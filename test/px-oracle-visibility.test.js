// PX-007 升级成功事件可见性（content 首行状态行/日志/sources 不变）+ PX-008 升级失败事件可见性与终态归属。
// Oracle 骨架（工作包 #88）：实现前跑红属预期。观测面 O6/O7/O8。
import test from "node:test";
import assert from "node:assert/strict";
import { stepSuccess, stepFail } from "./helpers/fake-backend.js";
import { ENTRY_CODES, assertSearchResult, assertWebError, CHAIN_CODES } from "./helpers/contract.js";
import { chainHarness, keyedEntry, refsFor } from "./helpers/search-oracle.js";
import { assertNoSecrets } from "./helpers/redact.js";

const CLAUSES = "PX-007/PX-008";
const GLOBAL_REF = "search_chain_global_proxy";
const GLOBAL_URL = "http://syn-user:syn-pass@syn-proxy.invalid:8080";
const SYN = ["syn-user", "syn-pass", "syn-proxy.invalid:8080/path"];

function harness(t, steps2, { escalation = true, entries, stepsById } = {}) {
  return chainHarness(t, CLAUSES, {
    entries: entries ?? [keyedEntry("e1", "tavily", "直连条目")],
    credentialRefs: { ...refsFor("e1", "e2"), [GLOBAL_REF]: GLOBAL_URL },
    extraConfig: escalation ? { proxyEscalation: true, globalProxy: GLOBAL_REF } : {},
    useOfficialDeepSeekSearch: false,
    steps: stepsById ?? { e1: steps2 },
  });
}

const ESC_OK = [
  stepFail({ code: ENTRY_CODES.NETWORK, message: "合成 DNS 失败" }),
  stepSuccess({ sources: [{ url: "https://synthetic-host.invalid/ok?n=1", title: "T1", snippet: "S1" }] }),
];

// ─── PX-007 升级成功 ─────────────────────────────────────────────────────────────

test(`${CLAUSES} PX-007 验收1：升级成功 content 首行含条目名+「全局代理升级」+脱敏目标；全面向 syn-pass 零检索`, async (t) => {
  const h = await harness(t, ESC_OK);
  const res = await h.runToValue(h.search());
  const firstLine = String(res.content ?? "").split("\n")[0];
  assert.match(firstLine, /直连条目/, `首行含实际使用条目名（FB-002 机制）：${firstLine}`);
  assert.match(firstLine, /(全局代理|升级)/, `首行含升级事件要素：${firstLine}`);
  assert.match(firstLine, /syn-proxy\.invalid:8080/, `首行含脱敏目标 scheme://host:port：${firstLine}`);
  assertNoSecrets(t, res, ["syn-user", "syn-pass"], "PX-007 content 零认证信息");
  assertNoSecrets(t, h.logCapture.lines.join("\n"), ["syn-user", "syn-pass"], "PX-007 日志零认证信息");
});

test(`${CLAUSES} PX-007 验收2：未经升级的直连成功首行无升级字样（与 v0.2.0 呈现一致）`, async (t) => {
  const h = await harness(t, [stepSuccess({ sources: [{ url: "https://synthetic-host.invalid/ok", title: "T", snippet: "S" }] })]);
  const res = await h.runToValue(h.search());
  const head = String(res.content ?? "").split("\n")[0];
  assert.ok(!/升级|全局代理/.test(head), `直连成功首行不得含升级字样：${head}`);
});

test(`${CLAUSES} PX-007 验收3：升级成功的 sources 与无升级基线逐字段一致（升级信息不进 sources）`, async (t) => {
  const base = [{ url: "https://synthetic-host.invalid/ok?n=1", title: "T1", snippet: "S1" }];
  const hOn = await harness(t, [
    stepFail({ code: ENTRY_CODES.NETWORK }),
    stepSuccess({ sources: structuredClone(base) }),
  ]);
  const hOff = await harness(t, [stepSuccess({ sources: structuredClone(base) })], { escalation: false });
  const [on, off] = [await hOn.runToValue(hOn.search()), await hOff.runToValue(hOff.search())];
  assert.deepEqual(on.sources, off.sources, "sources 与无升级基线逐字段一致（PX-007 验收3）");
  for (const s of on.sources) {
    assert.deepEqual(Object.keys(s).sort(), Object.keys(off.sources[0]).sort(), "sources 不新增代理字段");
  }
  assertSearchResult(t, on);
});

test(`${CLAUSES} PX-007 日志：升级事件记录条目 id 与脱敏目标（调试日志面）`, async (t) => {
  const h = await harness(t, ESC_OK);
  await h.runToValue(h.search());
  const joined = h.logCapture.lines.join("\n");
  assert.match(joined, /e1/, "日志含条目 id");
  assert.match(joined, /syn-proxy\.invalid:8080/, "日志含脱敏目标");
  assertNoSecrets(t, joined, ["syn-user", "syn-pass"], "PX-007 日志脱敏（CFG-003）");
});

// ─── PX-008 升级失败 ─────────────────────────────────────────────────────────────

const ESC_FAIL = [
  stepFail({ code: ENTRY_CODES.NETWORK, message: "合成直连失败" }),
  stepFail({ code: ENTRY_CODES.NETWORK, message: "升级路由连接被拒" }),
];

test(`${CLAUSES} PX-008 验收1：仅一条目升级失败 → attempts 恰一条、码 ENTRY_NETWORK、reason 双段且零认证`, async (t) => {
  const h = await harness(t, ESC_FAIL);
  const err = await h.runToError(h.search());
  assertWebError(err, { code: CHAIN_CODES.UPSTREAM_FAILURES, attempts: [{ entryId: "e1", code: ENTRY_CODES.NETWORK }] });
  assert.equal(err.details.attempts.length, 1, "升级失败不另记第二条 attempts（条目内重试设计决定）");
  const reason = err.details.attempts[0].reason;
  assert.match(reason, /直连|网络失败/, `reason 段1：直连失败事实：${reason}`);
  assert.match(reason, /(经)?全局代理升级仍失败|升级仍失败/, `reason 段2：升级失败事实：${reason}`);
  assert.match(reason, /syn-proxy\.invalid:8080/, "reason 含脱敏目标与失败阶段");
  assertNoSecrets(t, err, ["syn-user", "syn-pass"], "PX-008 零认证信息");
  assert.notEqual(err.details.attempts[0].code, ENTRY_CODES.PROXY, "不压 ENTRY_PROXY（裁决 c）");
});

test(`${CLAUSES} PX-008 验收2：前序条目升级失败、后继成功 → FB-002 首行接管概括含「升级失败」要素`, async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e1", "tavily", "钉死前序"), keyedEntry("e2", "bing", "接管者")],
    credentialRefs: { ...refsFor("e1"), [GLOBAL_REF]: GLOBAL_URL },
    extraConfig: { proxyEscalation: true, globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    steps: { e1: ESC_FAIL, e2: [stepSuccess({ sources: [{ url: "https://synthetic-host.invalid/t", title: "T", snippet: "S" }] })] },
  });
  const res = await h.runToValue(h.search());
  const firstLine = String(res.content ?? "").split("\n")[0];
  assert.match(firstLine, /钉死前序/, "接管提示列出前序条目");
  assert.match(firstLine, /升级失败/, `对该条目的一字概括含升级失败要素（PX-008 验收2）：${firstLine}`);
});

test(`${CLAUSES} PX-008 验收3：开关关同注入 → reason 无升级字样；两态 reason 可区分（不产生静默）`, async (t) => {
  const hOn = await harness(t, ESC_FAIL);
  const hOff = await harness(t, [stepFail({ code: ENTRY_CODES.NETWORK, message: "合成直连失败" })], { escalation: false });
  const on = await hOn.runToError(hOn.search());
  const off = await hOff.runToError(hOff.search());
  assert.ok(!/升级/.test(off.details.attempts[0].reason), "开关关：reason 无升级字样");
  assert.match(on.details.attempts[0].reason, /升级/, "开关开：reason 含升级段");
  assert.notEqual(on.details.attempts[0].reason, off.details.attempts[0].reason, "两态文案可区分（PX-008 验收3）");
  void SYN;
});
