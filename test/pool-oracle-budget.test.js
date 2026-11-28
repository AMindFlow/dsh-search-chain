// 工作包 #86 · 多 key 池轮替 Oracle 骨架（POOL-005 轮替预算与 FB-001 边界）。
// 受控时钟（helpers/clock.js，经 chain-harness 注入）驱动；零真实等待。
// 观测面：条目预算 = FB-003 公式不变（预算分母 = 启用条目数，不因池 >1 改变）、
//         到期取消在途、出站止步、ENTRY_TIMEOUT 归因 + 未尝试数、条目间顺序/预算不受轮替影响、
//         宿主取消后零后续出站。实现前跑红属预期。
// 注：attempts 的 pool 明细字段名为 Oracle 假设，依 key-pool.md 设计决定「实现建议」
//     钉为 pool = { size, tried, outcomes:[{index,code}] }，untried = size − tried − 解析未命中数；
//     untried = size − tried − 解析未命中数；改名须随实现 PR 同步（见 Oracle 文档歧义上报）。
import test from "node:test";
import assert from "node:assert/strict";
import { createSearchChain } from "../src/search.js";
import { createChainHarness } from "./helpers/chain-harness.js";
import { stepSuccess } from "./helpers/fake-backend.js";
import { flush } from "./helpers/clock.js";
import { ENTRY_CODES } from "./helpers/contract.js";
import { credentialSeedFor, makeIssuingBackend, refPoolOf, scriptAttempts } from "./helpers/pool-oracle-kit.js";

const BING_OK = [{ url: "https://synthetic-host.invalid/bing-ok", title: "合成 Bing 来源" }];

function poolHarness({ letters = "ABC", timeoutMs = 6000, withBing = true, poolFirst = true }) {
  const pool = { id: "p", type: "openai", name: "池条目", enabled: true, credentialRefs: refPoolOf(letters) };
  const bing = { id: "b", type: "bing", name: "Bing 兜底", enabled: true };
  const entries = poolFirst ? [pool, bing] : [pool];
  const h = createChainHarness(createSearchChain, {
    entries: withBing ? entries : [pool],
    timeoutMs,
    steps: { b: [stepSuccess({ sources: BING_OK })] },
    credentialRefs: credentialSeedFor(letters),
  });
  const issuing = makeIssuingBackend("openai");
  h.deps.backends.set("openai", issuing);
  return { h, issuing };
}

/** 手动推进微任务直到条件成立（受控时钟无真实等待；无定时器时纯 flush）。 */
async function waitUntil(fn, rounds = 50) {
  for (let i = 0; i < rounds; i += 1) {
    await flush(3);
    if (fn()) return true;
  }
  return fn();
}

test("POOL-005①a 条目预算容纳 3 把：首 key 401、次 key 挂起 → 预算到期取消在途、出站止步 2、降级下一条目按 FB-003 口径继续", async () => {
  const { h, issuing } = poolHarness({ letters: "ABC" });
  scriptAttempts(h.fetchFn, { 1: 401, 2: "hang", 3: "ok:1" });
  const value = await h.runToValue(h.search());
  assert.equal(issuing.callCount("p"), 2, "轮替止于条目预算：第 3 把不得发出");
  assert.equal(h.fetchFn.calls.length, 2, "出站止步 2 次（供应商侧）");
  assert.equal(h.fetchFn.calls[1].aborted, true, "在途次 key 请求必须在预算到期时被取消");
  // 条目预算 = 6000 / 2 启用条目 = 3000（POOL-005 不得为轮替追加预算/改分母）
  assert.equal(issuing.calls[0].budgetMs, 3000, "首把拿到的条目预算必须仍是 FB-003 公式值");
  // 前后条目埋点：bing 的预算与顺序不受前条目轮替影响
  const bingCall = h.backend("bing").calls.find((c) => c.entryId === "b");
  assert.ok(bingCall, "预算到期后必须按 FB-003 继续下一条目");
  assert.equal(bingCall.budgetMs, 3000, "下一条目预算按剩余总预算原 FB-003 口径分配");
  assert.equal(bingCall.at - issuing.calls[0].at, 3000, "池条目占用窗口恰为其条目预算（3 把 key 全落在预算内）");
  assert.equal(value.sources[0].url, BING_OK[0].url);
  assert.match(value.content.split("\n")[0], /已由「Bing 兜底」/, "FB-002 接管提示不受池条目影响");
  assert.match(value.content.split("\n")[0], /超时/, "池条目按 ENTRY_TIMEOUT 归因进入接管提示");
});

test("POOL-005①b 预算到期归因：唯一条目终态 attempts 记 ENTRY_TIMEOUT 且未尝试 key 数可见", async () => {
  const { h, issuing } = poolHarness({ letters: "ABC", withBing: false });
  scriptAttempts(h.fetchFn, { 1: 401, 2: "hang" });
  const err = await h.runToError(h.search());
  const attempts = err.details.attempts.filter((a) => a.entryId === "p");
  assert.equal(attempts.length, 1, "池条目终态恰一条失败记录（POOL-006）");
  assert.equal(attempts[0].code, ENTRY_CODES.TIMEOUT, "预算到期按 ENTRY_TIMEOUT 归因");
  const pool = attempts[0].pool;
  assert.ok(pool && typeof pool === "object", "attempts 必须暴露 pool 逐 key 明细（Oracle 假设字段 pool）");
  assert.equal(pool.size, 3, "pool.size = 池候选数");
  assert.equal(pool.tried, 2, "挂起在途者计为已尝试（出站 2 把），tried=2");
  assert.equal(pool.size - pool.tried, 1, "未尝试 key 数 = 1（未尝试数可见）");
  assert.deepEqual((pool.outcomes ?? []).map((o) => [o.index, o.code]).filter(([i]) => i === 1), [[1, ENTRY_CODES.CREDENTIALS]], "首把 401 以池内序号 1 记 CREDENTIALS");
});

test("POOL-005② 轮替途中宿主取消：在途请求取消、后续出站数为零、整链拒绝（FB-003 口径）", async () => {
  const { h, issuing } = poolHarness({ letters: "ABC", withBing: false });
  scriptAttempts(h.fetchFn, { 1: 401, 2: "hang", 3: "ok:1" });
  const ac = new AbortController();
  const search = h.search({ query: "合成查询" }, ac.signal);
  let outcome = null;
  search.then((v) => (outcome = { ok: true, v }), (e) => (outcome = { ok: false, e }));
  const reached = await waitUntil(() => issuing.callCount("p") >= 2);
  assert.ok(reached, "前置：轮替已到次 key 在途");
  const outboundAtAbort = h.fetchFn.calls.length;
  ac.abort();
  for (let i = 0; i < 40 && outcome === null; i += 1) await flush(3);
  assert.ok(outcome, "宿主取消后整链必须拒绝收敛");
  assert.equal(outcome.ok, false, "取消以拒绝终结（FB-003）");
  assert.equal(outcome.e?.name, "AbortError", "宿主取消按 AbortError 暴露（错误契约）");
  assert.equal(h.fetchFn.calls.length, outboundAtAbort, "取消后不得产生任何后续出站");
  assert.equal(h.fetchFn.calls[1].aborted, true, "在途请求被取消");
});

test("POOL-005③ 回归：无池（单引用）条目 FB-001/FB-003 出站次数与顺序 = v0.2.0 基准", async () => {
  const h = createChainHarness(createSearchChain, {
    entries: [
      { id: "s", type: "openai", name: "单引用", enabled: true, credentialRef: "SOLO_REF" },
      { id: "b", type: "bing", name: "Bing 兜底", enabled: true },
    ],
    timeoutMs: 6000,
    steps: { s: [{ kind: "hang" }], b: [stepSuccess({ sources: BING_OK })] },
    credentialRefs: { SOLO_REF: "sk-synthetic-solo-KEY-DO-NOT-LOG" },
  });
  const value = await h.runToValue(h.search());
  assert.deepEqual(h.executions().map((c) => c.entryId), ["s", "b"], "条目间顺序与 v0.2.0 一致（单 key 无轮替）");
  assert.equal(h.executions().filter((c) => c.entryId === "s").length, 1, "单引用条目每搜索至多一次提交（FB-001 原文）");
  assert.equal(value.sources[0].url, BING_OK[0].url);
});
