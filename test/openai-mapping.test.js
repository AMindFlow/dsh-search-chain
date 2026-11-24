// WP2 验收 — OAI-002 引用提取与顺序 + OAI-003 无引用与响应失败（src/backends/openai.js，响应映射）。
// 覆盖条款：
//   OAI-002 要求1：完成响应按 output、消息 content、注释各数组的顺序，从 output_text 的 url_citation
//                  提取来源；每条来源采用注释的 url 与可用 title；同一文本块的首个非空段落用作 snippet，
//                  无该文本则省略 snippet。
//   OAI-002 要求2：来源满足 FB-002 有效性（绝对 HTTP(S) URL）；同一 URL 字符串只保留第一次出现的来源；
//                  缺少引用的模型正文不得构造为来源（正文裸链接不是来源）。
//   OAI-002 验收：混有工具项、多个消息、重复 URL、非 HTTP(S) URL、正文裸链接的响应 → 只保留有效引用，
//                  首次出现的标题和首段随对应来源返回。
//   OAI-003：完成响应中没有有效引用 → 响应失败（ENTRY_BAD_RESPONSE，按 FB-001 推进后继条目）；
//            JSON 或响应结构无法解析 → 响应失败；响应未完成 → 响应失败；上游明确拒绝 → 拒绝终态
//            （ENTRY_CONTENT_POLICY，验收：显式拒绝时后继条目无请求——链侧归 WP5 验收）。
//   FB-005：异常响应属 ENTRY_BAD_RESPONSE。
// 不覆盖：超发截断责任（待办 P5）；content 透传禁令的定名（待办 P11）；输入承载形状（待办 P3）。
// 样本见 test/helpers/openai-oracle.js（合成内联，注释为官方指南的扁平 url_citation 形状，
// 见 developers.openai.com/api/docs/guides/tools-web-search.md「Output and citations」；
// 历史嵌套形状仅用于 src 容错分支的兼容用例）。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import {
  SAMPLE_CITATIONS,
  SAMPLE_QUERY,
  assistantMessage,
  citationOf,
  completedResponse,
  nestedCitationOf,
  expectedSourceOf,
  incompleteResponse,
  loadOpenAIBackend,
  makeCtx,
  messageWithCitation,
  normalizeSources,
  openaiFetch,
  outputText,
  refusalResponse,
  rejectionOf,
  singleCall,
  textOnlyResponse,
  threeCitationOutput,
  webSearchCallItem,
  assertEntryError,
} from "./helpers/openai-oracle.js";

async function runWith(backend, body, maxResults = 10) {
  const fetch = openaiFetch({ status: 200, body });
  const out = await backend.search(makeCtx({ fetch, maxResults }));
  singleCall(fetch, "映射用例");
  return out;
}

test("OAI-002 要求1：完成响应按数组顺序逐条映射 url/title/snippet，顺序不变", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-002");
  if (!backend) return;
  const out = await runWith(backend, completedResponse(threeCitationOutput()));
  assert.deepEqual(
    normalizeSources(out.sources),
    SAMPLE_CITATIONS.map(expectedSourceOf),
    "OAI-002：sources 必须按 output/content/注释顺序，字段只有 url、可用 title、所在文本块首段 snippet",
  );
});

test("OAI-002/FB-002 兼容：历史嵌套 url_citation 注释（src 容错分支）同样产出来源", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-002/FB-002");
  if (!backend) return;
  // 官方 Responses 形状以扁平为准；此处刻意用历史嵌套形状（字段在 url_citation 对象内），
  // 钉住 src 的容错分支：扁平 url 缺失/无效时回退读 annotation.url_citation，映射期望与扁平样本一致（期望值不变）。
  const output = SAMPLE_CITATIONS.map((c) =>
    assistantMessage([outputText(c.text, [nestedCitationOf(c)])]),
  );
  const out = await runWith(backend, completedResponse(output));
  assert.deepEqual(
    normalizeSources(out.sources),
    SAMPLE_CITATIONS.map(expectedSourceOf),
    "FB-002 容错：嵌套 url_citation 注释须与扁平形状产出相同来源（url/可用 title/所在块首段 snippet），顺序不变",
  );
});

test("OAI-002 验收：混有 web_search 工具项时只取消息引用，且顺序保持", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-002");
  if (!backend) return;
  const output = [
    webSearchCallItem(),
    messageWithCitation(SAMPLE_CITATIONS[0]),
    webSearchCallItem("second"),
    messageWithCitation(SAMPLE_CITATIONS[1]),
  ];
  const out = await runWith(backend, completedResponse(output));
  assert.deepEqual(
    normalizeSources(out.sources),
    [expectedSourceOf(SAMPLE_CITATIONS[0]), expectedSourceOf(SAMPLE_CITATIONS[1])],
    "OAI-002：工具项（web_search_call）不得产出来源；消息引用保持出现顺序",
  );
});

test("OAI-002 要求2：同一 URL 字符串只保留第一次出现的来源", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-002");
  if (!backend) return;
  const c = SAMPLE_CITATIONS[0];
  const dup = { ...c, title: "重复标题后到者", snippet: "后到文本块首段。", text: "后到文本块首段。" };
  const output = [messageWithCitation(c), messageWithCitation(dup)];
  const out = await runWith(backend, completedResponse(output));
  assert.deepEqual(
    normalizeSources(out.sources),
    [expectedSourceOf(c)],
    "OAI-002：同一 URL 字符串的第二次出现必须丢弃（保留首现的标题与首段）",
  );
});

test("OAI-002 验收/FB-002：非 HTTP(S) 或缺 url 的注释被丢弃，有效引用保序保留", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-002/FB-002");
  if (!backend) return;
  const bad = [
    { url: "javascript:void(0)" },
    { url: "ftp://synthetic-host.invalid/file" },
    { url: "not a url at all" },
    {}, // 缺 url
  ];
  const output = [
    assistantMessage([
      outputText("第一段甲。\n\n第二段甲续。", bad.map((b) => citationOf({ ...b, title: "合成无效", start: 0, end: 4 }))),
    ]),
    messageWithCitation(SAMPLE_CITATIONS[2]), // 无 title 的有效引用在后
  ];
  const out = await runWith(backend, completedResponse(output));
  assert.deepEqual(
    normalizeSources(out.sources),
    [expectedSourceOf(SAMPLE_CITATIONS[2])],
    "FB-002：仅绝对 HTTP(S) URL 的注释进入 sources",
  );
});

test("OAI-002 要求2：缺少引用的模型正文（含正文裸链接）不得构造为来源", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-002");
  if (!backend) return;
  const body = completedResponse([
    assistantMessage(
      `合成正文。裸链接 https://synthetic-host.invalid/openai/raw-link 只是文本，不是 url_citation 注释。`,
    ),
  ]);
  const fetch = openaiFetch({ status: 200, body });
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.BAD_RESPONSE); // OAI-003：完成响应没有有效引用 → 响应失败
  singleCall(fetch, "裸链接");
});

test("OAI-002 要求1：snippet 取所在文本块首个非空段落；同块多注释共享 snippet；空文本块省略 snippet", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-002");
  if (!backend) return;
  const c1 = SAMPLE_CITATIONS[0];
  const c2 = SAMPLE_CITATIONS[1];
  // 同一文本块两条注释（c1、c2 的 snippet 不同则说明用了其它段落——这里构造同块场景）
  const sharedText = "共享首段。\n\n后续段落。";
  const sameBlock = assistantMessage([
    outputText(sharedText, [
      citationOf({ ...c1, text: sharedText, start: 0, end: 7 }),
      citationOf({ ...c2, url: "https://synthetic-host.invalid/openai/c2", text: sharedText, start: 9, end: 16 }),
    ]),
  ]);
  const emptyText = assistantMessage([
    outputText("   ", [citationOf({ url: "https://synthetic-host.invalid/openai/no-text", title: "空文本块" })]),
  ]);
  const out = await runWith(backend, completedResponse([sameBlock, emptyText]));
  assert.equal(out.sources.length, 3, "两条同块注释 + 一条空块注释都必须是来源");
  assert.equal(out.sources[0].snippet, "共享首段。", "OAI-002：snippet 必须是所在文本块的首个非空段落");
  assert.equal(out.sources[1].snippet, "共享首段。", "OAI-002：同一文本块的后续注释同样取首个非空段落");
  assert.equal(out.sources[2].snippet, undefined, "OAI-002：文本块无有效段落时必须省略 snippet（不得编造空格占位）");
});

test("OAI-002 验收：多个消息、多个 content 块按数组顺序展平", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-002");
  if (!backend) return;
  const msgTwoBlocks = assistantMessage([
    outputText("第一段甲。\n\n第二段甲续。", [citationOf(SAMPLE_CITATIONS[0])]),
    outputText("  \n第一段乙。\n\n第二段乙续。", [citationOf(SAMPLE_CITATIONS[1])]),
  ]);
  const out = await runWith(backend, completedResponse([msgTwoBlocks, messageWithCitation(SAMPLE_CITATIONS[2])]));
  assert.deepEqual(
    normalizeSources(out.sources),
    SAMPLE_CITATIONS.map(expectedSourceOf),
    "OAI-002：多消息多块必须按 output→content→注释 的数组顺序展平",
  );
});

test("OAI-002 验收：设较小 maxResults 后结果仍保序（前缀语义；截断责任见待办 P5）", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-002/FB-002");
  if (!backend) return;
  const out = await runWith(backend, completedResponse(threeCitationOutput()), 2);
  const got = normalizeSources(out.sources);
  assert.ok(got.length >= 2, `保留的有效引用不得少于 maxResults=2 可容纳的数量，实际 ${got.length}`);
  assert.ok(got.length <= 3);
  assert.deepEqual(
    got,
    SAMPLE_CITATIONS.map(expectedSourceOf).slice(0, got.length),
    "OAI-002：小 maxResults 下必须保留首次出现顺序的前缀，不得乱序或跳选",
  );
});

test("OAI-003 验收：完成但只有模型正文（零引用）→ 响应失败 ENTRY_BAD_RESPONSE（非正常空结果）", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-003/FB-004");
  if (!backend) return;
  const fetch = openaiFetch({ status: 200, body: textOnlyResponse() });
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.BAD_RESPONSE);
  singleCall(fetch, "零引用");
});

for (const [label, body] of [
  ["正文非 JSON", "{ this is not json (synthetic)"],
  ["正文是 JSON 标量 null", null],
  ["正文是 JSON 标量 42", 42],
  ["正文是数组而非响应对象", [1, 2, 3]],
  ["缺 output 字段", completedResponse(undefined, { output: undefined })],
  ["output 不是数组", completedResponse([], { output: "not-an-array" })],
  ["output 是空数组", completedResponse([])],
]) {
  test(`OAI-003 验收：${label} → 响应失败 ENTRY_BAD_RESPONSE`, async (t) => {
    const backend = await loadOpenAIBackend(t, "OAI-003");
    if (!backend) return;
    const fetch = openaiFetch({ status: 200, body });
    const err = await rejectionOf(backend.search(makeCtx({ fetch })));
    assertEntryError(err, C.ENTRY_CODES.BAD_RESPONSE);
    singleCall(fetch, label);
  });
}

for (const status of ["incomplete", "failed", undefined]) {
  test(`OAI-003 验收：响应状态 ${status ?? "缺失"}（未完成）→ 响应失败 ENTRY_BAD_RESPONSE`, async (t) => {
    const backend = await loadOpenAIBackend(t, "OAI-003");
    if (!backend) return;
    const body = incompleteResponse(threeCitationOutput(), status);
    const fetch = openaiFetch({ status: 200, body });
    const err = await rejectionOf(backend.search(makeCtx({ fetch })));
    assertEntryError(err, C.ENTRY_CODES.BAD_RESPONSE);
    singleCall(fetch, "未完成");
  });
}

test("OAI-003 要求：上游明确拒绝（消息 refusal）→ 拒绝终态 ENTRY_CONTENT_POLICY", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-003/FB-001");
  if (!backend) return;
  const fetch = openaiFetch({ status: 200, body: refusalResponse() });
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.CONTENT_POLICY);
  singleCall(fetch, "显式拒绝");
  // 「显式拒绝时后继条目无请求」是链侧语义（FB-001 终止类），归 WP5 链验收；适配器侧义务是
  // 以 CONTENT_POLICY 码抛出，链据此终止。非 200 的拒绝载体含糊见待办 P7。
});
