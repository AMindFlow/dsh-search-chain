// WP10 Brave 验收 — 规格含糊处的集中待办断言（全部为 oracle 推断，见下表与各条注释）。
//
// 【约定】本文件是 Brave 验收中唯一允许表达「规格未定」的地方。每条断言都以 [待办] 开头，
//         注明依据条款与未定点。由 dev 或规格维护者裁决：要么修改 docs/specs/draft/brave.md 定名，
//         要么在 PR 说明中改写本文件对应断言并给出理由。不得把这些断言散落到其他测试文件，也不得 skip。
//
// 待办清单（依据 brave.md 唯一条款 BRV-001，及 fallback.md FB-001..FB-005）：
//   P1 BRV-001/FB-002  description 的精确目标字段未定（snippet 还是 summary）。推断：snippet。
//   P2 BRV-001/FB-002  缺 title 但 URL 有效的条目：FB-002 只强制 URL 有效。推断：保留。
//   P3 BRV-001/FB-005  200 且缺 web 字段：是否属「可识别的空网页结果」未定。推断：ENTRY_BAD_RESPONSE。
//   P4 FB-005          5xx 精确码未定（FB-005 未列）。推断：ENTRY_BAD_RESPONSE（异常响应）。
//   P5 FB-005          直连网络失败精确码（ENTRY_NETWORK 或 ENTRY_PROXY）。推断：ENTRY_NETWORK。
//   P6 FB-003          budgetMs=0 时的失败码未定。推断：ENTRY_TIMEOUT。
//   P7 FB-001/FB-003   宿主取消的错误形状未定。推断：不得以 ENTRY_* 码抛出。
//   P8 FB-002          已裁决：截断与 truncated 置位归链层（WP5 buildSuccessResult 统一执行）；适配器返回全部映射来源、
//      不本地截断，maxResults 仅作上游参数 count 入请求。对应测试已按定案契约改写。
//   P9 BRV-001         「600 字符 / 75 词」计数口径未定（UTF-16 长度或码点）。
//                      断言二者择一：原样发出，或 ENTRY_CHANNEL_LIMIT 且零出站（不得出站后截断）。
//
// 仅在报告中列出、本文件不断言（规格未给出可观察条款，不由 oracle 擅自定义）：
//   - 时效参数（任务简报提及，brave.md 未定义任何 freshness 参数）。
//   - publishedAt 映射（Brave 的 page_age 字段未在 brave.md 中提及）。
//   - Brave 特有错误体与状态（如 400/422 参数错误的分类、上游 error.code 形状）。
//   - maxResults 为 0、非整数或超过 20 时的处理（brave.md 只规定取较小值）。
//   - description 为空字符串时是否保留该来源。
//   - 设置页「注明使用 Brave Search API 套餐」的文案（属 settings-ui，不在适配器测试内）。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import {
  guard,
  hangBrave,
  loadBraveBackend,
  makeBraveCtx,
  onlyCall,
  rejectionOf,
  routeBrave,
  settle,
  braveOk,
  braveResult,
} from "./helpers/brave-oracle.js";
import { flush } from "./helpers/clock.js";

test("[待办 BRV-001/FB-002] P1 description 精确落点：推断为 snippet", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001/FB-002");
  const { ctx, fetch } = makeBraveCtx({ maxResults: 3 });
  routeBrave(fetch, { status: 200, body: braveOk([braveResult(1)]) });
  const result = await guard(backend.search(ctx), "P1");
  onlyCall(fetch, "P1");
  assert.equal(
    result.sources[0]?.snippet,
    "合成描述 1",
    `[待办 P1] description 的精确字段未定（brave.md 未写）。推断为 snippet，实际 snippet=${result.sources[0]?.snippet}`,
  );
});

test("[待办 BRV-001/FB-002] P2 缺 title 但 URL 有效的条目：推断保留（title 可缺省）", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001/FB-002");
  const { ctx, fetch } = makeBraveCtx({ maxResults: 3 });
  routeBrave(fetch, {
    status: 200,
    body: braveOk([{ url: "https://brave-sample.invalid/doc/notitle", description: "合成描述" }]),
  });
  const result = await guard(backend.search(ctx), "P2");
  onlyCall(fetch, "P2");
  assert.equal(
    result.sources.length,
    1,
    `[待办 P2] FB-002 只强制 URL 有效，title「按适配规格提供」。推断保留，实际 ${result.sources.length} 条`,
  );
});

test("[待办 BRV-001/FB-005] P3 200 且缺 web 字段：推断为 ENTRY_BAD_RESPONSE（非可识别的空网页结果）", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001/FB-005");
  const { ctx, fetch } = makeBraveCtx();
  routeBrave(fetch, { status: 200, body: { type: "search", query: { original: "合成" } } });
  const err = await rejectionOf(backend.search(ctx), "P3");
  onlyCall(fetch, "P3");
  assert.equal(
    err?.code,
    C.ENTRY_CODES.BAD_RESPONSE,
    `[待办 P3] 缺 web 字段是否为「可识别的空网页结果」未定。推断为 ENTRY_BAD_RESPONSE，实际：${err?.code}`,
  );
});

test("[待办 FB-005] P4 5xx 精确条目码：推断为 ENTRY_BAD_RESPONSE", async (t) => {
  const backend = await loadBraveBackend(t, "FB-005");
  const { ctx, fetch } = makeBraveCtx();
  routeBrave(fetch, { status: 500, body: { error: { message: "合成内部错误" } } });
  const err = await rejectionOf(backend.search(ctx), "P4");
  onlyCall(fetch, "P4");
  assert.equal(
    err?.code,
    C.ENTRY_CODES.BAD_RESPONSE,
    `[待办 P4] FB-005 未列 5xx。推断为 ENTRY_BAD_RESPONSE（异常响应），实际：${err?.code}`,
  );
});

test("[待办 FB-005] P5 直连网络失败精确码：推断为 ENTRY_NETWORK", async (t) => {
  const backend = await loadBraveBackend(t, "FB-005");
  const { ctx, fetch } = makeBraveCtx();
  fetch.when((url) => url.startsWith("https://api.search.brave.com/")).fails({
    error: new TypeError("合成网络故障 fetch failed"),
  });
  const err = await rejectionOf(backend.search(ctx), "P5");
  onlyCall(fetch, "P5");
  assert.equal(
    err?.code,
    C.ENTRY_CODES.NETWORK,
    `[待办 P5] 直连网络失败的精确码未定。推断为 ENTRY_NETWORK，实际：${err?.code}`,
  );
});

test("[待办 FB-003] P6 budgetMs=0 的失败码：推断为 ENTRY_TIMEOUT（零出站已由 brave-cancel 断言）", async (t) => {
  const backend = await loadBraveBackend(t, "FB-003");
  const { ctx, fetch } = makeBraveCtx({ budgetMs: 0 });
  const o = await settle(guard(backend.search(ctx), "P6"));
  assert.equal(fetch.count(), 0, "前置：零预算零出站");
  assert.equal(o.ok, false, "前置：零预算不得成功");
  assert.equal(
    o.error?.code,
    C.ENTRY_CODES.TIMEOUT,
    `[待办 P6] 无可用时间时的码未定。推断为 ENTRY_TIMEOUT，实际：${o.error?.code}`,
  );
});

test("[待办 FB-001/FB-003] P7 宿主取消的错误不得带可降级 ENTRY_* 码", async (t) => {
  const backend = await loadBraveBackend(t, "FB-001/FB-003");
  const ac = new AbortController();
  const { ctx, fetch } = makeBraveCtx({ signal: ac.signal, budgetMs: 5000 });
  hangBrave(fetch);
  const pending = settle(backend.search(ctx));
  await flush(2);
  ac.abort(new Error("synthetic host cancel"));
  const o = await guard(pending, "P7");
  assert.equal(o.ok, false, "前置：宿主取消不得成功");
  assert.ok(
    !Object.values(C.ENTRY_CODES).includes(o.error?.code),
    `[待办 P7] 宿主取消的错误形状未定。推断：不得以 ENTRY_* 码抛出（链会误以为可降级继续），实际码：${o.error?.code}`,
  );
});

test("BRV-001/FB-002 上游超发（5 条 > maxResults=3）：适配器返回全量来源不截断（截断与 truncated 归链层）", async (t) => {
  const backend = await loadBraveBackend(t, "FB-002");
  const { ctx, fetch } = makeBraveCtx({ maxResults: 3 });
  routeBrave(fetch, { status: 200, body: braveOk([1, 2, 3, 4, 5].map((i) => braveResult(i))) });
  const result = await guard(backend.search(ctx), "P8");
  onlyCall(fetch, "P8");
  // maxResults 仍作为上游参数发送（BRV-001 要求1：count=min(maxResults,20)）；本用例钉住「发送但不本地裁剪」。
  assert.equal(
    new URL(fetch.calls[0].url).searchParams.get("count"),
    "3",
    "maxResults=3 仍须入请求 count（BRV-001 上游参数），实际未发送或值不符",
  );
  assert.equal(
    result.sources.length,
    5,
    `裁决（FB-002）：插件边界截断与 truncated 置位由链 WP5 buildSuccessResult 统一执行，适配器返回全部 5 条映射来源、不本地截断，实际 ${result.sources.length} 条`,
  );
});

test("[待办 BRV-001] P9 字符口径：不得出站后截断；要么原样发出，要么零出站且 CHANNEL_LIMIT", async (t) => {
  const backend = await loadBraveBackend(t, "BRV-001");
  // 301 个 U+1F600：UTF-16 长 602（超 600），码点数 301（未超）。口径未定，二者择一即可。
  const emoji = "\u{1F600}".repeat(301);
  const { ctx, fetch } = makeBraveCtx({ query: emoji });
  routeBrave(fetch, { status: 200, body: braveOk([braveResult(1)]) });
  const o = await settle(guard(backend.search(ctx), "P9"));
  if (fetch.count() === 0) {
    assert.equal(o.ok, false, "[待办 P9] 零出站时须以 ENTRY_CHANNEL_LIMIT 拒绝");
    assert.equal(
      o.error?.code,
      C.ENTRY_CODES.CHANNEL_LIMIT,
      `[待办 P9] 按 UTF-16 口径超限时的码应为 CHANNEL_LIMIT，实际：${o.error?.code}`,
    );
  } else {
    assert.equal(
      new URL(fetch.calls[0].url).searchParams.get("q"),
      emoji,
      "[待办 P9] 若按码点口径放行，发出的 q 须完整，不得被截断",
    );
  }
});
