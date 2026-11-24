// WP2 验收 — OAI-003 HTTP 错误分类（src/backends/openai.js）+ FB-005 通用分类（src/search.js，WP5）。
// 覆盖条款：
//   OAI-003 要求：带 HTTP 错误的响应按 FB-005 分类；上游明确拒绝报告拒绝终态（见 openai-mapping.test.js）。
//   FB-005：401 → 凭据或权限；402 → 额度；429 + error.code=insufficient_quota → 额度（OpenAI 典型形状，
//           与上游样本 upstream/http-outcomes.json 的 quota-code-insufficient 同构）；其他 429 → 限流；
//           403 → 凭据或权限（http-outcomes blocked-403-html 为供应商无关的注册期望码）；
//           5xx/无法解析 → 异常响应 ENTRY_BAD_RESPONSE；网络层故障（无 HTTP 状态）→ ENTRY_NETWORK。
//   FB-001：每条目最多一次查询 → 每个失败用例出站恰好一次（无内部重试）。
// 推断（集中说明，硬断言在 openai-pending.test.js）：HTTP 400 → ENTRY_CHANNEL_LIMIT（P9）；
//   非 200 的 content_filter 拒绝载体 → ENTRY_CONTENT_POLICY（P7）。403→CREDENTIALS、5xx→BAD_RESPONSE
//   分别为 http-outcomes 注册码与 FB-005「异常响应」的直接应用，留本文件。
// 取消与超时见 openai-budget.test.js；脱敏见 openai-redaction.test.js。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { loadFixture, FIXTURE_NAMES } from "./helpers/fixtures.js";
import {
  WP_SEARCH,
  SYNTH_AUTH_BODY,
  SYNTH_QUOTA_BODY,
  SYNTH_RATE_BODY,
  openaiFetch,
  openaiFetchFails,
  loadOpenAIBackend,
  makeCtx,
  singleCall,
  rejectionOf,
  assertEntryError,
} from "./helpers/openai-oracle.js";

const HTML_BODY = "<html><body>synthetic upstream error page</body></html>";

const CASES = [
  { label: "401 鉴权失败", status: 401, body: SYNTH_AUTH_BODY, code: C.ENTRY_CODES.CREDENTIALS, clause: "FB-005/OAI-003" },
  { label: "403 权限不足（http-outcomes 注册码→凭据或权限）", status: 403, body: SYNTH_AUTH_BODY, code: C.ENTRY_CODES.CREDENTIALS, clause: "FB-005" },
  { label: "402 额度（FB-005 明文）", status: 402, body: { error: { type: "insufficient_balance", message: "synthetic quota message" } }, code: C.ENTRY_CODES.QUOTA, clause: "FB-005/OAI-003" },
  { label: "429 + error.code=insufficient_quota → 额度（FB-005 明文，OpenAI 典型形状）", status: 429, body: SYNTH_QUOTA_BODY, code: C.ENTRY_CODES.QUOTA, clause: "FB-005" },
  { label: "429 限流（非 insufficient_quota）", status: 429, body: SYNTH_RATE_BODY, code: C.ENTRY_CODES.RATE_LIMITED, clause: "FB-005/OAI-003" },
  { label: "500 上游异常（FB-005 异常响应）", status: 500, body: HTML_BODY, headers: { "content-type": "text/html" }, code: C.ENTRY_CODES.BAD_RESPONSE, clause: "FB-005" },
  { label: "503 上游异常（FB-005 异常响应）", status: 503, body: { error: "synthetic unavailable" }, code: C.ENTRY_CODES.BAD_RESPONSE, clause: "FB-005" },
];

for (const c of CASES) {
  test(`${c.clause}：${c.label} → ${c.code}，且出站恰好一次`, async (t) => {
    const backend = await loadOpenAIBackend(t, c.clause);
    if (!backend) return;
    const fetch = openaiFetch({ status: c.status, body: c.body, headers: c.headers });
    const err = await rejectionOf(backend.search(makeCtx({ fetch })));
    assertEntryError(err, c.code);
    singleCall(fetch, c.label);
  });
}

test("FB-005：网络层故障（无 HTTP 状态）→ ENTRY_NETWORK，且不重试", async (t) => {
  const backend = await loadOpenAIBackend(t, "FB-005");
  if (!backend) return;
  const fetch = openaiFetchFails(new TypeError("synthetic fetch failed"));
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.NETWORK);
  singleCall(fetch, "网络故障");
});

// 与上游样本 fixture 对表（test/fixtures/upstream/http-outcomes.json，FB-005 注册期望码）。
// 跳过两项：channel-limit-tavily-432 的 note 明示「细分依据 TAV-002」（Tavily 专属）；
// blocked-403-html 的 note 只把 Bing 排除出 CREDENTIALS 细分（「其他供应商按 FB-005 归类」→本文件上方 403 用例已覆盖其注册码）。
const FIXTURE_IDS = ["auth-401", "quota-402", "quota-code-insufficient", "rate-429", "malformed-200"];

for (const outcome of loadFixture(FIXTURE_NAMES.upstreamErrors).outcomes.filter((o) => FIXTURE_IDS.includes(o.id))) {
  test(`FB-005（fixture 对表 ${outcome.id}）：适配器分类与上游样本注册码一致`, async (t) => {
    const backend = await loadOpenAIBackend(t, "FB-005/OAI-003");
    if (!backend) return;
    const fetch = openaiFetch({
      status: outcome.response.status,
      body: outcome.response.body,
      headers: { "content-type": outcome.response.contentType },
    });
    const err = await rejectionOf(backend.search(makeCtx({ fetch })));
    assertEntryError(err, outcome.expect.code);
    singleCall(fetch, outcome.id);
  });
}

// 通用分类函数（A4，src/search.js，WP5 负责）。OpenAI 适配器不得自带一套与之矛盾的 5xx/传输分类。
test("FB-005：classifyUpstreamFailure 通用规则（5xx、异常响应、传输故障）", async (t) => {
  const res = await tryImportSrc("search.js");
  if (failIfUnimplemented(t, res, WP_SEARCH, "FB-005")) return;
  const { classifyUpstreamFailure } = res.module;
  assert.equal(typeof classifyUpstreamFailure, "function", "search.js 须导出 classifyUpstreamFailure（A4）");
  assert.equal(classifyUpstreamFailure({ status: 500, phase: "response" }), C.ENTRY_CODES.BAD_RESPONSE, "FB-005：5xx 属异常响应");
  assert.equal(classifyUpstreamFailure({ status: 503, phase: "response" }), C.ENTRY_CODES.BAD_RESPONSE, "FB-005：503 属异常响应");
  assert.equal(
    classifyUpstreamFailure({ status: 200, phase: "response" }),
    C.ENTRY_CODES.BAD_RESPONSE,
    "FB-005：异常响应（无法解析的正文）属 ENTRY_BAD_RESPONSE",
  );
  assert.equal(
    classifyUpstreamFailure({ status: 500, upstreamCode: "insufficient_quota", phase: "response" }),
    C.ENTRY_CODES.QUOTA,
    "FB-005：insufficient_quota 属额度，即便状态非 402/429",
  );
  assert.equal(classifyUpstreamFailure({ phase: "transport" }), C.ENTRY_CODES.NETWORK, "FB-005：直连网络故障属 ENTRY_NETWORK");
});

// 同一 fixture 亦直接对表通用分类器（malformed-200 是「200 但 JSON 无法解析」的注册样本）。
test("FB-005（fixture 对表 malformed-200）：通用分类器判 BAD_RESPONSE（WP5）", async (t) => {
  const res = await tryImportSrc("search.js");
  if (failIfUnimplemented(t, res, WP_SEARCH, "FB-005 malformed-200")) return;
  const { classifyUpstreamFailure } = res.module;
  const outcome = loadFixture(FIXTURE_NAMES.upstreamErrors).outcomes.find((o) => o.id === "malformed-200");
  assert.equal(
    classifyUpstreamFailure({ status: outcome.response.status, phase: "response" }),
    outcome.expect.code,
    "FB-005：malformed-200 注册码",
  );
});
