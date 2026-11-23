// WP2 验收 — 规格含糊处的集中待办断言（全部为 oracle 推断，见下表与各条注释）。
//
// 【约定】本文件是 OpenAI 验收中唯一允许表达「规格未定」的地方。每条断言都以 [待办] 开头，
//         注明依据条款与未定点。由 dev 或规格维护者裁决：要么修改 docs/specs/draft/*.md 定名，
//         要么在 PR 说明中改写本文件对应断言并给出理由。不得把这些断言散落到其他测试文件，也不得 skip。
//
// 待办清单：
//   P1  OAI-001/CFG-004  条目「模型」参数的字段拼写未定（推断 entry.model）；model 无效时「该通道配置错误」
//                        的错误码未定（A5 只允许 ENTRY_*，语义更贴 CONFIG_CODES.INVALID）。本文件选 INVALID。
//   P2  OAI-001/OAI-002  流式与否规格未写。推断：非流式（OAI-002 只处理单份「完成的响应」，OAI-003 把
//                        未完成视为失败）→ 请求体不得出现 stream 字段。
//   P3  OAI-001          任务内容的承载字段未定（Responses API 可用 body.input 或 body.instructions）。
//                        本文件约束二者至少其一且形状合法（collectTaskTextParts 可识别）。
//   P4  OAI-001          固定搜索指令的文本要求（列出引用与摘要、用查询的语言）无逐字规格。
//                        推断：指令文本须可读地包含 引用/摘要/语言 三要素（关键词宽松匹配）。
//   P5  OAI-002/FB-002   上游超发时截断责任（适配器 vs 链）未定；本文件推断适配器输出 ≤ maxResults。
//   P6  OAI-001/FB-001   缺 key 时适配器抛出的码未定（CREDENTIALS 或由链给 SKIPPED_NO_KEY）；本文件选 CREDENTIALS。
//   P7  OAI-003          显式拒绝的载体未定：非 200 的 content_filter 错误体是否也按拒绝终态（而非可降级
//                        CREDENTIALS/BAD_RESPONSE）；本文件推断 ENTRY_CONTENT_POLICY。200+refusal 形状已在
//                        openai-mapping.test.js 按指南形状固化。
//   P8  FB-001/FB-003    宿主取消的错误形状未定；推断：不得以可降级 ENTRY_* 码抛出（否则链会误以为可继续）。
//                        注：openai-budget.test.js 的取消用例已带同一推断的硬断言（那里是取消行为的组成部分）。
//   P9  FB-005/OAI-003   HTTP 400（参数错误）归类未定；推断为 ENTRY_CHANNEL_LIMIT（「通道参数限制」）。
//   P10 FB-003           budgetMs≤0（无可用时间）时失败码未定；推断为 ENTRY_TIMEOUT。
//   P11 FB-002/OAI-002   OpenAI 属「提供纯来源的适配器」推断（OAI-002 只定义来源映射，无单独呈现条款）；
//                        推断适配器 resolve 永不携带 content（供应商生成正文不得作为通用 content）。
//
// 另有一处仅在报告中列出、本文件不断言（规格未给出可观察条款）：
//   - OpenAI 通道不存在「200 正常空结果」形状（OAI-003 把零有效引用定为响应失败）→ FB-004 的
//     「明确无结果」终态对纯 OpenAI 链不可达；链侧文案归 WP5。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import {
  OPENAI_MODEL_DEFAULT,
  SAMPLE_CITATIONS,
  completedResponse,
  collectTaskTextParts,
  fixedInstructionParts,
  loadOpenAIBackend,
  makeCtx,
  messageWithCitation,
  openaiFetch,
  openaiFetchHangs,
  openaiFetchNoRoutes,
  rejectionOf,
  singleCall,
  threeCitationOutput,
  withGuard,
  bodyOf,
  assertEntryError,
} from "./helpers/openai-oracle.js";

async function once(backend, overrides = {}, spec = { status: 200, body: completedResponse(threeCitationOutput()) }) {
  const fetch = openaiFetch(spec);
  const out = await backend.search(makeCtx({ fetch, ...overrides }));
  return { fetch, out, call: singleCall(fetch, "待办用例") };
}

test("[待办 OAI-001/CFG-004] P1 模型参数假定落在 entry.model；无效 model 的配置错误码选 CONFIG_INVALID", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-001/CFG-004");
  if (!backend) return;
  // (a) 参数承载前提：无 model 的条目 → 默认模型（若规格定名不同，本文件与助手须同步改）。
  const { call } = await once(backend);
  assert.equal(bodyOf(call).model, OPENAI_MODEL_DEFAULT, "P1 前提：无 model 的条目 → 默认模型");
  // (b) 无效 model 的错误码：零出站已在 openai-request.test.js；这里只定码。
  const fetch = openaiFetchNoRoutes();
  const err = await rejectionOf(backend.search(makeCtx({ fetch, model: "" })));
  assert.equal(fetch.count(), 0, "P1 前提：无效 model 零出站（OAI-001 验收明文）");
  assert.equal(
    err.code,
    C.CONFIG_CODES.INVALID,
    `[待办 P1] 「该通道配置错误」的码未在规格定义（A5 枚举只含 ENTRY_*）。推断携带 CONFIG_CODES.INVALID，实际：${err.code}`,
  );
});

test("[待办 OAI-001/OAI-002] P2 非流式推断：请求体不得出现 stream 字段", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-001/OAI-002");
  if (!backend) return;
  const { call } = await once(backend);
  const body = bodyOf(call);
  assert.ok(
    !("stream" in body),
    `[待办 P2] 规格未提流式；推断单 JSON 响应（OAI-002 完成态映射）→ 不得声明 stream，实际：${JSON.stringify(body.stream)}`,
  );
});

test("[待办 OAI-001] P3 任务内容必须经 body.input 或 body.instructions 承载（Responses API 形状）", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-001");
  if (!backend) return;
  const { call } = await once(backend);
  const body = bodyOf(call);
  assert.ok(
    "input" in body || "instructions" in body,
    "[待办 P3] 承载字段未定名。推断二者至少其一存在（input 为字符串或消息项数组；instructions 为字符串）",
  );
  const parts = collectTaskTextParts(body);
  assert.ok(parts.length > 0, "[待办 P3] 承载形状必须可被 collectTaskTextParts 识别（见 openai-oracle.js）");
});

test("[待办 OAI-001] P4 固定搜索指令须可读地包含引用、摘要与语言三要素", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-001");
  if (!backend) return;
  const fetch = openaiFetch({ status: 200, body: completedResponse(threeCitationOutput()) });
  await backend.search(makeCtx({ fetch, query: "alpha query 一" }));
  await backend.search(makeCtx({ fetch, query: "beta query 二" }));
  const [bA] = fetch.callsFor("v1/responses").map(bodyOf);
  const instr = fixedInstructionParts(bA, "alpha query 一");
  assert.match(instr, /citation|cite|引用|来源/i, `[待办 P4] 固定指令应要求列出引用，实际：${JSON.stringify(instr)}`);
  assert.match(instr, /summar|excerpt|摘要/i, "[待办 P4] 固定指令应要求列出摘要");
  assert.match(instr, /language|语言|语种/i, "[待办 P4] 固定指令应要求用查询的语言作答");
});

test("[待办 OAI-002/FB-002] P5 上游超发（3 条 > maxResults=2）：适配器输出不得超过 maxResults", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-002/FB-002");
  if (!backend) return;
  const { out } = await once(backend, { maxResults: 2 });
  assert.ok(
    out.sources.length <= 2,
    `[待办 P5] 截断责任未定（OAI-002 只写「上限」引用 FB-002，FB-002 写在结果层）。推断适配器输出 ≤ maxResults，实际 ${out.sources.length} 条`,
  );
});

test("[待办 OAI-001/FB-001] P6 缺 key 时适配器抛出的码（本文件选 CREDENTIALS；链也可给 SKIPPED_NO_KEY）", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-001/FB-001");
  if (!backend) return;
  const fetch = openaiFetchNoRoutes();
  const err = await rejectionOf(backend.search(makeCtx({ fetch, key: undefined })));
  assert.equal(fetch.count(), 0, "零出站（FB-001）已在 openai-request.test.js 断言");
  assert.equal(
    err.code,
    C.ENTRY_CODES.CREDENTIALS,
    `[待办 P6] 缺 key 的码未定（CREDENTIALS 或链层 ${C.SKIPPED_NO_KEY}）。本文件选 CREDENTIALS，实际：${err.code}`,
  );
});

test("[待办 OAI-003] P7 非 200 的 content_filter 错误体 → 拒绝终态 ENTRY_CONTENT_POLICY", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-003");
  if (!backend) return;
  const fetch = openaiFetch({
    status: 400,
    body: { error: { code: "content_filter", message: "synthetic content policy decline" } },
  });
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.CONTENT_POLICY);
  singleCall(fetch, "content_filter");
  // 注：本用例同时是 P9 的反例面——400 常规参数错误走 P9，content_filter 载荷须优先按拒绝处理。
});

test("[待办 FB-001/FB-003] P8 宿主取消的错误不得带可降级 ENTRY_* 码（链需据此终止而非降级）", async (t) => {
  const backend = await loadOpenAIBackend(t, "FB-001/FB-003");
  if (!backend) return;
  const ac = new AbortController();
  const fetch = openaiFetchHangs();
  const p = backend.search(makeCtx({ fetch, signal: ac.signal, budgetMs: 5000 }));
  p.catch(() => {});
  await new Promise((r) => setImmediate(r));
  ac.abort(new Error("synthetic host cancel"));
  const err = await rejectionOf(withGuard(p, "宿主取消"));
  assert.ok(
    !Object.values(C.ENTRY_CODES).includes(err?.code),
    `[待办 P8] 取消错误形状未定。推断：不得以 ENTRY_* 码抛出（否则链会当作可降级继续），实际码：${err?.code}`,
  );
});

test("[待办 FB-005/OAI-003] P9 HTTP 400（参数错误）→ ENTRY_CHANNEL_LIMIT（「通道参数限制」推断）", async (t) => {
  const backend = await loadOpenAIBackend(t, "FB-005/OAI-003");
  if (!backend) return;
  const fetch = openaiFetch({ status: 400, body: { error: { message: "synthetic bad parameter" } } });
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.CHANNEL_LIMIT);
  singleCall(fetch, "400");
});

test("[待办 FB-003] P10 budgetMs=0 时的失败码推断为 ENTRY_TIMEOUT（无可用时间）", async (t) => {
  const backend = await loadOpenAIBackend(t, "FB-003");
  if (!backend) return;
  const fetch = openaiFetchHangs();
  const err = await rejectionOf(withGuard(backend.search(makeCtx({ fetch, budgetMs: 0 })), "budgetMs=0"));
  assertEntryError(err, C.ENTRY_CODES.TIMEOUT);
});

test("[待办 FB-002/OAI-002] P11 纯来源适配器：resolve 永不携带 content（供应商正文不得透传）", async (t) => {
  const backend = await loadOpenAIBackend(t, "FB-002/OAI-002");
  if (!backend) return;
  const body = completedResponse([
    messageWithCitation(SAMPLE_CITATIONS[0]),
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "合成整段回答，不应出现在 content 中", annotations: [] }],
    },
  ]);
  const { out } = await once(backend, { maxResults: 10 }, { status: 200, body });
  assert.equal(
    out.content,
    undefined,
    `[待办 P11] OpenAI 定性为纯来源适配器是推断（OAI-002 无单独呈现条款）。推断 content 缺省，链层自行加条目首行标注；实际：${JSON.stringify(out.content)}`,
  );
});
