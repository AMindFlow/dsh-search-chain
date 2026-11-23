// WP5 验收 — classifyUpstreamFailure（FB-005 上游失败 → 条目码映射）与链码映射待办。
// 已定部分（钉死）：402 或 insufficient_quota → QUOTA；其他 429 → RATE_LIMITED；401/403 → CREDENTIALS；
// timeout → TIMEOUT；transport 无状态 → NETWORK；响应解析失败 → BAD_RESPONSE。
// 样本：test/fixtures/upstream/http-outcomes.json（Tavily 432 归 TAV-002 适配器细分，不在此钉死）。
// 输入形状（contract.js A4）：info = { status?, upstreamCode?, phase?, error? }；解析失败 = phase "response" + SyntaxError。
// 集中待办（唯一一处，未定）：末尾「待办」测试，覆盖 (a) 链码→宿主 WebError.code 映射（WP0 风险①/HOST-5）、
// (b) PROXY 信号形态、(c) CONTENT_POLICY 判定字段、(d) CHANNEL_LIMIT 信号形态。定名后替换为具体断言。
// 实现模块：src/search.js（export classifyUpstreamFailure）。尚未实现时全部为红，不得改为 skip。
import test from "node:test";
import assert from "node:assert/strict";
import { ENTRY_CODES } from "./helpers/contract.js";
import { loadFixture, FIXTURE_NAMES } from "./helpers/fixtures.js";
import { loadSearch } from "./helpers/search-oracle.js";

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

test("FB-005：上游结局样本（http-outcomes.json）逐条映射到规定的条目码", async (t) => {
  const classify = await loadClassify(t);
  const fixture = loadFixture(FIXTURE_NAMES.upstreamErrors);
  let checked = 0;
  for (const outcome of fixture.outcomes) {
    if (outcome.id === "channel-limit-tavily-432") continue; // TAV-002 细分归适配器
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
  assert.ok(checked >= 7, "FB-005：样本覆盖不应缩水");
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

test("待办·WP0 风险①：链码→宿主 WebError.code 映射与 PROXY/CONTENT_POLICY/CHANNEL_LIMIT 输入信号形态", (t) => {
  t.diagnostic(
    "[WP0 oracle] 待办（唯一集中处）：(a) CHAIN_CODES→宿主 WebError.code 最终映射（HOST-5）；" +
      "(b) PROXY 信号形态；(c) CONTENT_POLICY 判定字段；(d) CHANNEL_LIMIT 信号形态。",
  );
  assert.fail(
    "待办未定：链码→宿主 WebError.code 映射与 PROXY/CONTENT_POLICY/CHANNEL_LIMIT 输入信号尚未定名，" +
      "等待 WP5 宿主验收定名（WP0 风险①）——红属预期，定名后替换本测试，勿改为 skip",
  );
});
