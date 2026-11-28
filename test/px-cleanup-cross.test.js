// Issue #88 第二批起各批修复的面板面交叉流（test(proxy)：不改任何骨架/既有测试）：
//  首批 P0：switch-only / 明文×新地址 交叉流——统一 ops builder（finalizeOps）+ 实际终态预检；
//  第二批 ①/③：secret 字段名闭集递归清零（任意位置、按名不按值）+ writeConfig raw 保留面同闭集；
//  第三批 ②：SET-008 条目草稿缓存接入 proxyPin（改 A 钉死转 B 保存 → A 草稿不静默丢）；
//  第四批 P0：新地址恒新唯一 ref——凭据成功而 mutate 冲突时旧 ref/value/路由不变、草稿+失败锚点保留；
//  第五批 ⑥：全局区块统一错误边界（宿主消息回显本次 URL 时脱敏，不留 userinfo/path/query）。
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
const NEXT_URL = "http://next-user:next-pass@next-proxy.invalid:9998";
const NEXT_REF_UNIQUE = /^search_chain_global_proxy_[a-z0-9]+$/;

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

/** 递归收集闭集命中字段的路径串（按字段名，任意深度；独立于实现，测试面自验）。 */
function closureHits(value, path = [], out = []) {
  const NAME = /^(apikey|api_key|key|secret|token|password|auth|authorization|globalproxy.*)$/i;
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) closureHits(value[i], [...path, String(i)], out);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    const p = [...path, k];
    const legitRef = String(k).toLowerCase() === "globalproxy" && typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim());
    if (NAME.test(k) && !legitRef) out.push(p.join("/"));
    if (v !== null && typeof v === "object") closureHits(v, p, out);
  }
  return out;
}

const bingOnly = {
  entries: [{ id: "bing-c", type: "bing", name: "Bing 公开", enabled: true }],
  useOfficialDeepSeekSearch: true,
  timeoutMs: 25000,
};

// ────────────────────────────────────────────────────────────────────────────────────────
// 1) 首批 P0①：switch-only 保存 + 两族存量残留（top 层 globalProxyUrl + 条目级 apiKey）→
//    单次 mutate 同时清两族；合法引用（globalProxy=REF）豁免不清；请求体零明文。
// ────────────────────────────────────────────────────────────────────────────────────────
test("首批P0①：switch-only 保存一并清两族存量（top 全局代理明文 + 条目 legacy secret），合法引用豁免", async () => {
  const state = makeSettingsState({
    user: {
      ...bingOnly,
      globalProxy: SYN_GLOBAL_REF,
      proxyEscalation: false,
      globalProxyUrl: "http://stock-pass@stock-proxy.invalid:9999",
    },
  });
  state.user.entries[0] = { ...bingOnly.entries[0], credentialRef: "BING_NONE", apiKey: "sk-STOCK-1" };
  await withEnv(state, async ({ fetchStub, state: st }) => {
    const { view, tree } = await openPanel("px-cross-1");
    expect_ref_status(tree, SYN_GLOBAL_REF);
    let next = await act(view, () => fire(one(tree, ROLE.escalationToggle), "onChange", { target: { checked: true } }));
    next = await act(view, () => fire(one(next, ROLE.escalationSave), "onClick"));
    const mutes = fetchStub.mutates();
    assert.equal(mutes.length, 1, "switch-only 恰 1 次 mutate");
    const ops = opsOf(mutes[0]);
    assert.ok(ops.some((op) => op.op === "set" && op.path.join("/") === "proxyEscalation" && op.value === true), "开关落盘 op 在场");
    assert.ok(ops.some((op) => op.op === "unset" && op.path.join("/") === "globalProxyUrl"), "top 层全局代理明文 unset 在场（switch-only 路径必带）");
    assert.ok(ops.some((op) => op.op === "unset" && op.path.join("/") === "entries/0/apiKey"), "条目级 legacy secret unset 在场");
    assert.ok(!ops.some((op) => op.op === "unset" && op.path.join("/") === "globalProxy"), "合法引用 globalProxy=REF 不得被清理 unset 豁免误伤");
    const mutStrings = collectStrings(mutes[0].body);
    assert.ok(!mutStrings.some((s) => s.includes("stock-pass") || s.includes("sk-STOCK-1")), "mutate 请求体零明文");
    assert.equal(st.user.globalProxy, SYN_GLOBAL_REF, "合法引用原样保留");
    assert.equal(st.user.globalProxyUrl, undefined, "top 层明文清零");
    assert.equal(st.user.entries[0].apiKey, undefined, "条目级 legacy secret 清零");
    assert.equal(st.user.proxyEscalation, true, "开关落盘 true");
    assert.equal(leaksIn(next, "stock-pass").length, 0, "渲染树零明文");
  });
});

function expect_ref_status(tree, ref) {
  const statusText = visibleText(one(tree, ROLE.globalProxyStatus));
  assert.ok(statusText.includes("已配置"), `状态面呈「已配置」（ref=${ref}）`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// 2) 首批 P0②：同键碰撞——user.globalProxy 为明文 + 输入新地址保存 →
//    终态 globalProxy = 新引用（不是 unset 归空）；无 unset(globalProxy) op；凭据恰 1 次写新唯一 ref。
// ─────────────────────────────────────────────────────────────────────────────────────────
test("首批P0②：明文同键 + 新地址 → set(新唯一 ref) 不被后置 unset 覆盖；终态为引用、请求体零明文", async () => {
  const state = makeSettingsState({
    user: { ...bingOnly, globalProxy: SYN_GLOBAL_URL, proxyEscalation: false },
  });
  await withEnv(state, async ({ fetchStub, state: st }) => {
    const { view, tree } = await openPanel("px-cross-2");
    assert.ok(!visibleText(one(tree, ROLE.globalProxyStatus)).includes("syn-pass"), "状态面不呈存量明文");
    let next = await act(view, () => fire(one(tree, ROLE.escalationToggle), "onChange", { target: { checked: true } }));
    next = await act(view, () => fire(one(next, ROLE.globalProxyInput), "onChange", { target: { value: NEXT_URL } }));
    next = await act(view, () => fire(one(next, ROLE.escalationSave), "onClick"));
    const sets = fetchStub.credentialSets();
    assert.equal(sets.length, 1, "凭据恰写入 1 次");
    const setStrings = collectStrings(sets[0].body);
    assert.ok(setStrings.includes(NEXT_URL), "凭据服务收到新地址");
    const newRef = setStrings.find((s) => s !== NEXT_URL && NEXT_REF_UNIQUE.test(s));
    assert.ok(newRef, `凭据 ref 为新唯一名（既有 ref=明文串 → 非首存）：${setStrings.join("|")}`);
    assert.notEqual(newRef, SYN_GLOBAL_REF, "非首存不得使用默认引用名");
    const mutes = fetchStub.mutates();
    assert.equal(mutes.length, 1, "恰 1 次 mutate");
    const ops = opsOf(mutes[0]);
    assert.ok(!ops.some((op) => op.op === "unset" && op.path.join("/") === "globalProxy"), "同键碰撞：不得出现后置 unset(globalProxy)");
    assert.ok(ops.some((op) => op.op === "set" && op.path.join("/") === "globalProxy" && op.value === newRef), "set 落新唯一引用");
    const mutStrings = collectStrings(mutes[0].body);
    assert.ok(!mutStrings.some((s) => s.includes("syn-pass") || s.includes("next-pass")), "mutate 请求体零两代明文");
    assert.equal(st.user.globalProxy, newRef, "实际终态 globalProxy = 新唯一引用（不是归空）");
    assert.equal(st.user.proxyEscalation, true, "开关落盘 true");
    assert.equal(st.credentials[newRef]?.configured, true, "新引用在凭据服务已配置");
    assert.equal(one(next, ROLE.globalProxyInput).props.value, "", "保存成功输入框清空");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 3) 第二批①：任意位置嵌套明文（extra 顶层 + 二级嵌套）× 官方开关保存流 → 递归按名清零、
//    非闭集未知键（PX-009）存续；请求体零明文。
// ─────────────────────────────────────────────────────────────────────────────────────────
test("第二批①：嵌套任意位置明文 × 离散保存流 → 递归按字段名闭集清零，非闭集未知键存续", async () => {
  const state = makeSettingsState({
    user: {
      ...bingOnly,
      extra: {
        globalProxyUrl: "http://u:p@h:1234",
        apiKey: "sk-NESTED-9",
        meta: { token: "tok-NESTED-7", note: "keep-me" },
      },
    },
  });
  await withEnv(state, async ({ fetchStub, state: st }) => {
    const { view, tree } = await openPanel("px-cross-3");
    const next = await act(view, () => fire(one(tree, ROLE.officialToggle), "onChange", { target: { checked: false } }));
    const mutes = fetchStub.mutates();
    assert.ok(mutes.length >= 1, "官方开关离散保存发生");
    const mutStrings = collectStrings(mutes[0].body);
    assert.ok(!mutStrings.some((s) => s.includes("NESTED") || s.includes("u:p@h")), "mutate 请求体零嵌套明文");
    assert.deepEqual(st.user.extra, { meta: { note: "keep-me" } }, "闭集命中键任意深度全清；非闭集未知键存续（PX-009）");
    assert.equal(st.user.useOfficialDeepSeekSearch, false, "意图变更落盘");
    assert.equal(closureHits(st.user).filter((p) => !p.startsWith("entries/") || !p.endsWith("/proxy")).length, 0, "终层零闭集残留（除合法引用形态）");
    assert.equal(leaksIn(next, "NESTED").length, 0, "渲染树零嵌套明文");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 4) 第四批 P0：凭据成功 → mutate 冲突 → 旧 ref/value/活路由全部不变（配置层原子性）；
//    失败锚点保留、草稿（输入值）保留、无成功提示；孤儿新 ref 留在凭据服务（可清理，不回滚读旧 secret）。
// ─────────────────────────────────────────────────────────────────────────────────────────
test("第四批P0：凭据成功 + mutate 冲突 → 旧 ref/开关不变、草稿与失败锚点保留、孤儿新 ref 在场", async () => {
  const state = makeSettingsState({
    mutateMode: "conflict",
    user: { ...bingOnly, globalProxy: SYN_GLOBAL_REF, proxyEscalation: false },
    credentials: { [SYN_GLOBAL_REF]: { configured: true, writable: true, masked: "••••" } },
  });
  await withEnv(state, async ({ fetchStub, state: st }) => {
    const { view, tree } = await openPanel("px-cross-4");
    expect_ref_status(tree, SYN_GLOBAL_REF);
    let next = await act(view, () => fire(one(tree, ROLE.escalationToggle), "onChange", { target: { checked: true } }));
    next = await act(view, () => fire(one(next, ROLE.globalProxyInput), "onChange", { target: { value: NEXT_URL } }));
    next = await act(view, () => fire(one(next, ROLE.escalationSave), "onClick"));
    const sets = fetchStub.credentialSets();
    assert.equal(sets.length, 1, "凭据先写 1 次（次序：先凭据后 mutate）");
    const setStrings = collectStrings(sets[0].body);
    const orphanRef = setStrings.find((s) => s !== NEXT_URL && NEXT_REF_UNIQUE.test(s));
    assert.ok(orphanRef && orphanRef !== SYN_GLOBAL_REF, "写入的是新唯一 ref（非默认名）");
    assert.equal(st.credentials[SYN_GLOBAL_REF]?.configured, true, "旧 ref 仍配置（未被改动）");
    assert.equal(st.credentials[orphanRef]?.configured, true, "孤儿新 ref 留痕（可清理，不回滚读旧 secret）");
    assert.equal(st.user.globalProxy, SYN_GLOBAL_REF, "mutate 冲突：配置层旧 ref 不变（活路由不变）");
    assert.equal(st.user.proxyEscalation, false, "mutate 冲突：开关不变");
    const errText = byRole(next, ROLE.saveError).map(visibleText).join(" ");
    assert.ok(errText.length > 0, "失败锚点（role=alert）在场");
    assert.equal(byRole(next, ROLE.saveStatus).length, 0, "无成功提示（与错误互斥）");
    assert.equal(one(next, ROLE.globalProxyInput).props.value, NEXT_URL, "草稿（地址输入）保留");
    assert.equal(one(next, ROLE.escalationToggle).props.checked, true, "草稿（开关态）保留");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 5) 第五批⑥：统一错误边界——宿主拒绝消息回显本次 URL 明文（含认证）时，呈现文本脱敏：
//    只留 scheme://host:port，无 userinfo、无 path/query；catch 面（凭据网络异常）同边界。
// ─────────────────────────────────────────────────────────────────────────────────────────
test("第五批⑥：宿主消息回显本次 URL → 错误呈现脱敏（无 userinfo/path/query）；catch 面同边界", async () => {
  await withEnv(
    makeSettingsState({
      mutateMode: "save-failed",
      errorEcho: `${NEXT_URL}/v1/search?apiKey=nxt-secret-q`,
      user: { ...bingOnly, globalProxy: SYN_GLOBAL_REF, proxyEscalation: false },
    }),
    async ({ fetchStub, state }) => {
      const { view, tree } = await openPanel("px-cross-5a");
      let next = await act(view, () => fire(one(tree, ROLE.escalationToggle), "onChange", { target: { checked: true } }));
      next = await act(view, () => fire(one(next, ROLE.globalProxyInput), "onChange", { target: { value: NEXT_URL } }));
      next = await act(view, () => fire(one(next, ROLE.escalationSave), "onClick"));
      const errText = byRole(next, ROLE.saveError).map(visibleText).join(" ");
      assert.ok(errText.includes("next-proxy.invalid:9998"), "错误呈现保留脱敏目标 scheme://host:port");
      assert.ok(!errText.includes("next-user") && !errText.includes("next-pass"), "错误呈现零 userinfo");
      assert.ok(!errText.includes("/v1/search") && !errText.includes("apiKey="), "错误呈现零 path/query");
      assert.ok(!errText.includes("nxt-secret-q"), "错误呈现零回显的附加明文");
      const errLeak = byRole(next, ROLE.saveError).reduce((n, e) => n + leaksIn(e, "next-pass").length, 0);
      assert.equal(errLeak, 0, "错误节点零明文（输入框草稿保留为用户自输文本，不在错误边界面）");
      // 宿主侧数据未被污染：冲突/失败不应用 ops。
      assert.equal(state.user.globalProxy, SYN_GLOBAL_REF, "失败路径配置层不变");
    },
  );
  await withEnv(
    makeSettingsState({
      credentialMode: "network",
      user: { ...bingOnly, globalProxy: SYN_GLOBAL_REF, proxyEscalation: false },
    }),
    async ({ fetchStub }) => {
      const { view, tree } = await openPanel("px-cross-5b");
      let next = await act(view, () => fire(one(tree, ROLE.escalationToggle), "onChange", { target: { checked: true } }));
      next = await act(view, () => fire(one(next, ROLE.globalProxyInput), "onChange", { target: { value: NEXT_URL } }));
      next = await act(view, () => fire(one(next, ROLE.escalationSave), "onClick"));
      const errText = byRole(next, ROLE.saveError).map(visibleText).join(" ");
      assert.ok(errText.includes("fetch failed"), "凭据网络异常以可读错误呈现");
      assert.ok(!errText.includes("next-pass") && !errText.includes("next-user"), "catch 面错误零 URL 明文");
      assert.equal(fetchStub.mutates().length, 0, "凭据写失败后零 settings/mutate");
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 6) 第三批②：SET-008 钉死草稿缓存——改 A 钉死 → 转 B 编辑并保存 B → 重开 A 钉死不静默丢；
//    保存 A 落盘 proxyPin；成功提交清 A 缓存（再重开回读落盘值）。
// ─────────────────────────────────────────────────────────────────────────────────────────
test("第三批②：改 A 钉死转 B 保存 → A 草稿钉死保留并重开复原；保存 A 落盘 proxyPin", async () => {
  const entries = [
    { id: "tavily-a", type: "tavily", name: "Tavily 主", enabled: true, credentialRef: "TAVILY_KEY_A" },
    { id: "exa-b", type: "exa", name: "Exa 备用", enabled: true },
  ];
  await withEnv(makeSettingsState({ user: { ...bingOnly, entries } }), async ({ fetchStub, state }) => {
    const { view, tree } = await openPanel("px-cross-6");
    // 序列 1：编辑 A，钉死「仅直连」（未提交）。
    let next = await act(view, () => fire(one(tree, ROLE.edit, { entryId: "tavily-a" }), "onClick"));
    next = await act(view, () => fire(one(next, ROLE.pinDirect, { entryId: "tavily-a" }), "onChange"));
    assert.equal(one(next, ROLE.pinDirect, { entryId: "tavily-a" }).props.checked, true, "A 钉死选中「仅直连」");
    // 序列 2：转 B 编辑并改名保存（A 草稿须随条目缓存留存）。
    next = await act(view, () => fire(one(next, ROLE.edit, { entryId: "exa-b" }), "onClick"));
    next = await act(view, () => fire(one(next, ROLE.field, { field: "name", entryId: "exa-b" }), "onChange", { target: { value: "Exa 备用改" } }));
    next = await act(view, () => fire(one(next, ROLE.editorSubmit), "onClick"));
    assert.equal(state.user.entries.find((e) => e.id === "exa-b").name, "Exa 备用改", "B 保存落盘");
    assert.equal(state.user.entries.find((e) => e.id === "tavily-a").proxyPin, undefined, "保存 B 不触及 A（A 草稿未落盘）");
    // 序列 3：重开 A——钉死须复原为「仅直连」（缓存回填，不静默丢）。
    next = await act(view, () => fire(one(next, ROLE.edit, { entryId: "tavily-a" }), "onClick"));
    assert.equal(one(next, ROLE.pinDirect, { entryId: "tavily-a" }).props.checked, true, "重开 A 钉死复原「仅直连」（SET-008 缓存）");
    // 序列 4：保存 A → proxyPin 落盘。
    next = await act(view, () => fire(one(next, ROLE.editorSubmit), "onClick"));
    const a = state.user.entries.find((e) => e.id === "tavily-a");
    assert.equal(a.proxyPin, "directOnly", "A 钉死落盘 directOnly");
    // 序列 5：成功提交清 A 缓存——再重开回读落盘值（无残留草稿覆盖）。
    next = await act(view, () => fire(one(next, ROLE.edit, { entryId: "tavily-a" }), "onClick"));
    assert.equal(one(next, ROLE.pinDirect, { entryId: "tavily-a" }).props.checked, true, "再重开 A 回读落盘 directOnly");
    assert.ok(fetchStub.mutates().length >= 2, "B、A 各至少 1 次 mutate");
  });
});
