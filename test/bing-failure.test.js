// bing.md BING-002「空 Feed 与失败」及 FB-005 失败分界验收（docs/specs/draft/bing.md；docs/specs/draft/fallback.md）。
// 全红：适配器测试等待 WP4 src/backends/bing.js；classifyUpstreamFailure 段另等 WP5 src/search.js（分界函数归属 WP5，非 WP4）。
// 覆盖：403 访问受限、200 拦截页、非 RSS 响应、JSON 应答、畸形 XML、无有效链接、共享 HTTP 结局（401/402/429/坏 JSON/403 HTML）、
//       直连网络故障；拦截后不得额外出站。
//       body 阶段读取失败映射（审阅缺口 3）：200 形 text() 原始传输失败 → ENTRY_NETWORK；
//       429 形 body 体积超限 → 仍按状态归 ENTRY_RATE_LIMITED（429 状态分类不丢失）。
// 待办：TODO-BING-1（5xx 可降级，见本文件末尾）。歧义：AMB-5（200 拦截页归类与任务简报冲突，已按样本取 ENTRY_CREDENTIALS）。
import test from "node:test";
import assert from "node:assert/strict";
import { ENTRY_CODES } from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { FIXTURE_NAMES, loadFixture } from "./helpers/fixtures.js";
import {
  BING_SERVER_ERRORS,
  DEGRADABLE_CODES,
  failBing,
  INLINE,
  loadBingBackend,
  makeBingCtx,
  onlyDispatch,
  routeBing,
  routeFromResponse,
  settle,
  sharedUpstreamOutcomes,
  spyFetch,
} from "./helpers/bing-oracle.js";

const CLAUSE = "BING-002 失败";

function assertDegradableFailure(res, label) {
  assert.equal(res.ok, false, `${label} 必须抛错（BING-002：失败分界）`);
  assert.equal(typeof res.error?.code, "string", `${label} 抛出的错误必须携带 .code（A5）`);
  assert.ok(DEGRADABLE_CODES.includes(res.error.code), `${label} 须为可降级条目码（FB-005），实际：${res.error.code}`);
  assert.ok(typeof res.error.message === "string" && res.error.message.length > 0, `${label} 的 message 须非空，给出可操作原因（FB-004）`);
}

test("BING-002 失败：403 访问受限（样本 block-not-rss.html）→ ENTRY_CREDENTIALS，且拦截后不额外出站", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  routeBing(fetch, { status: 403, body: loadFixture(FIXTURE_NAMES.bingNotRss), headers: { "content-type": "text/html" } });

  const res = await settle(bing.search(ctx));

  assertDegradableFailure(res, "403 拦截");
  assert.equal(res.error.code, ENTRY_CODES.CREDENTIALS, "403 访问受限须归为 ENTRY_CREDENTIALS（BING-002/bing-outcomes access-denied）");
  onlyDispatch(fetch);
});

test("BING-002 失败：200 拦截页（HTML）→ ENTRY_CREDENTIALS，按样本 blocked-200-html 归类（AMB-5）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  routeBing(fetch, { status: 200, body: loadFixture(FIXTURE_NAMES.bingNotRss), headers: { "content-type": "text/html" } });

  const res = await settle(bing.search(ctx));

  assertDegradableFailure(res, "200 拦截页");
  assert.equal(res.error.code, ENTRY_CODES.CREDENTIALS, "200 拦截页属于访问受限，须为 ENTRY_CREDENTIALS（BING-002；bing-outcomes blocked-200-html）");
  onlyDispatch(fetch);
});

test("BING-002 失败：200 非 RSS 纯文本应答 → ENTRY_BAD_RESPONSE（响应失败）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  routeBing(fetch, { status: 200, body: INLINE.plainText, headers: { "content-type": "text/plain" } });

  const res = await settle(bing.search(ctx));

  assertDegradableFailure(res, "非 RSS 文本");
  assert.equal(res.error.code, ENTRY_CODES.BAD_RESPONSE, "非 RSS 应答须为 ENTRY_BAD_RESPONSE（BING-002）");
});

test("BING-002 失败：200 JSON 应答（非 RSS）→ ENTRY_BAD_RESPONSE", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  routeBing(fetch, { status: 200, body: INLINE.jsonBody, headers: { "content-type": "application/json" } });

  const res = await settle(bing.search(ctx));

  assertDegradableFailure(res, "JSON 应答");
  assert.equal(res.error.code, ENTRY_CODES.BAD_RESPONSE, "非 RSS 的 JSON 须为 ENTRY_BAD_RESPONSE（BING-002）");
});

test("BING-002 失败：畸形 XML（样本 rss-malformed.xml）→ ENTRY_BAD_RESPONSE（XML 结构异常）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  routeBing(fetch, { status: 200, body: loadFixture(FIXTURE_NAMES.bingMalformed), headers: { "content-type": "application/rss+xml" } });

  const res = await settle(bing.search(ctx));

  assertDegradableFailure(res, "畸形 XML");
  assert.equal(res.error.code, ENTRY_CODES.BAD_RESPONSE, "畸形 XML 须为 ENTRY_BAD_RESPONSE（BING-002）");
});

test("BING-002 失败：所有 item 均无有效链接 → ENTRY_BAD_RESPONSE（响应失败，而非空结果）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  routeBing(fetch, { status: 200, body: INLINE.noValidLinks, headers: { "content-type": "application/rss+xml" } });

  const res = await settle(bing.search(ctx));

  assertDegradableFailure(res, "全部无效链接");
  assert.equal(res.error.code, ENTRY_CODES.BAD_RESPONSE, "所有条目无有效链接属于响应失败（BING-002），不得当作空结果");
});

test("FB-005 分界：共享上游结局（401 / 402 / 429 额度与限流 / 403 HTML / 坏 JSON）→ 对应 ENTRY 码，且可降级", async (t) => {
  const bing = await loadBingBackend(t, "FB-005 分界（共享结局）");
  const outcomes = sharedUpstreamOutcomes(loadFixture, FIXTURE_NAMES);
  assert.ok(outcomes.length >= 5, "共享结局样本至少应含鉴权/额度/限流/拦截/异常五类（卫生前置）");

  for (const outcome of outcomes) {
    await t.test(`${outcome.id}：${outcome.describe}`, async () => {
      const { ctx, fetch } = makeBingCtx();
      routeFromResponse(fetch, outcome.response);

      const res = await settle(bing.search(ctx));

      assertDegradableFailure(res, outcome.id);
      assert.equal(
        res.error.code,
        outcome.expect.code,
        `${outcome.id} 条目码须为 ${outcome.expect.code}（${outcome.describe}；FB-005）`,
      );
    });
  }
});

test("FB-005 分界：直连网络故障（fetch 抛错）→ ENTRY_NETWORK", async (t) => {
  const bing = await loadBingBackend(t, "FB-005 直连网络");
  const { ctx, fetch } = makeBingCtx();
  failBing(fetch, new Error("synthetic connection reset"));

  const res = await settle(bing.search(ctx));

  assertDegradableFailure(res, "直连网络");
  assert.equal(res.error.code, ENTRY_CODES.NETWORK, "fetch 抛错属于直连网络（FB-005）");
});

test("BING-002/FB-005 失败：200 形响应体 text() 原始传输失败 → ENTRY_NETWORK（body 读取失败映射，审阅缺口 3）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx } = makeBingCtx();
  // 鸭子形态响应：无 body 流（走 text() 路径），text() 以原始传输层错误拒绝（模拟 terminated / body 不可读）。
  const rawResponse = {
    status: 200,
    headers: { "content-type": "application/rss+xml" },
    text: () => Promise.reject(new TypeError("synthetic body read failed: terminated")),
  };
  const fetch = spyFetch(async () => rawResponse);
  ctx.fetch = fetch;

  const res = await settle(bing.search(ctx));

  assertDegradableFailure(res, "200 形 text() 失败");
  assert.equal(
    res.error.code,
    ENTRY_CODES.NETWORK,
    `text() 原始失败（200 形）须映射为 ENTRY_NETWORK（FB-005 传输层），不得裸抛原始错误，实际：${res.error.code}`,
  );
  assert.ok(
    !res.error.message.includes("terminated") && !res.error.message.includes("synthetic"),
    "CFG-003：错误文本不得包含原始读取错误内容，实际：",
  );
  assert.equal(fetch.dispatched.length, 1, "前置：恰好一次出站");
});

test("BING-002/FB-005 失败：429 形 body 体积超限仍按状态归 ENTRY_RATE_LIMITED（429 状态分类不丢失，审阅缺口 3）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  // 超限（>2MB）且不含 insufficient_quota 语义的 429 body：额度扫描遇超限视为「无额度标记」，
  // 最终分类仍由 429 状态给出（不因 body 体积改判为 BAD_RESPONSE/NETWORK）。
  routeBing(fetch, {
    status: 429,
    body: "x".repeat(2 * 1024 * 1024 + 10),
    headers: { "content-type": "application/json" },
  });

  const res = await settle(bing.search(ctx));

  assertDegradableFailure(res, "429 形 body 超限");
  assert.equal(
    res.error.code,
    ENTRY_CODES.RATE_LIMITED,
    `429 形 body 超限时状态分类不得丢失（仍限流），不得改判 BAD_RESPONSE/NETWORK，实际：${res.error.code}`,
  );
  onlyDispatch(fetch);
});

test("TODO-BING-1 5xx：可降级，且不归为 CREDENTIALS / QUOTA / RATE_LIMITED（具体码待规格，见 bing-oracle.js 文件头）", async (t) => {
  const bing = await loadBingBackend(t, "FB-005 5xx（TODO-BING-1）");

  for (const outcome of BING_SERVER_ERRORS) {
    await t.test(outcome.id, async () => {
      const { ctx, fetch } = makeBingCtx();
      routeFromResponse(fetch, outcome.response);

      const res = await settle(bing.search(ctx));

      assertDegradableFailure(res, outcome.id);
      for (const notThis of [ENTRY_CODES.CREDENTIALS, ENTRY_CODES.QUOTA, ENTRY_CODES.RATE_LIMITED]) {
        assert.notEqual(res.error.code, notThis, `${outcome.id} 不得归为 ${notThis}（5xx 不是凭据、额度或限流；TODO-BING-1）`);
      }
    });
  }
});

test("FB-005 分界函数：classifyUpstreamFailure 对 401/403/402/429/超时/传输层给出 ENTRY 码（分界函数归属 WP5 src/search.js）", async (t) => {
  const res = await tryImportSrc("search.js");
  failIfUnimplemented(t, res, "WP5 src/search.js", "FB-005 classifyUpstreamFailure（BING-002 失败分界所依赖）");
  const { classifyUpstreamFailure } = res.module;
  assert.equal(typeof classifyUpstreamFailure, "function", "src/search.js 须导出 classifyUpstreamFailure（A4）");

  const cases = [
    [{ status: 401 }, ENTRY_CODES.CREDENTIALS],
    [{ status: 403 }, ENTRY_CODES.CREDENTIALS],
    [{ status: 402 }, ENTRY_CODES.QUOTA],
    [{ status: 429, upstreamCode: "insufficient_quota" }, ENTRY_CODES.QUOTA],
    [{ status: 429 }, ENTRY_CODES.RATE_LIMITED],
    [{ status: 200, phase: "response" }, ENTRY_CODES.BAD_RESPONSE],
    [{ phase: "timeout" }, ENTRY_CODES.TIMEOUT],
    [{ phase: "transport", error: new Error("synthetic socket reset") }, ENTRY_CODES.NETWORK],
  ];
  for (const [info, want] of cases) {
    assert.equal(classifyUpstreamFailure(info), want, `classifyUpstreamFailure(${JSON.stringify({ ...info, error: undefined })}) 须为 ${want}（FB-005）`);
  }
});
