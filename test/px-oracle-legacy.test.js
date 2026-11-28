// PX-009 存量迁移零感知与 v0.2.0 行为逐位一致（前提实证结论见 oracle 文档「PX-009 前提」节：成立）。
// Oracle 骨架（工作包 #88）：实现前跑红属预期（默认键未输出）。
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, writeConfig } from "../src/config.js";
import { stepSuccess, stepFail } from "./helpers/fake-backend.js";
import { ENTRY_CODES } from "./helpers/contract.js";
import { chainHarness, keyedEntry, refsFor } from "./helpers/search-oracle.js";
import { createHostShapeFakeHost } from "./helpers/fake-host.js";

const CLAUSES = "PX-009";

/** v0.2.0 真实形态存量快照（三网络态 + 超时 + 官方开关，无三新键）。 */
function legacyRaw() {
  return {
    entries: [
      { id: "d1", type: "tavily", name: "直连", enabled: true, credentialRef: "TAV" },
      { id: "p1", type: "exa", name: "固定代理", enabled: true, credentialRef: "EXA", proxy: "http://own-proxy.invalid:3128" },
      { id: "pac1", type: "bing", name: "PAC", enabled: true, proxy: { pac: "http://syn-pac.invalid:8765/acceleration.pac?v=3" } },
    ],
    useOfficialDeepSeekSearch: true,
    timeoutMs: 25000,
    foreign_plugin_key: { keep: "me" },
  };
}

test(`${CLAUSES} 验收1：存量 fixture 读闸归一化 ≡「开关 OFF、全局代理未配置、全部条目继承」`, () => {
  const out = normalizeConfig(legacyRaw());
  assert.equal(out.proxyEscalation, false, "PX-009：存量归一化必须输出 proxyEscalation=false");
  assert.ok(!("globalProxy" in out), "PX-009：globalProxy 省略");
  for (const e of out.entries) assert.equal(e.proxyPin, "inherit", `PX-009：条目 ${e.id} 继承态`);
  // 既有字段零感知
  assert.deepEqual(
    out.entries.map((e) => ({ id: e.id, proxy: e.proxy })),
    [
      { id: "d1", proxy: undefined },
      { id: "p1", proxy: "http://own-proxy.invalid:3128" },
      { id: "pac1", proxy: { pac: "http://syn-pac.invalid:8765/acceleration.pac?v=3" } },
    ],
    "既有键值零变化",
  );
});

test(`${CLAUSES} 验收1（行为面）：存量配置整链无升级出站、无新状态行（FB-002 首行=接管标注面）`, async (t) => {
  const h = await chainHarness(t, CLAUSES, {
    entries: [keyedEntry("d1", "tavily", "直连"), keyedEntry("d2", "bing", "兜底")],
    credentialRefs: refsFor("d1", "d2"),
    extraConfig: {},
    useOfficialDeepSeekSearch: false,
    steps: { d1: [stepFail({ code: ENTRY_CODES.NETWORK })], d2: [stepSuccess({ sources: [{ url: "https://synthetic-host.invalid/x", title: "t", snippet: "s" }] })] },
  });
  const res = await h.runToValue(h.search());
  assert.equal(h.executionCount("d1"), 1, "存量形态：条目失败仅一次，无升级重试");
  const viaGlobal = h.transport.handles.filter((x) => x.opts?.viaGlobal === true);
  assert.equal(viaGlobal.length, 0, "存量形态零升级出站");
  assert.ok(!/升级|全局代理/.test(String(res.content ?? "")), "无升级状态行（零感知）");
});

test(`${CLAUSES} 验收2：存量快照「读出→保存」round-trip，diff 仅允许新增显式默认键，既有键值零变化`, async () => {
  const host = createHostShapeFakeHost({
    inject: ["configEditor"],
    config: { ...legacyRaw() },
  });
  const before = structuredClone(host.settingsPort.current());
  const snapshot = normalizeConfig(structuredClone(before));
  await writeConfig(host.settingsPort, snapshot);
  const after = host.settingsPort.current();
  // 违规检测：既有键（含他插件键）值变化 = 违规；新增只允许三新键的默认值
  for (const k of Object.keys(before)) {
    if (k === "entries") continue;
    assert.deepEqual(after[k], before[k], `round-trip 不得改动既有顶层键 ${k}（PX-009 验收2）`);
  }
  const beforeIds = before.entries.map((e) => e.id).join(",");
  assert.equal(after.entries.map((e) => e.id).join(","), beforeIds, "条目顺序不变");
  for (const b of before.entries) {
    const a = after.entries.find((e) => e.id === b.id);
    for (const [k, v] of Object.entries(b)) {
      assert.deepEqual(a[k], v, `entries[${b.id}].${k} 值零变化`);
    }
  }
  const allowedAdded = new Set(["proxyEscalation", "globalProxy", "proxyPin"]);
  for (const k of Object.keys(after)) {
    if (k in before || allowedAdded.has(k)) continue;
    assert.fail(`round-trip 不得新增非默认键 ${k}（PX-009 验收2）`);
  }
});

test(`${CLAUSES} 验收3（近似面）：v0.3.0 保存的三新键 override 经降级面读回无 CONFIG_INVALID；他插件键保留（前提实证已证 v0.2.0 忽略未知键）`, async () => {
  const upgradedOverride = {
    entries: [{ id: "d1", type: "tavily", name: "直连", enabled: true, proxyPin: "proxyOnly" }],
    useOfficialDeepSeekSearch: true,
    timeoutMs: 25000,
    proxyEscalation: true,
    globalProxy: "search_chain_global_proxy",
    foreign_plugin_key: { keep: "me" },
  };
  // 降级近似面（当前读闸 = 升级后读闸）：加载不报错、非本包键保留。
  // v0.2.0 真实读闸行为以 oracle 文档「PX-009 前提」一次性实证为准（/tmp/px009-probe-88 实跑记录）。
  let out;
  assert.doesNotThrow(() => {
    out = normalizeConfig(structuredClone(upgradedOverride));
  }, "含三新键的 override 必须可读（无 CONFIG_INVALID）");
  const host = createHostShapeFakeHost({ inject: ["configEditor"], config: structuredClone(upgradedOverride) });
  await writeConfig(host.settingsPort, out);
  const after = host.settingsPort.current();
  assert.deepEqual(after.foreign_plugin_key, { keep: "me" }, "他插件顶层键原样保留（PX-009 验收3）");
  assert.equal(after.proxyEscalation, true, "本包新键经 writeConfig 保留（OWN_CONFIG_KEYS 扩展，设计决定 PX-009）");
  assert.equal(after.globalProxy, "search_chain_global_proxy", "globalProxy 入自有键集整体替换面");
});
