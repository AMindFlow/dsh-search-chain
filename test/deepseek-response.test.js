// WP8 DeepSeek 响应映射验收（docs/specs/draft/deepseek.md DSK-002/DSK-004；来源合同 FB-002、A1/A2）。
// 全红：src/backends/deepseek.js 尚未实现，等待 WP8。
// 覆盖条款：
//   DSK-004 Search API：成功响应必须含 results 数组；按数组顺序映射 url/title/snippet/summary/date，
//     date→publishedAt；供应商专有字段不进入来源（A2）；缺失字段省略不编造；无效项丢弃保序；
//     数组缺失/类型错误/非空数组无有效 URL → 响应失败（ENTRY_BAD_RESPONSE）；
//     FB-002 纯来源：content 缺省；超发时结果是上游顺序前缀（截断责任归链级，S6/P8）。
//   DSK-002 Agentic Search：从 web_search_tool_result 的 web_search_result 项提取 url/title 与可用
//     snippet；对相同 URL 字符串按首见顺序去重；生成的回答与裸链接不得构造成来源；模型正文不作为
//     content（FB-002 + P7 推断）。
// 待办：helpers/deepseek-oracle.js 头注 S1..S7；test/deepseek-pending.test.js P1..P8。
import test from "node:test";
import assert from "node:assert/strict";
import { ENTRY_CODES } from "./helpers/contract.js";
import {
  agenticOk,
  assertAdapterResultShape,
  agenticThreeResults,
  dsApiOk,
  dsApiResult,
  dsSearchResult,
  dsTextBlock,
  dsToolResultBlock,
  expectedApiSource,
  loadDeepseek,
  makeCtx,
  normalizeSources,
  routeFor,
  settle,
  stripUndefined,
} from "./helpers/deepseek-oracle.js";

const AG = "deepseek-agentic-search";
const API = "deepseek-search";

/** 对成功响应跑适配器，要求 resolve，并做 A1/FB-002 形状检查。 */
async function runOk(t, backend, type, body, opts = {}) {
  const { ctx, fetch } = makeCtx({ type, ...opts });
  routeFor(fetch, type, { status: 200, body });
  const res = await settle(backend.search(ctx));
  assert.equal(res.ok, true, `200 有效响应不得抛错：${res.ok ? "" : res.error?.code} ${res.error?.message ?? ""}`);
  assertAdapterResultShape(t, res.value, "适配器结果（A5：sources 必填，content/truncated 若存在须合规）");
  return res.value;
}

/** 对响应跑适配器并返回 settle 结果（形状类断言用）。 */
async function runSettled(t, backend, type, body, opts = {}) {
  const { ctx, fetch } = makeCtx({ type, ...opts });
  routeFor(fetch, type, { status: 200, body });
  return settle(backend.search(ctx));
}

// ─── DSK-004 Search API 映射 ────────────────────────────────────────────────

test("DSK-004 映射：results 顺序逐项映射 url/title/snippet/summary，date→publishedAt，深比较锁形状与顺序", async (t) => {
  const backend = await loadDeepseek(t, API, "DSK-004 映射");
  const results = [dsApiResult(1), dsApiResult(2), dsApiResult(3)];
  const out = await runOk(t, backend, API, dsApiOk(results));
  assert.deepEqual(
    normalizeSources(out.sources),
    results.map(expectedApiSource),
    "来源必须逐字段、按数组顺序映射，date 落入 publishedAt（DSK-004）",
  );
});

test("DSK-004 白名单：site_name/icon 等供应商专有字段不得进入来源（A2 不新增 per-source 字段）", async (t) => {
  const backend = await loadDeepseek(t, API, "DSK-004 字段白名单");
  const out = await runOk(t, backend, API, dsApiOk([dsApiResult(1)]));
  assert.deepEqual(Object.keys(out.sources[0]).sort(), ["publishedAt", "snippet", "summary", "title", "url"]);
});

test("DSK-004 省略语义：title/snippet/summary/date 缺失时来源省略对应字段，不得编造", async (t) => {
  const backend = await loadDeepseek(t, API, "DSK-004 省略语义");
  const out = await runOk(
    t,
    backend,
    API,
    dsApiOk([dsApiResult(1, { title: undefined, snippet: undefined, summary: undefined, date: undefined })]),
  );
  assert.deepEqual(out.sources, [{ url: dsApiResult(1).url }], "仅有 url 的有效项只返回 url（A1 可选字段，不编造）");
});

test("DSK-004 部分无效：URL 缺失/非字符串/相对/非 HTTP(S)/空白、非对象项被丢弃，有效项按原顺序保留", async (t) => {
  const backend = await loadDeepseek(t, API, "DSK-004 部分无效");
  const valid = [dsApiResult(1), dsApiResult(2), dsApiResult(3)];
  const results = [
    valid[0],
    { title: "无 url", snippet: "x" },
    "not-an-object",
    valid[1],
    { url: "/relative/path", title: "相对路径" },
    { url: "ftp://ds-sample.invalid/x", title: "非 HTTP" },
    { url: "javascript:alert(1)", title: "脚本" },
    { url: "   ", title: "空白" },
    { url: 42, title: "非字符串" },
    valid[2],
  ];
  const out = await runOk(t, backend, API, dsApiOk(results));
  assert.deepEqual(
    normalizeSources(out.sources),
    valid.map(expectedApiSource),
    "丢弃无效项、保留有效项的上游顺序（DSK-004「有效项」+ FB-002 绝对 HTTP(S)）",
  );
});

test("DSK-004 空数组：200 且 results:[] → 正常无结果 sources:[]，不抛错、不带 content", async (t) => {
  const backend = await loadDeepseek(t, API, "DSK-004 空数组");
  const out = await runOk(t, backend, API, dsApiOk([]));
  assert.deepEqual(out.sources, [], "空数组是明确无结果（DSK-004「空数组报告正常无结果」）");
  assert.equal(out.content, undefined, "正常空结果不得携带 content（纯来源，FB-002）");
});

test("DSK-004 结构失败：results 缺失/null/非数组/响应根为数组 → ENTRY_BAD_RESPONSE", async (t) => {
  const backend = await loadDeepseek(t, API, "DSK-004 结构失败");
  const shapes = [{}, { results: null }, { results: "not-an-array" }, { results: {} }, { results: 42 }, []];
  for (const body of shapes) {
    const res = await runSettled(t, backend, API, body);
    assert.equal(res.ok, false, `坏结构 ${JSON.stringify(body)} 必须失败（DSK-004「数组缺失、类型错误」）`);
    assert.equal(res.error?.code, ENTRY_CODES.BAD_RESPONSE, `坏结构 ${JSON.stringify(body)} → ENTRY_BAD_RESPONSE（FB-005）`);
  }
});

test("DSK-004 全无效：非空数组但没有任何有效 URL → 响应失败 ENTRY_BAD_RESPONSE（不是正常空结果）", async (t) => {
  const backend = await loadDeepseek(t, API, "DSK-004 全无效");
  const res = await runSettled(t, backend, API, dsApiOk([{ title: "无 url" }, { url: "/relative" }, { url: "ftp://x.invalid" }]));
  assert.equal(res.ok, false, "全部无效不得返回 sources:[]（DSK-004 与 FB-004 空语义区分）");
  assert.equal(res.error?.code, ENTRY_CODES.BAD_RESPONSE, "全无效 → ENTRY_BAD_RESPONSE（FB-005 异常响应）");
});

test("FB-002 纯来源：Search API 适配器 content 缺省（接管首行标注由链级注入）", async (t) => {
  const backend = await loadDeepseek(t, API, "FB-002 content");
  const out = await runOk(t, backend, API, dsApiOk([dsApiResult(1)]));
  assert.equal(out.content, undefined, "Search API 适配器结果不得携带 content（FB-002 纯来源 + DSK-004）");
});

test("DSK-004/S6 超发：maxResults=2 且上游 4 条时不报错，结果保持上游顺序前缀（截断与 truncated 责任归属见 pending P8）", async (t) => {
  const backend = await loadDeepseek(t, API, "DSK-004 超发前缀");
  const results = [dsApiResult(1), dsApiResult(2), dsApiResult(3), dsApiResult(4)];
  const out = await runOk(t, backend, API, dsApiOk(results), { maxResults: 2 });
  assert.ok(out.sources.length >= 1 && out.sources.length <= results.length, `sources 数须在 1..上游条数（实际 ${out.sources.length}）`);
  assert.deepEqual(
    out.sources.map((s) => s.url),
    results.slice(0, out.sources.length).map((r) => r.url),
    "只能是上游顺序的前缀，不得重排（FB-002 顺序；截断责任归属见 pending P8）",
  );
});

// ─── DSK-002 Agentic Search 映射 ────────────────────────────────────────────

test("DSK-002 映射：web_search_tool_result 的 web_search_result 项提取 url/title/snippet，顺序保持，结果形状合规", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-002 映射");
  const items = [dsSearchResult(1), dsSearchResult(2), dsSearchResult(3)];
  const out = await runOk(t, backend, AG, agenticOk([dsToolResultBlock(items), dsTextBlock()]));
  assert.deepEqual(
    normalizeSources(out.sources),
    items.map((r) => stripUndefined({ url: r.url, title: r.title, snippet: r.snippet })),
    "按实际搜索结果块顺序逐项映射 url/title/snippet（DSK-002）",
  );
});

test("DSK-002 snippet：「可用的」缺失时省略，不得编造；title 缺失同样省略", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-002 snippet 可选");
  const items = [dsSearchResult(1, { snippet: undefined }), dsSearchResult(2, { title: undefined, snippet: undefined })];
  const out = await runOk(t, backend, AG, agenticOk([dsToolResultBlock(items)]));
  assert.equal(out.sources.length, 2, "缺 snippet/title 不使有效项被丢弃（DSK-002「可用的」）");
  assert.equal(out.sources[0].snippet, undefined, "snippet 缺失不得编造（DSK-002）");
  assert.equal(out.sources[1].snippet, undefined);
  assert.equal(out.sources[1].title, undefined, "title 缺失不得编造（A1 可选）");
});

test("DSK-002 去重：相同 URL 字符串按首见顺序保留一次；不同 URL 不吞并；跨块同样去重", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-002 去重");
  const a = dsSearchResult(1);
  const aDup = dsSearchResult(1, { title: "重复标题应被丢弃" });
  const b = dsSearchResult(2);
  const c = dsSearchResult(3);
  const out = await runOk(
    t,
    backend,
    AG,
    agenticOk([
      dsToolResultBlock([a, aDup, b], "srvtoolu_synth_1"),
      dsToolResultBlock([b, c], "srvtoolu_synth_2"),
    ]),
  );
  assert.deepEqual(
    out.sources.map((s) => s.url),
    [a.url, b.url, c.url],
    "URL 字符串相同只保留首次出现，首见顺序排列（DSK-002）",
  );
  assert.equal(out.sources[0].title, a.title, "重复项不得覆盖首见条目（DSK-002「首见」）");
});

test("DSK-002 无效项：URL 缺失/相对/非 HTTP(S)/非字符串的结果项丢弃，有效项保序；裸链接不得成来源", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-002 无效项与裸链接");
  const a = dsSearchResult(1);
  const b = dsSearchResult(2);
  const blocks = [
    dsToolResultBlock([
      a,
      { type: "web_search_result", title: "无 url" },
      { type: "web_search_result", url: "/relative", title: "相对" },
      { type: "web_search_result", url: "ftp://ds-sample.invalid/x", title: "FTP" },
      { type: "web_search_result", url: 42, title: "非字符串" },
      b,
    ]),
    dsTextBlock("回答里提到 https://ds-bare-link.invalid/page-a 和 http://ds-bare-link.invalid/page-b 两个裸链接。"),
  ];
  const out = await runOk(t, backend, AG, agenticOk(blocks));
  assert.deepEqual(
    out.sources.map((s) => s.url),
    [a.url, b.url],
    "丢弃无效结果项、保留有效项顺序；正文/裸链接不构造来源（DSK-002）",
  );
  assert.ok(
    !out.sources.some((s) => s.url.includes("ds-bare-link.invalid")),
    "裸链接不得成为来源（DSK-002「生成的回答和裸链接不得构造成来源」）",
  );
});

test("DSK-002 正文复述与新增链接：来源只来自结果块，回答中的链接不得被构造成来源", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-002 正文不入来源");
  const item = dsSearchResult(1);
  const body = agenticOk([
    dsToolResultBlock([item]),
    { type: "text", text: `回答复述 ${item.url} 并新增 https://ds-sample.invalid/answer/only` },
  ]);
  const out = await runOk(t, backend, AG, body);
  assert.deepEqual(out.sources.map((s) => s.url), [item.url], "来源只来自实际搜索结果块（DSK-002）");
  assert.ok(!out.sources.some((s) => s.url.includes("/answer/only")), "回答中的链接不得被构造成来源（DSK-002）");
});

test("S5 块缺失：无任何 web_search_tool_result 块（只有 server_tool_use/正文）→ 失败，不得误当正常空结果（归类见 pending P6）", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-002 块缺失");
  const res = await runSettled(
    t,
    backend,
    AG,
    agenticOk([
      { type: "server_tool_use", id: "srvtoolu_synth_1", name: "web_search", input: { queries: ["q"] } },
      dsTextBlock(),
    ]),
  );
  assert.equal(res.ok, false, "未产出任何结果块不是「明确空结果」（DSK-002）");
});

test("FB-002 纯来源（Agentic）：模型回答不得作为通用 content 返回（推断，理由见 pending P7）", async (t) => {
  const backend = await loadDeepseek(t, AG, "FB-002 content（Agentic）");
  const out = await runOk(t, backend, AG, agenticThreeResults());
  assert.equal(out.content, undefined, "Agentic 适配器不得把模型回答作为 content 返回（FB-002 纯来源；P7）");
});
