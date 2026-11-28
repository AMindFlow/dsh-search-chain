// 工作包 #86 · 多 key 池轮替 Oracle 骨架（POOL-002 存量单引用 = 1 元池，零感知迁移）。
// v0.2.0 形态 fixture：磁盘逐字节一致构造法 = tmp state（settings.user）+ describe 回包
// （installSettingsFetch 按 state.user 快照应答）+ 保存回放（面板 ops 经权威 reducer 落回
// state.user）→ 全程对 state.user 做 JSON.stringify 前后对比（键序即盘上字节序代理真值）。
// 观测面：mutates()/credentialSets() 计数、unset 路径、401/429/网络注入的基准文案
// （无「全部 N 把」字样）、出站次数。实现前跑红属预期。
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../src/config.js";
import { createSearchChain } from "../src/search.js";
import { createChainHarness } from "./helpers/chain-harness.js";
import { stepSuccess } from "./helpers/fake-backend.js";
import { ENTRY_CODES } from "./helpers/contract.js";
import { makeIssuingBackend, scriptAttempts } from "./helpers/pool-oracle-kit.js";
import {
  ROLE,
  act,
  byRole,
  clone,
  fire,
  loadSection,
  makeSettingsState,
  one,
  opsOf,
  settle,
  withEnv,
} from "./helpers/settings-panel-v02.js";

/** v0.2.0 生成形态的磁盘样本：单 key（credentialRef）+ 免 key + 无凭据条目混合。 */
function v020User() {
  return {
    entries: [
      { id: "tavily-a", type: "tavily", name: "Tavily 主", enabled: true, credentialRef: "TAVILY_KEY_A" },
      { id: "exa-b", type: "exa", name: "Exa 备用", enabled: true },
      { id: "bing-c", type: "bing", name: "Bing 公开", enabled: true },
    ],
    useOfficialDeepSeekSearch: true,
    timeoutMs: 25000,
  };
}

const bytes = (v) => JSON.stringify(v);

test("POOL-002①a 读闸零改写：v0.2.0 fixture 过 normalizeConfig 不补 credentialRefs、不动旧键", () => {
  const out = normalizeConfig(clone(v020User()));
  const a = out.entries[0];
  assert.equal("credentialRefs" in a, false, "升级后读闸不得主动补 credentialRefs 键（磁盘迁移禁止）");
  assert.equal(a.credentialRef, "TAVILY_KEY_A", "旧 credentialRef 原样保留");
  assert.equal(JSON.stringify(out).includes("credentialRefs"), false, "归一化面不出现池键字样");
});

test("POOL-002①b 搜索零感知：启动+一次搜索后磁盘逐字节一致（零写入 + 键序不变）", async () => {
  const saved = {
    entries: [
      { id: "s", type: "openai", name: "单引用", enabled: true, credentialRef: "SOLO_REF" },
      { id: "b", type: "bing", name: "Bing", enabled: true },
    ],
    useOfficialDeepSeekSearch: true,
    timeoutMs: 25000,
  };
  const before = bytes(saved);
  const h = createChainHarness(createSearchChain, {
    entries: saved.entries,
    timeoutMs: saved.timeoutMs,
    useOfficialDeepSeekSearch: true,
    steps: { s: [stepSuccess({ sources: [{ url: "https://synthetic-host.invalid/a", title: "合成" }] })], b: [stepSuccess({ sources: [] })] },
    credentialRefs: { SOLO_REF: "sk-synthetic-solo-KEY-DO-NOT-LOG" },
  });
  await h.runToValue(h.search());
  assert.equal(bytes(h.savedConfig()), before, "一次搜索后已保存配置必须逐字节不变（无磁盘迁移）");
  const a = h.savedConfig().entries[0];
  assert.deepEqual(Object.keys(a), ["id", "type", "name", "enabled", "credentialRef"], "键序不得改写");
});

test("POOL-002①c 面板打开零感知：open/渲染/卸载全程零 settings/mutate，磁盘 stringify 不变", async () => {
  const state = makeSettingsState();
  state.user = v020User();
  const before = bytes(state.user);
  await withEnv(state, async ({ fetchStub }) => {
    const view = await loadSection("pool-mig-open");
    await settle(view);
    assert.equal(fetchStub.mutates().length, 0, "仅打开面板不得写入");
  });
  assert.equal(bytes(state.user), before, "打开-渲染全程后磁盘逐字节一致");
});

test("POOL-002② 401/429/网络失败注入：attempts/reason/出站次数 = v0.2.0 基准，无「全部 N 把」池字样", async () => {
  const cases = [
    { kind: 401, code: ENTRY_CODES.CREDENTIALS, reason: /key 是否有效/ },
    { kind: 429, code: ENTRY_CODES.RATE_LIMITED, reason: /限流/ },
    { kind: "network", code: ENTRY_CODES.NETWORK, reason: /直连网络失败/ },
  ];
  for (const { kind, code, reason } of cases) {
    const h = createChainHarness(createSearchChain, {
      entries: [{ id: "s", type: "openai", name: "单引用", enabled: true, credentialRef: "SOLO_REF" }],
      credentialRefs: { SOLO_REF: "sk-synthetic-solo-KEY-DO-NOT-LOG" },
    });
    h.deps.backends.set("openai", makeIssuingBackend("openai"));
    scriptAttempts(h.fetchFn, { 1: kind });
    const err = await h.runToError(h.search());
    const attempt = err.details.attempts.find((x) => x.entryId === "s");
    assert.equal(attempt.code, code, `${kind}：分类码与 v0.2.0 基准一致`);
    assert.match(attempt.reason, reason, `${kind}：reason 基准文案`);
    assert.doesNotMatch(attempt.reason, /全部\s*\d+\s*把/, `${kind}：不得出现池耗尽字样`);
    assert.equal(h.fetchFn.calls.length, 1, `${kind}：单 key 出站恰一次`);
  }
});

test("POOL-002③ 惰性迁移：编辑存量单引用条目改名保存 → credentialRefs 落盘 + 字段级 unset 旧键，其余条目逐字节不变", async () => {
  const state = makeSettingsState();
  state.user = v020User();
  const beforeOthers = state.user.entries.slice(1).map(bytes);
  await withEnv(state, async ({ fetchStub }) => {
    const view = await loadSection("pool-mig-edit");
    let tree = await settle(view);
    // 打开 tavily-a 编辑器：改名并提交（不带新 key）
    tree = await act(view, () => fire(one(tree, ROLE.edit, { entryId: "tavily-a" }), "onClick"));
    const nameField = one(tree, ROLE.field, { field: "name" });
    tree = await act(view, () => fire(nameField, "onChange", { target: { value: "Tavily 主（改名）" } }));
    tree = await act(view, () => fire(one(tree, ROLE.editorSubmit), "onClick"));
    assert.equal(byRole(tree, ROLE.editor).length, 0, "提交成功编辑器关闭");
    assert.equal(fetchStub.credentialSets().length, 0, "未带新 key：零 credentials/set（引用原样迁移）");

    const ops = fetchStub.mutates().flatMap((c) => opsOf(c));
    const refSet = ops.find(
      (op) => op.op === "set" && JSON.stringify(op.path ?? []).includes("credentialRefs") ||
        (op.op === "set" && op.value && Array.isArray(op.value.credentialRefs)),
    );
    assert.ok(refSet, "该条目凭据必须以 credentialRefs 数组形态落盘（惰性迁移）");
    const carried = refSet.op === "set" && Array.isArray(refSet.value?.credentialRefs) ? refSet.value.credentialRefs : ops.find((o) => o.op === "set" && String(o.path?.at(-1)) === "credentialRefs")?.value;
    assert.deepEqual(carried, ["TAVILY_KEY_A"], "迁移值 = 原引用 1 元池");
    const unsetOld = ops.find((op) => op.op === "unset" && String(op.path?.at(-1)) === "credentialRef");
    assert.ok(unsetOld, "同一提交必须附带字段级 unset 移除旧 credentialRef");

    const a = state.user.entries[0];
    assert.deepEqual(a.credentialRefs, ["TAVILY_KEY_A"]);
    assert.equal("credentialRef" in a, false, "旧键必须从磁盘移除（不共存）");
    assert.equal(a.name, "Tavily 主（改名）");
    assert.deepEqual(state.user.entries.slice(1).map(bytes), beforeOthers, "未编辑条目磁盘内容逐字节不变");
  });
});
