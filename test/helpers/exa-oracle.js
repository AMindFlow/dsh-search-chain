// WP9 Exa 适配器验收助手（WP0 oracle 新增，仅供 test/exa-*.test.js 使用）。
// 规格来源：docs/specs/draft/exa.md EXA-001；错误分类依据 docs/specs/draft/fallback.md FB-005。
//
// ─── 规格含糊待办（集中记录；测试只断言规格明确的部分，其余以 TODO-EXA-n 标注）──────────
// TODO-EXA-1  适配器导出形状未定。本助手按顺序容忍：exaBackend | default | createExaBackend()，
//             要求结果具有 search(ctx) 方法（contract.js A5）。dev 请择一并在 PR 中说明。
// TODO-EXA-2  highlights 的请求体形状未定。规格只写「采用 highlights」。断言 contents.highlights 为真值
//             （true 或对象均可）。
// TODO-EXA-3  高亮文本落入 snippet 还是 summary 未定。断言二者择一包含高亮文本。
// TODO-EXA-4  publishedDate → publishedAt 映射规格未写，本套件不断言。
// TODO-EXA-5  numResults 在 type:auto 下的上下限未写（「在该类型支持范围内」）。只测 1..10 内的透传。
// TODO-EXA-6  maxResults 截断责任边界未写（适配器截断还是链截断，FB-002）。适配器只断言返回
//             的是上游顺序的前缀，不断言适配器是否自行截断。
// TODO-EXA-7  5xx 的条目码未写（FB-005 未列）。只断言属于可降级码且非 CREDENTIALS/QUOTA/RATE_LIMITED。
// TODO-EXA-8  缺 key 时适配器的错误码未写（链级 FB-001 保证跳过且零出站）。适配器级只断言：
//             零出站 + 抛错。
// TODO-EXA-9  预算中止的错误形状未写（ENTRY_TIMEOUT 或 AbortError 择一）。只断言二者之一且不 resolve。
// TODO-EXA-10 「设置选项须注明费用随 Exa 搜索和内容用量计算」属于设置面板文案（settings-ui），
//             不在适配器测试内断言。
// TODO-EXA-11 任务简报提到 category/搜索模式字段，但 exa.md 未要求。请求体按「逐字段」只允许
//             query/type/numResults/contents 四键；若需要 category，须先回写规格。
// TODO-EXA-12 Exa 错误体的上游 code 形状未给出。样本沿用 upstream/http-outcomes.json 的通用 error 形状。
// TODO-EXA-13 新 fixture 与 fixtures-hygiene 规则 6 冲突：新增 test/fixtures/exa-*.json 必须在
//             test/helpers/fixtures.js 的 FIXTURE_NAMES 登记，而该文件属于既有 test/ 文件，本任务禁止编辑。
//             因此 Exa 合成样本内联在本文件，仅复用已登记的 upstream/http-outcomes.json。
// ──────────────────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { tryImportSrc, failIfUnimplemented } from "./impl.js";
import { createControlledClock } from "./clock.js";
import { createFakeFetch, SYNTHETIC_KEY } from "./fake-fetch.js";
import { createLogCapture } from "./redact.js";
import { ENTRY_CODES } from "./contract.js";
import { loadFixture, FIXTURE_NAMES } from "./fixtures.js";

export const EXA_WP = "WP9 src/backends/exa.js";
export const EXA_ENDPOINT = "https://api.exa.ai/search";
export const EXA_KEY = SYNTHETIC_KEY("exa");
export const EXA_BUDGET_MS = 25000;
export const EXA_QUERY = '合成查询 "exa" 文档';

/** FB-005 可降级的条目码（不含终止类 CONTENT_POLICY）。 */
export const DEGRADABLE_CODES = Object.freeze(
  Object.values(ENTRY_CODES).filter((c) => c !== ENTRY_CODES.CONTENT_POLICY),
);

/**
 * 加载 Exa 适配器（未实现则按 impl.js 约定红）。
 * @param {import("node:test").TestContext} t
 * @param {string} clauses 条款编号，如 "EXA-001 请求"
 */
export async function loadExaBackend(t, clauses) {
  const res = await tryImportSrc("backends/exa.js");
  failIfUnimplemented(t, res, EXA_WP, clauses);
  const mod = res.module;
  const backend =
    mod.exaBackend ?? mod.default ?? (typeof mod.createExaBackend === "function" ? mod.createExaBackend() : undefined);
  assert.ok(
    backend && typeof backend.search === "function",
    `${clauses}: src/backends/exa.js 须导出 exaBackend = { type: "exa", search(ctx) }（TODO-EXA-1）`,
  );
  return backend;
}

/**
 * 构造适配器上下文（contract.js A5）。默认注入受控时钟与「未声明即抛错」的假 fetch。
 * key 显式传 undefined 时保持缺失（不做默认补齐）。
 */
export function makeExaCtx(opts = {}) {
  const clock = opts.clock ?? createControlledClock();
  const fetch = opts.fetch ?? createFakeFetch({ default: "never", clock });
  const log = createLogCapture();
  const ctx = {
    entry: { id: opts.entryId ?? "exa-entry-1", type: "exa", name: opts.name ?? "Exa 合成条目", enabled: true },
    query: opts.query ?? EXA_QUERY,
    key: "key" in opts ? opts.key : EXA_KEY,
    fetch,
    budgetMs: opts.budgetMs ?? EXA_BUDGET_MS,
    signal: opts.signal ?? new AbortController().signal,
    clock,
    log: log.log,
  };
  if (opts.maxResults !== undefined) ctx.maxResults = opts.maxResults;
  return { ctx, clock, fetch, log };
}

/** 为 Exa 端点声明一条合成响应路由。 */
export function routeExa(fetch, spec) {
  fetch.when(EXA_ENDPOINT).responds(spec);
}

/** 为 Exa 端点声明一条挂起路由（直到 signal 中止）。 */
export function hangExa(fetch) {
  fetch.when(EXA_ENDPOINT).hangs();
}

/** 把 {status, contentType, body} 样本路由到 Exa 端点。 */
export function routeFromResponse(fetch, response, extra = {}) {
  routeExa(fetch, {
    status: response.status,
    body: response.body,
    headers: { "content-type": response.contentType },
    ...extra,
  });
}

/** 把 promise 归一化为 {ok, value|error}，供形状断言。 */
export async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 唯一一次出站记录；数量不为 1 时给出可读断言。 */
export function onlyCall(fetch) {
  assert.equal(fetch.count(), 1, "EXA-001：每次尝试恰好一次 POST 出站");
  return fetch.calls[0];
}

/** 解析请求体（须为 JSON 文本）。 */
export function sentBody(call) {
  assert.equal(typeof call.init.body, "string", "EXA-001：请求体须为 JSON 文本");
  return JSON.parse(call.init.body);
}

// ─── 合成样本（全部虚构，主机使用 .invalid 保留域；见 TODO-EXA-13）──────────────────

/** 合成 Exa 结果项。 */
export function exaResult(i, overrides = {}) {
  return {
    id: `https://exa-sample.invalid/doc/${i}`,
    url: `https://exa-sample.invalid/doc/${i}`,
    title: `合成结果 ${i}`,
    publishedDate: "2026-01-01T00:00:00.000Z",
    highlights: [`合成高亮 ${i}`],
    highlightScores: [0.5],
    ...overrides,
  };
}

/** 合成成功响应体。 */
export function exaOk(results, extra = {}) {
  return { requestId: "req-synthetic-exa-1", results, ...extra };
}

/**
 * 上游错误结局（复用已登记的 upstream/http-outcomes.json），去掉 Tavily 专属的 432 样本。
 * 每项形如 { id, response: { status, contentType, body }, expect: { code } }。
 */
export function sharedUpstreamOutcomes() {
  return loadFixture(FIXTURE_NAMES.upstreamErrors).outcomes.filter((o) => o.id !== "channel-limit-tavily-432");
}

/** 5xx 合成样本（TODO-EXA-7：只断言可降级，不断言具体码）。 */
export const EXA_SERVER_ERRORS = Object.freeze([
  {
    id: "server-500",
    response: {
      status: 500,
      contentType: "application/json",
      body: { error: { type: "server_error", message: "synthetic internal error" } },
    },
  },
  {
    id: "server-503",
    response: { status: 503, contentType: "text/plain", body: "synthetic unavailable" },
  },
]);
