// PR#35 审阅补口 oracle（P2-b）— 链层钉桩：条目适配器抛「已带码错误」时链的消费策略。
//
// lead 裁决（本工作包落地，裁决原文如实记录）：
//   【条目执行期】适配器上抛的带码错误（含 CONFIG_*、PAC_*）按【条目级失败降级】——
//   该条目 broken 不代表其他条目 broken，弹性优先；attempts 保留原码原样；
//   全部条目皆败时终态 WebError.attempts 携各条原码。
//   【全局 CONFIG_*】（链级配置读取自身失败，无条目上下文）仍硬失败不降级。
//   CFG-005 只管报阶段，链弹性归 FB 家族，此为本裁决补位。
//
// 按裁决划分的本文件各面：
//   ① ENTRY_PROXY（条目级归因码）：按 FB-005 可降级条目失败处理——记录尝试（保留原码）后
//      降级到下一条目；后续条目成功 → 成功结果照常返回（FB-001 首个有效来源即停）。
//      成功路径无 WebError，attempts 记录从链的 warn 日志观察（失败路径的 attempts 已由
//      transport-passthrough.test.js P1-1 单条目面钉住）。——绿，勿动。
//   ② CONFIG_INVALID（条目执行期抛码）：裁决改判后按条目级失败降级——降到下一条目成功；
//      attempts 记录保留 CONFIG_INVALID 原码（成功路径可观察面 = warn 日志，与①同面）；
//      FB-002 接管提示须让首条失败原因可诊断。（旧版曾钉「CONFIG_* 不降级、原码 Loud」，
//      经 lead 裁决翻转为条目级降级；现实现不降级 → 本用例预期红。）
//   ③ PAC_ROUTE_FAILED（条目执行期抛码，CFG-005 路由/建连阶段）：与②同款降级；
//      CFG-005 只管报阶段，链弹性归 FB 家族。（新增；现实现不降级 → 预期红。）
//   ④ 全败面：条目执行期 CONFIG_* 与条目执行期网络失败逐条发生 → 全部启用条目皆败 →
//      终态 WebError（FB-004 出口 v0.2：CHAIN_UPSTREAM_FAILURES）details.attempts
//      按尝试顺序携各条原码。（新增；现实现于首个 CONFIG_* 即原样上抛 → 预期红。）
//   ⑤ 全局 CONFIG_*：链级配置读取自身失败（deps.getConfig 抛码，无条目上下文）→
//      硬失败：原错误对象原样上抛、零条目执行、零出站。（现实现已如此 → 记绿防回归。）
//
// 语义边界（PR#35 裁决补充，lead 同判——张力已清，本轮落地）：
//   - transport-passthrough.test.js 链级 CONFIG 行与④（全败终态 WebError 携原码）在单条目全败
//     特例上的张力已同判：条目执行期 CONFIG_*/PAC_* 与 PROXY 一律条目级降级，「原样暴露不包装」
//     只对全局 CONFIG_*（链级配置读取失败，⑤）成立。该行已改为只钉防压扁面（原码裸原码或
//     attempts 原码存活到终态），终态形状由④强制红；其传输/适配器级行（原码原样透传）不动。
//   - helpers/contract.js assertWebError 的 attempts 码白名单已并入 CONFIG_CODES 原码面
//     （ENTRY_CODES ∪ CONFIG_CODES ∪ {SKIPPED_NO_KEY}，含 PAC_*；A7 镜像注释同步）。
//     ④ 维持直接断言 details.attempts 不借道 assertWebError，测试期望不因此改动。
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_QUERY } from "./helpers/chain-harness.js";
import { stepSuccess, stepFail } from "./helpers/fake-backend.js";
import {
  ENTRY_CODES,
  CONFIG_CODES,
  CHAIN_CODES,
  assertSearchResult,
  makeSources,
} from "./helpers/contract.js";
import { chainHarness, keyedEntry, refsFor } from "./helpers/search-oracle.js";

// ─── ① ENTRY_PROXY：条目级失败 → 降级下一条目 ─────────────────────────────────────────

test("P2-b①：条目适配器抛 ENTRY_PROXY → 按条目级失败降级下一条目；后续条目成功 → 成功结果且尝试记录保留 PROXY 原码", async (t) => {
  const s = makeSources(2, "https://synthetic-p2b.invalid/doc");
  const h = await chainHarness(t, "P2-b/FB-001/FB-005", {
    entries: [
      keyedEntry("p2b-e1", "openai", "条目甲"),
      keyedEntry("p2b-e2", "tavily", "条目乙"),
      keyedEntry("p2b-e3", "exa", "条目丙"),
    ],
    credentialRefs: refsFor("p2b-e1", "p2b-e2", "p2b-e3"),
    steps: {
      "p2b-e1": [stepFail({ code: ENTRY_CODES.PROXY, message: "synthetic proxy failure" })],
      "p2b-e2": [stepSuccess({ sources: s })],
      "p2b-e3": [stepSuccess({ sources: makeSources(1, "https://synthetic-p2b-c.invalid/doc") })],
    },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));

  // 成功照常收敛：降级到下一条目后首个有效来源即停（FB-001），前序失败以接管提示标注（FB-002）。
  assertSearchResult(t, res, { sources: s, truncated: false, entryName: "条目乙" });
  assert.match(
    res.content.split("\n")[0],
    /代理失败/,
    "接管提示首行须按失败分类一字概括标注前序条目为代理失败（FB-002 接管提示，PROXY 归因不得丢）",
  );

  // 降级执行面：e1 失败 → e2 成功即停；e3 不发请求；失败条目至多一次。
  assert.deepEqual(
    h.executions().map((c) => c.entryId),
    ["p2b-e1", "p2b-e2"],
    "P2-b①：ENTRY_PROXY 是可降级条目级失败，链须继续下一启用条目而非终止",
  );
  assert.equal(h.executionCount("p2b-e1"), 1, "FB-001：失败条目至多提交一次，不重试");
  assert.equal(h.executionCount("p2b-e3"), 0, "FB-001：首个有效来源之后的条目不得发出请求");

  // attempts 记 PROXY：成功路径无 WebError，逐条尝试记录以链的 warn 日志为可观察面（A7/FB-005）。
  const rec = h.logCapture.entries.find(
    (e) => e.message === "search-chain 条目失败" && e.rest?.[0]?.entryId === "p2b-e1",
  );
  assert.ok(rec, "降级条目须留下一次条目失败记录（attempts 记录的成功路径可观察面）");
  assert.equal(
    rec.rest[0].code,
    ENTRY_CODES.PROXY,
    `尝试记录须保留原码 ${ENTRY_CODES.PROXY}（P1-1 透传语义），不得改写成 ENTRY_NETWORK 等`,
  );
});

// ─── ② 条目执行期 CONFIG_INVALID：裁决改判 → 条目级降级 ────────────────────────────────

test("P2-b②（裁决改判）：条目执行期抛 CONFIG_INVALID → 条目级降级；降到 e2 成功 → 成功结果 + attempts[0].code=CONFIG_INVALID + 首条失败原因可诊断", async (t) => {
  const s = makeSources(2, "https://synthetic-p2b-cfg.invalid/doc");
  const h = await chainHarness(t, "P2-b/lead裁决-条目级降级/FB-001/FB-002", {
    entries: [
      keyedEntry("p2b-c1", "openai", "条目甲"),
      keyedEntry("p2b-c2", "tavily", "条目乙"),
      keyedEntry("p2b-c3", "exa", "条目丙"),
    ],
    credentialRefs: refsFor("p2b-c1", "p2b-c2", "p2b-c3"),
    steps: {
      "p2b-c1": [stepFail({ code: CONFIG_CODES.INVALID, message: "synthetic entry-phase config violation" })],
      "p2b-c2": [stepSuccess({ sources: s })],
      "p2b-c3": [stepSuccess({ sources: makeSources(1, "https://synthetic-p2b-c3.invalid/doc") })],
    },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));

  // 裁决：条目执行期的 CONFIG_INVALID 只说明该条目 broken，不代表其他条目 broken（弹性优先）。
  assertSearchResult(t, res, { sources: s, truncated: false, entryName: "条目乙" });

  assert.deepEqual(
    h.executions().map((c) => c.entryId),
    ["p2b-c1", "p2b-c2"],
    "P2-b②：条目执行期 CONFIG_* 是可降级条目级失败——链须继续下一启用条目而非整链终止（lead 裁决）",
  );
  assert.equal(h.executionCount("p2b-c1"), 1, "FB-001：失败条目至多提交一次，不重试");
  assert.equal(h.executionCount("p2b-c3"), 0, "FB-001：首个有效来源之后的条目不得发出请求");

  // attempts[0].code=CONFIG_INVALID：成功路径无 WebError，attempts 可观察面 = warn 日志（与①同面）。
  const rec = h.logCapture.entries.find(
    (e) => e.message === "search-chain 条目失败" && e.rest?.[0]?.entryId === "p2b-c1",
  );
  assert.ok(rec, "降级条目须留下一次条目尝试记录（成功路径的 attempts 可观察面）");
  assert.equal(
    rec.rest[0].code,
    CONFIG_CODES.INVALID,
    `attempts[0].code 须原样保留 ${CONFIG_CODES.INVALID}（裁决：attempts 保留原码原样），不得压成 ENTRY_* 或改写为 CHAIN_*`,
  );

  // 首条失败原因可诊断：FB-002 接管提示首行须标注前序条目及其失败归因（字面措辞不限，须可定位）。
  const firstLine = res.content.split("\n")[0];
  assert.match(firstLine, /条目甲/, "接管提示须标注失败的条目名（FB-002）");
  assert.match(
    firstLine,
    /配置|CONFIG/,
    "首条失败原因可诊断：首行须让使用者看出前序条目因配置面失败被降级（CONFIG_* 归因不得静默或错标）",
  );
  assert.doesNotMatch(firstLine, /undefined/, "失败描述缺映射导致 undefined 泄漏即不可诊断（FB-002 接管提示）");
});

// ─── ③ 条目执行期 PAC_ROUTE_FAILED：同款降级（CFG-005 只报阶段，弹性归 FB 家族） ─────────

test("P2-b③：条目执行期抛 PAC_ROUTE_FAILED → 条目级降级（②同款）；e2 成功 + attempts[0].code=PAC_ROUTE_FAILED + 接管提示路由阶段可诊断", async (t) => {
  const s = makeSources(1, "https://synthetic-p2b-pac.invalid/doc");
  const h = await chainHarness(t, "P2-b/lead裁决-条目级降级/CFG-005/FB-002", {
    entries: [
      keyedEntry("p2b-d1", "openai", "条目甲"),
      keyedEntry("p2b-d2", "tavily", "条目乙"),
    ],
    credentialRefs: refsFor("p2b-d1", "p2b-d2"),
    steps: {
      "p2b-d1": [stepFail({ code: CONFIG_CODES.PAC_ROUTE_FAILED, message: "synthetic entry-phase pac route failure" })],
      "p2b-d2": [stepSuccess({ sources: s })],
    },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));

  assertSearchResult(t, res, { sources: s, truncated: false, entryName: "条目乙" });

  assert.deepEqual(
    h.executions().map((c) => c.entryId),
    ["p2b-d1", "p2b-d2"],
    "P2-b③：PAC_* 与 CONFIG_* 同属条目执行期带码错误 → 条目级降级（lead 裁决；CFG-005 只管报阶段）",
  );
  assert.equal(h.executionCount("p2b-d1"), 1, "FB-001：失败条目至多提交一次，不重试");

  const rec = h.logCapture.entries.find(
    (e) => e.message === "search-chain 条目失败" && e.rest?.[0]?.entryId === "p2b-d1",
  );
  assert.ok(rec, "降级条目须留下一次条目尝试记录");
  assert.equal(
    rec.rest[0].code,
    CONFIG_CODES.PAC_ROUTE_FAILED,
    `attempts[0].code 须原样保留 ${CONFIG_CODES.PAC_ROUTE_FAILED}（裁决：attempts 保留原码原样；阶段归因不得丢）`,
  );

  const firstLine = res.content.split("\n")[0];
  assert.match(firstLine, /条目甲/, "接管提示须标注失败的条目名（FB-002）");
  assert.match(
    firstLine,
    /路由|建连|PAC/,
    "接管提示须可诊断到 PAC 路由/建连阶段（CFG-005 报阶段面），不得静默或错标成代理/网络失败",
  );
  assert.doesNotMatch(firstLine, /undefined/, "失败描述缺映射导致 undefined 泄漏即不可诊断（FB-002 接管提示）");
});

// ─── ④ 全败面：终态 WebError.attempts 携各条原码 ───────────────────────────────────────

test("P2-b④：全部条目皆败（e1 条目执行期 CONFIG_INVALID + e2 网络失败）→ 终态 WebError.attempts 按尝试顺序携各条原码", async (t) => {
  const h = await chainHarness(t, "P2-b/lead裁决-全败面/FB-004", {
    entries: [
      keyedEntry("p2b-f1", "openai", "条目甲"),
      keyedEntry("p2b-f2", "tavily", "条目乙"),
    ],
    credentialRefs: refsFor("p2b-f1", "p2b-f2"),
    steps: {
      "p2b-f1": [stepFail({ code: CONFIG_CODES.INVALID, message: "synthetic entry-phase config violation" })],
      "p2b-f2": [stepFail({ code: ENTRY_CODES.NETWORK, message: "synthetic direct network failure" })],
    },
  });
  const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));

  // 降级后全部启用条目皆败 → FB-004 终态收敛（出口 v0.2），不再于首个 CONFIG_* 处原样上抛。
  assert.equal(err?.name, "WebError", "全部条目皆败须收敛为终态 WebError（A7/FB-004），而非首个条目的裸错误");
  assert.equal(
    err?.code,
    CHAIN_CODES.UPSTREAM_FAILURES,
    `全败终态码仍为 ${CHAIN_CODES.UPSTREAM_FAILURES}（FB-004 出口 v0.2 不变；裁决只补 attempts 原码面）`,
  );

  const attempts = err?.details?.attempts;
  assert.ok(
    Array.isArray(attempts) && attempts.length === 2,
    `attempts 须按尝试顺序列出两个条目，实测=${JSON.stringify(attempts)}`,
  );
  assert.deepEqual(
    attempts.map((a) => a.entryId),
    ["p2b-f1", "p2b-f2"],
    "attempts 顺序 = 尝试顺序（A7）",
  );
  assert.equal(
    attempts[0].code,
    CONFIG_CODES.INVALID,
    `终态 attempts 须携条目 1 原码 ${CONFIG_CODES.INVALID}（裁决：attempts 保留原码原样，CONFIG_* 不得被改写或压平）`,
  );
  assert.equal(
    attempts[1].code,
    ENTRY_CODES.NETWORK,
    `终态 attempts 须携条目 2 原码 ${ENTRY_CODES.NETWORK}`,
  );
  for (const [i, a] of attempts.entries()) {
    assert.equal(typeof a.reason, "string", `attempts[${i}].reason 须为可核查文本`);
    assert.ok(a.reason.length > 0, `attempts[${i}].reason 不得为空（终态可诊断）`);
  }

  assert.equal(h.executionCount("p2b-f1"), 1, "FB-001：降级不重试，每条目至多一次");
  assert.equal(h.executionCount("p2b-f2"), 1, "条目 1 降级后条目 2 须被尝试");
});

// ─── ⑤ 全局 CONFIG_*：链级配置读取自身失败 → 硬失败不降级（现实现已达，记绿防回归） ───────

test("P2-b⑤：全局 CONFIG_*（deps.getConfig 读取自身失败，无条目上下文）→ 原错误原样上抛、不跑条目（硬失败不降级）", async (t) => {
  const CFG_ERR = new Error("synthetic chain-level config read failure");
  CFG_ERR.code = CONFIG_CODES.INVALID;
  const h = await chainHarness(t, "P2-b/lead裁决-全局面/FB-005", {
    entries: [keyedEntry("p2b-g1", "openai", "条目甲"), keyedEntry("p2b-g2", "tavily", "条目乙")],
    credentialRefs: refsFor("p2b-g1", "p2b-g2"),
    steps: {
      "p2b-g1": [stepSuccess({ sources: makeSources(1, "https://synthetic-p2b-g1.invalid/doc") })],
      "p2b-g2": [stepSuccess({ sources: makeSources(1, "https://synthetic-p2b-g2.invalid/doc") })],
    },
    getConfigThrows: CFG_ERR,
  });
  let err;
  try {
    err = await h.runToError(h.search({ query: DEFAULT_QUERY }));
  } catch (thrown) {
    err = thrown; // 现实现同步读配置：同步上抛与拒绝同为合法的「原样上抛」出口
  }

  assert.equal(err, CFG_ERR, "全局 CONFIG_*：原错误对象原样上抛——不改码、不包装、不降级（lead 裁决：全局面仍硬失败）");
  assert.ok(!Array.isArray(err?.details?.attempts), "无条目上下文：不得产生 attempts 或条目级降级记录");
  assert.ok(h.configReads >= 1, "失败须确实源自链级配置读取（而非旁路）");
  assert.equal(h.executions().length, 0, "全局配置失败：一个条目都不得执行（无条目上下文不谈降级）");
  assert.equal(h.fetchFn.count(), 0, "全局配置失败：零出站");
});
