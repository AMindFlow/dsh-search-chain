// EXA-001 响应映射验收（docs/specs/draft/exa.md；来源校验依据 FB-002、A1/A2）。全红：等待 WP9 实现 src/backends/exa.js。
// 覆盖条款：EXA-001「按 results 顺序映射 url、title 和可用的高亮文本」；
//           「缺失、不合法或全部无效来源的结果为响应失败」（部分无效时保留有效项）；
//           FB-002「供应商生成的正文不得作为通用 content」（Exa 为纯来源适配器）。
// 待办见 helpers/exa-oracle.js 文件头（TODO-EXA-3/4/6/12）。
import test from "node:test";
import assert from "node:assert/strict";
import { assertSearchResult, ENTRY_CODES } from "./helpers/contract.js";
import {
  loadExaBackend,
  makeExaCtx,
  routeExa,
  settle,
  exaOk,
  exaResult,
} from "./helpers/exa-oracle.js";

const CLAUSE = "EXA-001 响应映射";

/** 对一条成功响应跑适配器，返回结果（断言其为成功 resolve）。 */
async function runOk(t, exa, body, opts = {}) {
  const { ctx, fetch } = makeExaCtx(opts);
  routeExa(fetch, { status: 200, body });
  const res = await settle(exa.search(ctx));
  assert.equal(res.ok, true, `成功响应不得抛错：${res.ok ? "" : res.error?.message}`);
  return res.value;
}

test("EXA-001 响应映射：按 results 顺序映射 url 与 title，结果满足 host WebSearchResult 形状", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const results = [exaResult(1), exaResult(2), exaResult(3)];

  const out = await runOk(t, exa, exaOk(results));

  assertSearchResult(t, out);
  assert.deepEqual(
    out.sources.map((s) => [s.url, s.title]),
    results.map((r) => [r.url, r.title]),
    "sources 的 url/title 必须按上游 results 顺序逐项映射（EXA-001）",
  );
});

test("EXA-001 高亮映射：可用的高亮文本进入 snippet 或 summary（二者择一，TODO-EXA-3）", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const results = [exaResult(1, { highlights: ["合成高亮甲", "合成高亮乙"] })];

  const out = await runOk(t, exa, exaOk(results));

  const s = out.sources[0];
  const text = `${s.snippet ?? ""}\n${s.summary ?? ""}`;
  for (const h of ["合成高亮甲", "合成高亮乙"]) {
    assert.ok(text.includes(h), `高亮「${h}」必须出现在 snippet 或 summary 中（EXA-001「可用的高亮文本」）`);
  }
});

test("EXA-001 高亮映射：无可用高亮时不得编造 snippet/summary，且不得以正文 text 代替（TODO-EXA-3）", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const results = [
    exaResult(1, { highlights: [] }),
    exaResult(2, { highlights: undefined, text: "合成正文不应被当作摘要" }),
  ];

  const out = await runOk(t, exa, exaOk(results));

  assert.equal(out.sources.length, 2, "无高亮的有效结果仍须保留（EXA-001「可用的」仅影响文本）");
  for (const s of out.sources) {
    assert.equal(s.snippet, undefined, "无高亮时 snippet 不得编造（EXA-001）");
    assert.equal(s.summary, undefined, "无高亮时 summary 不得编造（EXA-001）");
  }
});

test("EXA-001 来源校验：url 缺失、相对路径、非 HTTP(S)、非字符串的项被丢弃，其余有效项保持顺序", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const a = exaResult(1);
  const b = exaResult(2);
  const c = exaResult(3);
  const results = [
    a,
    { title: "无 url 的合成项", highlights: ["x"] },
    b,
    { url: "/relative/path", title: "相对路径" },
    { url: "ftp://exa-sample.invalid/ftp", title: "非 HTTP" },
    { url: 42, title: "非字符串 url" },
    c,
  ];

  const out = await runOk(t, exa, exaOk(results));

  assertSearchResult(t, out, { sources: out.sources });
  assert.deepEqual(
    out.sources.map((s) => s.url),
    [a.url, b.url, c.url],
    "部分无效时须丢弃无效项、保留有效项的上游顺序（EXA-001 与 FB-002 绝对 HTTP(S) URL）",
  );
});

test("EXA-001 来源校验：title 缺失的有效 url 仍保留（A1 title 可选），且不编造 title", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const results = [exaResult(1, { title: undefined })];

  const out = await runOk(t, exa, exaOk(results));

  assert.equal(out.sources.length, 1, "有效 url 不因缺 title 被丢弃（A1 title 可选）");
  assert.equal(out.sources[0].url, results[0].url);
  assert.equal(out.sources[0].title, undefined, "缺 title 时不得编造标题（EXA-001）");
});

test("EXA-001 来源校验：全部结果无效 → 响应失败 ENTRY_BAD_RESPONSE（不得当作空结果）", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx, fetch } = makeExaCtx();
  routeExa(fetch, {
    status: 200,
    body: exaOk([{ title: "无 url" }, { url: "/relative" }, { url: "javascript:alert(1)" }]),
  });

  const res = await settle(exa.search(ctx));

  assert.equal(res.ok, false, "全部来源无效须抛错，不得返回 sources: []（EXA-001 与 FB-004 空语义区分）");
  assert.equal(res.error?.code, ENTRY_CODES.BAD_RESPONSE, "全部无效来源 → ENTRY_BAD_RESPONSE（FB-005 异常响应）");
});

test("EXA-001 结构校验：results 缺失、为 null、非数组 → 响应失败 ENTRY_BAD_RESPONSE", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const shapes = [{}, { results: null }, { results: "not-an-array" }, { results: {} }, { requestId: "x" }];
  for (const body of shapes) {
    const { ctx, fetch } = makeExaCtx();
    routeExa(fetch, { status: 200, body });

    const res = await settle(exa.search(ctx));

    assert.equal(res.ok, false, `坏结构 ${JSON.stringify(body)} 必须失败（EXA-001「缺失或不合法」）`);
    assert.equal(res.error?.code, ENTRY_CODES.BAD_RESPONSE, `坏结构 ${JSON.stringify(body)} 码须为 ENTRY_BAD_RESPONSE`);
  }
});

test("FB-002 纯来源：适配器结果不携带通用 content，即使响应含供应商生成的正文字段", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const body = exaOk([exaResult(1), exaResult(2)], {
    output: { content: "合成的供应商生成正文，不得作为通用 content（FB-002）" },
    autopromptString: "合成的改写查询",
  });

  const out = await runOk(t, exa, body);

  assert.equal(out.content, undefined, "Exa 为纯来源适配器：供应商正文不得作为通用 content（FB-002）");
});

test("EXA-001 maxResults 边界：上游超发时只返回上游顺序的前缀，不报错（TODO-EXA-6，截断责任不在本断言）", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const upstream = [exaResult(1), exaResult(2), exaResult(3), exaResult(4)];

  const out = await runOk(t, exa, exaOk(upstream), { maxResults: 2 });

  assert.ok(out.sources.length >= 1 && out.sources.length <= upstream.length, "超发时结果数须在有效区间内");
  assert.deepEqual(
    out.sources.map((s) => s.url),
    upstream.slice(0, out.sources.length).map((r) => r.url),
    "超发时只能是上游顺序的前缀，不得重排或编造（FB-002 顺序）",
  );
});
