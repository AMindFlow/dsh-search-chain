// 工作包 #86 · 多 key 池轮替 Oracle 骨架（POOL-006 池耗尽归因与轮替事件可见）。
// 规范文案要素（lead 审阅批准）：池耗尽 reason 含「全部 N 把 key 失败」；换 key 成功
// content 首行冠以「已使用第 N/M 把 key」。单 key（含 1 元池）失败不得出现池字样。
// attempts.pool 字段面为 Oracle 假设（见 budget 头注与 Oracle 文档歧义上报）。
// 日志轮替事件：假设 log(level, message, details) 中 message 含「轮替」且 details 含条目 id
// 与池内序号（事件数 = 实际换 key 次数）——命名属实现选择，同步义务在实现 PR。
import test from "node:test";
import assert from "node:assert/strict";
import { createSearchChain } from "../src/search.js";
import { createChainHarness } from "./helpers/chain-harness.js";
import { ENTRY_CODES } from "./helpers/contract.js";
import {
  assertNoPoolKeys,
  credentialSeedFor,
  makeIssuingBackend,
  poolKey,
  refName,
  refPoolOf,
  scriptAttempts,
} from "./helpers/pool-oracle-kit.js";

function poolHarness(letters) {
  const h = createChainHarness(createSearchChain, {
    entries: [{ id: "p", type: "openai", name: "池条目", enabled: true, credentialRefs: refPoolOf(letters) }],
    credentialRefs: credentialSeedFor(letters),
  });
  const issuing = makeIssuingBackend("openai");
  h.deps.backends.set("openai", issuing);
  return { h, issuing };
}

function singleRefHarness() {
  return createChainHarness(createSearchChain, {
    entries: [{ id: "s", type: "openai", name: "单引用", enabled: true, credentialRef: refName("A") }],
    credentialRefs: { [refName("A")]: poolKey("A") },
  });
}

test("POOL-006① 3 元池全败（401/429/402）：attempts 恰一条 + 逐 key 序号/分类码 + reason 含「全部 3 把 key 失败」", async () => {
  const { h } = poolHarness("ABC");
  scriptAttempts(h.fetchFn, { 1: 401, 2: 429, 3: 402 });
  const err = await h.runToError(h.search());
  const attempts = err.details.attempts.filter((a) => a.entryId === "p");
  assert.equal(attempts.length, 1, "池条目终态恰一条 attempts 记录");
  assert.equal(attempts[0].code, ENTRY_CODES.QUOTA, "终态归因 = 最后一把尝试的 FB-005 分类码");
  assert.match(attempts[0].reason, /全部\s*3\s*把\s*key\s*失败/, "池耗尽规范文案要素");
  const pool = attempts[0].pool;
  assert.ok(pool, "attempts 必须暴露 pool 逐 key 明细（Oracle 假设字段 pool）");
  assert.equal(pool.size, 3);
  assert.deepEqual(
    (pool.outcomes ?? []).map((o) => [o.index, o.code]),
    [[1, ENTRY_CODES.CREDENTIALS], [2, ENTRY_CODES.RATE_LIMITED], [3, ENTRY_CODES.QUOTA]],
    "逐 key 脱敏明细：池内序号（1 起）与 FB-005 分类码",
  );
});

test("POOL-006① 单 key 401 = v0.2.0 基准文案：无「全部 N 把」池字样，与池耗尽可区分", async () => {
  const h = singleRefHarness();
  const issuing = makeIssuingBackend("openai");
  h.deps.backends.set("openai", issuing);
  scriptAttempts(h.fetchFn, { 1: 401 });
  const err = await h.runToError(h.search());
  const attempt = err.details.attempts.find((a) => a.entryId === "s");
  assert.match(attempt.reason, /key 是否有效/, "单 key 基准 reason 与 v0.2.0 相同（FB-005 凭据类）");
  assert.doesNotMatch(attempt.reason, /全部\s*\d+\s*把/, "不得出现池耗尽字样");
});

test("POOL-006① 1 元池（credentialRefs 单元素）全败 = 单 key 语义：不得出现池字样", async () => {
  const { h } = poolHarness("A");
  scriptAttempts(h.fetchFn, { 1: 401 });
  const err = await h.runToError(h.search());
  const attempt = err.details.attempts.find((a) => a.entryId === "p");
  assert.equal(attempt.code, ENTRY_CODES.CREDENTIALS, "1 元池必须真实以该 key 出站失败（非缺 key 跳过）");
  assert.doesNotMatch(attempt.reason, /全部\s*\d+\s*把/, "1 元池等同单 key：reason 无池字样");
});

test("POOL-006② 换 key 命中成功：content 首行冠「已使用第 2/3 把 key」，第三把零出站", async () => {
  const { h } = poolHarness("ABC");
  scriptAttempts(h.fetchFn, { 1: 401, 2: "ok:1" });
  const value = await h.runToValue(h.search());
  const firstLine = String(value.content ?? "").split("\n")[0];
  assert.match(firstLine, /已使用第\s*2\/3\s*把\s*key/, "换 key 标注按 FB-002 同一渠道、冠首行");
  assert.equal(h.fetchFn.calls.length, 2, "成功后不得继续尝试第三把");
});

test("POOL-006③ 脱敏全表面：attempts/content/日志对合成 key 正则不可命中；轮替日志事件数 = 换 key 次数", async () => {
  const { h } = poolHarness("ABC");
  scriptAttempts(h.fetchFn, { 1: 401, 2: "ok:1" });
  const value = await h.runToValue(h.search());
  const surface = JSON.stringify({ result: value, logs: h.logCapture.entries });
  assertNoPoolKeys(assert, surface, ["A", "B", "C"], "成功路径全表面");

  const rotationEvents = h.logCapture.entries.filter((e) => JSON.stringify(e).includes("轮替"));
  assert.equal(rotationEvents.length, 1, "每次换 key 恰一条脱敏日志事件（本例换 1 次）");
  assert.match(JSON.stringify(rotationEvents[0]), /"p"/, "事件须定位条目 id");

  // 耗尽路径同样脱敏 + 事件数 = 2
  // oracle-skeleton-fix（lead 裁决 (b)）：与本用例 L87 同款解构——poolHarness 返回 { h, issuing }，
  // 原行未解构直接取 h2.fetchFn 恒为 undefined；"ABC" 位置参经 refPoolOf/credentialSeedFor
  // 展开为 3 元池（A/B/C），可观察语义与规格一致（首轮 1 条轮替事件、耗尽 2 条）。断言零改动。
  const { h: h2 } = poolHarness("ABC");
  scriptAttempts(h2.fetchFn, { 1: 401, 2: 429, 3: "ok:1" });
  await h2.runToValue(h2.search());
  assertNoPoolKeys(assert, `${h2.logCapture.text()}`, ["A", "B", "C"], "轮替日志");
  assert.equal(h2.logCapture.entries.filter((e) => JSON.stringify(e).includes("轮替")).length, 2, "两次换 key = 两条事件");
});
