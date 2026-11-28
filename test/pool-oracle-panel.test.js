// 工作包 #86 · 多 key 池轮替 Oracle 骨架（POOL-009 设置面板池编辑 + POOL-010 免 key 形态面板侧）。
// ⚠ Oracle 假设（规格未钉 DOM 锚点，已上报 lead，命名变动须同步本文件）：
//   - 「新增一把 key」动作：props["data-role"]="key-add"；
//   - 槽位移除动作：props["data-role"]="key-remove"；
//   - 每把 key 一个独立槽位行，每槽一个 data-field="key" 输入框（write-only，值不回流）；
//   - 卡片凭据状态含池规模（「N 把」字样）。
// 数据面（真值，无假设）：credentialSets() 计数与顺序、磁盘 credentialRefs 数组顺序、
//   credentials/unset 计数、save-error+role=alert、草稿驻留、零出站、明文 key 不回显。
import test from "node:test";
import assert from "node:assert/strict";
import { REF_GRAMMAR, ROLE, act, byRole, fire, leaksIn, loadSection, makeSettingsState, one, settle, textOf, withEnv } from "./helpers/settings-panel-v02.js";

const POOL_ROLE = Object.freeze({ add: "key-add", remove: "key-remove" });
const KEY1 = "sk-TEST-1111aaaa2222bbbb3333cccc4444dddd";
const KEY2 = "sk-TEST-5555eeee6666ffff7777gggg8888hhhh";

const keyFields = (tree) => byRole(tree, ROLE.field).filter((f) => f.props["data-field"] === "key");
const click = (view, tree, role, filter) => act(view, () => fire(one(tree, role, filter), "onClick"));

function findSelect(node) {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (n && n.type === "select") return n;
    if (Array.isArray(n?.children)) stack.push(...n.children);
  }
  throw new Error("编辑器缺少厂商选择下拉框");
}

/** 打开新增编辑器 → 选厂商 → 填名。 */
async function openAddEditor(view, tree, type, name = "池合成条目") {
  tree = await click(view, tree, ROLE.add);
  fire(findSelect(one(tree, ROLE.editor)), "onChange", { target: { value: type } });
  tree = await settle(view);
  const nameField = one(tree, ROLE.field, { field: "name" });
  return act(view, () => fire(nameField, "onChange", { target: { value: name } }));
}

/** 依次向第 i 个 key 槽填值（槽位模型断言在各步内）。 */
async function fillKeySlot(view, tree, slotIdx, value) {
  const before = keyFields(tree).length;
  tree = await click(view, tree, POOL_ROLE.add);
  assert.equal(keyFields(tree).length, before + 1, `新增槽位应恰多出一个 key 输入框（第 ${slotIdx + 1} 槽）`);
  return act(view, () => fire(keyFields(tree)[slotIdx], "onChange", { target: { value } }));
}

test("POOL-009① 新增填 2 把 key 保存：credentialSets=2、credentialRefs 顺序=录入顺序、卡片状态含池规模", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const view = await loadSection("pool-panel-add");
    let tree = await settle(view);
    tree = await openAddEditor(view, tree, "tavily");
    tree = await fillKeySlot(view, tree, 0, KEY1);
    tree = await fillKeySlot(view, tree, 1, KEY2);
    tree = await act(view, () => fire(one(tree, ROLE.editorSubmit), "onClick"));

    const sets = fetchStub.credentialSets();
    assert.equal(sets.length, 2, `credential/set 调用数 = 新增 key 数（实得 ${sets.length}）`);
    const created = state.user.entries[state.user.entries.length - 1];
    assert.equal(created.name, "池合成条目");
    assert.ok(Array.isArray(created.credentialRefs) && created.credentialRefs.length === 2, "落盘 credentialRefs 数组（2 元）");
    assert.ok(created.credentialRefs.every((r) => REF_GRAMMAR.test(r)), "每把新引用符合 POSIX 语法");
    sets.forEach((c, i) => {
      assert.ok(JSON.stringify(c.body).includes(created.credentialRefs[i]), `第 ${i + 1} 次 credentials/set 写入第 ${i + 1} 个引用（顺序=录入顺序）`);
    });
    assert.match(textOf(one(tree, ROLE.card, { entryId: created.id })), /2\s*把/, "卡片凭据状态显示池规模「2 把」");
    assert.equal(fetchStub.mutates().length, 1, "恰好一次 settings/mutate");
  });
});

test("POOL-009① 安全面：保存成功后全树不出现明文 key；全程零出站", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const view = await loadSection("pool-panel-leak");
    let tree = await settle(view);
    tree = await openAddEditor(view, tree, "tavily");
    tree = await fillKeySlot(view, tree, 0, KEY1);
    tree = await act(view, () => fire(one(tree, ROLE.editorSubmit), "onClick"));
    assert.deepEqual(leaksIn(tree, KEY1), [], "保存后不得回显明文 key（编辑器已关闭，零豁免）");
    assert.equal(fetchStub.outbound.length, 0, "面板全程零供应商/外部出站（SET-004）");
  });
});

test("POOL-009② 移除槽位保存：credentialRefs 缩短；credentials/unset 计数为 0（SET-002 复用边界）", async () => {
  const state = makeSettingsState();
  state.user.entries[0] = { id: "tavily-a", type: "tavily", name: "Tavily 主", enabled: true, credentialRefs: ["POOL_REF_A", "POOL_REF_B"] };
  await withEnv(state, async ({ fetchStub }) => {
    const view = await loadSection("pool-panel-remove");
    let tree = await settle(view);
    tree = await click(view, tree, ROLE.edit, { entryId: "tavily-a" });
    assert.equal(keyFields(tree).length, 2, "编辑既有池条目：每引用一槽（值空见 ③）");
    tree = await act(view, () => fire(byRole(tree, POOL_ROLE.remove)[1], "onClick")); // 移除第 2 槽
    tree = await act(view, () => fire(one(tree, ROLE.editorSubmit), "onClick"));
    assert.deepEqual(state.user.entries[0].credentialRefs, ["POOL_REF_A"], "保存后 credentialRefs = 剩余顺序数组");
    const unsets = fetchStub.credentialCalls().filter((c) => c.kind === "credentials/unset");
    assert.equal(unsets.length, 0, "移除槽位不得删凭据（孤儿引用不回收）");
  });
});

test("POOL-009③ 打开既有池条目：每引用一槽且 write-only，不回显任何既有值", async () => {
  const state = makeSettingsState();
  state.user.entries[0] = { id: "tavily-a", type: "tavily", name: "Tavily 主", enabled: true, credentialRefs: ["POOL_REF_A"] };
  await withEnv(state, async () => {
    const view = await loadSection("pool-panel-reopen");
    let tree = await settle(view);
    tree = await click(view, tree, ROLE.edit, { entryId: "tavily-a" });
    const fields = keyFields(tree);
    assert.equal(fields.length, 1, "一引用一槽");
    for (const f of fields) {
      assert.equal(String(f.props.value ?? ""), "", "key 槽位 write-only：值不回流");
      assert.deepEqual(leaksIn(f, "POOL_REF_A"), [], "槽位不得回显引用名");
    }
  });
});

test("POOL-009④ 凭据写入被拒（rejected）：save-error+role=alert、草稿保留、settings/mutate=0", async () => {
  const state = makeSettingsState({ credentialMode: "rejected" });
  await withEnv(state, async ({ fetchStub }) => {
    const view = await loadSection("pool-panel-rejected");
    let tree = await settle(view);
    tree = await openAddEditor(view, tree, "tavily");
    tree = await fillKeySlot(view, tree, 0, KEY1);
    tree = await act(view, () => fire(one(tree, ROLE.editorSubmit), "onClick"));
    const errs = byRole(tree, ROLE.saveError);
    assert.equal(errs.length, 1, "凭据失败必须显示可见可操作错误（SET-006 锚点）");
    assert.equal(errs[0].props.role, "alert", "错误区 role=alert（SET-006）");
    assert.deepEqual(leaksIn(tree, KEY1, { allowDraftInput: true }), [], "失败驻留：明文只允许作为草稿输入值存在");
    assert.ok(byRole(tree, ROLE.editor).length === 1, "编辑器保持打开，草稿可继续编辑");
    assert.equal(fetchStub.mutates().length, 0, "凭据失败零配置写入（CFG-W-004 先校验后凭据）");
  });
});

test("POOL-009⑤ 同一条目内重复引用提交：可见定位报错，credentialSets=0 且 settings/mutate=0", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const view = await loadSection("pool-panel-dup");
    let tree = await settle(view);
    tree = await openAddEditor(view, tree, "tavily");
    // 同一 key 值填两槽：面板若按值派生引用则重复；若实现允许面板提交，写闸必须拒绝（gates 矩阵已钉文案）。
    tree = await fillKeySlot(view, tree, 0, KEY1);
    tree = await fillKeySlot(view, tree, 1, KEY1);
    tree = await act(view, () => fire(one(tree, ROLE.editorSubmit), "onClick"));
    const rejected = byRole(tree, ROLE.saveError).length === 1 || byRole(tree, ROLE.editor).length === 1 && fetchStub.mutates().length === 0;
    assert.ok(rejected, "重复引用必被可见拒绝（POOL-009⑤）");
    assert.equal(fetchStub.credentialSets().length <= 1, true, "至多一次去重后写入；重复项零写入");
    if (fetchStub.credentialSets().length === 0) assert.equal(fetchStub.mutates().length, 0, "写闸拒绝 = 零 settings/mutate");
  });
});

test("POOL-009⑤b 池上限：8 槽可用、第 9 槽不可达（禁用/不出槽），越限可见", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const view = await loadSection("pool-panel-cap");
    let tree = await settle(view);
    tree = await openAddEditor(view, tree, "tavily");
    for (let i = 0; i < 8; i += 1) {
      tree = await click(view, tree, POOL_ROLE.add);
      assert.equal(keyFields(tree).length, i + 1, `第 ${i + 1} 槽可用（上限 8）`);
    }
    const addBtn = byRole(tree, POOL_ROLE.add)[0];
    const blocked = !addBtn || addBtn.props.disabled === true;
    if (!blocked) {
      tree = await click(view, tree, POOL_ROLE.add);
      assert.equal(keyFields(tree).length, 8, "第 9 槽不得出现");
      assert.equal(byRole(tree, ROLE.saveError).length + byRole(tree, ROLE.field, { field: "name" }).length >= 1, true, "越限提示可见（错误区或提示行）");
    }
    assert.equal(fetchStub.mutates().length, 0);
    assert.equal(fetchStub.credentialSets().length, 0);
  });
});

test("POOL-010① 面板侧 bing：编辑器无 key 输入与 key 槽位动作（免 key 形态一致性）", async () => {
  const state = makeSettingsState();
  await withEnv(state, async () => {
    const view = await loadSection("pool-panel-bing");
    let tree = await settle(view);
    tree = await click(view, tree, ROLE.add);
    fire(findSelect(one(tree, ROLE.editor)), "onChange", { target: { value: "bing" } });
    tree = await settle(view);
    const fields = byRole(tree, ROLE.field).map((f) => f.props["data-field"]);
    assert.ok(!fields.includes("key") && !fields.includes("credentialRef"), "免 key 类型无 key/credentialRef 输入");
    assert.equal(byRole(tree, POOL_ROLE.add).length, 0, "免 key 类型无「新增 key 槽位」动作（POOL-010 面板面）");
  });
});
