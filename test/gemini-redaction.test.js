// WP11 Gemini 脱敏验收（CFG-003 凭据隔离和脱敏；FB-005 可核查但不泄露）。
//
// 条款：
//   CFG-003 要求：日志、返回错误、测试样本和交付产物不得包含实际 key 或原始报错响应体。
//   FB-005  要求：错误须指出对应条目和可核查的配置，遵守 CFG-003。
//
// 检查面：拒绝对象的 message、details、cause、stack 以及日志采集器文本。
// 红属预期：src/backends/gemini.js 尚未实现（WP11）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_ROUTE,
  GEMINI_KEY,
  RAW_MARK,
  SUGGESTION_HTML,
  UPSTREAM,
  groundedOutputs,
  newRig,
  startSearch,
  settle,
  expectRejected,
  expectCode,
  loadGeminiBackend,
} from "./helpers/gemini-oracle.js";
import { assertNoSecrets, assertNoRawBody } from "./helpers/redact.js";
import { ENTRY_CODES } from "./helpers/contract.js";

test("CFG-003：上游回显 key 时，错误对象与日志均不含 key", async (t) => {
  const backend = await loadGeminiBackend(t, "CFG-003");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({
    status: 401,
    body: { error: { code: 401, status: "UNAUTHENTICATED", message: `API key not valid: ${GEMINI_KEY}` } },
  });

  const outcome = await settle(rig, startSearch(backend, rig));
  const err = expectRejected(outcome, "401 回显 key");
  expectCode(err, ENTRY_CODES.CREDENTIALS, "401 回显 key");
  assertNoSecrets(t, { err, log: rig.logs.text() }, [GEMINI_KEY], "CFG-003 错误与日志");
});

test("CFG-003：403 原始 HTML 拦截页不进入错误文本、details、cause、stack 或日志", async (t) => {
  const backend = await loadGeminiBackend(t, "CFG-003");
  const rig = newRig();
  const s403 = UPSTREAM.block403Html();
  rig.fetch.when(GEMINI_ROUTE).responds({ status: s403.status, headers: s403.headers, body: s403.body });

  const outcome = await settle(rig, startSearch(backend, rig));
  const err = expectRejected(outcome, "403 HTML");
  expectCode(err, ENTRY_CODES.CREDENTIALS, "403 HTML");
  assertNoSecrets(t, { err, log: rig.logs.text() }, [RAW_MARK, GEMINI_KEY], "CFG-003 原始拦截页");
  assertNoRawBody(t, { err, log: rig.logs.text() }, "CFG-003 原始拦截页");
});

test("CFG-003：500 原始报错体不进入错误或日志", async (t) => {
  const backend = await loadGeminiBackend(t, "CFG-003");
  const rig = newRig();
  const s500 = UPSTREAM.server500();
  rig.fetch.when(GEMINI_ROUTE).responds({ status: s500.status, body: s500.body });

  const outcome = await settle(rig, startSearch(backend, rig));
  const err = expectRejected(outcome, "500 原始体");
  assert.ok(err && typeof err.code === "string", "5xx 错误须带条目分类码（FB-005）");
  assertNoSecrets(t, { err, log: rig.logs.text() }, [RAW_MARK, GEMINI_KEY], "CFG-003 500 原始报错体");
});

test("CFG-003：成功路径的日志与返回值不含 key，也不含搜索建议 HTML", async (t) => {
  const backend = await loadGeminiBackend(t, "CFG-003");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({ body: groundedOutputs() });

  const outcome = await settle(rig, startSearch(backend, rig));
  assert.equal(outcome.ok, true, `成功样本应成功：${outcome.ok ? "" : outcome.error?.message}`);
  assertNoSecrets(t, { value: outcome.value, log: rig.logs.text() }, [GEMINI_KEY, SUGGESTION_HTML], "CFG-003 成功路径");
});
