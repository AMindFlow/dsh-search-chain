// WP2 验收 — OAI-001 查询与模型（src/backends/openai.js，请求成形）。
// 覆盖条款：
//   OAI-001 要求1：OpenAI 通道被尝试时恰一次 POST 到 https://api.openai.com/v1/responses；
//                  任务文本仅为当前查询 + 固定搜索指令（跨查询逐字不变，「固定」的可观察面）；
//                  省略 entry.model → model=gpt-5.6-luna；显式合法 model 原样透传；
//                  显式 model 非法（空串/纯空白/非字符串/null）→ 发出 OpenAI 请求前报告通道配置错误
//                  （验收明文：出站为零；错误码的定名含糊 → openai-pending.test.js P1）。
//   OAI-001 要求2：tools 只声明 web_search 一项；tool_choice="required"；max_tool_calls=1；store=false。
//   CFG-002/CFG-003（适配器侧）：key 只随 authorization: Bearer <key> 发送，不进 URL/正文；每条目用自己的 key。
//   FB-001：缺 key 时出站为零（不发无鉴权请求）；每条目最多一次 → 失败响应后无内部重试。
//   规格未给任何上游结果数/时效参数 → maxResults 不得演化为未声明的请求参数（结果数控制归链层 FB-002 截断）。
// 不覆盖：传输/代理路由（CFG-001 归 transport 验收）；计费说明 UI；stream 字段与输入承载形状等含糊处
//         （openai-pending.test.js P2/P3/P4）；账号实机验收（DSH-004）。
// 样本与断言助手见 test/helpers/openai-oracle.js（合成样本内联，不写入 test/fixtures/）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  OPENAI_ENDPOINT,
  OPENAI_KEY,
  OPENAI_KEY_B,
  OPENAI_MODEL_DEFAULT,
  OPENAI_MODEL_CUSTOM,
  SAMPLE_QUERY,
  openaiFetch,
  openaiFetchNoRoutes,
  completedResponse,
  threeCitationOutput,
  loadOpenAIBackend,
  makeCtx,
  singleCall,
  bodyOf,
  assertEndpoint,
  collectTaskTextParts,
  fixedInstructionParts,
  rejectionOf,
} from "./helpers/openai-oracle.js";

// 合法的完成响应：OAI-003 规定零有效引用是响应失败，请求用例子体也必须可被成功解析。
const OK = () => ({ status: 200, body: completedResponse(threeCitationOutput()) });

test("OAI-001 要求1：单次 POST 到固定端点，无查询串，Bearer 鉴权", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-001");
  if (!backend) return;
  const fetch = openaiFetch(OK());
  await backend.search(makeCtx({ fetch }));
  const call = singleCall(fetch, "默认查询");
  assertEndpoint(call);
  assert.equal(
    call.headers.authorization,
    `Bearer ${OPENAI_KEY}`,
    "OAI-001/CFG-003：authorization 必须为 Bearer <条目注入 key>（键名按任务约定 authorization: Bearer <key>）",
  );
});

test("OAI-001 要求1/要求2：正文逐字段符合规格（默认模型 + 固定参数面）", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-001");
  if (!backend) return;
  const fetch = openaiFetch(OK());
  await backend.search(makeCtx({ fetch }));
  const body = bodyOf(singleCall(fetch));
  assert.equal(body.model, OPENAI_MODEL_DEFAULT, "OAI-001：省略 model 时必须使用 gpt-5.6-luna");
  assert.equal(body.tool_choice, "required", "OAI-001：tool_choice 必须为 required");
  assert.equal(body.max_tool_calls, 1, "OAI-001：max_tool_calls 必须为 1");
  assert.equal(body.store, false, "OAI-001：store 必须为 false（不得持久化响应）");
});

test("OAI-001 要求2：tools 必须只声明 web_search 一项", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-001");
  if (!backend) return;
  const fetch = openaiFetch(OK());
  await backend.search(makeCtx({ fetch }));
  const body = bodyOf(singleCall(fetch));
  assert.ok(Array.isArray(body.tools), "OAI-001：tools 必须是数组");
  assert.equal(body.tools.length, 1, "OAI-001：必须只声明一个工具");
  assert.equal(body.tools[0]?.type, "web_search", "OAI-001：唯一工具必须是 web_search");
});

test("OAI-001 验收：任务文本只有测试查询和固定指令（两个查询各一次 POST，指令跨查询不变）", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-001");
  if (!backend) return;
  const fetch = openaiFetch(OK());
  const queryA = SAMPLE_QUERY;
  const queryB = "second synthetic query 第二个合成查询";
  await backend.search(makeCtx({ fetch, query: queryA }));
  await backend.search(makeCtx({ fetch, query: queryB }));
  for (const [label, query] of [["查询一", queryA], ["查询二", queryB]]) {
    const call = fetch.callsFor(OPENAI_ENDPOINT).find((c) => JSON.stringify(bodyOf(c)).includes(query));
    assert.ok(call, `OAI-001：${label} 的查询必须逐字出现在请求正文中`);
    const parts = collectTaskTextParts(bodyOf(call));
    assert.ok(parts.length > 0, "OAI-001：请求体必须携带任务文本；input/instructions 承载形状见待办 P3");
    assert.ok(
      parts.some((p) => p === query || p.includes(query)),
      `OAI-001：任务文本必须逐字包含当前查询（${label}），不得改写或另造查询`,
    );
  }
  const [bA, bB] = fetch.callsFor(OPENAI_ENDPOINT).map(bodyOf);
  assert.notEqual(bA, bB);
  assert.equal(
    fixedInstructionParts(bA, queryA),
    fixedInstructionParts(bB, queryB),
    "OAI-001：固定搜索指令必须逐字不变（跨查询可观察的「固定」面）",
  );
  assert.ok(fixedInstructionParts(bA, queryA).length > 0, "OAI-001：固定搜索指令不得为空（指令内容要求见待办 P4）");
});

test("OAI-001 验收：显式自定义 model 原样透传（自定义模型也恰好一次 POST）", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-001");
  if (!backend) return;
  const fetch = openaiFetch(OK());
  await backend.search(makeCtx({ fetch, model: OPENAI_MODEL_CUSTOM }));
  const call = singleCall(fetch, "自定义模型");
  assertEndpoint(call);
  assert.equal(bodyOf(call).model, OPENAI_MODEL_CUSTOM, "OAI-001：显式设置的合法 model 必须原样使用");
});

for (const [label, model] of [
  ["空字符串", ""],
  ["纯空白", "   "],
  ["非字符串（数字）", 42],
  ["null", null],
]) {
  test(`OAI-001 验收：显式 model 为 ${label} → 发出 OpenAI 请求前报告配置错误（出站为零）`, async (t) => {
    const backend = await loadOpenAIBackend(t, "OAI-001");
    if (!backend) return;
    const fetch = openaiFetchNoRoutes();
    await rejectionOf(backend.search(makeCtx({ fetch, model })));
    assert.equal(
      fetch.count(),
      0,
      "OAI-001：model 无效时必须在发出 OpenAI 请求前失败（验收：OpenAI 请求为零；配置错误的码见待办 P1）",
    );
  });
}

test("OAI-001：规格未定义任何结果数/时效参数 → maxResults 不得演化为未声明的正文参数", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-001/FB-002");
  if (!backend) return;
  for (const maxResults of [undefined, 3]) {
    const fetch = openaiFetch(OK());
    await backend.search(makeCtx({ fetch, maxResults }));
    const body = bodyOf(singleCall(fetch, `maxResults=${maxResults}`));
    for (const field of ["max_results", "num_results", "n", "top_k", "topK", "freshness", "time_range"]) {
      assert.ok(
        !(field in body),
        `OAI-001：openai.md 未定义参数 ${field}，正文不得出现未声明的结果数/时效参数（结果数控制归链层 FB-002 截断）`,
      );
    }
  }
});

test("OAI-001/CFG-003：key 只进鉴权头，不进入 URL 或正文", async (t) => {
  const backend = await loadOpenAIBackend(t, "OAI-001/CFG-003");
  if (!backend) return;
  const fetch = openaiFetch(OK());
  await backend.search(makeCtx({ fetch }));
  const call = singleCall(fetch);
  assert.ok(!call.url.includes(OPENAI_KEY), "CFG-003：key 不得出现在 URL 中");
  assert.ok(!JSON.stringify(bodyOf(call)).includes(OPENAI_KEY), "CFG-003：key 不得出现在正文中");
});

test("CFG-002/CFG-003：两个条目各自的 key 只发给各自的请求", async (t) => {
  const backend = await loadOpenAIBackend(t, "CFG-002/CFG-003");
  if (!backend) return;
  const fetch = openaiFetch(OK());
  await backend.search(makeCtx({ fetch, key: OPENAI_KEY, entryId: "oai-a" }));
  await backend.search(makeCtx({ fetch, key: OPENAI_KEY_B, entryId: "oai-b" }));
  const calls = fetch.callsFor(OPENAI_ENDPOINT);
  assert.equal(calls.length, 2, "两个条目各自恰好一次出站");
  assert.equal(calls[0].headers.authorization, `Bearer ${OPENAI_KEY}`, "第一条目只用自己的 key");
  assert.equal(calls[1].headers.authorization, `Bearer ${OPENAI_KEY_B}`, "第二条目只用自己的 key，不得复用第一条目的 key");
});

for (const [label, key] of [
  ["undefined", undefined],
  ["空串", ""],
]) {
  test(`FB-001/CFG-002：key 为 ${label} 时零出站且失败（不发无鉴权请求）`, async (t) => {
    const backend = await loadOpenAIBackend(t, "FB-001/CFG-002");
    if (!backend) return;
    const fetch = openaiFetchNoRoutes();
    const err = await rejectionOf(backend.search(makeCtx({ fetch, key })));
    assert.ok(err, "缺 key 时适配器不得成功返回");
    assert.equal(fetch.count(), 0, "FB-001：缺 key 条目出站请求数必须为零（码的细节见待办 P6）");
  });
}

test("FB-001/OAI-003：上游 401 后不得内部重试（失败恰一次出站）", async (t) => {
  const backend = await loadOpenAIBackend(t, "FB-001/OAI-003");
  if (!backend) return;
  const fetch = openaiFetch({ status: 401, body: { error: { type: "authentication_error", message: "synthetic" } } });
  await rejectionOf(backend.search(makeCtx({ fetch })));
  assert.equal(fetch.count(), 1, "FB-001：每个条目最多向供应商提交一次，失败不得重试");
});
