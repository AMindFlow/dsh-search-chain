// WP5 验收 — FB-003（预算与取消）。全部在受控时钟上运行（helpers/clock.js），不依赖真实等待。
// 覆盖：条目预算 = floor(剩余 / 该条目及之后的启用条目数)（含尚未检查凭据的启用条目）；
//       跳过/提前结束的余量流向后续条目；无可用时间不发请求；条目超时中止 signal 后继续；
//       迟到结果被忽略；总预算耗尽终止；外部 abort 立即终止整链且不再出站。
// 实现模块：src/search.js（createSearchChain）。尚未实现时全部为红，不得改为 skip。
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_QUERY } from "./helpers/chain-harness.js";
import { stepSuccess, stepFail, stepHang, stepLate } from "./helpers/fake-backend.js";
import { ENTRY_CODES, CHAIN_CODES, assertSearchResult, assertWebError, makeEntry, makeSources, makeSource } from "./helpers/contract.js";
import { flush } from "./helpers/clock.js";
import { chainHarness, keyedEntry, refsFor } from "./helpers/search-oracle.js";

const CLAUSES = "FB-003";

test("FB-003：条目预算 = floor(剩余 / 该条目及之后启用条目数)；含尚未检查凭据的启用条目；跳过余量流向后续", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    timeoutMs: 10001,
    entries: [
      keyedEntry("e-a", "openai", "条目甲"),
      makeEntry({ id: "e-b", type: "tavily", name: "无钥条目乙", enabled: true }), // 启用但缺 key
      keyedEntry("e-c", "exa", "条目丙"),
      keyedEntry("e-d", "brave", "条目丁"),
    ],
    credentialRefs: refsFor("e-a", "e-c", "e-d"),
    steps: {
      "e-a": [stepFail({ code: ENTRY_CODES.NETWORK })],
      "e-c": [stepFail({ code: ENTRY_CODES.NETWORK })],
      "e-d": [stepSuccess({ sources: makeSources(1) })],
    },
  });
  await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  // e-a：启用条目共 4 个（甲、乙、丙、丁），floor(10001/4)=2500
  assert.equal(h.ctxFor("e-a").budgetMs, 2500, "FB-003：首条预算按启用条目数 4（含缺 key 的乙）分配并向下取整");
  // e-a 立即失败，乙被跳过；丙的预算按剩余 10001 与 丙、丁 两条分配 → floor(10001/2)=5000
  assert.equal(h.ctxFor("e-c").budgetMs, 5000, "FB-003：前条跳过或失败的余量须分配给后续条目");
  // 丙立即失败，只剩丁 → 全部剩余 10001
  assert.equal(h.ctxFor("e-d").budgetMs, 10001, "FB-003：最后一个条目获得全部剩余预算");
  assert.equal(h.executionCount("e-b"), 0, "FB-001：缺 key 的乙不得出站");
});

test("FB-003：前条消耗的时间从剩余总预算中扣除，后续条目据此分配", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    timeoutMs: 9000,
    entries: [keyedEntry("e-a", "openai", "条目甲"), keyedEntry("e-b", "tavily", "条目乙")],
    credentialRefs: refsFor("e-a", "e-b"),
    steps: {
      "e-a": [stepFail({ code: ENTRY_CODES.NETWORK, consumeMs: 3000 })],
      "e-b": [stepSuccess({ sources: makeSources(1) })],
    },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assertSearchResult(t, res, { sources: makeSources(1), entryName: "条目乙" });
  assert.equal(h.ctxFor("e-a").budgetMs, 4500, "FB-003：首条预算 floor(9000/2)=4500");
  assert.equal(h.ctxFor("e-b").budgetMs, 6000, "FB-003：首条耗时 3000ms 后，剩余 6000 全部给末条");
});

test("FB-003：条目超时须中止该条目 signal，剩余预算允许时继续下一条", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    timeoutMs: 10000,
    entries: [keyedEntry("e-a", "openai", "条目甲"), keyedEntry("e-b", "tavily", "条目乙")],
    credentialRefs: refsFor("e-a", "e-b"),
    steps: {
      "e-a": [stepHang()],
      "e-b": [stepSuccess({ sources: makeSources(1) })],
    },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assertSearchResult(t, res, { sources: makeSources(1), entryName: "条目乙" });
  assert.equal(h.ctxFor("e-a").budgetMs, 5000, "FB-003：首条预算 floor(10000/2)=5000");
  assert.equal(h.ctxFor("e-a").signal?.aborted, true, "FB-003：条目到期须取消其在途请求（signal 必须被中止）");
  const [a, b] = h.executions();
  assert.equal(b.at - a.at, 5000, "FB-003：条目到期后按剩余预算继续，下一条于超时时刻开始");
  assert.equal(h.ctxFor("e-b").budgetMs, 5000, "FB-003：超时后末条获得剩余 5000ms");
});

test("FB-003：总预算耗尽且无结果 → CHAIN_CODES.BUDGET_EXHAUSTED，尝试按序附超时原因", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    timeoutMs: 10000,
    entries: [keyedEntry("e-a", "openai", "条目甲"), keyedEntry("e-b", "tavily", "条目乙")],
    credentialRefs: refsFor("e-a", "e-b"),
    steps: { "e-a": [stepHang()], "e-b": [stepHang()] },
  });
  const start = h.clock.now();
  const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));
  assertWebError(err, {
    code: CHAIN_CODES.BUDGET_EXHAUSTED,
    attempts: [
      { entryId: "e-a", code: ENTRY_CODES.TIMEOUT },
      { entryId: "e-b", code: ENTRY_CODES.TIMEOUT },
    ],
  });
  assert.equal(h.clock.now() - start, 10000, "FB-003：总超时须在 timeoutMs 整处终止整链");
  assert.equal(h.executionCount(), 2, "FB-003：总预算耗尽后不得再发起请求");
});

test("FB-003：无可用时间时不得发出请求（预算为 0 的条目不出站，余量给后续条目）", async (t) => {
  // timeoutMs=1，两条启用条目：首条预算 floor(1/2)=0 → 不得出站；末条获得剩余 1ms。
  const h = await chainHarness(t, CLAUSES, {
    timeoutMs: 1,
    entries: [keyedEntry("e-a", "openai", "条目甲"), keyedEntry("e-b", "tavily", "条目乙")],
    credentialRefs: refsFor("e-a", "e-b"),
    steps: {
      "e-a": [stepSuccess({ sources: makeSources(1, "https://synthetic-a.invalid/doc") })],
      "e-b": [stepSuccess({ sources: makeSources(1, "https://synthetic-b.invalid/doc") })],
    },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assert.equal(h.executionCount("e-a"), 0, "FB-003：预算为 0 的条目不得发出请求");
  assert.equal(h.ctxFor("e-b").budgetMs, 1, "FB-003：首条未出站，余量 1ms 分配给末条");
  assert.ok(res.sources[0].url.startsWith("https://synthetic-b.invalid/"), "FB-003：结果来自实际获得预算的末条");
});

test("FB-003：迟到结果被忽略且不污染结果（前条超时后 resolve 的来源不得出现）", async (t) => {
  const late = makeSource(9, "https://synthetic-late.invalid/doc");
  const ok = makeSources(1, "https://synthetic-ok.invalid/doc");
  const h = await chainHarness(t, CLAUSES, {
    timeoutMs: 10000,
    entries: [keyedEntry("e-a", "openai", "条目甲"), keyedEntry("e-b", "tavily", "条目乙")],
    credentialRefs: refsFor("e-a", "e-b"),
    steps: {
      "e-a": [stepLate({ sources: [late], resolveAfterMs: 7000 })], // 超过 A 的 5000ms 预算后才 resolve
      "e-b": [stepSuccess({ sources: ok })],
    },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assertSearchResult(t, res, { sources: ok, truncated: false, entryName: "条目乙" });
  const snapshot = JSON.stringify(res);
  h.clock.advance(3000); // 越过迟到结果的解析时刻（8000ms），确保其已真正 resolve
  await flush(3);
  assert.equal(JSON.stringify(res), snapshot, "FB-003：迟到的 resolve 不得改变已返回的结果");
  assert.ok(!JSON.stringify(res).includes(late.url), "FB-003：超时条目的迟到来源不得进入结果");
});

test("FB-003：唯一条目超时后迟到结果不得进入终态错误细节（失败终态）", async (t) => {
  const late = makeSource(8, "https://synthetic-late2.invalid/doc");
  const h = await chainHarness(t, CLAUSES, {
    timeoutMs: 10000,
    entries: [keyedEntry("e-a", "openai", "条目甲"), keyedEntry("e-b", "tavily", "条目乙")],
    credentialRefs: refsFor("e-a", "e-b"),
    steps: {
      "e-a": [stepLate({ sources: [late], resolveAfterMs: 7000 })],
      "e-b": [stepFail({ code: ENTRY_CODES.NETWORK })],
    },
  });
  const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));
  assertWebError(err, {
    code: CHAIN_CODES.UPSTREAM_FAILURES,
    attempts: [
      { entryId: "e-a", code: ENTRY_CODES.TIMEOUT },
      { entryId: "e-b", code: ENTRY_CODES.NETWORK },
    ],
  });
  const snapshot = JSON.stringify(err.details);
  h.clock.advance(3000);
  await flush(3);
  assert.equal(JSON.stringify(err.details), snapshot, "FB-003：迟到结果不得改写终态错误细节");
  assert.ok(!JSON.stringify(err).includes(late.url), "FB-003：迟到来源不得进入终态错误");
});

test("FB-003：外部 abort 立即终止整链，在途条目 signal 被中止，之后不再出站", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    timeoutMs: 25000,
    entries: [keyedEntry("e-a", "openai", "条目甲"), keyedEntry("e-b", "tavily", "条目乙")],
    credentialRefs: refsFor("e-a", "e-b"),
    steps: {
      "e-a": [stepHang()],
      "e-b": [stepSuccess({ sources: makeSources(1) })],
    },
  });
  const ac = new AbortController();
  const p = h.search({ query: DEFAULT_QUERY }, ac.signal);
  await flush(2);
  h.clock.advance(1000); // e-a 仍在途
  ac.abort();
  const outcome = await h.runUntilSettled(p);
  assert.equal(outcome.ok, false, "FB-003：宿主取消须使搜索以拒绝结束，不得返回结果");
  assert.equal(h.ctxFor("e-a").signal?.aborted, true, "FB-003：取消须传播到在途条目的 signal");
  assert.equal(h.executionCount("e-b"), 0, "FB-003：宿主取消后不得开始后续条目");
  const requestsAtCancel = h.fetchFn.count();
  h.clock.advance(30000);
  await flush(3);
  assert.equal(h.executionCount("e-b"), 0, "FB-003：取消后出站请求数不再增加");
  assert.equal(h.fetchFn.count(), requestsAtCancel, "FB-003：取消后不得再发出网络请求");
});
