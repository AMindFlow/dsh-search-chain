// WP3 验收 — TAV-002 结果映射与正常空结果（src/backends/tavily.js，响应映射）。
// 覆盖条款：
//   TAV-002 要求：成功响应须提供 results 数组；按数组顺序把有效项的 url / title / content
//                 映射为 WebSource 的链接、标题、snippet；空数组 = 正常无结果（非错误）；
//                 results 缺失或类型错误、或非空数组中没有有效来源 → 响应失败（ENTRY_BAD_RESPONSE）。
//   TAV-002 验收：正常有序结果 / 空数组 / 缺失或类型错误的 results / 全为无效 URL 的结果。
//   FB-002：来源须为可解析的绝对 HTTP(S) URL；sources 严格按供应商返回顺序。
//   FB-004：空数组对适配器而言是 resolve({ sources: [] })，不得抛错。
// 不覆盖：截断 truncated（链层 FB-002）；answer 字段是否进入 content（规格含糊，见 tavily-pending.test.js）。
// 样本见 test/helpers/tavily-oracle.js（合成内联）。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import {
  SAMPLE_RESULTS,
  successBody,
  tavilyFetch,
  loadTavilyBackend,
  makeCtx,
  singleCall,
  rejectionOf,
  assertEntryError,
  expectedSourceOf,
  normalizeSources,
} from "./helpers/tavily-oracle.js";

async function runWith(backend, spec) {
  const fetch = tavilyFetch(spec);
  const ctx = makeCtx({ fetch, maxResults: 10 });
  const out = await backend.search(ctx);
  singleCall(fetch, "映射用例");
  return out;
}

test("TAV-002 要求：正常有序结果逐条映射为 url / title / snippet，顺序不变", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-002");
  if (!backend) return;
  const out = await runWith(backend, { status: 200, body: successBody() });
  assert.deepEqual(
    normalizeSources(out.sources),
    SAMPLE_RESULTS.map(expectedSourceOf),
    "TAV-002：sources 必须按 results 数组顺序，且仅含 url/title/snippet（content→snippet）",
  );
});

test("FB-002/TAV-002：URL 无效的条目被剔除，有效条目保序保留", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-002/FB-002");
  if (!backend) return;
  const mixed = [
    SAMPLE_RESULTS[0],
    { url: "javascript:void(0)", title: "合成无效协议", content: "x" },
    { url: "not a url at all", title: "合成非 URL", content: "x" },
    { url: "ftp://synthetic-host.invalid/file", title: "合成 FTP", content: "x" },
    { title: "合成缺 url", content: "x" },
    SAMPLE_RESULTS[1],
  ];
  const out = await runWith(backend, { status: 200, body: successBody(mixed) });
  assert.deepEqual(
    normalizeSources(out.sources),
    [expectedSourceOf(SAMPLE_RESULTS[0]), expectedSourceOf(SAMPLE_RESULTS[1])],
    "FB-002：仅绝对 HTTP(S) URL 的有效项进入 sources，且保持相对顺序",
  );
  for (const s of out.sources) {
    assert.ok(/^https?:$/.test(new URL(s.url).protocol), `FB-002：sources url 必须为 HTTP(S)：${s.url}`);
  }
});

test("TAV-002 要求：缺 title 或缺 content 时不产生对应字段（不编造占位文本）", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-002");
  if (!backend) return;
  const sparse = [
    { url: "https://synthetic-host.invalid/tavily/no-title", content: "仅有摘要" },
    { url: "https://synthetic-host.invalid/tavily/no-content", title: "仅有标题" },
  ];
  const out = await runWith(backend, { status: 200, body: successBody(sparse) });
  assert.equal(out.sources.length, 2);
  assert.equal(out.sources[0].title, undefined, "缺 title 时不得编造标题");
  assert.equal(out.sources[0].snippet, "仅有摘要");
  assert.equal(out.sources[1].snippet, undefined, "缺 content 时不得编造摘要");
  assert.equal(out.sources[1].title, "仅有标题");
});

test("TAV-002 验收：空数组 → 正常无结果（resolve 为 sources: []，不抛错）", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-002/FB-004");
  if (!backend) return;
  const out = await runWith(backend, { status: 200, body: successBody([]) });
  assert.ok(out && typeof out === "object", "空结果必须 resolve 为对象，而非抛错");
  assert.deepEqual(out.sources, [], "FB-004：空数组映射为 sources: []");
});

for (const [label, body] of [
  ["results 字段缺失", { query: "x", answer: null }],
  ["results 为字符串", { query: "x", results: "not-an-array" }],
  ["results 为对象", { query: "x", results: { 0: SAMPLE_RESULTS[0] } }],
  ["results 为 null", { query: "x", results: null }],
]) {
  test(`TAV-002 验收：${label} → 响应失败 ENTRY_BAD_RESPONSE`, async (t) => {
    const backend = await loadTavilyBackend(t, "TAV-002");
    if (!backend) return;
    const fetch = tavilyFetch({ status: 200, body });
    const err = await rejectionOf(backend.search(makeCtx({ fetch })));
    assertEntryError(err, C.ENTRY_CODES.BAD_RESPONSE);
    singleCall(fetch, label);
  });
}

test("TAV-002 验收：非空数组但全部无效 URL → 响应失败 ENTRY_BAD_RESPONSE（不是空结果）", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-002");
  if (!backend) return;
  const allBad = [
    { url: "javascript:alert(1)", title: "无效一", content: "x" },
    { url: "not a url", title: "无效二", content: "x" },
  ];
  const fetch = tavilyFetch({ status: 200, body: successBody(allBad) });
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.BAD_RESPONSE);
  singleCall(fetch, "全部无效");
});

test("FB-005/TAV-002：200 但正文非 JSON → 响应失败 ENTRY_BAD_RESPONSE", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-002/FB-005");
  if (!backend) return;
  const fetch = tavilyFetch({ status: 200, body: "{ this is not json (synthetic)" });
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  assertEntryError(err, C.ENTRY_CODES.BAD_RESPONSE);
  singleCall(fetch, "非 JSON 正文");
});
