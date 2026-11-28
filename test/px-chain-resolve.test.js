// Issue #88 第三批/第五批修复的链面断言（test(proxy)：不改任何骨架/既有测试）：
//  ① PX-008 终态 WebError「升级失败」要素双态（ON 升级实际出站且失败 → 带要素；OFF → 逐字 legacy）；
//  ③ proxyOnly 非 NETWORK 相位失败保留原码 + 钉死要素（强制代理事实 + 脱敏目标 + 安全原因）；
//  ⑤ 全局代理 resolve 无预算/取消约束——悬挂 resolve 与剩余预算+宿主取消竞速：耗尽零出站收敛；
//  升裁·空结果可见性：升级已实际出网但空结果 → attempts 携带 ESCALATED_EMPTY 改道事实（呈现面）。
// 全程受控时钟、合成凭据（syn-*.invalid），零真实网络。
import test from "node:test";
import assert from "node:assert/strict";
import { stepSuccess, stepFail } from "./helpers/fake-backend.js";
import { ENTRY_CODES, CHAIN_CODES, assertWebError } from "./helpers/contract.js";
import { chainHarness, keyedEntry, refsFor } from "./helpers/search-oracle.js";
import { assertNoSecrets } from "./helpers/redact.js";

const CLAUSES = "PX-005/PX-008/PX-006";
const GLOBAL_REF = "search_chain_global_proxy";
const GLOBAL_URL = "http://syn-user:syn-pass@syn-proxy.invalid:8080";

/** 让全局代理引用的 resolve 永远不返回（模拟凭据服务悬挂）；条目引用不受影响。 */
function hangGlobalResolve(h) {
  const orig = h.credentials.resolve.bind(h.credentials);
  h.credentials.resolve = (ref) => (ref === GLOBAL_REF ? new Promise(() => {}) : orig(ref));
}

function globalOpens(h, entryId) {
  return h.transport.handles.filter((x) => x.entry.id === entryId && x.opts?.viaGlobal === true);
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// ⑤ proxyOnly + 悬挂 resolve：钉死路径同受剩余预算约束——截止即收敛，零出站（无直连、无代理）。
// ─────────────────────────────────────────────────────────────────────────────────────────
test(`${CLAUSES} 第五批⑤：proxyOnly 悬挂 resolve → 预算截止收敛「全局代理不可用」、零出站`, async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e1", "tavily", "钉死条目", { proxyPin: "proxyOnly" })],
    credentialRefs: { ...refsFor("e1"), [GLOBAL_REF]: GLOBAL_URL },
    extraConfig: { proxyEscalation: true, globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    timeoutMs: 4000,
    steps: { e1: [stepSuccess({ sources: [{ url: "https://synthetic-host.invalid/p", title: "p", snippet: "s" }] })] },
  });
  hangGlobalResolve(h);
  const err = await h.runToError(h.search());
  assert.equal(h.transport.openCount(), 0, "悬挂 resolve 截止后零出站（无直连、无代理）");
  assert.equal(h.executionCount("e1"), 0, "零执行");
  assertWebError(err, { code: CHAIN_CODES.BUDGET_EXHAUSTED, attempts: [{ entryId: "e1", code: ENTRY_CODES.NETWORK }] });
  assert.match(err.details.attempts[0].reason, /钉死仅代理.*全局代理不可用|钉死仅代理.*剩余预算不足/, `原因须为预算/不可用收敛面：${err.details.attempts[0].reason}`);
  assertNoSecrets(t, err, ["syn-user", "syn-pass"], "失败文本脱敏");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// ⑤ 升级路径 + 悬挂 resolve：直连失败后升级 resolve 与剩余预算竞速——耗尽按预算要素文案收敛、
//    零升级出站；终态 attempts 携带双要素（直连失败 + 剩余预算不足）。
// ─────────────────────────────────────────────────────────────────────────────────────────
test(`${CLAUSES} 第五批⑤：升级悬挂 resolve → 耗尽零升级出站、原因逐字「直连失败；剩余预算不足，未执行全局代理升级」`, async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e1", "tavily", "升级条目")],
    credentialRefs: { ...refsFor("e1"), [GLOBAL_REF]: GLOBAL_URL },
    extraConfig: { proxyEscalation: true, globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    timeoutMs: 4000,
    steps: { e1: [stepFail({ code: ENTRY_CODES.NETWORK, message: "合成 DNS 失败" })] },
  });
  hangGlobalResolve(h);
  const err = await h.runToError(h.search());
  assert.equal(globalOpens(h, "e1").length, 0, "悬挂 resolve 截止后零升级出站");
  assert.equal(h.executionCount("e1"), 1, "直连执行恰 1 次（无升级重试）");
  assertWebError(err, { code: CHAIN_CODES.BUDGET_EXHAUSTED, attempts: [{ entryId: "e1", code: ENTRY_CODES.NETWORK }] });
  assert.equal(
    err.details.attempts[0].reason,
    "直连失败；剩余预算不足，未执行全局代理升级",
    "升级耗尽面原因逐字（双要素）",
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// ① PX-008 终态「升级失败」要素双态：
//    ON 态（升级实际出站且失败）→ WebError 消息含「含经全局代理升级仍失败条目」；
//    OFF 态（纯直连失败）→ 消息逐字 legacy（无升级要素）。
// ─────────────────────────────────────────────────────────────────────────────────────────
test(`${CLAUSES} 第三批①：终态 WebError「升级失败」要素双态——ON 带要素、OFF 逐字 legacy`, async (t) => {
  // ON 态：直连失败 → 升级出站 → 升级上游 401（CREDENTIALS）。
  const on = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e1", "tavily", "升级条目")],
    credentialRefs: { ...refsFor("e1"), [GLOBAL_REF]: GLOBAL_URL },
    extraConfig: { proxyEscalation: true, globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    timeoutMs: 8000,
    steps: { e1: [stepFail({ code: ENTRY_CODES.NETWORK }), stepFail({ code: ENTRY_CODES.CREDENTIALS, message: "合成 401" })] },
  });
  const errOn = await on.runToError(on.search());
  assert.ok(globalOpens(on, "e1").length >= 1, "ON 态升级实际出站");
  // 升级失败以 NETWORK 落码（原相位保留在原因文本；PX-008：不得压 ENTRY_PROXY 给条目自有代理）。
  assertWebError(errOn, { code: CHAIN_CODES.UPSTREAM_FAILURES, attempts: [{ entryId: "e1", code: ENTRY_CODES.NETWORK }] });
  assert.match(errOn.message, /含经全局代理升级仍失败条目/, `ON 态终态消息须含「升级失败」要素：${errOn.message}`);
  assert.match(errOn.details.attempts[0].reason, new RegExp(`经全局代理升级仍失败（http://syn-proxy\\.invalid:8080，失败阶段：${ENTRY_CODES.CREDENTIALS}）`), "attempts 原因含升级改道事实 + 原相位");

  // OFF 态：同形态纯直连失败——消息逐字 legacy。
  const off = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e1", "tavily", "升级条目")],
    credentialRefs: { ...refsFor("e1"), [GLOBAL_REF]: GLOBAL_URL },
    extraConfig: { globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    timeoutMs: 8000,
    steps: { e1: [stepFail({ code: ENTRY_CODES.NETWORK })] },
  });
  const errOff = await off.runToError(off.search());
  assert.equal(
    errOff.message,
    "全链未获得有效来源：尝试过的条目均失败或被跳过（见 details.attempts 的逐条原因）",
    "OFF 态终态消息逐字 legacy（无升级要素）",
  );
  assert.ok(!/升级/.test(errOff.message), "OFF 态消息零升级字样");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// ③ proxyOnly 非 NETWORK 相位失败：保留原码（不压 NETWORK/ENTRY_PROXY）+ 钉死要素（强制代理事实+脱敏目标+安全原因）。
// ─────────────────────────────────────────────────────────────────────────────────────────
test(`${CLAUSES} 第三批③：proxyOnly 非 NETWORK 相位（CREDENTIALS）保留原码与钉死要素`, async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e1", "tavily", "钉死条目", { proxyPin: "proxyOnly" })],
    credentialRefs: { ...refsFor("e1"), [GLOBAL_REF]: GLOBAL_URL },
    extraConfig: { proxyEscalation: true, globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    timeoutMs: 8000,
    steps: { e1: [stepFail({ code: ENTRY_CODES.CREDENTIALS, message: "合成 401" })] },
  });
  const err = await h.runToError(h.search());
  assert.ok(globalOpens(h, "e1").length >= 1, "proxyOnly 经全局代理出站（未达代理≠回退直连）");
  assertWebError(err, { code: CHAIN_CODES.UPSTREAM_FAILURES, attempts: [{ entryId: "e1", code: ENTRY_CODES.CREDENTIALS }] });
  const reason = err.details.attempts[0].reason;
  assert.match(reason, /条目钉死仅代理：全局代理失败（http:\/\/syn-proxy\.invalid:8080，/, "钉死要素：强制代理事实 + 脱敏目标");
  assert.match(reason, /凭据或权限被上游拒绝/, "保留原相位的安全原因（非 NETWORK 泛化文案）");
  assert.equal(err.details.attempts[0].code, ENTRY_CODES.CREDENTIALS, "非 NETWORK 相位原码保留");
  assertNoSecrets(t, err, ["syn-user", "syn-pass"], "失败文本脱敏");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 升裁·空结果可见性：升级路径已实际出网但返回空 → attempts 携带 ESCALATED_EMPTY 改道事实
// （呈现面：失败终态经 WebError details 可见；空成功终态形状由 FB-004 锁死不加键）。
// ─────────────────────────────────────────────────────────────────────────────────────────
test(`${CLAUSES} 升裁：升级已出网但空结果 → attempts 含 ESCALATED_EMPTY 改道事实（含脱敏目标）`, async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e1", "tavily", "升级条目"), keyedEntry("e2", "exa", "兜底条目")],
    credentialRefs: { ...refsFor("e1", "e2"), [GLOBAL_REF]: GLOBAL_URL },
    extraConfig: { proxyEscalation: true, globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    timeoutMs: 8000,
    steps: {
      e1: [stepFail({ code: ENTRY_CODES.NETWORK }), stepSuccess({ sources: [] })],
      e2: [stepFail({ code: ENTRY_CODES.QUOTA, message: "合成 402" })],
    },
  });
  const err = await h.runToError(h.search());
  assert.ok(globalOpens(h, "e1").length >= 1, "e1 升级路径实际出网");
  // 自写断言（不经 assertWebError）：ESCALATED_EMPTY 为呈现面事实码，不在骨架 ALLOWED_ATTEMPT_CODES 内（no skeleton changes）。
  assert.equal(err.name, "WebError", "终态为 WebError");
  assert.equal(err.code, CHAIN_CODES.UPSTREAM_FAILURES, "终态码 UPSTREAM_FAILURES");
  assert.deepEqual(
    err.details.attempts.map((a) => a.entryId),
    ["e1", "e2"],
    "attempts 按条目列出",
  );
  const fact = err.details.attempts.find((a) => a.entryId === "e1" && a.code === "ESCALATED_EMPTY");
  assert.ok(fact, "attempts 含 ESCALATED_EMPTY 改道事实记录");
  assert.match(fact.reason, /直连失败；经全局代理升级（http:\/\/syn-proxy\.invalid:8080）已出站但未返回结果/, "事实含脱敏目标与空结果语义");
  assert.ok(err.details.attempts.some((a) => a.entryId === "e2" && a.code === ENTRY_CODES.QUOTA), "e2 原相位失败在场");
  assertNoSecrets(t, err, ["syn-user", "syn-pass"], "失败文本脱敏");
});
