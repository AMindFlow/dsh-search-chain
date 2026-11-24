// WP5 验收 — FB-001（顺序、跳过、执行期冻结）与 FB-002（成功结果与提示）。
// 实现模块：src/search.js（createSearchChain，contract.js A4/A5/A6）。尚未实现时全部为红，
// 诊断带「等待实现 WP5」与条款号（helpers/impl.js 约定）；不得改为 skip。
// 条目替身：fake-backend（按条目 ID 脚本化）；时间：chain-harness 受控时钟。
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_QUERY } from "./helpers/chain-harness.js";
import { stepSuccess, stepFail } from "./helpers/fake-backend.js";
import { ENTRY_CODES, assertSearchResult, makeEntry, makeSources, makeSource } from "./helpers/contract.js";
import { flush } from "./helpers/clock.js";
import { chainHarness, keyedEntry, refsFor, refOf } from "./helpers/search-oracle.js";

const CLAUSES = "FB-001/FB-002";

// ─── FB-001：顺序与首个有效来源即停止 ────────────────────────────────────────

test("FB-001：按已保存顺序串行尝试，首个有效来源即停止，后续条目不发请求", async (t) => {
  const s = makeSources(2, "https://synthetic-b.invalid/doc");
  const h = await chainHarness(t, CLAUSES, {
    entries: [
      keyedEntry("e-a", "openai", "条目甲"),
      keyedEntry("e-b", "tavily", "条目乙"),
      keyedEntry("e-c", "exa", "条目丙"),
    ],
    credentialRefs: refsFor("e-a", "e-b", "e-c"),
    steps: {
      "e-a": [stepFail({ code: ENTRY_CODES.NETWORK })],
      "e-b": [stepSuccess({ sources: s })],
      "e-c": [stepSuccess({ sources: makeSources(1, "https://synthetic-c.invalid/doc") })],
    },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assertSearchResult(t, res, { sources: s, truncated: false, entryName: "条目乙" });
  assert.deepEqual(
    h.executions().map((c) => c.entryId),
    ["e-a", "e-b"],
    "FB-001：实际执行顺序必须与已保存列表一致，首个成功后停止",
  );
  assert.equal(h.executionCount("e-a"), 1, "FB-001：每个条目最多向其供应商提交一次查询");
  assert.equal(h.executionCount("e-b"), 1, "FB-001：每个条目最多向其供应商提交一次查询");
  assert.equal(h.executionCount("e-c"), 0, "FB-001：首个有效结果之后的条目不得发出请求");
});

test("FB-001：已保存顺序在执行期冻结，搜索中途改动列表不影响本次执行（链不读活配置）", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [
      keyedEntry("e-a", "openai", "条目甲"),
      keyedEntry("e-b", "tavily", "条目乙"),
      keyedEntry("e-c", "exa", "条目丙"),
    ],
    credentialRefs: refsFor("e-a", "e-b", "e-c"),
    steps: {
      "e-a": [stepFail({ code: ENTRY_CODES.NETWORK, consumeMs: 1000 })],
      "e-b": [stepFail({ code: ENTRY_CODES.QUOTA })],
      "e-c": [stepSuccess({ sources: makeSources(1) })],
    },
  });
  const p = h.search({ query: DEFAULT_QUERY });
  await flush(2);
  h.clock.advance(500); // 此时 e-a 仍在执行（耗时 1000ms）
  // 模拟另一界面保存：反转顺序并停用 e-b。本次搜索必须仍按开始时的快照执行。
  h.mutateSaved((saved) => {
    saved.entries.reverse();
    saved.entries.find((e) => e.id === "e-b").enabled = false;
  });
  const res = await h.runToValue(p);
  assert.deepEqual(
    h.executions().map((c) => c.entryId),
    ["e-a", "e-b", "e-c"],
    "FB-001：执行期顺序须冻结在搜索开始时的快照，不得读取中途改动的活配置",
  );
  assertSearchResult(t, res, { sources: makeSources(1), entryName: "条目丙" });
});

test("FB-001：停用条目与缺 key 条目直接跳过，不读停用条目 key、不发请求、不分配传输", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [
      makeEntry({ id: "e-d", type: "openai", name: "停用条目甲", enabled: false, credentialRef: refOf("e-d") }),
      makeEntry({ id: "e-e", type: "tavily", name: "无钥条目乙", enabled: true }),
      keyedEntry("e-f", "exa", "条目丙"),
    ],
    credentialRefs: refsFor("e-d", "e-f"),
    steps: {
      "e-d": [stepSuccess({ sources: makeSources(1, "https://synthetic-d.invalid/doc") })],
      "e-e": [stepSuccess({ sources: makeSources(1, "https://synthetic-e.invalid/doc") })],
      "e-f": [stepSuccess({ sources: makeSources(1) })],
    },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assert.deepEqual(
    h.executions().map((c) => c.entryId),
    ["e-f"],
    "FB-001：停用条目与缺 key 条目不得出站",
  );
  assert.equal(h.executionCount("e-d"), 0, "FB-001：停用条目不得调用适配器");
  assert.equal(h.executionCount("e-e"), 0, "FB-001：缺 key 条目不得调用适配器");
  assert.equal(h.fetchFn.count(), 0, "FB-001：跳过条目不得发出任何网络请求");
  assert.ok(
    !h.credentials.resolveCalls.includes(refOf("e-d")),
    "CFG-002/FB-001：停用条目不得为其解析 key（不得读取其凭据引用）",
  );
  assert.ok(
    !h.transport.openedEntryIds.includes("e-d") && !h.transport.openedEntryIds.includes("e-e"),
    "A6：仅实际尝试的条目才 open 传输句柄，跳过条目不得 open",
  );
  // FB-002：此前有启用条目因缺 key 被跳过 → content 首行标明实际使用的条目；停用条目不得被标注。
  assertSearchResult(t, res, { sources: makeSources(1), entryName: "条目丙", noEntryMark: "停用条目甲" });
});

test("FB-001：同型条目以各自 ID 区分，各自只尝试一次", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("o-1", "openai", "OpenAI 甲"), keyedEntry("o-2", "openai", "OpenAI 乙")],
    credentialRefs: refsFor("o-1", "o-2"),
    steps: {
      "o-1": [stepFail({ code: ENTRY_CODES.RATE_LIMITED })],
      "o-2": [stepSuccess({ sources: makeSources(1) })],
    },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assertSearchResult(t, res, { sources: makeSources(1), entryName: "OpenAI 乙" });
  assert.deepEqual(
    h.executions().map((c) => c.entryId),
    ["o-1", "o-2"],
    "FB-001：同型条目须按 ID 逐条尝试",
  );
  assert.equal(h.executionCount("o-1"), 1);
  assert.equal(h.executionCount("o-2"), 1);
});

// ─── FB-002：成功结果、截断与接管提示 ────────────────────────────────────────

test("FB-002：maxResults=3 时 2、3、4 条来源分别返回 2、3、3 条，仅第三次 truncated=true", async (t) => {
  const outcomes = [];
  for (const n of [2, 3, 4]) {
    const all = makeSources(n);
    const h = await chainHarness(t, CLAUSES, {
      entries: [keyedEntry("e-a", "tavily", "条目甲")],
      credentialRefs: refsFor("e-a"),
      steps: { "e-a": [stepSuccess({ sources: all })] },
    });
    const res = await h.runToValue(h.search({ query: DEFAULT_QUERY, maxResults: 3 }));
    outcomes.push({ returned: res.sources.length, truncated: res.truncated, urls: res.sources.map((s) => s.url), all });
  }
  assert.deepEqual(
    outcomes.map((o) => o.returned),
    [2, 3, 3],
    "FB-002：超过 maxResults 时保留前若干条；不足或恰好时全部返回",
  );
  assert.deepEqual(
    outcomes.map((o) => o.truncated),
    [false, false, true],
    "FB-002：只有超过 maxResults 而被截断时 truncated 为 true",
  );
  assert.deepEqual(
    outcomes[2].urls,
    outcomes[2].all.slice(0, 3).map((s) => s.url),
    "FB-002：截断保留的是供应商返回顺序的前三条",
  );
});

test("FB-002：首个条目成功则 content 不标注接管（停用条目不构成标注理由）", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [
      makeEntry({ id: "e-x", type: "bing", name: "停用甲", enabled: false }),
      makeEntry({ id: "e-y", type: "bing", name: "条目丁", enabled: true }),
    ],
    steps: { "e-y": [stepSuccess({ sources: makeSources(1) })] },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assertSearchResult(t, res, { sources: makeSources(1), truncated: false, noEntryMark: "停用甲" });
  assert.equal(h.executionCount("e-x"), 0, "停用条目不得出站");
});

test("FB-002：首条失败后第二条目接管，sources 只来自成功条目且 content 首行标明接管条目", async (t) => {
  const takeover = makeSources(2, "https://synthetic-tv.invalid/doc");
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-a", "openai", "主线"), keyedEntry("e-b", "tavily", "备线")],
    credentialRefs: refsFor("e-a", "e-b"),
    steps: {
      "e-a": [stepFail({ code: ENTRY_CODES.NETWORK })],
      "e-b": [stepSuccess({ sources: takeover })],
    },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assertSearchResult(t, res, { sources: takeover, truncated: false, entryName: "备线" });
  assert.ok(
    res.sources.every((s) => s.url.startsWith("https://synthetic-tv.invalid/")),
    "FB-002：失败条目不得贡献来源",
  );
});

test("FB-002：有效来源必须是绝对 HTTP(S) URL；非 HTTP(S) 的来源不得原样交给宿主", async (t) => {
  const s1 = makeSource(1);
  const s2 = makeSource(2);
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-a", "openai", "条目甲")],
    credentialRefs: refsFor("e-a"),
    steps: {
      "e-a": [
        stepSuccess({
          sources: [s1, { url: "javascript:void(0)", title: "坏来源甲" }, { url: "ftp://synthetic-host.invalid/x", title: "坏来源乙" }, s2],
        }),
      ],
    },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assertSearchResult(t, res); // 每条来源都必须是可解析的绝对 HTTP(S)
  const validUrls = res.sources.map((s) => s.url).filter((u) => u.startsWith("https://synthetic-host.invalid/"));
  assert.deepEqual(validUrls, [s1.url, s2.url], "FB-002：有效来源按供应商顺序保留");
});

test("FB-002：纯来源适配器（Bing RSS）的供应商正文不得作为通用 content", async (t) => {
  // oracle 假设：bing 为纯来源适配器（bing.md BING-001 只映射 link/title/description/pubDate）。
  const h = await chainHarness(t, CLAUSES, {
    entries: [makeEntry({ id: "e-bing", type: "bing", name: "条目甲", enabled: true })],
    steps: {
      "e-bing": [stepSuccess({ sources: makeSources(1), content: "供应商生成正文（不得透出）" })],
    },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assert.equal(res.sources.length, 1);
  assert.ok(
    !String(res.content ?? "").includes("供应商生成正文"),
    "FB-002：纯来源适配器的供应商生成正文不得作为通用 content",
  );
});
