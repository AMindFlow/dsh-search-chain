// EXA-001 空结果与失败分界验收（docs/specs/draft/exa.md；分类依据 fallback.md FB-004/FB-005）。
// 全红：等待 WP9 实现 src/backends/exa.js；classifyUpstreamFailure 段另等 WP5 src/search.js。
// 覆盖条款：EXA-001「有效 results: [] 为无结果」；「认证、额度、限流…遵守降级规格」；
//           FB-005 额度（402 / insufficient_quota）、限流（其他 429）、凭据权限（401/403）、
//           异常响应（200 坏 JSON）、直连网络（fetch 抛错）；FB-005「内部程序违约向调用方暴露」。
// 样本：复用已登记的 upstream/http-outcomes.json（去掉 Tavily 专属 432）+ helpers/exa-oracle.js 内联 5xx。
// 待办见 helpers/exa-oracle.js 文件头（TODO-EXA-7/12）。
import test from "node:test";
import assert from "node:assert/strict";
import { ENTRY_CODES, CHAIN_CODES } from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import {
  DEGRADABLE_CODES,
  EXA_SERVER_ERRORS,
  loadExaBackend,
  makeExaCtx,
  routeFromResponse,
  routeExa,
  settle,
  exaOk,
  exaResult,
  sharedUpstreamOutcomes,
} from "./helpers/exa-oracle.js";

const CLAUSE = "EXA-001 空结果与失败";

test("EXA-001 空结果：200 且 results: [] 为明确无结果，resolve sources: []，不抛错", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx, fetch } = makeExaCtx();
  routeExa(fetch, { status: 200, body: exaOk([]) });

  const res = await settle(exa.search(ctx));

  assert.equal(res.ok, true, "有效空数组是无结果，不是错误（EXA-001；FB-004 明确无结果）");
  assert.deepEqual(res.value.sources, [], "sources 必须为空数组");
  assert.equal(res.value.content, undefined, "空结果不得携带 content（纯来源适配器，FB-002）");
});

test("FB-005 分类：共享上游结局（401/402/429 额度与限流/403 HTML/坏 JSON）→ 对应 ENTRY 码，且可降级", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const outcomes = sharedUpstreamOutcomes();
  assert.ok(outcomes.length >= 5, "共享结局样本至少应含鉴权/额度/限流/拦截/异常五类（卫生检查前置）");

  for (const outcome of outcomes) {
    await t.test(`${outcome.id}：${outcome.describe}`, async () => {
      const { ctx, fetch } = makeExaCtx();
      routeFromResponse(fetch, outcome.response);

      const res = await settle(exa.search(ctx));

      assert.equal(res.ok, false, `${outcome.id} 必须抛错`);
      assert.equal(
        res.error?.code,
        outcome.expect.code,
        `${outcome.id} 条目码须为 ${outcome.expect.code}（${outcome.describe}；FB-005）`,
      );
      assert.ok(DEGRADABLE_CODES.includes(res.error.code), `${outcome.id} 须为可降级条目码（FB-005）`);
    });
  }
});

test("FB-005 额度：HTTP 402 与 429+insufficient_quota 均为 ENTRY_QUOTA，其他 429 为 ENTRY_RATE_LIMITED", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const cases = [
    { status: 402, body: { error: { type: "insufficient_balance", message: "合成额度" } }, want: ENTRY_CODES.QUOTA },
    {
      status: 429,
      body: { error: { code: "insufficient_quota", message: "合成额度" } },
      want: ENTRY_CODES.QUOTA,
    },
    {
      status: 429,
      body: { error: { type: "rate_limit_exceeded", message: "合成限流" } },
      want: ENTRY_CODES.RATE_LIMITED,
    },
  ];
  for (const c of cases) {
    const { ctx, fetch } = makeExaCtx();
    routeExa(fetch, { status: c.status, body: c.body });
    const res = await settle(exa.search(ctx));
    assert.equal(res.error?.code, c.want, `HTTP ${c.status} ${JSON.stringify(c.body)} → ${c.want}（FB-005）`);
  }
});

test("FB-005 上游 5xx：可降级条目码，且不被归为凭据/额度/限流（TODO-EXA-7）", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  for (const sample of EXA_SERVER_ERRORS) {
    await t.test(sample.id, async () => {
      const { ctx, fetch } = makeExaCtx();
      routeFromResponse(fetch, sample.response);

      const res = await settle(exa.search(ctx));

      assert.equal(res.ok, false, `${sample.id} 必须抛错`);
      assert.ok(DEGRADABLE_CODES.includes(res.error?.code), `${sample.id} 须为可降级条目码，实际 ${res.error?.code}`);
      for (const bad of [ENTRY_CODES.CREDENTIALS, ENTRY_CODES.QUOTA, ENTRY_CODES.RATE_LIMITED]) {
        assert.notEqual(res.error.code, bad, `${sample.id} 不得被归为 ${bad}`);
      }
    });
  }
});

test("FB-005 直连网络：fetch 本身失败（无 HTTP 响应）→ ENTRY_NETWORK", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx, fetch } = makeExaCtx();
  fetch.when(/api\.exa\.ai/).fails({ error: new TypeError("合成 fetch failed（无响应）") });

  const res = await settle(exa.search(ctx));

  assert.equal(res.ok, false, "网络故障必须抛错");
  assert.equal(res.error?.code, ENTRY_CODES.NETWORK, "无 HTTP 响应的 transport 故障 → ENTRY_NETWORK（FB-005）");
});

test("FB-005 程序违约：ctx.fetch 不可用属内部违约，抛出时不得带 ENTRY 码（向调用方暴露）", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const { ctx } = makeExaCtx();
  ctx.fetch = undefined;

  const res = await settle(exa.search(ctx));

  assert.equal(res.ok, false, "缺少 fetch 必须抛错");
  assert.ok(
    !Object.values(ENTRY_CODES).includes(res.error?.code),
    "程序违约不得被包装为可降级 ENTRY 码（FB-005「内部程序违约向调用方暴露」）",
  );
});

test("FB-005 分类器（共享映射）：classifyUpstreamFailure 对 Exa 相关输入给出规格码（依赖 WP5）", async (t) => {
  const res = await tryImportSrc("search.js");
  failIfUnimplemented(t, res, "WP5 src/search.js", "FB-005 classifyUpstreamFailure（Exa 输入）");
  const classify = res.module.classifyUpstreamFailure;
  assert.equal(typeof classify, "function", "src/search.js 须导出 classifyUpstreamFailure（A4）");

  const table = [
    [{ status: 401, phase: "response" }, ENTRY_CODES.CREDENTIALS],
    [{ status: 403, phase: "response" }, ENTRY_CODES.CREDENTIALS],
    [{ status: 402, phase: "response" }, ENTRY_CODES.QUOTA],
    [{ status: 429, upstreamCode: "insufficient_quota", phase: "response" }, ENTRY_CODES.QUOTA],
    [{ status: 429, phase: "response" }, ENTRY_CODES.RATE_LIMITED],
    [{ phase: "response", status: 200 }, ENTRY_CODES.BAD_RESPONSE],
    [{ phase: "transport", error: new TypeError("合成 fetch failed") }, ENTRY_CODES.NETWORK],
    [{ phase: "timeout" }, ENTRY_CODES.TIMEOUT],
  ];
  for (const [info, want] of table) {
    assert.equal(classify(info), want, `classifyUpstreamFailure(${JSON.stringify({ ...info, error: undefined })}) 须为 ${want}（FB-005）`);
  }
  // 5xx 具体码未定（TODO-EXA-7）：只断言为可降级码。
  assert.ok(DEGRADABLE_CODES.includes(classify({ status: 503, phase: "response" })), "503 须为可降级条目码（TODO-EXA-7）");
  // 终态码不得由单条目分类器产生。
  assert.ok(!Object.values(CHAIN_CODES).includes(classify({ status: 401, phase: "response" })), "分类器只产出条目码");
});

test("EXA-001 空与失败分界：同一有效 results 结构内，空数组与坏结构的结果互不混淆", async (t) => {
  const exa = await loadExaBackend(t, CLAUSE);
  const empty = makeExaCtx();
  routeExa(empty.fetch, { status: 200, body: exaOk([]) });
  const bad = makeExaCtx();
  routeExa(bad.fetch, { status: 200, body: exaOk([exaResult(1, { url: "relative" })]) });

  const okRes = await settle(exa.search(empty.ctx));
  const badRes = await settle(exa.search(bad.ctx));

  assert.equal(okRes.ok, true, "空数组为无结果");
  assert.equal(badRes.ok, false, "全部无效来源为响应失败");
  assert.equal(badRes.error?.code, ENTRY_CODES.BAD_RESPONSE);
});
