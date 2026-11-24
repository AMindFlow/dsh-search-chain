// bing.md BING-001 出站与 FB-003「预算与取消」在 Bing 适配器上的验收（docs/specs/draft/bing.md；docs/specs/draft/fallback.md）。
// 全红：src/backends/bing.js 尚未实现，等待 WP4。
// 覆盖：ctx.signal 合并透传到出站 init.signal；宿主取消使在途请求中止且不再出站；
//       挂起被条目预算中止时的错误形状（AbortError 或 ENTRY_TIMEOUT，AMB-6）且不 resolve；预取消零出站。
//       body 阶段（响应头先到、body 挂起，helpers 自有 bodyHangFetch）：预算到期 → ENTRY_TIMEOUT；
//       宿主中途取消 → 无码 AbortError（FB-003 预算/取消贯穿 fetch + body 生命周期，审阅缺口 2）。
// 说明：挂起等待使用受控时钟（helpers/clock.js）推进；raceWithin 仅是挂起未中止时的报红守护，不作为正确性依据。
// 待办与歧义见 helpers/bing-oracle.js 文件头（AMB-6）。
import test from "node:test";
import assert from "node:assert/strict";
import { ENTRY_CODES } from "./helpers/contract.js";
import { createControlledClock, flush } from "./helpers/clock.js";
import {
  BING_BUDGET_MS,
  hangBing,
  loadBingBackend,
  makeBingBodyHangCtx,
  makeBingCtx,
  raceWithin,
  routeBing,
  rssDoc,
  rssItem,
} from "./helpers/bing-oracle.js";

const CLAUSE = "BING-001 取消与预算";
const OK_BODY = rssDoc(rssItem({ title: "取消侧样本", link: "https://cancel-sample.host.test/a", description: "取消侧描述" }));

test("FB-003 取消：ctx.signal 合并透传到出站 init.signal，宿主取消后在途请求中止且不再出站", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const ac = new AbortController();
  const { ctx, fetch } = makeBingCtx({ signal: ac.signal });
  hangBing(fetch);

  const pending = raceWithin(bing.search(ctx));
  await flush(5);

  assert.equal(fetch.dispatched.length, 1, "挂起前应已发出一次请求（前置）");
  const outSignal = fetch.dispatched[0].init.signal;
  assert.ok(outSignal, "出站 init.signal 必须存在（合并或透传 ctx.signal，FB-003）");
  assert.equal(outSignal.aborted, false, "前置：取消前出站 signal 未中止");

  ac.abort(new Error("宿主取消（合成）"));
  const res = await pending;

  assert.equal(res.timedOut, undefined, "宿主取消须使在途请求中止，不得挂起（FB-003）");
  assert.equal(res.ok, false, "取消后不得 resolve（FB-003）");
  assert.equal(outSignal.aborted, true, "出站 signal 须随 ctx.signal 中止（合并透传，FB-003）");

  await flush(5);
  assert.equal(fetch.dispatched.length, 1, "取消后出站请求数不得增加（FB-003）");
});

test("FB-003 预算：挂起被条目预算中止后结束等待，错误形状为 AbortError 或 ENTRY_TIMEOUT，且不 resolve（AMB-6）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const clock = createControlledClock();
  const ac = new AbortController();
  const { ctx, fetch } = makeBingCtx({ signal: ac.signal, clock, budgetMs: BING_BUDGET_MS });
  hangBing(fetch);

  const pending = raceWithin(bing.search(ctx));
  await flush(5);
  assert.equal(fetch.dispatched.length, 1, "挂起前应已发出一次请求（前置）");

  clock.setTimeout(() => ac.abort(new Error("条目预算到期（合成）")), BING_BUDGET_MS);
  clock.advance(BING_BUDGET_MS);
  const res = await pending;

  assert.equal(res.timedOut, undefined, "预算中止后须结束等待（FB-003）");
  assert.equal(res.ok, false, "挂起被预算中止后不得 resolve（FB-003）");
  const err = res.error;
  const shapeOk = err?.name === "AbortError" || err?.code === ENTRY_CODES.TIMEOUT;
  assert.ok(shapeOk, `中止形状须为 AbortError 或 ${ENTRY_CODES.TIMEOUT}（AMB-6），实际 name=${err?.name} code=${err?.code}`);
  assert.equal(fetch.dispatched.length, 1, "预算中止不得触发新的出站（FB-003）");
});

test("FB-003 预取消：signal 已中止时零出站", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const ac = new AbortController();
  ac.abort(new Error("预取消（合成）"));
  const { ctx, fetch } = makeBingCtx({ signal: ac.signal });
  routeBing(fetch, { status: 200, body: OK_BODY, headers: { "content-type": "application/rss+xml" } });

  const res = await raceWithin(bing.search(ctx));

  assert.equal(res.timedOut, undefined, "预取消时必须立即结束（FB-003）");
  assert.equal(res.ok, false, "预取消时不得 resolve（FB-003）");
  assert.equal(fetch.dispatched.length, 0, "预取消时零出站：不得调用 ctx.fetch（FB-003）");
});

test("FB-003 预算：响应头先到、body 挂起时，预算到期 → ENTRY_TIMEOUT（预算贯穿 body 阶段，审阅缺口 2）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const clock = createControlledClock();
  const { ctx, fetch } = makeBingBodyHangCtx({ clock, budgetMs: BING_BUDGET_MS });

  const pending = raceWithin(bing.search(ctx));
  await flush(5);
  assert.equal(fetch.dispatched.length, 1, "前置：响应头应已到达（恰好一次出站）");

  clock.advance(BING_BUDGET_MS);
  const res = await pending;

  assert.equal(res.timedOut, undefined, "预算到期须使挂起的 body 读取结束（FB-003：预算覆盖 body 生命周期）");
  assert.equal(res.ok, false, "预算到期后不得 resolve（FB-003）");
  assert.equal(
    res.error?.code,
    ENTRY_CODES.TIMEOUT,
    `预算到期须为 ${ENTRY_CODES.TIMEOUT}（FB-003/AMB-6：条目预算到期），实际 name=${res.error?.name} code=${res.error?.code}`,
  );
  assert.equal(fetch.dispatched.length, 1, "预算到期不得触发新的出站（FB-003）");
  assert.equal(fetch.calls[0].bodyCancelled, true, "中止时须终止底层 body 流（reader.cancel 兜底，FB-003）");
});

test("FB-003 取消：响应头先到、body 挂起时，宿主中途取消 → 无码 AbortError（取消分类不丢失，审阅缺口 2）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const ac = new AbortController();
  const { ctx, fetch } = makeBingBodyHangCtx({ signal: ac.signal, budgetMs: 60000 });

  const pending = raceWithin(bing.search(ctx));
  await flush(5);
  assert.equal(fetch.dispatched.length, 1, "前置：响应头应已到达（恰好一次出站）");

  ac.abort(new Error("宿主取消（合成，body 阶段）"));
  const res = await pending;

  assert.equal(res.timedOut, undefined, "宿主取消须使挂起的 body 读取结束（FB-003）");
  assert.equal(res.ok, false, "宿主取消后不得 resolve（FB-003）");
  assert.equal(
    res.error?.name,
    "AbortError",
    `宿主取消须为 AbortError 形状（FB-003/AMB-6），实际 name=${res.error?.name} code=${res.error?.code}`,
  );
  assert.equal(res.error?.code, undefined, "宿主取消不得携带可降级 ENTRY_* 码（链据此终止而非降级，FB-001/FB-003）");
  assert.equal(fetch.calls[0].bodyCancelled, true, "取消时须终止底层 body 流（reader.cancel 兜底，FB-003）");
  assert.equal(fetch.dispatched.length, 1, "取消后不得触发新的出站（FB-003）");
});
