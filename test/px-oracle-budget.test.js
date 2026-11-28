// PX-005 升级尝试的预算约束（共享条目剩余预算，设计决定 PX-005）。
// Oracle 骨架（工作包 #88）：实现前跑红属预期。受控时钟驱动（helpers/clock.js + chain-harness）。
// 注意：验收2/上报#1 的归因码边界（剩余≤0 文案 vs ENTRY_TIMEOUT）待 lead 裁决，本文件只钉不变式。
import test from "node:test";
import assert from "node:assert/strict";
import { stepSuccess, stepFail, stepHang } from "./helpers/fake-backend.js";
import { ENTRY_CODES, CHAIN_CODES } from "./helpers/contract.js";
import { chainHarness, keyedEntry, refsFor } from "./helpers/search-oracle.js";

const CLAUSES = "PX-005";
const GLOBAL_REF = "search_chain_global_proxy";
const GLOBAL_URL = "http://syn-user:syn-pass@syn-proxy.invalid:8080";

function routeIsGlobalUpgrade(o) {
  if (!o || typeof o !== "object") return false;
  if (o.viaGlobal === true) return true;
  return typeof o.proxyUrl === "string" && o.proxyUrl.includes("syn-proxy.invalid:8080");
}
function escalationObserved(h, entryId) {
  return (
    h.transport.handles.some((x) => x.entry.id === entryId && routeIsGlobalUpgrade(x.opts)) ||
    h.fetchFn.calls.some((c) => routeIsGlobalUpgrade(c.init?.route))
  );
}

test(`${CLAUSES} 验收1：条目预算 1000、直连失败耗时 400 → 升级共享未消耗时间（≤600 硬限）、整链不超 timeoutMs`, async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e1", "tavily", "直连条目")],
    credentialRefs: { ...refsFor("e1"), [GLOBAL_REF]: GLOBAL_URL },
    extraConfig: { proxyEscalation: true, globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    timeoutMs: 1000,
    steps: {
      e1: [
        stepFail({ code: ENTRY_CODES.NETWORK, message: "合成直连失败", consumeMs: 400 }),
        stepSuccess({ sources: [{ url: "https://synthetic-host.invalid/ok", title: "t", snippet: "s" }], consumeMs: 500 }),
      ],
    },
  });
  const start = h.clock.now();
  await h.runToValue(h.search());
  const [c1, c2] = h.backend("tavily").calls;
  assert.ok(c2, "升级重试应发生（第二次执行）");
  assert.equal(c2.at - start, 400, "升级发起时点=直连失败完成时点");
  assert.ok(c2.budgetMs <= 600, `升级硬限必须 ≤ 条目预算未消耗时间 600ms，实际 ${c2.budgetMs}（PX-005 要求）`);
  assert.ok(c2.budgetMs > 0, "升级预算必须为正值");
  assert.ok(h.clock.now() - start <= 1000, `整链耗时不得超 timeoutMs：${h.clock.now() - start}`);
});

test(`${CLAUSES} 验收2（不变式面）：直连失败发生于预算耗尽瞬间 → 零升级出站、失败原因含「剩余预算不足/未执行升级」要素（码归因待上报#1 裁决）`, async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e1", "tavily", "直连条目")],
    credentialRefs: { ...refsFor("e1"), [GLOBAL_REF]: GLOBAL_URL },
    extraConfig: { proxyEscalation: true, globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    timeoutMs: 500,
    steps: { e1: [stepFail({ code: ENTRY_CODES.NETWORK, message: "预算到期瞬间的直连失败", consumeMs: 500 })] },
  });
  const err = await h.runToError(h.search());
  assert.equal(escalationObserved(h, "e1"), false, "剩余 ≤0 不得发出升级请求（PX-005 要求）");
  assert.equal(h.executionCount("e1"), 1, "无升级重试出站");
  const reason = err.details.attempts[0].reason;
  assert.match(reason, /剩余预算不足|预算耗尽|未执行全局代理升级|预算到期/, `reason 须含预算类可操作要素，实际：${reason}`);
  // 上报#1（oracle 文档）：ENTRY_NETWORK+「剩余预算不足」 vs ENTRY_TIMEOUT 归因待裁决，此处不断言码值。
});

test(`${CLAUSES} 验收3：升级在途条目预算到期 → 升级请求被取消、迟到不采纳、剩余预算允许时继续下一条目`, async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e1", "tavily", "直连条目"), keyedEntry("e2", "bing", "兜底免key")],
    credentialRefs: { ...refsFor("e1"), [GLOBAL_REF]: GLOBAL_URL },
    extraConfig: { proxyEscalation: true, globalProxy: GLOBAL_REF },
    useOfficialDeepSeekSearch: false,
    timeoutMs: 1000,
    steps: {
      e1: [stepFail({ code: ENTRY_CODES.NETWORK, message: "直连失败" }), stepHang()],
      e2: [stepSuccess({ sources: [{ url: "https://synthetic-host.invalid/b", title: "b", snippet: "s" }] })],
    },
  });
  const res = await h.runToValue(h.search());
  assert.ok(res.sources.some((s) => s.url.includes("synthetic-host.invalid/b")), "兜底条目应成功（FB-003 条目到期可继续）");
  assert.equal(escalationObserved(h, "e1"), true, "前置：升级确实发出");
  const escCtx = h.backend("tavily").calls[1]?.ctx;
  assert.ok(escCtx?.signal?.aborted === true, "升级在途须被条目预算到期取消（FB-003 语义）");
});

test(`${CLAUSES} 验收4：升级不改变后续条目预算分配——与无升级基线逐毫秒一致`, async (t) => {
  async function secondEntryBudget(escalation) {
    const h = await chainHarness(t, CLAUSES, {
      entries: [keyedEntry("e1", "tavily", "直连条目"), keyedEntry("e2", "bing", "兜底免key")],
      credentialRefs: escalation ? { ...refsFor("e1"), [GLOBAL_REF]: GLOBAL_URL } : refsFor("e1"),
      extraConfig: escalation ? { proxyEscalation: true, globalProxy: GLOBAL_REF } : {},
      useOfficialDeepSeekSearch: false,
      timeoutMs: 999,
      steps: {
        e1: escalation
          ? [stepFail({ code: ENTRY_CODES.NETWORK, consumeMs: 100 }), stepFail({ code: ENTRY_CODES.NETWORK, consumeMs: 100 })]
          : [stepFail({ code: ENTRY_CODES.NETWORK, consumeMs: 200 })],
        e2: [stepFail({ code: ENTRY_CODES.NETWORK })],
      },
    });
    await h.runToError(h.search()).catch(() => {});
    const execs = h.executions();
    const e2 = execs.find((c) => c.entryId === "e2");
    return { budgetMs: e2?.budgetMs, at: e2?.at };
  }
  const baseline = await secondEntryBudget(false);
  const withEsc = await secondEntryBudget(true);
  // FB-003：分配公式按条目开始时点剩余/启用数——升级总耗时与基线同（100+100=200）⇒ e2 预算逐毫秒一致。
  assert.deepEqual(withEsc, baseline, "升级不得改变后续条目的预算分配值与起始时点（PX-005 验收4）");
});
