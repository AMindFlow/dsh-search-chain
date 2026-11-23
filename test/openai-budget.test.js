// WP2 验收 — 取消与预算透传（src/backends/openai.js，FB-003；OAI-001「取消按 FB-003 处理」）。
// 覆盖条款：
//   FB-003：预算计时只用 ctx.clock（A8）；预算内不得中止；条目到期必须取消在途请求（经 ctx.fetch 的
//           init.signal 合并透传，A5/A6），并以 ENTRY_TIMEOUT 报告（码的推断见 openai-pending.test.js P10）。
//   FB-003：无可用时间（budgetMs≤0）不得发出任何请求；宿主取消（ctx.signal 中止）必须取消在途操作、
//           不得再发起新请求；调用前信号已中止 → 不得有请求抵达网络。
//   FB-001：宿主取消属终止类——取消错误形状未在规格定义，推断不得携带可降级 ENTRY_* 码（待办 P8）。
// 真实 Promise 守卫（withGuard）只用于防卡死，不作为预算依据。挂起用 fake-fetch.hangs：
// 只有 init.signal 被中止才会结束，因此这些用例同时验证「ctx.signal 与预算中止合并透传给 ctx.fetch」。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { createControlledClock, flush } from "./helpers/clock.js";
import {
  loadOpenAIBackend,
  makeCtx,
  openaiFetchHangs,
  openaiFetchNoRoutes,
  singleCall,
  rejectionOf,
  withGuard,
  assertEntryError,
  OPENAI_ENDPOINT,
} from "./helpers/openai-oracle.js";

test("FB-003/OAI-001：挂起的上游由 ctx.clock 预算中止，报 ENTRY_TIMEOUT，在途请求被取消", async (t) => {
  const backend = await loadOpenAIBackend(t, "FB-003");
  if (!backend) return;
  const clock = createControlledClock();
  const fetch = openaiFetchHangs();
  const p = backend.search(makeCtx({ fetch, clock, budgetMs: 5000 }));
  p.catch(() => {});
  await flush(3);
  const call = singleCall(fetch, "挂起请求");
  assert.ok(call.signal, "A5/A6：fetch 必须带 init.signal（宿主取消与预算中止的合并信号）");
  clock.advance(4999);
  await flush(3);
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await flush(3);
  assert.equal(settled, false, "FB-003：预算未到（4999/5000ms）不得中止");
  clock.advance(1);
  const err = await rejectionOf(withGuard(p, "预算 5000ms 到期应中止挂起请求"));
  assertEntryError(err, C.ENTRY_CODES.TIMEOUT);
  assert.equal(fetch.calls[0].aborted, true, "FB-003：到期必须取消在途 fetch（init.signal 已中止）");
  assert.equal(fetch.count(OPENAI_ENDPOINT), 1, "超时后不得再发起请求");
});

test("FB-003：预算为 0（无可用时间）时不得发出任何请求", async (t) => {
  const backend = await loadOpenAIBackend(t, "FB-003");
  if (!backend) return;
  const fetch = openaiFetchNoRoutes(); // 任何出站都会抛「未声明的出站调用」
  await rejectionOf(withGuard(backend.search(makeCtx({ fetch, budgetMs: 0 })), "budgetMs=0"));
  assert.equal(fetch.count(), 0, "FB-003：无可用时间时出站请求数必须为零（码的推断见待办 P10）");
});

test("FB-003/FB-001：宿主取消中止在途请求 → 请求被取消、码不可降级、不再出站", async (t) => {
  const backend = await loadOpenAIBackend(t, "FB-003/FB-001");
  if (!backend) return;
  const ac = new AbortController();
  const fetch = openaiFetchHangs();
  const p = backend.search(makeCtx({ fetch, signal: ac.signal, budgetMs: 5000 }));
  p.catch(() => {});
  await flush(3);
  singleCall(fetch, "在途请求");
  ac.abort(new Error("synthetic host cancel"));
  const err = await rejectionOf(withGuard(p, "宿主取消后应结束"));
  assert.equal(fetch.calls[0].aborted, true, "FB-003：宿主取消必须取消在途 fetch（ctx.signal 合并透传）");
  assert.equal(fetch.count(), 1, "FB-003：取消后出站请求数不得增加");
  assert.ok(
    !Object.values(C.ENTRY_CODES).includes(err?.code),
    `FB-001：宿主取消是终止类，不得以可降级 ENTRY_* 码抛出（推断，见待办 P8），实际码：${err?.code}`,
  );
});

test("FB-003：调用前 ctx.signal 已中止 → 不得有请求抵达网络", async (t) => {
  const backend = await loadOpenAIBackend(t, "FB-003");
  if (!backend) return;
  const ac = new AbortController();
  ac.abort(new Error("synthetic pre-abort"));
  const fetch = openaiFetchHangs();
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
