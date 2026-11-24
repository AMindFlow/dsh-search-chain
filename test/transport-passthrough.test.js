// gap 修正 B 包 oracle（P1-1）— 条目传输带码错误的透传（src/transport.js + 七个后端适配器 + src/search.js 链）。
//
// 覆盖条款与依据：
//   FB-005「必须区分……代理、直连网络」：代理路由的故障（ENTRY_PROXY）绝不能与直连网络故障（ENTRY_NETWORK）
//     混同；已带归因码的错误在传输/适配器层必须原样透传，不得被压成 ENTRY_NETWORK。
//   FB-005「内部程序违约（不带条目分类码的错误）原样向调用方暴露，不包装、不再发起新的上游请求」：
//     TRANSPORT_RELEASED 不是条目分类 → 链仍原样暴露（出口仍 v0.2，不改终态面）。
//     裁决补充（PR#35 同判，lead）：条目执行期 CONFIG_*/PAC_* 与 PROXY 一律条目级降级，
//     「原样暴露不包装」只对全局 CONFIG_*（链级配置读取失败，P2-b⑤）成立；
//     链级 CONFIG 行终态面与 P2-b④ 同判——本文件对该行只钉防压扁，终态形状由④强制红。
//   #12-26（gap 清单）：透传先修，出口仍 v0.2 —— 本文件只钉「码不再被压扁」，不新增任何终态/包装。
//   FB-001 每条目至多一次：每个场景出站恰好一次（程序错误后不得再发起上游请求）。
//   A6 seam：链经 transport.open(entry) 取 ctx.fetch；本文件在链级把 ctx.fetch 替换为抛「带码错误」的
//   注入面（fake-transport 直通 fake-fetch），另在传输层用真实 createEntryTransport 直接验证同一透传。
//
// 参数化：后端 7 家（openai / tavily / exa / brave / bing / gemini / deepseek-search）各 1 例，
// 每例三种带码错误（ENTRY_PROXY、CONFIG_CODES 码、TRANSPORT_RELEASED）逐一注入，断链终态保留原码。
// 既有面不动：无码错误仍归 ENTRY_NETWORK（FB-005 直连网络兜底）——该行为本轮预期为绿。
//
// 缺陷钉（dev 面，B 包实现修复后转绿）：P1-1 各例在 main 上把带码错误压成 ENTRY_NETWORK。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { chainHarness, keyedEntry, refsFor } from "./helpers/search-oracle.js";

/** src/transport.js 释放语义码（本地镜像同步义务：与 transport.js fetch() 的 closed 分支同值）。 */
const TRANSPORT_RELEASED = "TRANSPORT_RELEASED";

/** 每家后端的加载与取形（A5 三种导出形态按各家 oracle 先例）。 */
const BACKENDS = [
  { type: "openai", rel: "backends/openai.js", pick: (m) => m.openaiBackend ?? m.createOpenAIBackend?.() },
  { type: "tavily", rel: "backends/tavily.js", pick: (m) => m.tavilyBackend ?? m.createTavilyBackend?.() ?? m.default },
  { type: "exa", rel: "backends/exa.js", pick: (m) => m.exaBackend ?? m.createExaBackend?.() },
  { type: "brave", rel: "backends/brave.js", pick: (m) => m.braveBackend ?? m.createBraveBackend?.() },
  { type: "bing", rel: "backends/bing.js", pick: (m) => m.bingBackend },
  { type: "gemini", rel: "backends/gemini.js", pick: (m) => m.createGeminiBackend?.() ?? m.geminiBackend },
  {
    type: "deepseek-search",
    rel: "backends/deepseek.js",
    pick: (m) => m.deepseekBackends?.["deepseek-search"] ?? m.deepseekSearchBackend,
  },
];

/**
 * 每个后端注入的三种带码错误：一条 ENTRY_*（归因必须区分）、一条 CONFIG_CODES、一条 TRANSPORT_RELEASED。
 * chain = 链级期望模式（PR#35 裁决补充，lead 同判）：
 *   "attempts"     条目级降级，终态 attempts 携原码；
 *   "same-as-p2b4" 与 P2-b④ 同判——本行只钉防压扁（原码存活到终态：裸原码或 attempts 原码），
 *                  终态形状（降级 WebError 携原码）由 chain-coded-failure-policy④ 强制红，不在此双钉；
 *   "raw"          原样暴露不包装（现仅 TRANSPORT_RELEASED；全局 CONFIG_* 的原样面在 P2-b⑤）。
 * 传输层（适配器级）行不受 chain 影响：一律要求原码原样透传（不压扁，本轮不动）。
 */
const PASTHROUGH_CASES = [
  { label: "ENTRY_PROXY（代理归因码，FB-005 必须区分代理）", code: C.ENTRY_CODES.PROXY, chain: "attempts" },
  { label: "CONFIG_CODES 码（CONFIG_INVALID，条目执行期→条目级降级，与 P2-b④ 同判）", code: C.CONFIG_CODES.INVALID, chain: "same-as-p2b4" },
  { label: "TRANSPORT_RELEASED（释放后拒发，程序违约原样暴露）", code: TRANSPORT_RELEASED, chain: "raw" },
];

/** 合成「带码」传输错误：message 固定脱敏文本，code 为被测透传对象。每场景新建实例（错误对象不复用）。 */
function codedError(code) {
  const err = new Error(`synthetic transport failure carrying code ${code}`);
  err.code = code;
  return err;
}

/** 无码合成网络故障（既有面：应归 ENTRY_NETWORK）。 */
function plainNetworkError() {
  return new Error("synthetic network failure without code");
}

/**
 * 跑一次「单条目链 + ctx.fetch 抛指定错误」，返回 { err, calls }。
 * real backend 经 harness.deps.backends 注入（同一 Map 引用，链在 run 时 get）。
 */
async function runChainWithFetchError(t, clauses, type, makeError) {
  const entry = keyedEntry("p11-e1", type, "P1-1 透传条目");
  const harness = await chainHarness(t, clauses, {
    entries: [entry],
    credentialRefs: refsFor("p11-e1"),
  });
  const spec = BACKENDS.find((b) => b.type === type);
  const res = await tryImportSrc(spec.rel);
  if (failIfUnimplemented(t, res, `WP src/${spec.rel}`, clauses)) return null;
  const backend = spec.pick(res.module);
  assert.ok(backend && typeof backend.search === "function", `${spec.rel} 必须提供 A5 后端 { type, search }`);
  harness.deps.backends.set(type, backend);
  harness.fetchFn.when(() => true).fails({ error: makeError() });
  const err = await harness.runToError(harness.search());
  return { err, calls: harness.fetchFn.count() };
}

for (const { type } of BACKENDS) {
  test(`P1-1 ${type}：ctx.fetch 带码错误（ENTRY_PROXY/CONFIG码/TRANSPORT_RELEASED）经链终态保留原码（裸原码或 attempts 原码），不压成 ENTRY_NETWORK（FB-005/#12-26）`, async (t) => {
    const clauses = "P1-1/FB-005/#12-26";
    const problems = [];
    for (const c of PASTHROUGH_CASES) {
      const r = await runChainWithFetchError(t, clauses, type, () => codedError(c.code));
      if (!r) return;
      const { err, calls } = r;
      if (calls !== 1) {
        problems.push(`${c.label}：出站应恰好 1 次，实测=${calls}`);
      }
      if (c.chain === "attempts") {
        // ENTRY_PROXY 是可降级条目分类（FB-005 代理）：链终态仍 UPSTREAM_FAILURES（出口 v0.2 不变），
        // 但 attempts 码必须是 ENTRY_PROXY —— 压成 ENTRY_NETWORK 即违反「必须区分代理」。
        if (err?.code !== C.CHAIN_CODES.UPSTREAM_FAILURES) {
          problems.push(`${c.label}：链终态应仍为 ${C.CHAIN_CODES.UPSTREAM_FAILURES}（出口 v0.2 不变），实测=${String(err?.code)}`);
        }
        const attempts = err?.details?.attempts;
        if (!Array.isArray(attempts) || attempts.length !== 1) {
          problems.push(`${c.label}：attempts 应恰 1 条，实测=${JSON.stringify(attempts)}`);
        } else if (attempts[0].code !== C.ENTRY_CODES.PROXY) {
          problems.push(
            `${c.label}：attempts[0].code 应保留原码 ${C.ENTRY_CODES.PROXY}（FB-005 必须区分代理），实测=${String(attempts[0].code)}`,
          );
        }
      } else if (c.chain === "same-as-p2b4") {
        // 条目执行期 CONFIG_*（PR#35 裁决补充，与 P2-b④ 同判）：一律条目级降级——单条目全败的
        // 终态形状（WebError.attempts 携原码）由 chain-coded-failure-policy④ 强制红（现实现裸原码
        // 上抛 → 属降级三例红面，实现落地包修复），本行不双钉形状，只钉 #12-26 本义「码不被压扁」：
        // 原码必须存活到终态观察面（裸原码透传或 attempts 原码），绝不得压成 ENTRY_NETWORK 等改写。
        const attempts = err?.details?.attempts;
        const barePassthrough = err?.code === c.code && !Array.isArray(attempts);
        const downgradedWithCode =
          err?.code === C.CHAIN_CODES.UPSTREAM_FAILURES &&
          Array.isArray(attempts) && attempts.length === 1 && attempts[0].code === c.code;
        if (!barePassthrough && !downgradedWithCode) {
          problems.push(
            `${c.label}：链终态必须保留原码 ${c.code}（裸原码或 attempts[0].code，与 P2-b④ 同判），实测 code=${String(err?.code)} attempts=${JSON.stringify(attempts)}`,
          );
        }
      } else {
        // TRANSPORT_RELEASED：非条目分类、非 CONFIG_* 的程序违约（释放后拒发）仍原样暴露（FB-005），
        // 不得包装为带 attempts 的 WebError、不得改码；链出口保持 v0.2。
        // （裁决补充：「原样暴露不包装」对 CONFIG_* 只对全局 CONFIG_* 成立，见 P2-b⑤。）
        if (err?.code !== c.code) {
          problems.push(
            `${c.label}：应以原码 ${c.code} 原样暴露（程序违约不包装），实测 code=${String(err?.code)}`,
          );
        }
        if (Array.isArray(err?.details?.attempts)) {
          problems.push(
            `${c.label}：程序违约不得被包装成带 attempts 的 WebError，实测 attempts=${JSON.stringify(err.details.attempts)}`,
          );
        }
      }
    }
    assert.deepEqual(problems, [], `${type}：带码错误透传存在压扁/包装（预期红：B 包修复前 main 一律压成 ENTRY_NETWORK）`);
  });

  test(`P1-1 ${type}：无码错误仍归 ENTRY_NETWORK（既有面不动，FB-005 直连网络兜底）`, async (t) => {
    const r = await runChainWithFetchError(t, "P1-1/FB-005 既有面", type, () => plainNetworkError());
    if (!r) return;
    const { err, calls } = r;
    assert.equal(calls, 1, "无码故障出站恰好一次（FB-001 每条目至多一次）");
    assert.equal(err?.code, C.CHAIN_CODES.UPSTREAM_FAILURES, "单条目链全失败终态（出口 v0.2）");
    assert.equal(
      err?.details?.attempts?.[0]?.code,
      C.ENTRY_CODES.NETWORK,
      "无码错误仍 ENTRY_NETWORK：FB-005 直连网络兜底，本轮不得改动此既有面",
    );
  });
}

// ─── 传输层自身：createEntryTransport 注入 fetch 带码错误同样不得压成 ENTRY_NETWORK ──────────
// transport.mapFetchError 只放行 TransportError 实例；装配层 dispatcher 抛出的普通 Error 带码
// （ENTRY_PROXY / CONFIG_CODES / TRANSPORT_RELEASED）同样必须透传（P1-1 名目所在：transport 码透传）。

async function loadTransportFactory(t, clauses) {
  const res = await tryImportSrc("transport.js");
  if (failIfUnimplemented(t, res, "WP1 src/transport.js", clauses)) return null;
  return res.module.createEntryTransport;
}

/** 直连条目（proxy 省略 = 直连，CFG-001），注入 fetch 恒抛 makeError()。 */
function directTransport(createEntryTransport, makeError) {
  return createEntryTransport(
    { id: "p11-tp", type: "tavily", name: "P1-1 传输层直连条目" },
    { fetch: async () => { throw makeError(); } },
  );
}

test("P1-1（transport 层）：直连路由下注入 fetch 的带码错误原码透传，不压成 ENTRY_NETWORK（FB-005/#12-26）", async (t) => {
  const createEntryTransport = await loadTransportFactory(t, "P1-1/CFG-001/FB-005");
  if (!createEntryTransport) return;
  const problems = [];
  for (const c of PASTHROUGH_CASES) {
    const transport = directTransport(createEntryTransport, () => codedError(c.code));
    let got;
    try {
      await transport.fetch("https://synthetic-host.invalid/probe");
      got = "⟨resolve 未拒绝⟩";
    } catch (err) {
      got = err?.code;
    }
    if (got !== c.code) {
      problems.push(`${c.label}：handle.fetch 拒绝码应保留原码 ${c.code}，实测=${String(got)}`);
    }
  }
  assert.deepEqual(problems, [], "transport 层把带码错误压成了 ENTRY_NETWORK（预期红：B 包修复前 main 行为）");
});

test("P1-1（transport 层）：直连路由无码错误仍 TransportError(ENTRY_NETWORK)（既有面不动）", async (t) => {
  const createEntryTransport = await loadTransportFactory(t, "P1-1 既有面");
  if (!createEntryTransport) return;
  const transport = directTransport(createEntryTransport, () => plainNetworkError());
  await assert.rejects(
    () => transport.fetch("https://synthetic-host.invalid/probe"),
    (err) => {
      assert.equal(err?.code, C.ENTRY_CODES.NETWORK, "无码直连故障仍归 ENTRY_NETWORK（FB-005 既有兜底面）");
      return true;
    },
  );
});
