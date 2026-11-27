// Issue #56 / V5-5: a pending create draft remains reachable after editing another card.
// This file is the only addition under test/ for this round; no product source is changed.
// #56（V5-5）机械改写记录：本文件按 lead 指示自 artifacts/task-ui56 判据复制入 test/，
// 仅 createTavilyWithCurrentFlow 内旧「点 add-tool → 点 ROLE.addType picker 项」两步操作步骤
// 改写为新交互一步「点 add-tool 直接进表单（默认厂商=目录第一种；若默认厂商非 tavily 用
// 表单内下拉选 tavily，操作与 v02 迁移助手同形态）」；全部断言一字未动。
import test from "node:test";
import assert from "node:assert/strict";
import {
  allNodes,
  ROLE,
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

async function changeField(view, tree, field, value) {
  const input = one(tree, ROLE.field, { field });
  return act(view, () => fire(input, "onChange", { target: { value, checked: value } }));
}

async function createTavilyWithCurrentFlow(view, tree) {
  // #56（V5-2/V5-5）机械改写：原「点 add-tool → 点 ROLE.addType（picker 项）」两步改为
  // 「点 add-tool 直接进表单（默认厂商=目录第一种 openai）」；默认厂商非 tavily，
  // 故用表单内厂商下拉选 tavily（与 v02 迁移助手 addType 同形态）。断言不变：
  // 重开必须恢复同一待保存草稿（同 id + 字段回填）；不得编码 picker 语义。
  tree = await click(view, tree, ROLE.add);
  const select = allNodes(one(tree, ROLE.editor)).find((n) => n && n.type === "select");
  if (select.props.value !== "tavily") {
    tree = await act(view, () => fire(select, "onChange", { target: { value: "tavily" } }));
  }
  return tree;
}

function createId(tree) {
  return one(tree, ROLE.field, { field: "name" }).props["data-entry-id"];
}

test("V5-5 切换编辑后重新打开新增入口，应恢复同一未保存草稿并可保存/取消", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v5-5-draft-reach");
    let next = await createTavilyWithCurrentFlow(view, tree);
    const draftId = createId(next);
    next = await changeField(view, next, "name", "待保存 Tavily 草稿");
    next = await changeField(view, next, "credentialRef", "TAVILY_ROUND25_DRAFT_REF");
    assert.equal(fetchStub.mutates().length, 0, "新增草稿字段输入不得持久化");

    next = await click(view, next, ROLE.edit, { entryId: "exa-b" });
    assert.equal(one(next, ROLE.field, { field: "name" }).props.value, "Exa 备用", "切换后既有条目编辑器正常打开");
    assert.equal(fetchStub.mutates().length, 0, "切换编辑目标不得写入");

    next = await createTavilyWithCurrentFlow(view, next);
    const reopenedId = createId(next);
    assert.equal(reopenedId, draftId, "重新打开新增入口必须恢复同一草稿 id，而非分配新 id");
    assert.equal(one(next, ROLE.field, { field: "name" }).props.value, "待保存 Tavily 草稿", "草稿名称须回填");
    assert.equal(one(next, ROLE.field, { field: "credentialRef" }).props.value, "TAVILY_ROUND25_DRAFT_REF", "厂商凭据引用草稿须回填");
    assert.equal(fetchStub.mutates().length, 0, "重开草稿过程零写入");

    next = await click(view, next, ROLE.editorSubmit);
    assert.equal(fetchStub.mutates().length, 1, "显式保存恰好一次 mutate");
    assert.ok(cardOrder(next).includes(draftId), "保存的草稿进入持久卡片列表");
    const saved = state.user.entries.find((entry) => entry.id === draftId);
    assert.equal(saved.name, "待保存 Tavily 草稿");
    assert.equal(saved.credentialRef, "TAVILY_ROUND25_DRAFT_REF");

    next = await createTavilyWithCurrentFlow(view, next);
    const cancelledId = createId(next);
    next = await changeField(view, next, "name", "取消后不得残留");
    next = await click(view, next, ROLE.editorCancel);
    assert.equal(fetchStub.mutates().length, 1, "显式取消零新增写入");
    next = await createTavilyWithCurrentFlow(view, next);
    assert.notEqual(createId(next), cancelledId, "取消草稿后再次新增应分配全新 id");
    assert.notEqual(one(next, ROLE.field, { field: "name" }).props.value, "取消后不得残留", "取消草稿字段不得残留");
    assert.equal(one(next, ROLE.field, { field: "credentialRef" }).props.value, "", "取消后凭据引用草稿不得残留");
    assert.equal(fetchStub.mutates().length, 1, "取消后重开仍零写入");
  });
});

test("V5-5 反面保护：无待保存草稿时每次新增都是新 id 和默认字段", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v5-5-fresh-add");
    let first = await createTavilyWithCurrentFlow(view, tree);
    const firstId = createId(first);
    const defaultName = one(first, ROLE.field, { field: "name" }).props.value;
    const defaultRef = one(first, ROLE.field, { field: "credentialRef" }).props.value;
    assert.equal(defaultRef, "", "无待保存草稿时凭据引用从默认空值开始");
    first = await click(view, first, ROLE.editorCancel);

    const second = await createTavilyWithCurrentFlow(view, first);
    assert.notEqual(createId(second), firstId, "每次全新新增都分配新 id");
    assert.equal(one(second, ROLE.field, { field: "name" }).props.value, defaultName, "全新新增回到厂商默认名称");
    assert.equal(one(second, ROLE.field, { field: "credentialRef" }).props.value, defaultRef, "全新新增回到默认凭据引用");
    assert.equal(fetchStub.mutates().length, 0, "反面保护流程全程零写入");
  });
});
