// WP7 P0 缺陷 oracle 修正轮 — 真宿主凭据形状直测。
// 权威来源：@deepseek-ai/dsh-credentials README/types.ts @0.2.2-rc.5（本机 node_modules 内该包）：
//   resolve(ref) → { value, source } | undefined（空 stored 值 = absent）；
//   readRecord(name) → CredentialRecord = { kind: "api-key", key?, env? } | { kind: "grant", payload }。
// 本文件只断言「真宿主形状下必须取到键；undefined 必须按 SKIPPED_NO_KEY 零出站」。
// src/search.js 与 src/config.js 按字符串消费 resolve、按 record.value 消费记录——真宿主形状下
// 本文件命中类断言必红（WP7 P0 dev 面），修正 src 前应保持红，不得弱化或改 skip。
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAIN_CODES,
  SKIPPED_NO_KEY,
  assertWebError,
  makeEntry,
  makeSources,
} from "./helpers/contract.js";
import { createFakeCredentials } from "./helpers/fake-credentials.js";
import { SYNTHETIC_KEY } from "./helpers/fake-fetch.js";
import { stepSuccess } from "./helpers/fake-backend.js";
import { DEFAULT_QUERY } from "./helpers/chain-harness.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { chainHarness, keyedEntry, refOf } from "./helpers/search-oracle.js";

const WP = "WP1 src/config.js";

async function loadConfig(t) {
  const res = await tryImportSrc("config.js");
  if (failIfUnimplemented(t, res, WP, "CFG-002")) return null;
  return res.module;
}

// 真宿主形状（dsh-credentials README/types.ts @0.2.2-rc.5，WP7 实机发现）：
// resolve 命中是 { value, source }，键在 hit.value——不是裸字符串。
test("WP7 oracle：resolve 返回 {value, source} 真形时解析器取到键（CFG-002 第一层）", async (t) => {
  const mod = await loadConfig(t);
  if (!mod) return;
  const K = SYNTHETIC_KEY("real-hit");
  // seed 直供真形 hit（不走替身字符串糖），排除替身自证。
  const creds = createFakeCredentials({ refs: { "ref:e1": { value: K, source: "env" } } });
  assert.deepEqual(
    await mod.resolveEntryApiKey(
      makeEntry({ id: "e1", type: "openai", name: "条目甲", credentialRef: "ref:e1" }),
      { env: {}, credentials: creds, legacyYaml: {} },
    ),
    { key: K },
    "真宿主形状（dsh-credentials README，WP7 实机发现）：键取 resolve 命中的 hit.value",
  );
});

// 真宿主形状（dsh-credentials README/types.ts @0.2.2-rc.5，WP7 实机发现）：
// api-key 记录是 { kind: "api-key", key }——值只在记录顶层 key；不存在 record.value，api-key 也无 payload。
test("WP7 oracle：api-key 记录值只在 record.key 时解析器取到键（CFG-002 第三层）", async (t) => {
  const mod = await loadConfig(t);
  if (!mod) return;
  const K_REC = SYNTHETIC_KEY("real-record");
  // seed 直供 CredentialRecord 真形：除 kind/key 外不携带 value/payload 任何别名字段。
  const creds = createFakeCredentials({ records: { TAVILY_API_KEY: { kind: "api-key", key: K_REC } } });
  assert.deepEqual(
    await mod.resolveEntryApiKey(
      makeEntry({ id: "e2", type: "tavily", name: "条目乙" }),
      { env: {}, credentials: creds, legacyYaml: undefined },
    ),
    { key: K_REC },
    "真宿主形状（dsh-credentials README，WP7 实机发现）：键取 readRecord 记录的 record.key",
  );
});

// 链级正向：search.js resolveKey 必须从 hit.value 取键并下发给适配器 ctx.key。
test("WP7 oracle：resolve 真形命中时链取到键，适配器 ctx.key 即 hit.value（FB-001/CFG-002）", async (t) => {
  const K = SYNTHETIC_KEY("chain-hit");
  const h = await chainHarness(t, "WP7 oracle", {
    entries: [keyedEntry("e-a", "openai", "条目甲")],
    credentialRefs: { [refOf("e-a")]: { value: K, source: "user-env" } },
    steps: { "e-a": [stepSuccess({ sources: makeSources(2, "https://synthetic-a.invalid/doc") })] },
  });
  await h.runToValue(h.search({ query: DEFAULT_QUERY }));
  assert.equal(h.executionCount("e-a"), 1, "凭据命中即应执行，不得按缺 key 跳过");
  assert.equal(h.ctxFor("e-a").key, K, "真宿主形状（dsh-credentials README，WP7 实机发现）：链下发 ctx.key = resolve 命中的 value");
});

// 链级负向：resolve 返回 undefined（ref 缺失，真宿主可注入面）→ SKIPPED_NO_KEY，零出站。
test("WP7 oracle：resolve 返回 undefined 时条目按 SKIPPED_NO_KEY 跳过且零出站（FB-001/FB-004）", async (t) => {
  const h = await chainHarness(t, "WP7 oracle", {
    entries: [keyedEntry("e-a", "openai", "条目甲")],
    credentialRefs: {}, // ref 未配置 → resolve → undefined（真宿主形状的可注入 undefined 面）
    steps: { "e-a": [stepSuccess({ sources: makeSources(1) })] },
  });
  const err = await h.runToError(h.search({ query: DEFAULT_QUERY }));
  assertWebError(err, {
    code: CHAIN_CODES.ALL_KEYS_MISSING,
    attempts: [{ entryId: "e-a", code: SKIPPED_NO_KEY }],
  });
  assert.equal(h.executionCount("e-a"), 0, "undefined 凭据必须零出站，不发无鉴权请求");
  assert.equal(h.credentials.resolveCalls.length, 1, "跳过前对条目引用恰 resolve 一次（undefined = 该层缺失）");
});
