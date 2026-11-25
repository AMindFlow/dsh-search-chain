// 搜索链测试台：把受控时钟、假 fetch/凭据/日志/transport 和脚本化后端接成
// createSearchChain(deps) 的完整注入面（contract.js A4/A5/A6/A8）。
// 所有时间只走注入的 clock；测试通过 runUntilSettled 拨钟驱动链，绝不依赖真实等待。
import { createControlledClock, flush } from "./clock.js";
import { createFakeFetch } from "./fake-fetch.js";
import { createFakeCredentials } from "./fake-credentials.js";
import { createFakeTransportFactory } from "./fake-transport.js";
import { createScriptedBackend } from "./fake-backend.js";
import { createLogCapture } from "./redact.js";
import { makeSavedConfig, OFFICIAL_ROUTE_ID } from "./contract.js";

export const DEFAULT_QUERY = "合成查询 openai 文档";

/**
 * @param {Function} createSearchChain src/search.js 的导出
 * @param {{
 *   entries?: object[], useOfficialDeepSeekSearch?: boolean, timeoutMs?: number, extraConfig?: object,
 *   steps?: Record<string, object[]>, env?: object, credentialRefs?: object, credentialRecords?: object,
 *   legacyYaml?: any, defaultFetch?: "never"|object, clockNow?: number,
 *   getConfigThrows?: Error,  // 链级配置读取自身失败（无条目上下文的全局面）：getConfig 每次读取原样抛出
 * }} [spec]
 */
export function createChainHarness(createSearchChain, spec = {}) {
  const entries = spec.entries ?? [];
  let saved = makeSavedConfig(entries, {
    useOfficialDeepSeekSearch: spec.useOfficialDeepSeekSearch ?? true,
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    ...spec.extraConfig,
  });
  let configReads = 0;
  const getConfig = () => {
    configReads += 1;
    if (spec.getConfigThrows !== undefined) throw spec.getConfigThrows;
    return saved;
  };

  const clock = createControlledClock({ now: spec.clockNow });
  const fetchFn = createFakeFetch({ default: spec.defaultFetch ?? "never", clock });
  const transport = createFakeTransportFactory({ fetchImpl: fetchFn });
  const credentials = createFakeCredentials({
    refs: spec.credentialRefs,
    records: spec.credentialRecords,
    strictRefGrammar: spec.strictRefGrammar === true, // R-1：opt-in，默认关闭
  });
  const logCapture = createLogCapture();

  const seqRef = { n: 0 };
  const types = [...new Set(entries.map((e) => e.type))];
  const backends = new Map();
  const backendByType = new Map();
  for (const type of types) {
    const b = createScriptedBackend(type, spec.steps ?? {}, seqRef);
    backends.set(type, b);
    backendByType.set(type, b);
  }

  const deps = {
    getConfig,
    backends,
    transport,
    credentials,
    env: spec.env ?? {},
    clock,
    log: logCapture.log,
  };
  if (spec.legacyYaml !== undefined) deps.legacyYaml = spec.legacyYaml;

  const chain = createSearchChain(deps);

  const harness = {
    chain,
    deps,
    clock,
    fetchFn,
    transport,
    credentials,
    logCapture,
    backendByType,
    get configReads() {
      return configReads;
    },
    savedConfig: () => saved,
    /** 模拟「另一界面保存了新配置」（CFG-004）：直接替换已保存对象。 */
    setConfig(next) {
      saved = next;
    },
    /** 在已保存对象上就地修改（模拟保存重写列表/开关）。 */
    mutateSaved(mutate) {
      mutate(saved);
    },
    search(request = { query: DEFAULT_QUERY }, signal) {
      return chain.search(request, signal);
    },
    backend(type) {
      const b = backendByType.get(type);
      if (!b) throw new Error(`测试台没有 ${type} 后端（检查 entries 是否含该类型）`);
      return b;
    },
    /** 条目被适配器实际执行的上下文（budgetMs/key/fetch/signal）。 */
    ctxFor(entryId) {
      for (const b of backendByType.values()) {
        const ctx = b.ctxFor(entryId);
        if (ctx) return ctx;
      }
      return undefined;
    },
    /** 条目实际执行记录（含开始时间与全局调用序号），用于核对 FB-001 顺序与 FB-003 预算。 */
    executions() {
      const all = [];
      for (const b of backendByType.values()) for (const c of b.calls) all.push(c);
      return all.sort((a, b) => a.at - b.at || a.seq - b.seq);
    },
    executionCount(entryId) {
      let n = 0;
      for (const b of backendByType.values()) n += b.callCount(entryId);
      return n;
    },
    /** 拨钟驱动直到 search 收敛；返回 { ok, value } 或 { ok:false, error }。 */
    async runUntilSettled(promise, maxMs = 120_000) {
      let outcome = null;
      promise.then(
        (value) => {
          outcome = { ok: true, value };
        },
        (error) => {
          outcome = { ok: false, error };
        },
      );
      const start = clock.now();
      while (!outcome) {
        await flush(2);
        if (outcome) break;
        if (clock.pending().length === 0) break; // 无任何待触发定时器：等待外部信号或实现停滞
        const due = clock.nextDue();
        clock.advance(Math.max(1, due - clock.now()));
        if (clock.now() - start > maxMs) break;
      }
      await flush(3);
      if (!outcome) {
        throw new Error(
          `[harness] 搜索未在受控时间内收敛。pending=${JSON.stringify(clock.pending())} clockErrors=${clock.errors.length}`,
        );
      }
      return outcome;
    },
    /** 便捷：跑完并强制要求成功值，否则抛出错误。 */
    async runToValue(promise, maxMs) {
      const o = await harness.runUntilSettled(promise, maxMs);
      if (!o.ok) throw o.error;
      return o.value;
    },
    /** 便捷：跑完并强制要求拒绝，否则断言失败。 */
    async runToError(promise, maxMs) {
      const o = await harness.runUntilSettled(promise, maxMs);
      if (o.ok) throw new Error(`[harness] 期望拒绝但得到结果：${JSON.stringify(o.value)}`);
      return o.error;
    },
  };
  return harness;
}

/**
 * provider 测试台（DSH-002/DSH-005）：createSearchProvider 的纯注入面，
 * 不要求真实链——路由矩阵用假链桩即可（provider 只负责选路与透传）。
 * @param {Function} createSearchProvider src/index.js 的导出
 * @param {{
 *   chain?: { search(request, signal?): Promise<object>, release?(): void },  // 假链桩（默认：返回固定结果的桩）
 *   config?: { entries?: object[], useOfficialDeepSeekSearch?: boolean },     // getConfig 提供的快照
 *   official?: "present"|"absent", officialBehavior?: any,
 *   routeOf?: (request) => string|undefined, officialRouteId?: string,
 * }} [spec]
 */
export function createProviderHarness(createSearchProvider, spec = {}) {
  const chainCalls = [];
  let releaseCount = 0;
  const stubChain = spec.chain ?? {
    async search(request, signal) {
      chainCalls.push({ request, signal });
      return { sources: [], truncated: false, content: "stub-chain" };
    },
    release() {}, // 计数统一由下方包装层添加，避免双计
  };
  if (typeof stubChain.release === "function") {
    const orig = stubChain.release.bind(stubChain);
    stubChain.release = () => {
      releaseCount += 1;
      return orig();
    };
  }
  let config = spec.config ?? { entries: [], useOfficialDeepSeekSearch: true };
  let configReads = 0;
  const getConfig = () => {
    configReads += 1;
    return config;
  };

  const officialCalls = [];
  const official =
    (spec.official ?? "present") === "present"
      ? {
          id: spec.officialRouteId ?? OFFICIAL_ROUTE_ID,
          available: () => true,
          async ready() {
            return true;
          },
          async search(request, signal) {
            officialCalls.push({ request, signal });
            if (typeof spec.officialBehavior === "function") return spec.officialBehavior(request, signal);
            return spec.officialBehavior;
          },
        }
      : null;

  const provider = createSearchProvider({
    getConfig,
    chain: stubChain,
    official,
    routeOf: spec.routeOf, // undefined 时实现须用默认 (request) => request?.llmProvider
    officialRouteId: spec.officialRouteId, // undefined 时实现须用 OFFICIAL_ROUTE_ID
  });

  return {
    provider,
    official,
    officialCalls,
    officialRequestCount: () => officialCalls.length,
    chainCalls,
    chainRequestCount: () => chainCalls.length,
    releaseCount: () => releaseCount,
    get configReads() {
      return configReads;
    },
    setConfig(next) {
      config = next;
    },
    search(request = { query: DEFAULT_QUERY }, signal) {
      return provider.search(request, signal);
    },
  };
}
