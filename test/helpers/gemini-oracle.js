// WP11 Gemini 验收替身与内联样本（GMI-001 / GMI-002，并引用 FB-001/002/003/005、CFG-002/003）。
//
// 样本全部内联在本文件中：不改 test/helpers/fixtures.js，不新增 fixture 文件（fixtures/README 规则 6）。
// 所有 URL 主机保留 TLD（.invalid），所有 key 为可辨识合成值（卫生规则 1/2/4）。
//
// ─── 适配器 seam（contract.js A5/A6，本文件消费的契约）─────────────────────────
//   src/backends/gemini.js 导出  createGeminiBackend() → { type: "gemini", search(ctx) }
//   ctx = { entry, query, maxResults, key, fetch, budgetMs, signal, clock, log }
//     - fetch 即 ctx.fetch（假 fetch）；适配器自身用它出站（A6）。
//     - 出站 init.signal 必须是「ctx.signal 与预算中止」合并后的信号（FB-003）。
//     - 预算须经 ctx.clock.setTimeout 调度，禁止全局 setTimeout / Date.now（受控时钟）。
//   search 成功 resolve { sources: [{ url, title?, snippet? }], content? }
//     （无 truncated：FB-002 截断与标记由链补齐，适配器不负责）。
//   search 失败 throw 携带 .code ∈ ENTRY_CODES 的错误（FB-005）；宿主取消不得带 ENTRY 码（FB-001）。
// ──────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { createControlledClock, flush } from "./clock.js";
import { createFakeFetch } from "./fake-fetch.js";
import { createLogCapture } from "./redact.js";
import { tryImportSrc, failIfUnimplemented } from "./impl.js";
import { makeEntry, DEFAULT_TIMEOUT_MS, ENTRY_CODES } from "./contract.js";

/** GMI-001 规定端点（无路径模型参数，模型置于 body）。 */
export const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
/** 假 fetch 路由匹配串（端点路径片段）。 */
export const GEMINI_ROUTE = "/v1beta/interactions";
/** 合成 key：可辨识、非真实形状的字符串。 */
export const GEMINI_KEY = "AIzaSYNTHETIC-gemini-KEY-DO-NOT-LOG";
export const DEFAULT_QUERY = "合成查询 gemini grounding";
/** GMI-002：上游搜索建议 HTML 的可辨识标记。 */
export const SUGGESTION_MARK = "synthetic-search-suggestions";
export const SUGGESTION_HTML = `<div class="${SUGGESTION_MARK}"><a href="https://www.google.invalid/search?q=synthetic">合成建议</a></div>`;
/** 上游原始报错体的可辨识标记（CFG-003：不得进入错误、details、cause、stack、日志）。 */
export const RAW_MARK = "SYNTH-RAW-UPSTREAM-BODY-MARK";

export const ENTRY_CODE_SET = new Set(Object.values(ENTRY_CODES));

export const SRC_A = Object.freeze({ url: "https://news.synthetic-host.invalid/a", title: "合成来源 A" });
export const SRC_B = Object.freeze({ url: "https://news.synthetic-host.invalid/b", title: "合成来源 B" });

/** url_citation 注释（GMI-001「引用」）。字段名 url/title/start_index/end_index 来自 Interactions 文档（推断，见 P-01 说明）。 */
export function urlCitation({ url, title, start = 0, end = 4 }) {
  return { type: "url_citation", url, title, start_index: start, end_index: end };
}

const searchCall = (id) => ({ type: "google_search_call", id, arguments: { queries: ["合成查询"] } });
const searchResult = (callId, suggestion) => ({
  type: "google_search_result",
  call_id: callId,
  result: { rendered_content: suggestion },
});

/**
 * 旧式 outputs 结构（Interactions 文档的 legacy 形状，推断）。
 * withSearch=false 表示没有任何 google_search_* 步骤（缺少服务端搜索证据，GMI-001）。
 */
export function outputsResponse({
  text = "合成回答正文",
  annotations = [],
  suggestion = SUGGESTION_HTML,
  status = "completed",
  withSearch = true,
} = {}) {
  const outputs = [];
  if (withSearch) {
    outputs.push(searchCall("synthetic-call-1"), searchResult("synthetic-call-1", suggestion));
  }
  outputs.push({ type: "text", text, annotations });
  return { id: "synthetic-interaction-outputs", status, outputs };
}

/**
 * 新式 steps 结构（May 2026 迁移指南的 steps 形状，推断）。
 * 与 outputsResponse 同一语义；适配器应对两种形状得到相同映射（见 P-01/R2）。
 */
export function stepsResponse({
  text = "合成回答正文",
  annotations = [],
  suggestion = SUGGESTION_HTML,
  status = "completed",
  withSearch = true,
} = {}) {
  const steps = [{ type: "user_input", content: [{ type: "text", text: DEFAULT_QUERY }] }];
  if (withSearch) {
    steps.push(searchCall("synthetic-call-1"), searchResult("synthetic-call-1", suggestion));
  }
  steps.push({ type: "model_output", content: [{ type: "text", text, annotations }] });
  return { id: "synthetic-interaction-steps", status, steps };
}

/** 两个合法引用的标准成功样本（outputs 形状）。 */
export function groundedOutputs() {
  return outputsResponse({ annotations: [urlCitation(SRC_A), urlCitation(SRC_B)] });
}

/**
 * 上游失败样本（FB-005 分类输入）。
 * 数值与 http-outcomes.json 的 401/402/429/403-HTML/malformed-200 语义一致，但内联、不引用其文件。
 */
export const UPSTREAM = Object.freeze({
  auth401: () => ({ status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED", message: "合成鉴权失败 SYNTH-401" } } }),
  perm403: () => ({ status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: "合成权限拒绝 SYNTH-403" } } }),
  block403Html: () => ({
    status: 403,
    headers: { "content-type": "text/html" },
    body: `<html><body>${RAW_MARK}</body></html>`,
  }),
  payment402: () => ({ status: 402, body: { error: { code: 402, status: "PAYMENT_REQUIRED", message: "合成付费 SYNTH-402" } } }),
  quotaCode429: () => ({ status: 429, body: { error: { code: "insufficient_quota", message: "合成额度 SYNTH-429Q" } } }),
  rate429: () => ({ status: 429, body: { error: { code: 429, message: "Rate limit exceeded (synthetic) SYNTH-429R" } } }),
  server500: () => ({ status: 500, body: { error: { code: 500, status: "INTERNAL", message: `合成内部错误 ${RAW_MARK}` } } }),
  malformed200: () => ({ status: 200, body: "{ this is not json (synthetic)" }),
});

/**
 * 构造一次适配器调用的替身环境。
 * @returns {{ clock, fetch, logs, ctl, ctx }} ctx 即传给 backend.search 的上下文。
 */
export function newRig({ budgetMs = DEFAULT_TIMEOUT_MS, key = GEMINI_KEY, query = DEFAULT_QUERY, maxResults = 5, signal } = {}) {
  const clock = createControlledClock();
  const fetch = createFakeFetch({ default: "never", clock });
  const logs = createLogCapture();
  const ctl = new AbortController();
  const ctx = {
    entry: makeEntry({ id: "gem-1", type: "gemini", name: "Gemini 条目", enabled: true }),
    query,
    maxResults,
    key,
    fetch,
    budgetMs,
    signal: signal ?? ctl.signal,
    clock,
    log: logs.log,
  };
  return { clock, fetch, logs, ctl, ctx };
}

/** 调用 backend.search(ctx)，同步抛出也被转为拒绝。 */
export function startSearch(backend, rig) {
  return new Promise((resolve) => resolve(backend.search(rig.ctx)));
}

/**
 * 驱动受控时钟直到结果收敛。只拨动注入的 clock，不用真实定时器。
 * 若既无结果也无待触发定时器，说明实现未经 ctx.clock 调度或已停滞，直接判红。
 * @returns {Promise<{ok:true, value:any} | {ok:false, error:any}>}
 */
export async function settle(rig, promise, maxSteps = 200) {
  let outcome = null;
  promise.then(
    (value) => {
      outcome = { ok: true, value };
    },
    (error) => {
      outcome = { ok: false, error };
    },
  );
  for (let i = 0; i < maxSteps && !outcome; i += 1) {
    await flush(2);
    if (outcome) break;
    const due = rig.clock.nextDue();
    if (due === null) break;
    rig.clock.advance(Math.max(1, due - rig.clock.now()));
  }
  await flush(3);
  if (!outcome) {
    assert.fail(
      `搜索未收敛（既无结果也无待触发定时器）。pending=${JSON.stringify(rig.clock.pending())}。` +
        "若实现未经 ctx.clock 调度，即违反受控时钟约定（FB-003）",
    );
  }
  return outcome;
}

/** 断言结果为拒绝，返回错误对象。 */
export function expectRejected(outcome, label) {
  assert.equal(outcome.ok, false, `${label}：应拒绝（失败分类），实际成功：${JSON.stringify(outcome.value)}`);
  return outcome.error;
}

/** 断言错误的条目分类码。 */
export function expectCode(err, code, label) {
  assert.ok(err && typeof err === "object", `${label}：须抛出错误对象`);
  assert.equal(err.code, code, `${label}：条目分类码应为 ${code}（FB-005），实际 ${String(err.code)}`);
}

/** 断言错误不是条目可降级分类（宿主取消/程序违约路径，FB-001）。 */
export function expectNotEntryCode(err, label) {
  assert.ok(err && typeof err === "object", `${label}：须抛出错误对象`);
  assert.ok(!ENTRY_CODE_SET.has(err.code), `${label}：宿主取消不得归为可降级条目分类（FB-001），实际 ${String(err.code)}`);
}

/** 断言来源数组形状（A1/FB-002）：url 为绝对 HTTP(S)，title/snippet/summary 若存在为字符串。 */
export function assertSourceShape(sources, label = "sources") {
  assert.ok(Array.isArray(sources), `${label} 必须是数组（A5）`);
  sources.forEach((s, i) => {
    assert.equal(typeof s?.url, "string", `${label}[${i}].url 必须是字符串（A1）`);
    let u;
    try {
      u = new URL(s.url);
    } catch {
      assert.fail(`${label}[${i}].url 必须可解析（FB-002）：${s.url}`);
    }
    assert.ok(u.protocol === "http:" || u.protocol === "https:", `${label}[${i}].url 必须是绝对 HTTP(S)（FB-002）：${s.url}`);
    for (const f of ["title", "snippet", "summary"]) {
      if (s[f] !== undefined) assert.equal(typeof s[f], "string", `${label}[${i}].${f} 若存在须为字符串`);
    }
  });
}

/** sources 投影为 url/title，用于与期望比较（snippet 归 P-06）。 */
export function urlTitle(sources) {
  return sources.map((s) => ({ url: s.url, title: s.title }));
}

/** 本次出站调用（路由匹配 Gemini 端点）。 */
export function gemCalls(fetch) {
  return fetch.callsFor(GEMINI_ROUTE);
}

/** 解析某次出站的 JSON body。 */
export function bodyOf(call) {
  return JSON.parse(call.init.body);
}

/**
 * 加载适配器模块并实例化。模块缺失或未导出 createGeminiBackend 时判红（failIfUnimplemented）。
 * @param {import("node:test").TestContext} t
 * @param {string} clauses 覆盖的条款编号
 */
export async function loadGeminiBackend(t, clauses) {
  const res = await tryImportSrc("backends/gemini.js");
  failIfUnimplemented(t, res, "WP11 src/backends/gemini.js", clauses);
  const factory = res.module.createGeminiBackend;
  assert.equal(typeof factory, "function", `${clauses}：src/backends/gemini.js 须导出 createGeminiBackend()（A5 seam，见本文件头注释）`);
  const backend = factory();
  assert.equal(backend?.type, "gemini", `${clauses}：backend.type 须为 "gemini"（A5）`);
  assert.equal(typeof backend.search, "function", `${clauses}：backend.search 须为函数（A5）`);
  return backend;
}

/**
 * 加载 src/search.js（A4：classifyUpstreamFailure）。模块缺失时判红。
 * @param {import("node:test").TestContext} t
 * @param {string} clauses
 */
export async function loadSearchModule(t, clauses) {
  const res = await tryImportSrc("search.js");
  failIfUnimplemented(t, res, "WP5 src/search.js（classifyUpstreamFailure）", clauses);
  assert.equal(typeof res.module.classifyUpstreamFailure, "function", `${clauses}：src/search.js 须导出 classifyUpstreamFailure（A4）`);
  return res.module;
}
