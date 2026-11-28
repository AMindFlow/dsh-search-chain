// PX-004 「直连失败」触发定义与分类边界 + lead 显式用例 A（未知兜底触发）/B（响应相位反例）。
// Oracle 骨架（工作包 #88）：实现前跑红属预期；两条单元钉为现状语义回归钉（当前应绿）。
import test from "node:test";
import assert from "node:assert/strict";
import { stepSuccess, stepFail, stepHang } from "./helpers/fake-backend.js";
import { ENTRY_CODES, assertSearchResult, assertWebError, CHAIN_CODES, makeEntry } from "./helpers/contract.js";
import { chainHarness, loadSearch, keyedEntry, refsFor } from "./helpers/search-oracle.js";
import { tryImportSrc } from "./helpers/impl.js";

const CLAUSES = "PX-004";
const GLOBAL_REF = "search_chain_global_proxy";
const GLOBAL_URL = "http://syn-user:syn-pass@syn-proxy.invalid:8080";

function routeIsGlobalUpgrade(route) {
  if (!route || typeof route !== "object") return false;
  if (route.viaGlobal === true) return true;
  return typeof route.proxyUrl === "string" && route.proxyUrl.includes("syn-proxy.invalid:8080");
}
function escalationObserved(h, entryId) {
  return (
    h.transport.handles.some((x) => x.entry.id === entryId && routeIsGlobalUpgrade(x.opts)) ||
    h.fetchFn.calls.some((c) => routeIsGlobalUpgrade(c.init?.route))
  );
}

async function triggerHarness(t, steps, extraEntries = []) {
  return chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e1", "tavily", "直连条目"), ...extraEntries],
    credentialRefs: { ...refsFor("e1"), [GLOBAL_REF]: GLOBAL_URL },
    extraConfig: { proxyEscalation: true, globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    steps: { e1: steps },
  });
}

// ─── 单元钉：classifyUpstreamFailure 边界（现状语义回归钉，lead 裁决风险1 依据面）──────

test(`${CLAUSES} 钉A（lead 显式用例 A 单元面）：无阶段无状态码未知失败 → classifyUpstreamFailure 兜底 ENTRY_NETWORK（现状钉，升级触发面前提）`, async () => {
  const res = await tryImportSrc("search.js");
  assert.ok(typeof res.module?.classifyUpstreamFailure === "function", "classifyUpstreamFailure 必须可导入（A4）");
  assert.equal(res.module.classifyUpstreamFailure({}), ENTRY_CODES.NETWORK);
  assert.equal(res.module.classifyUpstreamFailure({ error: new Error("unknown") }), ENTRY_CODES.NETWORK);
});

test(`${CLAUSES} 钉B（lead 显式用例 B 单元面）：已到响应相位（phase="response"）不得归 ENTRY_NETWORK（反例前提）`, async () => {
  const res = await tryImportSrc("search.js");
  assert.equal(res.module.classifyUpstreamFailure({ phase: "response" }), ENTRY_CODES.BAD_RESPONSE);
  assert.notEqual(res.module.classifyUpstreamFailure({ phase: "response" }), ENTRY_CODES.NETWORK);
});

// ─── 三例触发（验收：DNS 失败 / 连接被拒 / 连接超时 → 升级实收到）────────────────────

for (const [label, cause] of [
  ["DNS 解析失败", () => Object.assign(new Error("synthetic getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })],
  ["TCP 连接被拒", () => Object.assign(new Error("synthetic connect ECONNREFUSED"), { code: "ECONNREFUSED" })],
  ["连接超时/不可达", () => Object.assign(new Error("synthetic connect ETIMEDOUT"), { code: "ETIMEDOUT" })],
]) {
  test(`${CLAUSES}：直连 ${label}（ENTRY_NETWORK transport 面）→ 升级出站实收到且同条目经升级成功（验收·三触发例）`, async (t) => {
    const h = await triggerHarness(t, [
      stepFail({ code: ENTRY_CODES.NETWORK, message: `合成 ${label}`, cause: cause() }),
      stepSuccess({ sources: [{ url: "https://synthetic-host.invalid/ok", title: "t", snippet: "s" }] }),
    ]);
    const res = await h.runToValue(h.search());
    assertSearchResult(t, res);
    assert.equal(escalationObserved(h, "e1"), true, `${label} 必须触发升级出站（PX-004）`);
    assert.equal(h.executionCount("e1"), 2, "直连失败后升级重试恰一次（条目内改道，FB-001 每条目一次供应商提交由升级未达供应商前提保证）");
  });
}

// ─── 九例不触发（各零升级出站、FB-005 分类与降级/终止行为不变）──────────────────────

const NON_TRIGGERS = [
  ["401 凭据或权限", ENTRY_CODES.CREDENTIALS],
  ["402/额度证据", ENTRY_CODES.QUOTA],
  ["其他 429 限流", ENTRY_CODES.RATE_LIMITED],
  ["其他 4xx 通道参数", ENTRY_CODES.CHANNEL_LIMIT],
  ["5xx/异常响应（响应相位）", ENTRY_CODES.BAD_RESPONSE],
];
for (const [label, code] of NON_TRIGGERS) {
  test(`${CLAUSES}：${label}（${code}）→ 零升级出站，FB-005 分类与降级不变（验收·九不触发例）`, async (t) => {
    const h = await triggerHarness(t, [stepFail({ code })], [keyedEntry("e2", "bing", "兜底", { })]);
    h.backend("bing");
    const err = await h.runToError(h.search());
    assert.equal(escalationObserved(h, "e1"), false, `${label} 不得触发升级（PX-004）`);
    assert.equal(h.executionCount("e1"), 1, "不触发即不得二次执行");
    assert.ok(err.details.attempts.some((a) => a.entryId === "e1" && a.code === code), "原分类码保持（FB-005/FB-006）");
  });
}

test(`${CLAUSES}：条目预算到期 ENTRY_TIMEOUT → 零升级出站（验收·九不触发例；码语义见 PX-005）`, async (t) => {
  const h = await triggerHarness(t, [stepHang()], [keyedEntry("e2", "bing", "兜底")]);
  h.backend("bing");
  try {
    await h.runUntilSettled(h.search(), 60_000);
  } catch {}
  assert.equal(escalationObserved(h, "e1"), false, "条目预算到期不得触发升级（PX-004）");
});

test(`${CLAUSES}：内容策略拒绝 ENTRY_CONTENT_POLICY → 终止整链、零升级出站（验收·九不触发例）`, async (t) => {
  const h = await triggerHarness(t, [stepFail({ code: ENTRY_CODES.CONTENT_POLICY })]);
  const err = await h.runToError(h.search());
  assert.equal(escalationObserved(h, "e1"), false);
  assert.equal(err.code, CHAIN_CODES.CONTENT_POLICY, "内容策略维持 FB-001 终止面");
});

test(`${CLAUSES}：缺凭据条目（SKIPPED_NO_KEY 跳过）→ 零执行零升级出站（验收·九不触发例）`, async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [makeEntry({ id: "e1", type: "tavily", name: "缺key条目", enabled: true })],
    credentialRefs: { [GLOBAL_REF]: GLOBAL_URL },
    extraConfig: { proxyEscalation: true, globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    steps: {},
  });
  await h.runToError(h.search()).catch(() => {});
  assert.equal(h.executionCount("e1"), 0);
  assert.equal(escalationObserved(h, "e1"), false, "跳过条目无「直连失败」可言，不升级");
});

test(`${CLAUSES}：宿主取消 → 整链终止、零升级出站（验收·九不触发例）`, async (t) => {
  const h = await triggerHarness(t, [stepHang()]);
  const ac = new AbortController();
  const p = h.search({ query: "合成查询" }, ac.signal);
  await new Promise((r) => setImmediate(r));
  ac.abort();
  await h.runUntilSettled(p).catch(() => {});
  assert.equal(escalationObserved(h, "e1"), false, "FB-003 终止面不升级");
});

// ─── lead 显式用例 A（链层）：未知兜底 ENTRY_NETWORK 触发升级 ────────────────────────

test(`${CLAUSES} 用例A（lead 指定，链层）：无阶段无状态码未知失败兜底 ENTRY_NETWORK 必须触发升级——「触发面偏宽」按裁决钉为规格语义`, async (t) => {
  const h = await triggerHarness(t, [
    stepFail({ code: ENTRY_CODES.NETWORK, message: "合成失败（无阶段、无状态码、无 cause）" }),
    stepSuccess({ sources: [{ url: "https://synthetic-host.invalid/ok", title: "t", snippet: "s" }] }),
  ]);
  await h.runToValue(h.search());
  assert.equal(escalationObserved(h, "e1"), true, "未知兜底 NETWORK 触发升级（PR#103 风险1 裁决：显式钉住）");
});

// ─── 升级至多一次：不回退直连、不二次升级（要求2）──────────────────────────────────

test(`${CLAUSES}：升级路由上再失败 → 总执行 ≤2、无第三次出站、不回退直连、条目以最终失败落定（要求2）`, async (t) => {
  const h = await triggerHarness(t, [
    stepFail({ code: ENTRY_CODES.NETWORK, message: "直连失败" }),
    stepFail({ code: ENTRY_CODES.NETWORK, message: "升级路由连接被拒" }),
  ]);
  const err = await h.runToError(h.search());
  assert.equal(h.executionCount("e1"), 2, "至多一次升级：无第三次执行");
  const opens = h.transport.handleFor("e1");
  assert.ok(opens.length <= 2, `transport.open 至多直连+升级两次，实际 ${opens.length}`);
  assertWebError(err, { code: CHAIN_CODES.UPSTREAM_FAILURES, attempts: [{ entryId: "e1", code: ENTRY_CODES.NETWORK }] });
  assert.equal(err.details.attempts.length, 1, "attempts 仍按条目一条（PX-007/008 设计决定）");
});
