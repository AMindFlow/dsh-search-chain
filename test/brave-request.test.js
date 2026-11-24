// WP10 Brave 验收 — brave.md BRV-001 要求 1（请求与来源）+ 验收中的查询编码、鉴权头、结果过滤、单次请求、上限。
// 覆盖：固定端点与单次 GET；X-Subscription-Token 鉴权；q 编码；result_filter / text_decorations 固定值；
//       count = min(宿主结果数, 20)，未提供则省略且无占位参数；600 字符 / 75 词上限（边界含）与零出站；
//       缺 key 零出站（FB-001）；链级：超限条目零出站且后继条目收到完整查询。
// 红属预期：src/backends/brave.js（WP10）与 src/search.js（WP5）缺失时经 impl.js 报「等待实现」。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import {
  BRAVE_ENDPOINT,
  BRAVE_KEY,
  BRAVE_MAX_CHARS,
  BRAVE_MAX_WORDS,
  BRAVE_MAX_COUNT,
  BRAVE_QUERY,
  loadBraveBackend,
  loadSearchModule,
  makeBraveCtx,
  routeBrave,
  braveOk,
  braveResult,
  guard,
  rejectionOf,
  onlyCall,
  queryParamsOf,
  wordsOf,
} from "./helpers/brave-oracle.js";
import { createChainHarness } from "./helpers/chain-harness.js";
import { stepSuccess } from "./helpers/fake-backend.js";
import { SYNTHETIC_KEY } from "./helpers/fake-fetch.js";

const OK_BODY = braveOk([braveResult(1)]);

test("BRV-001 要求1：对固定端点只发一次 GET（origin+pathname 精确相等，无 fragment，无内嵌凭据）", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求1 端点");
  const { ctx, fetch } = makeBraveCtx({ maxResults: 5 });
  routeBrave(fetch, { status: 200, body: OK_BODY });
  await guard(backend.search(ctx), "端点");
  const call = onlyCall(fetch, "BRV-001 要求1");
  const u = new URL(call.url);
  assert.equal(call.method, "GET", "BRV-001：须为 GET");
  assert.equal(u.origin + u.pathname, BRAVE_ENDPOINT, "BRV-001：端点须为规格固定 URL");
  assert.equal(u.hash, "", "不得带 fragment");
  assert.equal(u.username + u.password, "", "URL 不得带认证信息（CFG-003）");
});

test("BRV-001 要求1：鉴权头为 X-Subscription-Token，值即条目 key；不得另用 Authorization 头", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求1 鉴权");
  const { ctx, fetch } = makeBraveCtx({ maxResults: 5 });
  routeBrave(fetch, { status: 200, body: OK_BODY });
  await guard(backend.search(ctx), "鉴权");
  const call = onlyCall(fetch, "BRV-001 要求1 鉴权");
  assert.equal(call.headers["x-subscription-token"], BRAVE_KEY, "BRV-001：须以 X-Subscription-Token 鉴权");
  assert.equal(call.headers.authorization, undefined, "BRV-001：Brave 鉴权不得使用 Authorization 头");
  assert.ok(!call.url.includes(BRAVE_KEY), "key 不得出现在查询串中（CFG-003）");
});

const QUERY_TRICKY = '合成 查询 a&b=c #frag +plus %25 "quoted"';

test("BRV-001 要求1：q 经标准编码后可精确还原（空格、CJK、&、=、#、+、%、引号）", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求1 查询编码");
  const { ctx, fetch } = makeBraveCtx({ query: QUERY_TRICKY });
  routeBrave(fetch, { status: 200, body: OK_BODY });
  await guard(backend.search(ctx), "查询编码");
  const call = onlyCall(fetch, "BRV-001 要求1 查询编码");
  assert.equal(queryParamsOf(call).get("q"), QUERY_TRICKY, "BRV-001：发送当前查询 q，须可精确还原");
});

test("BRV-001 要求1：固定过滤参数 result_filter=web、text_decorations=false（精确值）", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求1 过滤");
  const { ctx, fetch } = makeBraveCtx({ maxResults: 5 });
  routeBrave(fetch, { status: 200, body: OK_BODY });
  await guard(backend.search(ctx), "过滤");
  const params = queryParamsOf(onlyCall(fetch, "BRV-001 要求1 过滤"));
  assert.equal(params.get("result_filter"), "web", "BRV-001：result_filter 须为 web");
  assert.equal(params.get("text_decorations"), "false", "BRV-001：text_decorations 须为 false");
});

for (const [maxResults, want] of [
  [1, "1"],
  [3, "3"],
  [BRAVE_MAX_COUNT, "20"],
  [50, "20"],
]) {
  test(`BRV-001 要求1：宿主结果数 maxResults=${maxResults} 时 count=${want}（取其与 20 中较小值）`, async (t) => {
    const backend = await loadBraveBackend(t, `BRV-001 要求1 上限 ${maxResults}`);
    const { ctx, fetch } = makeBraveCtx({ maxResults });
    routeBrave(fetch, { status: 200, body: OK_BODY });
    await guard(backend.search(ctx), `count ${maxResults}`);
    const params = queryParamsOf(onlyCall(fetch, `BRV-001 要求1 count ${maxResults}`));
    assert.equal(params.get("count"), want, `BRV-001：count 须为 min(${maxResults}, ${BRAVE_MAX_COUNT}) = ${want}`);
  });
}

test("BRV-001 要求1：宿主未提供结果数时省略 count，且不出现 null/undefined/空值参数", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求1 省略");
  const { ctx, fetch } = makeBraveCtx();
  assert.equal("maxResults" in ctx, false, "前置：未提供结果数");
  routeBrave(fetch, { status: 200, body: OK_BODY });
  await guard(backend.search(ctx), "省略");
  const params = queryParamsOf(onlyCall(fetch, "BRV-001 要求1 省略"));
  assert.equal(params.has("count"), false, "未提供结果数时须省略 count（未指定参数省略而非 null）");
  for (const [k, v] of params) {
    assert.ok(v !== "" && v !== "null" && v !== "undefined", `参数 ${k} 不得为占位值（实际：${JSON.stringify(v)}）`);
  }
});

test(`BRV-001 要求1：${BRAVE_MAX_CHARS} 字符恰好为上限，可发出（边界含）`, async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求1 字符边界");
  const q = "a".repeat(BRAVE_MAX_CHARS);
  const { ctx, fetch } = makeBraveCtx({ query: q });
  routeBrave(fetch, { status: 200, body: OK_BODY });
  await guard(backend.search(ctx), "字符边界");
  assert.equal(queryParamsOf(onlyCall(fetch, "字符边界")).get("q"), q, "恰好 600 字符时查询须完整发出");
});

test(`BRV-001 要求1：${BRAVE_MAX_CHARS + 1} 字符超过供应商上限 → ENTRY_CHANNEL_LIMIT，零出站`, async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求1 字符超限");
  const { ctx, fetch } = makeBraveCtx({ query: "a".repeat(BRAVE_MAX_CHARS + 1) });
  routeBrave(fetch, { status: 200, body: OK_BODY }); // 若误发出会命中此路由，由 count 断言暴露
  const err = await rejectionOf(backend.search(ctx), "字符超限");
  assert.equal(err?.code, C.ENTRY_CODES.CHANNEL_LIMIT, "BRV-001：超出供应商查询长度须报告参数限制（通道参数限制）");
  assert.equal(fetch.count(), 0, "BRV-001：超出供应商查询长度时 Brave 无请求");
});

test(`BRV-001 要求1：${BRAVE_MAX_WORDS} 词恰好为上限，可发出（边界含）`, async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求1 词数边界");
  const q = wordsOf(BRAVE_MAX_WORDS);
  const { ctx, fetch } = makeBraveCtx({ query: q });
  routeBrave(fetch, { status: 200, body: OK_BODY });
  await guard(backend.search(ctx), "词数边界");
  assert.equal(queryParamsOf(onlyCall(fetch, "词数边界")).get("q"), q, "恰好 75 词时查询须完整发出");
});

test(`BRV-001 要求1：${BRAVE_MAX_WORDS + 1} 词超过供应商上限 → ENTRY_CHANNEL_LIMIT，零出站`, async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001 要求1 词数超限");
  const { ctx, fetch } = makeBraveCtx({ query: wordsOf(BRAVE_MAX_WORDS + 1) });
  routeBrave(fetch, { status: 200, body: OK_BODY });
  const err = await rejectionOf(backend.search(ctx), "词数超限");
  assert.equal(err?.code, C.ENTRY_CODES.CHANNEL_LIMIT, "BRV-001：超过 75 词须报告参数限制");
  assert.equal(fetch.count(), 0, "BRV-001：超过词数上限时 Brave 无请求");
});

test("FB-001 + BRV-001 要求1：条目缺 key 时零出站并拒绝（缺必要 key 的条目不提交查询）", async (t) => {
  const backend = await loadBraveBackend(t, "FB-001 缺 key");
  const { ctx, fetch } = makeBraveCtx({ key: undefined });
  routeBrave(fetch, { status: 200, body: OK_BODY });
  const err = await rejectionOf(backend.search(ctx), "缺 key");
  assert.equal(fetch.count(), 0, "FB-001：缺 key 时出站请求数为零");
  assert.ok(err && typeof err.message === "string" && err.message.length > 0, "拒绝须给出可操作原因（FB-004）");
});

// ─── 链级：超限条目零出站，后继条目收到完整未截断查询 ─────────────────────────────

test("BRV-001 要求1 + FB-001：超限查询使 Brave 零出站，后继条目收到完整未截断的查询", async (t) => {
  const braveBackend = await loadBraveBackend(t, "BRV-001 要求1 链级超限");
  const { createSearchChain } = await loadSearchModule(t, "BRV-001 要求1 链级超限");
  const longQuery = "a".repeat(BRAVE_MAX_CHARS + 1);
  const h = createChainHarness(createSearchChain, {
    entries: [
      C.makeEntry({ id: "brave-1", type: "brave", name: "合成 Brave 一" }),
      C.makeEntry({ id: "openai-2", type: "openai", name: "合成 OpenAI 二" }),
    ],
    env: { BRAVE_API_KEY: BRAVE_KEY, OPENAI_API_KEY: SYNTHETIC_KEY("openai") },
    steps: { "openai-2": [stepSuccess({ sources: C.makeSources(1) })] },
  });
  h.deps.backends.set("brave", braveBackend);
  routeBrave(h.fetchFn, { status: 200, body: OK_BODY });
  const result = await h.runToValue(h.search({ query: longQuery }), 60000);
  assert.equal(h.fetchFn.count(BRAVE_ENDPOINT), 0, "BRV-001：超限查询时 Brave 无请求");
  assert.equal(h.ctxFor("openai-2")?.query, longQuery, "后继条目须收到完整查询，不得被截断（BRV-001）");
  C.assertSearchResult(t, result, { sources: C.makeSources(1) });
});

test("FB-001 + BRV-001：Brave 条目缺 key 时被链跳过且零出站，后继条目接管", async (t) => {
  const braveBackend = await loadBraveBackend(t, "FB-001 链级缺 key");
  const { createSearchChain } = await loadSearchModule(t, "FB-001 链级缺 key");
  const h = createChainHarness(createSearchChain, {
    entries: [
      C.makeEntry({ id: "brave-1", type: "brave", name: "合成 Brave 无 key" }),
      C.makeEntry({ id: "openai-2", type: "openai", name: "合成 OpenAI 二" }),
    ],
    env: { OPENAI_API_KEY: SYNTHETIC_KEY("openai") },
    steps: { "openai-2": [stepSuccess({ sources: C.makeSources(1) })] },
  });
  h.deps.backends.set("brave", braveBackend);
  routeBrave(h.fetchFn, { status: 200, body: OK_BODY });
  const result = await h.runToValue(h.search({ query: BRAVE_QUERY }), 60000);
  assert.equal(h.fetchFn.count(BRAVE_ENDPOINT), 0, "FB-001：缺 key 的 Brave 条目出站请求数为零");
  C.assertSearchResult(t, result, { sources: C.makeSources(1), entryName: "合成 OpenAI 二" });
});
