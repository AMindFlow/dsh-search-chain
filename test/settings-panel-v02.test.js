// Issue #48 · v0.2 设置面板 oracle（SET-001…SET-005 + P0 凭据边界）。
//
// 本文件是新增 oracle：实现未落地时红属预期，绝不 skip。
// 钉的是可观察行为：渲染树（经测试侧约定 C-2/C-3，见 helpers/settings-panel-v02.js）、
// settings RPC 的请求 envelope 与 ops、出站请求计数、host.call 计数。文案只用关键词钉。
//
// ─── 设计决定（本套件依据，须在交付报告中呈报 lead 复核）────────────────────────────────
// D-1 reorder 编码（SET-003）= 逐下标 set：
//     拖动/键盘移动后，目标顺序中每个「下标与当前不一致」的条目产出一条
//     set entries[i] = stripSecrets(目标条目)；下标不变的条目不产出任何 op（字段级 diff 原样保留）。
//     被选中 = 只改动位置变化的条目，保持 v0.1 字段级 diff（SET-002 不整体改写未动条目）。
//     代价（钉在第 3 组）：下标变化的条目，其残留的内联明文 apiKey 随 set 值被剥离（P0 要求
//     ops 不含秘密键名，只能剥离）。未移动条目的残留键保持不动。
//     否决：整数组 set entries（会剥离所有条目的残留键，范围过大）；unset+set 逐条重写（同样剥离）。
// D-2C 凭据通道（SET-002/SET-004，P0）= 宿主全局 Remote 的 credentials 命名空间（取代旧 B 与 A）：
//     依据（0.2.2-rc.5 实证）：
//       · @deepseek-ai/dsh-api-settings-controller（README + lib/typert.remote-client.js zod 面）为
//         浏览器配置界面生成平级 Remote 命名空间 settings 与 credentials；与 #46 已走通的
//         settings/describe、settings/mutate 同一控制器。
//       · 方法：credentials/describe(refs[]) → 每 ref {configured, source?, writable, masked?}（masked 为
//         供应商掩码预览，绝不回全值）；credentials/set(ref, value) → void；credentials/unset(ref) → void。
//         README：「Full secret values cross in this direction only: no method here returns one.」
//       · 规格侧：CFG-003「编辑器可接收用户新输入的值，重开时不得回读或回显旧值」；
//         docs/user/getting-started.md 4.3 冻结 v0.2 语义：key 输入框只写不读，带 key 保存时经宿主凭据服务
//         落为新 credentialRef（旧引用不删），移除条目不删凭据。
//     否决旧 B：无 key 输入、指引去模型页，与上述三处冲突。
//     否决旧 A（host.call 写凭据）：host.call 属动态 Client 半专属，静态 bundle 无 host 服务（[C3]）。
//     仍禁：面板操作零 host.call；factory inject 恰 ["slots"]。
//     未实证（实现侧须真机核对）：credentials/* 的 URL 路径（/api/credentials/<m> 或 /api/settings/…）、
//     args 传形（位置数组 vs 命名对象）、describe 回包包装。测试只钉方法字符串与同源 /api/ 前缀。
//     R-1 裁决（0.2.2-rc.5 源码实证）：新生成 credentialRef 必须是 POSIX 标识符，不得含冒号。
//       · @deepseek-ai/dsh-credentials src/index.ts L19：REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/；
//         L29-34 credentialRef() 对不合语法的串抛 TypeError；L45-47 isCredentialRefName 的注释原文：
//         a name outside the grammar "has no reference to miss and should read as 'not set' rather than as a
//         thrown error"（引用侧未命中，不抛错）。
//       · L21 注释：record key 的 `<scope>/<id>` 以 `/` 分隔，正为与 REF 语法不相交；浏览器通道只碰 REF。
//       · 故旧冒号形态 search-chain-credential:<id>:<ts> 必被宿主 set 拒绝（zod 面虽为 z.string()，品牌化在宿主侧）。
//     新 ref 钉：匹配 REF_GRAMMAR；大小写不敏感前缀 SEARCH_CHAIN_CREDENTIAL_；含 entryId 净化形（非 [A-Za-z0-9_] 替换为 _）；
//     每次带 key 保存唯一。语义保持：带 key 保存 → 新 ref、旧引用不删；留空不换 ref。
//     链级（test/credential-ref-grammar.test.js）：超语法引用在 resolveKey 视为该层未命中，落到环境变量/托管层。
//
// ─── R-2（codex P2 增补，三条依据；PR #49 review，实现随后由 dev 做，本段只产出红钉）────────
// P2-1 base 层继承字段保真：describe 回包 base 中的条目（含 model/proxy 等非表单字段）经保存不得丢失。
//     钉：保存若产出 ops（非空），应用到 user 后该条目未知字段仍在且值不变，条目顺序与数量不变；
//     改名变体同样保留未知字段。无改动的保存若不产出 mutate，base 原样保留，视为通过。
// P2-2 在途编辑：mutate 在途期间，保存按钮、条目控件（enabled-toggle、card-edit、add-tool、official-toggle）
//     与名称/key 输入框全部 disabled=true；响应完成后不再有 disabled。挂起用 deferred 手动释放，绝不赌定时。
// P2-3 迁移死路：条目原 credentialRef 为冒号形态时，带新 key 保存须放行（恰一次 credentials/set，ref 为
//     grammar 合法新引用且含净化 entryId，先于一次 mutate；旧冒号 ref 任何请求体都不出现）。
//     留空变体（无 key 且超法 ref）维持阻断，零 mutate、零 credentials 调用、零出站。
//
// 运行期工件仅 test/；不改 src/、docs/、package.json、.github/。

import test from "node:test";
import assert from "node:assert/strict";
import {
  BUNDLE_SLOT,
  ROLE,
  SECTION_ID,
  SECTION_ORDER,
  SECTION_SLOT,
  SECTION_TITLE,
  SECRET_FIELD,
  SYNTH_KEY,
  ALL_TYPES,
  allNodes,
  applyOps,
  byRole,
  cardOrder,
  clone,
  fire,
  fixtureEntries,
  importSelfRegister,
  loadSection,
  makeLiveCtx,
  makeSettingsState,
  one,
  opsOf,
  secretPathsIn,
  settle,
  act,
  textOf,
  withEnv,
  CRED_PREFIX,
  REF_GRAMMAR,
  collectStrings,
  isSameOriginApi,
  leaksIn,
} from "./helpers/settings-panel-v02.js";
import { BILLING_KEYWORDS, OFFICIAL_HINT_KEYWORDS, KEYED_TYPES } from "./helpers/settings-oracle.js";

// ────────────────────────────────────────────────────────────────────────────────────────
// 公共步骤
// ────────────────────────────────────────────────────────────────────────────────────────

/** 交互一步：在当前树上找控件、触发回调、沉降后返回新树。 */
async function step(view, tree, role, filter = {}, prop = "onClick", event = {}) {
  return act(view, () => fire(one(tree, role, filter), prop, event));
}

async function setName(view, tree, entryId, name) {
  tree = await step(view, tree, ROLE.edit, { entryId });
  tree = await act(view, () =>
    fire(one(tree, ROLE.field, { field: "name" }), "onChange", { target: { value: name, checked: name } }),
  );
  return tree;
}

async function setEnabled(view, tree, entryId, on) {
  return act(view, () =>
    fire(one(tree, ROLE.enabled, { entryId }), "onChange", { target: { checked: on, value: on } }),
  );
}

async function moveWithKey(view, tree, entryId, key) {
  return act(view, () => fire(one(tree, ROLE.dragHandle, { entryId }), "onKeyDown", { key, preventDefault() {} }));
}

async function addType(view, tree, type) {
  tree = await step(view, tree, ROLE.add);
  return step(view, tree, ROLE.addType, { type });
}

/** 打开并沉降面板（同一 withEnv 内 fetch 替身已安装）。 */
async function openPanel(tag) {
  const view = await loadSection(tag);
  const tree = await settle(view);
  return { view, tree };
}

function stateEntries(state) {
  return state.user.entries;
}

function idsOf(entries) {
  return entries.map((e) => e.id);
}

// ────────────────────────────────────────────────────────────────────────────────────────
// 第 1 组 · SET-001 入口、布局与空状态
// ────────────────────────────────────────────────────────────────────────────────────────

test("SET-001 注册：settings.section 登记「网页搜索链」区域，id=search-chain，order=30", async () => {
  await withEnv(makeSettingsState(), async () => {
    const view = await loadSection("reg");
    assert.equal(view.registration.id, SECTION_ID, `区域 id 须为 ${SECTION_ID}`);
    assert.equal(view.registration.order, SECTION_ORDER, "区域 order 须为 30（agent-presets 20 之后）");
    const label = typeof view.registration.label === "function" ? view.registration.label() : view.registration.label;
    assert.equal(label, SECTION_TITLE, "区域标题须为「网页搜索链」");
  });
});

test("SET-001 布局：区域顶端为 SET-005 开关，其后依次为卡片，列表末尾为「添加搜索工具」", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { tree } = await openPanel("layout");
    const nodes = allNodes(tree);
    const idx = (pred) => nodes.findIndex(pred);
    const toggleAt = idx((n) => n.props?.["data-role"] === ROLE.officialToggle);
    const firstCard = idx((n) => n.props?.["data-role"] === ROLE.card);
    const lastCardIdx = nodes.map((n) => n.props?.["data-role"]).lastIndexOf(ROLE.card);
    const addAt = idx((n) => n.props?.["data-role"] === ROLE.add);
    assert.ok(toggleAt >= 0, "顶端须有官方搜索开关（SET-005）");
    assert.ok(firstCard > toggleAt, "官方开关须位于第一张卡片之前");
    assert.ok(addAt > lastCardIdx && lastCardIdx >= 0, "「添加搜索工具」须位于最后一张卡片之后");
  });
});

test("SET-001 卡片：每张卡片恰含名称、类型、配置状态、启用开关、编辑、移除、拖动把手各一个", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { tree } = await openPanel("card-parts");
    for (const entry of fixtureEntries()) {
      const filter = { entryId: entry.id };
      one(tree, ROLE.cardName, filter);
      one(tree, ROLE.cardType, filter);
      one(tree, ROLE.cardStatus, filter);
      one(tree, ROLE.enabled, filter);
      one(tree, ROLE.edit, filter);
      one(tree, ROLE.remove, filter);
      one(tree, ROLE.dragHandle, filter);
    }
    assert.deepEqual(cardOrder(tree), idsOf(fixtureEntries()), "卡片视觉顺序须与已保存顺序一致");
  });
});

test("SET-001 状态可辨（R2 纯点）：三态 data-state 落在点自身且区分明确；aria-label/title 互不相同且非空；空文本、role=img、无 aria-live", async () => {
  const state = makeSettingsState({
    user: {
      entries: [
        { id: "tavily-a", type: "tavily", name: "A", enabled: true, credentialRef: "TAVILY_KEY_A" },
        { id: "exa-b", type: "exa", name: "B", enabled: true },
        { id: "bing-c", type: "bing", name: "C", enabled: false },
      ],
      useOfficialDeepSeekSearch: true,
      timeoutMs: 25000,
    },
  });
  await withEnv(state, async () => {
    const { tree } = await openPanel("status");
    const dot = (id) => one(tree, ROLE.cardStatus, { entryId: id });
    const ready = dot("tavily-a");
    const missing = dot("exa-b");
    const closed = dot("bing-c");
    assert.equal(ready.props["data-state"], "ready", "已就绪 data-state=ready");
    assert.equal(missing.props["data-state"], "missing", "缺 key data-state=missing");
    assert.equal(closed.props["data-state"], "disabled", "已关闭 data-state=disabled");
    const label = (n) => n.props["aria-label"];
    assert.ok(label(ready) && label(missing) && label(closed), "三张卡片状态点 aria-label 均须非空");
    assert.notEqual(label(missing), label(ready), "缺少 key 与已就绪不可同标签");
    assert.notEqual(label(closed), label(ready), "已关闭与已就绪不可同标签");
    assert.notEqual(label(closed), label(missing), "已关闭与缺少 key 不可同标签");
    assert.match(label(missing), /缺|未配置|凭据/, "缺少 key 的标签须含「缺/未配置/凭据」之一");
    assert.match(label(closed), /关闭|停用/, "已停用条目的标签须含「关闭/停用」之一");
    for (const d of [ready, missing, closed]) {
      assert.equal(d.props.role, "img", "状态点须 role=img");
      assert.equal(d.props.title, label(d), "title 须等于 aria-label");
      assert.ok(!(d.children || []).some((c) => c !== null && c !== undefined && c !== false), "状态点 textContent 须为空（无子节点、无可见状态文字）");
      assert.ok(!("aria-live" in d.props), "状态点禁止 aria-live");
      assert.ok(String(d.props.className).includes("sc-status-dot"), "状态宿主须为 .sc-status-dot 自身（无 wrapper）");
    }
  });
});

test("SET-001 空状态：无条目时显示引导文案且仍可添加", async () => {
  await withEnv(makeSettingsState({ user: { entries: [], useOfficialDeepSeekSearch: true, timeoutMs: 25000 } }), async () => {
    const { tree } = await openPanel("empty");
    assert.deepEqual(cardOrder(tree), [], "空列表不得渲染任何卡片");
    const empty = one(tree, ROLE.empty);
    assert.match(textOf(empty), /添加/, "空状态文案须引导添加");
    one(tree, ROLE.add);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 第 2 组 · SET-002 增加、编辑与停用、移除
// ────────────────────────────────────────────────────────────────────────────────────────

test("SET-002 添加入口列出 CAT-001 全部八种类型，每种各一个选项", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("picker");
    const opened = await step(view, tree, ROLE.add);
    const options = byRole(opened, ROLE.addType).map((n) => n.props["data-type"]);
    assert.deepEqual([...options].sort(), [...ALL_TYPES].sort(), "添加入口的类型选项须恰为 CAT-001 八种（providers.md）");
  });
});

test("SET-002 类型选项显示计费说明（关键词钉，见 settings-oracle BILLING_KEYWORDS）", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("billing");
    const opened = await step(view, tree, ROLE.add);
    for (const type of ALL_TYPES) {
      const option = one(opened, ROLE.addType, { type });
      const text = textOf(option);
      assert.ok(text.length > 0, `类型 ${type} 的选项须显示说明文字`);
      for (const re of BILLING_KEYWORDS[type] ?? []) {
        assert.match(text, re, `类型 ${type} 的计费说明须含关键要素 ${re}`);
      }
    }
  });
});

test("SET-002 添加：选择 tavily 后新条目追加到末尾、启用，保存后落入 ops 与宿主快照", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("add");
    let t = await addType(view, tree, "tavily");
    const order = cardOrder(t);
    assert.equal(order.length, 4, "添加后须有 4 张卡片");
    const newId = order[3];
    assert.ok(!fixtureEntries().some((e) => e.id === newId), "新条目须有新的稳定 id");
    assert.equal(one(t, ROLE.enabled, { entryId: newId }).props.checked, true, "新条目须默认启用");
    // O-8（#51）：SET-006 条目级保存——新条目须经其编辑器提交落盘（无全局保存钮）。
    t = await step(view, t, ROLE.editorSubmit);
    const saved = stateEntries(state);
    assert.equal(saved.length, 4, "保存后宿主快照应含 4 条");
    assert.equal(saved[3].type, "tavily", "新条目类型须为 tavily");
    assert.equal(saved[3].enabled, true, "新条目须启用");
    assert.equal(fetchStub.mutates().length, 1, "保存恰好一次 mutate");
  });
});

test("SET-002 同类型多实例：两次添加 tavily 得到两个互不相同的 id", async () => {
  const state = makeSettingsState();
  await withEnv(state, async () => {
    const { view, tree } = await openPanel("multi");
    let t = await addType(view, tree, "tavily");
    t = await step(view, t, ROLE.editorSubmit); // O-8（#51）：SET-006——新条目逐条经编辑器提交落盘
    t = await addType(view, t, "tavily");
    t = await step(view, t, ROLE.editorSubmit);
    const ids = idsOf(stateEntries(state));
    assert.equal(new Set(ids).size, ids.length, `同类型实例 id 须唯一：${JSON.stringify(ids)}`);
    assert.equal(stateEntries(state).filter((e) => e.type === "tavily").length, 3, "应有 1 个原有 + 2 个新增 tavily");
  });
});

test("SET-002 编辑隔离：改名 exa-b 后保存，其余两条的 id/类型/名称/启用/凭据引用不变", async () => {
  const state = makeSettingsState();
  await withEnv(state, async () => {
    const before = fixtureEntries();
    const { view, tree } = await openPanel("edit-iso");
    let t = await setName(view, tree, "exa-b", "Exa 改名");
    t = await step(view, t, ROLE.editorSubmit); // O-8（#51）：SET-006——条目级提交替代全局保存
    const after = stateEntries(state);
    const byId = (id) => after.find((e) => e.id === id);
    assert.equal(byId("exa-b").name, "Exa 改名", "被编辑条目名称须更新");
    assert.equal(byId("exa-b").type, "exa", "被编辑条目类型不变");
    for (const id of ["tavily-a", "bing-c"]) {
      assert.deepEqual(byId(id), before.find((e) => e.id === id), `未编辑条目 ${id} 必须保持不变`);
    }
  });
});

test("SET-002 Bing 免 key：编辑器无 key 字段（D-2C，免 key 类型不提供 key 输入）", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("keyless");
    const bingTree = await step(view, tree, ROLE.edit, { entryId: "bing-c" });
    const bingFields = byRole(bingTree, ROLE.field).map((n) => n.props["data-field"]);
    assert.ok(!bingFields.includes("key"), `Bing 编辑器不得出现 key 输入框：${JSON.stringify(bingFields)}`);
    assert.ok(!bingFields.some((f) => SECRET_FIELD.test(f)), `Bing 编辑器不得出现 key 类字段：${JSON.stringify(bingFields)}`);
  });
});

test("SET-002 Tavily 编辑器：key 输入框只写（D-2C），credentialRef 字段可见且可编辑（R-1 校验），重开时 key 输入为空", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("tavily-key");
    const tav = await step(view, tree, ROLE.edit, { entryId: "tavily-a" });
    const fields = byRole(tav, ROLE.field).map((n) => n.props["data-field"]);
    assert.ok(fields.includes("key"), `Tavily 编辑器须有 key 输入框（D-2C）：${JSON.stringify(fields)}`);
    assert.ok(fields.includes("credentialRef"), "Tavily 编辑器须展示 credentialRef 字段（R-1：可编辑，供语法校验）");
    assert.ok(!one(tav, ROLE.field, { field: "key" }).props.value, "key 输入框回填须为空（只写：绝不回显旧值或掩码）");
  });
});

test("SET-002 credentialRef 输入校验（R-1）：不合语法的引用名保存被阻断（零 credentials/set、零 mutate、可见错误或保存禁用）；合法名（如 DEEPSEEK_API_KEY）照常保存", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub, state }) => {
    const { view, tree } = await openPanel("ref-grammar");
    let t = await editEntry(view, tree, "exa-b", { ref: "SEARCH_CHAIN_CREDENTIAL:exa-b:1" });
    t = await step(view, t, ROLE.editorSubmit); // O-8（#51）：SET-006——条目级提交
    assert.equal(fetchStub.credentialSets().length, 0, "不合语法的引用名不得发 credentials/set（R-1）");
    assert.equal(fetchStub.mutates().length, 0, "不合语法的引用名不得发 settings/mutate（R-1）");
    const blocked = byRole(t, ROLE.saveError).length === 1 || one(t, ROLE.editorSubmit).props.disabled === true;
    assert.ok(blocked, "保存须被阻断：须有可见错误（save-error）或保存控件禁用（R-1）");
    t = await act(view, () => fire(one(t, ROLE.field, { field: "credentialRef" }), "onChange", { target: { value: "DEEPSEEK_API_KEY" } }));
    await step(view, t, ROLE.editorSubmit);
    assert.equal(fetchStub.mutates().length, 1, "合法引用名 DEEPSEEK_API_KEY 应照常保存");
    assert.equal(fetchStub.credentialSets().length, 0, "无 key 时合法引用名保存不发 credentials/set");
    assert.equal(state.user.entries.find((e) => e.id === "exa-b").credentialRef, "DEEPSEEK_API_KEY", "合法引用名落入条目");
  });
});

test("SET-002 需 key 的类型编辑器均含 key 输入框（D-2C：KEYED_TYPES 七种逐一添加后打开编辑器）", async () => {
  assert.equal(KEYED_TYPES.length, 7, `KEYED_TYPES 应为 CAT-001 中除 bing 外的七种（现 ${KEYED_TYPES.length}）`);
  for (const type of KEYED_TYPES) {
    await withEnv(makeSettingsState(), async () => {
      const { view, tree } = await openPanel(`keyed-${type}`);
      const added = await addType(view, tree, type);
      const newId = cardOrder(added).at(-1);
      const ed = await step(view, added, ROLE.edit, { entryId: newId });
      assert.equal(byRole(ed, ROLE.field, { field: "key" }).length, 1, `类型 ${type} 的编辑器须恰一个 key 输入框（D-2C）`);
    });
  }
});

test("SET-002 停用：关闭 exa-b 后位置与配置保留；保存后重开仍为关闭且在原位", async () => {
  const state = makeSettingsState();
  await withEnv(state, async () => {
    const { view, tree } = await openPanel("disable");
    // O-8（#51）：SET-006——启用开关 onChange 即离散落盘，无全局保存步。
    const t = await setEnabled(view, tree, "exa-b", false);
    assert.deepEqual(cardOrder(t), idsOf(fixtureEntries()), "停用不得改变卡片位置");
    const reopened = await openPanel("disable-reopen");
    assert.deepEqual(cardOrder(reopened.tree), idsOf(fixtureEntries()), "重开后位置保持");
    assert.equal(one(reopened.tree, ROLE.enabled, { entryId: "exa-b" }).props.checked, false, "重开后 exa-b 须仍为关闭");
    const exa = stateEntries(state)[1];
    assert.equal(exa.name, "Exa 备用", "停用保存后配置（名称）保留");
  });
});

test("SET-002 移除：需二次确认才移除；确认后该条消失，其余凭据引用原样（不触碰宿主凭据）", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub, hostStub }) => {
    const { view, tree } = await openPanel("remove");
    let t = await step(view, tree, ROLE.remove, { entryId: "exa-b" });
    assert.deepEqual(cardOrder(t), idsOf(fixtureEntries()), "未确认前卡片不得消失");
    assert.equal(fetchStub.mutates().length, 0, "未确认前不得写入");
    // O-8（#51）：SET-006——确认移除即落盘 unset，无全局保存步。
    t = await step(view, t, ROLE.confirmRemove, { entryId: "exa-b" });
    assert.deepEqual(idsOf(stateEntries(state)), ["tavily-a", "bing-c"], "确认后 exa-b 须移除（即时落盘）");
    assert.equal(stateEntries(state)[0].credentialRef, "TAVILY_KEY_A", "其余条目的凭据引用不得被改动");
    assert.equal(hostStub.calls.length, 0, "移除不得调用宿主 host.call 通道（D-2C：零 host 调用）");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 第 3 组 · SET-003 拖动与键盘排序；reorder 编码（D-1）
// ────────────────────────────────────────────────────────────────────────────────────────

test("SET-003 键盘等价：bing-c 的把手上移两次后顺序为 bing-c、tavily-a、exa-b", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("kb-move");
    let t = await moveWithKey(view, tree, "bing-c", "ArrowUp");
    assert.deepEqual(cardOrder(t), ["tavily-a", "bing-c", "exa-b"], "第一次上移后顺序");
    t = await moveWithKey(view, t, "bing-c", "ArrowUp");
    assert.deepEqual(cardOrder(t), ["bing-c", "tavily-a", "exa-b"], "第二次上移后顺序");
  });
});

test("SET-003 边界：首张上移与末张下移均为空操作", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("kb-edge");
    let t = await moveWithKey(view, tree, "tavily-a", "ArrowUp");
    assert.deepEqual(cardOrder(t), idsOf(fixtureEntries()), "首张上移无效");
    t = await moveWithKey(view, t, "bing-c", "ArrowDown");
    assert.deepEqual(cardOrder(t), idsOf(fixtureEntries()), "末张下移无效");
  });
});

test("SET-003 已停用条目可排序：关闭的 exa-b 上移到首位后仍为关闭", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("kb-disabled");
    let t = await setEnabled(view, tree, "exa-b", false);
    t = await moveWithKey(view, t, "exa-b", "ArrowUp");
    assert.equal(cardOrder(t)[0], "exa-b", "停用条目须可上移到首位");
    assert.equal(one(t, ROLE.enabled, { entryId: "exa-b" }).props.checked, false, "移动后仍为关闭");
  });
});

test("SET-003 保存后读回：移动两次后保存恰一次 mutate，宿主顺序与卡片顺序一致且 id 保留", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("kb-save");
    // O-8（#51）：SET-006——键盘重排即离散落盘，每次移动一次 mutate（取代「移动后统一保存」）。
    let t = await moveWithKey(view, tree, "bing-c", "ArrowUp");
    assert.equal(fetchStub.mutates().length, 1, "第一次移动即落盘（恰一次 mutate）");
    t = await moveWithKey(view, t, "bing-c", "ArrowUp");
    assert.equal(fetchStub.mutates().length, 2, "第二次移动即落盘（累计恰两次 mutate）");
    assert.deepEqual(idsOf(stateEntries(state)), ["bing-c", "tavily-a", "exa-b"], "宿主快照顺序须与卡片一致");
  });
});

test("SET-003 toOps 契约扩展：重排不得抛错；经权威 reducer 应用后得到合并后的目标顺序", async () => {
  const contract = await loadBundleContract("contract-reorder");
  const current = { entries: fixtureEntries(), useOfficialDeepSeekSearch: true, timeoutMs: 25000 };
  const target = [fixtureEntries()[2], fixtureEntries()[0], fixtureEntries()[1]];
  const merged = contract.merge({ entries: target, useOfficialDeepSeekSearch: true, timeoutMs: 25000 }, clone(current));
  let ops;
  try {
    ops = contract.toOps(clone(merged), clone(current));
  } catch (e) {
    assert.fail(`重排须被 toOps 支持（SET-003），现抛错：${e && e.message}`);
  }
  const reduced = applyOps(current, ops);
  assert.deepEqual(idsOf(reduced.entries), ["bing-c", "tavily-a", "exa-b"], "reducer 应用 ops 后顺序须为目标顺序");
});

test("SET-003 D-1 编码：重排的 ops 只触及位置变化的下标，且 set 值不含秘密键", async () => {
  const contract = await loadBundleContract("encoding");
  const current = { entries: fixtureEntries(), useOfficialDeepSeekSearch: true, timeoutMs: 25000 };
  const target = [fixtureEntries()[0], fixtureEntries()[2], fixtureEntries()[1]]; // 仅 1、2 下标交换
  const merged = contract.merge({ entries: target, useOfficialDeepSeekSearch: true, timeoutMs: 25000 }, clone(current));
  const ops = contract.toOps(clone(merged), clone(current));
  const touchedIndices = new Set(
    ops.filter((o) => o.path[0] === "entries" && o.path.length >= 2).map((o) => o.path[1]),
  );
  assert.ok(!touchedIndices.has("0"), "下标 0 未移动，不得产出任何 entries 条目 op");
  assert.deepEqual([...touchedIndices].sort(), ["1", "2"], "仅下标 1、2 产出 op");
  assert.deepEqual(secretPathsIn(ops), [], `ops 的 set 值不得含秘密键（P0）：${JSON.stringify(secretPathsIn(ops))}`);
});

test("SET-003 D-1 代价（钉）：下标变化的条目残留的内联 apiKey 随重排被剥离；未移动条目的残留键保持不动", async () => {
  const contract = await loadBundleContract("residual");
  const entries = fixtureEntries();
  entries[0].apiKey = SYNTH_KEY; // 未移动（下标 0 保持）
  entries[1].apiKey = SYNTH_KEY; // 移动（下标 1 与 2 交换）
  const current = { entries, useOfficialDeepSeekSearch: true, timeoutMs: 25000 };
  const target = [entries[0], entries[2], entries[1]];
  const merged = contract.merge({ entries: target, useOfficialDeepSeekSearch: true, timeoutMs: 25000 }, clone(current));
  const ops = contract.toOps(clone(merged), clone(current));
  const reduced = applyOps(current, ops);
  assert.equal(reduced.entries[0].apiKey, SYNTH_KEY, "未移动条目的残留 apiKey 不得被 ops 改动");
  assert.equal(reduced.entries[2].apiKey, undefined, "移动到新下标的条目，其残留 apiKey 须随 set 值剥离（D-1 代价）");
});

test("SET-003 字段级 diff 守卫：仅改名（无重排）时 ops 只触及该条目的 name 字段，不整体改写列表或条目", async () => {
  const contract = await loadBundleContract("field-diff");
  const current = { entries: fixtureEntries(), useOfficialDeepSeekSearch: true, timeoutMs: 25000 };
  const target = fixtureEntries();
  target[1].name = "Exa 改名";
  const merged = contract.merge({ entries: target, useOfficialDeepSeekSearch: true, timeoutMs: 25000 }, clone(current));
  const ops = contract.toOps(clone(merged), clone(current));
  for (const o of ops) {
    const p = o.path.join(".");
    assert.ok(!(p === "entries" || /^entries\.\d+$/.test(p)), `不得整体改写列表或条目：${JSON.stringify(o)}`);
  }
  const entryOps = ops.filter((o) => o.path[0] === "entries");
  assert.ok(entryOps.length >= 1 && entryOps.every((o) => o.path[1] === "1" && o.path[2] === "name"), `条目 op 仅限 entries.1.name：${JSON.stringify(entryOps)}`);
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 第 4 组 · SET-004 保存、revision、错误与零出站
// ────────────────────────────────────────────────────────────────────────────────────────

test("SET-004 零出站：打开、开关、改名、停用、排序、添加、移除均不产生供应商请求或 host.call（仅同源 /api/ 的 settings 调用）", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub, hostStub }) => {
    const { view, tree } = await openPanel("zero-out");
    let t = await setName(view, tree, "exa-b", "Exa 改名");
    t = await setEnabled(view, t, "exa-b", false);
    t = await moveWithKey(view, t, "bing-c", "ArrowUp");
    t = await addType(view, t, "tavily");
    t = await step(view, t, ROLE.remove, { entryId: "exa-b" });
    t = await step(view, t, ROLE.confirmRemove, { entryId: "exa-b" });
    t = await step(view, t, ROLE.officialToggle, {}, "onChange", { target: { checked: false, value: false } });
    assert.deepEqual(fetchStub.outbound, [], `面板操作不得出站：${JSON.stringify(fetchStub.outbound)}`);
    const allowed = new Set(["settings/describe", "settings/mutate", "credentials/describe", "credentials/set", "credentials/unset"]);
    for (const c of fetchStub.calls) {
      assert.ok(allowed.has(c.kind) && isSameOriginApi(c.url), `允许的同源端点集合外的请求（D-2C）：${c.url} ${c.kind}`);
    }
    // O-8（#51）：SET-006 后离散动作即时落盘，故不再断言零 mutate；本用例钉的是「零供应商出站、零 host.call」。
    assert.equal(hostStub.calls.length, 0, "面板操作不得调用 host.call（D-2C：静态 ctx 无 host 服务）");
  });
});

test("SET-004 保存：恰一次 mutate，args 含 ns=search-chain、ops 数组、expectedRevision 等于 describe 回包 revision", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("save-once");
    await step(view, await setName(view, tree, "exa-b", "Exa 改名"), ROLE.editorSubmit); // O-8（#51）：SET-006
    const muts = fetchStub.mutates();
    assert.equal(muts.length, 1, "保存恰好一次 mutate");
    const args = muts[0].body.payload.args;
    assert.equal(args.ns, SECTION_ID, "mutate args.ns 须为 search-chain");
    assert.ok(Array.isArray(args.ops) && args.ops.length > 0, "mutate args.ops 须为非空数组");
    assert.equal(args.expectedRevision, 3, "expectedRevision 须等于 describe 回包 revision（3）");
    assert.equal(state.revision, 4, "成功保存后 revision 递增");
  });
});

test("SET-004 修订缺失：describe 回包无 revision 时保存被阻断（零 mutate，且保存控件禁用或可见错误）", async () => {
  await withEnv(makeSettingsState({ omitRevision: true }), async ({ fetchStub }) => {
    const { view, tree } = await openPanel("no-rev");
    const t = await setName(view, tree, "exa-b", "Exa 改名");
    // O-8（#51）：SET-006——缺 revision 时提交钮禁用（读即只读），且面板已有节级错误提示。
    const saveNode = one(t, ROLE.editorSubmit);
    const flagged = saveNode.props.disabled === true || byRole(t, ROLE.saveError).length > 0;
    assert.ok(flagged, "修订缺失时保存控件须禁用或显示错误");
    fire(saveNode, "onClick");
    await settle(view);
    assert.equal(fetchStub.mutates().length, 0, "修订缺失不得发出 mutate");
  });
});

test("SET-004 版本冲突：宿主回 CONFIG_CONFLICT → 错误可见、草稿保留（改名仍在）、不显示已保存", async () => {
  const state = makeSettingsState({ mutateMode: "conflict" });
  await withEnv(state, async () => {
    const { view, tree } = await openPanel("conflict");
    let t = await setName(view, tree, "exa-b", "Exa 冲突草稿");
    t = await step(view, t, ROLE.editorSubmit); // O-8（#51）：SET-006——冲突错误展示于编辑器动作行上方（role=alert）
    assert.ok(byRole(t, ROLE.saveError).length > 0 && textOf(one(t, ROLE.saveError)).length > 0, "冲突须有可见错误");
    assert.match(textOf(t), /Exa 冲突草稿/, "未提交的草稿须保留");
    assert.doesNotMatch(textOf(t), /已保存/, "冲突不得显示已保存");
    assert.equal(state.revision, 3, "冲突后宿主快照不变");
  });
});

test("SET-004 保存失败：宿主拒绝 → 错误可见、草稿保留、宿主继续使用已保存快照", async () => {
  const state = makeSettingsState({ mutateMode: "save-failed" });
  await withEnv(state, async () => {
    const { view, tree } = await openPanel("save-fail");
    let t = await setName(view, tree, "exa-b", "Exa 失败草稿");
    t = await step(view, t, ROLE.editorSubmit); // O-8（#51）：SET-006——失败保留草稿与编辑器
    assert.ok(byRole(t, ROLE.saveError).length > 0, "保存失败须有可见错误");
    assert.match(textOf(t), /Exa 失败草稿/, "失败后草稿保留");
    assert.equal(state.user.entries[1].name, "Exa 备用", "宿主快照保持已保存值");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 第 5 组 · P0 凭据边界（D-2C：宿主全局 Remote credentials 命名空间）
// ────────────────────────────────────────────────────────────────────────────────────────

test("P0 残留明文不渲染：宿主快照中残留的内联 apiKey 不得出现在面板文本中（含展开编辑器）", async () => {
  const entries = fixtureEntries();
  entries[1].apiKey = SYNTH_KEY;
  await withEnv(makeSettingsState({ user: { entries, useOfficialDeepSeekSearch: true, timeoutMs: 25000 } }), async () => {
    const { view, tree } = await openPanel("residual-render");
    assert.ok(!textOf(tree).includes(SYNTH_KEY), "卡片文本不得含 key 明文");
    const edited = await step(view, tree, ROLE.edit, { entryId: "exa-b" });
    assert.ok(!textOf(edited).includes(SYNTH_KEY), "编辑器文本不得含 key 明文");
  });
});

test("P0 写入边界：保存后 mutate 的 ops 与请求体不含秘密键名或残留 key 明文", async () => {
  const entries = fixtureEntries();
  entries[1].apiKey = SYNTH_KEY;
  const state = makeSettingsState({ user: { entries, useOfficialDeepSeekSearch: true, timeoutMs: 25000 } });
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("residual-write");
    await step(view, await setName(view, tree, "exa-b", "Exa 改名"), ROLE.editorSubmit); // O-8（#51）：SET-006
    const mut = fetchStub.mutates()[0];
    assert.ok(mut, "保存应产生 mutate");
    assert.deepEqual(secretPathsIn(opsOf(mut)), [], "ops 不得含秘密键名（P0）");
    assert.ok(!JSON.stringify(mut.body).includes(SYNTH_KEY), "请求体不得含 key 明文");
  });
});

/** 打开条目编辑器并依次写入草稿字段（不保存）；返回编辑器打开后的树。 */
async function editEntry(view, tree, entryId, { name, key, ref } = {}) {
  let t = await step(view, tree, ROLE.edit, { entryId });
  if (name !== undefined) {
    t = await act(view, () => fire(one(t, ROLE.field, { field: "name" }), "onChange", { target: { value: name } }));
  }
  if (ref !== undefined) {
    t = await act(view, () => fire(one(t, ROLE.field, { field: "credentialRef" }), "onChange", { target: { value: ref } }));
  }
  if (key !== undefined) {
    t = await act(view, () => fire(one(t, ROLE.field, { field: "key" }), "onChange", { target: { value: key } }));
  }
  return t;
}

/** 保存后取出 credentials/set 调用体中的 ref（前缀钉）。 */
function refOfSet(call) {
  return collectStrings(call.body?.payload?.args ?? {}).find((s) => s.toLowerCase().startsWith(CRED_PREFIX.toLowerCase()));
}

test("P0 无 host 通道（D-2C）：带 key 保存经 credentials/set，面板操作零 host.call；factory inject 恰 [\"slots\"]", async () => {
  await withEnv(makeSettingsState(), async ({ hostStub, fetchStub }) => {
    const { view, tree } = await openPanel("no-host");
    const added = await addType(view, tree, "exa");
    const newId = cardOrder(added).at(-1);
    let t = await editEntry(view, added, newId, { key: SYNTH_KEY });
    t = await step(view, t, ROLE.editorSubmit); // O-8（#51）：SET-006 条目级提交
    assert.equal(hostStub.calls.length, 0, "带 key 保存亦不得调用 host.call（D-2C：静态 ctx 无 host 服务）");
    assert.equal(fetchStub.credentialSets().length, 1, "带 key 保存须经 credentials/set（D-2C）");
    const regs = await importSelfRegister("no-host-ctx");
    const product = regs[0].factory((spec) => (spec === "react" ? undefined : undefined));
    assert.deepEqual([...product.inject].sort(), ["slots"], "factory inject 恰为 [\"slots\"]（不声明 host 服务）");
  });
});

test("P0 凭据 D-2C 保存时序：非空 key 先 credentials/set(newRef,key)，成功后才 settings/mutate，且 credentialRef === newRef", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub, consoleStub, state }) => {
    const { view, tree } = await openPanel("keyed-order");
    let t = await editEntry(view, tree, "exa-b", { key: SYNTH_KEY });
    assert.equal(leaksIn(t, SYNTH_KEY, { allowDraftInput: true }).length, 0, "草稿期间明文只允许出现在 key 输入框的 value");
    t = await step(view, t, ROLE.editorSubmit); // O-8（#51）：SET-006 条目级提交
    const sets = fetchStub.credentialSets();
    const muts = fetchStub.mutates();
    assert.equal(sets.length, 1, "带非空 key 保存恰一次 credentials/set");
    assert.equal(muts.length, 1, "成功后恰一次 settings/mutate");
    assert.ok(sets[0].seq < muts[0].seq, "credentials/set 须先于 settings/mutate（成功后才写配置）");
    const ref = refOfSet(sets[0]);
    assert.ok(ref, "credentials/set 请求体须含以 SEARCH_CHAIN_CREDENTIAL_（大小写不敏感）开头的 ref");
    assert.match(ref, REF_GRAMMAR, "ref 须匹配 POSIX grammar ^[A-Za-z_][A-Za-z0-9_]*$（R-1，无冒号）");
    assert.match(ref, /^search_chain_credential_exa_b_/i, "ref 形态 SEARCH_CHAIN_CREDENTIAL_<净化 entryId>_<唯一后缀>（前缀大小写不敏感）");
    assert.ok(collectStrings(sets[0].body?.payload?.args ?? {}).includes(SYNTH_KEY), "明文 key 只允许出现在 credentials/set 请求体（唯一合法出口）");
    assert.equal(state.user.entries.find((e) => e.id === "exa-b").credentialRef, ref, "mutate 后该条目 credentialRef === 本次 set 的 newRef");
    // 明文一处出现即红：mutate ops、其余请求体、渲染树（保存成功后零豁免）、console 桩。
    for (const c of fetchStub.calls) {
      if (c.kind === "credentials/set") continue;
      assert.ok(!JSON.stringify(c.body ?? null).includes(SYNTH_KEY), `明文 key 不得出现在 ${c.kind} 请求体`);
    }
    assert.deepEqual(secretPathsIn(opsOf(muts[0])), [], "mutate ops 不得含秘密键名（P0）");
    assert.deepEqual(leaksIn(t, SYNTH_KEY), [], "保存成功后渲染树不得残留明文（P0）");
    assert.ok(!consoleStub.text().includes(SYNTH_KEY), "console 输出不得含明文（P0）");
  });
});

test("P0 凭据 D-2C 替换：已有引用的条目带新 key 保存 → 写入新 ref；旧引用与其宿主凭据保留（无 unset）", async () => {
  const state = makeSettingsState({
    credentials: { TAVILY_KEY_A: { configured: true, writable: true, masked: "sk-****A1B2" } },
  });
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("keyed-replace");
    const t = await editEntry(view, tree, "tavily-a", { key: SYNTH_KEY });
    await step(view, t, ROLE.editorSubmit); // O-8（#51）：SET-006
    const sets = fetchStub.credentialSets();
    assert.equal(sets.length, 1, "替换保存恰一次 credentials/set");
    assert.equal(fetchStub.credentialCalls().filter((c) => c.kind === "credentials/unset").length, 0, "替换不得 unset 旧引用（移除/替换均不删宿主凭据）");
    assert.ok(state.credentials.TAVILY_KEY_A, "旧引用 TAVILY_KEY_A 的宿主凭据仍在");
    const ref = refOfSet(sets[0]);
    assert.match(ref, REF_GRAMMAR, "新 ref 须匹配 POSIX grammar（R-1）");
    assert.match(ref, /^search_chain_credential_tavily_a_/i, "新 ref 形态含净化 entryId（tavily-a → tavily_a）");
    assert.notEqual(ref, "TAVILY_KEY_A", "新 ref 不得复用旧引用名");
    assert.equal(state.user.entries.find((e) => e.id === "tavily-a").credentialRef, ref, "条目指向新 ref");
  });
});

test("P0 凭据 D-2C ref 唯一（R-1）：同一条目连续两次带 key 保存，生成两个不同且合法的 ref（唯一后缀）", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub }) => {
    const first = await openPanel("ref-uniq-1");
    await step(first.view, await editEntry(first.view, first.tree, "exa-b", { key: SYNTH_KEY }), ROLE.editorSubmit); // O-8（#51）：SET-006
    const second = await openPanel("ref-uniq-2");
    await step(second.view, await editEntry(second.view, second.tree, "exa-b", { key: SYNTH_KEY }), ROLE.editorSubmit); // O-8（#51）：SET-006
    const refs = fetchStub.credentialSets().map(refOfSet);
    assert.equal(refs.length, 2, "两次带 key 保存应各有一次 credentials/set");
    assert.notEqual(refs[0], refs[1], "每次带 key 保存须生成新 ref，不覆写既有 ref");
    for (const r of refs) assert.match(r, REF_GRAMMAR, "每个新 ref 均须匹配 POSIX grammar（R-1）");
  });
});

test("P0 凭据 D-2C 写入被拒（credential-rejected）：零 mutate，草稿保留，错误可见且含 provider message", async () => {
  await withEnv(makeSettingsState({ credentialMode: "rejected" }), async ({ fetchStub }) => {
    const { view, tree } = await openPanel("keyed-rejected");
    let t = await editEntry(view, tree, "exa-b", { name: "Exa 草稿", key: SYNTH_KEY });
    t = await step(view, t, ROLE.editorSubmit); // O-8（#51）：SET-006 条目级提交
    assert.equal(fetchStub.mutates().length, 0, "凭据写入被拒时不得发 settings/mutate");
    const err = byRole(t, ROLE.saveError);
    assert.equal(err.length, 1, "保存错误须可见（恰一个 save-error）");
    assert.match(textOf(err[0]), /synthetic provider rejection/, "错误须携带 provider message");
    assert.equal(one(t, ROLE.field, { field: "name" }).props.value, "Exa 草稿", "草稿（名称）保留");
    assert.equal(one(t, ROLE.field, { field: "key" }).props.value, SYNTH_KEY, "草稿（key）保留，仅限 key 输入框 value");
    assert.deepEqual(leaksIn(t, SYNTH_KEY, { allowDraftInput: true }), [], "错误态渲染树除草稿 value 外不得含明文");
  });
});

test("P0 凭据 D-2C 网络失败：credentials/set 抛网络错误 → 零 mutate，草稿保留，错误可见", async () => {
  await withEnv(makeSettingsState({ credentialMode: "network" }), async ({ fetchStub }) => {
    const { view, tree } = await openPanel("keyed-network");
    let t = await editEntry(view, tree, "exa-b", { name: "Exa 草稿", key: SYNTH_KEY });
    t = await step(view, t, ROLE.editorSubmit); // O-8（#51）：SET-006 条目级提交
    assert.equal(fetchStub.mutates().length, 0, "网络失败时不得发 settings/mutate");
    assert.equal(byRole(t, ROLE.saveError).length, 1, "网络失败须有可见错误");
    assert.equal(one(t, ROLE.field, { field: "name" }).props.value, "Exa 草稿", "草稿保留");
    assert.deepEqual(leaksIn(t, SYNTH_KEY, { allowDraftInput: true }), [], "错误态渲染树除草稿 value 外不得含明文");
  });
});

test("P0 凭据 D-2C 空 key 保存：零 credentials/set，既有 credentialRef 原样保留（不重置）", async () => {
  const state = makeSettingsState({
    credentials: { TAVILY_KEY_A: { configured: true, writable: true, masked: "sk-****A1B2" } },
  });
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("keyed-blank");
    const t = await editEntry(view, tree, "tavily-a", { name: "Tavily 改名", key: "" });
    await step(view, t, ROLE.editorSubmit); // O-8（#51）：SET-006
    assert.equal(fetchStub.credentialCalls().filter((c) => c.kind === "credentials/set").length, 0, "空 key 不得 credentials/set");
    assert.equal(fetchStub.mutates().length, 1, "改名仍须保存");
    const ent = state.user.entries.find((e) => e.id === "tavily-a");
    assert.equal(ent.credentialRef, "TAVILY_KEY_A", "空 key 保存不得重置既有 credentialRef");
    assert.equal(ent.name, "Tavily 改名", "改名生效");
  });
});

test("P0 凭据 D-2C 只写回填：保存后重开编辑器，key 输入为空，不回显旧值", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("keyed-reopen");
    let t = await editEntry(view, tree, "exa-b", { key: SYNTH_KEY });
    t = await step(view, t, ROLE.editorSubmit); // O-8（#51）：SET-006 条目级提交
    if (byRole(t, ROLE.field, { field: "key" }).length === 0) {
      t = await step(view, t, ROLE.edit, { entryId: "exa-b" });
    }
    const keyInput = one(t, ROLE.field, { field: "key" });
    assert.ok(!keyInput.props.value, "重开后 key 输入框回填须为空（只写，绝不回显）");
    assert.deepEqual(leaksIn(t, SYNTH_KEY), [], "重开后渲染树不得含明文");
  });
});

test("P0 凭据 D-2C 只写回填（掩码）：已有引用的条目打开编辑器，key 输入为空，掩码预览不进入输入框 value", async () => {
  const state = makeSettingsState({
    credentials: { TAVILY_KEY_A: { configured: true, writable: true, masked: "sk-****A1B2" } },
  });
  await withEnv(state, async () => {
    const { view, tree } = await openPanel("keyed-mask");
    const t = await step(view, tree, ROLE.edit, { entryId: "tavily-a" });
    const keyInput = one(t, ROLE.field, { field: "key" });
    assert.ok(!keyInput.props.value, "key 输入框回填须为空（只写）");
    assert.ok(!String(keyInput.props.value ?? "").includes("A1B2"), "掩码预览不得进入 key 输入框 value");
  });
});

test("SET-004 零出站（D-2C 保存链）：带 key 保存仅产生同源 /api/ 的 settings 与 credentials 调用；其余为零；host.call 为零", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub, hostStub }) => {
    const { view, tree } = await openPanel("keyed-zero-out");
    const t = await editEntry(view, tree, "exa-b", { key: SYNTH_KEY });
    await step(view, t, ROLE.editorSubmit); // O-8（#51）：SET-006
    assert.deepEqual(fetchStub.outbound, [], `保存链不得出站：${JSON.stringify(fetchStub.outbound)}`);
    const allowed = new Set(["settings/describe", "settings/mutate", "credentials/describe", "credentials/set", "credentials/unset"]);
    for (const c of fetchStub.calls) {
      assert.ok(allowed.has(c.kind) && isSameOriginApi(c.url), `允许端点集合外的请求（D-2C）：${c.url} ${c.kind}`);
    }
    assert.equal(hostStub.calls.length, 0, "保存链不得调用 host.call");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// R-2（codex P2 增补）：在途编辑、base 继承保真、旧冒号 ref 迁移
// ────────────────────────────────────────────────────────────────────────────────────────

const BASE_OA = Object.freeze({
  id: "base-oa",
  type: "openai",
  name: "OpenAI 基础",
  enabled: true,
  model: "gpt-4o",
  proxy: "http://127.0.0.1:8080",
});

/**
 * base 层带一条 openai（含非表单字段），user 层不含 entries 键（P2-1 夹具）。
 * 注：client 投影为 {...base, ...user}（src/client-entry.js L465），user 若带 entries 数组会整体遮住 base 的 entries，
 * 故「user 为空」取不带 entries 键的形态。
 */
function baseFixtureState() {
  return makeSettingsState({
    base: { entries: [clone(BASE_OA)] },
    user: { useOfficialDeepSeekSearch: true, timeoutMs: 25000 },
  });
}

test("R-2 P2-1 base 继承保真：base 层含非表单字段的 openai 条目，不做修改直接保存 → 若产出 ops，应用到 user 后 model/proxy 仍在且值不变；条目顺序与数量不变", async () => {
  const state = baseFixtureState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("base-noop");
    assert.deepEqual(cardOrder(tree), ["base-oa"], "前置：base 层条目须出现在卡片列表（SET-001）");
    // O-8（#51）：SET-006——无改动的保存 = 打开该条目编辑器原样提交（base-only 条目将被实体化进 user 层）。
    await step(view, await step(view, tree, ROLE.edit, { entryId: "base-oa" }), ROLE.editorSubmit);
    const muts = fetchStub.mutates();
    if (muts.length === 0 || opsOf(muts[0]).length === 0) return; // 无改动：base 原样保留
    const after = state.user.entries ?? [];
    assert.deepEqual(after.map((e) => e.id), ["base-oa"], "条目顺序与数量不得改变（P2-1）");
    const kept = after[0] ?? {};
    assert.equal(kept.model, BASE_OA.model, "未知字段 model 保存后须仍在且值不变（P2-1）");
    assert.equal(kept.proxy, BASE_OA.proxy, "未知字段 proxy 保存后须仍在且值不变（P2-1）");
  });
});

test("R-2 P2-1 base 继承保真·改名变体：改名 base-oa 后保存，model/proxy 仍保留，条目数量与顺序不变", async () => {
  const state = baseFixtureState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("base-rename");
    const t = await setName(view, tree, "base-oa", "OpenAI 改名");
    await step(view, t, ROLE.editorSubmit); // O-8（#51）：SET-006
    assert.equal(fetchStub.mutates().length, 1, "改名后保存恰一次 mutate");
    const after = state.user.entries ?? [];
    assert.deepEqual(after.map((e) => e.id), ["base-oa"], "条目顺序与数量不得改变（P2-1）");
    assert.equal(after[0].name, "OpenAI 改名", "改名须落入 user 层");
    assert.equal(after[0].model, BASE_OA.model, "改名后未知字段 model 仍在且值不变（P2-1）");
    assert.equal(after[0].proxy, BASE_OA.proxy, "改名后未知字段 proxy 仍在且值不变（P2-1）");
  });
});

/** R-2 P2-2：在途期间须 disabled 的控件（名称/key 输入框按 data-field 区分）。O-8（#51）：SET-006 后为编辑器提交/取消钮。 */
const LOCKED_ROLES = [ROLE.editorSubmit, ROLE.editorCancel, ROLE.enabled, ROLE.edit, ROLE.add, ROLE.officialToggle];
function lockedNodes(tree) {
  return allNodes(tree).filter((n) => {
    const p = n.props ?? {};
    if (p["data-role"] === ROLE.field) return p["data-field"] === "name" || p["data-field"] === "key";
    return LOCKED_ROLES.includes(p["data-role"]);
  });
}

test("R-2 P2-2 在途编辑：mutate 挂起期间保存、条目控件与名称/key 输入框 disabled=true；释放响应后恢复可编辑", async () => {
  await withEnv(makeSettingsState({ deferMutate: true }), async ({ fetchStub }) => {
    const { view, tree } = await openPanel("inflight");
    let t = await editEntry(view, tree, "exa-b", { name: "Exa 在途" });
    t = await step(view, t, ROLE.editorSubmit); // O-8（#51）：SET-006 条目级提交
    try {
      assert.equal(fetchStub.pendingMutates(), 1, "保存应有一次挂起中的 mutate（deferred）");
      assert.equal(one(t, ROLE.editorSubmit).props.disabled, true, "在途期间提交按钮须 disabled=true（P2-2）");
      const pre = lockedNodes(t);
      for (const role of LOCKED_ROLES.filter((r) => r !== ROLE.editorSubmit)) {
        assert.ok(byRole(t, role).length > 0, `在途期间须存在控件 ${role}`);
      }
      assert.ok(pre.length >= 6, `在途期间须可见名称与 key 输入框（实得 ${pre.length} 个受控节点）`);
      for (const n of pre) {
        const tag = n.props["data-field"] ? `${n.props["data-role"]}/${n.props["data-field"]}` : n.props["data-role"];
        assert.equal(n.props.disabled, true, `在途期间 ${tag} 须 disabled=true（P2-2）`);
      }
    } finally {
      fetchStub.releaseMutate();
    }
    t = await settle(view);
    assert.equal(fetchStub.mutates().length, 1, "释放后恰一次 mutate");
    const stillLocked = lockedNodes(t).filter((n) => n.props.disabled === true);
    assert.equal(stillLocked.length, 0, `响应完成后不得仍有 disabled：${stillLocked.map((n) => n.props["data-role"]).join(",")}（P2-2）`);
  });
});

test("R-2 P2-3 旧冒号 ref + 新 key 保存放行：恰一次 credentials/set（合法新 ref、含净化 entryId）先于一次 mutate；条目终态 credentialRef=新 ref；旧冒号 ref 不出现在任何请求体", async () => {
  const LEGACY = "search-chain-credential:exa-b:1";
  const entries = fixtureEntries();
  entries[1].credentialRef = LEGACY;
  const state = makeSettingsState({ user: { entries, useOfficialDeepSeekSearch: true, timeoutMs: 25000 } });
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("legacy-keyed");
    await step(view, await editEntry(view, tree, "exa-b", { key: SYNTH_KEY }), ROLE.editorSubmit); // O-8（#51）：SET-006
    const sets = fetchStub.credentialSets();
    assert.equal(sets.length, 1, "带新 key 保存恰一次 credentials/set（P2-3）");
    const newRef = refOfSet(sets[0]);
    assert.ok(newRef, "credentials/set 请求体须含 SEARCH_CHAIN_CREDENTIAL_ 前缀的新 ref");
    assert.match(newRef, REF_GRAMMAR, "新 ref 须匹配 POSIX grammar（R-1）");
    assert.match(newRef, /^search_chain_credential_exa_b_/i, "新 ref 含净化 entryId（exa-b → exa_b）");
    const muts = fetchStub.mutates();
    assert.equal(muts.length, 1, "credentials/set 成功后恰一次 settings/mutate（P2-3）");
    assert.ok(sets[0].seq < muts[0].seq, "credentials/set 须先于 settings/mutate");
    const entry = state.user.entries.find((e) => e.id === "exa-b");
    assert.equal(entry.credentialRef, newRef, "条目终态 credentialRef 须为新 ref（P2-3）");
    const wire = JSON.stringify(fetchStub.calls.map((c) => c.body ?? null));
    assert.ok(!wire.includes(LEGACY), "旧冒号 ref 不得出现在任何请求体（P2-3）");
  });
});

test("R-2 P2-3 旧冒号 ref 留空变体：条目原 credentialRef 为冒号形态且无新 key → 保存阻断：零 mutate、零 credentials 调用、零出站", async () => {
  const LEGACY = "search-chain-credential:exa-b:1";
  const entries = fixtureEntries();
  entries[1].credentialRef = LEGACY;
  const state = makeSettingsState({ user: { entries, useOfficialDeepSeekSearch: true, timeoutMs: 25000 } });
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("legacy-blocked");
    let t = await setName(view, tree, "exa-b", "Exa 改名");
    t = await step(view, t, ROLE.editorSubmit); // O-8（#51）：SET-006 条目级提交
    const blocked = byRole(t, ROLE.saveError).length > 0 || one(t, ROLE.editorSubmit).props.disabled === true;
    assert.ok(blocked, "旧冒号 ref 且无新 key：保存须被阻断（可见错误或保存禁用）（P2-3）");
    assert.equal(fetchStub.mutates().length, 0, "阻断时零 settings/mutate（P2-3）");
    assert.equal(fetchStub.credentialCalls().length, 0, "阻断时零 credentials 调用（P2-3）");
    assert.deepEqual(fetchStub.outbound, [], "阻断时零出站（P2-3）");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 第 6 组 · SET-005 DeepSeek 官方搜索开关
// ────────────────────────────────────────────────────────────────────────────────────────

test("SET-005 缺省开启：宿主快照未设开关时，顶端开关显示为开启", async () => {
  const state = makeSettingsState({ user: { entries: fixtureEntries(), timeoutMs: 25000 } });
  await withEnv(state, async () => {
    const { tree } = await openPanel("official-default");
    assert.equal(one(tree, ROLE.officialToggle).props.checked, true, "未设开关须显示为开启");
  });
});

test("SET-005 提示文案：开关旁提示覆盖会话范围、关闭后用工具链、不另按次收费、按 token 计费（关键词）", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { tree } = await openPanel("official-hint");
    const hint = textOf(one(tree, ROLE.officialHint));
    for (const re of OFFICIAL_HINT_KEYWORDS) {
      assert.match(hint, re, `SET-005 提示须含 ${re}`);
    }
  });
});

test("SET-005 持久化：关闭开关并保存后，ops 含 useOfficialDeepSeekSearch=false；重开仍为关闭；自定义条目保持不变", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const before = fixtureEntries();
    const { view, tree } = await openPanel("official-save");
    // O-8（#51）：SET-006——顶部官方开关 onChange 即离散落盘（无全局保存步），mutate[0] 已含该键。
    await act(view, () =>
      fire(one(tree, ROLE.officialToggle), "onChange", { target: { checked: false, value: false } }),
    );
    const ops = opsOf(fetchStub.mutates()[0]);
    assert.ok(
      ops.some((o) => o.op === "set" && o.path.join(".") === "useOfficialDeepSeekSearch" && o.value === false),
      `ops 须含 set useOfficialDeepSeekSearch=false：${JSON.stringify(ops)}`,
    );
    assert.equal(state.user.useOfficialDeepSeekSearch, false, "宿主快照须持久化为 false");
    assert.deepEqual(stateEntries(state), before, "切换开关不得改动自定义条目的配置与位置");
    const reopened = await openPanel("official-reopen");
    assert.equal(one(reopened.tree, ROLE.officialToggle).props.checked, false, "重开后开关仍为关闭");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 第 7 组 · SET-006（#51 追加）条目级保存与离散落盘新增面（O-8）
// ────────────────────────────────────────────────────────────────────────────────────────

test("SET-006(#51) 超时离散落盘：变化且合法 blur 即时提交（ops 仅 timeoutMs 键）；非法值不写并给可操作错误；成功反馈在节级顶部槽位", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("timeout-commit");
    // 非法值（0）：blur → 不写 + 节级可见错误
    let t = await act(view, () => fire(one(tree, ROLE.field, { field: "timeoutMs" }), "onChange", { target: { value: "0" } }));
    t = await act(view, () => fire(one(t, ROLE.field, { field: "timeoutMs" }), "onBlur"));
    assert.equal(fetchStub.mutates().length, 0, "非法超时（0）不得写");
    assert.ok(byRole(t, ROLE.saveError).length > 0, "非法超时须有可见错误");
    assert.match(textOf(one(t, ROLE.saveError)), /正整数/, "错误须可操作（提示正整数毫秒）");
    // 合法变化：blur → 恰一次 mutate，ops 仅含 timeoutMs 键
    t = await act(view, () => fire(one(t, ROLE.field, { field: "timeoutMs" }), "onChange", { target: { value: "7777" } }));
    t = await act(view, () => fire(one(t, ROLE.field, { field: "timeoutMs" }), "onBlur"));
    assert.equal(fetchStub.mutates().length, 1, "合法超时变化须恰一次 mutate");
    assert.deepEqual(opsOf(fetchStub.mutates()[0]), [{ op: "set", path: ["timeoutMs"], value: 7777 }], "ops 须仅含 timeoutMs 键");
    assert.equal(state.user.timeoutMs, 7777, "宿主快照超时已更新");
    assert.equal(byRole(t, ROLE.saveStatus).length, 1, "成功反馈恰一个（节级顶部槽位）");
    assert.equal(one(t, ROLE.saveStatus).props["data-state"], "saved", "成功节点 data-state=saved");
    assert.match(textOf(one(t, ROLE.saveStatus)), /已保存设置/, "成功文案为「已保存设置。」");
  });
});

test("SET-006(#51) 取消/Esc（O-5）：零写、清该条目字段草稿与 key 缓冲、关编辑器（新建条目移出列表）；Escape 与取消等价", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub }) => {
    const { view, tree } = await openPanel("cancel-edit");
    // 编辑条目：改名 + 改引用 → 取消 → 字段草稿还原为已持久化值，零写
    let t = await editEntry(view, tree, "exa-b", { name: "Exa 废弃", ref: "SHOULD_BE_DISCARDED" });
    t = await step(view, t, ROLE.editorCancel);
    assert.equal(fetchStub.mutates().length, 0, "取消不得写");
    assert.equal(byRole(t, ROLE.editor).length, 0, "取消后编辑器关闭");
    t = await step(view, t, ROLE.edit, { entryId: "exa-b" });
    assert.equal(one(t, ROLE.field, { field: "name" }).props.value, "Exa 备用", "取消后字段草稿须清空（还原已持久化值）");
    assert.equal(one(t, ROLE.field, { field: "credentialRef" }).props.value, "", "exa-b 无持久化引用：取消后不得残留草稿引用");
    // 新建条目：填名 + key 后 Esc → 新条目移出列表，key 缓冲清零
    t = await addType(view, t, "brave");
    assert.equal(cardOrder(t).length, 4, "选类型后新条目出现在列表末尾");
    t = await act(view, () => fire(one(t, ROLE.field, { field: "name" }), "onChange", { target: { value: "Brave 草稿" } }));
    t = await act(view, () => fire(one(t, ROLE.field, { field: "key" }), "onChange", { target: { value: SYNTH_KEY } }));
    t = await act(view, () => fire(one(t, ROLE.editor), "onKeyDown", { key: "Escape", preventDefault() {} }));
    assert.equal(fetchStub.mutates().length, 0, "Escape 不得写（O-5）");
    assert.equal(byRole(t, ROLE.editor).length, 0, "Escape 后编辑器关闭");
    assert.equal(cardOrder(t).length, 3, "取消后新建条目须移出草稿列表");
    assert.deepEqual(leaksIn(t, SYNTH_KEY), [], "取消后明文 key 缓冲须清零（零残留明文）");
  });
});

test("SET-006(#51) 取消钮可用矩阵：校验失败 / 上次提交错误 / 缺 revision 均可点；仅提交在途时禁用", async () => {
  // (a) 校验失败
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("cancel-validation");
    const t = await editEntry(view, tree, "exa-b", { ref: "bad:ref" });
    assert.ok(byRole(t, ROLE.saveError).length > 0, "校验失败须有可见错误");
    assert.equal(one(t, ROLE.editorSubmit).props.disabled, true, "校验失败：提交钮须禁用");
    assert.equal(one(t, ROLE.editorCancel).props.disabled, false, "校验失败：取消须可点");
  });
  // (b) 上次提交错误
  await withEnv(makeSettingsState({ mutateMode: "conflict" }), async () => {
    const { view, tree } = await openPanel("cancel-after-error");
    const t = await step(view, await setName(view, tree, "exa-b", "Exa 错后"), ROLE.editorSubmit);
    assert.ok(byRole(t, ROLE.saveError).length > 0, "提交错误须可见");
    assert.equal(one(t, ROLE.editorCancel).props.disabled, false, "上次提交错误：取消须可点");
  });
  // (c) 缺 revision（读即只读）
  await withEnv(makeSettingsState({ omitRevision: true }), async () => {
    const { view, tree } = await openPanel("cancel-no-rev");
    const t = await step(view, tree, ROLE.edit, { entryId: "exa-b" });
    assert.equal(one(t, ROLE.editorSubmit).props.disabled, true, "缺 revision：提交钮须禁用");
    assert.equal(one(t, ROLE.editorCancel).props.disabled, false, "缺 revision：取消须可点");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 第 8 组 · SET-008（#51）跨分区草稿保全：缓存纯逻辑（读/写/冲突判定）+ 会话内刷新免疫（O-8 允许新增）
// 说明：「卸载 → 重挂」（同模块实例二次初始 load）在本替身内不可达——组件 React 经 factory
// require 永久绑定首个 hook-React 实例，换外层 hook 渲染会破坏 hook 索引。故缓存读/写/冲突
// 判定按 lead 建议以纯函数面（Component.contract.draftCacheApply）单测；后台快照刷新免疫走
// 可达的真实组件路径（离散提交成功读回）。
// ────────────────────────────────────────────────────────────────────────────────────────

let pureSeq = 0;
/** 取内联纯函数面（不渲染、零 RPC；每次新模块实例，contract 为冻结纯函数对象）。 */
async function pureContract() {
  const view = await loadSection(`pure-${++pureSeq}`);
  return view.rec.Component.contract;
}
/** 草稿基形（draftFrom 输出同形）。 */
function baseDraft(entries, timeoutText = "25000") {
  return { entries, useOfficial: true, timeoutText };
}
/** 投影基形（revision 唯一被 draftCacheApply 读取的投影字段）。 */
function projOf(revision) {
  return { revision, base: {}, user: {} };
}

test("SET-008(#51) 纯逻辑·版本一致：回填字段/key/超时并给出自动重开 editingId，零冲突，不清记录", async () => {
  const C = await pureContract();
  const cache = new Map();
  const ent = { id: "exa-b", type: "exa", name: "Exa 备用", enabled: true, credentialRef: "SEARCH_CHAIN_CREDENTIAL_exa_b_old" };
  // 记录 fields 恒为编辑器当前值（syncEntryCache 语义）：未触碰 ref 时即投影值的副本。
  cache.set("exa-b", { mode: "edit", type: "exa", fields: { name: "Exa 草稿", credentialRef: "SEARCH_CHAIN_CREDENTIAL_exa_b_old" }, key: SYNTH_KEY, baseRevision: 3 });
  cache.set(C.draftCacheGlobalKey, { timeoutText: "7777", baseRevision: 3 });
  const out = C.draftCacheApply(cache, projOf(3), baseDraft([ent]));
  assert.equal(out.conflicts.length, 0, "版本一致零冲突");
  assert.equal(out.editingId, "exa-b", "自动重开在编条目");
  assert.equal(out.keys["exa-b"], SYNTH_KEY, "key 缓冲复原");
  const re = out.draft.entries.find((e) => e.id === "exa-b");
  assert.equal(re.name, "Exa 草稿", "名称回填");
  assert.equal(re.credentialRef, "SEARCH_CHAIN_CREDENTIAL_exa_b_old", "credentialRef 按草稿当前值回填");
  // 无 ref 条目（fixture exa-b 同形）：草稿空 ref 回填空，不臆造
  const noRef = { id: "bing-c", type: "bing", name: "Bing", enabled: true, credentialRef: undefined };
  const cacheNR = new Map();
  cacheNR.set("bing-c", { mode: "edit", type: "bing", fields: { name: "Bing 改", credentialRef: "" }, key: "", baseRevision: 3 });
  const outNR = C.draftCacheApply(cacheNR, projOf(3), baseDraft([noRef]));
  assert.equal(outNR.draft.entries.find((e) => e.id === "bing-c").credentialRef, "", "无 ref 条目保持空");
  assert.equal(out.draft.timeoutText, "7777", "超时草稿回填");
  assert.equal(out.draft.entries.length, 1, "条目数不变");
  assert.ok(cache.has("exa-b") && cache.has(C.draftCacheGlobalKey), "成功回填不清记录");
});

test("SET-008(#51) 纯逻辑·版本冲突：草稿仍回填（可再提交/取消）+ conflicts(kind=version)；新建记录撞现存 id 同按版本冲突且不入列", async () => {
  const C = await pureContract();
  const cache = new Map();
  const ent = { id: "exa-b", type: "exa", name: "Exa 备用", enabled: true, credentialRef: "r1" };
  cache.set("exa-b", { mode: "edit", type: "exa", fields: { name: "Exa 冲突", credentialRef: "" }, key: "", baseRevision: 3 });
  cache.set(C.draftCacheGlobalKey, { timeoutText: "999", baseRevision: 3 });
  const out = C.draftCacheApply(cache, projOf(4), baseDraft([ent]));
  assert.equal(out.conflicts.length, 2, "条目+全局各一条版本冲突");
  assert.ok(out.conflicts.every((c) => c.kind === "version"), "kind 均为 version");
  assert.equal(out.editingId, "exa-b", "冲突仍自动重开（草稿可见、可再提交或取消）");
  assert.equal(out.draft.entries.find((e) => e.id === "exa-b").name, "Exa 冲突", "冲突仍回填字段");
  assert.equal(out.draft.timeoutText, "999", "冲突仍回填超时");
  assert.ok(cache.has("exa-b"), "冲突不清记录（丢弃/重放由用户显式决定）");
  // 新建记录撞现存 id
  const cache2 = new Map();
  cache2.set("tavily-a", { mode: "create", type: "tavily", fields: { name: "新条目", credentialRef: "" }, key: "", baseRevision: 3 });
  const existing = { id: "tavily-a", type: "tavily", name: "Tavily 主用", enabled: true, credentialRef: "r2" };
  const out2 = C.draftCacheApply(cache2, projOf(4), baseDraft([existing]));
  assert.equal(out2.conflicts.length, 1, "撞 id 一条冲突");
  assert.equal(out2.conflicts[0].kind, "version");
  assert.equal(out2.draft.entries.length, 1, "撞 id 不重复入列");
  assert.equal(out2.editingId, null, "撞 id 不自动重开");
});

test("SET-008(#51) 纯逻辑·外部删除：conflicts(kind=deleted) 且记录自缓存移除（带因显式丢弃）；空缓存/无 revision 跳过校验", async () => {
  const C = await pureContract();
  const cache = new Map();
  cache.set("exa-b", { mode: "edit", type: "exa", fields: { name: "Exa 删除", credentialRef: "" }, key: "", baseRevision: 3 });
  const out = C.draftCacheApply(cache, projOf(4), baseDraft([]));
  assert.equal(out.conflicts.length, 1, "外部删除一条冲突");
  assert.equal(out.conflicts[0].kind, "deleted");
  assert.match(out.conflicts[0].text, /已被外部删除/, "删除提示说明条目已被外部删除");
  assert.equal(cache.size, 0, "被删记录已移出缓存");
  assert.equal(C.draftCacheApply(cache, projOf(4), baseDraft([])), null, "空缓存跳过校验");
  const cache2 = new Map();
  cache2.set("exa-b", { mode: "edit", type: "exa", fields: { name: "x", credentialRef: "" }, key: "", baseRevision: 3 });
  assert.equal(C.draftCacheApply(cache2, { base: {}, user: {} }, baseDraft([])), null, "投影无 revision 跳过校验（面板只读）");
});

test("SET-008(#51) 纯逻辑·新建复原：create 记录重新入列+自动重开+key 复原，版本一致零冲突", async () => {
  const C = await pureContract();
  const cache = new Map();
  cache.set("search_chain_tmp1", { mode: "create", type: "openai", fields: { name: "GPT 草稿", credentialRef: "" }, key: SYNTH_KEY, baseRevision: 3 });
  const out = C.draftCacheApply(cache, projOf(3), baseDraft([{ id: "exa-b", type: "exa", name: "x", enabled: true, credentialRef: "r" }]));
  assert.equal(out.conflicts.length, 0, "新建复原零冲突");
  assert.equal(out.editingId, "search_chain_tmp1", "新建草稿自动重开");
  const re = out.draft.entries.find((e) => e.id === "search_chain_tmp1");
  assert.ok(re, "新建条目重新入列");
  assert.equal(re.name, "GPT 草稿", "名称复原");
  assert.equal(re.enabled, true, "enabled 复原为 true");
  assert.equal(re.credentialRef, "", "credentialRef 复原为空");
  assert.equal(out.keys["search_chain_tmp1"], SYNTH_KEY, "新建条目 key 复原");
  assert.equal(out.draft.entries.length, 2, "入列后条目数 +1");
});

test("SET-008(#51) 后台快照刷新免疫：离散提交成功读回不清缓存、不覆盖在编字段与在编超时草稿、不关闭在编编辑器、不致假冲突", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("refresh-immune");
    let t = await editEntry(view, tree, "exa-b", { name: "Exa 在编" });
    t = await act(view, () => fire(one(t, ROLE.field, { field: "timeoutMs" }), "onChange", { target: { value: "7777" } }));
    // 离散提交（官方开关）→ 成功读回刷新（keepStatus=true 路径）
    t = await act(view, () => fire(one(t, ROLE.officialToggle), "onChange", { target: { checked: false, value: false } }));
    assert.equal(fetchStub.mutates().length, 1, "前置：离散提交产生一次 mutate");
    assert.equal(one(t, ROLE.field, { field: "name" }).props.value, "Exa 在编", "在编字段不得被刷新覆盖");
    assert.equal(one(t, ROLE.field, { field: "timeoutMs" }).props.value, "7777", "在编超时草稿不得被刷新覆盖");
    assert.equal(byRole(t, ROLE.editor).length, 1, "刷新不得关闭在编编辑器");
    assert.equal(byRole(t, ROLE.saveError).length, 0, "自身离散提交不得造成假版本冲突");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 辅助：bundle 页 contract（merge/toOps 内联纯函数，BCF-004）
// ────────────────────────────────────────────────────────────────────────────────────────

async function loadBundleContract(tag) {
  const regs = await importSelfRegister(tag);
  assert.equal(regs.length, 1, "自注册须恰 1 次");
  const { React } = (await import("./helpers/settings-panel-v02.js")).makeHookReact();
  const product = regs[0].factory((spec) => (spec === "react" ? React : undefined));
  const h = makeLiveCtx();
  product.apply(h.ctx);
  const rec = h.mountSlot(BUNDLE_SLOT);
  assert.ok(rec, `须经 ${BUNDLE_SLOT} 登记 bundle 配置区（BCF-001）`);
  const contract = rec.Component.contract;
  assert.ok(contract && typeof contract.merge === "function" && typeof contract.toOps === "function", "组件须挂 Component.contract = { merge, validate, toOps }");
  return contract;
}
