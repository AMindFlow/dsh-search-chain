// WP5 验收 — classifyUpstreamFailure（FB-005 上游失败 → 条目码映射）与链码闭合结构断言。
//
// 已定并钉死的映射（FB-005 / fixtures upstream/http-outcomes.json）：
//   402 或 upstreamCode=insufficient_quota → QUOTA（优先于 429）；其他 429 → RATE_LIMITED；
//   401 / 403（含访问受限拦截页）→ CREDENTIALS；phase=timeout → TIMEOUT；
//   phase=transport 且无 HTTP 状态 → NETWORK；响应解析失败（phase=response + SyntaxError）→ BAD_RESPONSE。
//
// 样本排除语义：http-outcomes.json 共 7 条，其中 channel-limit-tavily-432（Tavily 用量超限）
//   按 TAV-002 归适配器细分，通用分类器不作判定（FB-005「针对具体接口的错误细分由适配规格定义」），
//   故样本断言覆盖 6 条（checked === 6）。排除是显式的，不是断言缩水。
//
// 输入形状假设（contract.js A4）：info = { status?, upstreamCode?, phase?, error? }。
//
// 结构性断言（今日可判定，不再无条件红）：
//   S1 classifyUpstreamFailure 对链级输入不产出 PROXY / CONTENT_POLICY / CHANNEL_LIMIT 三码——
//      这三码只允许适配器直接赋码（FB-005「细分由适配规格定义」），链级分类器不得自行推断。
//   S2 CHAIN_CODES 闭合：链级终态错误的 code 只能落在 CHAIN_CODES 已定义集合内，且集合本身无重复、同一前缀。
//
// 协调裁决（lead，WP0 风险①，2026-11-24）：DSH-002 要求链终态 WebError 原样同一对象透传，
//   宿主 WebError.code 为开放字符串，因此链码→宿主码不做改名映射、直接透传。
//   dev 提出的 WEB_SEARCH_* 映射表仅存档，不采纳。
//   注：仓库内 dsh-integration.md 的 DSH-002 原文为「报告 FB-004 的空配置或其他终态」，未逐字写「原样透传」。
//   该裁决依据是协调记录，WP6 宿主核对时须对照 DSH-002 原文确认。
//
// 宿主核对清单（WP6 承接，未定，本文件不断言）：
//   (a) 若 WP6 推翻直传裁决，需新增链码→宿主码映射测试，Issue 留痕；
//   (b) PROXY 信号形态（CFG-005 PAC 阶段码是否直接映射为条目码）；
//   (c) CONTENT_POLICY 判定字段（上游内容策略拒绝在 info 中如何表示）；
//   (d) CHANNEL_LIMIT 信号形态（如 brave 超长查询的判定方式）。
//
// 实现模块：src/search.js（export classifyUpstreamFailure、createSearchChain）。尚未实现时全部为红，不得改为 skip。
import test from "node:test";
import assert from "node:assert/strict";
import { ENTRY_CODES, CHAIN_CODES, makeEntry } from "./helpers/contract.js";
import { loadFixture, FIXTURE_NAMES } from "./helpers/fixtures.js";
import { stepFail, stepHang } from "./helpers/fake-backend.js";
import { DEFAULT_QUERY } from "./helpers/chain-harness.js";
import { loadSearch, chainHarness, keyedEntry, refsFor } from "./helpers/search-oracle.js";

const CLAUSES = "FB-005";

async function loadClassify(t) {
  const mod = await loadSearch(t, CLAUSES);
  if (typeof mod.classifyUpstreamFailure !== "function") {
    t.diagnostic("[WP0 oracle] FB-005: 等待实现 WP5 src/search.js 导出 classifyUpstreamFailure（contract.js A4）");
    assert.fail("等待实现 WP5：缺少导出 classifyUpstreamFailure（FB-005）——红属预期，勿改为 skip");
  }
  return mod.classifyUpstreamFailure;
}

const VALID_ENTRY_CODES = new Set(Object.values(ENTRY_CODES));
const VALID_CHAIN_CODES = new Set(Object.values(CHAIN_CODES));
// 只允许适配器直接赋码的三码（S1）。
const ADAPTER_ONLY_CODES = [ENTRY_CODES.PROXY, ENTRY_CODES.CONTENT_POLICY, ENTRY_CODES.CHANNEL_LIMIT];

test("FB-005：上游结局样本（http-outcomes.json）逐条映射到规定的条目码（排除 Tavily 432，见文件头）", async (t) => {
  const classify = await loadClassify(t);
  const fixture = loadFixture(FIXTURE_NAMES.upstreamErrors);
  let checked = 0;
  for (const outcome of fixture.outcomes) {
    if (outcome.id === "channel-limit-tavily-432") continue; // TAV-002 细分归适配器，显式排除
    const body = outcome.response.body;
    const info = {
      status: outcome.response.status,
      upstreamCode: typeof body === "object" && body?.error?.code ? body.error.code : undefined,
      phase: "response",
      ...(outcome.id === "malformed-200" ? { error: new SyntaxError("synthetic unexpected token") } : {}),
    };
    const got = classify(info);
    assert.equal(got, outcome.expect.code, `FB-005 样本 ${outcome.id}（${outcome.describe}）应为 ${outcome.expect.code}，实际 ${got}`);
    checked += 1;
  }
  assert.equal(checked, 6, "FB-005：http-outcomes.json 7 条减去显式排除的 channel-limit-tavily-432，应恰好覆盖 6 条");
});

test("FB-005：显式映射表——网络、超时、鉴权、额度、限流、解析", async (t) => {
  const classify = await loadClassify(t);
  const table = [
    ["直连网络失败（transport，无 HTTP 状态）", { phase: "transport", error: new Error("synthetic ECONNRESET") }, ENTRY_CODES.NETWORK],
    ["单项超时", { phase: "timeout" }, ENTRY_CODES.TIMEOUT],
    ["401 鉴权失败", { status: 401, phase: "response" }, ENTRY_CODES.CREDENTIALS],
    ["403 权限/访问受限", { status: 403, phase: "response" }, ENTRY_CODES.CREDENTIALS],
    ["402 额度", { status: 402, phase: "response" }, ENTRY_CODES.QUOTA],
    ["402 优先于上游限流文案（仍是额度）", { status: 402, upstreamCode: "rate_limit_exceeded" }, ENTRY_CODES.QUOTA],
    ["429 + insufficient_quota → 额度而非限流", { status: 429, upstreamCode: "insufficient_quota" }, ENTRY_CODES.QUOTA],
    ["其他 429 → 限流", { status: 429, phase: "response" }, ENTRY_CODES.RATE_LIMITED],
    ["200 响应无法解析 → 异常响应", { status: 200, phase: "response", error: new SyntaxError("synthetic") }, ENTRY_CODES.BAD_RESPONSE],
  ];
  for (const [label, info, want] of table) {
    const got = classify(info);
    assert.ok(VALID_ENTRY_CODES.has(got), `${label}：返回值必须属于 ENTRY_CODES，实际 ${got}`);
    assert.equal(got, want, `FB-005 ${label}：应为 ${want}，实际 ${got}`);
  }
});

test("FB-005：额度与限流的区分只看 status 与上游 code，不依赖正文文本", async (t) => {
  const classify = await loadClassify(t);
  assert.equal(classify({ status: 429, upstreamCode: "insufficient_quota" }), ENTRY_CODES.QUOTA);
  assert.equal(classify({ status: 429, upstreamCode: "rate_limit_exceeded" }), ENTRY_CODES.RATE_LIMITED);
});

test("S1·FB-005：classifyUpstreamFailure 对链级输入不产出 PROXY / CONTENT_POLICY / CHANNEL_LIMIT（只允许适配器赋码）", async (t) => {
  const classify = await loadClassify(t);
  const chainLevelInputs = [
    { phase: "transport", error: new Error("synthetic ECONNRESET") },
    { phase: "timeout" },
    { status: 401, phase: "response" },
    { status: 403, phase: "response" },
    { status: 402, phase: "response" },
    { status: 429, phase: "response" },
    { status: 429, upstreamCode: "insufficient_quota" },
    { status: 200, phase: "response", error: new SyntaxError("synthetic") },
  ];
  for (const info of chainLevelInputs) {
    const got = classify(info);
    assert.ok(VALID_ENTRY_CODES.has(got), `返回值必须属于 ENTRY_CODES，实际 ${got}（输入 ${JSON.stringify(info.status ?? info.phase)}）`);
    assert.ok(
      !ADAPTER_ONLY_CODES.includes(got),
      `链级分类器不得自行产出适配器专属码 ${got}（FB-005：细分由适配规格定义；见文件头宿主核对清单）`,
    );
  }
});

test("S2·FB-004/FB-005：CHAIN_CODES 闭合——链级终态错误码只落在已定义集合内，且集合无重复、同一前缀", async (t) => {
  const values = Object.values(CHAIN_CODES);
  assert.equal(new Set(values).size, values.length, "CHAIN_CODES 取值不得重复");
  for (const v of values) {
    assert.ok(v.startsWith("CHAIN_"), `CHAIN_CODES 取值须以 CHAIN_ 为前缀，实际 ${v}`);
  }

  // 驱动覆盖各终态场景，收集链实际抛出的 code，要求全部属于 CHAIN_CODES。
  const scenarios = [
    ["空列表", { entries: [] }],
    ["全部缺 key", { entries: [makeEntry({ id: "e-k", type: "openai", name: "无钥条目", enabled: true })] }],
    [
      "内容策略终止",
      {
        entries: [keyedEntry("e-p", "openai", "策略条目")],
        credentialRefs: refsFor("e-p"),
        steps: { "e-p": [stepFail({ code: ENTRY_CODES.CONTENT_POLICY })] },
      },
    ],
    [
      "全部失败",
      {
        entries: [keyedEntry("e-f", "tavily", "失败条目")],
        credentialRefs: refsFor("e-f"),
        steps: { "e-f": [stepFail({ code: ENTRY_CODES.NETWORK })] },
      },
    ],
    [
      "总预算耗尽",
      {
        entries: [keyedEntry("e-h", "exa", "挂起条目")],
        credentialRefs: refsFor("e-h"),
        steps: { "e-h": [stepHang()] },
      },
    ],
  ];

  const observed = [];
  for (const [label, spec] of scenarios) {
    const h = await chainHarness(t, CLAUSES, spec);
    const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));
    observed.push([label, err.code]);
  }
  for (const [label, code] of observed) {
    assert.ok(VALID_CHAIN_CODES.has(code), `场景「${label}」的链终态码必须属于 CHAIN_CODES（闭合），实际 ${code}`);
  }
});
