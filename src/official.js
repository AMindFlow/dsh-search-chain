// DSH-005 官方 DeepSeek 搜索的宿主复用（dsh-integration.md 设计决定：复用宿主导出的
// DeepSeekSearchProvider 与官方凭据/路由配置，不得经 ctx.web.search 回流到本插件）。
//
// 配置来源（B2）：宿主 web-search-deepseek 行的活配置，经 configEditor.configuration() 读取
// （该 API 返回全部活行的 inherited/override 值；本插件以 inject: configEditor 声明依赖）。
// 装配语义逐条对齐宿主 web-search-deepseek apply()/resolveOptions()：
//   baseURL：行配置 ?? 环境变量 DEEPSEEK_SEARCH_BASE_URL ?? 宿主默认常量；
//   凭据：行内字面 apiKey（非空）→ resolveDeepSeekApiKey(ctx, apiKeyEnv)；账号令牌仅当会话
//         requestContext.provider === deepseek-account（官方路由的会话不走账号令牌）；
//   model / apiVersion / maxTokens / maxUses：行配置 ?? 宿主默认常量。
// 仅使用宿主包的公开导出；这些包由宿主以 peer 提供（见根目录 package.json peerDependencies）。

const SEARCH_PKG = "@deepseek-ai/dsh-web-search-deepseek";
const LLM_PKG = "@deepseek-ai/dsh-llm-deepseek";
const CREDENTIALS_PKG = "@deepseek-ai/dsh-credentials";
const LAUNCH_ENV_PKG = "@deepseek-ai/dsh-launch-environment";

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
        "官方 DeepSeek 搜索组件无法加载（宿主需提供 dsh-web-search-deepseek 等 peer 包），未回退自定义链",
        cause,
      );
    },
  };
}

function nonblank(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** 宿主 web-search-deepseek 行的活配置（inherited 与 override 合并）；读不到时为空对象。 */
export function hostSearchRowConfig(ctx) {
  const editor = ctx.configEditor;
  if (typeof editor?.configuration !== "function") return {};
  const row = editor
    .configuration()
    .find((r) => r.entry?.name === SEARCH_PKG || r.entry?.id === "web-search-deepseek");
  return row ? { ...row.inherited, ...row.override } : {};
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

  const row = hostSearchRowConfig(ctx);
  const apiKeyEnv = credentials.credentialRef(nonblank(row.apiKeyEnv) ?? DEFAULT_API_KEY_ENV);
  const literalApiKey = nonblank(row.apiKey);
  const currentAgent = () => ctx.get("agents")?.currentInitiator();

  return new search.DeepSeekSearchProvider(() => ({
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
      nonblank(row.baseURL) ??
      launchEnv.launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value ??
      search.DEEPSEEK_DEFAULT_BASE_URL,
    model: nonblank(row.model) ?? search.DEEPSEEK_DEFAULT_MODEL,
    apiVersion: nonblank(row.apiVersion) ?? search.DEEPSEEK_DEFAULT_API_VERSION,
    maxTokens: row.maxTokens ?? search.DEEPSEEK_DEFAULT_MAX_TOKENS,
    maxUses: row.maxUses ?? search.DEEPSEEK_DEFAULT_MAX_USES,
    recordRequest: (request) => currentAgent()?.session.append("web/deepseek-search-llm-request", request),
  }));
}
