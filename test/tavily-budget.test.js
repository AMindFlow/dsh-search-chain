// WP3 验收 — 取消与超时透传（src/backends/tavily.js，A8 受控时钟 / ctx.signal）。
// 覆盖条款：
//   FB-003：总预算 budgetMs 由 ctx.clock 驱动；无可用时间时不得发出请求；
//           条目到期须取消在途请求；宿主取消须取消在途操作且不得再请求。
//   FB-001：宿主取消或总预算耗尽须终止，不得降级到后续条目（取消错误形状见 tavily-pending.test.js）。
//   TAV-001/TAV-002 验收：「取消及超时透传」—— 上游挂起时由预算中止，并以 ENTRY_TIMEOUT 报告。
// 说明：挂起用假 fetch（fake-fetch.hangs），只有 init.signal 中止才会结束；适配器必须把 ctx.signal 与
//       预算中止合并后传入 init.signal。真实 Promise 守卫（withGuard）只用于防卡死，不作为预算依据。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { createControlledClock, flush } from "./helpers/clock.js";
import {
  loadTavilyBackend,
  makeCtx,
  tavilyFetchHangs,
  singleCall,
  rejectionOf,
  withGuard,
  assertEntryError,
  TAVILY_URL,
} from "./helpers/tavily-oracle.js";

test("FB-003/TAV-002：挂起的上游由 ctx.clock 预算中止，报 ENTRY_TIMEOUT，在途请求被取消", async (t) => {
  const backend = await loadTavilyBackend(t, "FB-003");
  if (!backend) return;
  const clock = createControlledClock();
  const fetch = tavilyFetchHangs();
  const p = backend.search(makeCtx({ fetch, clock, budgetMs: 5000 }));
  p.catch(() => {});
  await flush(3);
  singleCall(fetch, "挂起请求");
  clock.advance(4999);
  await flush(3);
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await flush(3);
  assert.equal(settled, false, "FB-003：预算未到（4999ms）不得中止");
  clock.advance(1);
  const err = await rejectionOf(withGuard(p, "预算 5000ms 到期应中止挂起请求"));
  assertEntryError(err, C.ENTRY_CODES.TIMEOUT);
  assert.equal(fetch.calls[0].aborted, true, "FB-003：到期必须取消在途 fetch（init.signal 已中止）");
  assert.equal(fetch.count(TAVILY_URL), 1, "超时后不得再发起请求");
});

test("FB-003：预算为 0（无可用时间）时不得发出任何请求", async (t) => {
  const backend = await loadTavilyBackend(t, "FB-003");
  if (!backend) return;
  const fetch = tavilyFetchHangs();
  await rejectionOf(withGuard(backend.search(makeCtx({ fetch, budgetMs: 0 })), "budgetMs=0"));
  assert.equal(fetch.count(), 0, "FB-003：无可用时间时出站请求数必须为零");
});

test("FB-003/宿主取消：在途请求时 ctx.signal 中止 → fetch 被取消，且不再发起新请求", async (t) => {
  const backend = await loadTavilyBackend(t, "FB-003");
  if (!backend) return;
  const ac = new AbortController();
  const fetch = tavilyFetchHangs();
  const p = backend.search(makeCtx({ fetch, signal: ac.signal, budgetMs: 5000 }));
  p.catch(() => {});
  await flush(3);
  singleCall(fetch, "在途请求");
  ac.abort(new Error("synthetic host cancel"));
  await rejectionOf(withGuard(p, "宿主取消后应结束"));
  assert.equal(fetch.calls[0].aborted, true, "FB-003：宿主取消必须取消在途 fetch");
  assert.equal(fetch.count(), 1, "取消后出站请求数不得增加");
});

test("FB-003/宿主取消：调用前信号已中止 → 不得有请求抵达网络", async (t) => {
  const backend = await loadTavilyBackend(t, "FB-003");
  if (!backend) return;
  const ac = new AbortController();
  ac.abort(new Error("synthetic pre-abort"));
  const fetch = tavilyFetchHangs();
  await rejectionOf(withGuard(backend.search(makeCtx({ fetch, signal: ac.signal })), "预先取消"));
  for (const call of fetch.calls) {
    assert.equal(call.settled, "aborted", "FB-003：预先取消时任何出站调用都不得完成为正常响应");
  }
  assert.equal(
    fetch.calls.filter((c) => c.settled === "ok").length,
    0,
    "FB-003：预先取消时不得有成功的网络往返",
  );
});
