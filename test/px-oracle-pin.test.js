// PX-006 条目级钉死三态（inherit/directOnly/proxyOnly）与对全局策略的优先（lead 裁决 a：正交）。
// Oracle 骨架（工作包 #88）：实现前跑红属预期。闸层拒绝矩阵见 px-oracle-gates.test.js。
import test from "node:test";
import assert from "node:assert/strict";
import { stepSuccess, stepFail } from "./helpers/fake-backend.js";
import { ENTRY_CODES, assertSearchResult, assertWebError, CHAIN_CODES } from "./helpers/contract.js";
import { chainHarness, keyedEntry, refsFor } from "./helpers/search-oracle.js";
import { assertNoSecrets } from "./helpers/redact.js";

const CLAUSES = "PX-006";
const GLOBAL_REF = "search_chain_global_proxy";
const GLOBAL_URL = "http://syn-user:syn-pass@syn-proxy.invalid:8080";

function routeIsGlobalUpgrade(o) {
  if (!o || typeof o !== "object") return false;
  if (o.viaGlobal === true) return true;
  return typeof o.proxyUrl === "string" && o.proxyUrl.includes("syn-proxy.invalid:8080");
}
function globalOpens(h, entryId) {
  return h.transport.handles.filter((x) => x.entry.id === entryId && routeIsGlobalUpgrade(x.opts));
}
function plainOpens(h, entryId) {
  return h.transport.handles.filter((x) => x.entry.id === entryId && !routeIsGlobalUpgrade(x.opts));
}

function harness(t, pin, steps, { escalation = true, cred = {} } = {}) {
  return chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e1", "tavily", "钉死条目", { proxyPin: pin })],
    credentialRefs: { ...refsFor("e1"), [GLOBAL_REF]: GLOBAL_URL, ...cred },
    extraConfig: escalation ? { proxyEscalation: true, globalProxy: GLOBAL_REF } : { globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    steps: { e1: steps },
  });
}

test(`${CLAUSES} 验收1：directOnly + 开关开 + 全局代理可用，DNS 失败 → 全局代理零请求、按直连失败落定（纯直连形态无升级段）`, async (t) => {
  const h = await harness(t, "directOnly", [stepFail({ code: ENTRY_CODES.NETWORK, message: "合成 DNS 失败" })]);
  const err = await h.runToError(h.search());
  assert.equal(globalOpens(h, "e1").length, 0, "directOnly 绝不升级（PX-006）");
  assert.equal(h.executionCount("e1"), 1, "无升级重试执行");
  assertWebError(err, { code: CHAIN_CODES.UPSTREAM_FAILURES, attempts: [{ entryId: "e1", code: ENTRY_CODES.NETWORK }] });
  assert.ok(!/升级|全局代理/.test(err.details.attempts[0].reason), "错误为纯直连失败形态，无升级文案");
});

test(`${CLAUSES} 验收2：proxyOnly 请求实经全局代理出站、直连零出站；代理断开 → 失败含「钉死仅代理」+脱敏目标、直连零出站`, async (t) => {
  const ok = await harness(t, "proxyOnly", [stepSuccess({ sources: [{ url: "https://synthetic-host.invalid/p", title: "p", snippet: "s" }] })]);
  const res = await ok.runToValue(ok.search());
  assertSearchResult(t, res);
  assert.ok(globalOpens(ok, "e1").length >= 1, "proxyOnly 必须经 globalProxy 引用解析出的代理出站（PX-006）");
  assert.equal(plainOpens(ok, "e1").length, 0, "proxyOnly 绝不直连");

  const down = await harness(t, "proxyOnly", [stepFail({ code: ENTRY_CODES.NETWORK, message: "经全局代理请求失败" })]);
  const err = await down.runToError(down.search());
  assert.equal(globalOpens(down, "e1").length >= 1, true, "失败例亦须经代理（未达代理≠回退直连）");
  assert.equal(plainOpens(down, "e1").length, 0, "代理失败绝不回退直连（PX-006 验收2）");
  assert.match(err.details.attempts[0].reason, /钉死仅代理|仅代理：全局代理(不可用|失败)/, `原因须含钉死仅代理要素：${err.details.attempts[0].reason}`);
  assert.match(err.details.attempts[0].reason, /syn-proxy\.invalid:8080/, "原因含脱敏目标 scheme://host:port");
  assertNoSecrets(t, err, ["syn-user", "syn-pass"], "PX-006 proxyOnly 失败文本脱敏");
  // 归因码守 PX-008 预留面：不得压 ENTRY_PROXY（保留给条目自有代理）
  assert.notEqual(err.details.attempts[0].code, ENTRY_CODES.PROXY, "全局代理失败不得压 ENTRY_PROXY（PX-008/lead 裁决 c）");
});

test(`${CLAUSES} 验收3：proxyOnly + 引用未配置 → 零出站、原因明示不可用；开关 OFF 亦绝不直连（正交，lead 裁决 a）`, async (t) => {
  for (const escalation of [true, false]) {
    const h = await chainHarness(t, CLAUSES, {
      entries: [keyedEntry("e1", "tavily", "钉死条目", { proxyPin: "proxyOnly" })],
      credentialRefs: refsFor("e1"), // 无 GLOBAL_REF
      extraConfig: { ...(escalation ? { proxyEscalation: true } : {}), globalProxy: GLOBAL_REF },
      useOfficialDeepSeekSearch: false,
      steps: { e1: [stepSuccess({ sources: [] })] },
    });
    const err = await h.runToError(h.search());
    assert.equal(h.executionCount("e1"), 0, `proxyOnly 代理解析失败零执行（开关=${escalation}）`);
    assert.equal(h.transport.openCount(), 0, "零出站（无直连、无代理）");
    assert.match(err.details.attempts[0].reason, /钉死仅代理|全局代理.*(不可用|未配置)/, "原因明示不可用");
  }
});

test(`${CLAUSES} 正交（lead 裁决 a 方向2）：proxyOnly 不依赖升级开关——开关 OFF 仍强制经全局代理成功`, async (t) => {
  const h = await harness(t, "proxyOnly", [stepSuccess({ sources: [{ url: "https://synthetic-host.invalid/p2", title: "p", snippet: "s" }] })], {
    escalation: false,
  });
  const res = await h.runToValue(h.search());
  assertSearchResult(t, res);
  assert.ok(globalOpens(h, "e1").length >= 1, "开关 OFF 不剥夺 proxyOnly（PX-006 设计决定）");
});

test(`${CLAUSES} 要求2：directOnly 与 inherit+开关 OFF 行为与 v0.2.0 逐位一致（执行/transport.open/预算形状一致基线）`, async (t) => {
  async function shape(pin, escalation) {
    const h = await chainHarness(t, CLAUSES, {
      entries: [keyedEntry("e1", "tavily", "条目", { ...(pin ? { proxyPin: pin } : {}) })],
      credentialRefs: { ...refsFor("e1"), [GLOBAL_REF]: GLOBAL_URL },
      extraConfig: escalation ? { proxyEscalation: true, globalProxy: GLOBAL_REF } : {},
      useOfficialDeepSeekSearch: false,
      timeoutMs: 1234,
      steps: { e1: [stepFail({ code: ENTRY_CODES.NETWORK })] },
    });
    await h.runToError(h.search()).catch(() => {});
    return {
      executions: h.executions().map((c) => ({ entryId: c.entryId, budgetMs: c.budgetMs })),
      opens: h.transport.handles.map((x) => ({ id: x.entry.id, viaGlobal: routeIsGlobalUpgrade(x.opts) })),
      closed: h.transport.allClosed(),
    };
  }
  const v020 = await shape(null, false); // 存量形态基线
  assert.deepEqual(await shape("directOnly", true), v020, "directOnly 即使开关开也与 v0.2.0 逐位一致（PX-006 要求2）");
  assert.deepEqual(await shape("inherit", false), v020, "inherit+开关 OFF 与 v0.2.0 逐位一致");
});
