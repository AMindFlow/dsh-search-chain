// Issue #88 面板面：全局代理升级区块（PX-011）+ 条目卡钉死控件（PX-012）+ secret 处置（PX-001#2/#3）。
// 判据目录与 docs/specs/draft/proxy-escalation-oracle.md「PX-011/PX-012」逐条对应；
// 复用 test/helpers/settings-panel-v02.js 替身（A-PX-2 已增补新锚点键，不改既有键）。
// 全程零真实网络、零真实定时器、合成凭据（syn-*.invalid）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  ROLE,
  allNodes,
  byRole,
  collectStrings,
  fire,
  leaksIn,
  loadSection,
  makeSettingsState,
  one,
  opsOf,
  settle,
  act,
  withEnv,
} from "./helpers/settings-panel-v02.js";

const SYN_GLOBAL_URL = "http://syn-user:syn-pass@syn-proxy.invalid:8080";
const SYN_GLOBAL_REF = "search_chain_global_proxy";

async function openPanel(tag) {
  const view = await loadSection(tag);
  return { view, tree: await settle(view) };
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.children);
}

function visibleText(node) {
  return textOf(allNodes(node));
}

// ────────────────────────────────────────────────────────────────────────────────────────
// 1) PX-011#1 + PX-002#1（面板层）+ PX-011#4：全新安装 OFF/未配置；拨开关不配地址保存 →
//    区块内 role=alert 可读错误、草稿保留、零 mutate、零 credentials/set、无成功提示。
// ────────────────────────────────────────────────────────────────────────────────────────
test("PX-011#1/PX-002#1/PX-011#4：全新安装 OFF/未配置；拨开关不配地址保存 → 区块 alert、草稿保留、零写入、无成功提示", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub, state }) => {
    const { view, tree } = await openPanel("px-panel-1");
    const toggle = one(tree, ROLE.escalationToggle);
    assert.equal(toggle.props.checked, false, "全新安装开关须 OFF");
    assert.ok(visibleText(one(tree, ROLE.globalProxyStatus)).includes("未配置"), "全局代理状态须呈「未配置」");
    assert.ok(byRole(tree, ROLE.saveError).length === 0, "初始无错误节点");
    let next = await act(view, () => fire(toggle, "onChange", { target: { checked: true } }));
    assert.equal(one(next, ROLE.escalationToggle).props.checked, true, "开关为草稿字段：拨动即反映");
    next = await act(view, () => fire(one(next, ROLE.escalationSave), "onClick"));
    const errs = byRole(next, ROLE.saveError);
    assert.ok(errs.length >= 1, "保存须呈现 role=alert 错误节点");
    assert.equal(one(next, ROLE.saveError).props.role, "alert", "错误节点须 role=alert");
    const errText = errs.map(visibleText).join(" ");
    assert.match(errText, /proxyEscalation/, "错误须定位 proxyEscalation 字段");
    assert.match(errText, /全局代理/, "错误须含全局代理指引");
    assert.equal(byRole(next, ROLE.saveStatus).length, 0, "错误与成功提示互斥（无 save-status）");
    assert.equal(fetchStub.mutates().length, 0, "拒绝路径零 settings/mutate");
    assert.equal(fetchStub.credentialSets().length, 0, "拒绝路径零 credentials/set（CFG-W-004 预检先于凭据写）");
    assert.equal(one(next, ROLE.escalationToggle).props.checked, true, "草稿（开关态）保留");
    assert.equal(fetchStub.outbound.filter((u) => u.includes("syn-proxy")).length, 0, "面板对代理零连通性探测（PX-011#5）");
    assert.equal(state.user.proxyEscalation, undefined, "宿主 user 层未写入开关");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 2) PX-011#2 + PX-001#2：保存带认证合成 URL → 凭据恰 1 次（原值一次）、mutate 体零明文、
//    引用落盘、状态呈脱敏目标、输入清空、重开无回显、凭据先写次序、零出站。
// ────────────────────────────────────────────────────────────────────────────────────────
test("PX-011#2/PX-001#2：保存带认证 URL → 凭据恰 1 次先于 mutate、落盘仅引用、状态脱敏、重开无回显、零出站", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub, state, consoleStub }) => {
    const { view, tree } = await openPanel("px-panel-2");
    let next = await act(view, () => fire(one(tree, ROLE.escalationToggle), "onChange", { target: { checked: true } }));
    next = await act(view, () => fire(one(next, ROLE.globalProxyInput), "onChange", { target: { value: SYN_GLOBAL_URL } }));
    next = await act(view, () => fire(one(next, ROLE.escalationSave), "onClick"));
    const sets = fetchStub.credentialSets();
    assert.equal(sets.length, 1, "凭据恰写入 1 次");
    const setStrings = collectStrings(sets[0].body);
    assert.equal(setStrings.filter((s) => s === SYN_GLOBAL_URL).length, 1, "凭据服务收到原 URL 恰 1 次");
    assert.ok(setStrings.includes(SYN_GLOBAL_REF), "凭据引用为默认引用名");
    const mutes = fetchStub.mutates();
    assert.equal(mutes.length, 1, "恰 1 次 settings/mutate");
    const mutStrings = collectStrings(mutes[0].body);
    assert.ok(!mutStrings.some((s) => s.includes("syn-pass") || s.includes("syn-user")), "mutate 请求体零凭据明文");
    assert.ok(!mutStrings.some((s) => s.includes("://")), "mutate 请求体零明文 URL");
    assert.equal(sets[0].seq < mutes[0].seq, true, "次序：credentials/set 先于 settings/mutate");
    assert.equal(state.user.globalProxy, SYN_GLOBAL_REF, "宿主 user 层 globalProxy 仅落引用名");
    assert.equal(state.user.proxyEscalation, true, "宿主 user 层开关落 true");
    const statusText = visibleText(one(next, ROLE.globalProxyStatus));
    assert.match(statusText, /http:\/\/syn-proxy\.invalid:8080/, "状态指示呈脱敏 scheme://host:port");
    assert.equal(one(next, ROLE.globalProxyInput).props.value, "", "保存成功后输入框清空");
    assert.equal(leaksIn(next, "syn-pass").length, 0, "渲染树零 syn-pass 泄漏");
    assert.equal(leaksIn(next, "syn-user").length, 0, "渲染树零 syn-user 泄漏");
    assert.ok(!consoleStub.text().includes("syn-pass"), "日志零明文（O8）");
    assert.equal(fetchStub.outbound.filter((u) => u.includes("syn-proxy")).length, 0, "面板对全局代理零连通性探测（PX-011#5）");
    // 重开面板：输入框无回显、零泄漏（状态面最多呈「已配置」，不读回明文）。
    const view2 = await loadSection("px-panel-2b");
    const tree2 = await settle(view2);
    assert.equal(one(tree2, ROLE.globalProxyInput).props.value, "", "重开面板输入框为空（无回显）");
    assert.equal(leaksIn(tree2, "syn-pass").length, 0, "重开面板零 syn-pass 泄漏");
    assert.ok(visibleText(one(tree2, ROLE.globalProxyStatus)).includes("已配置"), "重开后状态面呈「已配置」");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 3) PX-011#3：非 HTTP(S) 输入 → 拒绝保存、错误定位「全局代理」、草稿保留、零 mutate、零凭据（SET-004）。
// ────────────────────────────────────────────────────────────────────────────────────────
test("PX-011#3：非 HTTP(S) 输入拒绝保存——错误定位「全局代理」、草稿保留、零写入", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub }) => {
    const { view, tree } = await openPanel("px-panel-3");
    let next = await act(view, () => fire(one(tree, ROLE.escalationToggle), "onChange", { target: { checked: true } }));
    next = await act(view, () => fire(one(next, ROLE.globalProxyInput), "onChange", { target: { value: "ftp://syn-proxy.invalid" } }));
    next = await act(view, () => fire(one(next, ROLE.escalationSave), "onClick"));
    const errText = byRole(next, ROLE.saveError).map(visibleText).join(" ");
    assert.ok(errText.includes("全局代理"), "错误须定位「全局代理」字段");
    assert.equal(one(next, ROLE.globalProxyInput).props.value, "ftp://syn-proxy.invalid", "草稿输入值保留");
    assert.equal(fetchStub.mutates().length, 0, "语法拒绝零 settings/mutate");
    assert.equal(fetchStub.credentialSets().length, 0, "语法拒绝零 credentials/set");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 4) PX-001#3：user 层预置全局代理明文 → 任意变更保存路径一并清零（set 值与 mutate 体零明文）。
// ────────────────────────────────────────────────────────────────────────────────────────
test("PX-001#3：user 层预置全局代理明文 → 无关离散保存一并清零，零明文出站", async () => {
  const state = makeSettingsState({ user: { entries: [{ id: "bing-x", type: "bing", name: "Bing", enabled: true }], useOfficialDeepSeekSearch: true, timeoutMs: 25000, globalProxy: SYN_GLOBAL_URL } });
  await withEnv(state, async ({ fetchStub, state: st }) => {
    const { view, tree } = await openPanel("px-panel-4");
    const statusText = visibleText(one(tree, ROLE.globalProxyStatus));
    assert.ok(!statusText.includes("syn-pass"), "状态面不呈明文（只写不回读）");
    let next = await act(view, () => fire(one(tree, ROLE.officialToggle), "onChange", { target: { checked: false } }));
    const mutes = fetchStub.mutates();
    assert.ok(mutes.length >= 1, "官方开关离散保存发生");
    const mutStrings = collectStrings(mutes[0].body);
    assert.ok(!mutStrings.some((s) => s.includes("syn-pass") || s.includes(":8080")), "mutate 请求体零全局代理明文");
    assert.equal(st.user.globalProxy, undefined, "保存后 user 层明文全局代理被清零（unset）");
    assert.equal(leaksIn(next, "syn-pass").length, 0, "渲染树零明文泄漏");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 5) PX-012#1：新建直连条目钉死默认「继承」；改「仅代理」保存 → 宿主 proxyPin:"proxyOnly"、
//    卡片出现 pin-badge「仅代理」；重开编辑器回读「仅代理」。
// ────────────────────────────────────────────────────────────────────────────────────────
test("PX-012#1：新建条目钉死默认继承；改仅代理保存 → 落盘 proxyOnly + 卡片徽标 + 重开回读", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub, state }) => {
    const { view, tree } = await openPanel("px-panel-5");
    let next = await act(view, () => fire(one(tree, ROLE.add), "onClick"));
    const ghostId = one(next, ROLE.field, { field: "name" }).props["data-entry-id"];
    assert.equal(one(next, ROLE.pinInherit, { entryId: ghostId }).props.checked, true, "新建直连条目钉死默认选中「继承」");
    assert.equal(one(next, ROLE.pinProxy, { entryId: ghostId }).props.checked, false, "「仅代理」初始未选中");
    next = await act(view, () => fire(one(next, ROLE.pinProxy, { entryId: ghostId }), "onChange"));
    assert.equal(one(next, ROLE.pinProxy, { entryId: ghostId }).props.checked, true, "改选「仅代理」");
    next = await act(view, () => fire(one(next, ROLE.editorSubmit), "onClick"));
    const saved = state.user.entries.find((e) => e.id === ghostId);
    assert.ok(saved, "新条目落盘");
    assert.equal(saved.proxyPin, "proxyOnly", "宿主条目 proxyPin 落 proxyOnly");
    const badge = one(next, ROLE.pinBadge, { entryId: ghostId });
    assert.ok(visibleText(badge).includes("仅代理"), "卡片徽标文本「仅代理」");
    // 重开编辑器回读「仅代理」。
    next = await act(view, () => fire(one(next, ROLE.edit, { entryId: ghostId }), "onClick"));
    assert.equal(one(next, ROLE.pinProxy, { entryId: ghostId }).props.checked, true, "重开编辑器回读选中「仅代理」");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 6) PX-012#2：已配固定代理条目 —— 钉死控件禁用 + 提示「已配置自有代理，钉死不适用」；
//    保存不产生 proxyPin 字段。
// ────────────────────────────────────────────────────────────────────────────────────────
test("PX-012#2：自有代理条目钉死控件禁用并提示；保存不产生 proxyPin 字段", async () => {
  const entries = [
    { id: "exa-prox", type: "exa", name: "Exa 代理", enabled: true, proxy: "http://p.invalid:9000" },
    { id: "bing-c", type: "bing", name: "Bing 公开", enabled: true },
  ];
  await withEnv(makeSettingsState({ user: { entries, useOfficialDeepSeekSearch: true, timeoutMs: 25000 } }), async ({ state }) => {
    const { view, tree } = await openPanel("px-panel-6");
    let next = await act(view, () => fire(one(tree, ROLE.edit, { entryId: "exa-prox" }), "onClick"));
    for (const role of [ROLE.pinDirect, ROLE.pinInherit, ROLE.pinProxy]) {
      assert.equal(one(next, role, { entryId: "exa-prox" }).props.disabled, true, "自有代理条目钉死控件须禁用");
    }
    assert.ok(visibleText(one(next, ROLE.editor)).includes("已配置自有代理，钉死不适用"), "界面呈现「已配置自有代理，钉死不适用」");
    next = await act(view, () => fire(one(next, ROLE.field, { field: "name", entryId: "exa-prox" }), "onChange", { target: { value: "Exa 代理改" } }));
    next = await act(view, () => fire(one(next, ROLE.editorSubmit), "onClick"));
    const saved = state.user.entries.find((e) => e.id === "exa-prox");
    assert.ok(saved, "条目落盘");
    assert.ok(!Object.prototype.hasOwnProperty.call(saved, "proxyPin"), "保存后落盘条目无 proxyPin 键");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 7) PX-012#3：编辑他条目不改变已存钉死值（ops 不含无关条目 proxyPin 变更）。
// ────────────────────────────────────────────────────────────────────────────────────────
test("PX-012#3：编辑他条目保存不触及他条目已存钉死值", async () => {
  const entries = [
    { id: "tavily-a", type: "tavily", name: "Tavily 主", enabled: true, credentialRef: "TAVILY_KEY_A" },
    { id: "exa-b", type: "exa", name: "Exa 备用", enabled: true, proxyPin: "proxyOnly" },
  ];
  await withEnv(makeSettingsState({ user: { entries, useOfficialDeepSeekSearch: true, timeoutMs: 25000 } }), async ({ fetchStub, state }) => {
    const { view, tree } = await openPanel("px-panel-7");
    let next = await act(view, () => fire(one(tree, ROLE.edit, { entryId: "tavily-a" }), "onClick"));
    next = await act(view, () => fire(one(next, ROLE.field, { field: "name", entryId: "tavily-a" }), "onChange", { target: { value: "Tavily 主改" } }));
    next = await act(view, () => fire(one(next, ROLE.editorSubmit), "onClick"));
    const mutes = fetchStub.mutates();
    assert.ok(mutes.length >= 1, "改名保存发生");
    const ops = opsOf(mutes[mutes.length - 1]);
    assert.ok(!ops.some((op) => op.path.join("/").includes("entries/1") && op.path[op.path.length - 1] === "proxyPin"), "ops 不含条目 1（exa-b）的 proxyPin 变更");
    const saved = state.user.entries.find((e) => e.id === "exa-b");
    assert.equal(saved.proxyPin, "proxyOnly", "他条目已存钉死值不变");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 8) PX-012#4：直写注入矛盾组合（proxy + proxyPin:"directOnly"）→ 面板读取不崩溃；
//    任何保存路径被写闸拒绝且错误定位 entries[i].proxyPin。
// ────────────────────────────────────────────────────────────────────────────────────────
test("PX-012#4：矛盾组合（proxy+directOnly）读取不崩溃；保存被写闸拒绝并定位 entries[i].proxyPin", async () => {
  const entries = [
    { id: "tavily-a", type: "tavily", name: "Tavily 主", enabled: true, credentialRef: "TAVILY_KEY_A", proxy: "http://p.invalid:9000", proxyPin: "directOnly" },
  ];
  await withEnv(makeSettingsState({ user: { entries, useOfficialDeepSeekSearch: true, timeoutMs: 25000 } }), async ({ fetchStub, state }) => {
    const { view, tree } = await openPanel("px-panel-8");
    // 读取不崩溃：面板正常渲染且可打开编辑器、钉死控件按自有代理口径禁用。
    let next = await act(view, () => fire(one(tree, ROLE.edit, { entryId: "tavily-a" }), "onClick"));
    for (const role of [ROLE.pinDirect, ROLE.pinInherit, ROLE.pinProxy]) {
      assert.equal(one(next, role, { entryId: "tavily-a" }).props.disabled, true, "矛盾条目自有代理在场 → 钉死控件禁用");
    }
    next = await act(view, () => fire(one(next, ROLE.field, { field: "name", entryId: "tavily-a" }), "onChange", { target: { value: "Tavily 矛盾改" } }));
    next = await act(view, () => fire(one(next, ROLE.editorSubmit), "onClick"));
    const errText = byRole(next, ROLE.saveError).map(visibleText).join(" ");
    assert.match(errText, /proxyPin/, "错误须定位 entries[i].proxyPin");
    assert.match(errText, /互斥/, "错误须呈互斥口径");
    assert.equal(fetchStub.mutates().length, 0, "写闸拒绝零 settings/mutate");
    const saved = state.user.entries.find((e) => e.id === "tavily-a");
    assert.equal(saved.name, "Tavily 主", "拒绝后条目内容未变");
  });
});
