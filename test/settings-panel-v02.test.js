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

// #56（V5-2）步骤迁移：旧「点添加 → 点 picker 项」独立步骤已废止（src 移除 sc-picker 控件）。
// 新流程 = 点添加（新增表单原位打开，默认厂商为目录第一种）→ 表单内厂商下拉选厂商。
// 本助手是全部 14 个调用点的共同 add 步骤迁移点；各判据的行为断言（V3-1 无占位行、
// SET-006 条目级提交、D-2C key 规则等）原样保留，逐条见交付报告迁移清单。
async function addType(view, tree, type) {
  tree = await step(view, tree, ROLE.add);
  const select = allNodes(one(tree, ROLE.editor)).find((n) => n && n.type === "select");
  return act(view, () => fire(select, "onChange", { target: { value: type } }));
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
    // #56（V5-2）步骤迁移：类型列表由 picker 按钮组（ROLE.addType）迁为新增表单内的厂商下拉框
    // （sc-picker 步骤废止）。断言语义原样保留：选项值集合恰为 CAT-001 八种、每种恰一个选项。
    const editor = one(opened, ROLE.editor);
    const select = allNodes(editor).find((n) => n && n.type === "select");
    const options = select.children.map((o) => o.props.value);
    assert.deepEqual([...options].sort(), [...ALL_TYPES].sort(), "添加入口的类型选项须恰为 CAT-001 八种（providers.md）");
  });
});

test("SET-002 类型选项显示计费说明（关键词钉，见 settings-oracle BILLING_KEYWORDS）", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("billing");
    const opened = await step(view, tree, ROLE.add);
    // #56（V5-6）合法迁移：V5-6 厂商下拉选项改为纯厂商名，计费说明迁至下拉正下方的
    // .sc-billing-hint（data-role="billing-hint"）提示行，随选中厂商联动更新。
    // 默认厂商=openai 时显示 openai 提示；fire select onChange 切换至每个 keyed/bing 类型后断言对应关键词。
    const findHint = (t) => {
      const editor = one(t, ROLE.editor);
      const hint = allNodes(editor).find(
        (n) => n && typeof n.props?.className === "string" && n.props.className.split(/\s+/).includes("sc-billing-hint"),
      );
      assert.ok(hint, "新建表单须包含 .sc-billing-hint 计费提示行");
      assert.equal(hint.props["data-role"], "billing-hint", "计费提示行须带 data-role=\"billing-hint\"");
      return hint;
    };
    const defaultSelect = allNodes(one(opened, ROLE.editor)).find((n) => n && n.type === "select");
    assert.equal(defaultSelect.props.value, "openai", "默认厂商须为 openai");
    const defaultHintText = textOf(findHint(opened));
    assert.ok(defaultHintText.length > 0, "默认厂商 openai 须显示计费提示文字");
    for (const re of BILLING_KEYWORDS.openai ?? []) {
      assert.match(defaultHintText, re, `默认厂商 openai 的计费说明须含关键要素 ${re}`);
    }

    let cur = opened;
    const switchOrder = [...ALL_TYPES.filter((t) => t !== "openai"), "openai"];
    for (const type of switchOrder) {
      const select = allNodes(one(cur, ROLE.editor)).find((n) => n && n.type === "select");
      cur = await act(view, () => fire(select, "onChange", { target: { value: type } }));
      const text = textOf(findHint(cur));
      assert.ok(text.length > 0, `类型 ${type} 的 .sc-billing-hint 须显示说明文字`);
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
    // v3 用户反馈（V3-1 无占位行）：未提交新建不入列——列表恒等于持久视图（3 条），新条目只在编辑器。
    assert.equal(cardOrder(t).length, 3, "未提交新建不入列（V3-1）：列表恒等于持久视图");
    assert.ok(one(t, ROLE.editor), "新建编辑器须在场（幽灵仅存在于编辑器）");
    const newId = one(t, ROLE.field, { field: "name" }).props["data-entry-id"];
    assert.ok(!fixtureEntries().some((e) => e.id === newId), "新条目须有新的稳定 id（编辑器绑定）");
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
      // v3 用户反馈（V3-1）：新建编辑器开启后即呈现（幽灵不入列，无需再点卡片编辑钮）。
      assert.equal(byRole(added, ROLE.field, { field: "key" }).length, 1, `类型 ${type} 的编辑器须恰一个 key 输入框（D-2C）`);
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
    assert.equal(byRole(t, ROLE.saveStatus).length, 0, "V3-3 开关免提示：启用开关动作不得发 savedNotice（开关状态呈现即反馈）");
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
// V4 用户反馈（Issue #50）：编辑器就地展开（V4-1）+ 删除确认模态（V4-2）
// 迁移面（docs/specs/draft/settings-panel-v4-feedback.md §实现迁移面）：卡片归属/相邻/互斥/关闭、
// 模态文案+role、×/取消/Escape 三条零变更关闭路径、删除持久化。
// 像素级 token 与几何面（A-046/A-068/B-027…B-032）由 scripts/oracle-style-50.mjs 真机验收，此处只钉渲染树可观察面。
// ────────────────────────────────────────────────────────────────────────────────────────

/** 找到 target 节点在渲染树中的父节点（不存在返回 null）。 */
function parentNodeOf(tree, target) {
  let found = null;
  const visit = (n, parent) => {
    if (found !== null || n === null || n === undefined || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const c of n) visit(c, parent); return; }
    if (n === target) { found = parent; return; }
    visit(n.children, n);
  };
  visit(tree, null);
  return found;
}

/** 当前树上的 alertdialog（删除模态）节点。 */
function modalNode(tree) {
  const all = allNodes(tree);
  return all.find((n) => n.props && n.props.role === "alertdialog") ?? null;
}

/** 节点自身可见文本（仅 children 文本叶子；不含 aria-label 等 props——用于按钮文本精确匹配）。 */
function leafText(node) {
  const out = [];
  const visit = (n) => {
    if (n === null || n === undefined || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(visit); return; }
    visit(n.children);
  };
  visit(node);
  return out.join("");
}

/** 收集子树内全部按钮节点。 */
function buttonsUnder(node) {
  const acc = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === "button") acc.push(n);
    (n.children || []).forEach(walk);
  };
  walk(node);
  return acc;
}

test("V4-1 就地展开：编辑首条后编辑器是其归属卡片的直接子节点、条目行（.sc-card-row）的下一兄弟；卡序不变、列表尾部/卡片外无编辑器", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("v4-inline-open");
    const t = await step(view, tree, ROLE.edit, { entryId: "tavily-a" });
    assert.equal(byRole(t, ROLE.editor).length, 1, "编辑器恰一个");
    const ed = one(t, ROLE.editor);
    const card = one(t, ROLE.card, { entryId: "tavily-a" });
    assert.equal(parentNodeOf(t, ed), card, "编辑器须是归属卡片的直接子节点");
    const kids = card.children.filter((c) => c !== null && c !== undefined);
    const rowIdx = kids.findIndex((c) => c.props && c.props.className === "sc-card-row");
    assert.equal(rowIdx, 0, "卡片首个子节点须为条目行 .sc-card-row");
    assert.equal(kids[rowIdx + 1], ed, "编辑器须紧随条目行（DOM nextElementSibling 语义）");
    assert.deepEqual(cardOrder(t), idsOf(fixtureEntries()), "展开不得改变卡片顺序");
    for (const e of byRole(t, ROLE.editor)) {
      const p = parentNodeOf(t, e);
      assert.ok(p && p.props && p.props["data-role"] === ROLE.card, "编辑器不得游离于卡片外/列表尾部");
    }
  });
});

test("V4-1 切换互斥：从首条切到第二条，唯一编辑器整体移入新卡片；旧卡片无编辑器残留、卡序不变", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("v4-inline-switch");
    let t = await step(view, tree, ROLE.edit, { entryId: "tavily-a" });
    assert.equal(parentNodeOf(t, one(t, ROLE.editor)).props["data-entry-id"], "tavily-a", "前置：编辑器在首条卡片");
    t = await step(view, t, ROLE.edit, { entryId: "exa-b" });
    assert.equal(byRole(t, ROLE.editor).length, 1, "切换后仍恰一个编辑器（不得复制/残留）");
    const ed = one(t, ROLE.editor);
    const card = one(t, ROLE.card, { entryId: "exa-b" });
    assert.equal(parentNodeOf(t, ed), card, "编辑器须移入新目标卡片（直接子节点）");
    const kids = card.children.filter((c) => c !== null && c !== undefined);
    const rowIdx = kids.findIndex((c) => c.props && c.props.className === "sc-card-row");
    assert.equal(kids[rowIdx + 1], ed, "移动后仍为条目行的下一兄弟");
    const oldCard = one(t, ROLE.card, { entryId: "tavily-a" });
    assert.equal(oldCard.children.filter((c) => c && c.props && c.props["data-role"] === ROLE.editor).length, 0, "旧卡片不得残留编辑器");
    assert.deepEqual(cardOrder(t), idsOf(fixtureEntries()), "切换编辑不得改变卡片顺序");
  });
});

test("V4-1 新建（幽灵）仍不入列：新建编辑器不属于任何卡片（列表尾部呈现），持久卡片零编辑器", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("v4-ghost-editor");
    const t = await addType(view, tree, "brave");
    assert.equal(byRole(t, ROLE.editor).length, 1, "新建编辑器在场");
    assert.equal(cardOrder(t).length, 3, "幽灵不入列（V3-1）");
    const p = parentNodeOf(t, one(t, ROLE.editor));
    assert.ok(!p || !p.props || p.props["data-role"] !== ROLE.card, "新建编辑器不得属于任何卡片");
    for (const card of byRole(t, ROLE.card)) {
      assert.equal(card.children.filter((c) => c && c.props && c.props["data-role"] === ROLE.editor).length, 0, "持久卡片不得含新建编辑器");
    }
  });
});

test("V4-2 模态契约：移除点击后呈 alertdialog（aria-modal、标题「删除 {名称}?」、正文逐字、右上 ×、取消 secondary、危险「删除 {名称}」带 confirm-remove 锚点）；旧内联文案废止", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { view, tree } = await openPanel("v4-modal-contract");
    const t = await step(view, tree, ROLE.remove, { entryId: "exa-b" });
    const dlg = modalNode(t);
    assert.ok(dlg, "须有 alertdialog");
    assert.equal(dlg.props["aria-modal"], "true", "aria-modal=true");
    const byId = (id) => dlg.children.find((c) => c && c.props && c.props.id === id);
    const titleId = dlg.props["aria-labelledby"], descId = dlg.props["aria-describedby"];
    assert.ok(titleId && descId, "须有 aria-labelledby/aria-describedby");
    assert.equal(textOf(byId(titleId)), "删除 Exa 备用?", "标题须逐字「删除 {名称}?」");
    assert.equal(
      textOf(byId(descId)),
      "删除 Exa 备用 会移除其配置；其使用的凭证（如有）由其他位置管理，将会保留。",
      "正文须逐字（含凭证保留声明）",
    );
    const allBtns = buttonsUnder(dlg);
    const close = allBtns.find((b) => leafText(b) === "×");
    const cancel = allBtns.find((b) => leafText(b) === "取消");
    const danger = allBtns.find((b) => b.props["data-role"] === ROLE.confirmRemove);
    assert.ok(close, "须有右上 ×（文本恰为 ×）");
    assert.ok(cancel && /secondary/i.test(cancel.props.className || ""), "取消须为 secondary 变体");
    assert.ok(danger, "须有 confirm-remove 危险钮");
    assert.equal(leafText(danger), "删除 Exa 备用", "危险钮文本须逐字「删除 {名称}」");
    assert.ok(/danger/i.test(danger.props.className || ""), "危险钮须带 danger 类");
    assert.equal(danger.props["data-entry-id"], "exa-b", "危险钮须携带目标条目 id");
    const flatText = textOf(dlg);
    assert.ok(!flatText.includes("移除该搜索工具"), "旧内联确认文案不得残留");
    assert.ok(!flatText.includes("确认移除"), "旧「确认移除」按钮文案不得残留");
    void byId;
  });
});

test("V4-2 关闭零变更（×）：× 关闭模态后卡片完整、零 mutate", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v4-close-x");
    let t = await step(view, tree, ROLE.remove, { entryId: "exa-b" });
    const dlg = modalNode(t);
    const close = buttonsUnder(dlg).find((b) => leafText(b) === "×");
    assert.ok(close, "模态须有 × 按钮");
    t = await act(view, () => fire(close, "onClick"));
    assert.equal(modalNode(t), null, "× 须关闭模态");
    assert.deepEqual(cardOrder(t), idsOf(fixtureEntries()), "× 关闭不得删除任何条目");
    assert.equal(fetchStub.mutates().length, 0, "× 关闭不得产生 settings/mutate");
  });
});

test("V4-2 关闭零变更（取消）：取消关闭模态后卡片完整、零 mutate", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v4-close-cancel");
    let t = await step(view, tree, ROLE.remove, { entryId: "exa-b" });
    const dlg = modalNode(t);
    const cancel = buttonsUnder(dlg).find((b) => leafText(b) === "取消");
    assert.ok(cancel, "模态须有取消按钮");
    t = await act(view, () => fire(cancel, "onClick"));
    assert.equal(modalNode(t), null, "取消须关闭模态");
    assert.deepEqual(cardOrder(t), idsOf(fixtureEntries()), "取消不得删除任何条目");
    assert.equal(fetchStub.mutates().length, 0, "取消不得产生 settings/mutate");
  });
});

test("V4-2 关闭零变更（Escape）：弹窗键位 Escape 关闭模态后卡片完整、零 mutate", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v4-close-escape");
    let t = await step(view, tree, ROLE.remove, { entryId: "exa-b" });
    const dlg = modalNode(t);
    t = await act(view, () => fire(dlg, "onKeyDown", { key: "Escape", preventDefault() {} }));
    assert.equal(modalNode(t), null, "Escape 须关闭模态");
    assert.deepEqual(cardOrder(t), idsOf(fixtureEntries()), "Escape 关闭不得删除任何条目");
    assert.equal(fetchStub.mutates().length, 0, "Escape 关闭不得产生 settings/mutate");
  });
});

test("V4-2 危险确认删除持久化：模态危险钮确认 → 恰一次 mutate（仅该条目 unset 语义）、目标消失且其余完整、savedNotice「已保存设置。」", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v4-confirm-delete");
    let t = await step(view, tree, ROLE.remove, { entryId: "exa-b" });
    const dlg = modalNode(t);
    const n0 = fetchStub.mutates().length;
    t = await step(view, t, ROLE.confirmRemove, { entryId: "exa-b" });
    assert.equal(fetchStub.mutates().length, n0 + 1, "确认删除须产生恰一次 settings/mutate");
    const ops = opsOf(fetchStub.mutates().at(-1));
    assert.ok(ops.length >= 1 && ops.every((op) => /entries/.test(JSON.stringify(op.path))), "删除载荷须指向条目键（entries 路径）");
    assert.deepEqual(idsOf(stateEntries(state)), ["tavily-a", "bing-c"], "目标条目须移除、其余保留（即时持久）");
    assert.equal(modalNode(t), null, "确认后模态须关闭");
    assert.match(textOf(one(t, ROLE.saveStatus)), /^已保存设置。$/, "离散删除 savedNotice 须为「已保存设置。」（SET-007）");
  });
});

test("V4-2 Escape 让位：编辑器在编且模态开启时，编辑器侧 Escape 不得取消编辑器（顶层模态优先）；零 mutate", async () => {
  await withEnv(makeSettingsState(), async ({ fetchStub }) => {
    const { view, tree } = await openPanel("v4-escape-priority");
    let t = await step(view, tree, ROLE.edit, { entryId: "tavily-a" });
    t = await act(view, () => fire(one(t, ROLE.field, { field: "name" }), "onChange", { target: { value: "Tavily 草稿", checked: "Tavily 草稿" } }));
    t = await step(view, t, ROLE.remove, { entryId: "exa-b" });
    assert.ok(modalNode(t), "前置：模态已开启");
    t = await act(view, () => fire(one(t, ROLE.editor), "onKeyDown", { key: "Escape", preventDefault() {} }));
    assert.equal(byRole(t, ROLE.editor).length, 1, "模态开启时编辑器侧 Escape 不得取消编辑器（焦点/键盘优先权归顶层模态）");
    assert.equal(one(t, ROLE.field, { field: "name" }).props.value, "Tavily 草稿", "在编字段草稿不得被误清");
    assert.equal(fetchStub.mutates().length, 0, "全程零 mutate");
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
    // v3 用户反馈（V3-1）：幽灵不入列——key 直接写入已开启的新建编辑器（编辑器绑定该新条目）。
    let t = await act(view, () => fire(one(added, ROLE.field, { field: "key" }), "onChange", { target: { value: SYNTH_KEY } }));
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
    const afterToggle = await act(view, () =>
      fire(one(tree, ROLE.officialToggle), "onChange", { target: { checked: false, value: false } }),
    );
    assert.equal(byRole(afterToggle, ROLE.saveStatus).length, 0, "V3-3 开关免提示：官方开关动作不得发 savedNotice（开关状态呈现即反馈）");
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
    assert.equal(cardOrder(t).length, 3, "选类型后未提交新建不入列（V3-1）：列表仍为持久 3 条");
    t = await act(view, () => fire(one(t, ROLE.field, { field: "name" }), "onChange", { target: { value: "Brave 草稿" } }));
    t = await act(view, () => fire(one(t, ROLE.field, { field: "key" }), "onChange", { target: { value: SYNTH_KEY } }));
    t = await act(view, () => fire(one(t, ROLE.editor), "onKeyDown", { key: "Escape", preventDefault() {} }));
    assert.equal(fetchStub.mutates().length, 0, "Escape 不得写（O-5）");
    assert.equal(byRole(t, ROLE.editor).length, 0, "Escape 后编辑器关闭");
    assert.equal(cardOrder(t).length, 3, "取消后列表不变（V3-1：新建本就不入列；幽灵随取消移出草稿）");
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
// 第 9 组 · 二轮修复（round-2，lead 三缺陷裁定）：stale 快照竞态族
//   根因（同一族）：各提交路径以渲染闭包 model 构造 ops/expectedRevision；上一提交成功后的读回
//   （load）未落定时闭包陈旧 → LWW 覆盖他条目 / 重排静默丢弃 / 删除落错下标（世界分叉）。
//   修复 = 单写者提交管线（commitChain）+ 权威快照（latestRef，读回同 tick 写入）+ FIFO 读回链
//   （readChain）+ 编辑器绑定守卫（singleEntryDiff 拒发）+ 超时输入实时 DOM 读值。
// ────────────────────────────────────────────────────────────────────────────────────────

test("二轮(B-007/009) 单写者提交：两次离散提交背靠背交错，各自从最新持久快照起算，expectedRevision 单调递增", async () => {
  const state = makeSettingsState(); // revision 3；exa-b enabled；official true
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("cw-interleave");
    const n0 = fetchStub.describes().length;
    // 同一 act 内背靠背触发两个离散提交（中间无 await/无沉降）：exa-b 停用 + 官方开关关闭。
    // 旧实现：两者共用同一渲染闭包（user/revision）为底 → 第二提交的 expectedRevision 陈旧、
    // ops 以未含第一提交结果的旧列表起算（真实宿主 LWW → 互相覆盖；验收器 run-2/3 非确定性即此）。
    await act(view, () => {
      fire(one(tree, ROLE.enabled, { entryId: "exa-b" }), "onChange", { target: { checked: false } });
      fire(one(tree, ROLE.officialToggle), "onChange", { target: { checked: false, value: false } });
    });
    const ms = fetchStub.mutates();
    assert.equal(ms.length, 2, "两个离散提交必须各落盘一次（不得丢写）");
    assert.deepEqual(ms.map((m) => m.body?.payload?.args?.expectedRevision), [3, 4],
      "expectedRevision 必须单调递增：第二提交从第一提交的读回快照起算（禁止复用同一陈旧快照做底板）");
    assert.deepEqual(opsOf(ms[0]), [{ op: "set", path: ["entries", "1", "enabled"], value: false }],
      "第一提交 payload 只含 exa-b 的 enabled 变更");
    assert.deepEqual(opsOf(ms[1]), [{ op: "set", path: ["useOfficialDeepSeekSearch"], value: false }],
      "第二提交 payload 只含官方开关变更（不得把他人已持久化的状态当自己的差异）");
    assert.equal(state.user.entries[1].enabled, false, "exa-b 停用已持久化");
    assert.equal(state.user.useOfficialDeepSeekSearch, false, "官方开关关闭已持久化");
    assert.equal(state.revision, 5, "两次提交各推进一个 revision");
    assert.equal(fetchStub.describes().length, n0 + 2, "每次提交后恰一次读回（单写者读回串行）");
  });
});

test("二轮(B-007/009) 绑定守卫 singleEntryDiff 纯逻辑：候选只允许在绑定行变化；目标漂移/位置错位/他行被改即拒发", async () => {
  const C = await pureContract();
  const user = { entries: [
    { id: "e1", type: "exa", name: "A", enabled: true, credentialRef: "R1" },
    { id: "e2", type: "exa", name: "B", enabled: true, credentialRef: "" },
    { id: "e3", type: "bing", name: "C", enabled: false, credentialRef: "" },
  ] };
  const row = (id, over = {}) => ({ ...user.entries.find((e) => e.id === id), ...over });
  const tmp = { id: "tmp", type: "brave", name: "N", enabled: true, credentialRef: "" };
  // 通过面：
  assert.equal(C.singleEntryDiff(user, [row("e1"), row("e2", { name: "B2" }), row("e3")], "e2"), true, "编辑：仅绑定行单字段变化放行");
  assert.equal(C.singleEntryDiff(user, [row("e1"), row("e2", { name: "B2", credentialRef: "R2" }), row("e3")], "e2"), true, "编辑：绑定行 name+ref 同时变化放行");
  assert.equal(C.singleEntryDiff(user, [row("e1"), row("e2"), row("e3"), tmp], "tmp"), true, "新建：新条目在末尾放行");
  // 拒发面：
  assert.equal(C.singleEntryDiff(user, [row("e1"), row("e2", { name: "B2" }), row("e3")], "e1"), false, "拒发：候选被改的行不是绑定条目（提交目标≠编辑器绑定 id）");
  assert.equal(C.singleEntryDiff(user, [row("e2", { name: "B2" }), row("e1"), row("e3")], "e2"), false, "拒发：绑定行位置错位（排序不得混入条目提交）");
  assert.equal(C.singleEntryDiff(user, [row("e1"), row("e2", { name: "B2" }), row("e3", { name: "C2" })], "e2"), false, "拒发：其他行不得变化（陈旧 current 覆盖他条目的旧缺陷面）");
  assert.equal(C.singleEntryDiff(user, [row("e1"), row("e2"), row("e3"), tmp], "e2"), false, "拒发：多出无绑定新条目（幽灵条目）");
  assert.equal(C.singleEntryDiff(user, [row("e1"), tmp, row("e2"), row("e3")], "tmp"), false, "拒发：新建条目必须位于末尾");
  assert.equal(C.singleEntryDiff(user, [row("e2", { name: "B2" }), row("e1"), row("e2")], "e2"), false, "拒发：绑定条目必须在候选中恰出现一次");
  assert.equal(C.singleEntryDiff(user, [row("e1"), row("e3")], "e2"), false, "拒发：绑定条目缺失");
  // applyOpsToLayer：权威快照乐观更新 ≡ 宿主 reducer（测试侧独立实现 applyOps 对照）。
  const ops = [
    { op: "set", path: ["entries", "1", "enabled"], value: false },
    { op: "set", path: ["entries", "2", "name"], value: "C2" },
    { op: "unset", path: ["entries", "0"] },
  ];
  assert.deepEqual(C.applyOpsToLayer(user, ops), applyOps(user, ops), "applyOpsToLayer 与宿主 applyOps 同语义");
});

test("二轮(B-017) 同帧 blur 提交：onChange 后同帧 onBlur 取实时 DOM 值提交新值 5000（不得提交陈旧 25000）；非法值同帧：报错+不写+aria-invalid", async () => {
  const state = makeSettingsState(); // timeoutMs=25000
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("b017-sameframe");
    // (a) 合法值同帧：onChange(5000) 与 onBlur 之间无重渲染——闭包 state 仍是旧值，
    //     提交必须取输入框实时 DOM 值（旧实现读闭包 state：25000===25000「值未变化」静默不写）。
    await act(view, () => {
      const input = one(tree, ROLE.field, { field: "timeoutMs" });
      fire(input, "onChange", { target: { value: "5000" }, currentTarget: { value: "5000" } });
      fire(input, "onBlur", { currentTarget: { value: "5000" } });
    });
    const ms = fetchStub.mutates();
    assert.equal(ms.length, 1, "合法同帧 blur 必须恰提交一次");
    assert.deepEqual(opsOf(ms[0]), [{ op: "set", path: ["timeoutMs"], value: 5000 }], "提交值必须为实时 DOM 的 5000（不得是陈旧闭包 25000）");
    assert.equal(state.user.timeoutMs, 5000, "宿主快照已更新为 5000");
    assert.equal(fetchStub.describes().length, 2, "提交后读回一次（mount + 读回）");
    // (b) 非法值同帧：onChange(0) 与 onBlur(0) 同帧——旧实现非法分支永不可达（闭包值仍合法）。
    let t = await act(view, () => {
      const input = one(tree, ROLE.field, { field: "timeoutMs" });
      fire(input, "onChange", { target: { value: "0" }, currentTarget: { value: "0" } });
      fire(input, "onBlur", { currentTarget: { value: "0" } });
    });
    assert.equal(fetchStub.mutates().length, 1, "非法值不得写（不得产生第二次 mutate）");
    assert.equal(state.user.timeoutMs, 5000, "持久超时保持不变");
    assert.ok(byRole(t, ROLE.saveError).length > 0, "非法值必须出现节级错误（role=alert）");
    assert.match(textOf(one(t, ROLE.saveError)), /正整数/, "错误文案含「正整数」");
    assert.equal(one(t, ROLE.field, { field: "timeoutMs" }).props["aria-invalid"], true, "非法值输入框必须带 aria-invalid");
    // (c) 非法草稿不静默丢弃：随后合法值仍可提交（草稿链路未断）。
    t = await act(view, () => {
      const input = one(t, ROLE.field, { field: "timeoutMs" });
      fire(input, "onChange", { target: { value: "9000" }, currentTarget: { value: "9000" } });
      fire(input, "onBlur", { currentTarget: { value: "9000" } });
    });
    assert.equal(fetchStub.mutates().length, 2, "后续合法值恢复可提交");
    assert.equal(state.user.timeoutMs, 9000, "9000 已持久化");
    assert.equal(byRole(t, ROLE.saveError).length, 0, "合法提交后错误清除");
  });
});

test("二轮(B-012) 键盘重排×未提交新建草稿并存：重排 op 自最新持久列表起算照常落盘（不得因成员漂移静默丢弃）", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("b012-phantom-reorder");
    // 新建 brave（未提交）：草稿尾部多一条幽灵条目（持久层仍 3 条），编辑器打开。
    let t = await addType(view, tree, "brave");
    assert.equal(cardOrder(t).length, 3, "未提交新建不入列（V3-1）：列表恒等于持久视图");
    assert.ok(one(t, ROLE.editor), "新建编辑器须在场（幽灵仅存在于编辑器）");
    assert.equal(stateEntries(state).length, 3, "持久层仍 3 条（新建未提交）");
    const n0 = fetchStub.mutates().length;
    // 键盘上移 bing-c 两次（2 号位 → 0 号位）。旧实现：闭包 user/草稿成员漂移时 commitReorder
    // 静默返回 []（零 mutate——run-3 B-012 症状）；新实现：以最新持久列表为底，幽灵条目被过滤。
    t = await moveWithKey(view, t, "bing-c", "ArrowUp");
    t = await moveWithKey(view, t, "bing-c", "ArrowUp");
    const ms = fetchStub.mutates().slice(n0);
    assert.equal(ms.length, 2, "每次键盘移动必须各自产生一次 mutate（不得静默丢弃）");
    for (const m of ms) {
      const paths = opsOf(m).map((o) => o.path.join("."));
      assert.ok(paths.length > 0 && paths.every((p) => p.startsWith("entries.")), "重排 payload 只含 entries 族（B-021 同判据）");
    }
    assert.deepEqual(idsOf(stateEntries(state)), ["bing-c", "tavily-a", "exa-b"], "持久层顺序已重排且幽灵条目未入持久层");
    const byId = Object.fromEntries(stateEntries(state).map((e) => [e.id, e]));
    assert.equal(byId["bing-c"].name, "Bing 公开", "条目名恒随自身 id（B-007 名错乱回归面）");
    assert.equal(byId["tavily-a"].name, "Tavily 主", "tavily-a 名未受重排影响");
    assert.equal(byId["exa-b"].name, "Exa 备用", "exa-b 名未受重排影响");
    // v3 用户反馈（V3-1 无占位行）：世界分叉回归面改为「列表恒等于持久视图」——重排读回后页内视图
    // 恰为持久 3 条（未提交新建不入列）；幽灵仅存于编辑器（在编状态不得从页内视图丢失）。
    const order = cardOrder(t);
    assert.deepEqual(order, ["bing-c", "tavily-a", "exa-b"], "页内视图=持久投影 3 条（V3-1：未提交新建不入列，世界分叉回归面）");
    assert.equal(byRole(t, ROLE.editor).length, 1, "在编新建编辑器不得被重排读回关闭（在编状态不得从页内视图丢失）");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 第 10 组 · 三轮修复（round-3）：B-012 键盘重排焦点断链
//   症状（run-5 探针实锤）：初始聚焦=drag-handle；第一次 ArrowUp 生效（mutate 载荷正确）；
//   首次按键后 activeElement=空——重排渲染把卡片 DOM 节点物理挪位（浏览器规范 blur 原聚焦元素），
//   且提交在途 busy→把手 disabled 二次 blur、解锁后浏览器不自动回焦 → 第二下 ArrowUp 落空。
//   修复：回焦意图（model.pendingHandleFocus）+ 把手 ref 登记（handleRefs）+ 渲染提交后 effect 回焦：
//   首焦不消费（锁定周期必然到来）→ 经历锁定渲染 → 解锁后焦点仍在「空位」则回焦并消费；
//   用户期间移走焦点则只消费不抢焦。contract 纯函数 reorderFocusTarget 裁决回焦目标（测试面）。
// ────────────────────────────────────────────────────────────────────────────────────────

test("三轮(B-012) 键盘重排焦点跟随：连续两次 ArrowUp 各自 mutate、修订单调；把手带 ref 登记（回焦机制接线）；边界移动不写", async () => {
  const state = makeSettingsState(); // [tavily-a, exa-b, bing-c]，revision 3
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("b012-focus-follow");
    const n0 = fetchStub.mutates().length;
    // 第一次 ArrowUp：bing-c 2 号位 → 1 号位。
    let t = await moveWithKey(view, tree, "bing-c", "ArrowUp");
    assert.equal(fetchStub.mutates().length, n0 + 1, "第一次 ArrowUp 必须产生一次 mutate");
    // 回焦接线：被移动条目的把手节点必须登记 ref 回调——真实 React 中该回调把手 DOM 节点存入
    // handleRefs，重排渲染提交后回焦 effect 按 entryId 找回新位把手并 focus()（焦点跟随被移动条目）。
    const handle1 = one(t, ROLE.dragHandle, { entryId: "bing-c" });
    assert.equal(typeof handle1.props.ref, "function", "把手按钮必须登记 ref（回焦 effect 经被移动条目 id 找回把手）");
    // 第二次 ArrowUp：真实宿主中依赖焦点已跟随 bing-c 恢复（effect 于渲染提交后回焦）；
    // harness 无真实 DOM 焦点，fire 直调 handler——此处钉住单写者管线对连续移动持续可用（第二下不得落空）。
    t = await moveWithKey(view, t, "bing-c", "ArrowUp");
    const ms = fetchStub.mutates().slice(n0);
    assert.equal(ms.length, 2, "连续两次 ArrowUp 必须各自产生一次 mutate（第二下不得落空）");
    assert.deepEqual(ms.map((m) => m.body?.payload?.args?.expectedRevision), [3, 4],
      "两次重排的 expectedRevision 单调递增（单写者串行、各自从读回快照起算）");
    assert.deepEqual(idsOf(stateEntries(state)), ["bing-c", "tavily-a", "exa-b"], "持久层顺序连续两次上移到位");
    assert.deepEqual(cardOrder(t).slice(0, 3), ["bing-c", "tavily-a", "exa-b"], "页内视图顺序与持久投影一致");
    // 边界：bing-c 已在 0 号位——第三次 ArrowUp 越界无效（不写、不抛、不产生读回）。
    const d0 = fetchStub.describes().length;
    t = await moveWithKey(view, t, "bing-c", "ArrowUp");
    assert.equal(fetchStub.mutates().length, n0 + 2, "边界外移动不得写");
    assert.equal(fetchStub.describes().length, d0, "边界外移动不得引发提交/读回");
  });
});

test("三轮(B-012) 回焦目标裁决 reorderFocusTarget 纯逻辑：被移动条目仍在列表才回焦，否则放弃意图", async () => {
  const C = await pureContract();
  const entries = [
    { id: "a", type: "exa", name: "A", enabled: true, credentialRef: "" },
    { id: "b", type: "bing", name: "B", enabled: true, credentialRef: "" },
  ];
  assert.equal(C.reorderFocusTarget("b", entries), "b", "被移动条目仍在列表 → 回焦目标=该条目");
  assert.equal(C.reorderFocusTarget("a", [entries[1], entries[0]]), "a", "列表重排后条目仍在 → 仍回焦（焦点跟随条目而非位置）");
  assert.equal(C.reorderFocusTarget("gone", entries), null, "条目已不在列表（如已移除）→ 放弃意图");
  assert.equal(C.reorderFocusTarget("", entries), null, "空 id → 放弃");
  assert.equal(C.reorderFocusTarget(null, entries), null, "非字符串 id → 放弃");
  assert.equal(C.reorderFocusTarget("b", undefined), null, "列表缺失 → 放弃");
  assert.equal(C.reorderFocusTarget("b", "nope"), null, "列表非数组 → 放弃");
  assert.equal(C.reorderFocusTarget("b", [{ id: "b" }, null, 42]), "b", "列表含非对象项：按存在性裁决不受影响");
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 第 11 组 · 四轮修复（round-4）：空名新建被放行落库（B-007/009/019 三连胜污染源的同一根）
//   症状（run-6 探针实锤）：A-047 真空名提交 → mutate×1 载荷 ["set:entries.3"] 直接落库——
//   期望是 SPC-023/SET-006「新建=完整校验」拦截 + 编辑器动作行上方 role=alert 错误（SPC-030）。
//   根因：SET-006 提交校验链（实时 editorBlock 与提交前 validate 同源 normalizeConfig）
//   对 name 只判 typeof string，空串/纯空白放行；v1 的名称门在迁移中丢失。
//   修复：entryNameGate 名称门（trim 后非空）——新建与编辑同一路径同判据：
//   实时 editorBlock（禁用提交钮 + 动作行上方 role=alert）+ 提交前代码级守卫（零出站、
//   编辑器不关、输入不丢=SET-004 失败保留面）。运行时 normalizeConfig（src/config.js）
//   保持宽容不动（name 仅展示面，legacy 空名行不得拒载整份配置）。
// ────────────────────────────────────────────────────────────────────────────────────────

test("四轮(B-007/009/019) 空名/纯空白名新建被拦截：零 mutate + 动作行上方 role=alert + 编辑器不关 + 输入不丢 + 提交钮禁用", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("r4-empty-name-create");
    const n0 = fetchStub.mutates().length;
    const c0 = fetchStub.credentialSets().length;
    // 新建 brave（编辑器预填目录标签 "Brave"）→ 清空为空名 → 提交（真实 DOM 中提交钮已禁用；
    // harness 直触 handler，验证代码级守卫零出站）。
    let t = await addType(view, tree, "brave");
    t = await act(view, () => fire(one(t, ROLE.field, { field: "name" }), "onChange", { target: { value: "" } }));
    await step(view, t, ROLE.editorSubmit);
    assert.equal(fetchStub.mutates().length, n0, "空名新建必须零 mutate（SPC-023 新建=完整校验：空名不得落库）");
    assert.equal(fetchStub.credentialSets().length, c0, "空名新建不得连带触发 credentials/set");
    const errs = byRole(t, ROLE.saveError);
    assert.equal(errs.length, 1, "编辑器动作行上方须有可见错误");
    assert.equal(one(t, ROLE.saveError).props.role, "alert", "错误节点须 role=alert（SPC-023/SPC-030）");
    assert.ok(textOf(one(t, ROLE.saveError)).includes("名称"), "错误文案须指向名称问题");
    assert.ok(one(t, ROLE.editor), "拦截后编辑器不得关闭（SET-004 失败保留面）");
    assert.equal(one(t, ROLE.field, { field: "name" }).props.value, "", "输入不丢：名称字段保持所输（空）");
    assert.equal(one(t, ROLE.editorSubmit).props.disabled, true, "提交钮须实时禁用（真实 DOM 中禁用钮不可点）");
    // 纯空白名 → 同样拦截，累计仍零 mutate。
    t = await act(view, () => fire(one(t, ROLE.field, { field: "name" }), "onChange", { target: { value: "   \t " } }));
    t = await step(view, t, ROLE.editorSubmit);
    assert.equal(fetchStub.mutates().length, n0, "纯空白名新建同样零 mutate");
    assert.ok(one(t, ROLE.saveError), "纯空白名同样须有可见错误");
    assert.ok(one(t, ROLE.editor), "纯空白拦截后编辑器仍开");
    // 校验失败时取消钮须可点（SET-006：只读/在途之外均可取消）。
    t = await step(view, t, ROLE.editorCancel);
    assert.equal(byRole(t, ROLE.editor).length, 0, "校验失败时取消仍须可关编辑器（新条目草稿随之清除）");
    assert.equal(stateEntries(state).length, 3, "拦截的新建不得在持久层留痕");
  });
});

test("四轮(B-007/009/019) trim 后合法：前后带空白的名称新建照常落库（持久名保留原输入）", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("r4-trim-name-create");
    const n0 = fetchStub.mutates().length;
    let t = await addType(view, tree, "brave");
    t = await act(view, () => fire(one(t, ROLE.field, { field: "name" }), "onChange", { target: { value: "  Brave 备 " } }));
    t = await step(view, t, ROLE.editorSubmit);
    assert.equal(fetchStub.mutates().length, n0 + 1, "trim 后非空=合法，新建照常落库");
    const added = stateEntries(state).at(-1);
    assert.equal(added.type, "brave", "新落库条目即本次新建 brave");
    assert.equal(added.name, "  Brave 备 ", "持久名保留原输入（trim 只做合法性裁决，不做值归一）");
    assert.equal(byRole(t, ROLE.editor).length, 0, "成功提交后编辑器关闭");
    assert.ok(one(t, ROLE.saveStatus), "须有保存成功提示");
  });
});

test("四轮(B-007/009/019) 编辑面同查：既有条目改空名/空白名提交同样被拦；trim 后合法照常落库", async () => {
  const state = makeSettingsState(); // bing-c 持久名 "Bing 公开"
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("r4-empty-name-edit");
    const n0 = fetchStub.mutates().length;
    // 编辑 bing-c → 清空为空名 → 提交 → 拦（编辑与新建同判据）。
    let t = await setName(view, tree, "bing-c", "");
    await step(view, t, ROLE.editorSubmit);
    assert.equal(fetchStub.mutates().length, n0, "既有条目改空名必须零 mutate（编辑面与新建同判据）");
    assert.ok(one(t, ROLE.saveError), "编辑面拦截须有可见错误");
    assert.ok(one(t, ROLE.editor), "编辑面拦截后编辑器不得关闭");
    assert.equal(one(t, ROLE.field, { field: "name" }).props.value, "", "输入不丢");
    assert.equal(stateEntries(state).find((e) => e.id === "bing-c").name, "Bing 公开", "持久名未被空名覆盖");
    // 纯空白名 → 仍拦。
    t = await act(view, () => fire(one(t, ROLE.field, { field: "name" }), "onChange", { target: { value: "\t  " } }));
    t = await step(view, t, ROLE.editorSubmit);
    assert.equal(fetchStub.mutates().length, n0, "既有条目改纯空白名同样零 mutate");
    // trim 后合法 → 照常落库。
    t = await act(view, () => fire(one(t, ROLE.field, { field: "name" }), "onChange", { target: { value: "  Bing 备用 " } }));
    t = await step(view, t, ROLE.editorSubmit);
    assert.equal(fetchStub.mutates().length, n0 + 1, "trim 后非空=合法，编辑照常落库");
    assert.equal(stateEntries(state).find((e) => e.id === "bing-c").name, "  Bing 备用 ", "持久名保留原输入");
  });
});

test("四轮(B-007/009/019) 名称门裁决 entryNameGate 纯逻辑：trim 后非空放行，空/空白/非字符串拦截", async () => {
  const C = await pureContract();
  assert.equal(C.entryNameGate("Brave"), null, "常规名称 → 放行");
  assert.equal(C.entryNameGate("  Brave 备 "), null, "前后带空白但 trim 非空 → 放行（trim 后合法）");
  assert.equal(typeof C.entryNameGate(""), "string", "空名 → 拦截（返回错误文本）");
  assert.equal(typeof C.entryNameGate("   "), "string", "纯空白名 → 拦截");
  assert.equal(typeof C.entryNameGate("\t\n"), "string", "纯空白（制表/换行）→ 拦截");
  assert.equal(typeof C.entryNameGate(undefined), "string", "缺失 name → 拦截");
  assert.equal(typeof C.entryNameGate(42), "string", "非字符串 name → 拦截");
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 第 12 组 · 五轮修复（round-5，codex 复审 P1+P2 继承层与草稿恢复四项）
//   同根（宿主层模型）：user 层数组存在即整段遮蔽 base 层数组（无行级合并）；
//   旧版各 op 构造器只以 user 层为底 → 纯继承世界（base 有条目、user: {}）的编辑/新建/离散动作
//   要么静默零 ops、要么落盘只含单条而遮蔽整个继承数组（数据丢失）。
//   复现配方（codex 评论即蓝本）：makeSettingsState({ user: {}, base: { entries: fixtureEntries(), … } })。
//   修复 = 有效持久视图（effectiveEntriesOf = user 层有 entries ? user 层 : base 层，保序保兄弟）
//   + singleEntryDiff 守卫对照继承底板（他行零改动语义不变）+ SET-008 读回复原全部在场草稿。
// ────────────────────────────────────────────────────────────────────────────────────────

test("五轮(codex P1) 继承列表遮蔽：改名继承条目/继承世界新建，落盘均整单具化有效列表（保序保兄弟，不得遮蔽继承数组）", async () => {
  const inheritedState = () => makeSettingsState({
    user: {},
    base: { entries: fixtureEntries(), useOfficialDeepSeekSearch: true, timeoutMs: 25000 },
  });
  // (a) 改名 tavily-a（继承行）：旧版候选=[tavily-a] 单条落盘 → user 层遮蔽 base 三行（只剩它可见）。
  {
    const state = inheritedState();
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("r5-inherited-rename");
      assert.deepEqual(cardOrder(tree), ["tavily-a", "exa-b", "bing-c"], "继承条目页内可见（继承合并视图）");
      const n0 = fetchStub.mutates().length;
      let t = await setName(view, tree, "tavily-a", "Tavily 改");
      t = await step(view, t, ROLE.editorSubmit);
      assert.equal(fetchStub.mutates().length, n0 + 1, "改名继承条目必须落盘一次（守卫对照继承底板放行，不得拒发/静默）");
      const entries = state.user.entries;
      assert.ok(Array.isArray(entries), "落盘后 user 层持有完整有效列表（具化）");
      assert.deepEqual(idsOf(entries), ["tavily-a", "exa-b", "bing-c"], "保序保兄弟：user 层不得遮蔽成单条（P1 必拦面）");
      assert.equal(entries[0].name, "Tavily 改", "改名生效");
      assert.equal(entries[1].name, "Exa 备用", "兄弟行 exa-b 不丢");
      assert.equal(entries[2].name, "Bing 公开", "兄弟行 bing-c 不丢");
      assert.equal(fetchStub.credentialSets().length, 0, "纯改名不涉及凭据写入");
      assert.deepEqual(cardOrder(t), ["tavily-a", "exa-b", "bing-c"], "读回后页内仍 3 条（世界视图一致）");
      assert.ok(textOf(t).includes("Tavily 改"), "页内视图反映改名");
    });
  }
  // (b) 继承世界新建 bing：旧版候选=[bing] 单条落盘 → 三条继承兄弟全没。
  {
    const state = inheritedState();
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("r5-inherited-create");
      const n0 = fetchStub.mutates().length;
      let t = await addType(view, tree, "bing");
      assert.equal(cardOrder(t).length, 3, "未提交新建不入列（V3-1）：列表恒等于继承持久视图（3 条）");
      assert.ok(one(t, ROLE.editor), "新建编辑器须在场（幽灵仅存在于编辑器）");
      t = await step(view, t, ROLE.editorSubmit); // 名称预填 "Bing RSS"（非空，过名称门）
      assert.equal(fetchStub.mutates().length, n0 + 1, "继承世界新建必须落盘一次");
      const ids = idsOf(state.user.entries);
      assert.deepEqual(ids.slice(0, 3), ["tavily-a", "exa-b", "bing-c"], "三条继承兄弟行不得被遮蔽丢失（P1 必拦面）");
      assert.equal(ids.length, 4, "新条目追加在有效列表末尾");
      assert.ok(ids[3].startsWith("search_chain_"), "新条目为本次新建的稳定临时 id");
      assert.equal(state.user.entries[3].type, "bing", "新条目即本次新建 bing");
      assert.equal(state.user.entries[0].name, "Tavily 主", "兄弟行值原样保持");
      assert.deepEqual(cardOrder(t).slice(0, 3), ["tavily-a", "exa-b", "bing-c"], "读回后页内视图与持久一致");
    });
  }
});

test("五轮(codex P2) official 开关比对错层：base=false 且 user 无覆盖 → 打开开关必须落盘 user 层 override", async () => {
  const state = makeSettingsState({
    user: {},
    base: { entries: fixtureEntries(), useOfficialDeepSeekSearch: false, timeoutMs: 25000 },
  });
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("r5-official-inherited");
    assert.equal(one(tree, ROLE.officialToggle).props.checked, false, "有效值=继承 base=false：开关初态关");
    const n0 = fetchStub.mutates().length;
    const t = await act(view, () => fire(one(tree, ROLE.officialToggle), "onChange", { target: { checked: true, value: true } }));
    const ms = fetchStub.mutates().slice(n0);
    assert.equal(ms.length, 1, "打开开关必须恰落盘一次（旧版只读 user 层误判「已是 true」→ 零 mutate：UI 显示开、实际关）");
    assert.deepEqual(opsOf(ms[0]), [{ op: "set", path: ["useOfficialDeepSeekSearch"], value: true }], "载荷仅 user 层 override=true（从合并后有效配置判「变没变」）");
    assert.equal(state.user.useOfficialDeepSeekSearch, true, "user 层 override 已写入");
    assert.equal(one(t, ROLE.officialToggle).props.checked, true, "开关态开（UI 与持久一致）");
    assert.equal(stateEntries(state), undefined, "user 层无 entries：开关提交不得连带具化条目列表（仅自身键）");
  });
});

test("五轮(codex P2) 继承条目的离散动作必须落盘（旧版 idx===-1 静默零 ops）：启用开关/移除/重排各于纯继承世界复现", async () => {
  const inheritedState = () => makeSettingsState({
    user: {},
    base: { entries: fixtureEntries(), useOfficialDeepSeekSearch: true, timeoutMs: 25000 },
  });
  // (a) 启用开关（继承行 exa-b 关）：整单具化有效列表，兄弟不丢。
  {
    const state = inheritedState();
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("r5-inh-toggle");
      const n0 = fetchStub.mutates().length;
      const t = await setEnabled(view, tree, "exa-b", false);
      assert.equal(fetchStub.mutates().length, n0 + 1, "继承条目启用开关必须落盘一次（旧版 user 层 findIndex===-1 → 静默零 ops）");
      assert.deepEqual(idsOf(state.user.entries), ["tavily-a", "exa-b", "bing-c"], "整单具化有效列表（兄弟行不丢）");
      assert.equal(state.user.entries[1].enabled, false, "关闭已持久化");
      assert.equal(state.user.entries[0].enabled, true, "兄弟行 enabled 值原样保持");
      assert.deepEqual(cardOrder(t), ["tavily-a", "exa-b", "bing-c"], "页内视图与持久一致");
    });
  }
  // (b) 移除（继承行 exa-b）：移除后的有效列表具化（该行从有效视图消失，读回不复活）。
  {
    const state = inheritedState();
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("r5-inh-remove");
      const n0 = fetchStub.mutates().length;
      let t = await step(view, tree, ROLE.remove, { entryId: "exa-b" });
      t = await step(view, t, ROLE.confirmRemove, { entryId: "exa-b" });
      assert.equal(fetchStub.mutates().length, n0 + 1, "继承条目移除必须落盘一次（旧版静默零 ops → 页内删卡后读回条目复活=数据不一致）");
      assert.deepEqual(idsOf(state.user.entries), ["tavily-a", "bing-c"], "具化后移除行从有效视图消失（遮蔽 base）");
      assert.deepEqual(cardOrder(t), ["tavily-a", "bing-c"], "页内条目已移除（读回不复活）");
    });
  }
  // (c) 键盘重排（继承行 bing-c 两次上移）：重排后的有效列表整单具化。
  {
    const state = inheritedState();
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("r5-inh-reorder");
      const n0 = fetchStub.mutates().length;
      let t = await moveWithKey(view, tree, "bing-c", "ArrowUp");
      t = await moveWithKey(view, t, "bing-c", "ArrowUp");
      const ms = fetchStub.mutates().slice(n0);
      assert.equal(ms.length, 2, "继承条目每次键盘移动必须各落盘一次（旧版：user 层空列表 → 目标 id 全被过滤 → 静默零 ops）");
      assert.deepEqual(idsOf(state.user.entries), ["bing-c", "tavily-a", "exa-b"], "重排后的有效列表已具化进 user 层");
      assert.deepEqual(cardOrder(t), ["bing-c", "tavily-a", "exa-b"], "页内顺序与持久一致");
      assert.equal(state.user.entries[0].name, "Bing 公开", "条目名恒随自身 id（B-007 名错乱回归面）");
    });
  }
});

test("五轮(codex P2) SET-008 全语义草稿复原：编辑 A 未提交→开 B→保存 B→读回后 A 的未提交字段必须复原（重开 A 读到草稿、再保存不丢）", async () => {
  const state = makeSettingsState(); // 标准 user 层 3 条夹具：复原路径与层模型无关（旧版缺陷在任何世界都成立）
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("r5-draft-restore");
    const n0 = fetchStub.mutates().length;
    // 编辑 A（tavily-a）：改名不提交（字段入 SET-008 草稿缓存，未持久化）。
    let t = await setName(view, tree, "tavily-a", "Tavily 草稿A");
    assert.equal(one(t, ROLE.field, { field: "name" }).props.value, "Tavily 草稿A", "前置：A 的草稿字段在编辑器");
    // 切换到 B（exa-b）：开 B 的编辑器（A 的未提交字段随切换保留在草稿缓存）。
    t = await act(view, () => fire(one(t, ROLE.edit, { entryId: "exa-b" }), "onClick", {}));
    t = await act(view, () => fire(one(t, ROLE.field, { field: "name" }), "onChange", { target: { value: "Exa 草稿B" } }));
    // 保存 B → 成功读回（keepStatus 后台刷新）。
    t = await step(view, t, ROLE.editorSubmit);
    assert.equal(fetchStub.mutates().length, n0 + 1, "B 的保存恰一次 mutate");
    assert.equal(stateEntries(state).find((e) => e.id === "exa-b").name, "Exa 草稿B", "B 改名已持久化");
    // 关键验收（codex P2）：读回重建后 A 的未提交字段从草稿缓存复原回页内——
    // 旧版只复原活动编辑器行（B 提交后已关）→ A 回退持久值、页内消失。
    assert.ok(textOf(one(t, ROLE.card, { entryId: "tavily-a" })).includes("Tavily 草稿A"),
      "读回后 A 的未提交名称复原在页内（SET-008：所有在场草稿都要复原，不只活动编辑器）");
    // 重开 A：编辑器读到复原的草稿值（不得回退持久名）。
    t = await act(view, () => fire(one(t, ROLE.edit, { entryId: "tavily-a" }), "onClick", {}));
    assert.equal(one(t, ROLE.field, { field: "name" }).props.value, "Tavily 草稿A", "重开 A 读到复原草稿（不查缓存则此处回退为「Tavily 主」）");
    // 再保存 A：草稿落盘（旧版此步把缓存永久删掉=草稿丢失的终点；修复后草稿值即提交值）。
    t = await step(view, t, ROLE.editorSubmit);
    assert.equal(fetchStub.mutates().length, n0 + 2, "A 的再保存落盘一次");
    assert.equal(stateEntries(state).find((e) => e.id === "tavily-a").name, "Tavily 草稿A", "A 的未提交草稿未丢失");
    assert.equal(stateEntries(state).find((e) => e.id === "exa-b").name, "Exa 草稿B", "B 的持久值未受 A 提交影响（他行零改动）");
    // create 面（v3 用户反馈 V3-1 + SET-008 复原语义）：开新建编辑器（幽灵）→ 启用开关触发离散落盘
    // → keepStatus 后台读回 → 列表无该行（幽灵不入列）+ 编辑器字段复原 + 编辑器在场；取消收尾。
    t = await addType(view, t, "brave");
    t = await act(view, () => fire(one(t, ROLE.field, { field: "name" }), "onChange", { target: { value: "Brave 草稿" } }));
    t = await setEnabled(view, t, "exa-b", false);
    assert.equal(fetchStub.mutates().length, n0 + 3, "开关落盘一次（触发 keepStatus 后台读回，此时缓存仅剩新建记录）");
    assert.deepEqual(cardOrder(t), ["tavily-a", "exa-b", "bing-c"], "读回后列表无新建幽灵行（V3-1：列表恒等于持久视图）");
    assert.ok(one(t, ROLE.editor), "新建编辑器仍在场（读回不关闭在编新建）");
    assert.equal(one(t, ROLE.field, { field: "name" }).props.value, "Brave 草稿", "新建的未提交字段复原（SET-008 复原语义=编辑器字段复原+自动重开，不是列表占位行）");
    t = await step(view, t, ROLE.editorCancel);
    assert.equal(byRole(t, ROLE.editor).length, 0, "取消后编辑器关闭（幽灵与缓存记录清除）");
    assert.equal(byRole(t, ROLE.saveError).length, 0, "全程零节级错误（自身提交不得制造假版本冲突）");
  });
});

test("五轮补充(codex 同族残留收口，lead (z) 点头) timeoutCommit 有效值对照：继承 world（base 有 timeoutMs、user 无覆盖）重输当前有效值零 mutate；新值落 user 层单键 override", async () => {
  const state = makeSettingsState({
    user: {},
    base: { entries: fixtureEntries(), useOfficialDeepSeekSearch: true, timeoutMs: 30000 },
  });
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("r5-timeout-inherited");
    assert.equal(one(tree, ROLE.field, { field: "timeoutMs" }).props.value, "30000", "有效值=继承 base=30000：输入框初值即有效值");
    const n0 = fetchStub.mutates().length;
    // (a) 重输当前有效值 30000（onChange+同帧 blur）→ 对照有效值判「值未变化」→ 零 mutate
    //     （旧版只读 user 层：Number(undefined)=NaN≠30000 → 写冗余 override 污染 user 层）。
    let t = await act(view, () => {
      const input = one(tree, ROLE.field, { field: "timeoutMs" });
      fire(input, "onChange", { target: { value: "30000" }, currentTarget: { value: "30000" } });
      fire(input, "onBlur", { currentTarget: { value: "30000" } });
    });
    assert.equal(fetchStub.mutates().length, n0, "重输继承有效值=值未变化：零 mutate（不得写冗余 user override）");
    assert.equal(state.user.timeoutMs, undefined, "user 层未污染");
    assert.equal(one(t, ROLE.field, { field: "timeoutMs" }).props.value, "30000", "输入框仍为有效值");
    // (b) 输新值 45000 → 提交载荷= user 层单键 override（与 official 开关同形，不连带具化条目列表）。
    t = await act(view, () => {
      const input = one(t, ROLE.field, { field: "timeoutMs" });
      fire(input, "onChange", { target: { value: "45000" }, currentTarget: { value: "45000" } });
      fire(input, "onBlur", { currentTarget: { value: "45000" } });
    });
    const ms = fetchStub.mutates().slice(n0);
    assert.equal(ms.length, 1, "继承 world 超时新值必须恰落盘一次");
    assert.deepEqual(opsOf(ms[0]), [{ op: "set", path: ["timeoutMs"], value: 45000 }], "载荷仅 user 层单键 override（与 official 开关同形）");
    assert.equal(state.user.timeoutMs, 45000, "user 层 override 已写入");
    assert.equal(state.user.entries, undefined, "不连带具化条目列表（仅自身键）");
    assert.equal(one(t, ROLE.field, { field: "timeoutMs" }).props.value, "45000", "输入框反映持久值（UI 与持久一致）");
  });
});

test("六轮(codex P2) 末位继承条目删除：显式持久化 user.entries=[]（恰一条 mutate、reload 不复活、非继承路径不变）", async () => {
  const onlyEntry = { id: "base-only", type: "bing", name: "继承单条", enabled: true };
  // (a) 纯继承单条目（user={} 缺失 entries）：确认删除必须产出 set entries=[] 并落盘
  {
    const state = makeSettingsState({
      user: {},
      base: { entries: [clone(onlyEntry)], useOfficialDeepSeekSearch: true, timeoutMs: 25000 },
    });
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("r6-inh-last-remove");
      assert.deepEqual(cardOrder(tree), ["base-only"], "前置：继承单条在卡片列表可见");
      const n0 = fetchStub.mutates().length;
      let t = await step(view, tree, ROLE.remove, { entryId: "base-only" });
      t = await step(view, t, ROLE.confirmRemove, { entryId: "base-only" });
      const ms = fetchStub.mutates().slice(n0);
      assert.equal(ms.length, 1, "末位继承条目删除必须恰产生一条 mutate（旧版 toOps([], []) 零操作）");
      assert.deepEqual(opsOf(ms[0]), [{ op: "set", path: ["entries"], value: [] }], "必须显式落盘 user.entries = []（不得退化为空操作或 unset）");
      assert.ok(Array.isArray(state.user.entries) && state.user.entries.length === 0, "user 层 entries 必须显式落为空数组 []");
      assert.deepEqual({ ...state.base, ...state.user }.entries, [], "合并生效配置 entries 必须为空数组（不再参与搜索）");
      assert.deepEqual(cardOrder(t), [], "删除后卡片列表为空");
      one(t, ROLE.empty);
      assert.equal(textOf(one(t, ROLE.saveStatus)), "已保存设置。", "离散删除成功提示不变");
      // reload 读回不复活
      const reopened = await openPanel("r6-inh-last-remove-reopen");
      assert.deepEqual(cardOrder(reopened.tree), [], "reload 重开面板后继承条目不得复活");
      one(reopened.tree, ROLE.empty);
    });
  }
  // (b) user 含其他键但缺失 entries（如仅设 timeoutMs）时删除末位继承条目：只写 entries=[]，保留既有 user 键
  {
    const state = makeSettingsState({
      user: { timeoutMs: 30000 },
      base: { entries: [clone(onlyEntry)], useOfficialDeepSeekSearch: true, timeoutMs: 25000 },
    });
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("r6-inh-last-remove-with-other-keys");
      let t = await step(view, tree, ROLE.remove, { entryId: "base-only" });
      t = await step(view, t, ROLE.confirmRemove, { entryId: "base-only" });
      const ms = fetchStub.mutates();
      assert.equal(ms.length, 1, "恰一条 mutate");
      assert.deepEqual(opsOf(ms[0]), [{ op: "set", path: ["entries"], value: [] }], "载荷仅 set entries=[]");
      assert.deepEqual(state.user, { timeoutMs: 30000, entries: [] }, "保留 user 层其他键且显式落盘 entries=[]");
      assert.deepEqual(cardOrder(t), [], "页内视图为空");
    });
  }
  // (c) 非继承单条目（user 层已有 entries=[onlyEntry]）：保持既有 D-1 单行 unset 路径不变
  {
    const state = makeSettingsState({
      user: { entries: [clone(onlyEntry)], useOfficialDeepSeekSearch: true, timeoutMs: 25000 },
      base: {},
    });
    await withEnv(state, async ({ fetchStub }) => {
      const { view, tree } = await openPanel("r6-user-last-remove");
      let t = await step(view, tree, ROLE.remove, { entryId: "base-only" });
      t = await step(view, t, ROLE.confirmRemove, { entryId: "base-only" });
      const ms = fetchStub.mutates();
      assert.equal(ms.length, 1, "非继承单条删除恰一条 mutate");
      assert.deepEqual(opsOf(ms[0]), [{ op: "unset", path: ["entries", "0"] }], "非继承路径保持 D-1 unset entries.0 语义不变");
      assert.deepEqual(state.user.entries, [], "user 层 entries 为 []");
      const reopened = await openPanel("r6-user-last-remove-reopen");
      assert.deepEqual(cardOrder(reopened.tree), [], "reload 后不复活");
    });
  }
});

test("六轮(codex P2) 超时提示文案：如实描述单次搜索共享总预算与剩余时间均分语义（12/18 提示档样式不变）", async () => {
  await withEnv(makeSettingsState(), async () => {
    const { tree } = await openPanel("r6-timeout-hint");
    const timeoutRow = one(tree, ROLE.timeout);
    const hintNode = allNodes(timeoutRow).find(
      (n) => n.type === "p" && typeof n.props?.className === "string" && n.props.className.includes("sc-official-hint"),
    );
    assert.ok(hintNode, "超时行须保留 sc-official-hint 提示节点（12/18 提示档样式不变）");
    const hint = textOf(hintNode);
    for (const re of [/单次搜索/, /共享总预算/, /剩余/, /均分/, /启用工具/, /回退/]) {
      assert.match(hint, re, `超时提示须包含关键语义 ${re}`);
    }
    assert.doesNotMatch(hint, /单个工具请求/, "不得再承诺「单个工具请求」独占超时");
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

// Issue #55 regression: persisted ids are trimmed by normalization, so every UI action
// must continue to address that persisted row by its normalized identity.
const paddedIdState = () => makeSettingsState({
  user: {
    entries: [
      { id: " tavily-a ", type: "tavily", name: "Tavily 空白 ID", enabled: true, credentialRef: "TAVILY_KEY_A" },
      { id: "exa-b", type: "exa", name: "Exa 备用", enabled: true },
      { id: "bing-c", type: "bing", name: "Bing 公开", enabled: true },
    ],
    useOfficialDeepSeekSearch: true,
    timeoutMs: 25000,
  },
});

test("#55 空白持久 id：卡片可见且编辑器按规范化 id 回填原草稿", async () => {
  const state = paddedIdState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("issue55-visible-edit");
    assert.deepEqual(cardOrder(tree), ["tavily-a", "exa-b", "bing-c"], "前后空白的持久 id 不得令卡片隐藏");
    let edited = await step(view, tree, ROLE.edit, { entryId: "tavily-a" });
    assert.equal(one(edited, ROLE.field, { field: "name" }).props.value, "Tavily 空白 ID", "编辑草稿须回填正确条目");
    edited = await act(view, () => fire(one(edited, ROLE.field, { field: "name" }), "onChange", { target: { value: "Tavily 编辑已保存" } }));
    edited = await step(view, edited, ROLE.editorSubmit);
    assert.equal(state.user.entries[0].name, "Tavily 编辑已保存", "编辑提交须命中空白持久 id 的原条目");
    assert.equal(state.user.entries[0].id, " tavily-a ", "编辑不得改写原持久 id");
    assert.equal(fetchStub.mutates().length, 1, "编辑保存恰好一次 mutate");
  });
});

test("#55 空白持久 id：启用开关可用并把关闭状态持久化到原条目", async () => {
  const state = paddedIdState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("issue55-toggle");
    const changed = await setEnabled(view, tree, "tavily-a", false);
    assert.equal(one(changed, ROLE.enabled, { entryId: "tavily-a" }).props.checked, false);
    assert.equal(fetchStub.mutates().length, 1, "开关操作恰好一次 mutate");
    assert.equal(state.user.entries[0].id, " tavily-a ", "写回不得改写原持久 id");
    assert.equal(state.user.entries[0].enabled, false, "mutate 应落到空白 id 所属条目");
  });
});

test("#55 空白持久 id：删除仍经确认路径并持久化", async () => {
  const state = paddedIdState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("issue55-remove");
    let next = await step(view, tree, ROLE.remove, { entryId: "tavily-a" });
    one(next, ROLE.confirmRemove, { entryId: "tavily-a" });
    assert.equal(fetchStub.mutates().length, 0, "删除确认前零写入");
    next = await step(view, next, ROLE.confirmRemove, { entryId: "tavily-a" });
    assert.deepEqual(state.user.entries.map((entry) => entry.id), ["exa-b", "bing-c"], "确认后只删除目标原条目");
    assert.equal(fetchStub.mutates().length, 1, "确认删除恰好一次 mutate");
    assert.deepEqual(cardOrder(next), ["exa-b", "bing-c"]);
  });
});

test("#55 正常 id 反面：可见、编辑、停用、删除与重排行为保持原契约", async () => {
  const state = makeSettingsState();
  await withEnv(state, async ({ fetchStub }) => {
    const { view, tree } = await openPanel("issue55-normal-ids");
    assert.deepEqual(cardOrder(tree), ["tavily-a", "exa-b", "bing-c"]);
    let next = await setName(view, tree, "exa-b", "Exa 正常 ID");
    next = await step(view, next, ROLE.editorSubmit);
    assert.equal(state.user.entries[1].name, "Exa 正常 ID");
    next = await setEnabled(view, next, "exa-b", false);
    assert.equal(state.user.entries[1].enabled, false);
    next = await moveWithKey(view, next, "bing-c", "ArrowUp");
    assert.deepEqual(cardOrder(next), ["tavily-a", "bing-c", "exa-b"]);
    next = await step(view, next, ROLE.remove, { entryId: "exa-b" });
    next = await step(view, next, ROLE.confirmRemove, { entryId: "exa-b" });
    assert.deepEqual(state.user.entries.map((entry) => entry.id), ["tavily-a", "bing-c"]);
    assert.deepEqual(cardOrder(next), ["tavily-a", "bing-c"]);
    assert.equal(fetchStub.mutates().length, 4, "编辑、停用、重排、删除各自维持一次离散写入");
  });
});
