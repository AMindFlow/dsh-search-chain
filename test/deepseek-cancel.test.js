// WP8 DeepSeek 取消与预算验收（fallback.md FB-003/FB-001/FB-005 单项超时；DSK-001「请求受 FB-003 约束」）。
// 全红：src/backends/deepseek.js 尚未实现，等待 WP8。预算/取消一律用受控时钟（helpers/clock.js），
// 不用真实定时器；真实计时仅作防挂起守卫。
// 覆盖：ctx.signal 预取消 → 零出站且拒绝；在途中止 → 出站 init.signal（单独或合并 signal，S5）随
//       ctx.signal 中止、假 fetch 观察取消、不重试、不 resolve；挂起被预算中止 → ENTRY_TIMEOUT 或
//       AbortError（S3/P8），且不归为凭据/额度/限流；拨钟任意时长后不再有第二次出站；
//       预算到期后迟到的成功响应不得改变结果（FB-003「迟到结果不得改变本次搜索」）。
// 待办：helpers/deepseek-oracle.js 头注 S1..S7；test/deepseek-pending.test.js P1..P8。
import test from "node:test";
import assert from "node:assert/strict";
import { ENTRY_CODES } from "./helpers/contract.js";
import { createControlledClock, flush } from "./helpers/clock.js";
import {
  DSK_BUDGET_MS,
  agenticOk,
  dsApiOk,
  endpointOf,
  hangFor,
  loadDeepseek,
  makeCtx,
  routeFor,
  settle,
  withGuard,
} from "./helpers/deepseek-oracle.js";

const AG = "deepseek-agentic-search";
const API = "deepseek-search";

/** 预算到期：受控时钟在 budgetMs 处中止信号（链级 FB-003 的复刻 seam）。 */
function budgetAbort(clock, budgetMs) {
  const ctrl = new AbortController();
  clock.setTimeout(() => ctrl.abort(new Error("合成条目预算到期")), budgetMs);
  return ctrl;
}

test("FB-003 预取消：ctx.signal 已中止 → 零出站且拒绝（两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `FB-003 预取消（${type}）`);
    const ctrl = new AbortController();
    ctrl.abort(new Error("合成宿主取消"));
    const { ctx, fetch } = makeCtx({ type, signal: ctrl.signal });
    routeFor(fetch, type, { status: 200, body: type === API ? dsApiOk([]) : agenticOk([]) });
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, false, `type=${type}：已中止的搜索不得返回结果`);
    assert.equal(fetch.count(), 0, `type=${type}：宿主已取消时不得再发出请求（FB-003「不得再请求」）`);
  }
});

test("FB-003 在途中止：出站 init.signal 随 ctx.signal 中止（单独或合并 signal，S5），fetch 被取消、拒绝、不重试（两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `FB-003 在途中止（${type}）`);
    const ctrl = new AbortController();
    const { ctx, fetch } = makeCtx({ type, signal: ctrl.signal });
    hangFor(fetch, type);
    const pending = settle(backend.search(ctx));
    await flush();
    assert.equal(fetch.count(), 1, `type=${type}：挂起期间应已发出唯一一次请求`);
    ctrl.abort(new Error("合成宿主取消"));
    const res = await withGuard(pending, `type=${type} 在途中止`);
    await flush();
    assert.equal(res.ok, false, `type=${type}：中止后不得 resolve`);
    assert.equal(fetch.count(), 1, `type=${type}：取消后不得再发起第二次请求（FB-003）`);
    const call = fetch.calls[0];
    assert.ok(call.signal, `type=${type}：出站 fetch 必须携带 signal（FB-003 取消在途操作）`);
    assert.equal(call.signal.aborted, true, `type=${type}：传给 fetch 的 signal（合并后）必须随 ctx.signal 中止（S5）`);
    assert.equal(call.aborted, true, `type=${type}：假 fetch 必须观察到取消`);
  }
});

test("FB-003 预算中止形状：挂起请求被预算中止 → ENTRY_TIMEOUT 或 AbortError（S3），不归凭据/额度/限流（两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `FB-003 预算中止（${type}）`);
    const clock = createControlledClock();
    const ctrl = budgetAbort(clock, DSK_BUDGET_MS);
    const { ctx, fetch } = makeCtx({ type, clock, signal: ctrl.signal, budgetMs: DSK_BUDGET_MS });
    hangFor(fetch, type);
    const pending = settle(backend.search(ctx));
    await flush();
    assert.equal(fetch.count(), 1, `type=${type}：预算到期前应已发出一次请求`);
    clock.advance(DSK_BUDGET_MS);
    const res = await withGuard(pending, `type=${type} 预算中止`);
    assert.equal(res.ok, false, `type=${type}：预算耗尽的挂起搜索不得 resolve`);
    const err = res.error;
    assert.ok(
      err?.code === ENTRY_CODES.TIMEOUT || err?.name === "AbortError",
      `预算中止须为 ENTRY_TIMEOUT 或 AbortError（S3），实际 code=${err?.code} name=${err?.name}`,
    );
    assert.ok(
      ![ENTRY_CODES.CREDENTIALS, ENTRY_CODES.QUOTA, ENTRY_CODES.RATE_LIMITED].includes(err?.code),
      "超时不得被归为凭据、额度或限流（FB-005 分类互斥）",
    );
  }
});

test("FB-003 中止后不重试：拨钟任意时长都不得再产生出站（两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `FB-003 中止后不重试（${type}）`);
    const clock = createControlledClock();
    const ctrl = budgetAbort(clock, DSK_BUDGET_MS);
    const { ctx, fetch } = makeCtx({ type, clock, signal: ctrl.signal, budgetMs: DSK_BUDGET_MS });
    hangFor(fetch, type);
    const pending = settle(backend.search(ctx));
    await flush();
    clock.advance(DSK_BUDGET_MS);
    await withGuard(pending, `type=${type} 中止后不重试`);
    clock.advance(60_000);
    await flush();
    assert.equal(fetch.count(), 1, `type=${type}：超时/取消后经过任意拨钟都不得再请求（FB-003）`);
  }
});

test("FB-003 迟到结果：预算到期后上游才返回的成功响应不得被采纳（两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `FB-003 迟到结果（${type}）`);
    const clock = createControlledClock();
    const ctrl = budgetAbort(clock, DSK_BUDGET_MS);
    const { ctx, fetch } = makeCtx({ type, clock, signal: ctrl.signal, budgetMs: DSK_BUDGET_MS });
    fetch.when(endpointOf(type)).responds({
      status: 200,
      body: type === API ? dsApiOk([]) : agenticOk([]),
      delayMs: DSK_BUDGET_MS + 10_000,
    });
    const pending = settle(backend.search(ctx));
    await flush();
    clock.advance(DSK_BUDGET_MS);
    clock.advance(10_000);
    const res = await withGuard(pending, `type=${type} 迟到结果`);
    assert.equal(res.ok, false, `type=${type}：预算到期后的迟到成功响应不得改变结果（FB-003）`);
  }
});
