// DSH-005 官方 DeepSeek 搜索的宿主复用（dsh-integration「设计决定」：复用宿主导出的
// DeepSeekSearchProvider 与官方凭据/路由，不得经 ctx.web.search 回流到本插件）。
// 只使用宿主包的公开导出；这些包由宿主以 peer 提供（见根目录 package.json peerDependencies）。
// 无法加载时返回以 WEB_PROVIDER_UNAVAILABLE 终态失败的官方端，不回退自定义链。

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

/**
 * 返回惰性加载函数：首次搜索时才导入宿主包并构造 DeepSeekSearchProvider（结果缓存）。
 * 不在 apply 时导入，避免装载阶段的网络或模块副作用。
 */
export function createLazyHostOfficial(ctx) {
  let pending = null;
  return () => {
    pending ??= loadHostOfficial(ctx);
    return pending;
  };
}

async function loadHostOfficial(ctx) {
  let search;
  let llm;
  let credentials;
  let launchEnv;
  try {
    [search, llm, credentials, launchEnv] = await Promise.all([
      import(SEARCH_PKG),
      import(LLM_PKG),
      import(CREDENTIALS_PKG),
      import(LAUNCH_ENV_PKG),
    ]);
  } catch (cause) {
    return unavailableOfficial(cause);
  }

  const apiKeyEnv = credentials.credentialRef(DEFAULT_API_KEY_ENV);
  const currentAgent = () => ctx.get("agents")?.currentInitiator();

  // 与宿主 web-search-deepseek 的 resolveOptions 同语义（官方凭据与账号令牌沿用宿主实现）。
  return new search.DeepSeekSearchProvider(() => ({
    resolveAccountToken: async (endpoint) => {
      const provider = currentAgent()?.session.requestContext()?.provider;
      if (provider !== ACCOUNT_PROVIDER) return undefined;
      return await llm.resolveDeepSeekAccountToken(ctx, endpoint);
    },
    rejectAccountToken: (token) => llm.rejectDeepSeekAccountToken(ctx, token),
    resolveApiKey: () => llm.resolveDeepSeekApiKey(ctx, apiKeyEnv),
    apiKeyEnv,
    baseURL: launchEnv.launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value ?? search.DEEPSEEK_DEFAULT_BASE_URL,
    model: search.DEEPSEEK_DEFAULT_MODEL,
    apiVersion: search.DEEPSEEK_DEFAULT_API_VERSION,
    maxTokens: search.DEEPSEEK_DEFAULT_MAX_TOKENS,
    maxUses: search.DEEPSEEK_DEFAULT_MAX_USES,
    recordRequest: (request) => currentAgent()?.session.append("web/deepseek-search-llm-request", request),
  }));
}
