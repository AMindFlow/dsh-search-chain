// dsh-search-chain bundle 入口（DSH-001..003、DSH-005）。
// 只注册一个 WebSearchProvider（id=search-chain）；卸载时反注册并释放链资源。
// 搜索链编排（WP5）与设置面板（WP12）不在本文件内实现。
import { CHAIN_CODES, OFFICIAL_ROUTE_ID, PROVIDER_ID } from "./constants.js";
import { readConfig } from "./config.js";
import { createLazyHostOfficial } from "./official.js";

export { PROVIDER_ID };

/** 行配置声明（JSON Schema 形态；宿主 Config 投影校验的实机形态见 PR「未验证项」）。 */
export const Config = {
  type: "object",
  additionalProperties: false,
  properties: {
    entries: { type: "array", description: "有序搜索条目（CFG-004）" },
    useOfficialDeepSeekSearch: { type: "boolean", default: true, description: "SET-005 官方 DeepSeek 搜索开关" },
    timeoutMs: { type: "integer", minimum: 1, default: 25000, description: "FB-003 总预算（毫秒）" },
  },
};

function webError(code, message) {
  const err = new Error(message);
  err.name = "WebError";
  err.code = code;
  err.details = { attempts: [] };
  return err;
}

/**
 * 占位链：WP5 装配前的诚实默认值。它不产出任何结果，直接以终态错误报告。
 * 测试与 WP5 集成时由 testDeps.chain 或真实 createSearchChain 替换。
 */
function unwiredChain() {
  return {
    async search() {
      throw webError(CHAIN_CODES.NOT_CONFIGURED, "搜索链编排尚未装配（WP5），本版本不产出搜索结果");
    },
    release() {},
  };
}

/**
 * 创建 search-chain provider。
 * deps = { getConfig, chain, official?, routeOf?, officialRouteId? }
 *   - official：宿主 DeepSeek 官方搜索 provider（须暴露 search(request, signal)），或返回它的惰性函数；
 *     为 null 时官方路由回落自定义链（测试替身语义）。
 *   - routeOf：从请求取路由 id，默认 request.llmProvider。
 */
export function createSearchProvider(deps) {
  const {
    getConfig,
    chain,
    official = null,
    routeOf = (request) => request?.llmProvider,
    officialRouteId = OFFICIAL_ROUTE_ID,
  } = deps;

  return {
    id: PROVIDER_ID,
    // DSH-002：同步布尔，无网络。初始化完成即接受搜索；空配置由链以 FB-004 终态报告。
    available() {
      return true;
    },
    // DSH-002/DSH-005：每次调用一个查询；官方分支仅在「开关开 + 官方路由 + 官方可用」时选择。
    async search(request, signal) {
      const cfg = getConfig();
      const useOfficial = cfg?.useOfficialDeepSeekSearch !== false;
      if (official && useOfficial && routeOf(request) === officialRouteId) {
        // 官方分支不经 ctx.web.search（会因配置 id=search-chain 选回本插件）。
        const target = typeof official === "function" ? await official() : official;
        if (target) return target.search(request, signal);
      }
      return chain.search(request, signal);
    },
    release() {
      if (typeof chain?.release === "function") chain.release();
    },
  };
}

/**
 * bundle 入口。在 ctx.effect 内注册 provider；cleanup 反注册并释放链（DSH-001）。
 * testDeps 仅供测试注入：{ chain, official, officialRouteId }。生产调用只有两参。
 */
export function apply(ctx, config, testDeps = {}) {
  const chain = testDeps.chain ?? unwiredChain();
  const official = "official" in testDeps ? testDeps.official : createLazyHostOfficial(ctx);
  const settings = {
    editor: ctx.configEditor,
    entry: ctx.fiber,
    current: () => config,
  };
  const provider = createSearchProvider({
    getConfig: () => readConfig(settings),
    chain,
    official,
    routeOf: testDeps.routeOf,
    officialRouteId: testDeps.officialRouteId,
  });

  return ctx.effect(() => {
    const unregister = ctx.web.registerSearchProvider(provider);
    return () => {
      try {
        unregister();
      } finally {
        provider.release();
      }
    };
  });
}
