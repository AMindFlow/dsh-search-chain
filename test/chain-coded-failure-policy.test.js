// PR#35 审阅补口 oracle（P2-b）— 链层钉桩：条目适配器抛「已带码错误」的两条链级策略。
//
// 转绿面：钉住 P1-1 透传修复后的设计语义，防后续回归；两用例当前实现即为绿，勿留红。
//   ① ENTRY_PROXY（条目级归因码）：链按 FB-005 可降级条目失败处理——记录尝试（保留原码）后
//      降级到下一条目；后续条目成功 → 成功结果照常返回（FB-001 首个有效来源即停）。
//      成功路径无 WebError，attempts 记录从链的 warn 日志观察（失败路径的 attempts 已由
//      transport-passthrough.test.js P1-1 单条目面钉住：attempts[0].code 保留 ENTRY_PROXY）。
//   ② CONFIG_*（config 面全局违约）：非 ENTRY_CODES 分类 → 链不降级、不再发起新请求，
//      终态错误原样携带原码（Loud，FB-005「内部程序违约原样暴露」）。
//      语义注记（如实报来，勿迁就）：任务表述为「终态 WebError 携带原码」，但既有绿面
//      transport-passthrough.test.js（P1-1 CONFIG 行）已明文钉「不得包装为带 attempts 的
//      WebError、不得改码」，且 src/search.js 头注第 16 行同为「程序违约原样暴露，不包装」。
//      本用例据此钉「原码 + 不包装 + 不降级」；若审阅裁决要求改为 WebError 包装并携带原码，
//      属新的终态语义变更（会与既有 P1-1 期望冲突），须另行裁决后同改两处。
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_QUERY } from "./helpers/chain-harness.js";
import { stepSuccess, stepFail } from "./helpers/fake-backend.js";
import { ENTRY_CODES, CONFIG_CODES, assertSearchResult, makeSources } from "./helpers/contract.js";
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

// ─── ② CONFIG_*：config 面全局违约 → 不降级、原码 Loud ────────────────────────────────

test("P2-b②：条目适配器抛 CONFIG_INVALID → 链不降级、不再发起新请求；终态错误原样携带原码（config 面全局违约 Loud）", async (t) => {
  const CONFIG_MSG = "synthetic config violation from adapter";
  const h = await chainHarness(t, "P2-b/FB-005", {
    entries: [
      keyedEntry("p2b-c1", "openai", "违约条目甲"),
      keyedEntry("p2b-c2", "tavily", "健康条目乙"),
    ],
    credentialRefs: refsFor("p2b-c1", "p2b-c2"),
    steps: {
      "p2b-c1": [stepFail({ code: CONFIG_CODES.INVALID, message: CONFIG_MSG })],
      "p2b-c2": [stepSuccess({ sources: makeSources(1, "https://synthetic-p2b-ok.invalid/doc") })],
    },
  });
  const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));

  // Loud：原码出门——既不得压成 ENTRY_NETWORK，也不得替换为链级终态码。
  assert.equal(
    err?.code,
    CONFIG_CODES.INVALID,
    `终态错误必须携带原码 ${CONFIG_CODES.INVALID}（config 面全局违约不降级；压码或换 CHAIN_* 终态码均丢失违约归因）`,
  );
  assert.equal(err?.message, CONFIG_MSG, "FB-005：程序违约原样暴露——message 不动（原错误出门，不重新包装文案）");
  assert.ok(
    !Array.isArray(err?.details?.attempts),
    "既有 P1-1 期望：CONFIG 违约不得被包装为带 attempts 的终态 WebError（原样暴露面，见文件头语义注记）",
  );

  // 不降级：违约之后的条目一个都不发；违约条目自身也不重试。
  assert.equal(h.executionCount("p2b-c2"), 0, "CONFIG_* 全局违约：链不得降级到后续条目（FB-005 不再发起新请求）");
  assert.equal(h.executionCount("p2b-c1"), 1, "FB-001：违约条目至多一次");
});
