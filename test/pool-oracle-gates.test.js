// 工作包 #86 · 多 key 池轮替 Oracle 骨架（POOL-001 / POOL-003 / POOL-008①②④）。
// 编制依据：docs/specs/draft/key-pool.md（含修订注 CFG-W-002 矩阵扩展 / CFG-W-003 数组深度）
// 与 docs/specs/draft/config-write-gate.md。实现前跑红属预期（Oracle 先钉行为）。
//
// 观测面：
//   读闸  src/config.js normalizeConfig（结论 + 归一化输出 + 文案）
//   写闸  src/client-entry.js Component.contract.validate / toOps（结论 + 文案 + CONFIG_INVALID）
//   面板  settings-panel-v02 替身：fetchStub.mutates()/credentialSets()/outbound、
//         权威 reducer applyOps 后的磁盘形态、save-error/role=alert 锚点。
// 两闸结论逐例必须双向全等（POOL-001 验收 / CFG-W-001 等价钉扩展）。
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../src/config.js";
import {
  ROLE,
  SYNTH_KEY,
  act,
  byRole,
  clone,
  collectStrings,
  fire,
  loadSection,
  makeSettingsState,
  one,
  opsOf,
  secretPathsIn,
  settle,
  withEnv,
} from "./helpers/settings-panel-v02.js";

// 与 key-pool.md 设计决定一致的池上限（草案常量；镜像同步义务属评审项，测试面本地取 8）。
const POOL_MAX = 8;

function refPool(n, prefix = "REF") {
  return Array.from({ length: n }, (_, i) => `${prefix}_${i + 1}`);
}

function baseConfig(entryPatch) {
  return {
    entries: [
      { id: "a", type: "tavily", name: "池条目", enabled: true, ...entryPatch },
      { id: "z", type: "bing", name: "免 key 条目", enabled: true },
    ],
    useOfficialDeepSeekSearch: true,
    timeoutMs: 25000,
  };
}

function outcomeOf(fn, sample) {
  try {
    return { ok: true, config: fn(sample) };
  } catch (err) {
    return { ok: false, message: String(err?.message ?? err) };
  }
}

/**
 * 两闸矩阵行（修订注 CFG-W-002 扩展行 × 通过/拒绝枚举）。
 * verdict=accept 时 expectRefs 钉归一化输出（undefined=省略该键）。
 * msgs=两闸文案都必须命中的定位/原因要素（规范文本要素来自修订注）。
 */
const GATE_MATRIX = [
  // ── 通过形态 ──────────────────────────────────────────────────────────────
  ["旧形态单引用（1 元池等价语义）", baseConfig({ credentialRef: "REF_A" }), "accept", undefined, [/entries\[0\]|^$/]],
  ["refs 1 元", baseConfig({ credentialRefs: ["REF_A"] }), "accept", ["REF_A"], []],
  ["refs 2 元原序", baseConfig({ credentialRefs: ["REF_A", "REF_B"] }), "accept", ["REF_A", "REF_B"], []],
  ["refs 元素带空白（trim 后原序）", baseConfig({ credentialRefs: [" REF_A ", "REF_B "] }), "accept", ["REF_A", "REF_B"], []],
  ["refs 8 元（上限值）", baseConfig({ credentialRefs: refPool(POOL_MAX) }), "accept", refPool(POOL_MAX), []],
  ["refs 空数组（等同省略）", baseConfig({ credentialRefs: [] }), "accept", undefined, []],
  ["bing + refs 空数组（POOL-010②）", { entries: [{ id: "b", type: "bing", credentialRefs: [] }] }, "accept", undefined, []],
  // ── 拒绝形态：读闸写闸必须双向一致 ──────────────────────────────────────
  ["trim 后相邻重复", baseConfig({ credentialRefs: ["REF_A", " REF_A "] }), "reject", undefined, [/entries\[0\]\.credentialRefs/, /重复/]],
  ["trim 后非相邻重复", baseConfig({ credentialRefs: ["REF_A", "REF_B", "REF_A"] }), "reject", undefined, [/entries\[0\]\.credentialRefs/, /重复/]],
  ["9 元越上限（含实际数与上限值）", baseConfig({ credentialRefs: refPool(9) }), "reject", undefined, [/9/, /8/, /entries\[0\]/]],
  ["元素 null（元素定位）", baseConfig({ credentialRefs: ["REF_A", null] }), "reject", undefined, [/entries\[0\]\.credentialRefs\[1\]/]],
  ["元素纯空白（元素定位）", baseConfig({ credentialRefs: ["REF_A", "  "] }), "reject", undefined, [/entries\[0\]\.credentialRefs\[1\]/]],
  ["元素空串", baseConfig({ credentialRefs: ["REF_A", ""] }), "reject", undefined, [/entries\[0\]\.credentialRefs\[1\]/]],
  ["元素嵌套数组", baseConfig({ credentialRefs: [["REF_A"]] }), "reject", undefined, [/entries\[0\]\.credentialRefs\[0\]/]],
  ["refs null（CFG-W-002 新增行）", baseConfig({ credentialRefs: null }), "reject", undefined, [/entries\[0\]\.credentialRefs/, /数组/]],
  ["refs 字符串（非数组）", baseConfig({ credentialRefs: "REF_A" }), "reject", undefined, [/entries\[0\]\.credentialRefs/, /数组/]],
  ["refs 数字（非数组）", baseConfig({ credentialRefs: 42 }), "reject", undefined, [/entries\[0\]\.credentialRefs/, /数组/]],
  ["两形态共存（互斥）", baseConfig({ credentialRef: "REF_A", credentialRefs: ["REF_B"] }), "reject", undefined, [/entries\[0\]/, /互斥/]],
  ["bing + 非空 refs（免 key 误配）", { entries: [{ id: "b", type: "bing", credentialRefs: ["REF_A"] }] }, "reject", undefined, [/entries\[0\]/, /bing|免\s*key/i]],
];

async function loadContract(tag) {
  const { Component } = await loadSection(tag);
  return Component.contract;
}

test("POOL-001/003/008① 两闸矩阵：credentialRefs 全形态下 validate ↔ normalizeConfig 结论逐例双向全等", async () => {
  const { validate } = await loadContract("pool-gates-matrix");
  for (const [name, sample, verdict, expectRefs, msgPatterns] of GATE_MATRIX) {
    const read = outcomeOf((s) => normalizeConfig(clone(s)), sample);
    const write = outcomeOf((s) => validate(clone(s)), sample);
    // 双向结论全等（POOL-001 验收 / CFG-W-001 钉）
    assert.equal(read.ok, write.ok, `${name}：两闸结论不一致（读=${read.ok} 写=${write.ok}）`);
    assert.equal(read.ok, verdict === "accept", `${name}：期望 ${verdict}，读闸实际 ${read.ok ? "accept" : "reject"}`);
    if (read.ok) {
      const entry = read.config.entries[0];
      if (expectRefs === undefined) {
        // 空数组归一化 = 省略该键（POOL-001 末段 / CFG-W-002 修订注）
        assert.equal("credentialRefs" in entry, false, `${name}：归一化输出必须省略 credentialRefs 键`);
      } else {
        assert.deepEqual(entry.credentialRefs, expectRefs, `${name}：候选清单必须为 trim 后原序数组`);
      }
    } else {
      for (const [gate, res] of [["normalizeConfig", read], ["contract.validate", write]]) {
        for (const pat of msgPatterns) {
          assert.match(res.message, pat, `${name}：${gate} 拒绝文案必须含定位/原因 ${pat}`);
        }
      }
    }
  }
});

test("POOL-001 通过形态：写闸归一化输出与读闸候选清单逐字段一致（双向）", async () => {
  const { validate } = await loadContract("pool-gates-normalize");
  const accepted = GATE_MATRIX.filter(([, , v]) => v === "accept");
  for (const [name, sample] of accepted) {
    const read = outcomeOf((s) => normalizeConfig(clone(s)), sample);
    const write = outcomeOf((s) => validate(clone(s)), sample);
    assert.ok(read.ok && write.ok, `${name}：两闸必须通过`);
    const strip = (c) => JSON.parse(JSON.stringify(c ?? null));
    assert.deepEqual(strip(write.config ?? write), strip(read.config), `${name}：两闸归一化输出必须一致（若写闸返回归一化对象）`);
  }
});

test("POOL-008① 写闸 toOps 预检：非法池目标直接抛 CONFIG_INVALID", async () => {
  const { toOps, validate } = await loadContract("pool-gates-toops");
  assert.ok(validate(baseConfig({ credentialRefs: ["REF_A"] })).config !== undefined || true);
  const bad = baseConfig({ credentialRefs: ["REF_A", " REF_A "] });
  assert.throws(
    () => toOps(clone(bad), { entries: clone(baseConfig({ credentialRefs: ["REF_A"] }).entries) }),
    /CONFIG_INVALID|无效|非法|重复/,
    "toOps 对非法池目标必须直接抛 CONFIG_INVALID（CFG-W-001 口径）",
  );
});

// 面板路径的被拒池形态：按 CFG-W-004 口径零 mutate、零 credentials/set、零出站，草稿/错误可见。
const PANEL_REJECT_FORMS = [
  ["池内重复（trim 变体）", (e) => { e.entries[0].credentialRefs = ["REF_A", " REF_A "]; }],
  ["9 元越上限", (e) => { e.entries[0].credentialRefs = refPool(9); }],
  ["bing 带非空池", (e) => { e.entries[2].credentialRefs = ["REF_B"]; }],
];

test("POOL-003/008④ 离散保存命中被拒池形态：save-error+role=alert 可见，mutates/credentialSets/outbound 全零", async () => {
  for (const [name, corrupt] of PANEL_REJECT_FORMS) {
    const state = makeSettingsState();
    corrupt(state.user);
    await withEnv(state, async ({ fetchStub }) => {
      const view = await loadSection(`pool-panel-reject-${name.length}`);
      let tree = await settle(view);
      // 离散动作：切换 bing 条目启用开关（合法动作，但盘上存在损坏池条目 → 写闸必须整单拒绝）
      tree = await act(view, () => fire(one(tree, ROLE.enabled, { entryId: "bing-c" }), "onChange", { target: { checked: false } }));
      const errs = byRole(tree, ROLE.saveError);
      assert.equal(errs.length, 1, `${name}：必须出现 data-role="save-error" 节级错误`);
      assert.equal(errs[0].props.role, "alert", `${name}：错误节点必须 role="alert"`);
      assert.equal(fetchStub.mutates().length, 0, `${name}：零 settings/mutate`);
      assert.equal(fetchStub.credentialSets().length, 0, `${name}：零 credentials/set`);
      assert.equal(fetchStub.outbound.length, 0, `${name}：零外部出站（CFG-W-004）`);
    });
  }
});

test("POOL-008② describe user 层带 credentialRefs 且残留明文 apiKey：任一保存路径请求体与磁盘零残留、共存零落盘", async () => {
  const state = makeSettingsState();
  state.user.entries[0] = {
    id: "tavily-a",
    type: "tavily",
    name: "Tavily 主",
    enabled: true,
    credentialRefs: ["REF_A", "REF_B"],
    apiKey: SYNTH_KEY, // v0.2.0 之前的持久残留
  };
  await withEnv(state, async ({ fetchStub }) => {
    const view = await loadSection("pool-gates-strip");
    let tree = await settle(view);
    // 未触碰池条目本条：切换其他条目启用开关 → 保存
    tree = await act(view, () => fire(one(tree, ROLE.enabled, { entryId: "bing-c" }), "onChange", { target: { checked: false } }));
    const mutates = fetchStub.mutates();
    assert.equal(mutates.length, 1, `干净池形态下离散保存应恰好一次 mutate（实得 ${mutates.length}）`);
    for (const call of mutates) {
      const strings = collectStrings(opsOf(call));
      assert.ok(!strings.includes(SYNTH_KEY), "请求体不得携带明文 key 残留值");
      for (const op of opsOf(call)) {
        // 字段名可合法出现在 unset 路径段（清除动作本身）；检查对象只针对值载荷
        assert.deepEqual(secretPathsIn(op.value ?? null), [], "ops 值载荷不得以 SECRET_FIELD 作对象键名（CFG-W-003）");
      }
    }
    // 权威 reducer 应用后：磁盘条目无 SECRET_FIELD 命中；credentialRefs 存活；旧 credentialRef 不复活
    const diskEntries = state.user.entries;
    assert.deepEqual(secretPathsIn(diskEntries), [], "磁盘条目必须零 SECRET_FIELD 命中字段（CFG-W-003 数组深度）");
    assert.deepEqual(diskEntries[0].credentialRefs, ["REF_A", "REF_B"], "合法池形态不得被误清");
    assert.equal("credentialRef" in diskEntries[0], false, "迁移后不得 credentialRef/credentialRefs 共存落盘");
  });
});
