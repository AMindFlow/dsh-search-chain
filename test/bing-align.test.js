// WP4 对齐包（oracle 轮）— 差距审计 P0-1 / P1-2 / P2-2-bing 的转正断言。
//
// 三条均为「规格已定、现实现违背」的期望转正，main 上预期红；dev 只能改 src/backends/bing.js
// 转绿，不得弱化或 skip 本文件（helpers/impl.js 红绿策略同约）。
//
//   P0-1 截断归链     FB-002（docs/specs/draft/fallback.md:14）与结果契约（fallback.md:43）：
//                     「适配器返回全量映射来源，不得按 maxResults 本地切片；截断与 truncated
//                     由链的 buildSuccessResult 统一执行」。现实现 bing.js 末尾本地 slice 违背。
//                     同族先例：tavily/openai/brave 的「上游超发→全量不截断」用例。
//                     注：bing.js 头部的「AMB-7」注释是悬空引用（grep 全部 docs/ 零命中），
//                     本文件断言不依赖它，只依 FB-002/A5 成文条款。
//   P1-2 其他 4xx     FB-005（fallback.md:34）统一规则：「其他 HTTP 4xx…由链统一归类为通道
//                     参数限制」；bing.md 未给 Bing 任何 4xx 本地重分类特例，链按适配器抛出的码
//                     消费 → 链终态 attempts 码须为 ENTRY_CHANNEL_LIMIT。现实现 400/422 →
//                     ENTRY_BAD_RESPONSE 违背。429+insufficient_quota→QUOTA 的授权特例保留面
//                     在 bing-failure.test.js（共享结局 quota-code-insufficient），本文件不动。
//   P2-2 clock 缺省   FB-003 预算涵盖请求与解析、条目到期须取消当前请求；brave 已按 P1-1 原则
//                     落地「定时器取 ctx.clock ?? globalThis，clock 缺省时不得静默跳过预算」
//                     （src/backends/brave.js 文件头 P1-1）。现实现 bing.js 要求 clock.setTimeout
//                     存在才装预算定时器——无 clock 时挂起 fetch 永不收尾（挂死）。
//                     本用例用真实定时器守护（raceWithin）断言 ENTRY_TIMEOUT 且零挂死。
import test from "node:test";
import assert from "node:assert/strict";
import { ENTRY_CODES } from "./helpers/contract.js";
import { makeEntry } from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { createChainHarness } from "./helpers/chain-harness.js";
import {
  BING_ENDPOINT,
  BING_QUERY,
  hangBing,
  loadBingBackend,
  makeBingCtx,
  onlyDispatch,
  raceWithin,
  routeBing,
  rssDoc,
  rssItem,
  settle,
} from "./helpers/bing-oracle.js";

const RSS_HEADERS = { "content-type": "application/rss+xml; charset=utf-8" };

// ─── P0-1 上游超发：适配器全量返回，不本地切片（FB-002 / 结果契约 A5）───────────────────────────

const OVERSELL_COUNT = 5;
const OVERSELL_URLS = Array.from({ length: OVERSELL_COUNT }, (_, i) => `https://oversell-${i + 1}.host.test/doc-${i + 1}`);
const OVERSELL_BODY = rssDoc(
  OVERSELL_URLS.map((link, i) =>
    rssItem({ title: `超发条目 ${i + 1}`, link, description: `合成超发描述 ${i + 1}`, pubDate: "Wed, 05 Nov 2025 10:00:00 GMT" }),
  ).join(""),
);

test("BING-001/FB-002 上游超发（5 条 > maxResults=2）：适配器返回全量来源不截断（截断与 truncated 归链层；FB-002 与 fallback.md:43 结果契约）", async (t) => {
  const bing = await loadBingBackend(t, "FB-002 全量返回（截断归链）");
  const { ctx, fetch } = makeBingCtx({ maxResults: 2 });
  routeBing(fetch, { status: 200, body: OVERSELL_BODY, headers: RSS_HEADERS });

  const res = await settle(bing.search(ctx));

  assert.equal(res.ok, true, `前置：5 条合成 RSS 须成功解析，实际错误：${res.error?.code ?? ""} ${res.error?.message ?? ""}`);
  assert.equal(
    res.value.sources.length,
    OVERSELL_COUNT,
    `裁决（FB-002，fallback.md:14/43）：适配器返回全量映射来源、不得按 maxResults 本地切片，截断与 truncated 由链的 buildSuccessResult 统一执行；应返回 ${OVERSELL_COUNT} 条，实际 ${res.value.sources.length} 条`,
  );
  assert.deepEqual(
    res.value.sources.map((s) => s.url),
    OVERSELL_URLS,
    "全量返回且保持上游文档顺序（BING-001 顺序；FB-002「按成功条目的结果顺序返回 sources」）",
  );
  onlyDispatch(fetch);
});

// ─── P1-2 其他 4xx → 链终态 attempts 码 ENTRY_CHANNEL_LIMIT（FB-005 统一规则）──────────────────

test("FB-005 统一规则（链级）：Bing 条目其他 4xx（400/422）→ 终态 attempts 码 ENTRY_CHANNEL_LIMIT（不得为 ENTRY_BAD_RESPONSE；bing.md 无本地重分类特例）", async (t) => {
  const bing = await loadBingBackend(t, "FB-005 其他 4xx → CHANNEL_LIMIT（链级）");
  const chainRes = await tryImportSrc("search.js");
  if (failIfUnimplemented(t, chainRes, "WP5 src/search.js", "FB-005 链按适配器码消费")) return;
  const { createSearchChain } = chainRes.module;

  for (const status of [400, 422]) {
    await t.test(`HTTP ${status}（其他 4xx，非 401/402/403/429，无额度证据码）`, async () => {
      const entry = makeEntry({ id: `bing-4xx-${status}`, type: "bing", name: `合成 Bing 通道 ${status}` });
      const h = createChainHarness(createSearchChain, { entries: [entry] });
      h.deps.backends.set("bing", bing); // 真实 bing 适配器进链（同 brave-request.test.js 先例）
      h.fetchFn.when(BING_ENDPOINT).responds({
        status,
        body: { error: { message: "synthetic parameter error" } },
        headers: { "content-type": "application/json" },
      });

      const err = await h.runToError(h.search({ query: BING_QUERY }), 60000);
      const hit = (err?.details?.attempts ?? []).find((a) => a.entryId === entry.id);
      assert.ok(hit, `FB-004：终态 attempts 须含该条目（实际 attempts=${JSON.stringify(err?.details?.attempts)}）`);
      assert.equal(
        hit.code,
        ENTRY_CODES.CHANNEL_LIMIT,
        `统一规则（FB-005，fallback.md:34）：其他 HTTP 4xx 归通道参数限制；bing.md 未授权任何 Bing 本地重分类，链按适配器抛出的码消费。期望 ${ENTRY_CODES.CHANNEL_LIMIT}，实际 ${hit.code}`,
      );
      assert.equal(h.fetchFn.count(BING_ENDPOINT), 1, "FB-001：每条目最多一次出站");
    });
  }
});

// ─── P2-2 clock 缺省：预算须回落真实时钟，不得静默跳过（brave P1-1 原则）───────────────────────

test("FB-003 预算（缺省 clock，brave P1-1 原则）：ctx.clock 未提供 + 挂起 fetch + 小 budgetMs → 真实时钟收尾 ENTRY_TIMEOUT，零挂死", async (t) => {
  const bing = await loadBingBackend(t, "FB-003 缺省 clock 预算回落真实时钟");
  const { ctx, fetch } = makeBingCtx({ budgetMs: 50 });
  delete ctx.clock; // 缺省 ctx.clock：预算定时器须回落真实时钟仍受预算（brave.js P1-1），不得静默跳过
  hangBing(fetch);

  const res = await raceWithin(bing.search(ctx), 2500);

  assert.equal(
    res.timedOut,
    undefined,
    "clock 缺省时预算定时器仍须收尾在途请求（FB-003：条目到期须取消当前请求；brave P1-1：缺省不得静默跳过预算）。挂起未收尾 = 静默跳过预算，零挂死不成立",
  );
  assert.equal(res.ok, false, "预算到期的挂起请求必须 reject，不得 resolve");
  assert.equal(
    res.error?.code,
    ENTRY_CODES.TIMEOUT,
    `条目预算到期的条目码须为 ${ENTRY_CODES.TIMEOUT}（FB-003/错误契约 fallback.md:44），实际：${res.error?.code ?? "(无码)"} ${res.error?.message ?? ""}`,
  );
  onlyDispatch(fetch);
  const outSignal = fetch.dispatched[0].init.signal;
  assert.equal(outSignal?.aborted, true, "到期须取消在途请求（FB-003：出站 signal 已中止）");
});
