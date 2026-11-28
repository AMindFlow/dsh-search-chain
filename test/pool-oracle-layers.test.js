// 工作包 #86 · 多 key 池轮替 Oracle 骨架（POOL-007 凭据解析分层与不轮替层）。
// 池 = 唯一轮替候选集；下层来源（白名单 env → DSH 托管 → 旧版 YAML）只参与选取期降级：
// 池内全 absent 才取其一兜底单 key；失败后不回头重试池引用、不降层再试、不重读层。
// 观测面：fake-fetch 出站次数与鉴权头用的哪把 key、fake-credentials.resolveCalls 留痕。
import test from "node:test";
import assert from "node:assert/strict";
import { createSearchChain } from "../src/search.js";
import { createChainHarness } from "./helpers/chain-harness.js";
import { ENTRY_CODES } from "./helpers/contract.js";
import {
  credentialSeedFor,
  makeIssuingBackend,
  poolKey,
  refName,
  refPoolOf,
  scriptAttempts,
} from "./helpers/pool-oracle-kit.js";

const ENV_KEY = "sk-synthetic-env-KEY-DO-NOT-LOG";
const HOSTED_KEY = "sk-synthetic-hosted-KEY-DO-NOT-LOG";

const authOf = (call) => call.headers.authorization;
const countOf = (arr, x) => arr.filter((v) => v === x).length;

function poolHarness({ letters = "AB", seedLetters = letters, env = {}, refSeedExtra = {} }) {
  const h = createChainHarness(createSearchChain, {
    entries: [{ id: "p", type: "openai", name: "池条目", enabled: true, credentialRefs: refPoolOf(letters) }],
    credentialRefs: { ...credentialSeedFor(seedLetters), ...refSeedExtra },
    env,
  });
  const issuing = makeIssuingBackend("openai");
  h.deps.backends.set("openai", issuing);
  return { h, issuing };
}

test("POOL-007① 池全 absent → 下层兜底单 key；401 后不回头重试池引用、不降层再试", async () => {
  const { h } = poolHarness({ letters: "XY", seedLetters: "", env: { OPENAI_API_KEY: ENV_KEY } });
  scriptAttempts(h.fetchFn, { 1: 401, 2: "ok:1" });
  const err = await h.runToError(h.search());
  assert.equal(h.fetchFn.calls.length, 1, "兜底单 key 每搜索至多一次；池引用不得被回头重试");
  assert.equal(authOf(h.fetchFn.calls[0]), `Bearer ${ENV_KEY}`, "选取应命中 env 层兜底 key");
  const calls = h.credentials.resolveCalls;
  assert.equal(countOf(calls, refName("X")), 1, "池引用选取期各读一次，失败后不再重读");
  assert.equal(countOf(calls, refName("Y")), 1);
  assert.equal(h.fetchFn.calls.length, 1);
  assert.equal(err.details.attempts.find((a) => a.entryId === "p").code, ENTRY_CODES.CREDENTIALS);
});

test("POOL-007② 池命中后 env 另有 key：env 不得成为轮替/降级候选，出站 = 池候选数", async () => {
  const { h } = poolHarness({ letters: "AB", env: { OPENAI_API_KEY: ENV_KEY } });
  scriptAttempts(h.fetchFn, { 1: 401, 2: 401, 3: 401 });
  const err = await h.runToError(h.search());
  assert.equal(h.fetchFn.calls.length, 2, "出站次数 = 池候选数；下层 key 零出站");
  assert.deepEqual(h.fetchFn.calls.map(authOf), [`Bearer ${poolKey("A")}`, `Bearer ${poolKey("B")}`]);
  assert.ok(!h.credentials.resolveCalls.includes("OPENAI_API_KEY"), "池内命中即停，下层不得参与选取或轮替");
  assert.equal(h.credentials.totalReads(), 2, "池耗尽不得引发凭据层重新读取");
  assert.ok(err);
});

test("POOL-007②b 池全 absent 且 env 未命中 → 托管引用层命中（WP7 裁决：裸 env 名 resolve）；池耗尽不重新降级", async () => {
  const { h } = poolHarness({ letters: "XY", seedLetters: "", refSeedExtra: { OPENAI_API_KEY: HOSTED_KEY } });
  scriptAttempts(h.fetchFn, { 1: 401 });
  await h.runToError(h.search());
  assert.equal(h.fetchFn.calls.length, 1);
  assert.equal(authOf(h.fetchFn.calls[0]), `Bearer ${HOSTED_KEY}`, "托管引用层（裸 env 名 resolve）兜底命中");
  const calls = h.credentials.resolveCalls;
  assert.equal(countOf(calls, "OPENAI_API_KEY"), 1, "下层每搜索至多被尝试一次");
});

test("POOL-007③ 免 key 条目参与搜索：凭据 resolve 调用计数为零", async () => {
  const h = createChainHarness(createSearchChain, {
    entries: [{ id: "b", type: "bing", name: "Bing", enabled: true, credentialRefs: ["POOL_REF_X"] }],
    steps: { b: [{ kind: "success", sources: [{ url: "https://synthetic-host.invalid/b", title: "合成" }] }] },
  });
  await h.runToValue(h.search());
  assert.equal(h.credentials.resolveCalls.length, 0, "bing 保持零凭据读取（CFG-002/POOL-010）");
  assert.equal(h.fetchFn.calls.length, 0, "RSS 出站由适配器面钉（bing-*），链级只钉零凭据读取");
});

test("POOL-007④ 回归：旧单引用条目逐层命中与 v0.2.0 解析链一致（entry ref 缺失 → env 命中）", async () => {
  const h = createChainHarness(createSearchChain, {
    entries: [{ id: "s", type: "openai", name: "单引用", enabled: true, credentialRef: refName("MISSING") }],
    env: { OPENAI_API_KEY: ENV_KEY },
  });
  const issuing = makeIssuingBackend("openai");
  h.deps.backends.set("openai", issuing);
  scriptAttempts(h.fetchFn, { 1: "ok:1" });
  await h.runToValue(h.search());
  assert.equal(authOf(h.fetchFn.calls[0]), `Bearer ${ENV_KEY}`, "逐层降级解析行为与 v0.2.0 一致");
  assert.deepEqual(h.credentials.resolveCalls, [refName("MISSING")], "env 层命中即停（env 读取不经凭据服务），托管层零读取——v0.2.0 解析链原样");
});
