// Issue #55 UI interaction proposal. Intentionally untracked for Phase B review.
// Assertions target rendered controls, user actions, and persisted state only.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ROLE,
  allNodes,
  byRole,
  cardOrder,
  fire,
  makeSettingsState,
  one,
  settle,
  act,
  withEnv,
  loadSection,
} from "./helpers/settings-panel-v02.js";

async function openPanel(tag) {
  const view = await loadSection(tag);
  return { view, tree: await settle(view) };
}

async function click(view, tree, role, filter = {}) {
  return act(view, () => fire(one(tree, role, filter), "onClick"));
}

function descendants(node) {
  return allNodes(node);
}

function visibleText(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(visibleText).join("");
  return visibleText(node.children);
}

test("V5 编辑开关：同一条再点编辑即收起，开收往返不写入", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v5-edit-toggle");
    let next = await click(view, tree, ROLE.edit, { entryId: "exa-b" });
    assert.equal(byRole(next, ROLE.editor).length, 1, "首次点击编辑应打开配置表单");
    next = await click(view, next, ROLE.edit, { entryId: "exa-b" });
    assert.equal(byRole(next, ROLE.editor).length, 0, "再次点击同一条编辑应收起表单");
    assert.equal(fetchStub.mutates().length, 0, "编辑器开合不写入");
  });
});

test("V5 添加入口：原位打开可切换厂商的表单，无占位行，取消/成功后入口恢复", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v5-add-inline");
    const before = cardOrder(tree);
    let next = await click(view, tree, ROLE.add);
    assert.equal(byRole(next, ROLE.editor).length, 1, "点击添加应直接打开新增表单");
    assert.deepEqual(cardOrder(next), before, "提交前列表不出现占位行");
    const rendered = allNodes(next);
    const lastCardAt = rendered.map((node) => node.props?.["data-role"]).lastIndexOf(ROLE.card);
    const editorAt = rendered.findIndex((node) => node.props?.["data-role"] === ROLE.editor);
    assert.ok(editorAt > lastCardAt, "新增表单应在列表下方的入口区域原位展开");
    assert.equal(byRole(next, ROLE.add).length, 0, "新增表单开启期间入口不重复显示");
    const form = one(next, ROLE.editor);
    const provider = descendants(form).find((node) => node.type === "select");
    assert.ok(provider, "新增表单内须有厂商选择下拉框");
    assert.equal(state.user.entries.length, before.length, "打开表单不提前创建持久条目");

    fire(provider, "onChange", { target: { value: "bing" } });
    next = await settle(view);
    let fields = byRole(next, ROLE.field).map((field) => field.props["data-field"]);
    assert.ok(!fields.includes("key") && !fields.includes("credentialRef"), "免 key 厂商不得显示 key 或 credentialRef 输入");
    const providerAfterSwitch = descendants(one(next, ROLE.editor)).find((node) => node.type === "select");
    fire(providerAfterSwitch, "onChange", { target: { value: "tavily" } });
    next = await settle(view);
    fields = byRole(next, ROLE.field).map((field) => field.props["data-field"]);
    assert.ok(fields.includes("key") && fields.includes("credentialRef"), "需 key 厂商须显示 key 与 credentialRef 输入");

    next = await click(view, next, ROLE.editorCancel);
    assert.equal(byRole(next, ROLE.editor).length, 0, "取消后表单关闭");
    assert.equal(byRole(next, ROLE.add).length, 1, "取消后添加入口恢复");
    assert.equal(state.user.entries.length, before.length, "取消不创建条目");
    assert.equal(fetchStub.mutates().length, 0, "取消零写入");

    next = await click(view, next, ROLE.add);
    const providerForSave = descendants(one(next, ROLE.editor)).find((node) => node.type === "select");
    assert.ok(providerForSave, "再次添加仍直接显示厂商下拉框");
    fire(providerForSave, "onChange", { target: { value: "bing" } });
    next = await settle(view);
    const nameField = one(next, ROLE.field, { field: "name" });
    next = await act(view, () => fire(nameField, "onChange", { target: { value: "" } }));
    const submit = one(next, ROLE.editorSubmit);
    assert.ok(submit.props.disabled === true || byRole(next, ROLE.saveError).length > 0,
      "名称空白时提交须禁用或显示名称门错误");
    const nameAfterGate = one(next, ROLE.field, { field: "name" });
    next = await act(view, () => fire(nameAfterGate, "onChange", { target: { value: "Bing Round2 合成条目" } }));
    assert.equal(one(next, ROLE.field, { field: "name" }).props.value, "Bing Round2 合成条目", "合法名称应保留在草稿");
    next = await click(view, next, ROLE.editorSubmit);
    assert.equal(byRole(next, ROLE.editor).length, 0, "保存成功后表单关闭");
    assert.equal(byRole(next, ROLE.add).length, 1, "保存成功后添加入口恢复");
    assert.equal(state.user.entries.length, before.length + 1, "成功保存才新增持久条目");
    assert.equal(cardOrder(next).length, before.length + 1, "保存成功后的持久条目立即进入列表视图");
    assert.equal(fetchStub.mutates().length, 1, "成功保存恰好一次 mutate");
  });
});

test("V5 添加入口互斥：新增表单打开時入口不可见，关闭后恢复", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("v5-add-exclusive");
    let next = await click(view, tree, ROLE.add);
    assert.equal(byRole(next, ROLE.editor).length, 1, "添加后新增表单在场");
    assert.equal(byRole(next, ROLE.add).length, 0, "表单打开时添加按钮不可见且不可达");
    next = await click(view, next, ROLE.editorCancel);
    assert.equal(byRole(next, ROLE.add).length, 1, "关闭表单后入口恢复");
  });
});

test("V5 开关标签：移除可见启用文字但保留无障碍名称与开关落盘", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v5-switch-label");
    const toggle = one(tree, ROLE.enabled, { entryId: "exa-b" });
    const label = allNodes(tree).find((node) => node.type === "label" && descendants(node).includes(toggle));
    assert.ok(label, "开关须保留 label 可访问名称关联");
    assert.ok(toggle.props["aria-label"]?.includes("Exa 备用"), "无障碍名称须包含条目身份");
    assert.doesNotMatch(visibleText(label), /(^|\s)(启用|启动)(\s|$)/, "开关旁可见文字不得单独出现「启用/启动」");
    const changed = await act(view, () => fire(toggle, "onChange", { target: { checked: false, value: false } }));
    assert.equal(one(changed, ROLE.enabled, { entryId: "exa-b" }).props.checked, false, "开关 checked 状态须立即反映选择");
    assert.equal(state.user.entries[1].enabled, false, "移除标签不得改变开关行为");
    assert.equal(fetchStub.mutates().length, 1, "切换仍恰好一次持久化 mutate");
  });
});

test("V5 新增切无 key 厂商：非法 credentialRef 与缓存 key 不阻塞 bing 提交且载荷不含凭据字段", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v5-keyless-cached-ref");
    const before = cardOrder(tree);
    let next = await click(view, tree, ROLE.add);

    const select1 = descendants(one(next, ROLE.editor)).find((node) => node.type === "select");
    next = await act(view, () => fire(select1, "onChange", { target: { value: "exa" } }));
    next = await act(view, () => fire(one(next, ROLE.field, { field: "credentialRef" }), "onChange", { target: { value: "invalid-ref" } }));
    assert.equal(one(next, ROLE.editorSubmit).props.disabled, true, "keyed 厂商下非法 credentialRef 应禁用保存");
    assert.equal(byRole(next, ROLE.saveError).length, 1, "keyed 厂商下非法 credentialRef 应显示校验错误");

    const select2 = descendants(one(next, ROLE.editor)).find((node) => node.type === "select");
    next = await act(view, () => fire(select2, "onChange", { target: { value: "bing" } }));
    const fields = byRole(next, ROLE.field).map((field) => field.props["data-field"]);
    assert.ok(!fields.includes("key") && !fields.includes("credentialRef"), "切到 bing 后 key 与 credentialRef 字段须隐藏");
    assert.equal(one(next, ROLE.editorSubmit).props.disabled, false, "切到 bing 后保存按钮须可用，不得被隐藏的非法 credentialRef 缓存阻塞");
    assert.equal(byRole(next, ROLE.saveError).length, 0, "切到 bing 后不应显示 credentialRef 校验错误");

    next = await click(view, next, ROLE.editorSubmit);
    assert.equal(byRole(next, ROLE.editor).length, 0, "bing 提交成功后表单应关闭");
    assert.equal(fetchStub.credentialSets().length, 0, "bing 提交不得调用 credentials/set");
    assert.equal(fetchStub.mutates().length, 1, "bing 提交应恰好产生一次 settings/mutate");
    const ops1 = fetchStub.mutates()[0].body?.payload?.args?.ops ?? [];
    const serializedOps1 = JSON.stringify(ops1);
    assert.ok(!serializedOps1.includes("credentialRef") && !serializedOps1.includes("invalid-ref"), "bing 提交载荷不得包含 credentialRef 或缓存非法值");
    assert.ok(!/"key"\s*:/.test(serializedOps1), "bing 提交载荷不得包含 key 字段");
    assert.equal(state.user.entries.length, before.length + 1, "成功保存后持久条目应增加一行");
    const created1 = state.user.entries[state.user.entries.length - 1];
    assert.equal(created1.type, "bing");
    assert.equal("credentialRef" in created1, false, "持久化 bing 条目不得携带 credentialRef");

    // 补充验证：keyed 下同时缓存了合法 ref 与明文 key，再切 bing 提交同样排除两者
    next = await click(view, next, ROLE.add);
    const select3 = descendants(one(next, ROLE.editor)).find((node) => node.type === "select");
    next = await act(view, () => fire(select3, "onChange", { target: { value: "exa" } }));
    next = await act(view, () => fire(one(next, ROLE.field, { field: "credentialRef" }), "onChange", { target: { value: "CACHED_EXA_REF" } }));
    next = await act(view, () => fire(one(next, ROLE.field, { field: "key" }), "onChange", { target: { value: "sk-TEST-cached-bing-ignore" } }));
    const select4 = descendants(one(next, ROLE.editor)).find((node) => node.type === "select");
    next = await act(view, () => fire(select4, "onChange", { target: { value: "bing" } }));
    assert.equal(one(next, ROLE.editorSubmit).props.disabled, false, "缓存 key+ref 后切 bing 保存按钮仍可用");
    next = await click(view, next, ROLE.editorSubmit);
    assert.equal(fetchStub.credentialSets().length, 0, "缓存 key 后切 bing 提交仍不得调用 credentials/set");
    assert.equal(fetchStub.mutates().length, 2, "第二次 bing 提交应恰好新增一次 settings/mutate");
    const ops2 = fetchStub.mutates()[1].body?.payload?.args?.ops ?? [];
    const serializedOps2 = JSON.stringify(ops2);
    assert.ok(!serializedOps2.includes("CACHED_EXA_REF") && !serializedOps2.includes("sk-TEST-cached-bing-ignore"), "第二次 bing 提交载荷不得包含缓存 ref 或明文 key");
    assert.ok(!serializedOps2.includes("credentialRef"), "第二次 bing 提交载荷不得包含 credentialRef 键");
  });
});

test("V5 新增切无 key 厂商再切回 keyed 厂商：缓存 credentialRef 回填且校验门恢复非法态禁用", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v5-keyless-roundtrip-ref");
    let next = await click(view, tree, ROLE.add);

    const select1 = descendants(one(next, ROLE.editor)).find((node) => node.type === "select");
    next = await act(view, () => fire(select1, "onChange", { target: { value: "exa" } }));
    next = await act(view, () => fire(one(next, ROLE.field, { field: "credentialRef" }), "onChange", { target: { value: "invalid-ref" } }));
    assert.equal(one(next, ROLE.editorSubmit).props.disabled, true, "切 bing 前 keyed 非法 ref 禁用保存");

    const select2 = descendants(one(next, ROLE.editor)).find((node) => node.type === "select");
    next = await act(view, () => fire(select2, "onChange", { target: { value: "bing" } }));
    assert.equal(one(next, ROLE.editorSubmit).props.disabled, false, "切到 bing 后保存恢复可用");
    assert.equal(byRole(next, ROLE.saveError).length, 0, "切到 bing 后无校验错误");

    const select3 = descendants(one(next, ROLE.editor)).find((node) => node.type === "select");
    next = await act(view, () => fire(select3, "onChange", { target: { value: "tavily" } }));
    const refField = one(next, ROLE.field, { field: "credentialRef" });
    assert.equal(refField.props.value, "invalid-ref", "切回 keyed 厂商后缓存 credentialRef 须原样回填");
    assert.equal(one(next, ROLE.editorSubmit).props.disabled, true, "切回 keyed 厂商后非法态校验门须恢复禁用");
    assert.equal(byRole(next, ROLE.saveError).length, 1, "切回 keyed 厂商后须重新呈现 credentialRef 校验错误");
    assert.equal(fetchStub.mutates().length, 0, "来回切换厂商零写入");
  });
});

const V5_6_LABELS = {
  openai: "OpenAI",
  tavily: "Tavily",
  exa: "Exa",
  brave: "Brave",
  bing: "Bing RSS",
  gemini: "Gemini",
  "deepseek-search": "DeepSeek Search API",
  "deepseek-agentic-search": "DeepSeek Agentic Search",
};

const V5_6_BILLING_HINTS = {
  openai: "按 OpenAI API 账户用量计费。",
  exa: "费用随 Exa 搜索和内容用量计算。",
  bing: "公开 RSS 通道，免 key，不产生供应商计费。",
};

test("V5-6 厂商下拉选项去括号为纯厂商名，下方 .sc-billing-hint 随厂商切换联动且仅新建显示", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("v5-6-billing-hint");
    let next = await click(view, tree, ROLE.add);
    const editor = one(next, ROLE.editor);
    const select = descendants(editor).find((node) => node.type === "select");
    assert.ok(select, "新增表单须包含厂商下拉框");
    assert.equal(select.children.length, Object.keys(V5_6_LABELS).length, "下拉框须列出全部 8 个厂商选项");

    for (const option of select.children) {
      const text = visibleText(option);
      assert.ok(!text.includes("（") && !text.includes("计费"), `选项 ${option.props.value} 不得含括号或计费说明：${text}`);
      assert.equal(text, V5_6_LABELS[option.props.value], `选项 ${option.props.value} 须为纯厂商名`);
    }

    const findBillingHint = (t) => descendants(one(t, ROLE.editor)).find(
      (node) => node && typeof node.props?.className === "string" && node.props.className.split(/\s+/).includes("sc-billing-hint"),
    );

    const initialHint = findBillingHint(next);
    assert.ok(initialHint, "新增表单须存在 .sc-billing-hint 提示行");
    assert.equal(initialHint.props["data-role"], "billing-hint", "提示行须带 data-role=\"billing-hint\"");
    assert.equal(visibleText(initialHint), V5_6_BILLING_HINTS[select.props.value], "初始计费提示须等于当前厂商提示原文");

    next = await act(view, () => fire(select, "onChange", { target: { value: "exa" } }));
    assert.equal(visibleText(findBillingHint(next)), V5_6_BILLING_HINTS.exa, "切换 exa 后计费提示须联动更新为 Exa 原文");

    const selectExa = descendants(one(next, ROLE.editor)).find((node) => node.type === "select");
    next = await act(view, () => fire(selectExa, "onChange", { target: { value: "bing" } }));
    assert.equal(visibleText(findBillingHint(next)), V5_6_BILLING_HINTS.bing, "切换 bing 后计费提示须联动更新为 Bing RSS 原文");

    next = await click(view, next, ROLE.edit, { entryId: "exa-b" });
    assert.equal(findBillingHint(next), undefined, "编辑已持久条目时不得显示 .sc-billing-hint");
  });
});
