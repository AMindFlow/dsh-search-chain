// WP10 Brave 适配器验收助手（WP0 oracle 新增，仅供 test/brave-*.test.js 使用）。
// 规格来源：docs/specs/draft/brave.md（唯一条款 BRV-001：要求 1 请求、要求 2 映射与失败、验收）；
// 失败分类 docs/specs/draft/fallback.md FB-001..FB-005；脱敏 docs/specs/draft/config-network.md CFG-003。
//
// ─── 样本内联策略 ─────────────────────────────────────────────────────────────
// 本文件内联全部 Brave 合成样本，不新增 test/fixtures/brave/*。原因：test/fixtures-hygiene.test.js 的
// 规则 6 要求每个 fixture 文件都登记在 test/helpers/fixtures.js 的 FIXTURE_NAMES 中，而该文件属于既有
// test/，本任务禁止编辑。仅复用已登记的 upstream/http-outcomes.json（FIXTURE_NAMES.upstreamErrors）。
// 内联样本的卫生由 test/brave-inline-hygiene.test.js 检查。
//
// ─── 适配器 seam（contract.js A5/A6）──────────────────────────────────────────
//   backend = { type: "brave", search(ctx) }
//   ctx = { entry, query, maxResults?, key, fetch, budgetMs, signal, clock, log }
//   search 成功 resolve { sources, content? }；空网页结果 resolve { sources: [] }（FB-004）；
//   失败 throw 携带 .code ∈ ENTRY_CODES 的错误；适配器只调用 ctx.fetch 一次（不重试，FB-001）；
//   预算与取消只走 ctx.clock 与 ctx.signal（受控时钟，FB-003）。
//
// ─── 规格含糊点 ───────────────────────────────────────────────────────────────
// 全部待办断言集中在 test/brave-pending.test.js（头部有 P1..P9 清单）。本助手的主断言只覆盖规格明确
// 或可由规格直接推出的行为；导出形状的容忍写法见 TODO-BRV-1。
//
// TODO-BRV-1  导出形状未定：本助手按序容忍 braveBackend | default | createBraveBackend()。dev 择一并在 PR 说明。
// TODO-BRV-2  「时效参数」：任务简报提及，但 brave.md 未定义任何 freshness 参数。本助手不断言其存在与否。
// TODO-BRV-3  publishedAt：brave.md 只写 url/title/description，未定 page_age 是否映射。本助手不断言。
// ──────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { tryImportSrc, failIfUnimplemented } from "./impl.js";
import { createControlledClock } from "./clock.js";
import { createFakeFetch, SYNTHETIC_KEY } from "./fake-fetch.js";
import { createLogCapture } from "./redact.js";
import { ENTRY_CODES } from "./contract.js";
import { loadFixture, FIXTURE_NAMES } from "./fixtures.js";

export const BRAVE_WP = "WP10 src/backends/brave.js";
/** BRV-001 要求 1 固定端点（规格原文）。 */
export const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
export const BRAVE_KEY = SYNTHETIC_KEY("brave");
export const BRAVE_BUDGET_MS = 25000;
export const BRAVE_QUERY = "合成查询 brave 文档";
/** BRV-001 要求 1：Brave 查询长度上限（字符 600、词 75；超过即参数限制）。 */
export const BRAVE_MAX_CHARS = 600;
export const BRAVE_MAX_WORDS = 75;
/** BRV-001 要求 1：count 取宿主结果数与 20 中较小值。 */
export const BRAVE_MAX_COUNT = 20;
/** 上游回显 key 的合成标记（用于脱敏断言：错误与日志不得回显上游错误体）。 */
export const BRAVE_ECHO_MARK = "synthetic echo of token";

/** FB-001/FB-005：可降级的条目码（不含终止类 CONTENT_POLICY）。 */
export const DEGRADABLE_CODES = Object.freeze(
  Object.values(ENTRY_CODES).filter((c) => c !== ENTRY_CODES.CONTENT_POLICY),
);

/**
 * 加载 Brave 适配器；未实现则按 impl.js 约定红（输出「等待实现 WP10」诊断）。
 * @param {import("node:test").TestContext} t
 * @param {string} clauses 条款说明，如 "BRV-001 要求1"
 */
export async function loadBraveBackend(t, clauses) {
  const res = await tryImportSrc("backends/brave.js");
  failIfUnimplemented(t, res, BRAVE_WP, clauses);
  const mod = res.module;
  const backend =
    mod.braveBackend ?? mod.default ?? (typeof mod.createBraveBackend === "function" ? mod.createBraveBackend() : undefined);
  assert.ok(
    backend && typeof backend.search === "function",
    `${clauses}: src/backends/brave.js 须导出 braveBackend = { type: "brave", search(ctx) }（TODO-BRV-1）`,
  );
  return backend;
}

/** 加载 WP5 的链与分类器（链级与分类测试用）。须先 loadBraveBackend，使 WP10 缺失时先给出 WP10 诊断。 */
export async function loadSearchModule(t, clauses) {
  const res = await tryImportSrc("search.js");
  failIfUnimplemented(t, res, "WP5 src/search.js", clauses);
  return res.module;
}

/**
 * 构造适配器上下文（contract.js A5）。默认注入受控时钟与「未声明即抛错」的假 fetch。
 * key 显式传 undefined 时保持缺失（不做默认补齐）。
 */
export function makeBraveCtx(opts = {}) {
  const clock = opts.clock ?? createControlledClock();
  const fetch = opts.fetch ?? createFakeFetch({ default: "never", clock });
  const log = createLogCapture();
  const ctx = {
    entry: { id: opts.entryId ?? "brave-entry-1", type: "brave", name: opts.name ?? "Brave 合成条目", enabled: true },
    query: opts.query ?? BRAVE_QUERY,
    key: "key" in opts ? opts.key : BRAVE_KEY,
    fetch,
    budgetMs: opts.budgetMs ?? BRAVE_BUDGET_MS,
    signal: opts.signal ?? new AbortController().signal,
    clock,
    log: log.log,
  };
  if (opts.maxResults !== undefined) ctx.maxResults = opts.maxResults;
  return { ctx, clock, fetch, log };
}

/** 为 Brave 端点声明一条合成响应路由。 */
export function routeBrave(fetch, spec) {
  fetch.when(BRAVE_ENDPOINT).responds(spec);
}

/** 为 Brave 端点声明一条挂起路由（直到 signal 中止）。 */
export function hangBrave(fetch) {
  fetch.when(BRAVE_ENDPOINT).hangs();
}

/** 把 {status, contentType, body} 样本路由到 Brave 端点。 */
export function routeFromBraveResponse(fetch, response, extra = {}) {
  routeBrave(fetch, {
    status: response.status,
    body: response.body,
    headers: { "content-type": response.contentType },
    ...extra,
  });
}

/** 把 promise 归一化为 {ok, value|error}。 */
export async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * 真实时间守卫：适配器若误用真实定时器等待，测试在 ms 内失败而非挂起（失败信息可读）。
 * 不吞掉 promise 自身的结果。
 */
export function guard(promise, label, ms = 3000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `[guard] ${label}：${ms}ms 真实时间内未结束。疑似未经 ctx.clock / ctx.signal 结束（BRV-001 / FB-003）`,
          ),
        ),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 断言拒绝并返回错误；若成功则失败并输出结果。 */
export async function rejectionOf(promise, label) {
  const o = await settle(guard(promise, label));
  assert.equal(o.ok, false, `${label}：期望拒绝，实际得到结果 ${JSON.stringify(o.value)}`);
  return o.error;
}

/** 唯一一次出站记录；数量不为 1 时给出可读断言（BRV-001 单次请求、FB-001 每条目一次提交）。 */
export function onlyCall(fetch, label = "BRV-001") {
  assert.equal(fetch.count(), 1, `${label}：每次尝试恰好一次 GET 出站（不得重试）`);
  return fetch.calls[0];
}

/** 解析出站 URL 的查询参数。 */
export function queryParamsOf(call) {
  return new URL(call.url).searchParams;
}

/** 构造 n 个以空格分隔的 ASCII 词（用于词数上限边界）。 */
export function wordsOf(n) {
  return Array.from({ length: n }, () => "w").join(" ");
}

// ─── 合成样本（全部内联；主机使用 .invalid 保留域；不含任何真实 key）─────────────

/** 合成网页结果项（BRV-001 要求 2：url/title/description）。 */
export function braveResult(i, overrides = {}) {
  return {
    url: `https://brave-sample.invalid/doc/${i}`,
    title: `合成标题 ${i}`,
    description: `合成描述 ${i}`,
    ...overrides,
  };
}

/** 合成成功响应体（web.results）。 */
export function braveOk(results, extra = {}) {
  return { type: "search", query: { original: BRAVE_QUERY }, web: { type: "search", results }, ...extra };
}

/** 合成「可识别的空网页结果」：web.results 为空数组（BRV-001 要求 2）。 */
export function braveEmpty() {
  return { type: "search", query: { original: BRAVE_QUERY }, web: { type: "search", results: [] } };
}

/** 混合无效条目：缺 URL、相对路径、非 HTTP(S) 协议、非字符串、null；有效条目为 doc/1 与 doc/5。 */
export function braveMixedInvalid() {
  return braveOk([
    braveResult(1),
    { title: "合成缺 URL 条目", description: "合成描述" },
    braveResult(2, { url: "/relative/path" }),
    braveResult(3, { url: "javascript:void(0)" }),
    braveResult(4, { url: 12345 }),
    null,
    braveResult(5),
  ]);
}
export const BRAVE_MIXED_VALID_URLS = Object.freeze([
  "https://brave-sample.invalid/doc/1",
  "https://brave-sample.invalid/doc/5",
]);

/** 全部无效：results 非空但无有效绝对 HTTP(S) URL（畸形数据，BRV-001 要求 2 → BAD_RESPONSE）。 */
export function braveAllInvalid() {
  return braveOk([{ title: "合成缺 URL 条目" }, braveResult(9, { url: "/rel" })]);
}

/** 供应商正文类字段（FB-002：纯来源适配器不得把它当作通用 content）。 */
export function braveWithFaq() {
  return braveOk([braveResult(1)], {
    faq: { results: [{ question: "合成问题", answer: "合成供应商正文，不得成为 content" }] },
  });
}

/** 回显 key 的上游 401 错误体（CFG-003：错误与日志不得回显原始体）。 */
export function braveEchoKeyBody() {
  return { error: { type: "authentication_error", message: `${BRAVE_ECHO_MARK} ${BRAVE_KEY}` } };
}

/** 合成 HTML 拦截页（CFG-003：原始报错体不进入错误文本）。 */
export const BRAVE_BLOCK_HTML = "<html><body>合成拦截页 synthetic block</body></html>";

/** 合成非 JSON 文本（200 但不可解析）。 */
export const BRAVE_NON_JSON_TEXT = "{ 合成不可解析响应 (synthetic)";

/**
 * 上游结局分类样本：复用已登记的 upstream/http-outcomes.json（FB-005 通用样本），
 * 去掉 Tavily 专属 432 样本。每项 { id, describe, response: {status, contentType, body}, expect: {code} }。
 */
export function sharedUpstreamOutcomes() {
  return loadFixture(FIXTURE_NAMES.upstreamErrors).outcomes.filter((o) => o.id !== "channel-limit-tavily-432");
}

/** 5xx 合成样本（FB-005 未列 5xx 具体码：主断言只要求可降级，精确码见 brave-pending P4）。 */
export const BRAVE_SERVER_ERRORS = Object.freeze([
  {
    id: "server-500",
    response: {
      status: 500,
      contentType: "application/json",
      body: { error: { type: "server_error", message: "合成内部错误" } },
    },
  },
  { id: "server-503", response: { status: 503, contentType: "text/plain", body: "合成暂不可用" } },
]);

/** 全部内联样本的集合，供内联卫生检查遍历。 */
export function inlineSamples() {
  return {
    ok: braveOk([braveResult(1), braveResult(2), braveResult(3)]),
    empty: braveEmpty(),
    mixedInvalid: braveMixedInvalid(),
    allInvalid: braveAllInvalid(),
    withFaq: braveWithFaq(),
    echoKeyBody: braveEchoKeyBody(),
    blockHtml: BRAVE_BLOCK_HTML,
    nonJson: BRAVE_NON_JSON_TEXT,
    serverErrors: BRAVE_SERVER_ERRORS.map((s) => s.response),
  };
}
