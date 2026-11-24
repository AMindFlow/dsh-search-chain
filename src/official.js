// DSH-005 官方 DeepSeek 搜索的宿主复用（dsh-integration.md 设计决定：复用宿主导出的
// DeepSeekSearchProvider 与官方凭据/路由配置，不得经 ctx.web.search 回流到本插件）。
//
// 配置来源（B2′）：宿主 web-search-deepseek 行的活配置，经 configEditor.configuration() 读取。
// 行的识别：r.entry.options.id === "web-search-deepseek"（宿主 Entry 形态，见 PR 正文 E4）。
// 行读取位于 resolveOptions 等价的 thunk 内：宿主 DeepSeekSearchProvider 每次操作调用一次
// options()，因此行内 baseURL/apiKey 等改动从下一次搜索起即生效（不在装载时固化）。
// 装配语义逐条对齐宿主 web-search-deepseek apply()/resolveOptions()（asar 源码实证）：
//   baseURL：行 ?? 环境变量 DEEPSEEK_SEARCH_BASE_URL ?? 宿主默认常量（?? 语义，空串保留）；
//   apiKey：行内字面值 !== undefined 且 length > 0 时使用，否则 resolveDeepSeekApiKey(ctx, apiKeyEnv)；
//   账号令牌：仅当会话 requestContext.provider === deepseek-account（官方路由会话不走账号令牌）；
//   apiKeyEnv / model / apiVersion / maxTokens / maxUses：行 ?? 宿主默认常量。
// 读不到宿主行（未挂载、配置端口不可用）时抛 WEB_PROVIDER_UNAVAILABLE：不使用默认值，
// 不降级为「仅 llm 层凭据」，也不回退自定义链（显式失败，见 PR 正文决定 D-B2）。
// 仅使用宿主包的公开导出；四个宿主包以精确版本作为 dependencies 安装（见 package.json）。

const SEARCH_PKG = "@deepseek-ai/dsh-web-search-deepseek";
const LLM_PKG = "@deepseek-ai/dsh-llm-deepseek";
const CREDENTIALS_PKG = "@deepseek-ai/dsh-credentials";
const LAUNCH_ENV_PKG = "@deepseek-ai/dsh-launch-environment";

const SEARCH_ROW_ID = "web-search-deepseek";
const ACCOUNT_PROVIDER = "deepseek-account";
const DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY";
const SEARCH_BASE_URL_ENV = "DEEPSEEK_SEARCH_BASE_URL";

function webError(code, message, cause) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.name = "WebError";
  err.code = code;
  err.details = { attempts: [] };
  return err;
}

function unavailableOfficial(cause) {
  return {
    async search() {
      throw webError(
        "WEB_PROVIDER_UNAVAILABLE",
        "官方 DeepSeek 搜索组件无法加载（宿主需提供 dsh-web-search-deepseek 等依赖包），未回退自定义链",
        cause,
      );
    },
  };
}

/** 宿主 web-search-deepseek 行的活配置（configuration() 行，终局形状 {entry, inherited, override}）。读不到或形态非法即抛 WEB_PROVIDER_UNAVAILABLE。 */
export function requireHostSearchRow(ctx) {
  const editor = ctx.configEditor;
  if (typeof editor?.configuration !== "function") {
    throw webError("WEB_PROVIDER_UNAVAILABLE", "宿主配置端口不可用，无法读取 web-search-deepseek 行配置");
  }
  let rows;
  try {
    rows = editor.configuration();
  } catch (cause) {
    throw webError("WEB_PROVIDER_UNAVAILABLE", "读取宿主活配置失败，无法读取 web-search-deepseek 行配置", cause);
  }
  if (!Array.isArray(rows)) {
    throw webError("WEB_PROVIDER_UNAVAILABLE", "宿主活配置形态非法（configuration() 应返回行数组），无法读取 web-search-deepseek 行配置");
  }
  const row = rows.find((r) => r?.entry?.options?.id === SEARCH_ROW_ID);
  if (!row) {
    throw webError(
      "WEB_PROVIDER_UNAVAILABLE",
      "宿主 web-search-deepseek 配置行未挂载，官方 DeepSeek 搜索不可用（请在插件设置中启用该行）",
    );
  }
  // 行形状实证同 src/index.js liveOwnConfig：configuration(): Array<{ entry; inherited; override }>，
  // 有效配置 = inherited ⊕ override。
  return { ...row.inherited, ...row.override };
}

/**
 * 返回惰性加载函数：首次搜索时才导入宿主包并构造 DeepSeekSearchProvider。
 * 成功结果缓存；加载失败不缓存（下次搜索重试加载），本次以 WEB_PROVIDER_UNAVAILABLE 报告。
 */
export function createLazyHostOfficial(ctx) {
  let cached = null;
  return async () => {
    if (cached) return cached;
    try {
      cached = await loadHostOfficial(ctx);
      return cached;
    } catch (cause) {
      return unavailableOfficial(cause);
    }
  };
}

async function loadHostOfficial(ctx) {
  const [search, llm, credentials, launchEnv] = await Promise.all([
    import(SEARCH_PKG),
    import(LLM_PKG),
    import(CREDENTIALS_PKG),
    import(LAUNCH_ENV_PKG),
  ]);

  const currentAgent = () => ctx.get("agents")?.currentInitiator();

  // 与宿主 resolveOptions 同构：每次搜索调用一次 thunk，读取当下的行配置。
  return new search.DeepSeekSearchProvider(() => {
    const row = requireHostSearchRow(ctx);
    const apiKeyEnv = credentials.credentialRef(row.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
    const literalApiKey =
      row.apiKey !== undefined && row.apiKey.length > 0 ? row.apiKey : undefined;
    return {
      ...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
      resolveAccountToken: async (endpoint) => {
        const provider = currentAgent()?.session.requestContext()?.provider;
        if (provider !== ACCOUNT_PROVIDER) return undefined;
        return await llm.resolveDeepSeekAccountToken(ctx, endpoint);
      },
      rejectAccountToken: (token) => llm.rejectDeepSeekAccountToken(ctx, token),
      resolveApiKey: () => llm.resolveDeepSeekApiKey(ctx, apiKeyEnv),
      apiKeyEnv,
      baseURL:
        row.baseURL ??
        launchEnv.launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value ??
        search.DEEPSEEK_DEFAULT_BASE_URL,
      model: row.model ?? search.DEEPSEEK_DEFAULT_MODEL,
      apiVersion: row.apiVersion ?? search.DEEPSEEK_DEFAULT_API_VERSION,
      maxTokens: row.maxTokens ?? search.DEEPSEEK_DEFAULT_MAX_TOKENS,
      maxUses: row.maxUses ?? search.DEEPSEEK_DEFAULT_MAX_USES,
      recordRequest: (request) => currentAgent()?.session.append("web/deepseek-search-llm-request", request),
    };
  });
}
