// Issue #45：配置写闸对齐读闸（CFG-W-001..004）验收测试。
// 覆盖：
//   1. 两闸等价钉：Component.contract.validate / toOps ↔ src/config.js normalizeConfig 双向全等 + null 形态矩阵。
//   2. 写路径明文 key 清零：describe user 层含 apiKey 等 SECRET_FIELD 残留时，任一面板保存后磁盘条目零残留。
//   3. 写闸拦截、错误语义与零出站：重复 id、null 形态、坏条目下全写路径拒绝（含先于 credentials/set 预检）。
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../src/config.js";
import {
  ROLE,
  SECRET_FIELD,
  SYNTH_KEY,
  act,
  byRole,
  cardOrder,
  clone,
  fire,
  fixtureEntries,
  leaksIn,
  loadSection,
  makeSettingsState,
  one,
  opsOf,
  secretPathsIn,
  settle,
  textOf,
  withEnv,
} from "./helpers/settings-panel-v02.js";

async function openPanel(tag) {
  const view = await loadSection(tag);
  return { view, tree: await settle(view) };
}

async function step(view, tree, role, filter = {}, prop = "onClick", event = {}) {
  return act(view, () => fire(one(tree, role, filter), prop, event));
}

function outcomeOfNormalize(sample) {
  try {
    return { ok: true, config: normalizeConfig(clone(sample)) };
  } catch (err) {
    return { ok: false, code: err?.code, message: String(err?.message || err) };
  }
}

function allEntrySecretKeys(entries) {
  const hits = [];
  if (!Array.isArray(entries)) return hits;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e !== "object") continue;
    for (const k of Object.keys(e)) {
      if (SECRET_FIELD.test(k)) hits.push(`entries[${i}].${k}`);
    }
  }
  return hits;
}

// ────────────────────────────────────────────────────────────────────────────────────────
// 第 1 组 · CFG-W-001 / CFG-W-002：两闸等价钉（contract.validate / toOps ↔ normalizeConfig）
// ────────────────────────────────────────────────────────────────────────────────────────

test("CFG-W-001 / CFG-W-002 两闸等价钉：恶意/边角样本与 null 形态矩阵下 validate ↔ normalizeConfig 双向全等", async () => {
  const { Component } = await loadSection("wg-equiv");
  const { validate, toOps } = Component.contract;

  const matrix = [
    // 顶层 null / 缺省 / 非法形态
    ["顶层 null", null],
    ["顶层 undefined", undefined],
    ["顶层空对象", {}],
    ["顶层字符串", "bad"],
    ["顶层数字", 42],
    ["顶层数组", []],
    ["entries 为 null", { entries: null }],
    ["entries 为字符串", { entries: "abc" }],
    ["entries 含 null 元素", { entries: [null] }],
    ["entries 含数字元素", { entries: [123] }],
    ["entries 含数组元素", { entries: [[]] }],

    // id 形态与重复 id
    ["entry.id 为 null", { entries: [{ id: null, type: "bing" }] }],
    ["entry.id 为空串", { entries: [{ id: "", type: "bing" }] }],
    ["entry.id 为空白", { entries: [{ id: "   ", type: "bing" }] }],
    ["entry.id 为数字", { entries: [{ id: 1, type: "bing" }] }],
    ["entry.id 首尾空白（合法且 trim）", { entries: [{ id: "  a  ", type: "bing" }] }],
    ["重复 id（精确一致）", { entries: [{ id: "dup", type: "bing" }, { id: "dup", type: "tavily" }] }],
    ["重复 id（去空白后碰撞）", { entries: [{ id: "dup", type: "bing" }, { id: " dup ", type: "tavily" }] }],

    // type / name / enabled null 与非法形态
    ["entry.type 为 null", { entries: [{ id: "a", type: null }] }],
    ["entry.type 未知", { entries: [{ id: "a", type: "unknown-tool" }] }],
    ["entry.type 非字符串", { entries: [{ id: "a", type: 7 }] }],
    ["entry.name 为 null", { entries: [{ id: "a", type: "bing", name: null }] }],
    ["entry.name 为数字", { entries: [{ id: "a", type: "bing", name: 99 }] }],
    ["entry.name 为 undefined（合法缺省）", { entries: [{ id: "a", type: "bing", name: undefined }] }],
    ["entry.name 为空白（归一化允许）", { entries: [{ id: "a", type: "bing", name: "  " }] }],
    ["entry.enabled 为 null", { entries: [{ id: "a", type: "bing", enabled: null }] }],
    ["entry.enabled 为字符串", { entries: [{ id: "a", type: "bing", enabled: "true" }] }],
    ["entry.enabled 为数字", { entries: [{ id: "a", type: "bing", enabled: 1 }] }],
    ["entry.enabled 为 false（合法）", { entries: [{ id: "a", type: "bing", enabled: false }] }],

    // credentialRef null 与边角形态
    ["entry.credentialRef 为 null（合法省略）", { entries: [{ id: "a", type: "tavily", credentialRef: null }] }],
    ["entry.credentialRef 为 undefined（合法省略）", { entries: [{ id: "a", type: "tavily", credentialRef: undefined }] }],
    ["entry.credentialRef 为空串（合法省略）", { entries: [{ id: "a", type: "tavily", credentialRef: "" }] }],
    ["entry.credentialRef 为空白（非法）", { entries: [{ id: "a", type: "tavily", credentialRef: "   " }] }],
    ["entry.credentialRef 为数字（非法）", { entries: [{ id: "a", type: "tavily", credentialRef: 123 }] }],
    ["entry.credentialRef 带首尾空白（合法 trim）", { entries: [{ id: "a", type: "tavily", credentialRef: "  MY_KEY  " }] }],
    ["entry.credentialRef 含冒号（归一化允许）", { entries: [{ id: "a", type: "tavily", credentialRef: "ref:a" }] }],

    // proxy null 与三形态
    ["entry.proxy 为 null（合法直连）", { entries: [{ id: "a", type: "bing", proxy: null }] }],
    ["entry.proxy 为空白串（合法直连）", { entries: [{ id: "a", type: "bing", proxy: "  " }] }],
    ["entry.proxy 为 http URL（合法）", { entries: [{ id: "a", type: "bing", proxy: "http://127.0.0.1:8080" }] }],
    ["entry.proxy 为 https PAC（合法）", { entries: [{ id: "a", type: "bing", proxy: { pac: "https://proxy.example.com/p.pac" } }] }],
    ["entry.proxy.pac 为 null（非法）", { entries: [{ id: "a", type: "bing", proxy: { pac: null } }] }],
    ["entry.proxy.pac 为空白（非法）", { entries: [{ id: "a", type: "bing", proxy: { pac: "   " } }] }],
    ["entry.proxy.pac 为 ftp（非法）", { entries: [{ id: "a", type: "bing", proxy: { pac: "ftp://proxy.example.com/p.pac" } }] }],
    ["entry.proxy 多余字段（非法）", { entries: [{ id: "a", type: "bing", proxy: { pac: "http://127.0.0.1:8080/p.pac", x: 1 } }] }],
    ["entry.proxy 为 ftp URL（非法）", { entries: [{ id: "a", type: "bing", proxy: "ftp://127.0.0.1:21" }] }],
    ["entry.proxy 为裸 host:port（非法）", { entries: [{ id: "a", type: "bing", proxy: "127.0.0.1:8080" }] }],
    ["entry.proxy 为数字（非法）", { entries: [{ id: "a", type: "bing", proxy: 8080 }] }],

    // 顶层标量 null 与边角
    ["useOfficialDeepSeekSearch 为 null", { useOfficialDeepSeekSearch: null }],
    ["useOfficialDeepSeekSearch 为字符串", { useOfficialDeepSeekSearch: "yes" }],
    ["useOfficialDeepSeekSearch 为 false（合法）", { useOfficialDeepSeekSearch: false }],
    ["timeoutMs 为 null", { timeoutMs: null }],
    ["timeoutMs 为 0", { timeoutMs: 0 }],
    ["timeoutMs 为负数", { timeoutMs: -1 }],
    ["timeoutMs 为小数", { timeoutMs: 1.5 }],
    ["timeoutMs 为字符串", { timeoutMs: "25000" }],
    ["timeoutMs 为 NaN", { timeoutMs: Number.NaN }],
    ["timeoutMs 超安全整数上界", { timeoutMs: 2 ** 53 }],
    ["timeoutMs 为 1（合法）", { timeoutMs: 1 }],
    ["timeoutMs 为 MAX_SAFE_INTEGER（合法）", { timeoutMs: Number.MAX_SAFE_INTEGER }],
  ];

  for (const [label, sample] of matrix) {
    const readRes = outcomeOfNormalize(sample);
    const writeRes = validate(clone(sample));
    assert.equal(writeRes.ok, readRes.ok, `两闸裁决不一致 [${label}]：read=${JSON.stringify(readRes)} write=${JSON.stringify(writeRes)}`);
    if (readRes.ok) {
      assert.deepEqual(writeRes.config, readRes.config, `两闸归一化产物不一致 [${label}]`);
      assert.doesNotThrow(() => toOps(clone(sample), {}), `合法形态 toOps 不得拒 [${label}]`);
    } else {
      assert.equal(writeRes.code, "CONFIG_INVALID", `写闸拒绝码须为 CONFIG_INVALID [${label}]`);
      assert.ok(writeRes.issues?.[0]?.message?.length > 0, `写闸拒绝文案不得为空 [${label}]`);
      assert.throws(() => toOps(clone(sample), {}), (err) => err?.code === "CONFIG_INVALID", `toOps 必须拒非法形态 [${label}]`);
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 第 2 组 · CFG-W-003：写路径明文 key 清零
// ────────────────────────────────────────────────────────────────────────────────────────

test("CFG-W-003 写路径清零：编辑直接保存、保存他行、离散开关/重排/超时/官方开关/移除均清除磁盘 SECRET_FIELD 残留", async () => {
  const dirtyUser = () => ({
    entries: [
      { ...fixtureEntries()[0], apiKey: SYNTH_KEY, TOKEN: "tok-TEST-001" },
      { ...fixtureEntries()[1], api_key: "ak-TEST-002" },
      { ...fixtureEntries()[2], secret: "sec-TEST-003" },
    ],
    useOfficialDeepSeekSearch: true,
    timeoutMs: 25000,
  });

  // (a) 打开含 apiKey 条目，零改动直接点保存 → 条目与兄弟条目全部明文键清除
  {
    const state = makeSettingsState({ user: dirtyUser() });
    await withEnv(state, async ({ fetchStub, hostStub }) => {
      const { view, tree } = await openPanel("wg-clean-save-untouched");
      let t = await step(view, tree, ROLE.edit, { entryId: "tavily-a" });
      t = await step(view, t, ROLE.editorSubmit);
      assert.equal(fetchStub.mutates().length, 1, "存在残留 SECRET_FIELD 时直接保存须发出清理 mutate");
      const mut = fetchStub.mutates()[0];
      assert.deepEqual(secretPathsIn(opsOf(mut)), [], "mutate ops 不得含秘密键名载荷");
      assert.ok(!JSON.stringify(mut.body).includes(SYNTH_KEY), "请求体不得含明文 key");
      assert.deepEqual(allEntrySecretKeys(state.user.entries), [], "保存后磁盘条目不得残留任何 SECRET_FIELD 键");
      assert.equal(leaksIn(t, SYNTH_KEY).length, 0, "渲染树零明文泄漏");
      assert.equal(hostStub.calls.length, 0);
      assert.equal(fetchStub.outbound.length, 0);
      normalizeConfig(state.user);
    });
  }

  // (b) 离散启用开关（停用 exa-b）→ 全部条目残留明文清除
  {
    const state = makeSettingsState({ user: dirtyUser() });
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("wg-clean-toggle");
      await step(view, tree, ROLE.enabled, { entryId: "exa-b" }, "onChange", { target: { checked: false } });
      assert.equal(fetchStub.mutates().length, 1);
      assert.deepEqual(allEntrySecretKeys(state.user.entries), [], "启用开关写路径须清除全条目 SECRET_FIELD 残留");
      assert.equal(state.user.entries[1].enabled, false);
      normalizeConfig(state.user);
    });
  }

  // (c) 键盘重排（bing-c 上移）→ 移动与未移动条目均清除明文残留
  {
    const state = makeSettingsState({ user: dirtyUser() });
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("wg-clean-reorder");
      const t = await step(view, tree, ROLE.dragHandle, { entryId: "bing-c" }, "onKeyDown", { key: "ArrowUp", preventDefault() {} });
      assert.deepEqual(cardOrder(t), ["tavily-a", "bing-c", "exa-b"]);
      assert.equal(fetchStub.mutates().length, 1);
      assert.deepEqual(allEntrySecretKeys(state.user.entries), [], "重排后包含未移动条目在内均须清除 SECRET_FIELD 残留");
      normalizeConfig(state.user);
    });
  }

  // (d) 官方开关与超时提交 → 附带清除 entries 上的 SECRET_FIELD 残留
  for (const [label, trigger] of [
    ["officialToggleChange", (view, tree) => step(view, tree, ROLE.officialToggle, {}, "onChange", { target: { checked: false } })],
    ["timeoutCommit", (view, tree) => act(view, () => {
      const input = one(tree, ROLE.field, { field: "timeoutMs" });
      fire(input, "onChange", { target: { value: "30000" }, currentTarget: { value: "30000" } });
      fire(input, "onBlur", { currentTarget: { value: "30000" } });
    })],
  ]) {
    const state = makeSettingsState({ user: dirtyUser() });
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel(`wg-clean-${label}`);
      await trigger(view, tree);
      assert.equal(fetchStub.mutates().length, 1, `${label} 须恰一次 mutate`);
      assert.deepEqual(secretPathsIn(opsOf(fetchStub.mutates()[0])), [], `${label} ops 不得含秘密键名`);
      assert.deepEqual(allEntrySecretKeys(state.user.entries), [], `${label} 保存后磁盘条目须零 SECRET_FIELD 残留`);
      normalizeConfig(state.user);
    });
  }

  // (e) 确认移除第 0 条（tavily-a）→ 余下条目（下标前移）同样清除 SECRET_FIELD 残留
  {
    const state = makeSettingsState({ user: dirtyUser() });
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("wg-clean-remove");
      let t = await step(view, tree, ROLE.remove, { entryId: "tavily-a" });
      t = await step(view, t, ROLE.confirmRemove, { entryId: "tavily-a" });
      assert.equal(fetchStub.mutates().length, 1);
      assert.deepEqual(allEntrySecretKeys(state.user.entries), [], "移除前清理余下条目的 SECRET_FIELD，避免下标前移漏清");
      assert.deepEqual(state.user.entries.map((e) => e.id), ["exa-b", "bing-c"]);
      normalizeConfig(state.user);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 第 3 组 · CFG-W-001 / CFG-W-002 / CFG-W-004：面板写闸拦截、错误语义、先于凭据写与零出站
// ────────────────────────────────────────────────────────────────────────────────────────

test("CFG-W-001 / CFG-W-004 重复 id 拦截：全离散动作与新建（含新 key）均被写闸拦下、零 credentials/set 与零 mutate", async () => {
  const dupEntries = () => [
    { id: "tavily-a", type: "tavily", name: "Tavily A", enabled: true, credentialRef: "TAVILY_KEY_A" },
    { id: " tavily-a ", type: "exa", name: "Exa 碰撞", enabled: true },
    { id: "bing-c", type: "bing", name: "Bing 公开", enabled: true },
  ];

  // (a) 官方开关、超时、重排、启用开关均拦截
  for (const [label, run] of [
    ["official", (view, tree) => step(view, tree, ROLE.officialToggle, {}, "onChange", { target: { checked: false } })],
    ["timeout", (view, tree) => act(view, () => {
      const input = one(tree, ROLE.field, { field: "timeoutMs" });
      fire(input, "onChange", { target: { value: "30000" }, currentTarget: { value: "30000" } });
      fire(input, "onBlur", { currentTarget: { value: "30000" } });
    })],
    ["reorder", (view, tree) => step(view, tree, ROLE.dragHandle, { entryId: "bing-c" }, "onKeyDown", { key: "ArrowUp", preventDefault() {} })],
    ["enabled", (view, tree) => step(view, tree, ROLE.enabled, { entryId: "bing-c" }, "onChange", { target: { checked: false } })],
  ]) {
    const state = makeSettingsState({ user: { entries: dupEntries(), useOfficialDeepSeekSearch: true, timeoutMs: 25000 } });
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel(`wg-dup-${label}`);
      const t = await run(view, tree);
      const errNode = one(t, ROLE.saveError);
      assert.equal(errNode.props.role, "alert", `${label} 须呈 role=alert 错误`);
      assert.match(textOf(errNode), /重复.*tavily-a/, `${label} 错误须包含重复 id 定位与原因`);
      assert.equal(byRole(t, ROLE.saveStatus).length, 0, `${label} 被拒不得显示成功提示`);
      assert.equal(fetchStub.mutates().length, 0, `${label} 被写闸拒不得发出 mutate`);
      assert.equal(fetchStub.outbound.length, 0);
    });
  }

  // (b) 新建条目且填了新 key → 写闸先于 credentials/set 拒发，编辑器与草稿保留
  {
    const state = makeSettingsState({ user: { entries: dupEntries(), useOfficialDeepSeekSearch: true, timeoutMs: 25000 } });
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("wg-dup-create-key");
      let t = await step(view, tree, ROLE.add);
      t = await act(view, () => fire(one(t, ROLE.field, { field: "name" }), "onChange", { target: { value: "新 Brave" } }));
      t = await act(view, () => fire(one(t, ROLE.field, { field: "key" }), "onChange", { target: { value: SYNTH_KEY } }));
      t = await step(view, t, ROLE.editorSubmit);
      assert.equal(fetchStub.credentialSets().length, 0, "写闸预检未过时绝不得写入孤儿凭据（CFG-W-004）");
      assert.equal(fetchStub.mutates().length, 0, "零 mutate");
      assert.equal(fetchStub.outbound.length, 0, "零出站");
      const errNode = one(t, ROLE.saveError);
      assert.equal(errNode.props.role, "alert");
      assert.match(textOf(errNode), /重复.*tavily-a/);
      assert.equal(byRole(t, ROLE.editor).length, 1, "拒绝后编辑器保留");
      assert.equal(one(t, ROLE.field, { field: "name" }).props.value, "新 Brave", "草稿名称保留");
      assert.equal(leaksIn(t, SYNTH_KEY, { allowDraftInput: true }).length, 0, "仅 key 输入框保留草稿，零额外泄漏");
    });
  }

  // (c) 重复 id 自愈：移除其中一条后仅剩唯一 id，校验通过并成功落盘
  {
    const state = makeSettingsState({ user: { entries: dupEntries(), useOfficialDeepSeekSearch: true, timeoutMs: 25000 } });
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("wg-dup-heal");
      let t = await step(view, tree, ROLE.remove, { entryId: "tavily-a" });
      t = await step(view, t, ROLE.confirmRemove, { entryId: "tavily-a" });
      assert.equal(fetchStub.mutates().length, 1, "移除后不再重复，写闸放行落盘");
      assert.deepEqual(state.user.entries.map((e) => e.id.trim()), ["tavily-a", "bing-c"]);
      normalizeConfig(state.user);
    });
  }
});

test("CFG-W-002 / CFG-W-004 面板 null 形态拦截：name=null / enabled=null / entries[null] 拦下各保存路径，且支持单行修复或移除自愈", async () => {
  // (a) entries[0].name = null → 离散写、他条目保存（含新 key）、移除完好条目（仍留坏条目）均被写闸拒；移除坏条目或编辑修复可恢复
  {
    const brokenEntries = () => [
      { id: "broken-a", type: "tavily", name: null, enabled: true, credentialRef: "TAVILY_KEY_A" },
      { id: "bing-c", type: "bing", name: "Bing 公开", enabled: true },
    ];
    const state = makeSettingsState({ user: { entries: brokenEntries(), useOfficialDeepSeekSearch: true, timeoutMs: 25000 } });
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("wg-null-name");
      // 1) 官方开关受阻
      let t = await step(view, tree, ROLE.officialToggle, {}, "onChange", { target: { checked: false } });
      assert.match(textOf(one(t, ROLE.saveError)), /entries\[0\]\.name/);
      assert.equal(fetchStub.mutates().length, 0);

      // 2) 启用另一个完好条目受阻
      t = await step(view, t, ROLE.enabled, { entryId: "bing-c" }, "onChange", { target: { checked: false } });
      assert.match(textOf(one(t, ROLE.saveError)), /entries\[0\]\.name/);
      assert.equal(fetchStub.mutates().length, 0);

      // 3) 移除完好条目（仍留下 broken-a）受阻且条目在列表恢复，不出现假删除
      t = await step(view, t, ROLE.remove, { entryId: "bing-c" });
      t = await step(view, t, ROLE.confirmRemove, { entryId: "bing-c" });
      assert.match(textOf(one(t, ROLE.saveError)), /entries\[0\]\.name/);
      assert.deepEqual(cardOrder(t), ["broken-a", "bing-c"], "写闸拒绝移除后，列表条目须恢复");
      assert.equal(fetchStub.mutates().length, 0);

      // 4) 编辑 broken-a 填入有效名称 + key 提交 → 自愈成功
      t = await step(view, t, ROLE.edit, { entryId: "broken-a" });
      t = await act(view, () => fire(one(t, ROLE.field, { field: "name" }), "onChange", { target: { value: "已修复 Tavily" } }));
      t = await act(view, () => fire(one(t, ROLE.field, { field: "key" }), "onChange", { target: { value: SYNTH_KEY } }));
      t = await step(view, t, ROLE.editorSubmit);
      assert.equal(fetchStub.credentialSets().length, 1);
      assert.equal(fetchStub.mutates().length, 1);
      assert.equal(state.user.entries[0].name, "已修复 Tavily");
      normalizeConfig(state.user);
    });
  }

  // (b) entries[0].enabled = null → 编辑他行（带新 key）与 timeout 提交均被拦截，零 credentials/set、零 mutate
  {
    const state = makeSettingsState({
      user: {
        entries: [
          { id: "broken-enabled", type: "tavily", name: "Tavily", enabled: null },
          { id: "exa-b", type: "exa", name: "Exa", enabled: true },
        ],
        useOfficialDeepSeekSearch: true,
        timeoutMs: 25000,
      },
    });
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("wg-null-enabled");
      let t = await step(view, tree, ROLE.edit, { entryId: "exa-b" });
      t = await act(view, () => fire(one(t, ROLE.field, { field: "name" }), "onChange", { target: { value: "Exa 新名" } }));
      t = await act(view, () => fire(one(t, ROLE.field, { field: "key" }), "onChange", { target: { value: SYNTH_KEY } }));
      t = await step(view, t, ROLE.editorSubmit);
      assert.equal(fetchStub.credentialSets().length, 0, "不得写入孤儿凭据");
      assert.equal(fetchStub.mutates().length, 0);
      assert.match(textOf(one(t, ROLE.saveError)), /entries\[0\]\.enabled/);

      // 直接移除坏条目 → 自愈成功
      t = await step(view, t, ROLE.editorCancel);
      t = await step(view, t, ROLE.remove, { entryId: "broken-enabled" });
      t = await step(view, t, ROLE.confirmRemove, { entryId: "broken-enabled" });
      assert.equal(fetchStub.mutates().length, 1);
      assert.deepEqual(state.user.entries.map((e) => e.id), ["exa-b"]);
      normalizeConfig(state.user);
    });
  }

  // (c) entries 含 null 非对象元素 + 顶层 timeoutMs = null：不崩溃渲染且写入被拦截
  {
    const state = makeSettingsState({
      user: {
        entries: [null, { id: "bing-c", type: "bing", name: "Bing", enabled: true }],
        useOfficialDeepSeekSearch: true,
        timeoutMs: null,
      },
    });
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("wg-null-mixed");
      assert.equal(byRole(tree, ROLE.saveError).length, 1, "载入即展示校验错误");
      const t = await step(view, tree, ROLE.officialToggle, {}, "onChange", { target: { checked: false } });
      assert.match(textOf(one(t, ROLE.saveError)), /entries\[0\] 必须是对象/);
      assert.equal(fetchStub.mutates().length, 0);
    });
  }

  // (d) 顶层 useOfficialDeepSeekSearch = null / timeoutMs = null 单独拦截（不含 entries 损坏）
  {
    const state = makeSettingsState({
      user: {
        entries: fixtureEntries(),
        useOfficialDeepSeekSearch: null,
        timeoutMs: 25000,
      },
    });
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("wg-null-top-official");
      const t = await act(view, () => {
        const input = one(tree, ROLE.field, { field: "timeoutMs" });
        fire(input, "onChange", { target: { value: "30000" }, currentTarget: { value: "30000" } });
        fire(input, "onBlur", { currentTarget: { value: "30000" } });
      });
      assert.match(textOf(one(t, ROLE.saveError)), /useOfficialDeepSeekSearch 必须是布尔值/);
      assert.equal(fetchStub.mutates().length, 0);
    });
  }
  {
    const state = makeSettingsState({
      user: {
        entries: fixtureEntries(),
        useOfficialDeepSeekSearch: true,
        timeoutMs: null,
      },
    });
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("wg-null-top-timeout");
      let t = await step(view, tree, ROLE.edit, { entryId: "exa-b" });
      t = await act(view, () => fire(one(t, ROLE.field, { field: "key" }), "onChange", { target: { value: SYNTH_KEY } }));
      t = await step(view, t, ROLE.editorSubmit);
      assert.equal(fetchStub.credentialSets().length, 0, "timeoutMs=null 拦截时零孤儿凭据写入");
      assert.equal(fetchStub.mutates().length, 0);
      assert.match(textOf(one(t, ROLE.saveError)), /timeoutMs 必须是正整数毫秒/);
    });
  }
});
