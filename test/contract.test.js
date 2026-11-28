// 契约常量自测（WP0 oracle，全绿）。
// 覆盖：CAT-001 / CFG-001..003（常量面）/ FB-003 / FB-004 / FB-005（码集合）/
//       DSH-005 官方路由常量（dsh 运行时 inspect 实证）。
// 目的：锁定 helpers/contract.js 与 docs/specs 草案逐条一致；实现（WP1+）必须 import 这些常量。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { loadFixture, listFixtures, FIXTURE_NAMES, fixturePath } from "./helpers/fixtures.js";

test("项目标识与 docs/README.md 一致", () => {
  assert.equal(C.BUNDLE_NAME, "dsh-fleetseek");
  assert.equal(C.PROVIDER_ID, "search-chain");
});

test("CAT-001：七家供应商，8 个类型 id，DeepSeek 两模式", () => {
  assert.equal(C.TOOL_TYPES.length, 8);
  assert.deepEqual(C.TOOL_TYPES.filter((t) => t.startsWith("deepseek")).sort(), [
    "deepseek-agentic-search",
    "deepseek-search",
  ]);
  assert.equal(C.TOOL_SUPPLIERS.length, 7);
  for (const type of C.TOOL_TYPES) {
    assert.ok(C.TOOL_SUPPLIERS.includes(C.supplierOfToolType(type)), `${type} 必须归属目录供应商`);
  }
});

test("CAT-001 凭据列 = KEY_ENV_BY_TYPE；Bing RSS 免 key（CFG-002）", () => {
  assert.deepEqual(C.KEY_ENV_BY_TYPE, {
    openai: "OPENAI_API_KEY",
    tavily: "TAVILY_API_KEY",
    exa: "EXA_API_KEY",
    brave: "BRAVE_API_KEY",
    gemini: "GEMINI_API_KEY",
    "deepseek-search": "DEEPSEEK_API_KEY",
    "deepseek-agentic-search": "DEEPSEEK_API_KEY",
  });
  assert.deepEqual(C.KEYLESS_TYPES, ["bing"]);
  assert.deepEqual([...C.TRUSTED_ENV_KEYS].sort(), [
    "BRAVE_API_KEY",
    "DEEPSEEK_API_KEY",
    "EXA_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "TAVILY_API_KEY",
  ]);
  // 旧版 YAML 顶层兼容仅限 OpenAI/Tavily/DeepSeek（CFG-002）
  assert.deepEqual([...C.LEGACY_YAML_SUPPLIERS].sort(), ["deepseek", "openai", "tavily"]);
});

test("FB-005：条目级分类码集合完整（八类 + 终止类内容拒绝）", () => {
  assert.deepEqual(Object.values(C.ENTRY_CODES).sort(), [
    "ENTRY_BAD_RESPONSE",
    "ENTRY_CHANNEL_LIMIT",
    "ENTRY_CONTENT_POLICY",
    "ENTRY_CREDENTIALS",
    "ENTRY_NETWORK",
    "ENTRY_PROXY",
    "ENTRY_QUOTA",
    "ENTRY_RATE_LIMITED",
    "ENTRY_TIMEOUT",
  ]);
  for (const v of Object.values(C.ENTRY_CODES)) assert.match(v, /^ENTRY_/);
  assert.equal(C.SKIPPED_NO_KEY, "SKIPPED_NO_KEY");
});

test("FB-004/FB-003/CFG-005：链级与配置级码前缀稳定", () => {
  for (const v of Object.values(C.CHAIN_CODES)) assert.match(v, /^CHAIN_/);
  for (const v of Object.values(C.CONFIG_CODES)) assert.match(v, /^(CONFIG_|PAC_)/);
  // CFG-005 三阶段可报告
  for (const phase of ["PAC_FETCH_FAILED", "PAC_EVAL_FAILED", "PAC_ROUTE_FAILED"]) {
    assert.ok(Object.values(C.CONFIG_CODES).includes(phase), `缺少 PAC 阶段码 ${phase}`);
  }
});

test("FB-003：默认总预算 25000；DSH-005：官方路由常量经 inspect 实证", () => {
  assert.equal(C.DEFAULT_TIMEOUT_MS, 25000);
  assert.equal(C.OFFICIAL_ROUTE_ID, "deepseek-official");
  assert.equal(C.OFFICIAL_PROVIDER_ID, "deepseek-official");
  assert.equal(C.DEEPSEEK_ACCOUNT_ROUTE_ID, "deepseek-account"); // 账号模式必须走自定义链
});

test("assertSearchResult：合法结果通过，形状违规必抛（FB-002）", (t) => {
  const ok = {
    content: "已由「条目B」返回结果",
    sources: [{ url: "https://a.host.test/x", title: "A" }, { url: "http://b.host.test/y" }],
    truncated: true,
  };
  C.assertSearchResult(t, ok, { sources: ok.sources, entryName: "条目B", maxResults: 2, truncated: true });

  assert.throws(
    () => C.assertSearchResult(t, { sources: [{ url: "ftp://x.host.test" }], truncated: false }, {}),
    /HTTP\(S\)/,
    "非 HTTP(S) URL 必须被拒（FB-002）",
  );
  assert.throws(
    () => C.assertSearchResult(t, { sources: [], truncated: false }, { entryName: "条目B" }),
    /FB-002/,
    "接管场景缺 content 标注必须被拒",
  );
  assert.throws(
    () => C.assertSearchResult(t, { sources: [{ url: "https://a.host.test" }], truncated: false }, { maxResults: 0 }),
    /maxResults/,
    "超发必须被拒（FB-002 插件自行截断）",
  );
});

test("assertWebError：attempts 顺序与码集合受锁（FB-004/FB-005）", () => {
  const err = {
    name: "WebError",
    code: C.CHAIN_CODES.UPSTREAM_FAILURES,
    message: "全部条目未获有效来源",
    details: {
      attempts: [
        { entryId: "e1", entryType: "openai", entryName: "A", code: C.SKIPPED_NO_KEY, reason: "缺 OPENAI_API_KEY" },
        { entryId: "e2", entryType: "bing", entryName: "B", code: C.ENTRY_CODES.NETWORK, reason: "合成网络失败" },
      ],
    },
  };
  C.assertWebError(err, {
    code: C.CHAIN_CODES.UPSTREAM_FAILURES,
    attempts: [
      { entryId: "e1", code: C.SKIPPED_NO_KEY },
      { entryId: "e2", code: C.ENTRY_CODES.NETWORK },
    ],
  });
  assert.throws(() => C.assertWebError(err, { code: C.CHAIN_CODES.UPSTREAM_FAILURES, attempts: [{ entryId: "e2", code: C.ENTRY_CODES.NETWORK }, { entryId: "e1", code: C.SKIPPED_NO_KEY }] }), /尝试顺序/);
  const bad = structuredClone(err);
  bad.details.attempts[0].code = "ENTRY_MADE_UP";
  assert.throws(() => C.assertWebError(bad, { code: C.CHAIN_CODES.UPSTREAM_FAILURES, attempts: [{ entryId: "e1", code: "ENTRY_MADE_UP" }, { entryId: "e2", code: C.ENTRY_CODES.NETWORK }] }), /ENTRY_CODES/);
});

test("工厂默认值：makeEntry/makeSavedConfig 覆盖 CFG-004 字段", () => {
  const e = C.makeEntry({ id: "e-fix", type: "bing" });
  assert.deepEqual(Object.keys(e).sort(), ["enabled", "id", "name", "type"]);
  assert.equal(e.enabled, true);
  const cfg = C.makeSavedConfig([e], { timeoutMs: 999 });
  assert.deepEqual(cfg.entries, [e]);
  assert.equal(cfg.useOfficialDeepSeekSearch, true); // SET-005 默认开启
  assert.equal(cfg.timeoutMs, 999);
});

test("fixture 组织：FIXTURE_NAMES 全部存在且可加载（fixtures/README 规则 6）", () => {
  const all = listFixtures();
  for (const [key, rel] of Object.entries(FIXTURE_NAMES)) {
    assert.ok(all.includes(rel), `FIXTURE_NAMES.${key} -> ${rel} 必须存在`);
    const loaded = loadFixture(rel);
    assert.ok(loaded !== undefined && loaded !== null);
  }
  assert.throws(() => fixturePath("../outside.json"), /越界/);
});
