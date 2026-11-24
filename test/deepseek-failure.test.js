// WP8 DeepSeek 空结果与失败分界验收（docs/specs/draft/deepseek.md DSK-002/DSK-004；
// 分类依据 fallback.md FB-004/FB-005；对照 test/fixtures/upstream/http-outcomes.json）。
// 全红：src/backends/deepseek.js 尚未实现，等待 WP8；classifyUpstreamFailure 段另等 WP5 src/search.js。
// 覆盖条款：
//   DSK-004「空数组报告正常无结果」；DSK-002「搜索结果块明确返回空数组且没有工具错误时，报告正常无
//     结果」；DSK-002 HTTP 200 内 web_search_tool_result_error 必须识别，其中 too_many_requests → 限流；
//   DSK-002 只模型回答/结构无效/工具错误 → 通道失败（与正常空结果不同状态，FB-001 降级条件）；
//   FB-005 分类：401→凭据、402→额度、429+insufficient_quota→额度、其他 429→限流、403→按 FB-005
//     （DeepSeek 无 Bing 式拦截细分）、200 非 JSON→异常响应、网络失败→直连网络、5xx→可降级非前三类；
//     insufficient_quota 优先于任何 HTTP 状态码分支（403/400 载体亦归额度），403 无码回归 CREDENTIALS；
//   FB-005「程序违约向调用方暴露」；DeepSeek 无特殊状态码细分，通用结局在两模式一致。
// 样本：登记 fixture upstream/http-outcomes.json + helpers/deepseek-oracle.js 内联（S7）。
// 待办：helpers/deepseek-oracle.js 头注 S1..S7；test/deepseek-pending.test.js P1..P8。
import test from "node:test";
import assert from "node:assert/strict";
import { ENTRY_CODES, CHAIN_CODES } from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import {
  DEGRADABLE_CODES,
  DSK_SERVER_ERRORS,
  agenticOk,
  dsApiOk,
  dsEmptyResultBlock,
  dsSearchResult,
  dsTextBlock,
  dsToolErrorBlock,
  dsToolResultBlock,
  endpointOf,
  loadDeepseek,
  makeCtx,
  routeFor,
  routeFromResponse,
  settle,
  sharedUpstreamOutcomes,
} from "./helpers/deepseek-oracle.js";

const AG = "deepseek-agentic-search";
const API = "deepseek-search";

// ─── 正常空结果 vs 失败（FB-004 / DSK-002 / DSK-004）─────────────────────────

test("DSK-004 正常空结果：results:[] resolve sources:[]，与结构失败路径不同状态", async (t) => {
  const backend = await loadDeepseek(t, API, "DSK-004 空结果分界");
  const empty = makeCtx({ type: API });
  routeFor(empty.fetch, API, { status: 200, body: dsApiOk([]) });
  const bad = makeCtx({ type: API });
  routeFor(bad.fetch, API, { status: 200, body: dsApiOk([{ title: "无 url" }]) });

  const okRes = await settle(backend.search(empty.ctx));
  const badRes = await settle(backend.search(bad.ctx));

  assert.equal(okRes.ok, true, "空数组是无结果不是错误（DSK-004/FB-004）");
  assert.deepEqual(okRes.value.sources, []);
  assert.equal(badRes.ok, false, "全部无效是响应失败（DSK-004）");
  assert.equal(badRes.error?.code, ENTRY_CODES.BAD_RESPONSE);
});

test("DSK-002 正常空结果：结果块 content:[] 且无工具错误 → sources:[]，不抛错", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-002 空数组块");
  const { ctx, fetch } = makeCtx({ type: AG });
  routeFor(fetch, AG, { status: 200, body: agenticOk([dsEmptyResultBlock(), dsTextBlock()]) });
  const res = await settle(backend.search(ctx));
  assert.equal(res.ok, true, "明确空数组且无工具错误是正常无结果（DSK-002）");
  assert.deepEqual(res.value.sources, [], "sources 为空数组（FB-004 明确无结果）");
  assert.equal(res.value.content, undefined, "空结果不带 content（纯来源，FB-002）");
});

test("DSK-002 混合块：空块与有效块并存 → 有效块来源保留，整次不算失败", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-002 混合块");
  const { ctx, fetch } = makeCtx({ type: AG });
  routeFor(fetch, AG, {
    status: 200,
    body: agenticOk([
      dsEmptyResultBlock("srvtoolu_synth_1"),
      dsToolResultBlock([dsSearchResult(1)], "srvtoolu_synth_2"),
      dsTextBlock(),
    ]),
  });
  const res = await settle(backend.search(ctx));
  assert.equal(res.ok, true, "只要存在实际搜索结果就不失败（DSK-002）");
  assert.deepEqual(res.value.sources.map((s) => s.url), [dsSearchResult(1).url]);
});

test("DSK-002 空块与工具错误并存：「没有工具错误」是正常空结果前提，共存时是通道失败", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-002 空块+错误");
  const { ctx, fetch } = makeCtx({ type: AG });
  routeFor(fetch, AG, {
    status: 200,
    body: agenticOk([dsEmptyResultBlock(), dsToolErrorBlock("too_many_requests", "srvtoolu_synth_2")]),
  });
  const res = await settle(backend.search(ctx));
  assert.equal(res.ok, false, "带工具错误时不得报告正常无结果（DSK-002「且没有工具错误」）");
  assert.ok(DEGRADABLE_CODES.includes(res.error?.code), `须为可降级条目码（FB-005），实际：${res.error?.code}`);
});

test("DSK-002 只模型回答：未触发工具 → 通道失败（BAD_RESPONSE 推断，见 pending P6）", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-002 无工具结果块");
  const { ctx, fetch } = makeCtx({ type: AG });
  routeFor(fetch, AG, { status: 200, body: agenticOk([dsTextBlock("合成正文，未触发任何搜索工具。")]) });
  const res = await settle(backend.search(ctx));
  assert.equal(res.ok, false, "只有模型回答而未触发工具是通道失败（DSK-002）");
  assert.equal(res.error?.code, ENTRY_CODES.BAD_RESPONSE, "「结果结构无效」类归 ENTRY_BAD_RESPONSE（FB-005；P6）");
});

test("DSK-002 结构无效块：结果块 content 缺失/非数组、顶层 content 非数组、响应根缺字段、项为非对象标量 → BAD_RESPONSE", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-002 结构无效");
  const shapes = [
    agenticOk([{ type: "web_search_tool_result", tool_use_id: "t1" }]),
    agenticOk([{ type: "web_search_tool_result", tool_use_id: "t1", content: "not-array" }]),
    agenticOk([{ type: "web_search_tool_result", tool_use_id: "t1", content: {} }]),
    { ...agenticOk([]), content: "not-array" },
    { id: "no-content-field" },
    agenticOk([{ type: "web_search_tool_result", tool_use_id: "t1", content: ["string-item", 42] }]),
  ];
  for (const [i, body] of shapes.entries()) {
    const { ctx, fetch } = makeCtx({ type: AG });
    routeFor(fetch, AG, { status: 200, body });
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, false, `结构无效样本 #${i} 必须失败（DSK-002「结果结构无效」）`);
    assert.equal(res.error?.code, ENTRY_CODES.BAD_RESPONSE, `结构无效样本 #${i} → ENTRY_BAD_RESPONSE（FB-005）`);
  }
});

// ─── HTTP 层分类（FB-005，两模式共用 DeepSeek 鉴权与状态语义）────────────────

test("FB-005 共享结局：401/402/429(insufficient_quota)/429/403-HTML/200 坏 JSON 在两模式映射同码且可降级", async (t) => {
  const outcomes = sharedUpstreamOutcomes();
  assert.ok(outcomes.length >= 5, "共享结局须至少含鉴权/额度(insufficient_quota)/限流/403/坏 JSON（卫生前置）");
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `FB-005 共享结局（${type}）`);
    for (const outcome of outcomes) {
      await t.test(`${type} ${outcome.id}`, async () => {
        const { ctx, fetch } = makeCtx({ type });
        routeFromResponse(fetch, type, outcome.response);
        const res = await settle(backend.search(ctx));
        assert.equal(res.ok, false, `${outcome.id} 必须抛错`);
        assert.equal(res.error?.code, outcome.expect.code, `${outcome.id} → ${outcome.expect.code}（FB-005/http-outcomes.json）`);
        assert.ok(DEGRADABLE_CODES.includes(res.error.code), `${outcome.id} 须可降级（FB-001/FB-005）`);
      });
    }
  }
});

test("FB-005 DeepSeek 403：按 FB-005 通用归类 ENTRY_CREDENTIALS（拦截细分属 Bing BING-002，DeepSeek 无特例）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `FB-005 403（${type}）`);
    const { ctx, fetch } = makeCtx({ type });
    routeFor(fetch, type, { status: 403, body: { error: { type: "permission_denied", message: "synthetic 403" } } });
    const res = await settle(backend.search(ctx));
    assert.equal(res.error?.code, ENTRY_CODES.CREDENTIALS, "403 → 凭据或权限（FB-005 类目 + http-outcomes 口径）");
  }
});

test("FB-005 额度与限流：402 与 429+insufficient_quota → QUOTA；其他 429 → RATE_LIMITED（两模式）", async (t) => {
  const cases = [
    { status: 402, body: { error: { type: "insufficient_balance", message: "合成额度" } }, want: ENTRY_CODES.QUOTA },
    { status: 429, body: { error: { code: "insufficient_quota", message: "合成额度" } }, want: ENTRY_CODES.QUOTA },
    { status: 429, body: { error: { type: "rate_limit_reached", message: "合成限流" } }, want: ENTRY_CODES.RATE_LIMITED },
  ];
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `FB-005 额度限流（${type}）`);
    for (const c of cases) {
      const { ctx, fetch } = makeCtx({ type });
      routeFor(fetch, type, { status: c.status, body: c.body });
      const res = await settle(backend.search(ctx));
      assert.equal(res.error?.code, c.want, `${type} HTTP ${c.status} ${JSON.stringify(c.body.error)} → ${c.want}（FB-005 明文）`);
    }
  }
});

test("FB-005 额度优先级：403 携带 insufficient_quota → QUOTA（上游码优先于状态码，两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `FB-005 quota 优先 403（${type}）`);
    const { ctx, fetch } = makeCtx({ type });
    routeFor(fetch, type, {
      status: 403,
      body: { error: { code: "insufficient_quota", message: "合成额度（403 载体）" } },
    });
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, false, `${type} HTTP 403 必须抛错`);
    assert.equal(
      res.error?.code,
      ENTRY_CODES.QUOTA,
      `${type} 403+insufficient_quota → QUOTA（FB-005：insufficient_quota 优先于任何 HTTP 状态码分支），实际：${res.error?.code}`,
    );
  }
});

test("FB-005 额度优先级：400 携带 insufficient_quota → QUOTA（上游码优先于状态码，两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `FB-005 quota 优先 400（${type}）`);
    const { ctx, fetch } = makeCtx({ type });
    routeFor(fetch, type, {
      status: 400,
      body: { error: { code: "insufficient_quota", message: "合成额度（400 载体）" } },
    });
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, false, `${type} HTTP 400 必须抛错`);
    assert.equal(
      res.error?.code,
      ENTRY_CODES.QUOTA,
      `${type} 400+insufficient_quota → QUOTA（FB-005：insufficient_quota 优先于任何 HTTP 状态码分支），实际：${res.error?.code}`,
    );
  }
});

test("FB-005 回归：403 不带 insufficient_quota 码 → CREDENTIALS（优先级分支不得吞掉普通 403，两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `FB-005 403 回归（${type}）`);
    const { ctx, fetch } = makeCtx({ type });
    routeFor(fetch, type, {
      status: 403,
      body: { error: { type: "permission_denied", message: "合成 403 无额度码" } },
    });
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, false, `${type} HTTP 403 必须抛错`);
    assert.equal(
      res.error?.code,
      ENTRY_CODES.CREDENTIALS,
      `${type} 403 无 insufficient_quota 码仍按状态码归 CREDENTIALS（回归，FB-005），实际：${res.error?.code}`,
    );
  }
});

test("FB-005 5xx：两模式可降级条目码，且不被归为凭据/额度/限流（同族先例 TODO-EXA-7）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `FB-005 5xx（${type}）`);
    for (const sample of DSK_SERVER_ERRORS) {
      await t.test(`${type} ${sample.id}`, async () => {
        const { ctx, fetch } = makeCtx({ type });
        routeFromResponse(fetch, type, sample.response);
        const res = await settle(backend.search(ctx));
        assert.equal(res.ok, false, `${sample.id} 必须抛错`);
        assert.ok(DEGRADABLE_CODES.includes(res.error?.code), `${sample.id} 须可降级，实际 ${res.error?.code}`);
        for (const bad of [ENTRY_CODES.CREDENTIALS, ENTRY_CODES.QUOTA, ENTRY_CODES.RATE_LIMITED]) {
          assert.notEqual(res.error.code, bad, `${sample.id} 不得归为 ${bad}`);
        }
      });
    }
  }
});

test("FB-005 非 JSON：200 且正文不可解析 → BAD_RESPONSE（两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `FB-005 非 JSON（${type}）`);
    const { ctx, fetch } = makeCtx({ type });
    routeFor(fetch, type, {
      status: 200,
      body: "{ 这不是合法 JSON (synthetic)",
      headers: { "content-type": "application/json" },
    });
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, false, "不可解析响应必须失败（FB-005 异常响应）");
    assert.equal(res.error?.code, ENTRY_CODES.BAD_RESPONSE);
  }
});

test("FB-005 直连网络：fetch 抛网络错误（无 HTTP 响应）→ ENTRY_NETWORK（两模式）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `FB-005 网络（${type}）`);
    const { ctx, fetch } = makeCtx({ type });
    fetch.when(endpointOf(type)).fails({ error: new TypeError("合成 fetch failed（无响应）") });
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, false, "网络故障必须抛错");
    assert.equal(res.error?.code, ENTRY_CODES.NETWORK, "transport 故障 → ENTRY_NETWORK（FB-005）");
  }
});

test("DSK-002 in-band 限流：HTTP 200 的 web_search_tool_result_error(too_many_requests) → ENTRY_RATE_LIMITED", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-002 tool error 限流");
  const { ctx, fetch } = makeCtx({ type: AG });
  routeFor(fetch, AG, { status: 200, body: agenticOk([dsToolErrorBlock("too_many_requests")]) });
  const res = await settle(backend.search(ctx));
  assert.equal(res.ok, false, "in-band 工具错误必须失败（DSK-002「HTTP 200 中的…也须识别」）");
  assert.equal(res.error?.code, ENTRY_CODES.RATE_LIMITED, "too_many_requests 分类为限流（DSK-002 明文）");
});

test("DSK-002 in-band 其他错误码：可降级条目码（具体归类见 pending P4）", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-002 tool error 其他码");
  for (const code of ["tool_exec_timeout", "invalid_tool_input"]) {
    const { ctx, fetch } = makeCtx({ type: AG });
    routeFor(fetch, AG, { status: 200, body: agenticOk([dsToolErrorBlock(code)]) });
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, false, `工具错误 ${code} 必须失败（DSK-002）`);
    assert.ok(DEGRADABLE_CODES.includes(res.error?.code), `工具错误 ${code} 须可降级，实际：${res.error?.code}`);
  }
});

test("FB-005 程序违约：ctx.fetch 缺失时抛出的错误不得携带 ENTRY 码（向调用方暴露）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `FB-005 程序违约（${type}）`);
    const { ctx } = makeCtx({ type });
    ctx.fetch = undefined;
    const res = await settle(backend.search(ctx));
    assert.equal(res.ok, false, "缺少 fetch 必须抛错");
    assert.ok(
      !Object.values(ENTRY_CODES).includes(res.error?.code),
      "程序违约不得包装为可降级 ENTRY 码（FB-005「内部程序违约向调用方暴露」）",
    );
  }
});

test("FB-005 分类器（共享映射）：classifyUpstreamFailure 对 DeepSeek 输入给出规格码（依赖 WP5）", async (t) => {
  const res = await tryImportSrc("search.js");
  failIfUnimplemented(t, res, "WP5 src/search.js", "FB-005 classifyUpstreamFailure（DeepSeek 输入）");
  const classify = res.module.classifyUpstreamFailure;
  assert.equal(typeof classify, "function", "src/search.js 须导出 classifyUpstreamFailure（A4）");
  const table = [
    [{ status: 401, phase: "response" }, ENTRY_CODES.CREDENTIALS],
    [{ status: 403, phase: "response" }, ENTRY_CODES.CREDENTIALS],
    [{ status: 402, phase: "response" }, ENTRY_CODES.QUOTA],
    [{ status: 429, upstreamCode: "insufficient_quota", phase: "response" }, ENTRY_CODES.QUOTA],
    [{ status: 429, phase: "response" }, ENTRY_CODES.RATE_LIMITED],
    [{ phase: "transport", error: new TypeError("合成 fetch failed") }, ENTRY_CODES.NETWORK],
    [{ phase: "timeout" }, ENTRY_CODES.TIMEOUT],
  ];
  for (const [info, want] of table) {
    assert.equal(classify({ ...info }), want, `classifyUpstreamFailure(${JSON.stringify({ ...info, error: String(info.error ?? "") })}) 须为 ${want}（FB-005）`);
  }
  assert.ok(DEGRADABLE_CODES.includes(classify({ status: 503, phase: "response" })), "503 须为可降级条目码（同族 TODO-EXA-7）");
  assert.ok(!Object.values(CHAIN_CODES).includes(classify({ status: 401, phase: "response" })), "分类器只产出条目码，不产出终态码（A7）");
});
