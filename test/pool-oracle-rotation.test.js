// 工作包 #86 · 多 key 池轮替 Oracle 骨架（POOL-004 触发集与顺序）。
// 依据：docs/specs/draft/key-pool.md POOL-004 + FB-005 分类 + lead 审阅批准（池上限 8）。
// 观测面：fake-fetch 出站计数与鉴权头用的是哪把 key、条目执行记录（每把 key 至多一次）、
//         FB-001/FB-005 降级与终止语义。实现前跑红属预期。
import test from "node:test";
import assert from "node:assert/strict";
import { createSearchChain } from "../src/search.js";
import { createChainHarness } from "./helpers/chain-harness.js";
import { stepSuccess } from "./helpers/fake-backend.js";
import { ENTRY_CODES } from "./helpers/contract.js";
import {
  assertNoPoolKeys,
  credentialSeedFor,
  makeIssuingBackend,
  poolKey,
  refName,
  refPoolOf,
  scriptAttempts,
  SYNTH_SOURCE,
} from "./helpers/pool-oracle-kit.js";

/**
 * 池条目链测试台：openai 类型换成「会真实出站」薄后端（每把 key 一次提交），
 * 其余类型走脚本后端。credentialRefs 数组透传进已保存快照（POOL-001 通过后语义）。
 */
// oracle-skeleton-fix（lead 裁决 (b)）：helper 参数补 `= {}` 默认——POOL-004① 无参调用，
// 原对象模式解构 undefined 恒抛 TypeError，用例不可通过；断言零改动。
function poolHarness({ letters = "AB", timeoutMs, extraEntries = [], steps = {}, env = {}, seedExtra = {} } = {}) {
  const entries = [
    { id: "p", type: "openai", name: "池条目", enabled: true, credentialRefs: refPoolOf(letters) },
    ...extraEntries,
  ];
  const h = createChainHarness(createSearchChain, {
    entries,
    timeoutMs,
    steps,
    env,
    credentialRefs: { ...credentialSeedFor(letters), ...seedExtra },
  });
  const issuing = makeIssuingBackend("openai");
  h.deps.backends.set("openai", issuing);
  return { h, issuing };
}

const authOf = (call) => call.headers.authorization;
const keysUsed = (issuing) => issuing.calls.map((c) => c.key);

test("POOL-004① 首 key 401 次 key 200：出站恰 2 次，成功结果来自次 key 的鉴权头", async () => {
  const { h, issuing } = poolHarness();
  scriptAttempts(h.fetchFn, { 1: 401, 2: "ok:2" });
  const value = await h.runToValue(h.search());
  assert.equal(h.fetchFn.calls.length, 2, "该供应商出站恰 2 次");
  assert.equal(authOf(h.fetchFn.calls[0]), `Bearer ${poolKey("A")}`, "首把必须是池头 key A");
  assert.equal(authOf(h.fetchFn.calls[1]), `Bearer ${poolKey("B")}`, "重试必须用池序下一把 key B");
  assert.equal(value.sources.length, 2, "成功结果来自次 key");
  assert.deepEqual(keysUsed(issuing), [poolKey("A"), poolKey("B")]);
});

test("POOL-004②③ 429 / 402 触发集：同 401 换 key 且成功", async () => {
  for (const status of [429, 402]) {
    const { h } = poolHarness({ letters: "AB" });
    scriptAttempts(h.fetchFn, { 1: status, 2: "ok:1" });
    const value = await h.runToValue(h.search());
    assert.equal(h.fetchFn.calls.length, 2, `${status} 应触发换 key，出站恰 2 次`);
    assert.equal(value.sources.length, 1);
  }
});

test("POOL-004④ 首 key 网络失败：不换 key，出站恰 1 次，按 FB-005 归 NETWORK 降级", async () => {
  const { h, issuing } = poolHarness({ letters: "AB" });
  scriptAttempts(h.fetchFn, { 1: "network" });
  const err = await h.runToError(h.search());
  assert.equal(h.fetchFn.calls.length, 1, "网络类失败不得换 key 重试");
  assert.equal(err.details.attempts[0].code, ENTRY_CODES.NETWORK);
  assert.ok(!keysUsed(issuing).includes(poolKey("B")), "次 key 不得被尝试");
});

test("POOL-004⑤ 明确空结果：不换 key、按 FB-001 继续下一条（非池耗尽）", async () => {
  const { h } = poolHarness({
    letters: "AB",
    extraEntries: [{ id: "b", type: "bing", name: "Bing 兜底", enabled: true }],
    steps: { b: [stepSuccess({ sources: [SYNTH_SOURCE(99)] })] },
  });
  scriptAttempts(h.fetchFn, { 1: "empty" });
  const value = await h.runToValue(h.search());
  assert.equal(h.fetchFn.calls.length, 1, "空结果不得再换 key");
  assert.equal(value.sources[0].url, SYNTH_SOURCE(99).url, "结果按 FB-001 由下一条目接管");
});

test("POOL-004 空结果停止轮次（2 元池：key2 不接空结果继续）", async () => {
  const { h } = poolHarness({
    letters: "ABC",
    extraEntries: [{ id: "b", type: "bing", name: "Bing 兜底", enabled: true }],
    steps: { b: [stepSuccess({ sources: [SYNTH_SOURCE(99)] })] },
  });
  scriptAttempts(h.fetchFn, { 1: 401, 2: "empty" });
  await h.runToValue(h.search());
  assert.equal(h.fetchFn.calls.length, 2, "轮替止于空结果：C 不得被尝试");
  assert.equal(authOf(h.fetchFn.calls[1]), `Bearer ${poolKey("B")}`);
});

test("POOL-004⑥ 两把全 401：出站 = 候选数、每把恰一次、无第三轮", async () => {
  const { h, issuing } = poolHarness({ letters: "AB" });
  scriptAttempts(h.fetchFn, { 1: 401, 2: 401 });
  const err = await h.runToError(h.search());
  assert.equal(h.fetchFn.calls.length, 2);
  assert.deepEqual(h.fetchFn.calls.map(authOf), [`Bearer ${poolKey("A")}`, `Bearer ${poolKey("B")}`], "每把 key 恰一次");
  assert.equal(issuing.callCount("p"), 2, "无二次轮转");
  assert.equal(err.details.attempts.length, 1, "条目终态仍是一条失败记录");
});

test("POOL-004⑦ 内容策略拒绝：零轮替、整链终止（FB-001 口径）", async () => {
  const { h } = poolHarness({
    letters: "AB",
    extraEntries: [{ id: "b", type: "bing", name: "Bing 兜底", enabled: true }],
    steps: { b: [stepSuccess({ sources: [SYNTH_SOURCE(99)] })] },
  });
  scriptAttempts(h.fetchFn, { 1: "policy" });
  const err = await h.runToError(h.search());
  assert.equal(h.fetchFn.calls.length, 1, "内容策略前后均不得条目内重试");
  assert.equal(err.code, "CHAIN_CONTENT_POLICY");
  assert.equal(h.backend("bing").callCount("b"), 0, "终止整链，不得降级下一条目");
});

test("POOL-004 起始恒为池头：同进程连续两次查询，第二次仍从第一把开始", async () => {
  const { h } = poolHarness({ letters: "AB" });
  // 第一次：A 失败 B 成功（若实现记忆偏移，第二次起点会是 B）
  scriptAttempts(h.fetchFn, { 1: 401, 2: "ok:1", 3: 401, 4: "ok:1" });
  await h.runToValue(h.search());
  h.fetchFn.calls.length = 0; // 清出站记录，聚焦第二次查询
  await h.runToValue(h.search());
  assert.equal(authOf(h.fetchFn.calls[0]), `Bearer ${poolKey("A")}`, "第二次查询必须重新从池头开始（无跨查询偏移）");
});

test("POOL-004 解析未命中的引用不占轮次：absent 项直接跳过，空 key 零出站", async () => {
  // 池 = [absent X, 命中 B]：首次出站必须用 B，且不得出现空 Authorization 的提交
  const { h } = poolHarness({ letters: "B" });
  h.savedConfig().entries[0].credentialRefs = [refName("X"), refName("B")]; // X 未在凭据服务 seed
  scriptAttempts(h.fetchFn, { 1: "ok:1" });
  await h.runToValue(h.search());
  assert.equal(h.fetchFn.calls.length, 1);
  assert.equal(authOf(h.fetchFn.calls[0]), `Bearer ${poolKey("B")}`, "未命中引用不得产生一次「空 key 提交」");
});

test("POOL-004 安全面：轮替全程日志无 key 明文", async () => {
  const { h } = poolHarness({ letters: "AB" });
  scriptAttempts(h.fetchFn, { 1: 401, 2: "ok:1" });
  await h.runToValue(h.search());
  assertNoPoolKeys(assert, h.logCapture.text(), ["A", "B"], "日志");
});
