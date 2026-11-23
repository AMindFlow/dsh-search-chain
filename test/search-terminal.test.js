// WP5 验收 — FB-004（空语义与终态错误）、FB-005（错误分类与脱敏、程序违约暴露）
// 以及三类黄金场景（全链无结果 / 全链失败 / 单条成功）的完整结果对象快照。
// 实现模块：src/search.js（createSearchChain + 链码 CHAIN_CODES / 条目码 ENTRY_CODES）。
// 尚未实现时全部为红（等待实现 WP5），不得改为 skip。
//
// oracle 假设（写在断言旁，最终报告同步列出）：
//   · 明确无结果（stepEmpty）的条目不计入 attempts（ALLOWED 码集中没有「空结果」码）；
//   · 缺 key 跳过的条目计入 attempts，code=SKIPPED_NO_KEY，reason 说明缺失的凭据名；
//   · 停用条目不计入 attempts（它不是失败，见 FB-002「停用条目不构成…」）。
import test from "node:test";
import assert from "node:assert/strict";
import { stepSuccess, stepFail, stepEmpty, stepProgramError } from "./helpers/fake-backend.js";
import {
  ENTRY_CODES,
  CHAIN_CODES,
  SKIPPED_NO_KEY,
  KEY_ENV_BY_TYPE,
  assertSearchResult,
  assertWebError,
  makeEntry,
  makeSources,
  makeSource,
} from "./helpers/contract.js";
import { DEFAULT_QUERY } from "./helpers/chain-harness.js";
import { loadFixture, FIXTURE_NAMES } from "./helpers/fixtures.js";
import { SYNTHETIC_KEY } from "./helpers/fake-fetch.js";
import { assertNoSecrets, assertNoRawBody } from "./helpers/redact.js";
import { chainHarness, keyedEntry, refsFor, plain } from "./helpers/search-oracle.js";

const CLAUSES = "FB-004/FB-005";

// ─── FB-004：空语义与终态错误 ─────────────────────────────────────────────────

test("FB-004：空列表 → 未配置可用工具（CHAIN_CODES.NOT_CONFIGURED），无尝试记录", async (t) => {
  const h = await chainHarness(t, CLAUSES, { entries: [] });
  const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));
  assertWebError(err, { code: CHAIN_CODES.NOT_CONFIGURED, attempts: [] });
  assert.equal(h.executions().length, 0, "FB-004：未配置时不得出站");
});

test("FB-004：全部停用 → 未配置可用工具（CHAIN_CODES.NOT_CONFIGURED），停用条目不计入尝试", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [
      makeEntry({ id: "e-a", type: "openai", name: "停用甲", enabled: false }),
      makeEntry({ id: "e-b", type: "tavily", name: "停用乙", enabled: false }),
    ],
  });
  const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));
  assertWebError(err, { code: CHAIN_CODES.NOT_CONFIGURED, attempts: [] });
  assert.equal(h.executions().length, 0, "FB-004：全部停用时不得出站");
});

test("FB-004：全部启用条目缺必要凭据 → ALL_KEYS_MISSING，按序附跳过原因并说明缺失的凭据名", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [
      makeEntry({ id: "e-a", type: "openai", name: "无钥甲", enabled: true }),
      makeEntry({ id: "e-b", type: "tavily", name: "无钥乙", enabled: true }),
    ],
  });
  const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));
  assertWebError(err, {
    code: CHAIN_CODES.ALL_KEYS_MISSING,
    attempts: [
      { entryId: "e-a", code: SKIPPED_NO_KEY },
      { entryId: "e-b", code: SKIPPED_NO_KEY },
    ],
  });
  assert.ok(err.details.attempts[0].reason.includes(KEY_ENV_BY_TYPE.openai), "FB-004：跳过原因须说明缺失的凭据名（OPENAI_API_KEY）");
  assert.ok(err.details.attempts[1].reason.includes(KEY_ENV_BY_TYPE.tavily), "FB-004：跳过原因须说明缺失的凭据名（TAVILY_API_KEY）");
  assert.equal(h.executions().length, 0, "FB-001：缺 key 全部跳过时零出站");
});

test("FB-004：单个明确空结果 → 成功终态 {sources: [], truncated: false}（与全部失败严格区分）", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-a", "tavily", "条目甲")],
    credentialRefs: refsFor("e-a"),
    steps: { "e-a": [stepEmpty()] },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assertSearchResult(t, res, { sources: [], truncated: false });
  assert.deepEqual(plain(res), { sources: [], truncated: false }, "FB-004：空成功终态的完整对象（无 content 时）");
});

test("FB-004：全部条目均明确无结果 → 空成功终态，不得抛错", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-a", "tavily", "条目甲"), keyedEntry("e-b", "exa", "条目乙")],
    credentialRefs: refsFor("e-a", "e-b"),
    steps: { "e-a": [stepEmpty()], "e-b": [stepEmpty()] },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assertSearchResult(t, res, { sources: [], truncated: false });
});

test("FB-004：仅跳过（缺 key）+ 明确空结果，无失败 → 成功空终态（跳过不是失败）", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [makeEntry({ id: "e-a", type: "openai", name: "无钥甲", enabled: true }), keyedEntry("e-b", "exa", "条目乙")],
    credentialRefs: refsFor("e-b"),
    steps: { "e-b": [stepEmpty()] },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assertSearchResult(t, res, { sources: [], truncated: false });
});

test("FB-004：全部失败（无空结果）→ 抛 WebError，不得与空成功终态混同", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-a", "openai", "条目甲"), keyedEntry("e-b", "tavily", "条目乙")],
    credentialRefs: refsFor("e-a", "e-b"),
    steps: {
      "e-a": [stepFail({ code: ENTRY_CODES.NETWORK })],
      "e-b": [stepFail({ code: ENTRY_CODES.QUOTA })],
    },
  });
  const outcome = await h.runUntilSettled(h.search({ query: DEFAULT_QUERY }));
  assert.equal(outcome.ok, false, "FB-004：存在失败且未获有效来源时必须抛错，不得返回空成功");
  assertWebError(outcome.error, {
    code: CHAIN_CODES.UPSTREAM_FAILURES,
    attempts: [
      { entryId: "e-a", code: ENTRY_CODES.NETWORK },
      { entryId: "e-b", code: ENTRY_CODES.QUOTA },
    ],
  });
});

test("FB-004：前项失败、末项正常空 → 仍返回含失败原因的 WebError（attempts 仅含失败/跳过条目）", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-a", "openai", "条目甲"), keyedEntry("e-b", "tavily", "条目乙")],
    credentialRefs: refsFor("e-a", "e-b"),
    steps: {
      "e-a": [stepFail({ code: ENTRY_CODES.RATE_LIMITED })],
      "e-b": [stepEmpty()],
    },
  });
  const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));
  assertWebError(err, {
    code: CHAIN_CODES.UPSTREAM_FAILURES,
    attempts: [{ entryId: "e-a", code: ENTRY_CODES.RATE_LIMITED }],
  });
});

test("FB-004：混合跳过（缺 key）与失败 → UPSTREAM_FAILURES，attempts 按尝试顺序含跳过条目", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-a", "openai", "条目甲"), makeEntry({ id: "e-b", type: "tavily", name: "无钥乙", enabled: true })],
    credentialRefs: refsFor("e-a"),
    steps: { "e-a": [stepFail({ code: ENTRY_CODES.NETWORK })] },
  });
  const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));
  assertWebError(err, {
    code: CHAIN_CODES.UPSTREAM_FAILURES,
    attempts: [
      { entryId: "e-a", code: ENTRY_CODES.NETWORK },
      { entryId: "e-b", code: SKIPPED_NO_KEY },
    ],
  });
});

// ─── FB-005：失败分类与脱敏、程序违约 ─────────────────────────────────────────

test("FB-005：每个可降级条目码均推进到下一条目；末条成功即返回", async (t) => {
  const degradable = [
    ENTRY_CODES.CREDENTIALS,
    ENTRY_CODES.QUOTA,
    ENTRY_CODES.RATE_LIMITED,
    ENTRY_CODES.PROXY,
    ENTRY_CODES.NETWORK,
    ENTRY_CODES.CHANNEL_LIMIT,
    ENTRY_CODES.TIMEOUT,
    ENTRY_CODES.BAD_RESPONSE,
  ];
  for (const code of degradable) {
    const h = await chainHarness(t, CLAUSES, {
      entries: [keyedEntry("e-a", "openai", "条目甲"), keyedEntry("e-b", "tavily", "条目乙")],
      credentialRefs: refsFor("e-a", "e-b"),
      steps: {
        "e-a": [stepFail({ code })],
        "e-b": [stepSuccess({ sources: makeSources(1) })],
      },
    });
    const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
    assertSearchResult(t, res, { sources: makeSources(1), entryName: "条目乙" });
    assert.equal(h.executionCount("e-b"), 1, `FB-005：可降级码 ${code} 之后应推进到下一条目`);
  }
});

test("FB-005：内容策略拒绝（ENTRY_CONTENT_POLICY）为终止类 → 链级 CONTENT_POLICY，后续条目不出站", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-a", "openai", "条目甲"), keyedEntry("e-b", "tavily", "条目乙")],
    credentialRefs: refsFor("e-a", "e-b"),
    steps: {
      "e-a": [stepFail({ code: ENTRY_CODES.CONTENT_POLICY })],
      "e-b": [stepSuccess({ sources: makeSources(1) })],
    },
  });
  const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));
  assertWebError(err, {
    code: CHAIN_CODES.CONTENT_POLICY,
    attempts: [{ entryId: "e-a", code: ENTRY_CODES.CONTENT_POLICY }],
  });
  assert.equal(h.executionCount("e-b"), 0, "FB-001/FB-005：明确内容策略拒绝须终止，不得继续下一条目");
});

test("FB-005：全部失败时，每条 attempts 保留其条目级分类码（不被合并丢失）", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-a", "openai", "条目甲"), keyedEntry("e-b", "tavily", "条目乙")],
    credentialRefs: refsFor("e-a", "e-b"),
    steps: {
      "e-a": [stepFail({ code: ENTRY_CODES.PROXY })],
      "e-b": [stepFail({ code: ENTRY_CODES.BAD_RESPONSE })],
    },
  });
  const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));
  assertWebError(err, {
    code: CHAIN_CODES.UPSTREAM_FAILURES,
    attempts: [
      { entryId: "e-a", code: ENTRY_CODES.PROXY },
      { entryId: "e-b", code: ENTRY_CODES.BAD_RESPONSE },
    ],
  });
});

test("FB-005：程序违约（无 code）原样抛出，不被吞、不被包装为 WebError，且不再发起后续请求", async (t) => {
  const sentinel = new TypeError("synthetic internal invariant violation (test sentinel)");
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-a", "openai", "条目甲"), keyedEntry("e-b", "tavily", "条目乙"), keyedEntry("e-c", "exa", "条目丙")],
    credentialRefs: refsFor("e-a", "e-b", "e-c"),
    steps: {
      "e-a": [stepFail({ code: ENTRY_CODES.NETWORK })],
      "e-b": [stepProgramError({ error: sentinel })],
      "e-c": [stepSuccess({ sources: makeSources(1) })],
    },
  });
  const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));
  assert.equal(err, sentinel, "FB-005：程序违约必须原样暴露给调用方（同一错误对象）");
  assert.equal(err.code, undefined, "FB-005：程序违约不得被赋予 code");
  assert.equal(h.executionCount("e-c"), 0, "FB-005：程序违约后不得发起新的上游请求");
});

test("FB-005/CFG-003：失败输出脱敏——明文 key、原始报错体不得出现在错误、attempts 或日志中", async (t) => {
  const K = SYNTHETIC_KEY("tavily-leak");
  // 原始响应体（合成 HTML 拦截页）：实现若把它原样带入错误或日志即违反 CFG-003。
  const rawBody = "\u003chtml\u003e\u003cbody\u003esynthetic upstream echo page\u003c/body\u003e\u003c/html\u003e";
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-a", "tavily", "条目甲")],
    credentialRefs: refsFor("e-a"),
    steps: {
      "e-a": [
        stepFail({
          code: ENTRY_CODES.CREDENTIALS,
          message: "上游拒绝（合成）",
          cause: { detail: `upstream echoed ${K}`, body: rawBody },
        }),
      ],
    },
  });
  const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));
  assertWebError(err, {
    code: CHAIN_CODES.UPSTREAM_FAILURES,
    attempts: [{ entryId: "e-a", code: ENTRY_CODES.CREDENTIALS }],
  });
  assertNoSecrets(t, err, [K], "FB-005 终态 WebError");
  assertNoRawBody(t, err, "FB-005 终态 WebError");
  assertNoSecrets(t, h.logCapture.entries, [K], "FB-005 日志");
  assertNoRawBody(t, h.logCapture.text(), "FB-005 日志");
});

test("FB-005：错误须指出对应条目（attempts 含 entryId/entryType/entryName）以便核查配置", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-a", "brave", "Brave 主线")],
    credentialRefs: refsFor("e-a"),
    steps: { "e-a": [stepFail({ code: ENTRY_CODES.QUOTA })] },
  });
  const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));
  const [a] = err.details.attempts;
  assert.equal(a.entryId, "e-a");
  assert.equal(a.entryType, "brave", "FB-005：attempts 须附条目类型");
  assert.equal(a.entryName, "Brave 主线", "FB-005：attempts 须附条目名");
  assert.equal(typeof a.reason, "string");
  assert.ok(a.reason.length > 0, "FB-005：reason 须为可核查的脱敏文本");
});

// ─── 黄金场景：完整结果对象快照 ──────────────────────────────────────────────

test("黄金·全链无结果：两条明确空结果 → 完整对象 {sources: [], truncated: false}", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-a", "tavily", "条目甲"), keyedEntry("e-b", "exa", "条目乙")],
    credentialRefs: refsFor("e-a", "e-b"),
    steps: { "e-a": [stepEmpty()], "e-b": [stepEmpty()] },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assert.deepEqual(plain(res), { sources: [], truncated: false });
});

test("黄金·全链失败：两条失败 → UPSTREAM_FAILURES 与完整 attempts 快照", async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-a", "openai", "OpenAI 主线"), keyedEntry("e-b", "brave", "Brave 备线")],
    credentialRefs: refsFor("e-a", "e-b"),
    steps: {
      "e-a": [stepFail({ code: ENTRY_CODES.NETWORK })],
      "e-b": [stepFail({ code: ENTRY_CODES.QUOTA })],
    },
  });
  const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));
  assert.equal(err.name, "WebError");
  assert.equal(err.code, CHAIN_CODES.UPSTREAM_FAILURES);
  const snapshot = err.details.attempts.map(({ entryId, entryType, entryName, code }) => ({
    entryId,
    entryType,
    entryName,
    code,
  }));
  assert.deepEqual(snapshot, [
    { entryId: "e-a", entryType: "openai", entryName: "OpenAI 主线", code: ENTRY_CODES.NETWORK },
    { entryId: "e-b", entryType: "brave", entryName: "Brave 备线", code: ENTRY_CODES.QUOTA },
  ]);
  assert.ok(err.details.attempts.every((a) => typeof a.reason === "string" && a.reason.length > 0));
});

test("黄金·单条成功：无前序跳过/失败时完整对象 {sources, truncated: false}，无接管 content", async (t) => {
  const s = makeSources(2, "https://synthetic-single.invalid/doc");
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-a", "tavily", "条目甲")],
    credentialRefs: refsFor("e-a"),
    steps: { "e-a": [stepSuccess({ sources: s })] },
  });
  const res = await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assert.deepEqual(plain(res), { sources: s, truncated: false });
});

test("黄金·接管（fixture）：首条网络失败，备线以 maxResults=2 截断 → 与 results/search-result-basic.json 一致", async (t) => {
  const fixture = loadFixture(FIXTURE_NAMES.resultBasic);
  const [s1, s2] = fixture.result.sources;
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-a", "openai", "主线"), keyedEntry("e-b", "tavily", "Tavily 备线")],
    credentialRefs: refsFor("e-a", "e-b"),
    steps: {
      "e-a": [stepFail({ code: ENTRY_CODES.NETWORK })],
      "e-b": [stepSuccess({ sources: [s1, s2, makeSource(3, "https://synthetic-tail.invalid/doc")] })],
    },
  });
  const res = await h.runToValue(h.search({ ...fixture.request }));
  assertSearchResult(t, res, { sources: [s1, s2], truncated: true, maxResults: 2, entryName: "Tavily 备线" });
  assert.equal(res.truncated, fixture.result.truncated);
});
