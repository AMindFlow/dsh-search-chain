// WP8 DeepSeek 脱敏边界验收（config-network.md CFG-003 + AGENTS.md 凭据边界；FB-005 reason 可核查但脱敏）。
// 全红：src/backends/deepseek.js 尚未实现，等待 WP8。
// 覆盖：上游回显 key 的 401 不得泄露；「Bearer <key>」请求头形状不得进入错误文本；
//       fetch 异常携带 key/authorization 时 message/cause/stack 须脱敏；错误对象不得以可枚举字段暴露
//       headers/init/request；错误/details/cause 中 authorization/bearer 头名不得出现；
//       上游 400 原文（合成 marker）不得原样进入错误文本与日志（FB-005 要求 reason 指向条目与可核查
//       配置，不逐字回显上游正文）；403 HTML 拦截页原始体不得进入错误文本；日志与成功结果不得含 key；
//       「实际搜索次数不计费、按 token/按次计费」文案属 CAT-001/settings-ui 展示面（WP12），不在适配器断言。
// 待办：helpers/deepseek-oracle.js 头注 S1..S7；test/deepseek-pending.test.js P1..P8。
import test from "node:test";
import assert from "node:assert/strict";
import { createLogCapture } from "./helpers/redact.js";
import {
  assertNoSecrets,
  assertNoCredentialUserinfo,
  assertNoRawBody,
  collectStrings,
} from "./helpers/redact.js";
import {
  DSK_KEY,
  agenticOk,
  dsApiOk,
  dsEmptyResultBlock,
  endpointOf,
  loadDeepseek,
  makeCtx,
  routeFor,
  routeFromResponse,
  settle,
} from "./helpers/deepseek-oracle.js";

const AG = "deepseek-agentic-search";
const API = "deepseek-search";

/** 带日志采集的 ctx。 */
function ctxWithLog(overrides = {}) {
  const log = createLogCapture();
  return { log, ...makeCtx({ log: log.log, ...overrides }) };
}

test("CFG-003 脱敏：上游 401 回显 key 时，错误对象与日志不得含 key（两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `CFG-003 401 回显（${type}）`);
    const { log, ctx, fetch } = ctxWithLog({ type });
    routeFor(fetch, type, {
      status: 401,
      body: { error: { type: "authentication_error", message: `Incorrect API key ${DSK_KEY} (synthetic echo)` } },
    });
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, false, "401 必须抛错");
    assertNoSecrets(t, res.error, [DSK_KEY], `${type} 401 错误对象（CFG-003）`);
    assertNoSecrets(t, log.text(), [DSK_KEY], `${type} 401 日志（CFG-003）`);
  }
});

test("CFG-003 脱敏：Authorization/Bearer 请求头形状不得进入错误文本（两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `CFG-003 鉴权头形状（${type}）`);
    const { log, ctx, fetch } = ctxWithLog({ type });
    routeFor(fetch, type, { status: 401, body: { error: { type: "authentication_error", message: "synthetic" } } });
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, false, "401 必须抛错");
    for (const s of collectStrings(res.error)) {
      assert.ok(!s.includes("Bearer "), `${type} 错误文本不得含「Bearer 」请求头形状（CFG-003）：${JSON.stringify(s.slice(0, 120))}`);
      assert.ok(!/[Aa]uthorization/.test(s), `${type} 错误文本不得含 authorization 头（CFG-003）：${JSON.stringify(s.slice(0, 120))}`);
    }
    assertNoSecrets(t, log.text(), [DSK_KEY], `${type} 鉴权头日志（CFG-003）`);
  }
});

test("CFG-003 脱敏：fetch 异常携带 key 与 authorization 头时，包装错误的 message/cause/stack 与日志须脱敏（两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `CFG-003 fetch 异常（${type}）`);
    const { log, ctx, fetch } = ctxWithLog({ type });
    const leaky = new TypeError(`fetch failed while sending authorization: Bearer ${DSK_KEY}`);
    leaky.cause = { headers: { authorization: `Bearer ${DSK_KEY}` } };
    fetch.when(endpointOf(type)).fails({ error: leaky });
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, false, "网络异常必须抛错");
    assertNoSecrets(t, res.error, [DSK_KEY], `${type} fetch 异常包装后（message/cause/stack，CFG-003）`);
    assertNoSecrets(t, log.text(), [DSK_KEY], `${type} fetch 异常日志（CFG-003）`);
  }
});

test("CFG-003 脱敏：错误对象不得以可枚举字段暴露 headers/init/request；authorization/bearer 字样不得出现在任何字符串（500，两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `CFG-003 错误形状（${type}）`);
    const { ctx, fetch } = ctxWithLog({ type });
    routeFor(fetch, type, { status: 500, body: { error: { type: "internal_server_error", message: "synthetic" } } });
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, false, "500 必须抛错");
    for (const k of ["headers", "init", "request", "requestHeaders", "requestInit"]) {
      assert.ok(!(k in (res.error ?? {})), `错误对象不得含字段 ${k}（请求头/请求体不得进入错误，CFG-003）`);
    }
    for (const s of collectStrings(res.error)) {
      assert.ok(
        !/authorization|bearer/i.test(s),
        `${type} 错误文本不得含 authorization/bearer 请求头（CFG-003）：${JSON.stringify(s.slice(0, 120))}`,
      );
    }
  }
});

test("CFG-003/FB-005 脱敏：上游 400 原文不得逐字进入错误与日志，reason 只指向条目与可核查配置（两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `CFG-003 上游原文（${type}）`);
    const { log, ctx, fetch } = ctxWithLog({ type });
    routeFor(fetch, type, {
      status: 400,
      body: { error: { type: "invalid_request_error", message: "SYNTH-UPSTREAM-RAW-MARKER: synthetic request rejected" } },
    });
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, false, "400 必须失败（FB-005 异常响应类目）");
    assert.ok(typeof res.error.message === "string" && res.error.message.length > 0, "错误须给出可操作原因（FB-005）");
    for (const s of collectStrings(res.error)) {
      assert.ok(!s.includes("SYNTH-UPSTREAM-RAW-MARKER"), `${type} 上游原文不得逐字进入错误（CFG-003/FB-005）：${JSON.stringify(s.slice(0, 120))}`);
    }
    assert.ok(
      !log.text().includes("SYNTH-UPSTREAM-RAW-MARKER"),
      `${type} 上游原文不得进入日志（CFG-003）`,
    );
  }
});

test("CFG-003 脱敏：403 HTML 拦截页原始体不得进入错误文本（两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `CFG-003 403 原始体（${type}）`);
    const { ctx, fetch } = makeCtx({ type });
    routeFromResponse(fetch, type, { status: 403, contentType: "text/html", body: "<html><body>synthetic block page</body></html>" });
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, false, "403 拦截页必须抛错");
    assertNoRawBody(t, res.error, `${type} 403 HTML 拦截页错误（CFG-003）`);
    assertNoSecrets(t, res.error, [DSK_KEY], `${type} 403 错误对象（CFG-003）`);
  }
});

test("CFG-003 脱敏：错误文本不含带认证信息的 URL（402，两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `CFG-003 userinfo（${type}）`);
    const { ctx, fetch } = makeCtx({ type });
    routeFor(fetch, type, { status: 402, body: { error: { type: "insufficient_balance", message: "synthetic quota" } } });
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, false, "402 必须抛错");
    assertNoCredentialUserinfo(t, res.error, `${type} 402 错误对象（CFG-003）`);
  }
});

test("CFG-003 脱敏：成功路径日志与结果不得含 key（两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `CFG-003 成功日志（${type}）`);
    const { log, ctx, fetch } = ctxWithLog({ type });
    routeFor(fetch, type, {
      status: 200,
      body: type === API ? dsApiOk([{ url: "https://ds-sample.invalid/api/doc/1", title: "t" }]) : agenticOk([dsEmptyResultBlock()]),
    });
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, true, "成功响应不得抛错");
    assertNoSecrets(t, log.text(), [DSK_KEY], `${type} 成功路径日志（CFG-003）`);
    assertNoSecrets(t, res.value, [DSK_KEY], `${type} 成功结果（CFG-003）`);
  }
});
