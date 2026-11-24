// dsh-search-chain bundle 入口（DSH-001..003、DSH-005）。
// 只注册一个 WebSearchProvider（id=search-chain）；卸载时反注册并释放链资源。
// 生产装配（WP6）：搜索链由 search.js 的 createSearchChain 接线（适配器见 src/backends/*，传输见 transport.js）；
// 设置面板（WP12）不在本文件内实现。
import { CONFIG_CODES, OFFICIAL_ROUTE_ID, PROVIDER_ID } from "./constants.js";
import { ConfigError, readConfig } from "./config.js";
import { createLazyHostOfficial } from "./official.js";
import { createSearchChain } from "./search.js";
import { createEntryTransport } from "./transport.js";
import { bingBackend } from "./backends/bing.js";
import { braveBackend } from "./backends/brave.js";
import { deepseekBackends } from "./backends/deepseek.js";
import { exaBackend } from "./backends/exa.js";
import { createGeminiBackend } from "./backends/gemini.js";
import { openaiBackend } from "./backends/openai.js";
import { tavilyBackend } from "./backends/tavily.js";

export { PROVIDER_ID };

/** Host 依赖声明：web 用于注册，configEditor 用于读取本行与 web-search-deepseek 行的活配置。 */
export const inject = ["web", "configEditor", "credentials", "agents"];

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

/** 生产时钟（A8）：链与适配器只用 now/setTimeout/clearTimeout；测试经 testDeps.clock 注入受控时钟。 */
const SYSTEM_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (id) => clearTimeout(id),
});

const NOOP_LOG = () => {};

/**
 * 生产出站 fetch（零依赖，全局 fetch）。直连路由照常出站；需要代理/PAC 命中代理的路由需要
 * 分发器实现（本插件零依赖，不引入 undici），故此类路由以 PROXY_UNSUPPORTED 显式失败、零出站，
 * 绝不静默改走直连（CFG-001）。代理错误码透传由 transport/后端协同面处理，本函数只负责失败不放行。
 */
function productionFetch(url, init = {}) {
  const { route, ...rest } = init ?? {};
  if (route && route.kind !== "direct") {
    return Promise.reject(Object.assign(new Error("代理路由暂不可用"), { code: "PROXY_UNSUPPORTED" }));
  }
  return globalThis.fetch(url, rest);
}

/** 宿主凭据服务（ctx.get("credentials")）：服务缺失时解析即失败（条目级 CREDENTIALS），不静默视作无 key。 */
function hostCredentials(ctx) {
  const svc = typeof ctx.get === "function" ? ctx.get("credentials") : undefined;
  const unavailable = () => {
    throw new Error("宿主凭据服务不可用");
  };
  return {
    resolve: (ref) => (typeof svc?.resolve === "function" ? svc.resolve(ref) : unavailable()),
    readRecord: (name) => (typeof svc?.readRecord === "function" ? svc.readRecord(name) : unavailable()),
  };
}

/** CAT-001 八个类型的后端适配器（按 entry.type 索引）。 */
function productionBackends() {
  const list = [
    bingBackend,
    braveBackend,
    exaBackend,
    openaiBackend,
    tavilyBackend,
    createGeminiBackend(),
    ...Object.values(deepseekBackends),
  ];
  return new Map(list.map((b) => [b.type, b]));
}

/** 生产搜索链（search.js createSearchChain）：每条目经 transport 路由、凭据经宿主服务解析。 */
function createProductionChain(ctx, { getConfig, fetchFn, clock, log }) {
  return createSearchChain({
    getConfig,
    backends: productionBackends(),
    transport: { open: (entry) => createEntryTransport(entry, { fetch: fetchFn, clock, log }) },
    credentials: hostCredentials(ctx),
    env: globalThis.process?.env ?? {},
    clock,
    log,
  });
}

/** B1′ 装配映射：配置端口的行不可用（ConfigError ROW_UNAVAILABLE）上抛为 WebError 终态，code 保留。 */
function mapRowUnavailable(err) {
  if (err instanceof ConfigError && err.code === CONFIG_CODES.ROW_UNAVAILABLE) {
    return webError(CONFIG_CODES.ROW_UNAVAILABLE, err.message);
  }
  return err;
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

  // 每次查询的路由与链路径选择（CFG-004 / #12 每操作契约）：活配置在入口只读一次（raw），
  // 路由判定与链快照由同一份 raw 派生，一次查询 configuration() 行读恰为 1，路由与链不跨保存撕裂。
  async function dispatchSearch(request, signal) {
    const raw = getRouteConfig(); // 装配层快照：本操作唯一一次活配置读取
    const useOfficial = raw?.useOfficialDeepSeekSearch !== false;
    if (official && useOfficial && routeOf(request) === officialRouteId) {
      // 官方分支不经 ctx.web.search（会因配置 id=search-chain 选回本插件）。
      const target = typeof official === "function" ? await official() : official;
      if (target) return target.search(request, signal);
    }
    // 链路径：由同一份 raw 派生规范化快照（非法条目在此以 CONFIG_INVALID 终态止步，零条目执行）。
    // 装配层快照注入（#12 每操作契约）：快照经链入口参数传入，链不再自读。
    const snapshot = getConfig(raw);
    return chain.search(request, signal, snapshot);
  }

  return {
    id: PROVIDER_ID,
    // DSH-002：同步布尔，无网络。初始化完成即接受搜索；空配置由链以 FB-004 终态报告。
    available() {
      return true;
    },
    // DSH-002/DSH-005：每次调用一个查询；官方分支仅在「开关开 + 官方路由 + 官方可用」时选择。
    // 每次查询重读活配置（CFG-004）；路由判定先于规范化，链路径才进 readConfig/normalizeConfig。
    async search(request, signal) {
      try {
        return await dispatchSearch(request, signal);
      } catch (err) {
        // B1′/#12-3：行不可用 → WebError 终态（code 保留 CONFIG_ROW_UNAVAILABLE），不静默回落快照。
        throw mapRowUnavailable(err);
      }
    },
    release() {
      if (typeof chain?.release === "function") chain.release();
    },
  };
}

/**
 * bundle 入口。在 ctx.effect 内注册 provider；cleanup 反注册并释放链（DSH-001）。
 * testDeps 仅供测试注入（A4/A8）：{ chain, official, officialRouteId, routeOf, clock, fetch, log }。
 * 生产调用只有两参：链为 createSearchChain 生产接线，clock 为系统时钟，fetch 为全局 fetch（直连）。
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
  // 测试注入面（A4/A8）：clock / fetch / log 缺省即生产实现；生产调用只有两参。
  const clock = testDeps.clock ?? SYSTEM_CLOCK;
  const fetchFn = testDeps.fetch ?? productionFetch;
  const log = testDeps.log ?? NOOP_LOG;
  const settings = createSettingsPort(ctx);
  // getConfig(raw)：raw 缺省时自读（链独立使用的默认行为）；传入 raw 时只从该份活配置规范化，不再读宿主。
  const getConfig = (raw) => readConfig(raw === undefined ? settings : { current: () => raw });
  const chain = testDeps.chain ?? createProductionChain(ctx, { getConfig, fetchFn, clock, log });
  const official = "official" in testDeps ? testDeps.official : createLazyHostOfficial(ctx);
  const provider = createSearchProvider({
    getConfig,
    getRouteConfig: () => settings.current(), // 每操作唯一一次 configuration() 读（见 dispatchSearch）
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
