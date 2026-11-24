// dsh-search-chain bundle 入口（DSH-001..003、DSH-005）。
// 只注册一个 WebSearchProvider（id=search-chain）；卸载时反注册并释放链资源。
// 搜索链编排（WP5）与设置面板（WP12）不在本文件内实现。
import { CHAIN_CODES, CONFIG_CODES, OFFICIAL_ROUTE_ID, PROVIDER_ID } from "./constants.js";
import { ConfigError, readConfig } from "./config.js";
import { createLazyHostOfficial } from "./official.js";

export { PROVIDER_ID };

/** Host 依赖声明：web 用于注册，configEditor 用于读取本行与 web-search-deepseek 行的活配置。 */
export const inject = ["web", "configEditor"];

/**
 * 读取本插件行的活配置（B1′）。匹配依据为 Entry 对象同一性：ctx.fiber.entry 与
 * configEditor.configuration() 返回的 r.entry 必为同一对象（宿主 Entry.id 带前缀，Fiber 无 id，
 * 按 id 匹配恒假）。行缺失或配置端口不可用时抛 CONFIG_ROW_UNAVAILABLE，禁止静默回退到装载快照——
 * 回退即恢复 B1（保存后下一次查询读不到新值）。
 */
export function liveOwnConfig(ctx) {
  const editor = ctx.configEditor;
  const entry = ctx.fiber?.entry;
  if (typeof editor?.configuration !== "function" || entry === undefined) {
    throw new ConfigError(CONFIG_CODES.ROW_UNAVAILABLE, "宿主配置端口不可用，无法读取本插件行的活配置");
  }
  let rows;
  try {
    rows = editor.configuration();
  } catch (cause) {
    throw new ConfigError(CONFIG_CODES.ROW_UNAVAILABLE, "读取宿主活配置失败", { cause });
  }
  if (!Array.isArray(rows)) {
    throw new ConfigError(CONFIG_CODES.ROW_UNAVAILABLE, "宿主活配置形态非法（configuration() 应返回行数组）");
  }
  const row = rows.find((r) => r?.entry === entry);
  if (!row) {
    throw new ConfigError(CONFIG_CODES.ROW_UNAVAILABLE, "本插件配置行不在宿主活行中（未挂载或已卸载）");
  }
  // 行形状实证（inspect Service 契约 configEditor 原文，0.2.2-rc.5）：
  //   configuration(): Array<{ entry: Entry; inherited: Record<string, unknown>; override: Record<string, unknown> }>
  //   ——"Read inherited and explicit profile values for the active entries"；消费端解构同形。
  //   有效配置 = inherited ⊕ override（override 覆盖同名键）。
  return { ...row.inherited, ...row.override };
}

/**
 * 行配置声明。
 *
 * 实机缺陷（0.2.2-rc.5，wp0-verify 首挂）：激活 search-chain 时失败，报
 *   `runtime.Config["~standard"].validate is not a function`。
 * 宿主 resolveConfig 原文（asar 实证）：
 *   if (!runtime.Config) return config;
 *   const result = runtime.Config["~standard"].validate(config);
 *   if ("then" in result) throw new TypeError("Async config validation is not supported");
 *   if (result.issues) throw new ValidationError(result.issues);
 *   else return result.value
 * 即宿主要求 Config 实现 Standard Schema 字面（`~standard.validate`，同步）。宿主自家插件使用的
 * @deepseek-ai/schemastery（zod 形状）在注册表版本（3.x）与 bundle 版本（0.2.x）间不对齐，且跨副本
 * volatile 标记不确定，因此这里零依赖手写 Standard Schema 字面。
 *
 * 分界：validate 只做形状钉存（plain object、已知键的类型与正整数），不深校验 entries 每项；
 * 深校验归 config.js normalizeConfig。validate 纯检查，原样返回 { value }（含未知键），缺省字段不补值。
 * 同步：绝不返回 thenable。
 *
 * 未知键【接受】（宿主语义）：宿主 configEditor 的 Config 面按 z.object 语义剥离 extras；若此处严格拒绝
 * 未知键，则保存结果（含他插件键或旧版残留键）必被宿主 validate 拒绝，形成「保存永败」死锁。
 * 未知键的丢弃发生在读路径（normalizeConfig），写路径保留 raw 未知键（writeConfig）。
 *
 * toJSON() 仅保留 JSON Schema 投影，供 WP12 设置面板做投影（volatileForm / schema.toJSON()）。
 * 投影与 validate 一致：additionalProperties 为 true（未知键不作为设置面错误）。
 * 宿主表单与 role 标记需要 schemastery 面；WP12 决策是否精确 pin @deepseek-ai/schemastery@3.19.0 并核对
 * 宿主实际解析版本。本 Config 本身不提供宿主表单标记。
 */
const CONFIG_JSON_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    entries: { type: "array", description: "有序搜索条目（CFG-004）" },
    useOfficialDeepSeekSearch: { type: "boolean", default: true, description: "SET-005 官方 DeepSeek 搜索开关" },
    timeoutMs: { type: "integer", minimum: 1, default: 25000, description: "FB-003 总预算（毫秒）" },
  },
};

function isPlainConfigObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export const Config = {
  "~standard": {
    version: 1,
    vendor: "dsh-search-chain",
    validate(value) {
      if (!isPlainConfigObject(value)) {
        return { issues: [{ message: "配置必须是对象" }] };
      }
      const issues = [];
      if (value.entries !== undefined) {
        if (!Array.isArray(value.entries)) {
          issues.push({ message: "entries 必须是数组", path: ["entries"] });
        } else {
          value.entries.forEach((entry, i) => {
            if (!isPlainConfigObject(entry)) issues.push({ message: "entries 每项必须是对象", path: ["entries", i] });
          });
        }
      }
      if (value.useOfficialDeepSeekSearch !== undefined && typeof value.useOfficialDeepSeekSearch !== "boolean") {
        issues.push({ message: "useOfficialDeepSeekSearch 必须是布尔值", path: ["useOfficialDeepSeekSearch"] });
      }
      if (
        value.timeoutMs !== undefined &&
        !(Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0)
      ) {
        issues.push({ message: "timeoutMs 必须是正整数毫秒", path: ["timeoutMs"] });
      }
      if (issues.length > 0) return { issues };
      return { value };
    },
  },
  toJSON() {
    return CONFIG_JSON_SCHEMA;
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
 * deps = { getConfig, getRouteConfig?, chain, official?, routeOf?, officialRouteId? }
 *   - getConfig：链路径的规范化快照（readConfig），非法条目在此抛 CONFIG_INVALID，仅作链终态。
 *   - getRouteConfig：路由判定的浅读活配置（不经 normalizeConfig），缺省回落 getConfig（测试替身）。
 *   - official：宿主 DeepSeek 官方搜索 provider（须暴露 search(request, signal)），或返回它的惰性函数；
 *     为 null 时官方路由回落自定义链（测试替身语义）。
 *   - routeOf：从请求取路由 id，默认 request.llmProvider。
 */
export function createSearchProvider(deps) {
  const {
    getConfig,
    getRouteConfig = getConfig,
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
    // 每次查询重读活配置（CFG-004）；路由判定先于规范化，链路径才进 readConfig/normalizeConfig。
    async search(request, signal) {
      const routeCfg = getRouteConfig();
      const useOfficial = routeCfg?.useOfficialDeepSeekSearch !== false;
      if (official && useOfficial && routeOf(request) === officialRouteId) {
        // 官方分支不经 ctx.web.search（会因配置 id=search-chain 选回本插件）。
        const target = typeof official === "function" ? await official() : official;
        if (target) return target.search(request, signal);
      }
      // 链路径：规范化快照（非法条目在此以 CONFIG_INVALID 终态止步，零条目执行）。
      getConfig();
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
/**
 * 配置端口（readConfig / writeConfig 的 settings 参数），纯接线、可单独测试。
 * - current()：每次查询实时读取活配置（B1′，CFG-004：保存成功后下一次查询生效）。
 * - entry：写入目标必须是宿主 Entry（ctx.fiber.entry）；传 Fiber 会被宿主 edit() 拒绝（B3）。
 */
export function createSettingsPort(ctx) {
  return {
    editor: ctx.configEditor,
    entry: ctx.fiber?.entry,
    current: () => liveOwnConfig(ctx),
  };
}

export function apply(ctx, _loadSnapshot, testDeps = {}) {
  const chain = testDeps.chain ?? unwiredChain();
  const official = "official" in testDeps ? testDeps.official : createLazyHostOfficial(ctx);
  const settings = createSettingsPort(ctx);
  const provider = createSearchProvider({
    getConfig: () => readConfig(settings),
    getRouteConfig: () => settings.current(),
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
