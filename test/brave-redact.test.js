// WP10 Brave 验收 — CFG-003 凭据隔离和脱敏，适用于 brave.md BRV-001 的鉴权头（X-Subscription-Token）。
// 覆盖：成功路径的结果与日志不含 key；401 错误的 message/stack/cause 与日志不含 key，且不回显上游错误体；
//       403 HTML 拦截页原始体不进入错误文本与日志；网络异常文本含 URL 与 key 时错误不转发它们；
//       key 只随 X-Subscription-Token 发送，URL 与其他头不含 key，且不含带认证信息的 URL。
// 红属预期：src/backends/brave.js（WP10）缺失时经 impl.js 报「等待实现 WP10」。
import test from "node:test";
import assert from "node:assert/strict";
import {
  BRAVE_BLOCK_HTML,
  BRAVE_ECHO_MARK,
  BRAVE_KEY,
  braveEchoKeyBody,
  braveOk,
  braveResult,
  guard,
  loadBraveBackend,
  makeBraveCtx,
  onlyCall,
  rejectionOf,
  routeBrave,
  routeFromBraveResponse,
  BRAVE_ENDPOINT,
} from "./helpers/brave-oracle.js";
import { assertNoSecrets, assertNoCredentialUserinfo, assertNoRawBody } from "./helpers/redact.js";

test("CFG-003：成功路径的结果与日志不含 key，请求不含带认证信息的 URL", async (t) => {
  const backend = await loadBraveBackend(t, "CFG-003 成功");
  const { ctx, fetch, log } = makeBraveCtx({ maxResults: 3 });
  routeBrave(fetch, { status: 200, body: braveOk([braveResult(1)]) });
  const result = await guard(backend.search(ctx), "成功脱敏");
  const call = onlyCall(fetch, "CFG-003 成功");
  assertNoSecrets(t, result, [BRAVE_KEY], "成功结果");
  assertNoSecrets(t, log.text(), [BRAVE_KEY], "成功日志");
  assertNoCredentialUserinfo(t, { url: call.url }, "成功请求 URL");
});

test("CFG-003：401 错误的 message/stack/cause 与日志不含 key，且不回显上游错误体", async (t) => {
  const backend = await loadBraveBackend(t, "CFG-003 401");
  const { ctx, fetch, log } = makeBraveCtx();
  routeFromBraveResponse(fetch, { status: 401, contentType: "application/json", body: braveEchoKeyBody() });
  const err = await rejectionOf(backend.search(ctx), "401 脱敏");
  onlyCall(fetch, "CFG-003 401");
  assertNoSecrets(t, err, [BRAVE_KEY, BRAVE_ECHO_MARK], "401 错误");
  assertNoSecrets(t, log.text(), [BRAVE_KEY, BRAVE_ECHO_MARK], "401 日志");
});

test("CFG-003：403 HTML 拦截页原始体不进入错误文本与日志", async (t) => {
  const backend = await loadBraveBackend(t, "CFG-003 403 HTML");
  const { ctx, fetch, log } = makeBraveCtx();
  routeFromBraveResponse(fetch, { status: 403, contentType: "text/html", body: BRAVE_BLOCK_HTML });
  const err = await rejectionOf(backend.search(ctx), "403 HTML");
  onlyCall(fetch, "CFG-003 403 HTML");
  assertNoRawBody(t, err, "403 错误文本");
  assertNoRawBody(t, log.text(), "403 日志");
  assertNoSecrets(t, err, [BRAVE_KEY, "合成拦截页"], "403 错误");
});

test("CFG-003：网络异常原文含 URL 与 key 时，适配器错误不转发它们", async (t) => {
  const backend = await loadBraveBackend(t, "CFG-003 网络异常");
  const { ctx, fetch, log } = makeBraveCtx();
  fetch.when((url) => url.startsWith("https://api.search.brave.com/")).fails({
    error: new Error(`synthetic socket error for ${BRAVE_ENDPOINT}?q=x token=${BRAVE_KEY}`),
  });
  const err = await rejectionOf(backend.search(ctx), "网络脱敏");
  onlyCall(fetch, "CFG-003 网络异常");
  assertNoSecrets(t, err, [BRAVE_KEY], "网络错误（含 stack 与 cause）");
  assertNoSecrets(t, log.text(), [BRAVE_KEY], "网络日志");
});

test("CFG-003：key 只出现在 X-Subscription-Token 中；URL 与其余请求头不含 key", async (t) => {
  const backend = await loadBraveBackend(t, "CFG-003 key 隔离");
  const { ctx, fetch } = makeBraveCtx({ maxResults: 3 });
  routeBrave(fetch, { status: 200, body: braveOk([braveResult(1)]) });
  await guard(backend.search(ctx), "key 隔离");
  const call = onlyCall(fetch, "CFG-003 key 隔离");
  const { "x-subscription-token": token, ...rest } = call.headers;
  assert.equal(token, BRAVE_KEY, "key 须随 X-Subscription-Token 发送");
  assertNoSecrets(t, { url: call.url, otherHeaders: rest }, [BRAVE_KEY], "非鉴权位置");
});
