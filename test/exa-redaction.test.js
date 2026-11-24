// EXA-001 脱敏边界验收（依据 config-network.md CFG-003：错误、details、cause、日志不得含 key、请求头或原始响应体）。
// 全红：等待 WP9 实现 src/backends/exa.js。
// 覆盖：上游回显 key 的 401 错误不得泄露；fetch 异常携带 key 与请求头时 cause/stack 须脱敏；
//       错误对象不得暴露请求头或 init 字段；HTML 原始拦截页不得进入错误文本；
//       成功路径日志不得含 key。
// 待办见 helpers/exa-oracle.js 文件头。
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNoSecrets,
  assertNoCredentialUserinfo,
  assertNoRawBody,
} from "./helpers/redact.js";
import { collectStrings } from "./helpers/redact.js";
import {
  EXA_KEY,
  loadExaBackend,
  makeExaCtx,
  routeExa,
  routeFromResponse,
  settle,
  exaOk,
  exaResult,
} from "./helpers/exa-oracle.js";

const CLAUSE = "EXA-001 脱敏";

test("CFG-003 脱敏：上游 401 回显 key 时，错误文本与 details 不得含 key", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx, fetch, log } = makeExaCtx();
  routeExa(fetch, {
    status: 401,
    body: { error: { type: "authentication_error", message: `Incorrect API key ${EXA_KEY} (synthetic echo)` } },
  });

  const res = await settle(exa.search(ctx));

  assert.equal(res.ok, false, "401 必须抛错");
  assertNoSecrets(t, res.error, [EXA_KEY], "401 错误对象（CFG-003）");
  assertNoSecrets(t, log.text(), [EXA_KEY], "401 日志（CFG-003）");
});

test("CFG-003 脱敏：fetch 异常的 message、cause、stack 携带 key 与请求头时，适配器错误须脱敏", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx, fetch, log } = makeExaCtx();
  const leaky = new TypeError(`fetch failed while sending x-api-key=${EXA_KEY}`);
  leaky.cause = { headers: { "x-api-key": EXA_KEY } };
  fetch.when(/api\.exa\.ai/).fails({ error: leaky });

  const res = await settle(exa.search(ctx));

  assert.equal(res.ok, false, "网络异常必须抛错");
  assertNoSecrets(t, res.error, [EXA_KEY], "fetch 异常包装后的错误（message/cause/stack，CFG-003）");
  assertNoSecrets(t, log.text(), [EXA_KEY], "fetch 异常日志（CFG-003）");
});

test("CFG-003 脱敏：错误对象不得以可枚举字段暴露请求头或 init（x-api-key 不进入 details）", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx, fetch } = makeExaCtx();
  routeExa(fetch, { status: 500, body: { error: { type: "server_error", message: "synthetic" } } });

  const res = await settle(exa.search(ctx));

  assert.equal(res.ok, false, "500 必须抛错");
  for (const k of ["headers", "init", "request", "requestHeaders"]) {
    assert.ok(!(k in (res.error ?? {})), `错误对象不得含字段 ${k}（请求头不得进入错误/details/cause，CFG-003）`);
  }
  for (const s of collectStrings(res.error)) {
    assert.ok(!s.toLowerCase().includes("x-api-key"), `错误文本不得含请求头名（CFG-003）：${JSON.stringify(s.slice(0, 120))}`);
  }
});

test("CFG-003 脱敏：HTML 拦截页原始体不得进入错误文本（403）", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx, fetch } = makeExaCtx();
  routeFromResponse(fetch, {
    status: 403,
    contentType: "text/html",
    body: "<html><body>synthetic block page</body></html>",
  });

  const res = await settle(exa.search(ctx));

  assert.equal(res.ok, false, "403 拦截页必须抛错");
  assertNoRawBody(t, res.error, "403 HTML 拦截页错误（CFG-003）");
  assertNoSecrets(t, res.error, [EXA_KEY], "403 错误对象（CFG-003）");
});

test("CFG-003 脱敏：错误文本不含带认证信息的 URL（user:pass@host）", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx, fetch } = makeExaCtx();
  routeExa(fetch, { status: 402, body: { error: { type: "insufficient_balance", message: "synthetic quota" } } });

  const res = await settle(exa.search(ctx));

  assert.equal(res.ok, false, "402 必须抛错");
  assertNoCredentialUserinfo(t, res.error, "402 错误对象（CFG-003）");
});

test("CFG-003 脱敏：成功路径的日志不含 key", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx, fetch, log } = makeExaCtx();
  routeExa(fetch, { status: 200, body: exaOk([exaResult(1)]) });

  const res = await settle(exa.search(ctx));

  assert.equal(res.ok, true, "成功响应不得抛错");
  assertNoSecrets(t, log.text(), [EXA_KEY], "成功路径日志（CFG-003）");
  assertNoSecrets(t, res.value, [EXA_KEY], "成功结果（CFG-003）");
});
