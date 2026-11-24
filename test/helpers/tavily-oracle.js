// WP3 Tavily 适配器验收的共享助手（oracle 定义；dev 不得为通过而修改本文件的断言语义）。
//
// 规格来源：docs/specs/draft/tavily.md（TAV-001 单查询与服务上限、TAV-002 结果映射与正常空结果），
//   跨条款：providers.md CAT-001、fallback.md FB-001..FB-005、config-network.md CFG-002/CFG-003、
//   contract.js A5（适配器 seam）、A6（ctx.fetch）、A8（ctx.clock 受控预算）。
//
// 本文件约定：
//   - 适配器按 A5 形状调用：backend.search(ctx)，ctx = { entry, query, maxResults?, key, fetch,
//     budgetMs, signal, clock, log }。resolve → { sources, content? }；失败 throw 带 .code ∈ ENTRY_CODES。
//   - 模块导出形状未在规格定义（A5 只定义 Backend 的形状）。本助手接受以下三种之一：
//     `tavilyBackend`、`default`、`createTavilyBackend()`，见 loadTavilyBackend。此为 oracle 假设，见报告。
//   - 合成样本全部内联于本文件，未放入 test/fixtures/：fixtures 卫生规则 6 要求每个 fixture 文件登记到
//     helpers/fixtures.js 的 FIXTURE_NAMES，而该文件属既有 test/，本轮禁止编辑。内联样本同样受
//     tavily-redaction.test.js 中的卫生检查约束（保留 TLD、无真实凭据形状）。
//   - 规格含糊处的断言集中在 test/tavily-pending.test.js，不散落到其他测试文件。
import assert from "node:assert/strict";
import * as C from "./contract.js";
import { createFakeFetch, SYNTHETIC_KEY } from "./fake-fetch.js";
import { createControlledClock, flush } from "./clock.js";
import { tryImportSrc, failIfUnimplemented } from "./impl.js";

/** 实现模块的工作包标签（用于缺失时的红色诊断）。 */
export const WP_TAVILY = "WP3 src/backends/tavily.js";
/** 分类函数 classifyUpstreamFailure 所在模块（A4，WP5 负责）。 */
export const WP_SEARCH = "WP5 src/search.js";

/** TAV-001：单查询 POST 端点（固定，无查询串）。 */
export const TAVILY_URL = "https://api.tavily.com/search";
/** TAV-001：max_results 服务上限。 */
export const TAVILY_MAX_RESULTS_CAP = 20;
/** 合成凭据（可辨识，见 fake-fetch.js SYNTHETIC_KEY 约定）。 */
export const TAVILY_KEY = SYNTHETIC_KEY("tavily");
/** 第二个合成条目的 key，用于「每条目 key 只发给自己」断言。 */
export const TAVILY_KEY_B = SYNTHETIC_KEY("tavily-second");
/** 合成查询（含中文与空格，验证单个原查询逐字发送）。 */
export const SAMPLE_QUERY = "synthetic tavily query 合成查询";
/** 真实 Promise 守卫时长：仅用于防止挂起测试卡死，不得作为预算依据（预算走 ctx.clock）。 */
export const GUARD_MS = 3000;

// ─── 内联合成样本（保留 TLD，结构与 Tavily 文档一致，内容虚构）──────────────

/** 三条有效结果（有序）。 */
export const SAMPLE_RESULTS = Object.freeze([
  { url: "https://synthetic-host.invalid/tavily/1", title: "合成结果一", content: "合成摘要一", score: 0.91 },
  { url: "https://synthetic-host.invalid/tavily/2", title: "合成结果二", content: "合成摘要二", score: 0.82 },
  { url: "https://synthetic-host.invalid/tavily/3", title: "合成结果三", content: "合成摘要三", score: 0.74 },
]);

/** 正常成功响应体（含 answer:null，符合 include_answer:false 的上游形状）。 */
export function successBody(results = SAMPLE_RESULTS, extra = {}) {
  return {
    query: SAMPLE_QUERY,
    follow_up_questions: null,
    answer: null,
    images: [],
    results: structuredClone(results),
    response_time: 0.12,
    ...extra,
  };
}

/** 上游用量超限的合成错误体（不含真实 key，错误文案虚构）。 */
export const SYNTH_QUOTA_BODY = Object.freeze({ detail: { error: "synthetic usage limit exceeded" } });
/** 上游鉴权失败的合成错误体。 */
export const SYNTH_AUTH_BODY = Object.freeze({ error: { type: "authentication_error", message: "synthetic invalid key" } });

// ─── 加载与上下文 ─────────────────────────────────────────────────────────

/**
 * 加载 Tavily 适配器。模块缺失时在 test 内记红（failIfUnimplemented）。
 * @returns {Promise<{ type?: string, search: Function } | null>} null 表示已记红并已抛错（调用方 return）。
 */
export async function loadTavilyBackend(t, clauses = "TAV-001/TAV-002") {
  const res = await tryImportSrc("backends/tavily.js");
  if (failIfUnimplemented(t, res, WP_TAVILY, clauses)) return null;
  const mod = res.module;
  const backend =
    mod.tavilyBackend ??
    mod.default ??
    (typeof mod.createTavilyBackend === "function" ? mod.createTavilyBackend() : undefined);
  assert.ok(
    backend && typeof backend.search === "function",
    "src/backends/tavily.js 须导出 Backend（{ type, search(ctx) }，A5）；oracle 接受 tavilyBackend / default / createTavilyBackend() 三种形态之一（形状未在规格定义，见报告）",
  );
  return backend;
}

/**
 * 构造 A5 ctx。maxResults 未指定时必须整体省略该字段（测试 TAV-001「省略 max_results」依赖此语义）。
 * @param {object} [overrides]
 */
export function makeCtx(overrides = {}) {
  const fetch = overrides.fetch ?? createFakeFetch();
  return {
    entry: C.makeEntry({
      id: overrides.entryId ?? "tav-entry-1",
      type: "tavily",
      name: overrides.name ?? "合成 Tavily 条目",
    }),
    query: overrides.query ?? SAMPLE_QUERY,
    ...(overrides.maxResults !== undefined ? { maxResults: overrides.maxResults } : {}),
    key: "key" in overrides ? overrides.key : TAVILY_KEY,
    fetch,
    budgetMs: overrides.budgetMs ?? 5000,
    signal: overrides.signal,
    clock: overrides.clock ?? createControlledClock(),
    log: overrides.log ?? (() => {}),
  };
}

/**
 * 只声明一条 Tavily 路由的假 fetch。spec 形如 { status, body?, headers? }。
 * 未声明的出站由 fake-fetch 抛错，便于发现多余请求。
 */
export function tavilyFetch(spec) {
  const f = createFakeFetch();
  f.when(TAVILY_URL).responds(spec);
  return f;
}

/** Tavily 路由以网络层错误失败（无 HTTP 状态）。 */
export function tavilyFetchFails(error) {
  const f = createFakeFetch();
  f.when(TAVILY_URL).fails({ error });
  return f;
}

/** Tavily 路由挂起直到 signal 中止。 */
export function tavilyFetchHangs() {
  const f = createFakeFetch();
  f.when(TAVILY_URL).hangs();
  return f;
}

// ─── 出站断言 ─────────────────────────────────────────────────────────────

/** 恰好一次出站到 Tavily 端点，返回该次调用记录。TAV-001 要求1 + FB-001（每条目最多一次）。 */
export function singleCall(fetch, label = "Tavily 请求") {
  const calls = fetch.callsFor(TAVILY_URL);
  assert.equal(
    calls.length,
    1,
    `${label}：必须恰好一次 POST 到 ${TAVILY_URL}（TAV-001 / FB-001 每条目最多一次）；实际出站共 ${fetch.count()} 次`,
  );
  return calls[0];
}

/** 解析请求正文 JSON。 */
export function bodyOf(call) {
  assert.equal(typeof call.init.body, "string", "请求正文须为字符串（JSON）");
  return JSON.parse(call.init.body);
}

/** 断言端点与方法，且 URL 不带查询串（TAV-001 要求1、CFG-003：key 不得进入 URL）。 */
export function assertEndpoint(call) {
  assert.equal(call.method, "POST", "TAV-001：方法必须为 POST");
  const u = new URL(call.url);
  assert.equal(`${u.origin}${u.pathname}`, TAVILY_URL, "TAV-001：端点必须为 https://api.tavily.com/search");
  assert.equal(u.search, "", "TAV-001/CFG-003：端点不得带查询串（key 只进鉴权头）");
}

// ─── 结果与错误断言 ──────────────────────────────────────────────────────

/** 去掉值为 undefined 的键，便于与期望对象做严格比较（不误伤「缺字段」语义）。 */
export function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** TAV-002 映射期望：url→url、title→title、content→snippet，仅这三个字段。 */
export function expectedSourceOf(r) {
  return stripUndefined({ url: r.url, title: r.title, snippet: r.content });
}

/** 把适配器返回的 sources 归一为去掉 undefined 键的对象数组。 */
export function normalizeSources(sources) {
  assert.ok(Array.isArray(sources), "适配器须 resolve 出 sources 数组（A5）");
  return sources.map(stripUndefined);
}

/** 等待适配器 promise 失败并返回错误；若成功则测试失败。 */
export async function rejectionOf(promise) {
  let err;
  let threw = false;
  try {
    await promise;
  } catch (e) {
    err = e;
    threw = true;
  }
  if (!threw) assert.fail("期望适配器失败（抛错），实际却成功返回");
  return err;
}

/** 条目级失败：code ∈ ENTRY_CODES，且带可操作的非空 message（FB-004/FB-005）。 */
export function assertEntryError(err, code) {
  assert.ok(err && typeof err === "object", "失败须以错误对象抛出");
  assert.ok(
    Object.values(C.ENTRY_CODES).includes(err.code),
    `失败码须属于 ENTRY_CODES（A5/FB-005），实际：${err.code}`,
  );
  assert.equal(err.code, code, `分类码须为 ${code}（FB-005/TAV-002），实际：${err.code}`);
  assert.equal(typeof err.message, "string", "错误 message 须为文本");
  assert.ok(err.message.length > 0, "错误 message 须给出可操作原因（FB-005）");
}

/**
 * 守卫：超过真实 GUARD_MS 仍未结束即失败，防止挂起测试卡死。
 * 预算语义必须由 ctx.clock 驱动，不得依赖此真实计时。
 */
export async function withGuard(promise, why = "") {
  promise.catch(() => {}); // 守卫超时后原 promise 迟到的拒绝不得成为未处理拒绝
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new assert.AssertionError({
            message: `超过 ${GUARD_MS}ms 仍未结束${why ? `：${why}` : ""}（超时/取消应由 ctx.clock 或 ctx.signal 驱动）`,
          }),
        ),
      GUARD_MS,
    );
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

export { flush };
