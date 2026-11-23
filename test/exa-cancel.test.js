// EXA-001 取消与超时透传验收（依据 fallback.md FB-001 宿主取消、FB-003 预算与取消、FB-005 单项超时）。
// 全红：等待 WP9 实现 src/backends/exa.js。预算时钟统一使用受控时钟（helpers/clock.js），不依赖真实等待。
// 覆盖：ctx.signal 预先中止 → 零出站；在途中止 → 取消 fetch 且不再重试；
//       预算到期（受控时钟拨动）→ 抛错而非 resolve，错误形状为 ENTRY_TIMEOUT 或 AbortError（TODO-EXA-9）；
//       中止后迟到的成功响应不得改变结果（FB-003「迟到结果不得改变本次搜索」）。
// 待办见 helpers/exa-oracle.js 文件头（TODO-EXA-9）。
import test from "node:test";
import assert from "node:assert/strict";
import { ENTRY_CODES } from "./helpers/contract.js";
import { flush, createControlledClock } from "./helpers/clock.js";
import {
  EXA_BUDGET_MS,
  hangExa,
  loadExaBackend,
  makeExaCtx,
  routeExa,
  settle,
  exaOk,
  exaResult,
} from "./helpers/exa-oracle.js";

const CLAUSE = "EXA-001 取消与超时";

test("FB-001/FB-003 取消：ctx.signal 预先中止时零出站且拒绝", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const ctrl = new AbortController();
  ctrl.abort(new Error("合成宿主取消"));
  const { ctx, fetch } = makeExaCtx({ signal: ctrl.signal });
  routeExa(fetch, { status: 200, body: exaOk([exaResult(1)]) });

  const res = await settle(exa.search(ctx));

  assert.equal(res.ok, false, "已中止的搜索不得返回结果");
  assert.equal(fetch.count(), 0, "宿主已取消时不得再发出请求（FB-003「不得再请求」）");
});

test("FB-003 取消：在途请求时 ctx.signal 中止 → 取消 fetch、拒绝、且不重试", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const ctrl = new AbortController();
  const { ctx, fetch } = makeExaCtx({ signal: ctrl.signal });
  hangExa(fetch);

  const pending = settle(exa.search(ctx));
  await flush();
  assert.equal(fetch.count(), 1, "挂起期间应已发出唯一一次请求");

  ctrl.abort(new Error("合成宿主取消"));
  const res = await pending;
  await flush();

  assert.equal(res.ok, false, "中止后不得 resolve");
  assert.equal(fetch.count(), 1, "取消后不得再发起第二次请求（FB-003）");
  const call = fetch.calls[0];
  assert.ok(call.signal, "出站请求必须携带 signal，以便取消在途操作");
  assert.equal(call.signal.aborted, true, "传给 fetch 的 signal 必须随 ctx.signal 中止（FB-003 取消在途操作）");
  assert.equal(call.aborted, true, "假 fetch 必须观察到取消");
});

test("FB-003 预算超时：受控时钟拨到 budgetMs → 抛错而非结果；错误为 ENTRY_TIMEOUT 或 AbortError（TODO-EXA-9）", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const clock = createControlledClock();
  const ctrl = new AbortController();
  clock.setTimeout(() => ctrl.abort(new Error("合成条目预算到期")), EXA_BUDGET_MS);
  const { ctx, fetch } = makeExaCtx({ clock, signal: ctrl.signal, budgetMs: EXA_BUDGET_MS });
  hangExa(fetch);

  const pending = settle(exa.search(ctx));
  await flush();
  assert.equal(fetch.count(), 1, "预算到期前应已发出一次请求");
  clock.advance(EXA_BUDGET_MS);
  const res = await pending;

  assert.equal(res.ok, false, "预算耗尽时挂起的搜索不得 resolve");
  const err = res.error;
  const timeoutShape = err?.code === ENTRY_CODES.TIMEOUT || err?.name === "AbortError";
  assert.ok(timeoutShape, `预算中止须为 ENTRY_TIMEOUT 或 AbortError（TODO-EXA-9），实际 code=${err?.code} name=${err?.name}`);
  assert.ok(
    ![ENTRY_CODES.CREDENTIALS, ENTRY_CODES.QUOTA, ENTRY_CODES.RATE_LIMITED].includes(err?.code),
    "超时不得被归为凭据、额度或限流",
  );
});

test("FB-003 预算超时后不再请求：拨钟后不产生第二次出站", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const clock = createControlledClock();
  const ctrl = new AbortController();
  clock.setTimeout(() => ctrl.abort(new Error("合成条目预算到期")), EXA_BUDGET_MS);
  const { ctx, fetch } = makeExaCtx({ clock, signal: ctrl.signal, budgetMs: EXA_BUDGET_MS });
  hangExa(fetch);

  const pending = settle(exa.search(ctx));
  await flush();
  clock.advance(EXA_BUDGET_MS);
  await pending;
  clock.advance(60_000);
  await flush();

  assert.equal(fetch.count(), 1, "超时后经过任意拨钟都不得再请求（FB-003）");
});

test("FB-003 迟到结果：中止后上游才返回的成功响应不得改变结果", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const clock = createControlledClock();
  const ctrl = new AbortController();
  clock.setTimeout(() => ctrl.abort(new Error("合成条目预算到期")), EXA_BUDGET_MS);
  const { ctx, fetch } = makeExaCtx({ clock, signal: ctrl.signal, budgetMs: EXA_BUDGET_MS });
  // 假 fetch 在 delayMs 后才会成功；delayMs 大于预算，故中止先发生。
  fetch.when(/api\.exa\.ai/).responds({
    status: 200,
    body: exaOk([exaResult(1)]),
    delayMs: EXA_BUDGET_MS + 10_000,
  });

  const pending = settle(exa.search(ctx));
  await flush();
  clock.advance(EXA_BUDGET_MS);
  clock.advance(10_000);
  const res = await pending;

  assert.equal(res.ok, false, "预算到期后的迟到成功响应不得被采纳为结果（FB-003）");
});
