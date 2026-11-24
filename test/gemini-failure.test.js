// WP11 Gemini 失败分类验收（FB-005 失败分类；FB-001 每条目最多一次出站；空结果与失败的分界）。
//
// 条款：
//   FB-005 要求：区分凭据或权限（401/403）、额度（402 或 insufficient_quota）、其他 429 限流、
//              直连网络、异常响应（非 JSON、结构错）、单项超时。
//   FB-001 要求：每个条目最多向其供应商提交一次查询（失败不得重试）。
//   FB-004 要求：只有明确的无结果才是空数组，失败不是空结果。
//
// 说明：Gemini 特有的额度体（429 + RESOURCE_EXHAUSTED）与 5xx 归类在规格中未写明，
//       见 gemini-pending.test.js（P-11/P-12）。本文件只断言 FB-005 字面写明的映射。
//
// 红属预期：src/backends/gemini.js 尚未实现（WP11）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_ROUTE,
  ENTRY_CODE_SET,
  UPSTREAM,
  newRig,
  startSearch,
  settle,
  expectRejected,
  expectCode,
  gemCalls,
  loadGeminiBackend,
} from "./helpers/gemini-oracle.js";
import { ENTRY_CODES } from "./helpers/contract.js";

/**
 * 对一个上游失败样本执行一次搜索，断言：拒绝、分类码、且只出站一次（FB-001）。
 */
async function assertFailureClass(backend, label, route, expectedCode) {
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({ status: route.status, body: route.body, headers: route.headers });
  const outcome = await settle(rig, startSearch(backend, rig));
  const err = expectRejected(outcome, label);
  expectCode(err, expectedCode, label);
  assert.equal(rig.fetch.count(), 1, `${label}：失败后不得重试，应恰好一次出站（FB-001）`);
}

test("FB-005：401 鉴权失败归为 ENTRY_CREDENTIALS，且只出站一次", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-005");
  await assertFailureClass(backend, "401", UPSTREAM.auth401(), ENTRY_CODES.CREDENTIALS);
});

test("FB-005：403 权限拒绝归为 ENTRY_CREDENTIALS", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-005");
  await assertFailureClass(backend, "403", UPSTREAM.perm403(), ENTRY_CODES.CREDENTIALS);
});

test("FB-005：403 HTML 拦截页归为 ENTRY_CREDENTIALS（原始体不入错误，见 gemini-redaction）", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-005");
  await assertFailureClass(backend, "403 HTML", UPSTREAM.block403Html(), ENTRY_CODES.CREDENTIALS);
});

test("FB-005：HTTP 402 归为 ENTRY_QUOTA（额度）", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-005");
  await assertFailureClass(backend, "402", UPSTREAM.payment402(), ENTRY_CODES.QUOTA);
});

test("FB-005：429 且上游 code 为 insufficient_quota 归为 ENTRY_QUOTA", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-005");
  await assertFailureClass(backend, "429 insufficient_quota", UPSTREAM.quotaCode429(), ENTRY_CODES.QUOTA);
});

test("FB-005：其他 429（无 insufficient_quota）归为 ENTRY_RATE_LIMITED", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-005");
  await assertFailureClass(backend, "429 限流", UPSTREAM.rate429(), ENTRY_CODES.RATE_LIMITED);
});

test("FB-005：直连网络故障（fetch 无 HTTP 状态即失败）归为 ENTRY_NETWORK", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-005");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).fails({ error: new TypeError("合成直连网络失败") });
  const outcome = await settle(rig, startSearch(backend, rig));
  const err = expectRejected(outcome, "网络故障");
  expectCode(err, ENTRY_CODES.NETWORK, "网络故障");
  assert.equal(rig.fetch.count(), 1, "网络故障后不得重试（FB-001）");
});

test("FB-005：200 但 JSON 无法解析归为 ENTRY_BAD_RESPONSE（异常响应）", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-005");
  await assertFailureClass(backend, "malformed-200", UPSTREAM.malformed200(), ENTRY_CODES.BAD_RESPONSE);
});

test("FB-005/FB-001：5xx 为条目分类失败，不是成功，且只出站一次", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-005 / FB-001");
  const rig = newRig();
  const s500 = UPSTREAM.server500();
  rig.fetch.when(GEMINI_ROUTE).responds({ status: s500.status, body: s500.body });
  const outcome = await settle(rig, startSearch(backend, rig));
  const err = expectRejected(outcome, "500");
  assert.ok(ENTRY_CODE_SET.has(err?.code), `5xx 须为条目分类码（FB-005），实际：${String(err?.code)}`);
  assert.equal(rig.fetch.count(), 1, "5xx 后不得重试（FB-001）");
});

test("FB-004：失败不得伪装成空结果（403 必须拒绝，不得以 sources: [] 成功返回）", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-004");
  const rig = newRig();
  const s403 = UPSTREAM.perm403();
  rig.fetch.when(GEMINI_ROUTE).responds({ status: s403.status, body: s403.body });
  const outcome = await settle(rig, startSearch(backend, rig));
  assert.equal(outcome.ok, false, "403 失败必须拒绝，不得以 sources: [] 的成功返回掩盖（FB-004 空与失败分界）");
  assert.ok(ENTRY_CODE_SET.has(outcome.error?.code), "失败须携带条目分类码");
  assert.equal(gemCalls(rig.fetch).length, 1);
});
