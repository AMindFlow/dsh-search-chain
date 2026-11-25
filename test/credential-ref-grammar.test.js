// Issue #48 · R-1 链级读取面 oracle（credentialRef 超 POSIX grammar 的目标行为）。
//
// 依据（dsh-credentials @0.2.2-rc.5 src/index.ts，lead 源码实证）：
//   L19 REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/；L29-34 credentialRef() 对不合语法的串抛 TypeError；
//   L45-47 注释原文：a name outside the grammar "has no reference to miss and should read as 'not set'
//   rather than as a thrown error"（引用侧未命中，不抛错）。
// 目标：src/search.js resolveKey 与 src/config.js resolveEntryApiKey 对超语法引用视为「该层未命中」，
//   继续落到环境变量 / 托管层 / 旧版 YAML；全部缺失则按 SKIPPED_NO_KEY（与无 ref 同路径）。
//   现状（待 dev 修）：超语法 ref 经 credentials.resolve 抛错 → CREDENTIALS 硬失败（search.js:229-234）。
//
// 测试台：chain-harness（受控时钟）+ fake-credentials 的 strictRefGrammar 开关（与真宿主同形抛 TypeError）。
// 实现未就绪时本文件全红，绝不 skip。

import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { chainHarness, keyedEntry } from "./helpers/search-oracle.js";
import { stepSuccess } from "./helpers/fake-backend.js";
import { SYNTHETIC_KEY } from "./helpers/fake-fetch.js";

const CLAUSES = "R-1/CFG-002";

/** 旧冒号形态：超出 POSIX grammar，宿主 set/resolve 均不接受（R-1）。 */
const LEGACY_COLON_REF = "search-chain-credential:e-t:1";

test("R-1 链级 3a：条目引用为超语法串（旧冒号形态）→ 该层视为未命中，落到环境变量 TAVILY_API_KEY 取 key，出站正常，不记 CREDENTIALS", async (t) => {
  const ENV_KEY = SYNTHETIC_KEY("env-tavily");
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-t", "tavily", "条目甲", { credentialRef: LEGACY_COLON_REF })],
    credentialRefs: {},
    env: { TAVILY_API_KEY: ENV_KEY },
    strictRefGrammar: true,
    steps: { "e-t": [stepSuccess({ sources: C.makeSources(1, "https://synthetic-t.invalid/doc") })] },
  });
  const value = await h.runToValue(h.search());
  assert.equal(h.ctxFor("e-t")?.key, ENV_KEY, "超语法引用须视为未命中：key 应取自环境变量 TAVILY_API_KEY（R-1，CFG-002 优先级续行）");
  assert.equal(h.executionCount("e-t"), 1, "取到环境变量 key 后应正常出站恰一次");
  assert.ok(Array.isArray(value.sources) && value.sources.length >= 1, "搜索应成功返回来源");
  assert.ok(
    !(value.attempts ?? []).some((a) => a.code === C.ENTRY_CODES.CREDENTIALS),
    "超语法引用不得记 ENTRY_CREDENTIALS 硬失败码（现状 search.js:229-234 硬失败，待 dev 修）",
  );
});

test("R-1 链级 3b：超语法引用且后续层无 key → SKIPPED_NO_KEY（与无 ref 同路径）；错误与日志不含 key 明文", async (t) => {
  const LEAK = SYNTHETIC_KEY("must-never-surface");
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("e-t", "tavily", "条目甲", { credentialRef: LEGACY_COLON_REF })],
    // 即便宿主侧存有该串对应的 key，超语法 ref 也不得被读取（strictRefGrammar 下 resolve 抛错）。
    credentialRefs: { [LEGACY_COLON_REF]: LEAK },
    env: {},
    strictRefGrammar: true,
    steps: {},
  });
  const err = await h.runToError(h.search());
  C.assertWebError(err, {
    code: C.CHAIN_CODES.ALL_KEYS_MISSING,
    attempts: [{ entryId: "e-t", code: C.SKIPPED_NO_KEY }],
  });
  assert.equal(h.executionCount("e-t"), 0, "无 key 时不得出站");
  const surfaced = JSON.stringify({ message: err?.message, attempts: err?.attempts }) + h.logCapture.text();
  assert.ok(!surfaced.includes(LEAK), "错误、尝试记录与日志不得含 key 明文（CFG-003 脱敏惯例）");
});
