// Issue #58（V5-7 代理配置暴露）：编辑器高级区三态代理输入（空=直连/URL/PAC）+「只写不回显」。
// 判据目录 a-h 与 docs/specs/draft/settings-panel-v5-add-edit.md「V5-7」小节逐条对应。
// 复用 test/helpers/settings-panel-v02.js 替身与 withEnv/makeSettingsState/openPanel/click/fire 惯例
// （参考 test/settings-panel-add-edit-v5.test.js 写法）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  ROLE,
  allNodes,
  byRole,
  fire,
  leaksIn,
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

/** 编辑器内「网络代理（高级）」折叠区与代理输入框（不存在时返回 undefined）。 */
function advancedOf(tree) {
  const ed = one(tree, ROLE.editor);
  const det = descendants(ed).find((n) => n && n.type === "details" && n.props?.className === "sc-advanced");
  const input = byRole(tree, "proxy-field", { field: "proxy" })[0];
  return { details: det, input };
}

/** 断言编辑器高级区在场且形态齐全（两路径共用）。 */
function assertAdvanced(tree, entryId, { configured }) {
  const { details, input } = advancedOf(tree);
  assert.ok(details, "编辑器须存在高级折叠区 <details class=\"sc-advanced\">");
  assert.ok(input, "高级区须存在代理输入框 data-role=\"proxy-field\" data-field=\"proxy\"");
  assert.equal(input.props["data-entry-id"], entryId, "代理输入框须绑定当前编辑条目 id");
  assert.equal(visibleText(details.children.find((c) => c && c.type === "summary")), "网络代理（高级）", "折叠区 summary 须为「网络代理（高级）」");
  assert.ok(visibleText(details).includes("留空=直连"), "高级区须含三态说明小字（留空=直连；填 http(s)://host:port；PAC 填 pac:http(s)://…）");
  assert.ok(visibleText(details).includes("pac:"), "说明小字须含 PAC 填写形态（pac: 前缀）");
  const configuredFlag = Object.prototype.hasOwnProperty.call(input.props, "data-configured");
  if (configured) {
    assert.equal(input.props.value, "", "已配置条目重开编辑器：代理输入框 value 必须为空字符串（只写不回显）");
    assert.equal(input.props["data-configured"], "true", "已配置条目输入框须带 data-configured=\"true\"");
    assert.ok(input.props.placeholder && input.props.placeholder.includes("已配置"), "已配置态 placeholder 须含「已配置」");
  } else {
    assert.equal(input.props.value, "", "未触碰输入框 value 为空");
    assert.equal(input.props.placeholder, "留空=直连", "未配置态 placeholder 为「留空=直连」");
    assert.ok(!configuredFlag || input.props["data-configured"] !== "true", "未配置态不得带 data-configured=\"true\"");
  }
  return input;
}

// ────────────────────────────────────────────────────────────────────────────────────────
// a) 新建与编辑两条路径都展示高级区与 proxy 字段
// ────────────────────────────────────────────────────────────────────────────────────────
test("a) 新建与编辑两条路径的编辑器都存在高级区与 proxy 字段（初始未触碰+未配置态）", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("v5-7-a");
    let next = await click(view, tree, ROLE.add);
    assert.equal(byRole(next, ROLE.editor).length, 1, "前置：点击添加打开新增表单");
    const ghostId = one(next, ROLE.field, { field: "name" }).props["data-entry-id"];
    assertAdvanced(next, ghostId, { configured: false });

    next = await click(view, next, ROLE.editorCancel);
    assert.equal(byRole(next, ROLE.editor).length, 0, "取消后表单关闭");

    next = await click(view, next, ROLE.edit, { entryId: "exa-b" });
    assert.equal(byRole(next, ROLE.editor).length, 1, "前置：点击编辑打开既有表单");
    assertAdvanced(next, "exa-b", { configured: false });
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// b) 填 http://127.0.0.1:8192 保存 → 提交配置条目.proxy 为该字符串
// ────────────────────────────────────────────────────────────────────────────────────────
test("b) 新建填 http://127.0.0.1:8192 保存 → 持久条目 proxy 为该字符串（恰一次 mutate）", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const before = state.user.entries.length;
    const { view, tree } = await openPanel("v5-7-b");
    let next = await click(view, tree, ROLE.add);
    const ghostId = one(next, ROLE.field, { field: "name" }).props["data-entry-id"];
    const proxyInput = one(next, "proxy-field", { field: "proxy" });
    next = await act(view, () => fire(proxyInput, "onChange", { target: { value: "http://127.0.0.1:8192" } }));
    assert.equal(one(next, "proxy-field", { field: "proxy" }).props.value, "http://127.0.0.1:8192", "触碰后输入值须回显用户输入（受控）");
    next = await click(view, next, ROLE.editorSubmit);
    assert.equal(fetchStub.mutates().length, 1, "保存恰好一次 settings/mutate");
    assert.equal(state.user.entries.length, before + 1, "新建条目进入持久列表");
    const saved = state.user.entries.find((e) => e.id === ghostId);
    assert.ok(saved, "保存后持久列表须含新建条目");
    assert.equal(saved.proxy, "http://127.0.0.1:8192", "提交配置条目.proxy 须为所填 URL 字符串");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// c) 填 pac:http://x/y.pac 保存 → {pac:"http://x/y.pac"}
// ────────────────────────────────────────────────────────────────────────────────────────
test("c) 编辑填 pac:http://x/y.pac 保存 → 条目 proxy 为 { pac: \"http://x/y.pac\" }", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v5-7-c");
    let next = await click(view, tree, ROLE.edit, { entryId: "exa-b" });
    const proxyInput = one(next, "proxy-field", { field: "proxy" });
    next = await act(view, () => fire(proxyInput, "onChange", { target: { value: "pac:http://x/y.pac" } }));
    next = await click(view, next, ROLE.editorSubmit);
    assert.equal(fetchStub.mutates().length, 1, "保存恰好一次 settings/mutate");
    const saved = state.user.entries.find((e) => e.id === "exa-b");
    assert.deepEqual(saved.proxy, { pac: "http://x/y.pac" }, "pac: 前缀输入须存 { pac: 去前缀后 URL }");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// d) 编辑已含 proxy 的条目 → input.value===""、data-configured=="true"、placeholder 含「已配置」、渲染 DOM 无该 URL
// ────────────────────────────────────────────────────────────────────────────────────────
const EXISTING_PROXY = "http://127.0.0.1:9099/secret-proxy";

function proxyConfiguredState() {
  const state = makeSettingsState();
  const entry = state.user.entries.find((e) => e.id === "exa-b");
  entry.proxy = EXISTING_PROXY;
  return state;
}

test("d) 编辑已含 proxy 的条目：只写不回显（value 空、data-configured、placeholder 含「已配置」、渲染无 URL 文本）", async () => {
  await withEnv(proxyConfiguredState(), async () => {
    const { view, tree } = await openPanel("v5-7-d");
    const next = await click(view, tree, ROLE.edit, { entryId: "exa-b" });
    const input = assertAdvanced(next, "exa-b", { configured: true });
    assert.deepEqual(leaksIn(next, EXISTING_PROXY), [], "渲染树（文本与全部 props 字符串）不得出现既有 proxy URL（含认证参数形态）");
    assert.ok(input, "输入框在场（断言见 assertAdvanced）");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// e) 不触碰输入直接保存 → proxy 原值保留
// ────────────────────────────────────────────────────────────────────────────────────────
test("e) 编辑已含 proxy 条目不触碰代理输入直接保存 → proxy 原值原样保留（不落新值/不删除）", async () => {
  const state = proxyConfiguredState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v5-7-e");
    let next = await click(view, tree, ROLE.edit, { entryId: "exa-b" });
    const proxyInput = one(next, "proxy-field", { field: "proxy" });
    assert.equal(proxyInput.props.value, "", "前置：未触碰时输入框为空（不回显）");
    next = await click(view, next, ROLE.editorSubmit);
    const saved = state.user.entries.find((e) => e.id === "exa-b");
    assert.equal(saved.proxy, EXISTING_PROXY, "未触碰代理输入：条目 proxy 原值必须保留");
    void fetchStub;
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// f) 触碰并清空提交 → 条目无 proxy 字段
// ────────────────────────────────────────────────────────────────────────────────────────
test("f) 触碰代理输入并清空后提交 → 条目无 proxy 字段", async () => {
  const state = proxyConfiguredState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v5-7-f");
    let next = await click(view, tree, ROLE.edit, { entryId: "exa-b" });
    const proxyInput = one(next, "proxy-field", { field: "proxy" });
    next = await act(view, () => fire(proxyInput, "onChange", { target: { value: "" } }));
    next = await click(view, next, ROLE.editorSubmit);
    assert.equal(fetchStub.mutates().length, 1, "清空提交恰好一次 settings/mutate");
    const saved = state.user.entries.find((e) => e.id === "exa-b");
    assert.equal("proxy" in saved, false, "触碰并清空提交后条目不得残留 proxy 字段");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// g) 非法值（缺协议）→ 保存报错含 normalizeProxy 文案且不落配置
// ────────────────────────────────────────────────────────────────────────────────────────
test("g) 填非法值 127.0.0.1:8192（缺协议）保存 → 既有保存错误面透出 normalizeProxy 文案，且不落配置", async () => {
  const state = proxyConfiguredState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v5-7-g");
    let next = await click(view, tree, ROLE.edit, { entryId: "exa-b" });
    const proxyInput = one(next, "proxy-field", { field: "proxy" });
    next = await act(view, () => fire(proxyInput, "onChange", { target: { value: "127.0.0.1:8192" } }));
    next = await click(view, next, ROLE.editorSubmit);
    const errors = byRole(next, ROLE.saveError);
    assert.ok(errors.length >= 1, "非法代理值必须出现既有保存错误面（role=alert）");
    const errorText = errors.map(visibleText).join("\n");
    assert.ok(errorText.includes("必须是绝对 HTTP(S) URL"), `保存报错须原样透出 normalizeProxy 文案，实得：${errorText}`);
    const saved = state.user.entries.find((e) => e.id === "exa-b");
    assert.equal(saved.proxy, EXISTING_PROXY, "非法值不得落配置：proxy 原值不变");
    assert.equal(fetchStub.mutates().length, 0, "非法值零 settings/mutate");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// h) bing 条目配 proxy 保存 → 有 proxy、无 credentialRef/key 字段
// ────────────────────────────────────────────────────────────────────────────────────────
test("h) bing（keyless）条目配 proxy 保存 → 持久条目有 proxy、无 credentialRef 与 key 字段", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v5-7-h");
    let next = await click(view, tree, ROLE.edit, { entryId: "bing-c" });
    const proxyInput = one(next, "proxy-field", { field: "proxy" });
    next = await act(view, () => fire(proxyInput, "onChange", { target: { value: "http://127.0.0.1:8192" } }));
    next = await click(view, next, ROLE.editorSubmit);
    assert.equal(fetchStub.mutates().length, 1, "bing 保存恰好一次 settings/mutate");
    assert.equal(fetchStub.credentialSets().length, 0, "bing 保存不得调用 credentials/set");
    const saved = state.user.entries.find((e) => e.id === "bing-c");
    assert.equal(saved.proxy, "http://127.0.0.1:8192", "keyless 条目同样可配代理");
    assert.equal("credentialRef" in saved, false, "bing 持久条目不得携带 credentialRef");
    assert.equal("key" in saved, false, "bing 持久条目不得携带 key 字段");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 工单 7（P2 清除代理交互修复）：显式「清除代理」按钮 + 删除意图提示 + 回归钉
// ────────────────────────────────────────────────────────────────────────────────────────

test("T7-1 点击「清除代理」按钮后提交（不直接调 onChange）→ 落盘 payload 该条目无 proxy 字段", async () => {
  const state = proxyConfiguredState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v5-7-t7-1");
    let next = await click(view, tree, ROLE.edit, { entryId: "exa-b" });
    next = await click(view, next, "proxy-clear", { entryId: "exa-b" });
    assert.equal(one(next, ROLE.editorSubmit).props.disabled, false, "空删除意图不得被实时校验门拦截");
    next = await click(view, next, ROLE.editorSubmit);
    assert.equal(fetchStub.mutates().length, 1, "点击清除代理后提交恰好一次 settings/mutate");
    const ops = fetchStub.mutates()[0]?.body?.payload?.args?.ops ?? [];
    assert.ok(
      ops.some((op) => op.op === "unset" && Array.isArray(op.path) && op.path[op.path.length - 1] === "proxy"),
      `落盘 ops 须显式 unset proxy，实得：${JSON.stringify(ops)}`,
    );
    const saved = state.user.entries.find((e) => e.id === "exa-b");
    assert.equal("proxy" in saved, false, "保存后持久条目不得保留 proxy 字段");
  });
});

test("T7-2 已有代理条目：未点清除直接保存 → proxy 原样保留（回归钉）", async () => {
  const state = proxyConfiguredState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v5-7-t7-2");
    let next = await click(view, tree, ROLE.edit, { entryId: "exa-b" });
    const clearBtn = one(next, "proxy-clear", { entryId: "exa-b" });
    assert.equal(clearBtn.props.type, "button", "清除按钮须为 type=button");
    assert.equal(visibleText(clearBtn), "清除代理", "按钮文案须为「清除代理」");
    next = await click(view, next, ROLE.editorSubmit);
    const saved = state.user.entries.find((e) => e.id === "exa-b");
    assert.equal(saved.proxy, EXISTING_PROXY, "未点清除直接保存：proxy 原值必须原样保留");
    assert.equal(fetchStub.mutates().length, 0, "未变更字段时零冗余 mutate");
  });
});

test("T7-3 点清除后按钮消失且 placeholder/hint 出现清除语义；再输入新值 → hint 恢复正常语义、提交后为新代理值", async () => {
  const state = proxyConfiguredState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v5-7-t7-3");
    let next = await click(view, tree, ROLE.edit, { entryId: "exa-b" });
    assert.equal(byRole(next, "proxy-clear", { entryId: "exa-b" }).length, 1, "前置：已配置代理条目呈现清除按钮");
    const initialHint = visibleText(one(next, "proxy-hint"));
    assert.ok(!initialHint.includes("已清除"), "初始 hint 不得含已清除语义");

    next = await click(view, next, "proxy-clear", { entryId: "exa-b" });
    assert.equal(byRole(next, "proxy-clear").length, 0, "点清除后「清除代理」按钮须消失");
    const clearedInput = one(next, "proxy-field", { field: "proxy" });
    assert.ok(
      clearedInput.props.placeholder && clearedInput.props.placeholder.includes("已清除"),
      `点清除后 placeholder 须更新为已清除语义，实得：${clearedInput.props.placeholder}`,
    );
    const clearedHint = visibleText(one(next, "proxy-hint"));
    assert.ok(clearedHint.includes("已清除") && clearedHint.includes("保存后删除代理"), `点清除后 hint 须追加清除语义，实得：${clearedHint}`);
    assert.ok(clearedHint.includes("留空=直连") && clearedHint.includes("pac:"), "点清除后既有 hint 文案仍须保留");
    assert.equal(one(next, ROLE.editorSubmit).props.disabled, false, "删除意图下保存按钮须保持可提交");

    next = await act(view, () => fire(one(next, "proxy-field", { field: "proxy" }), "onChange", { target: { value: "http://127.0.0.1:8899" } }));
    const restoredHint = visibleText(one(next, "proxy-hint"));
    assert.ok(!restoredHint.includes("已清除"), `输入新值后 hint 须恢复正常语义，实得：${restoredHint}`);
    assert.ok(restoredHint.includes("留空=直连") && restoredHint.includes("pac:"), "恢复后既有 hint 文案仍须渲染");
    assert.equal(byRole(next, "proxy-clear", { entryId: "exa-b" }).length, 1, "输入新非空值后清除按钮恢复可用");

    next = await click(view, next, ROLE.editorSubmit);
    assert.equal(fetchStub.mutates().length, 1, "覆盖新值提交恰好一次 settings/mutate");
    const saved = state.user.entries.find((e) => e.id === "exa-b");
    assert.equal(saved.proxy, "http://127.0.0.1:8899", "再输入新值并提交后持久 proxy 为新代理值");
  });
});

test("T7-4 新建条目与未配置代理条目不渲染清除按钮；placeholder 保持「留空=直连」", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("v5-7-t7-4");
    let next = await click(view, tree, ROLE.add);
    assert.equal(byRole(next, "proxy-clear").length, 0, "新建条目（从未配置）不得渲染清除代理按钮");
    assert.equal(one(next, "proxy-field", { field: "proxy" }).props.placeholder, "留空=直连", "新建条目 placeholder 须为「留空=直连」");

    next = await act(view, () => fire(one(next, "proxy-field", { field: "proxy" }), "onChange", { target: { value: "http://127.0.0.1:8000" } }));
    next = await act(view, () => fire(one(next, "proxy-field", { field: "proxy" }), "onChange", { target: { value: "" } }));
    assert.equal(byRole(next, "proxy-clear").length, 0, "新建条目清空输入后仍不得渲染清除按钮");
    assert.equal(one(next, "proxy-field", { field: "proxy" }).props.placeholder, "留空=直连", "未配置条目清空后 placeholder 仍为「留空=直连」");
    assert.ok(!visibleText(one(next, "proxy-hint")).includes("已清除"), "未配置条目 hint 不得出现已清除语义");

    next = await click(view, next, ROLE.editorCancel);
    next = await click(view, next, ROLE.edit, { entryId: "exa-b" });
    assert.equal(byRole(next, "proxy-clear").length, 0, "未配置代理的既有条目不得渲染清除代理按钮");
    assert.equal(one(next, "proxy-field", { field: "proxy" }).props.placeholder, "留空=直连", "未配置条目编辑态 placeholder 须为「留空=直连」");
  });
});

test("T7-5 在途 locked/busy 态下「清除代理」按钮禁用；释放响应后恢复", async () => {
  const state = proxyConfiguredState();
  state.deferMutate = true;
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v5-7-t7-5");
    let next = await click(view, tree, ROLE.edit, { entryId: "exa-b" });
    assert.equal(one(next, "proxy-clear", { entryId: "exa-b" }).props.disabled, false, "前置：非在途态清除按钮可点");

    next = await act(view, () => fire(one(next, ROLE.field, { field: "name" }), "onChange", { target: { value: "Exa 在途测试" } }));
    next = await click(view, next, ROLE.editorSubmit);
    try {
      assert.equal(fetchStub.pendingMutates(), 1, "应有一次挂起中的 settings/mutate");
      const busyClear = one(next, "proxy-clear", { entryId: "exa-b" });
      assert.equal(busyClear.props.disabled, true, "在途 locked/editorBusy 期间「清除代理」按钮须 disabled=true");
    } finally {
      fetchStub.releaseMutate();
    }
    next = await settle(view);
    assert.equal(fetchStub.mutates().length, 1, "释放后完成一次 mutate");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 工单 11b（用户裁定·远程 PAC 风险提示）：非回环即提示（http/https 均提示），同段落文本追加，不禁用不拦截；回环/非 PAC/已清除态不提示
// ────────────────────────────────────────────────────────────────────────────────────────

const REMOTE_PAC_WARN = "提示：该 PAC 来自远程地址，脚本内容可被其服务器随时更改；请仅配置您信任的来源。";

test("T10-4 远程 PAC 风险提示：非回环 PAC（http/https）追加同段提示且不禁用；回环/纯 http/已清除态不提示", async () => {
  await withEnv(proxyConfiguredState(), async () => {
    const { view, tree } = await openPanel("v5-7-t10-4");
    let next = await click(view, tree, ROLE.edit, { entryId: "exa-b" });

    // 1) 非回环 http PAC → proxy-hint 追加警示，且不新增节点、不禁用提交
    next = await act(view, () => fire(one(next, "proxy-field", { field: "proxy" }), "onChange", { target: { value: "pac:http://evil.invalid/a.pac" } }));
    const warnHintNode = one(next, "proxy-hint");
    assert.equal(warnHintNode.type, "p", "hint 保持原 <p> 节点类型");
    assert.ok(
      warnHintNode.children.every((c) => typeof c === "string" || c === null || c === undefined),
      "远程 PAC 警示须同段落文本追加，不得新增子节点类型",
    );
    const warnHintText = visibleText(warnHintNode);
    assert.ok(warnHintText.includes(REMOTE_PAC_WARN), `pac:http://evil.invalid/a.pac 须含远程 PAC 警示语，实得：${warnHintText}`);
    assert.ok(warnHintText.includes("留空=直连") && warnHintText.includes("pac:"), "原有说明小字须保留");
    assert.equal(one(next, ROLE.editorSubmit).props.disabled, false, "远程 PAC 纯提示不得禁用或拦截保存");

    // 2) 非回环 https PAC → 同样提示（TLS 不改变远程内容可变风险语义）且不禁用提交
    next = await act(view, () => fire(one(next, "proxy-field", { field: "proxy" }), "onChange", { target: { value: "pac:https://good.invalid/a.pac" } }));
    const httpsWarnNode = one(next, "proxy-hint");
    assert.equal(httpsWarnNode.type, "p", "https 远程 PAC 下 hint 保持原 <p> 节点类型");
    assert.ok(
      httpsWarnNode.children.every((c) => typeof c === "string" || c === null || c === undefined),
      "https 远程 PAC 警示须同段落文本追加，不得新增子节点类型",
    );
    const httpsText = visibleText(httpsWarnNode);
    assert.ok(httpsText.includes(REMOTE_PAC_WARN), `pac:https://good.invalid/a.pac 须含远程 PAC 警示语，实得：${httpsText}`);
    assert.equal(one(next, ROLE.editorSubmit).props.disabled, false, "https 远程 PAC 纯提示不得禁用或拦截保存");

    // 3) 回环 PAC（127.0.0.1 / localhost / [::1]，无论 http 或 https）→ 不含警示语
    for (const loopbackPac of [
      "pac:http://127.0.0.1:8765/a.pac",
      "pac:http://localhost:8765/a.pac",
      "pac:http://[::1]:8765/a.pac",
      "pac:https://localhost/x.pac",
    ]) {
      next = await act(view, () => fire(one(next, "proxy-field", { field: "proxy" }), "onChange", { target: { value: loopbackPac } }));
      const txt = visibleText(one(next, "proxy-hint"));
      assert.ok(!txt.includes("提示：该 PAC 来自远程地址"), `${loopbackPac} 回环地址不得提示远程 PAC 警示，实得：${txt}`);
    }

    // 4) 纯 http 非 PAC 代理 → 不含警示语
    next = await act(view, () => fire(one(next, "proxy-field", { field: "proxy" }), "onChange", { target: { value: "http://evil.invalid:8080" } }));
    const plainHttpText = visibleText(one(next, "proxy-hint"));
    assert.ok(!plainHttpText.includes("提示：该 PAC 来自远程地址"), `纯 http 非 PAC 代理不得提示远程 PAC 警示，实得：${plainHttpText}`);

    // 5) 已清除态 / 直连态 → 不含警示语
    next = await act(view, () => fire(one(next, "proxy-field", { field: "proxy" }), "onChange", { target: { value: "" } }));
    const clearedText = visibleText(one(next, "proxy-hint"));
    assert.ok(!clearedText.includes("提示：该 PAC 来自远程地址"), `已清除态不得提示远程 PAC 警示，实得：${clearedText}`);
  });
});
