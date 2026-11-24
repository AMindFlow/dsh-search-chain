// WP2 验收 — 脱敏边界（src/backends/openai.js，CFG-003；OAI-001 鉴权）。
// 覆盖条款：
//   CFG-003：key、Authorization 头不得出现在抛出错误（message/details/cause 链/stack）或日志中；
//            不得包含原始报错响应体（HTML/XML 或含 key 回显的 JSON 原文）；不得出现带认证信息的 URL。
//   OAI-002/FB-002：成功结果只由 url_citation 派生 → 响应正文中的 key 形串不得进入 sources。
//   FB-005：错误须可核查但脱敏。
// 另含：openai-oracle.js 内联样本的卫生检查（规则与 fixtures-hygiene.test.js 同源；fixtures 卫生规则 6
//       要求登记 FIXTURE_NAMES 即编辑既有 test/helpers/fixtures.js，本轮禁止，故在此对内联样本做等价检查）。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { loadFixture, FIXTURE_NAMES } from "./helpers/fixtures.js";
import { createLogCapture, assertNoSecrets, assertNoRawBody, assertNoCredentialUserinfo } from "./helpers/redact.js";
import {
  OPENAI_KEY,
  SAMPLE_CITATIONS,
  SYNTH_AUTH_BODY,
  SYNTH_QUOTA_BODY,
  completedResponse,
  loadOpenAIBackend,
  makeCtx,
  messageWithCitation,
  openaiFetch,
  openaiFetchFails,
  refusalResponse,
  rejectionOf,
  singleCall,
  threeCitationOutput,
  assertEntryError,
} from "./helpers/openai-oracle.js";

const SECRETS = [OPENAI_KEY, `Bearer ${OPENAI_KEY}`];

test("CFG-003：401 上游回显 key 时，抛出错误不含 key，且不含原始体", async (t) => {
  const backend = await loadOpenAIBackend(t, "CFG-003");
  if (!backend) return;
  const echo = { error: { type: "authentication_error", message: `synthetic invalid key ${OPENAI_KEY}` } };
  const fetch = openaiFetch({ status: 401, body: echo });
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.CREDENTIALS);
  assertNoSecrets(t, err, SECRETS, "401 错误");
  assertNoCredentialUserinfo(t, err, "401 错误");
});

test("CFG-003：5xx 原始 HTML 体（含 key 回显）不得进入错误文本", async (t) => {
  const backend = await loadOpenAIBackend(t, "CFG-003");
  if (!backend) return;
  const html = `<html><body>synthetic upstream trace ${OPENAI_KEY}</body></html>`;
  const fetch = openaiFetch({ status: 502, body: html, headers: { "content-type": "text/html" } });
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.BAD_RESPONSE);
  assertNoSecrets(t, err, SECRETS, "5xx HTML 错误");
  assertNoRawBody(t, err, "5xx HTML 错误");
});

test("CFG-003：网络故障的原始错误（message 与 cause 链）含 key 时，适配器抛出的错误不得回显", async (t) => {
  const backend = await loadOpenAIBackend(t, "CFG-003");
  if (!backend) return;
  const inner = new Error(`synthetic inner trace ${OPENAI_KEY}`);
  const outer = new TypeError(`synthetic fetch failed Authorization: Bearer ${OPENAI_KEY}`, { cause: inner });
  const fetch = openaiFetchFails(outer);
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.NETWORK);
  assertNoSecrets(t, err, SECRETS, "网络错误 cause 链");
});

test("CFG-003：日志采集器在失败与成功路径上均不得记录 key", async (t) => {
  const backend = await loadOpenAIBackend(t, "CFG-003");
  if (!backend) return;
  const cap = createLogCapture();
  const failFetch = openaiFetch({ status: 401, body: { error: { message: `echo ${OPENAI_KEY}` } } });
  await rejectionOf(backend.search(makeCtx({ fetch: failFetch, log: cap.log })));
  const okCap = createLogCapture();
  await backend.search(
    makeCtx({ fetch: openaiFetch({ status: 200, body: completedResponse(threeCitationOutput()) }), log: okCap.log }),
  );
  assert.equal(cap.text().includes(OPENAI_KEY), false, "失败路径日志不得含 key（CFG-003）");
  assert.equal(okCap.text().includes(OPENAI_KEY), false, "成功路径日志不得含 key（CFG-003）");
  assertNoSecrets(t, cap.entries, SECRETS, "失败路径日志");
});

test("CFG-003：显式拒绝响应的 refusal 文本含 key 时，错误对象不得回显", async (t) => {
  const backend = await loadOpenAIBackend(t, "CFG-003/OAI-003");
  if (!backend) return;
  const fetch = openaiFetch({ status: 200, body: refusalResponse(`synthetic refusal echoing ${OPENAI_KEY}`) });
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.CONTENT_POLICY);
  assertNoSecrets(t, err, SECRETS, "拒绝终态错误");
});

test("CFG-003/OAI-002：成功响应正文中的 key 形串不得进入返回的 sources", async (t) => {
  const backend = await loadOpenAIBackend(t, "CFG-003/OAI-002");
  if (!backend) return;
  const body = completedResponse([
    messageWithCitation(SAMPLE_CITATIONS[0]),
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: `正文泄漏 ${OPENAI_KEY}`, annotations: [] }],
    },
  ]);
  const fetch = openaiFetch({ status: 200, body });
  const out = await backend.search(makeCtx({ fetch, maxResults: 10 }));
  singleCall(fetch, "正文 key");
  assertNoSecrets(t, out, SECRETS, "成功结果 sources");
});

test("CFG-003：上游样本（http-outcomes）的注册响应体原文不得进入适配器错误文本", async (t) => {
  const backend = await loadOpenAIBackend(t, "CFG-003/FB-005");
  if (!backend) return;
  const outcomes = loadFixture(FIXTURE_NAMES.upstreamErrors).outcomes;
  for (const outcome of outcomes.filter((o) => o.response.status !== 432)) {
    const fetch = openaiFetch({
      status: outcome.response.status,
      body: outcome.response.body,
      headers: { "content-type": outcome.response.contentType },
    });
    const err = await rejectionOf(backend.search(makeCtx({ fetch })));
    assert.ok(err && typeof err === "object", `${outcome.id}：必须以错误对象失败`);
    const probe =
      typeof outcome.response.body === "string"
        ? outcome.response.body
        : JSON.stringify(outcome.response.body).slice(0, 40);
    assertNoRawBody(
      t,
      [err?.message, String(err?.stack ?? "")].filter(Boolean),
      `${outcome.id} 错误文本不得含原始 HTML/XML 体`,
    );
    assert.ok(
      !(err?.message ?? "").includes(probe),
      `CFG-003：${outcome.id} 错误 message 不得复述原始响应体：${JSON.stringify(err?.message)}`,
    );
  }
});

test("卫生（CFG-003/fixtures 规则 1、2、4）：内联样本仅用保留 TLD，且无真实凭据形状", () => {
  const blobs = [
    JSON.stringify(SAMPLE_CITATIONS),
    JSON.stringify(completedResponse(threeCitationOutput())),
    JSON.stringify(refusalResponse()),
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
