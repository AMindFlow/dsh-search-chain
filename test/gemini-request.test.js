// WP11 Gemini 请求成形验收（GMI-001 搜索请求与证据；CFG-003 key 只随鉴权头发送；FB-001 单查询单次出站）。
//
// 条款：
//   GMI-001 要求：POST https://generativelanguage.googleapis.com/v1beta/interactions；x-goog-api-key；
//                 启用 google_search；store:false；单查询。
//   CFG-003 要求：key 只随对应供应商鉴权头发送，不进入 URL 或 body。
//   FB-001  要求：每个条目最多向其供应商提交一次查询。
//
// 红属预期：src/backends/gemini.js 尚未实现（WP11），由 gemini-oracle.js 的 failIfUnimplemented 判红。
// 未在规格中写明的 body 字段名、模型值与生成参数不在本文件断言，见 gemini-pending.test.js（P 编号）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_ENDPOINT,
  GEMINI_ROUTE,
  GEMINI_KEY,
  DEFAULT_QUERY,
  SUGGESTION_MARK,
  groundedOutputs,
  outputsResponse,
  newRig,
  startSearch,
  settle,
  gemCalls,
  bodyOf,
  loadGeminiBackend,
} from "./helpers/gemini-oracle.js";

test("GMI-001：单查询只发一次 POST 到规定端点，端点无路径模型参数、无额外 query", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-001");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({ body: groundedOutputs() });

  const outcome = await settle(rig, startSearch(backend, rig));
  assert.equal(outcome.ok, true, `合成成功样本应成功：${outcome.ok ? "" : outcome.error?.message}`);

  assert.equal(rig.fetch.count(), 1, "单查询只允许一次出站（GMI-001 单查询 / FB-001 每条目最多一次）");
  const [call] = gemCalls(rig.fetch);
  assert.equal(call.method, "POST", "GMI-001：必须为 POST");
  assert.equal(call.url, GEMINI_ENDPOINT, "GMI-001：端点必须精确为 generativelanguage v1beta/interactions（不得附加 query 或路径模型参数）");
});

test("GMI-001/CFG-003：鉴权只用 x-goog-api-key 头；key 不进 URL、不进 body、不用 Authorization", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-001 / CFG-003");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({ body: groundedOutputs() });

  await settle(rig, startSearch(backend, rig));
  const [call] = gemCalls(rig.fetch);
  assert.ok(call, "应有一次 Gemini 出站");

  assert.equal(call.headers["x-goog-api-key"], GEMINI_KEY, "GMI-001：key 必须经 x-goog-api-key 头发送");
  assert.equal(call.headers.authorization, undefined, "GMI-001：不得改用 Authorization/Bearer 鉴权（不得自创混用）");
  assert.ok(!call.url.includes(GEMINI_KEY), "CFG-003：key 不得出现在 URL 中");
  assert.ok(!/[?&]key=/.test(call.url), "GMI-001：不得以 ?key= 查询参数鉴权");
  assert.ok(!JSON.stringify(bodyOf(call)).includes(GEMINI_KEY), "CFG-003：key 不得进入请求 body");
});

test("GMI-001：body 启用 google_search 服务端工具，store 为 false", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-001");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({ body: groundedOutputs() });

  await settle(rig, startSearch(backend, rig));
  const [call] = gemCalls(rig.fetch);
  const body = bodyOf(call);

  assert.equal(body.store, false, "GMI-001：store 必须为 false（严格布尔，不得省略或置 true）");
  assert.ok(Array.isArray(body.tools), "GMI-001：body 必须声明 tools 数组以启用服务端搜索");
  assert.ok(
    body.tools.some((tool) => tool && tool.type === "google_search"),
    "GMI-001：tools 必须包含 type 为 google_search 的服务端工具声明",
  );
});

test("GMI-001：单查询逐字进入请求，且在 body 中只出现一次（不改写、不拆分、不重复）", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-001");
  const rig = newRig({ query: DEFAULT_QUERY });
  rig.fetch.when(GEMINI_ROUTE).responds({ body: groundedOutputs() });

  await settle(rig, startSearch(backend, rig));
  const [call] = gemCalls(rig.fetch);
  const serialized = JSON.stringify(bodyOf(call));

  assert.ok(serialized.includes(DEFAULT_QUERY), "GMI-001：查询文本必须逐字出现在请求 body 中（不得翻译、裁剪）");
  const occurrences = serialized.split(DEFAULT_QUERY).length - 1;
  assert.equal(occurrences, 1, `GMI-001 单查询：查询文本只应出现一次，实际 ${occurrences} 次（不得多查询展开）`);
});

test("GMI-001/GMI-002：请求 body 不回灌上游搜索建议 HTML（只发单个查询）", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-001 / GMI-002");
  const rig = newRig({ query: DEFAULT_QUERY });
  rig.fetch.when(GEMINI_ROUTE).responds({ body: outputsResponse({ annotations: [] }) });

  await settle(rig, startSearch(backend, rig));
  const [call] = gemCalls(rig.fetch);
  assert.ok(!JSON.stringify(bodyOf(call)).includes(SUGGESTION_MARK), "请求 body 不得包含上游搜索建议 HTML（插件只把单个查询发给供应商，AGENTS.md）");
});
