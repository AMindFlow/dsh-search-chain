// WP10 Brave 验收 — brave.md BRV-001（请求与来源）+ FB-001 取消语义 + FB-003 预算与取消。
// 覆盖：预取消零出站；宿主取消经 signal 合并中止在途请求且不再二次请求；单条目预算到期（受控时钟）
//       未到期不取消、到期取消当前请求并以 ENTRY_TIMEOUT 拒绝；迟到结果不改变结果；预算为 0 零出站。
// 所有时间只通过注入的受控时钟推进（ctx.clock），测试不依赖真实等待；guard 防止误用真实定时器挂起。
// 红属预期：src/backends/brave.js（WP10）缺失时经 impl.js 报「等待实现 WP10」。
// 错误码口径：预算到期按 FB-005「单项超时」归为 ENTRY_TIMEOUT；宿主取消的错误形状未定，见 brave-pending P7。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import {
  guard,
  hangBrave,
  loadBraveBackend,
  makeBraveCtx,
  onlyCall,
  routeBrave,
  settle,
  braveOk,
  braveResult,
} from "./helpers/brave-oracle.js";
import { flush } from "./helpers/clock.js";

const OK_BODY = braveOk([braveResult(1)]);

test("FB-001 / FB-003：ctx.signal 已中止时零出站并拒绝", async (t) => {
  const backend = await loadBraveBackend(t, "FB-003 预取消");
  const ac = new AbortController();
  ac.abort(new Error("synthetic pre-cancel"));
  const { ctx, fetch } = makeBraveCtx({ signal: ac.signal });
  routeBrave(fetch, { status: 200, body: OK_BODY });
  const o = await settle(guard(backend.search(ctx), "预取消"));
  assert.equal(o.ok, false, "预取消后不得成功返回");
  assert.equal(fetch.count(), 0, "FB-003：预取消时出站请求数为零");
});

test("FB-003：宿主取消在途请求 → 传给 fetch 的 signal 中止，适配器拒绝，且不再发起第二次请求", async (t) => {
  const backend = await loadBraveBackend(t, "FB-003 宿主取消");
  const ac = new AbortController();
  const { ctx, fetch } = makeBraveCtx({ signal: ac.signal });
  hangBrave(fetch);
  const pending = settle(backend.search(ctx));
  await flush(2);
  ac.abort(new Error("synthetic host cancel"));
  const o = await guard(pending, "宿主取消");
  assert.equal(o.ok, false, "宿主取消后不得成功返回");
  const call = onlyCall(fetch, "宿主取消");
  assert.equal(call.signal?.aborted, true, "BRV-001 / FB-003：宿主取消须经 signal 合并中止在途请求");
});

test("FB-003：单条目预算到期（受控时钟）→ 未到期不取消，到期取消当前请求并以 ENTRY_TIMEOUT 拒绝", async (t) => {
  const backend = await loadBraveBackend(t, "FB-003 预算到期");
  const { ctx, clock, fetch } = makeBraveCtx({ budgetMs: 1000 });
  hangBrave(fetch);
  const pending = settle(backend.search(ctx));
  await flush(2);
  const call = onlyCall(fetch, "预算到期");
  clock.advance(999);
  assert.equal(call.signal?.aborted, false, "预算未到期前不得取消当前请求");
  clock.advance(1);
  const o = await guard(pending, "预算到期");
  assert.equal(o.ok, false, "预算到期后不得成功返回");
  assert.equal(o.error?.code, C.ENTRY_CODES.TIMEOUT, "FB-005：单项超时须归为 ENTRY_TIMEOUT");
  assert.equal(call.signal?.aborted, true, "FB-003：到期须取消当前请求");
  assert.equal(fetch.count(), 1, "到期取消后不得再次发起请求（FB-001 每条目一次提交）");
});

test("FB-003：迟到结果不改变结果：响应延迟超过预算 → 拒绝，拨钟越过迟到时间后仍为失败", async (t) => {
  const backend = await loadBraveBackend(t, "FB-003 迟到结果");
  const { ctx, clock, fetch } = makeBraveCtx({ budgetMs: 1000 });
  routeBrave(fetch, { status: 200, body: OK_BODY, delayMs: 5000 });
  const pending = settle(backend.search(ctx));
  await flush(2);
  clock.advance(1000);
  const o = await guard(pending, "迟到结果");
  assert.equal(o.ok, false, "预算内未返回，迟到结果不得构成成功");
  assert.equal(o.error?.code, C.ENTRY_CODES.TIMEOUT, "迟到结果到达前的预算到期须为 ENTRY_TIMEOUT");
  clock.advance(10000);
  await flush(2);
  assert.equal(o.ok, false, "拨钟越过迟到时间后，结果仍为失败（迟到结果被忽略）");
  assert.equal(fetch.count(), 1, "迟到结果不得触发重试");
});

test("FB-003：预算为 0（无可用时间）时不得发出请求", async (t) => {
  const backend = await loadBraveBackend(t, "FB-003 零预算");
  const { ctx, fetch } = makeBraveCtx({ budgetMs: 0 });
  routeBrave(fetch, { status: 200, body: OK_BODY });
  const o = await settle(guard(backend.search(ctx), "零预算"));
  assert.equal(o.ok, false, "无可用时间时不得成功返回");
  assert.equal(fetch.count(), 0, "FB-003：无可用时间时出站请求数为零");
});
