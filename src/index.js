// dsh-fleetseek bundle 入口（DSH-001..003、DSH-005）。
// 只注册一个 WebSearchProvider（id=search-chain）；卸载时反注册并释放链资源。
// 生产装配（WP6）：搜索链由 search.js 的 createSearchChain 接线（适配器见 src/backends/*，传输见 transport.js）；
// 设置面板（WP12）不在本文件内实现。
import { createRequire } from "node:module";
// Issue #61：代理出站 dispatcher 由 undici 承载（规格 config-network.md 运输段「插件自己的 undici dispatcher」，
// 本版本交付可用代理：直连维持 globalThis.fetch，代理路由经 ProxyAgent 隧道；直连不另建 undici Agent 的
// 口径出入在规格文中注明，决策来源 = Issue #61 用户指令）。
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { CONFIG_CODES, ENTRY_CODES, OFFICIAL_ROUTE_ID, PROVIDER_ID, TOOL_TYPES } from "./constants.js";
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

// schemastery 经 require 取构建（与契约 C2 探针同一副本）：Config 原型须 === 包内 resolve 副本的 Schema.prototype。
// ESM `import z` 与 CJS require 是两份独立模块实例（两个 Schema.prototype），混用即跨副本分叉。
const z = createRequire(import.meta.url)("@deepseek-ai/schemastery");

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
 * 行配置声明（#43：真实 @deepseek-ai/schemastery@3.19.x 节点，形状对齐官方 dsh-web-search-deepseek@0.2.2-rc.5）。
 *
 * 缺陷（#43 隔离 Host 实证）：旧手写 Config 无 meta。宿主 settings.describe 在 runtime.Config 原对象上
 * 直调 volatileForm，读 schema.meta.volatile 即 TypeError → gateway/internal，设置面打不开。宿主读取位
 * （0.2.2-rc.5 app.asar schema.js 实证）要求：根与每个 dict 子节点携带 meta 对象；可编辑字段
 * meta.volatile===true；toJSON 为 schemastery refs 序列化（{uid, refs}，宿主 new z(toJSON()) 重建）。
 * 契约钉在 test/config-schemastery-contract.test.js。
 *
 * 形状：根 z.object 且 required（拒 null 与数组根）；entries / timeoutMs / useOfficialDeepSeekSearch 为
 * 字段级 .volatile()（宿主每查询现读）；entries 项内子字段不再嵌 volatile，只标 role（credentialRef）。
 * 未知键：schemastery object resolver 非 strict（merge），接受并透传——严格拒绝即「保存永败」死锁（P2-2 定案）。
 * 缺省：schema 面不补默认值（默认归 normalizeConfig，FB-003/SET-005 分界不变）。
 *
 * 分界：本 schema 为同步 Standard Schema 写闸（宿主 resolveConfig：validate 不得返回 thenable），只做
 * 形状、类型、值域与 enum。深校验（代理形态、重复 id 等）归 config.js normalizeConfig，读路径与 writeConfig
 * 写前规范化共用。重复 id 不在 schema 面表达：schemastery 3.19 无 refine，而 transform 会把 entries 节点
 * 类型改为 transform，破坏宿主设置面的 array 类型注记；由 normalizeConfig 认定，文案含重复的 id。
 */
const ENTRY = z
  .object({
    id: z.string().required(),
    type: z.union(TOOL_TYPES.map((t) => z.const(t))).required(),
    name: z.string(),
    enabled: z.boolean(),
    credentialRef: z.string().role("credential-ref"),
    proxy: z.union([z.string(), z.object({ pac: z.string() })]),
  })
  .required();

export const Config = z
  .object({
    entries: z.array(ENTRY).volatile(),
    useOfficialDeepSeekSearch: z.boolean().volatile(),
    timeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).volatile(),
  })
  .required();

/**
 * 缺省不补值（SET-005/FB-003 分界：默认归 normalizeConfig）。schemastery 对 volatile 字段恒以 createVolatile
 * 包裹（含 undefined），且 entries 节点自带 default []；输入缺键时 validate 结果会凭空出现键。
 * 此处只保留输入中已存在的键，缺键不进入 value。仅改 validate 的输出对象，schema 节点本身不变。
 * 实现为节点上的不可枚举自有 ~standard（toJSON 的 refs 序列化不受影响）。
 */
const CONFIG_OWN_KEYS = ["entries", "useOfficialDeepSeekSearch", "timeoutMs"];
const baseStandard = Config["~standard"];
Object.defineProperty(Config, "~standard", {
  configurable: true,
  enumerable: false,
  value: Object.freeze({
    version: baseStandard.version,
    vendor: baseStandard.vendor,
    validate(input) {
      const result = baseStandard.validate(input);
      if (result.issues) return result;
      for (const key of CONFIG_OWN_KEYS) {
        if (!(key in input)) delete result.value[key];
        // schemastery 对非 required 字段放行 null（视为缺省）；旧手写面拒绝 null。写闸保持拒绝，
        // 否则 null 落盘后读路径 normalizeConfig 必拒（CONFIG_INVALID），形成保存成功即读不出的状态。
        else if (input[key] === null) {
          return { issues: [{ message: `${key} 不得为 null（缺省请省略该键）`, path: [key] }] };
        }
      }
      return result;
    },
  }),
});

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
 * 创建生产出站 fetch（Issue #61：装配面代理出站落地，PROXY_UNSUPPORTED 退役）。
 * 路由标记 init.route 由 src/transport.js 产出（A4 接缝），此处只按 route.kind 选 dispatcher：
 *  - kind=direct（含 PAC 判定直连）→ globalThis.fetch 照常出站（本版本决策：直连不另建 undici
 *    Agent，维持宿主全局 fetch 的既有连接与行为；规格运输段的口径出入已在 config-network.md 注明）；
 *  - kind=proxy/https-proxy（含 PAC 命中代理）→ undici fetch + ProxyAgent 隧道出站（proxyTunnel 强制
 *    CONNECT，明文 http 目标亦走隧道：行为统一、代理控制面只见 CONNECT）；ProxyAgent 按 proxyUrl
 *    缓存复用（多条目共用同一代理地址即共用一个连接池），不得静默改走直连（CFG-001）。
 *    undici 8 形态：dispatcher 经 init 传入（RequestInit 的 undici 特定项）；代理 URL 带 user:pass 时
 *    ProxyAgent 自动以 Proxy-Authorization: Basic 用于 CONNECT 控制面（凭据不进入日志/错误文本，
 *    endpointOf 脱敏）。
 * 代理连接故障不经本函数归因：undici 的原始错误交回 transport.mapFetchError，按 ENTRY_PROXY 阶段码
 * 落定（FB-005 区分代理/直连），链按 FB-001 降级下一条。
 * 生命周期：closeAll 释放全部代理连接池（CFG-004 卸载不残留连接），幂等、单 agent 失败不阻塞其余。
 * closeAll 与在途搜索协调（PR #62 P2，codex 复审 discussion_r4709786331）：closeAll 只关闭当时已
 * 存在的 ProxyAgent；若在途搜索（await 凭据/准备降级条目）其后到达 fetchFn，agentFor 会在已清空/
 * 已关闭的池上再造新 agent——唯一一次卸载清理已完成，该连接池永不被管理。故 closeAll 同步置 closed
 * 位（置位先于遍历关闭，幂等）；closed 后代理路由 fetch 在选择 dispatcher 前显式拒绝（agentFor 不
 * 再可达），拒绝错误复用既有 ENTRY_PROXY 阶段码经 mapFetchError 的 carriesPassthroughCode 透传
 * （不新增公开码）；direct 路由维持放行——globalThis.fetch 无插件自有连接池，无池残留/清理问题，
 * 仅代理路由（插件自有 agent 池）是拒绝对象。
 * 测试观察面（P2 断言）：返回值携带 non-enumerable 只读 agentCount（池内 agent 数 = map size）。
 * @returns {Function & { closeAll: () => Promise<void>, readonly agentCount: number }} fetch(url, init)；init 形状同 transport 注入
 */
export function createProductionFetch() {
  const proxyAgents = new Map(); // proxyUrl → undici ProxyAgent（按地址缓存复用）
  // P2（discussion_r4709786331）：卸载协调位。closeAll 同步置位后，任何其后到达的代理路由 fetch
  // 在选择 dispatcher 前被拒绝，卸载后不得再有新建 agent 逃逸于关闭之外。
  let closed = false;
  function agentFor(proxyUrl) {
    let agent = proxyAgents.get(proxyUrl);
    if (!agent) {
      // proxyTunnel:true 强制 CONNECT 隧道（含明文 http 目标），使 http/https 目标出站行为一致、
      // 代理控制面只见 CONNECT（供应商 key 只随隧道内转发请求出现，绝不进 CONNECT 头）——
      // Issue #61 判据「本地 CONNECT fixture 数到真实隧道请求」所要求的行为。
      agent = new ProxyAgent({ uri: proxyUrl, proxyTunnel: true });
      proxyAgents.set(proxyUrl, agent);
    }
    return agent;
  }
  const fetchFn = (url, init = {}) => {
    const { route, ...rest } = init ?? {};
    if (route && (route.kind === "proxy" || route.kind === "https-proxy")) {
      // P2（discussion_r4709786331）：closed 后代理路由在选择 dispatcher（agentFor）前显式拒绝——
      // 不得在已清空/已关闭的池上再造新 agent 逃逸于管理之外。CFG-001 红线：绝不静默改走直连。
      if (closed) {
        const err = new Error("插件已卸载，代理出站不可用");
        // 复用既有 ENTRY_PROXY 阶段码（不新增公开码）：mapFetchError 经 carriesPassthroughCode
        // 原样透传，链按 FB-005 归代理阶段（attempts 原码 ENTRY_PROXY）。
        err.code = ENTRY_CODES.PROXY;
        return Promise.reject(err);
      }
      // undici 8：dispatcher 是 RequestInit 的 undici 特定项（经 init 传入；旧版第三参形态已移除，
      // 第三参会被静默忽略并退回直连全局 dispatcher——不得回归）。
      return undiciFetch(url, { ...rest, dispatcher: agentFor(route.proxyUrl) });
    }
    // closed 后 direct 路由维持放行（决策）：globalThis.fetch 是宿主全局出站，无插件自有连接池，
    // 不存在池残留/无人管理问题；插件自有资源仅代理路由的 ProxyAgent 池，故卸载后仅代理路由拒绝。
    return globalThis.fetch(url, rest);
  };
  fetchFn.closeAll = async () => {
    if (closed) return; // 幂等：重复调用安全（唯一一次卸载清理只完成一次，不二次遍历已关闭 agent）。
    closed = true;
    const agents = [...proxyAgents.values()];
    proxyAgents.clear(); // 先清空池：其后 agentFor 不再可能从池命中，代理路由 fetch 亦已被 closed 位拒绝。
    // agent.close 等待其在途请求结算后关闭池（在途请求沿用原配置完成或取消，不随卸载中断）；
    // 单 agent 失败不阻塞其余（CFG-004）。
    await Promise.all(agents.map((agent) => agent.close().catch(() => {})));
  };
  // 测试观察面（P2 断言，non-enumerable 不污染函数自身）：当前池内 agent 数（map size）。
  Object.defineProperty(fetchFn, "agentCount", {
    configurable: true,
    enumerable: false,
    get: () => proxyAgents.size,
  });
  return fetchFn;
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
 * bundle 入口。在 ctx.effect 内注册 provider；cleanup 反注册并释放链与代理出站连接池（DSH-001/CFG-004）。
 * testDeps 仅供测试注入（A4/A8）：{ chain, official, officialRouteId, routeOf, clock, fetch, log }。
 * 生产调用只有两参：链为 createSearchChain 生产接线，clock 为系统时钟，fetch 为 createProductionFetch
 * 的生产出站（直连 globalThis.fetch + 代理 undici ProxyAgent，Issue #61）。
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
  // 每装载实例一份生产出站（代理连接池随本实例释放，不跨实例共享，CFG-004）。
  const fetchFn = testDeps.fetch ?? createProductionFetch();
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
      // CFG-004：卸载随释放代理出站连接池（closeAll 幂等；测试替身 fetch 无 closeAll 时安全跳过）。
      return fetchFn.closeAll?.();
    };
  });
}
