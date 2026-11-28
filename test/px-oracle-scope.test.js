// PX-003 作用域：全局升级仅作用于直连态条目；固定代理/PAC 条目自治不受影响；开关关全链路 v0.2.0 一致。
// Oracle 骨架（工作包 #88）：实现前跑红属预期。
// 观测面：O5 出站路由（A-PX-1：升级出站 route.viaGlobal===true 或 route.proxyUrl 命中全局代理）、O7。
import test from "node:test";
import assert from "node:assert/strict";
import { stepSuccess, stepFail } from "./helpers/fake-backend.js";
import { ENTRY_CODES, CONFIG_CODES, assertWebError, CHAIN_CODES } from "./helpers/contract.js";
import { chainHarness, keyedEntry, refsFor } from "./helpers/search-oracle.js";

const CLAUSES = "PX-003";
const GLOBAL_REF = "search_chain_global_proxy";
const GLOBAL_URL = "http://syn-user:syn-pass@syn-proxy.invalid:8080";
const OWN_PROXY = "http://own-proxy.invalid:3128";
const PAC = "http://syn-pac.invalid:8765/acceleration.pac?v=3";

function routeIsGlobalUpgrade(route) {
  if (!route || typeof route !== "object") return false;
  if (route.viaGlobal === true) return true;
  return typeof route.proxyUrl === "string" && route.proxyUrl.includes("syn-proxy.invalid:8080");
}
function escalationObserved(h, entryId) {
  const viaOpen = h.transport.handles.some((x) => x.entry.id === entryId && routeIsGlobalUpgrade(x.opts));
  const viaRoute = h.fetchFn.calls.some((c) => routeIsGlobalUpgrade(c.init?.route));
  return viaOpen || viaRoute;
}

/** 三类条目链：直连 E1、固定代理 E2、PAC E3、直连兜底 E4（成功）。 */
function threeKindEntries() {
  return [
    keyedEntry("e1", "tavily", "直连条目"),
    keyedEntry("e2", "exa", "固定代理条目", { proxy: OWN_PROXY }),
    keyedEntry("e3", "bing", "PAC条目", { proxy: { pac: PAC } }),
    keyedEntry("e4", "brave", "兜底直连"),
  ];
}

function allFailSteps() {
  return {
    e1: [stepFail({ code: ENTRY_CODES.NETWORK, message: "合成 DNS 失败" }), stepFail({ code: ENTRY_CODES.NETWORK, message: "升级仍失败" })],
    e2: [stepFail({ code: ENTRY_CODES.NETWORK, message: "自有代理网络失败" })],
    e3: [stepFail({ code: ENTRY_CODES.NETWORK, message: "PAC 判定 DIRECT 后网络失败" })],
    e4: [stepFail({ code: ENTRY_CODES.NETWORK, message: "兜底也失败" })],
  };
}

test(`${CLAUSES}：开关开，三类条目同链仅直连态 E1 升级出站；E2/E3 在全局代理桩零请求（验收1/2）`, async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: threeKindEntries(),
    credentialRefs: { ...refsFor("e1", "e2", "e4"), [GLOBAL_REF]: GLOBAL_URL },
    extraConfig: { proxyEscalation: true, globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    steps: allFailSteps(),
  });
  await h.runToError(h.search()).catch(() => {});
  assert.equal(escalationObserved(h, "e1"), true, "直连态 E1 必须出现升级出站（PX-003 验收1）");
  const globalHits = h.fetchFn.calls.filter((c) => routeIsGlobalUpgrade(c.init?.route));
  const e2e3Global = h.transport.handles.filter((x) => (x.entry.id === "e2" || x.entry.id === "e3") && routeIsGlobalUpgrade(x.opts));
  assert.equal(e2e3Global.length, 0, "固定代理/PAC 条目对全局代理的 transport.open 必须为 0（验收2）");
  void globalHits; // 链级 fetch 面归属实现细节，transport.open 判别为准（A-PX-1）
  for (const id of ["e2", "e3"]) {
    assert.equal(escalationObserved(h, id), false, `${id} 绝不改经全局代理（PX-003）`);
  }
});

test(`${CLAUSES}：E2/E3 失败按 FB-001/FB-006 降级下一条、错误无升级文案；不回退直连不改走全局（验收2/3）`, async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [
      keyedEntry("e2", "exa", "固定代理条目", { proxy: OWN_PROXY }),
      keyedEntry("e3", "bing", "PAC条目", { proxy: { pac: PAC } }),
    ],
    credentialRefs: { ...refsFor("e2"), [GLOBAL_REF]: GLOBAL_URL },
    extraConfig: { proxyEscalation: true, globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    steps: { e2: [stepFail({ code: ENTRY_CODES.PROXY })], e3: [stepFail({ code: CONFIG_CODES.PAC_ROUTE_FAILED })] },
  });
  const err = await h.runToError(h.search());
  assertWebError(err, {
    code: CHAIN_CODES.UPSTREAM_FAILURES,
    attempts: [
      { entryId: "e2", code: ENTRY_CODES.PROXY },
      { entryId: "e3", code: CONFIG_CODES.PAC_ROUTE_FAILED },
    ],
  });
  for (const a of err.details.attempts) {
    assert.ok(!/升级|全局代理/.test(a.reason), `${a.entryId} 错误文本不得含升级文案（PX-003 验收2）：${a.reason}`);
  }
  assert.ok(!JSON.stringify(err).includes(GLOBAL_URL), "错误面零全局代理明文（CFG-003）");
});

test(`${CLAUSES}：开关关重放 → 三类条目零升级出站、逐条目恰一次执行（行为与 v0.2.0 逐请求一致的行为面）（验收4）`, async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: threeKindEntries(),
    credentialRefs: { ...refsFor("e1", "e2", "e4") },
    extraConfig: {}, // 无三新键 = 存量形态（PX-009 行为面联测）
    useOfficialDeepSeekSearch: false,
    steps: allFailSteps(),
  });
  await h.runToError(h.search()).catch(() => {});
  for (const id of ["e1", "e2", "e3", "e4"]) {
    assert.equal(escalationObserved(h, id), false, "开关关：零升级出站（PX-003 验收4）");
  }
  assert.equal(h.executionCount("e1"), 1, "开关关：E1 恰一次执行，无升级重试（v0.2.0 一致）");
  assert.equal(h.transport.openCount(), 4, "开关关：出站条目 transport.open 与 v0.2.0 一致（每启用条目一次）");
});

test(`${CLAUSES}：升级不改宿主/OS 代理配置（要求2，边界桩：进程环境代理变量零改动）`, async (t) => {
  const before = { ...process.env };
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e1", "tavily", "直连条目")],
    credentialRefs: { ...refsFor("e1"), [GLOBAL_REF]: GLOBAL_URL },
    extraConfig: { proxyEscalation: true, globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    steps: { e1: [stepFail({ code: ENTRY_CODES.NETWORK }), stepFail({ code: ENTRY_CODES.NETWORK })] },
  });
  await h.runToError(h.search()).catch(() => {});
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    assert.equal(process.env[k], before[k], `宿主/OS 代理环境变量 ${k} 不得被改动（PX-003 要求2）`);
  }
});
