// WP10 Brave 验收 — brave.md BRV-001 要求 2（映射、空与失败）+ FB-002（来源与 content）+ FB-004（空结果）+ FB-005（失败分类）。
// 覆盖：web.results 顺序映射 url/title/description；无效条目丢弃保有效；可识别空结果为 sources:[]；
//       全无效 / 非 JSON / 结构错误 → ENTRY_BAD_RESPONSE；纯来源适配不产出 content；
//       http-outcomes.json 通用样本与 Brave 的 401/402/403/429/异常响应分类；5xx 可降级；单次请求不重试；
//       classifyUpstreamFailure 对状态码与上游 code 的分类（WP5 seam）。
// 红属预期：src/backends/brave.js（WP10）缺失时经 impl.js 报「等待实现 WP10」；精确 5xx 码、
//           缺 web 字段等不确定点移至 brave-pending.test.js。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import {
  BRAVE_BLOCK_HTML,
  BRAVE_NON_JSON_TEXT,
  BRAVE_SERVER_ERRORS,
  BRAVE_MIXED_VALID_URLS,
  DEGRADABLE_CODES,
  braveAllInvalid,
  braveEmpty,
  braveMixedInvalid,
  braveOk,
  braveResult,
  braveWithFaq,
  guard,
  loadBraveBackend,
  loadSearchModule,
  makeBraveCtx,
  onlyCall,
  rejectionOf,
  routeBrave,
  routeFromBraveResponse,
  sharedUpstreamOutcomes,
} from "./helpers/brave-oracle.js";

// ─── BRV-001 要求 2：正常映射 ─────────────────────────────────────────────────

test("BRV-001 要求2：web.results 顺序保持，url/title 精确；description 文本落入 snippet 或 summary（择一）", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求2 映射");
  const { ctx, fetch } = makeBraveCtx({ maxResults: 3 });
  routeBrave(fetch, { status: 200, body: braveOk([braveResult(1), braveResult(2), braveResult(3)]) });
  const result = await guard(backend.search(ctx), "映射");
  onlyCall(fetch, "BRV-001 要求2 映射");
  C.assertSearchResult(t, result, {});
  assert.deepEqual(
    result.sources.map((s) => s.url),
    ["https://brave-sample.invalid/doc/1", "https://brave-sample.invalid/doc/2", "https://brave-sample.invalid/doc/3"],
    "BRV-001：按 web.results 顺序提取 url",
  );
  assert.deepEqual(
    result.sources.map((s) => s.title),
    ["合成标题 1", "合成标题 2", "合成标题 3"],
    "BRV-001：title 原样映射",
  );
  for (const [i, s] of result.sources.entries()) {
    assert.ok(
      [s.snippet, s.summary].includes(`合成描述 ${i + 1}`),
      `BRV-001：description 须落入 snippet 或 summary（字段择一，精确字段见 brave-pending P1）：${JSON.stringify(s)}`,
    );
  }
});

test("BRV-001 要求2：无效条目（缺 URL、相对路径、javascript:、非字符串、null）被丢弃，有效条目保留且顺序不变", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求2 无效条目");
  const { ctx, fetch } = makeBraveCtx();
  routeBrave(fetch, { status: 200, body: braveMixedInvalid() });
  const result = await guard(backend.search(ctx), "无效条目");
  onlyCall(fetch, "BRV-001 要求2 无效条目");
  C.assertSearchResult(t, result, {});
  assert.deepEqual(
    result.sources.map((s) => s.url),
    [...BRAVE_MIXED_VALID_URLS],
    "BRV-001：仅保留有效绝对 HTTP(S) 条目，且保持 web.results 顺序",
  );
});

test("BRV-001 要求2：200 且 web.results 为空数组 → 无结果，sources:[]，不抛错（可识别的空网页结果）", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求2 空结果");
  const { ctx, fetch } = makeBraveCtx();
  routeBrave(fetch, { status: 200, body: braveEmpty() });
  const result = await guard(backend.search(ctx), "空结果");
  onlyCall(fetch, "BRV-001 要求2 空结果");
  assert.deepEqual(result.sources, [], "BRV-001：可识别的空网页结果为无结果（FB-004 明确空）");
});

test("FB-002 + BRV-001：纯来源适配器不得把响应中的供应商正文（faq 等）映射为 content", async (t) => {
  const backend = await loadBraveBackend(t, "FB-002 纯来源 content");
  const { ctx, fetch } = makeBraveCtx();
  routeBrave(fetch, { status: 200, body: braveWithFaq() });
  const result = await guard(backend.search(ctx), "content");
  onlyCall(fetch, "FB-002 content");
  assert.equal(result.content, undefined, "FB-002：Brave 为纯来源适配器，供应商正文不得作为通用 content");
  assert.equal(result.sources.length, 1, "来源仍须从 web.results 提取");
});

// ─── BRV-001 要求 2 / FB-005：畸形与失败 ──────────────────────────────────────

test("BRV-001 要求2 / FB-005：results 非空但无一有效绝对 URL（畸形数据）→ ENTRY_BAD_RESPONSE", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求2 全无效");
  const { ctx, fetch } = makeBraveCtx();
  routeBrave(fetch, { status: 200, body: braveAllInvalid() });
  const err = await rejectionOf(backend.search(ctx), "全无效");
  onlyCall(fetch, "BRV-001 要求2 全无效");
  assert.equal(err?.code, C.ENTRY_CODES.BAD_RESPONSE, "BRV-001：畸形数据按降级规格报告为异常响应");
});

test("BRV-001 要求2 / FB-005：web.results 不是数组（结构错误）→ ENTRY_BAD_RESPONSE", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求2 结构错误");
  const { ctx, fetch } = makeBraveCtx();
  routeBrave(fetch, { status: 200, body: { type: "search", web: { results: { url: "https://brave-sample.invalid/x" } } } });
  const err = await rejectionOf(backend.search(ctx), "结构错误");
  onlyCall(fetch, "BRV-001 要求2 结构错误");
  assert.equal(err?.code, C.ENTRY_CODES.BAD_RESPONSE, "BRV-001：results 非数组属无效结构");
});

test("BRV-001 要求2 / FB-005：JSON 顶层为 null → ENTRY_BAD_RESPONSE（不是可识别的空结果）", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求2 null");
  const { ctx, fetch } = makeBraveCtx();
  routeBrave(fetch, { status: 200, body: "null" });
  const err = await rejectionOf(backend.search(ctx), "null");
  onlyCall(fetch, "BRV-001 要求2 null");
  assert.equal(err?.code, C.ENTRY_CODES.BAD_RESPONSE, "BRV-001：顶层 null 为无效结构");
});

test("BRV-001 要求2 / FB-005：200 非 JSON 文本 → ENTRY_BAD_RESPONSE", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求2 非 JSON");
  const { ctx, fetch } = makeBraveCtx();
  routeBrave(fetch, { status: 200, body: BRAVE_NON_JSON_TEXT });
  const err = await rejectionOf(backend.search(ctx), "非 JSON");
  onlyCall(fetch, "BRV-001 要求2 非 JSON");
  assert.equal(err?.code, C.ENTRY_CODES.BAD_RESPONSE, "BRV-001：非 JSON 为异常响应");
});

test("BRV-001 要求2 / FB-005：200 HTML 拦截页（非 JSON）→ ENTRY_BAD_RESPONSE", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求2 HTML 200");
  const { ctx, fetch } = makeBraveCtx();
  routeFromBraveResponse(fetch, { status: 200, contentType: "text/html", body: BRAVE_BLOCK_HTML });
  const err = await rejectionOf(backend.search(ctx), "HTML 200");
  onlyCall(fetch, "BRV-001 要求2 HTML 200");
  assert.equal(err?.code, C.ENTRY_CODES.BAD_RESPONSE, "BRV-001：HTML 响应体不是 Brave 结构，为异常响应");
});

// ─── FB-005 通用上游结局样本（复用已登记的 upstream/http-outcomes.json）────────

for (const o of sharedUpstreamOutcomes()) {
  test(`FB-005 / BRV-001：上游结局「${o.id}」→ ${o.expect.code}（${o.describe}）`, async (t) => {
    const backend = await loadBraveBackend(t, `FB-005 ${o.id}`);
    const { ctx, fetch } = makeBraveCtx();
    routeFromBraveResponse(fetch, o.response);
    const err = await rejectionOf(backend.search(ctx), o.id);
    onlyCall(fetch, `FB-005 ${o.id}`);
    assert.equal(err?.code, o.expect.code, `FB-005：分类码须为 ${o.expect.code}（样本 ${o.id}）`);
    assert.ok(DEGRADABLE_CODES.includes(err.code), `FB-005：${o.id} 属可降级条目失败`);
  });
}

test("FB-005 / BRV-001：401 鉴权失败 → ENTRY_CREDENTIALS，单次请求", async (t) => {
  const backend = await loadBraveBackend(t, "FB-005 401");
  const { ctx, fetch } = makeBraveCtx();
  routeBrave(fetch, { status: 401, body: { error: { message: "合成鉴权失败" } } });
  const err = await rejectionOf(backend.search(ctx), "401");
  onlyCall(fetch, "401");
  assert.equal(err?.code, C.ENTRY_CODES.CREDENTIALS, "FB-005：401 属凭据或权限问题");
});

test("FB-005 / BRV-001：402 额度 → ENTRY_QUOTA，单次请求", async (t) => {
  const backend = await loadBraveBackend(t, "FB-005 402");
  const { ctx, fetch } = makeBraveCtx();
  routeBrave(fetch, { status: 402, body: { error: { message: "合成额度不足" } } });
  const err = await rejectionOf(backend.search(ctx), "402");
  onlyCall(fetch, "402");
  assert.equal(err?.code, C.ENTRY_CODES.QUOTA, "FB-005：HTTP 402 属额度问题");
});

test("FB-005 / BRV-001：403 权限 → ENTRY_CREDENTIALS（不因 JSON 体形状改变分类）", async (t) => {
  const backend = await loadBraveBackend(t, "FB-005 403");
  const { ctx, fetch } = makeBraveCtx();
  routeBrave(fetch, { status: 403, body: { error: { message: "合成权限不足" } } });
  const err = await rejectionOf(backend.search(ctx), "403");
  onlyCall(fetch, "403");
  assert.equal(err?.code, C.ENTRY_CODES.CREDENTIALS, "FB-005：403 属凭据或权限问题");
});

test("FB-005 / BRV-001：其他 429 限流 → ENTRY_RATE_LIMITED，且不重试（单次请求）", async (t) => {
  const backend = await loadBraveBackend(t, "FB-005 429");
  const { ctx, fetch } = makeBraveCtx();
  routeBrave(fetch, { status: 429, body: { error: { message: "合成限流" } } });
  const err = await rejectionOf(backend.search(ctx), "429");
  onlyCall(fetch, "429 不重试");
  assert.equal(err?.code, C.ENTRY_CODES.RATE_LIMITED, "FB-005：非 insufficient_quota 的 429 属限流");
});

for (const s of BRAVE_SERVER_ERRORS) {
  test(`FB-005 / BRV-001：5xx「${s.id}」可降级（非凭据/额度/限流），且单次请求不重试`, async (t) => {
    const backend = await loadBraveBackend(t, `FB-005 ${s.id}`);
    const { ctx, fetch } = makeBraveCtx();
    routeFromBraveResponse(fetch, s.response);
    const err = await rejectionOf(backend.search(ctx), s.id);
    onlyCall(fetch, `5xx ${s.id}`);
    assert.ok(DEGRADABLE_CODES.includes(err?.code), `FB-005：5xx 须为可降级条目码（精确码见 brave-pending P4），实际：${err?.code}`);
    assert.ok(
      ![C.ENTRY_CODES.CREDENTIALS, C.ENTRY_CODES.QUOTA, C.ENTRY_CODES.RATE_LIMITED].includes(err.code),
      "FB-005：5xx 不属凭据、额度或限流",
    );
  });
}

test("FB-005 / BRV-001：网络层失败（fetch 拒绝）→ 可降级条目码，单次请求不重试", async (t) => {
  const backend = await loadBraveBackend(t, "FB-005 网络失败");
  const { ctx, fetch } = makeBraveCtx();
  fetch.when((url) => url.startsWith("https://api.search.brave.com/")).fails({
    error: new TypeError("合成网络故障 fetch failed"),
  });
  const err = await rejectionOf(backend.search(ctx), "网络失败");
  onlyCall(fetch, "网络失败");
  assert.ok(DEGRADABLE_CODES.includes(err?.code), `FB-005：直连网络失败须可降级（精确码见 brave-pending P5），实际：${err?.code}`);
});

// ─── classifyUpstreamFailure（WP5 seam，A4）：Brave 相关输入的分类 ────────────────

const CLASSIFIER_CASES = [
  [{ status: 401 }, C.ENTRY_CODES.CREDENTIALS, "401 → 凭据"],
  [{ status: 402 }, C.ENTRY_CODES.QUOTA, "402 → 额度"],
  [{ status: 403 }, C.ENTRY_CODES.CREDENTIALS, "403 → 凭据或权限"],
  [{ status: 429 }, C.ENTRY_CODES.RATE_LIMITED, "429 → 限流"],
  [{ status: 429, upstreamCode: "insufficient_quota" }, C.ENTRY_CODES.QUOTA, "429 + insufficient_quota → 额度"],
];

for (const [info, want, label] of CLASSIFIER_CASES) {
  test(`FB-005：classifyUpstreamFailure ${label}`, async (t) => {
    await loadBraveBackend(t, "FB-005 classifier 前置");
    const { classifyUpstreamFailure } = await loadSearchModule(t, "FB-005 classifyUpstreamFailure");
    assert.equal(typeof classifyUpstreamFailure, "function", "A4：search.js 须导出 classifyUpstreamFailure(info)");
    assert.equal(classifyUpstreamFailure(info), want, `FB-005：${JSON.stringify(info)} 的分类码`);
  });
}
