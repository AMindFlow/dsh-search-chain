// WP11 Gemini 预算、取消与出站次数验收（FB-003 预算与取消；FB-001 宿主取消终止、每条目最多一次）。
//
// 条款：
//   FB-003 要求：条目到期须取消当前请求；宿主取消或总超时须取消在途操作且不得再请求；
//               无可用时间时不得发出请求；迟到结果不得改变本次搜索。
//   FB-001 要求：宿主取消须终止（不可降级）；每个条目最多提交一次查询。
//   FB-005 要求：单项超时归 ENTRY_TIMEOUT。
//
// 受控时钟：全部时间由 ctx.clock 注入的 controlled clock 拨动；本文件不依赖真实定时器。
// 出站 init.signal 须是 ctx.signal 与预算中止的合并信号（gemini-oracle.js 头注释，A6）。
//
// 红属预期：src/backends/gemini.js 尚未实现（WP11）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_ROUTE,
  groundedOutputs,
  newRig,
  startSearch,
  settle,
  expectRejected,
  expectCode,
  expectNotEntryCode,
  gemCalls,
  loadGeminiBackend,
} from "./helpers/gemini-oracle.js";
import { flush } from "./helpers/clock.js";
import { ENTRY_CODES } from "./helpers/contract.js";

test("FB-003/FB-005：预算按毫秒精确到期，到期中止在途请求、终态 ENTRY_TIMEOUT，之后不再出站", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-003 / FB-005");
  const rig = newRig({ budgetMs: 1000 });
  rig.fetch.when(GEMINI_ROUTE).hangs();

  const p = startSearch(backend, rig);
  await flush(3);
  assert.equal(rig.fetch.count(), 1, "挂起的请求应已发出一次");
  const [call] = gemCalls(rig.fetch);
  const signal = call.init?.signal;
  assert.ok(signal, "出站必须携带 init.signal（ctx.signal 与预算合并）");

  rig.clock.advance(999);
  await flush(3);
  assert.equal(signal.aborted, false, "预算未到（999ms）不得中止在途请求");

  rig.clock.advance(1);
  const outcome = await settle(rig, p);
  assert.equal(signal.aborted, true, "预算到期（1000ms）须中止 init.signal");
  const err = expectRejected(outcome, "预算到期");
  expectCode(err, ENTRY_CODES.TIMEOUT, "预算到期");

  rig.clock.advance(60_000);
  await flush(3);
  assert.equal(rig.fetch.count(), 1, "超时后不得再出站（FB-003）");
  assert.equal(rig.clock.invalidTimings.length, 0, "预算调度不得使用非正或非有限延时（FB-003 时间边界）");
});

test("FB-003/FB-005：预算到期时即便上游晚到，也以 ENTRY_TIMEOUT 结束，迟到结果不得成功返回", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-003 / FB-005");
  const rig = newRig({ budgetMs: 1000 });
  rig.fetch.when(GEMINI_ROUTE).responds({ delayMs: 5000, body: groundedOutputs() });

  const outcome = await settle(rig, startSearch(backend, rig));
  const err = expectRejected(outcome, "迟到结果");
  expectCode(err, ENTRY_CODES.TIMEOUT, "预算到期后的迟到结果");
  rig.clock.advance(10_000);
  await flush(3);
  assert.equal(rig.fetch.count(), 1, "迟到结果到达后仍不得重试（FB-001）");
});

test("FB-001/FB-003：宿主取消在途请求，中止 init.signal，终止为非条目分类（不可降级），之后不再出站", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-001 / FB-003");
  const rig = newRig({ budgetMs: 25_000 });
  rig.fetch.when(GEMINI_ROUTE).hangs();

  const p = startSearch(backend, rig);
  await flush(3);
  const [call] = gemCalls(rig.fetch);
  const signal = call.init?.signal;
  assert.ok(signal, "出站必须携带 init.signal");

  rig.ctl.abort();
  const outcome = await settle(rig, p);
  assert.equal(signal.aborted, true, "宿主取消须中止在途请求的 init.signal（FB-003）");
  const err = expectRejected(outcome, "宿主取消");
  expectNotEntryCode(err, "宿主取消");

  rig.clock.advance(60_000);
  await flush(3);
  assert.equal(rig.fetch.count(), 1, "宿主取消后不得再出站（FB-003）");
});

test("FB-003：预取消（ctx.signal 已中止）时零出站", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-003");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({ body: groundedOutputs() });
  rig.ctl.abort();

  const outcome = await settle(rig, startSearch(backend, rig));
  expectRejected(outcome, "预取消");
  assert.equal(rig.fetch.count(), 0, "预取消时不得发出任何请求（FB-003 无可用时间不得出站）");
});

test("FB-003：预算为 0 或负数（无可用时间）时零出站", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-003");
  for (const budgetMs of [0, -1]) {
    const rig = newRig({ budgetMs });
    rig.fetch.when(GEMINI_ROUTE).responds({ body: groundedOutputs() });
    const outcome = await settle(rig, startSearch(backend, rig));
    expectRejected(outcome, `budgetMs=${budgetMs}`);
    assert.equal(rig.fetch.count(), 0, `budgetMs=${budgetMs} 时不得发出请求（FB-003）`);
  }
});

test("FB-001：成功路径也只出站一次（不因结构或内容原因二次提交）", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-001");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({ body: groundedOutputs() });
  await settle(rig, startSearch(backend, rig));
  assert.equal(rig.fetch.count(), 1, "每个条目最多向其供应商提交一次查询（FB-001）");
});
