// WP3 验收 — TAV-001 单查询与服务上限（src/backends/tavily.js，请求成形）。
// 覆盖条款：
//   TAV-001 要求1：POST https://api.tavily.com/search；Bearer 鉴权；正文单个原查询；
//                  search_depth:"basic"、auto_parameters:false、include_answer:false、include_raw_content:false；
//                  maxResults 取其与 20 的较小值；未提供则省略 max_results（Tavily 默认）。
//   TAV-001 验收：maxResults 为 3 / 30 / 未指定 → 服务参数 3 / 20 / 省略。
//   CFG-002/CFG-003（适配器侧）：key 只随鉴权头发送，不进入 URL 或正文；每个条目用自己的 key。
//   FB-001：key 缺失时出站为零（条目跳过语义由链负责，适配器侧不得发出无鉴权请求）。
// 不覆盖：计费说明文案（TAV-001 要求2，属设置面板 UI 验收）；代理/直连路由（CFG-001，归 transport 验收）；
//         额度分类（归 tavily-failures.test.js）。
// 样本与断言助手见 test/helpers/tavily-oracle.js（合成样本内联，不写入 test/fixtures/）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  TAVILY_KEY,
  TAVILY_KEY_B,
  TAVILY_URL,
  TAVILY_MAX_RESULTS_CAP,
  SAMPLE_QUERY,
  successBody,
  tavilyFetch,
  loadTavilyBackend,
  makeCtx,
  singleCall,
  bodyOf,
  assertEndpoint,
  rejectionOf,
} from "./helpers/tavily-oracle.js";

const OK = () => ({ status: 200, body: successBody() });

test("TAV-001 要求1：单次 POST 到固定端点，无查询串，Bearer 鉴权", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-001");
  if (!backend) return;
  const fetch = tavilyFetch(OK());
  await backend.search(makeCtx({ fetch }));
  const call = singleCall(fetch, "默认查询");
  assertEndpoint(call);
  assert.equal(call.headers.authorization, `Bearer ${TAVILY_KEY}`, "TAV-001：Bearer 鉴权，值为条目注入的 key（A4/A5）");
});

test("TAV-001 要求1：正文逐字段符合规格，query 为单个原查询", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-001");
  if (!backend) return;
  const fetch = tavilyFetch(OK());
  await backend.search(makeCtx({ fetch }));
  const body = bodyOf(singleCall(fetch));
  assert.equal(body.query, SAMPLE_QUERY, "TAV-001：正文必须发送单个原查询，逐字不改写");
  assert.equal(body.search_depth, "basic", "TAV-001：search_depth 固定 basic");
  assert.equal(body.auto_parameters, false, "TAV-001：auto_parameters 必须为 false");
  assert.equal(body.include_answer, false, "TAV-001：include_answer 必须为 false");
  assert.equal(body.include_raw_content, false, "TAV-001：include_raw_content 必须为 false");
});

test("TAV-001 要求1/CFG-003：key 只进鉴权头，不进入 URL 或正文", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-001/CFG-003");
  if (!backend) return;
  const fetch = tavilyFetch(OK());
  await backend.search(makeCtx({ fetch, maxResults: 3 }));
  const call = singleCall(fetch);
  assert.ok(!call.url.includes(TAVILY_KEY), "CFG-003：key 不得出现在 URL 中");
  assert.ok(!JSON.stringify(bodyOf(call)).includes(TAVILY_KEY), "CFG-003：key 不得出现在正文中");
});

test("TAV-001 验收：maxResults=3 → 服务参数 max_results=3", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-001");
  if (!backend) return;
  const fetch = tavilyFetch(OK());
  await backend.search(makeCtx({ fetch, maxResults: 3 }));
  assert.equal(bodyOf(singleCall(fetch)).max_results, 3);
});

test("TAV-001 验收：maxResults=30 → 服务参数封顶为 20", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-001");
  if (!backend) return;
  const fetch = tavilyFetch(OK());
  await backend.search(makeCtx({ fetch, maxResults: 30 }));
  assert.equal(bodyOf(singleCall(fetch)).max_results, TAVILY_MAX_RESULTS_CAP, "TAV-001：max_results = min(maxResults, 20)");
});

test("TAV-001 验收：maxResults 未指定 → 请求体省略 max_results 字段", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-001");
  if (!backend) return;
  const fetch = tavilyFetch(OK());
  await backend.search(makeCtx({ fetch }));
  const body = bodyOf(singleCall(fetch));
  assert.ok(!("max_results" in body), "TAV-001：未提供 maxResults 时必须省略 max_results（使用 Tavily 默认），不得写 null 或 0");
});

test("TAV-001 要求1：maxResults 边界 20 与 1 原样发送（不得多减一）", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-001");
  if (!backend) return;
  for (const n of [TAVILY_MAX_RESULTS_CAP, 1]) {
    const fetch = tavilyFetch(OK());
    await backend.search(makeCtx({ fetch, maxResults: n }));
    assert.equal(bodyOf(singleCall(fetch, `maxResults=${n}`)).max_results, n, `maxResults=${n} 应原样发送`);
  }
});

test("TAV-001 验收：直连与代理两种传输下请求形状一致、各恰好一次（路由本身归 transport 验收）", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-001");
  if (!backend) return;
  const direct = tavilyFetch(OK());
  const proxied = tavilyFetch(OK());
  await backend.search(makeCtx({ fetch: direct, maxResults: 3 }));
  await backend.search(makeCtx({ fetch: proxied, maxResults: 3 }));
  const a = singleCall(direct, "直连");
  const b = singleCall(proxied, "代理");
  assertEndpoint(a);
  assertEndpoint(b);
  assert.deepEqual(bodyOf(a), bodyOf(b), "两种传输下正文必须一致");
  assert.equal(a.headers.authorization, b.headers.authorization, "两种传输下鉴权头必须一致");
});

test("CFG-002/CFG-003：两个条目各自的 key 只发给各自的请求", async (t) => {
  const backend = await loadTavilyBackend(t, "CFG-002/CFG-003");
  if (!backend) return;
  const fetch = tavilyFetch(OK());
  await backend.search(makeCtx({ fetch, key: TAVILY_KEY, entryId: "tav-a" }));
  await backend.search(makeCtx({ fetch, key: TAVILY_KEY_B, entryId: "tav-b" }));
  const calls = fetch.callsFor(TAVILY_URL);
  assert.equal(calls.length, 2, "两个条目各自恰好一次出站");
  assert.equal(calls[0].headers.authorization, `Bearer ${TAVILY_KEY}`, "第一条目只用自己的 key");
  assert.equal(calls[1].headers.authorization, `Bearer ${TAVILY_KEY_B}`, "第二条目只用自己的 key，不得复用第一条目的 key");
});

for (const [label, key] of [
  ["undefined", undefined],
  ["空串", ""],
]) {
  test(`FB-001/CFG-002：key 为 ${label} 时零出站且失败（不发无鉴权请求）`, async (t) => {
    const backend = await loadTavilyBackend(t, "FB-001/CFG-002");
    if (!backend) return;
    const fetch = tavilyFetch(OK());
    const err = await rejectionOf(backend.search(makeCtx({ fetch, key })));
    assert.ok(err, "缺 key 时适配器不得成功返回");
    assert.equal(fetch.count(), 0, "FB-001：缺 key 条目出站请求数必须为零（码的细节见 tavily-pending.test.js）");
  });
}
