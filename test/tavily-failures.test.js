// WP3 验收 — TAV-001 额度失败、TAV-002 上游失败分类（src/backends/tavily.js）+ FB-005 通用分类（src/search.js）。
// 覆盖条款：
//   TAV-001 要求2：超过套餐用量或按量上限 → 必须分类为额度失败（进入下一条，FB-001）。
//   TAV-002 验收：用 401、429、取消及用量超限的 432、433 验证分类；额度超限后尝试下一启用工具。
//   FB-005：HTTP 402 或 insufficient_quota → 额度；其他 429 → 限流；凭据/权限 → 凭据；异常响应 → 异常。
//   FB-001：每条目最多一次查询 → 每个失败用例出站恰好一次（无内部重试）。
// 推断（见 tavily-pending.test.js 与报告）：403 → CREDENTIALS；5xx → BAD_RESPONSE（FB-005「异常响应」）；
//   433 → QUOTA（TAV-002 验收将 432、433 并列为「用量超限」）。
// 取消与超时见 tavily-budget.test.js；脱敏见 tavily-redaction.test.js。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import {
  WP_SEARCH,
  SYNTH_AUTH_BODY,
  SYNTH_QUOTA_BODY,
  tavilyFetch,
  tavilyFetchFails,
  loadTavilyBackend,
  makeCtx,
  singleCall,
  rejectionOf,
  assertEntryError,
} from "./helpers/tavily-oracle.js";

const HTML_BODY = "<html><body>synthetic upstream error page</body></html>";

const CASES = [
  { label: "401 鉴权失败", status: 401, body: SYNTH_AUTH_BODY, code: C.ENTRY_CODES.CREDENTIALS, clause: "FB-005/TAV-002" },
  { label: "403 权限不足（推断→凭据或权限）", status: 403, body: SYNTH_AUTH_BODY, code: C.ENTRY_CODES.CREDENTIALS, clause: "FB-005" },
  { label: "402 额度（FB-005 明文）", status: 402, body: SYNTH_QUOTA_BODY, code: C.ENTRY_CODES.QUOTA, clause: "FB-005/TAV-001" },
  { label: "429 限流（非 insufficient_quota）", status: 429, body: { error: { type: "rate_limit", message: "synthetic rate limit" } }, code: C.ENTRY_CODES.RATE_LIMITED, clause: "FB-005/TAV-002" },
  {
    label: "429 + insufficient_quota → 额度（FB-005 明文）",
    status: 429,
    body: { error: { code: "insufficient_quota", message: "synthetic quota message" } },
    code: C.ENTRY_CODES.QUOTA,
    clause: "FB-005",
  },
  { label: "432 用量超限（TAV-002 验收）", status: 432, body: SYNTH_QUOTA_BODY, code: C.ENTRY_CODES.QUOTA, clause: "TAV-002/TAV-001" },
  { label: "433 用量超限（TAV-002 验收，语义见待办）", status: 433, body: SYNTH_QUOTA_BODY, code: C.ENTRY_CODES.QUOTA, clause: "TAV-002" },
  { label: "500 上游异常（推断→异常响应）", status: 500, body: HTML_BODY, headers: { "content-type": "text/html" }, code: C.ENTRY_CODES.BAD_RESPONSE, clause: "FB-005" },
  { label: "503 上游异常（推断→异常响应）", status: 503, body: { error: "synthetic unavailable" }, code: C.ENTRY_CODES.BAD_RESPONSE, clause: "FB-005" },
];

for (const c of CASES) {
  test(`${c.clause}：${c.label} → ${c.code}，且出站恰好一次`, async (t) => {
    const backend = await loadTavilyBackend(t, c.clause);
    if (!backend) return;
    const fetch = tavilyFetch({ status: c.status, body: c.body, headers: c.headers });
    const err = await rejectionOf(backend.search(makeCtx({ fetch })));
    assertEntryError(err, c.code);
    singleCall(fetch, c.label);
  });
}

test("FB-005：网络层故障（无 HTTP 状态）→ ENTRY_NETWORK，且不重试", async (t) => {
  const backend = await loadTavilyBackend(t, "FB-005");
  if (!backend) return;
  const fetch = tavilyFetchFails(new TypeError("synthetic fetch failed"));
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.NETWORK);
  singleCall(fetch, "网络故障");
});

test("FB-005/TAV-001：额度类失败不得被当作空结果或成功（必须抛错，驱动链进入下一条）", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-001/FB-005");
  if (!backend) return;
  const fetch = tavilyFetch({ status: 432, body: SYNTH_QUOTA_BODY });
  let ok = null;
  try {
    ok = await backend.search(makeCtx({ fetch }));
  } catch (e) {
    assert.ok(Object.values(C.ENTRY_CODES).includes(e.code), "额度失败须以 ENTRY_* 码抛出");
    return;
  }
  assert.fail(`额度超限不得成功返回（实际返回：${JSON.stringify(ok)}）`);
});

// 通用分类函数（A4，src/search.js，WP5 负责）。Tavily 特例（432/433）不在此断言，见 tavily-pending.test.js。
test("FB-005：classifyUpstreamFailure 通用规则（402、401、其他 429、insufficient_quota 429）", async (t) => {
  const res = await tryImportSrc("search.js");
  if (failIfUnimplemented(t, res, WP_SEARCH, "FB-005")) return;
  const { classifyUpstreamFailure } = res.module;
  assert.equal(typeof classifyUpstreamFailure, "function", "search.js 须导出 classifyUpstreamFailure（A4）");
  assert.equal(classifyUpstreamFailure({ status: 402 }), C.ENTRY_CODES.QUOTA, "FB-005：402 属额度");
  assert.equal(classifyUpstreamFailure({ status: 401 }), C.ENTRY_CODES.CREDENTIALS, "FB-005：401 属凭据或权限");
  assert.equal(classifyUpstreamFailure({ status: 429 }), C.ENTRY_CODES.RATE_LIMITED, "FB-005：其他 429 属限流");
  assert.equal(
    classifyUpstreamFailure({ status: 429, upstreamCode: "insufficient_quota" }),
    C.ENTRY_CODES.QUOTA,
    "FB-005：insufficient_quota 属额度，即便为 429",
  );
  assert.equal(
    classifyUpstreamFailure({ status: 200, phase: "response" }),
    C.ENTRY_CODES.BAD_RESPONSE,
    "FB-005：异常响应（无法解析的正文）属 ENTRY_BAD_RESPONSE",
  );
});
