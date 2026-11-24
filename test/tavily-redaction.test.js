// WP3 验收 — 脱敏边界（src/backends/tavily.js）。
// 覆盖条款：
//   CFG-003：key、Authorization 头不得出现在抛出错误、details、cause 链、日志或堆栈中；
//            不得包含原始报错响应体（HTML/XML）；不得出现带认证信息的 URL。
//   FB-005：错误须可核查但脱敏；内部程序违约向调用方暴露（本文件不覆盖程序违约）。
// 另含：tavily-oracle.js 内联样本的卫生检查（规则与 fixtures-hygiene.test.js 同源，因 test/fixtures/ 登记规则 6
//       要求编辑既有文件，本轮不允许，故在此对内联样本做等价检查）。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { createLogCapture, assertNoSecrets, assertNoRawBody, assertNoCredentialUserinfo } from "./helpers/redact.js";
import {
  TAVILY_KEY,
  SAMPLE_RESULTS,
  successBody,
  loadTavilyBackend,
  makeCtx,
  tavilyFetch,
  tavilyFetchFails,
  rejectionOf,
  assertEntryError,
  SYNTH_AUTH_BODY,
  SYNTH_QUOTA_BODY,
} from "./helpers/tavily-oracle.js";

const SECRETS = [TAVILY_KEY, `Bearer ${TAVILY_KEY}`];

test("CFG-003：401 上游回显 key 时，抛出错误不含 key，且不含原始体", async (t) => {
  const backend = await loadTavilyBackend(t, "CFG-003");
  if (!backend) return;
  const echo = { error: { type: "authentication_error", message: `synthetic invalid key ${TAVILY_KEY}` } };
  const fetch = tavilyFetch({ status: 401, body: echo });
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.CREDENTIALS);
  assertNoSecrets(t, err, SECRETS, "401 错误");
  assertNoCredentialUserinfo(t, err, "401 错误");
});

test("CFG-003：5xx 原始 HTML 体（含 key 回显）不得进入错误文本", async (t) => {
  const backend = await loadTavilyBackend(t, "CFG-003");
  if (!backend) return;
  const html = `<html><body>synthetic upstream trace ${TAVILY_KEY}</body></html>`;
  const fetch = tavilyFetch({ status: 502, body: html, headers: { "content-type": "text/html" } });
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.BAD_RESPONSE);
  assertNoSecrets(t, err, SECRETS, "5xx HTML 错误");
  assertNoRawBody(t, err, "5xx HTML 错误");
});

test("CFG-003：网络故障的原始错误（message 与 cause 链）含 key 时，适配器抛出的错误不得回显", async (t) => {
  const backend = await loadTavilyBackend(t, "CFG-003");
  if (!backend) return;
  const inner = new Error(`synthetic inner trace ${TAVILY_KEY}`);
  const outer = new TypeError(`synthetic fetch failed Authorization: Bearer ${TAVILY_KEY}`, { cause: inner });
  const fetch = tavilyFetchFails(outer);
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.NETWORK);
  assertNoSecrets(t, err, SECRETS, "网络错误 cause 链");
});

test("CFG-003：日志采集器在失败与成功路径上均不得记录 key", async (t) => {
  const backend = await loadTavilyBackend(t, "CFG-003");
  if (!backend) return;
  const cap = createLogCapture();
  const failFetch = tavilyFetch({ status: 401, body: { error: { message: `echo ${TAVILY_KEY}` } } });
  await rejectionOf(backend.search(makeCtx({ fetch: failFetch, log: cap.log })));
  const okCap = createLogCapture();
  await backend.search(makeCtx({ fetch: tavilyFetch({ status: 200, body: successBody() }), log: okCap.log }));
  assert.equal(cap.text().includes(TAVILY_KEY), false, "失败路径日志不得含 key（CFG-003）");
  assert.equal(okCap.text().includes(TAVILY_KEY), false, "成功路径日志不得含 key（CFG-003）");
  assertNoSecrets(t, cap.entries, SECRETS, "失败路径日志");
});

test("CFG-003：配额类错误（432）的错误对象不含 key 或 Authorization 头", async (t) => {
  const backend = await loadTavilyBackend(t, "CFG-003");
  if (!backend) return;
  const fetch = tavilyFetch({ status: 432, body: { detail: { error: `quota ${TAVILY_KEY}` } } });
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.QUOTA);
  assertNoSecrets(t, err, SECRETS, "432 错误");
});

test("卫生（CFG-003/fixtures 规则 1、2、4）：内联样本仅用保留 TLD，且无真实凭据形状", () => {
  const blobs = [
    JSON.stringify(SAMPLE_RESULTS),
    JSON.stringify(successBody()),
    JSON.stringify(SYNTH_AUTH_BODY),
    JSON.stringify(SYNTH_QUOTA_BODY),
  ];
  for (const text of blobs) {
    for (const raw of text.match(/\bhttps?:\/\/[^\s"'<>()\]\\]+/g) ?? []) {
      const u = new URL(raw);
      assert.ok(
        /\.(invalid|test|example)$/.test(u.hostname) || u.hostname === "localhost",
        `样本 URL 须使用保留 TLD（卫生规则 1）：${raw}`,
      );
      assert.equal(u.username + u.password, "", `样本 URL 不得含认证信息（卫生规则 2）：${raw}`);
    }
    for (const m of text.match(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{5,}/g) ?? []) {
      assert.match(m, /synthetic/i, `sk- 形状样本须带 synthetic 标记（卫生规则 4）：${m}`);
    }
  }
});
