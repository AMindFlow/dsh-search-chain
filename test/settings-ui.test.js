// WP12 验收（oracle）— SET-001 … SET-005 与 CAT-001（设置面板逻辑端口面，src/client.js + src/settings/）。
//
// 覆盖条款（编号见 docs/specs/draft/settings-ui.md 与 providers.md）：
//   SET-001 入口与列表：挂载为 settings.section 区域；空态；列表按保存顺序渲染；状态可辨别。
//   SET-002 增加、编辑与停用：追加末尾并启用；type 必填；同型多实例 id 唯一且稳定；
//           编辑隔离；删除确认；删除不移除宿主凭据；Bing 免 key；proxy 形态校验（与 CFG-001 委托比对）。
//   SET-003 拖动调整优先级：命令式重排 = 拖动结果；键盘上移/下移等价；停用可排序；重开后顺序一致；
//           保存后的写入形状即执行序（FB-001 写入口一致性）。
//   SET-004 保存与凭据状态：编辑在保存前不写宿主；保存恰一次；保存失败保留草稿且宿主快照不变（CFG-004）；
//           版本冲突不覆盖外部改动；保存成功后 current() 重读一致；面板操作供应商请求数为零；
//           key 只写不读、不进入视图与已保存配置（CFG-003 UI 层）。
//   SET-005 DeepSeek 官方搜索开关：缺省开启；开关旁文案要素；切换不自动保存、不发请求、保存后持久；
//           切换不改动自定义列表。
//   CAT-001 首期类型目录：七种类型齐备；供应商归并；凭据/免 key 字段；费用提示要素；DeepSeek 两模式切换。
//
// ─── oracle 假设（实现须满足，详见 helpers/settings-oracle.js 头部 API 契约）──────────────
//   · src/client.js 导出 createSettingsPanel(deps)、mountSettingsSection(slots, panel)。
//   · 面板命令同步返回（addTool/editEntry/...）；open()/save() 为 Promise。
//   · 校验在 editEntry/addTool 即时进行（非法值立即抛 CONFIG_CODES.INVALID，草稿不变）。
//   · 面板 catalog() 的 fields 包含 "credential"（需要 key 的类型）与 "mode"（DeepSeek 两模式）。
//
// ─── 宿主 / 浏览器核对清单（不在 node:test 内验证，留给 WP7 宿主清单）────────────────────────
//   H-1 设置区域确实出现在 DSH「设置」中，空态与「添加搜索工具」入口可见，首张卡片显示正确。
//   H-2 切换宿主主题（亮/暗）后标签、开关与状态文本均可读，且能辨别缺少 key 与已关闭。
//   H-3 拖动把手可改变视觉顺序；键盘上移/下移与拖动结果一致（真实 DOM 焦点与事件）。
//   H-4 保存后 profile 中的配置内容与界面一致；重启 DSH 后顺序与停用状态一致。
//   H-5 settings.section 真实注册形状（descriptor 字段、卸载注销）以宿主 slot 实机为准；
//       本轮 Client 检查超时（Slots.listSubTree 未连接），无法在线核对。
//   H-6 官方开关的路由效果（DSH-005）经真实 web_search 核对：官方会话走宿主搜索，其他会话走自定义链。
//   H-7 面板打开、切换、排序与保存时，网络监控下供应商请求数为零（SET-004 实测）。
//   H-8 七种类型在真实设置页逐一选择，显示对应凭据/模型/模式字段与计费说明。
//
// ─── TODO(spec)：规格含糊集中待办（唯一出处；测试已按下述假设取值）──────────────────────────
//   T-1 条目 id 生成规则未规定（SET-002 只要求「稳定身份」「同型多实例」）：只断言唯一、稳定、不复用，不钉格式。
//   T-2 保存失败后界面行为：SET-004 写「保留未提交编辑」，而任务书写「界面回滚到已生效快照」。
//       本文件取 SET-004 为准：宿主快照不变（CFG-004）、草稿保留并显示 saveError。待 spec 确认。
//   T-3 版本冲突的错误码未在 contract.js CONFIG_CODES 中定义：断言接受 SAVE_FAILED 或 CONFIG_CONFLICT。
//   T-4 条目状态措辞：SET-001 要求辨别「缺 key」与「已关闭」，SET-004 限定状态「只表示本地配置与启用情况」。
//       本文件只断言三态（已关闭 / 缺凭据引用 / 就绪）两两不同，不钉字符串。
//   T-5 各类型的凭据/模型/模式字段对应关系未规定：只钉需要 key 的类型含 credential、Bing 不含、DeepSeek 含 mode；
//       OpenAI 是否显示 model 未钉。
//   T-6 计费说明措辞未规定：只钉规格中明确的要素关键词（见 helpers BILLING_KEYWORDS），其余只要求非空。
//   T-7 设置面是否暴露 timeoutMs 未规定（SET 无对应条目）：本文件不要求 UI 控件，仅委托 normalizeConfig 语义。
//   T-8 键盘上移/下移在首末项的行为未规定：本文件取无操作。
//   T-9 config-contract.test.js 引用了 C.CONFIG_CODES.TIMEOUT_INVALID，contract.js 中不存在（为 undefined），
//       该既有用例即使实现正确也会因错误码比对失败；按规则不改既有测试，仅在报告中提出。
// ──────────────────────────────────────────────────────────────────────────────────────────
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import * as O from "./helpers/settings-oracle.js";
import { SYNTHETIC_KEY, SYNTHETIC_PROXY, SYNTHETIC_PAC } from "./helpers/fake-fetch.js";
import { createFakeCredentials } from "./helpers/fake-credentials.js";
import { assertNoSecrets } from "./helpers/redact.js";

const { CONFIG_CODES } = C;

/** 未在 contract.js 定义的冲突码（T-3 假设）。 */
const CONFLICT_CODES = [CONFIG_CODES.SAVE_FAILED, "CONFIG_CONFLICT"];

function entriesOf(h) {
  return h.host.settingsPort.current().entries;
}

// ═══════════════════════════════ SET-001 入口与列表 ═══════════════════════════════

test("SET-001：挂载为 settings.section 区域，重复挂载不双注册，清理即注销", async (t) => {
  const mod = await O.loadClient(t, "SET-001");
  if (!mod) return;
  const h = O.makeHarness({ config: O.savedFixture() });
  const panel = await O.openPanel(mod, h);
  const slots = O.createSlotRegistry();

  const cleanup = mod.mountSettingsSection(slots, panel);
  assert.equal(typeof cleanup, "function", "mountSettingsSection 必须返回注销函数");
  assert.equal(slots.regs.length, 1, "挂载后恰好一个设置区域（SET-001）");
  assert.equal(slots.regs[0].slot, "settings.section", "区域必须挂在 settings.section 插槽");
  assert.equal(slots.regs[0].id, C.PROVIDER_ID, "区域标识为 search-chain");

  cleanup();
  assert.equal(slots.regs.length, 0, "清理后区域必须注销（DSH-001 卸载语义）");

  const cleanup2 = mod.mountSettingsSection(slots, panel);
  assert.equal(slots.regs.length, 1, "重新挂载后仍只有一个区域");
  cleanup2();
});

test("SET-001：新配置列表为空，空态引导与添加入口可见，官方开关位于区域顶端", async (t) => {
  const mod = await O.loadClient(t, "SET-001");
  if (!mod) return;
  const h = O.makeHarness({ config: {} });
  const panel = await O.openPanel(mod, h);
  const view = panel.view();

  assert.equal(view.emptyState, true, "新配置列表为空时必须进入空态（SET-001）");
  assert.deepEqual(view.cards, [], "空态无卡片");
  assert.ok(typeof view.emptyText === "string" && view.emptyText.length > 0, "空态须有引导文案");
  assert.ok(typeof view.addAction?.label === "string" && view.addAction.label.length > 0, "列表末尾须有「添加搜索工具」入口");
  assert.equal(typeof view.officialToggle?.checked, "boolean", "区域顶端必须呈现 SET-005 官方开关");
});

test("SET-001：卡片按已保存顺序渲染，显示名称、类型、启用态，并可编辑与移除", async (t) => {
  const mod = await O.loadClient(t, "SET-001");
  if (!mod) return;
  const h = O.makeHarness({ config: O.savedFixture() });
  const panel = await O.openPanel(mod, h);
  const cards = panel.view().cards;

  assert.deepEqual(
    cards.map((c) => c.id),
    ["e-openai-main", "e-tavily-pac", "e-bing-off", "e-deepseek-search"],
    "卡片顺序即保存顺序（SET-003：列表从上到下即搜索顺序）",
  );
  const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.equal(byId["e-openai-main"].name, "合成 OpenAI 主线");
  assert.equal(byId["e-bing-off"].enabled, false, "停用状态须如实渲染");
  assert.equal(byId["e-tavily-pac"].enabled, true);
  for (const c of cards) {
    assert.ok(typeof c.typeLabel === "string" && c.typeLabel.length > 0, `卡片 ${c.id} 须显示类型名`);
    assert.equal(c.editable, true, `卡片 ${c.id} 须提供编辑入口`);
    assert.equal(c.removable, true, `卡片 ${c.id} 须提供移除入口`);
  }
});

test("SET-001/SET-004：状态可辨别「已关闭」「缺凭据引用」「就绪」三态（只表示本地配置与启用）", async (t) => {
  const mod = await O.loadClient(t, "SET-001/SET-004");
  if (!mod) return;
  const h = O.makeHarness({
    config: C.makeSavedConfig([
      C.makeEntry({ id: "ready", type: "openai", name: "就绪", enabled: true, credentialRef: "synthetic-ref:ready" }),
      C.makeEntry({ id: "nokey", type: "openai", name: "缺凭据", enabled: true }),
      C.makeEntry({ id: "off", type: "openai", name: "已关闭", enabled: false, credentialRef: "synthetic-ref:off" }),
    ]),
  });
  const panel = await O.openPanel(mod, h);
  const status = Object.fromEntries(panel.view().cards.map((c) => [c.id, c.status]));

  assert.notEqual(status.nokey, status.off, "缺 key 与已关闭必须可辨别（SET-001）");
  assert.notEqual(status.nokey, status.ready, "缺凭据与就绪必须可辨别");
  assert.notEqual(status.off, status.ready, "已关闭与就绪必须可辨别");
});

// ═══════════════════════════════ SET-002 增删改与停用 ═══════════════════════════════

test("SET-002：addTool 追加末尾并启用；type 必填；同型多实例 id 唯一", async (t) => {
  const mod = await O.loadClient(t, "SET-002");
  if (!mod) return;
  const h = O.makeHarness({
    config: C.makeSavedConfig([
      C.makeEntry({ id: "a", type: "openai" }),
      C.makeEntry({ id: "b", type: "exa" }),
    ]),
  });
  const panel = await O.openPanel(mod, h);

  const id1 = panel.addTool("tavily");
  const id2 = panel.addTool("tavily");
  assert.equal(typeof id1, "string");
  assert.ok(id1.length > 0, "新条目必须有稳定 id");
  assert.notEqual(id1, id2, "同一种类型可添加多个独立实例，id 必须不同（SET-002）");
  assert.ok(!["a", "b"].includes(id1), "新 id 不得与既有条目冲突");
  assert.deepEqual(O.cardIds(panel), ["a", "b", id1, id2], "新条目追加到末尾（SET-002）");

  const added = panel.draftEntry(id1);
  assert.equal(added.type, "tavily");
  assert.equal(added.enabled, true, "保存后该条目追加到末尾并启用（SET-002）");

  O.assertThrowsCode(() => panel.addTool(undefined), CONFIG_CODES.INVALID, "type 缺失必须拒绝");
  O.assertThrowsCode(() => panel.addTool(""), CONFIG_CODES.INVALID, "空 type 必须拒绝");
  assert.deepEqual(O.cardIds(panel), ["a", "b", id1, id2], "被拒绝的添加不得产生条目");
});

test("CAT-001/SET-002：未知类型在添加与编辑两处均被拒绝，且目录外类型不出现", async (t) => {
  const mod = await O.loadClient(t, "CAT-001/SET-002");
  if (!mod) return;
  const h = O.makeHarness({ config: C.makeSavedConfig([C.makeEntry({ id: "a", type: "openai" })]) });
  const panel = await O.openPanel(mod, h);

  O.assertThrowsCode(() => panel.addTool("not-a-tool"), CONFIG_CODES.INVALID, "未知类型添加必须拒绝");
  assert.deepEqual(O.cardIds(panel), ["a"], "被拒绝的添加不得产生条目");

  const before = panel.draftEntry("a");
  O.assertThrowsCode(() => panel.editEntry("a", { type: "not-a-tool" }), CONFIG_CODES.INVALID, "编辑为未知类型必须拒绝");
  assert.deepEqual(panel.draftEntry("a"), before, "被拒绝的编辑草稿不变");

  const types = panel.catalog().map((x) => x.type);
  assert.ok(!types.includes("not-a-tool"), "目录只含 CAT-001 七种类型");
});

test("SET-002：条目身份稳定，重排、停用、编辑、保存与重开后 id 不变", async (t) => {
  const mod = await O.loadClient(t, "SET-002");
  if (!mod) return;
  const h = O.makeHarness({ config: O.savedFixture() });
  const panel = await O.openPanel(mod, h);
  const id = panel.addTool("exa");
  panel.reorder(id, 0);
  panel.setEnabled(id, false);
  panel.editEntry(id, { name: "改名后的 Exa" });
  assert.equal(panel.draftEntry(id).type, "exa");

  assert.equal(await O.trySave(panel), null);
  assert.ok(O.savedIds(h).includes(id), "保存后 id 不变");

  const reopened = await O.openPanel(mod, h);
  const card = reopened.view().cards.find((c) => c.id === id);
  assert.ok(card, "重开后同一 id 仍存在");
  assert.equal(card.name, "改名后的 Exa");
  assert.equal(card.enabled, false);
});

test("SET-002：编辑单条不改变其他条目的配置与位置", async (t) => {
  const mod = await O.loadClient(t, "SET-002");
  if (!mod) return;
  const h = O.makeHarness({ config: O.savedFixture() });
  const panel = await O.openPanel(mod, h);
  const others = ["e-tavily-pac", "e-bing-off", "e-deepseek-search"];
  const beforeOthers = others.map((id) => panel.draftEntry(id));

  panel.editEntry("e-openai-main", { name: "只改这一条", proxy: SYNTHETIC_PROXY });

  assert.deepEqual(
    others.map((id) => panel.draftEntry(id)),
    beforeOthers,
    "其他条目的配置须保持不变（SET-002 验收）",
  );
  assert.deepEqual(O.cardIds(panel), ["e-openai-main", "e-tavily-pac", "e-bing-off", "e-deepseek-search"], "编辑不改变位置");
  assert.equal(panel.draftEntry("e-openai-main").type, "openai", "编辑不改变类型以外的既有身份字段");
});

test("SET-002：移除需确认；取消不生效，确认后仅移除此处配置且其余顺序保持", async (t) => {
  const mod = await O.loadClient(t, "SET-002");
  if (!mod) return;
  const h = O.makeHarness({ config: O.savedFixture() });
  const panel = await O.openPanel(mod, h);

  panel.requestRemove("e-tavily-pac");
  assert.equal(panel.view().pendingRemoveId, "e-tavily-pac", "请求移除后界面须进入确认态");
  assert.ok(O.cardIds(panel).includes("e-tavily-pac"), "未确认前条目仍在");

  panel.cancelRemove();
  assert.equal(panel.view().pendingRemoveId, null, "取消后确认态清除");
  assert.ok(O.cardIds(panel).includes("e-tavily-pac"), "取消后条目仍在");

  panel.requestRemove("e-tavily-pac");
  panel.confirmRemove("e-tavily-pac");
  assert.deepEqual(
    O.cardIds(panel),
    ["e-openai-main", "e-bing-off", "e-deepseek-search"],
    "确认后移除该条目，其余顺序保持",
  );
  assert.equal(panel.view().pendingRemoveId, null);
});

test("SET-002：移除条目不删除复用的宿主凭据（引用与托管记录均保留）", async (t) => {
  const mod = await O.loadClient(t, "SET-002");
  if (!mod) return;
  const K_REF = SYNTHETIC_KEY("shared-ref");
  const K_REC = SYNTHETIC_KEY("shared-record");
  const creds = createFakeCredentials({
    refs: { "synthetic-ref:shared": K_REF },
    records: { OPENAI_API_KEY: K_REC },
  });
  const h = O.makeHarness({
    config: C.makeSavedConfig([
      C.makeEntry({ id: "a", type: "openai", credentialRef: "synthetic-ref:shared" }),
      C.makeEntry({ id: "b", type: "openai" }),
    ]),
    credentials: creds,
  });
  const panel = await O.openPanel(mod, h);

  panel.requestRemove("a");
  panel.confirmRemove("a");
  assert.equal(await O.trySave(panel), null);

  assert.deepEqual(O.savedIds(h), ["b"], "此处配置已移除");
  // 真宿主形状（dsh-credentials README/types.ts @0.2.2-rc.5，WP7 实机发现）：
  // resolve → { value, source }；api-key 记录值在记录顶层 key。
  assert.deepEqual(
    await creds.resolve("synthetic-ref:shared"),
    { value: K_REF, source: "user-env" },
    "复用的凭据引用不得被移除（SET-002）",
  );
  const rec = await creds.readRecord("OPENAI_API_KEY");
  assert.equal(rec?.kind, "api-key", "宿主托管记录不得被移除（真宿主形状 record.kind）");
  assert.equal(rec?.key, K_REC, "宿主托管记录不得被移除（真宿主形状 record.key）");
});

test("SET-002：选择 Bing RSS 无需 key，保存成功且状态不因缺 key 显示为缺凭据", async (t) => {
  const mod = await O.loadClient(t, "SET-002/CAT-001");
  if (!mod) return;
  const h = O.makeHarness({
    config: C.makeSavedConfig([C.makeEntry({ id: "ref", type: "openai", credentialRef: "synthetic-ref:ref" })]),
  });
  const panel = await O.openPanel(mod, h);
  const bingId = panel.addTool("bing");

  assert.equal(await O.trySave(panel), null, "Bing 无需 key，保存不得报错（SET-002）");
  assert.equal(panel.view().saveError, null);
  const cards = Object.fromEntries(panel.view().cards.map((c) => [c.id, c]));
  assert.equal(cards[bingId].status, cards.ref.status, "免 key 条目的就绪态与带凭据引用的就绪态一致");
});

test("SET-002/CFG-001：proxy 三形态被接受，空白即直连，越界形态即时拒绝且草稿不变", async (t) => {
  const mod = await O.loadClient(t, "SET-002/CFG-001");
  if (!mod) return;
  const h = O.makeHarness({ config: C.makeSavedConfig([C.makeEntry({ id: "p", type: "openai" })]) });
  const panel = await O.openPanel(mod, h);

  panel.editEntry("p", { proxy: SYNTHETIC_PROXY });
  assert.equal(panel.draftEntry("p").proxy, SYNTHETIC_PROXY);
  panel.editEntry("p", { proxy: { pac: SYNTHETIC_PAC } });
  assert.deepEqual(panel.draftEntry("p").proxy, { pac: SYNTHETIC_PAC });
  for (const blank of ["", "   "]) {
    panel.editEntry("p", { proxy: blank });
    assert.ok(!panel.draftEntry("p").proxy, `空白 proxy 即直连，草稿中须省略（CFG-001）：${JSON.stringify(blank)}`);
  }

  panel.editEntry("p", { proxy: SYNTHETIC_PROXY });
  const good = panel.draftEntry("p");
  for (const bad of ["syn-proxy.invalid:8080", "ftp://syn-proxy.invalid:21", 42, { bogus: 1 }, { pac: "not-an-url" }, { pac: "   " }]) {
    O.assertThrowsCode(() => panel.editEntry("p", { proxy: bad }), CONFIG_CODES.INVALID, `越界 proxy 必须拒绝：${JSON.stringify(bad)}`);
    assert.deepEqual(panel.draftEntry("p"), good, "被拒绝的 proxy 不得改动草稿");
  }
});

test("CFG-001/SET-002：面板 proxy 校验与 normalizeConfig 语义逐例一致（委托，不重复造轮子）", async (t) => {
  const mod = await O.loadClient(t, "SET-002/CFG-001");
  if (!mod) return;
  const cfg = await O.loadConfig(t, "CFG-001");
  if (!cfg) return;
  const h = O.makeHarness({ config: C.makeSavedConfig([C.makeEntry({ id: "p", type: "openai" })]) });
  const panel = await O.openPanel(mod, h);

  const samples = [
    SYNTHETIC_PROXY,
    { pac: SYNTHETIC_PAC },
    "",
    "   ",
    "syn-proxy.invalid:8080",
    "ftp://syn-proxy.invalid:21",
    42,
    { bogus: 1 },
    { pac: "not-an-url" },
    { pac: "   " },
  ];
  for (const sample of samples) {
    const panelRejects = O.throwsSync(() => panel.editEntry("p", { proxy: sample }));
    const configRejects = O.throwsSync(() => cfg.normalizeConfig({ entries: [C.makeEntry({ id: "p", type: "openai", proxy: sample })] }));
    assert.equal(panelRejects, configRejects, `面板与 normalizeConfig 对 proxy 的接受/拒绝须一致：${JSON.stringify(sample)}`);
  }
});

test("FB-003/SET-002：timeoutMs 委托 normalizeConfig：非正整数一律 INVALID，缺省为 25000（T-7）", async (t) => {
  const cfg = await O.loadConfig(t, "FB-003/CFG-004");
  if (!cfg) return;
  for (const bad of [0, -5, 2.5, "25000", Number.NaN]) {
    O.assertThrowsCode(
      () => cfg.normalizeConfig({ entries: [], timeoutMs: bad }),
      CONFIG_CODES.INVALID,
      `timeoutMs=${String(bad)} 必须判为 INVALID（FB-003 正整数）`,
    );
  }
  assert.equal(cfg.normalizeConfig({ entries: [] }).timeoutMs, C.DEFAULT_TIMEOUT_MS, "缺省总预算 25000（FB-003）");
});

// ═══════════════════════════════ SET-003 拖动调整优先级 ═══════════════════════════════

test("SET-003：拖动重排产生新顺序；保存前宿主顺序不变，保存后与视觉顺序一致", async (t) => {
  const mod = await O.loadClient(t, "SET-003");
  if (!mod) return;
  const h = O.makeHarness({
    config: C.makeSavedConfig([
      C.makeEntry({ id: "a", type: "openai", name: "A" }),
      C.makeEntry({ id: "b", type: "exa", name: "B" }),
      C.makeEntry({ id: "c", type: "brave", name: "C" }),
    ]),
  });
  const panel = await O.openPanel(mod, h);

  panel.reorder("c", 0);
  assert.deepEqual(O.cardIds(panel), ["c", "a", "b"]);
  panel.reorder("b", 1);
  assert.deepEqual(O.cardIds(panel), ["c", "b", "a"], "重排结果即视觉顺序（SET-003 验收：保存 C、B、A）");
  assert.deepEqual(O.savedIds(h), ["a", "b", "c"], "拖动本身不得自动保存（SET-004）");

  assert.equal(await O.trySave(panel), null);
  assert.deepEqual(O.savedIds(h), ["c", "b", "a"], "保存后执行序与视觉顺序一致（FB-001 写入口形状）");
});

test("SET-003：停用条目可排序，排序后仍保持停用态", async (t) => {
  const mod = await O.loadClient(t, "SET-003");
  if (!mod) return;
  const h = O.makeHarness({
    config: C.makeSavedConfig([
      C.makeEntry({ id: "a", type: "openai" }),
      C.makeEntry({ id: "b", type: "exa", enabled: false }),
      C.makeEntry({ id: "c", type: "brave" }),
    ]),
  });
  const panel = await O.openPanel(mod, h);

  panel.reorder("b", 0);
  assert.deepEqual(O.cardIds(panel), ["b", "a", "c"], "停用条目也能拖动（SET-003）");
  assert.equal(panel.draftEntry("b").enabled, false, "排序不改变停用态");

  assert.equal(await O.trySave(panel), null);
  const saved = entriesOf(h).find((e) => e.id === "b");
  assert.equal(saved.enabled, false, "保存后仍为停用");
  assert.deepEqual(O.savedIds(h), ["b", "a", "c"]);
});

test("SET-003：键盘上移/下移与拖动结果等价；首末项越界为无操作", async (t) => {
  const mod = await O.loadClient(t, "SET-003");
  if (!mod) return;
  const make = () =>
    O.makeHarness({
      config: C.makeSavedConfig([
        C.makeEntry({ id: "a", type: "openai" }),
        C.makeEntry({ id: "b", type: "exa" }),
        C.makeEntry({ id: "c", type: "brave" }),
      ]),
    });

  const hk = make();
  const kb = await O.openPanel(mod, hk);
  kb.moveUp("a");
  assert.deepEqual(O.cardIds(kb), ["a", "b", "c"], "首项上移为无操作（T-8）");
  kb.moveDown("c");
  assert.deepEqual(O.cardIds(kb), ["a", "b", "c"], "末项下移为无操作（T-8）");
  kb.moveDown("a");
  assert.deepEqual(O.cardIds(kb), ["b", "a", "c"], "键盘下移一位");
  kb.moveUp("c");
  assert.deepEqual(O.cardIds(kb), ["b", "c", "a"], "键盘上移一位");

  const hd = make();
  const drag = await O.openPanel(mod, hd);
  drag.reorder("a", 1);
  drag.reorder("c", 1);
  assert.deepEqual(O.cardIds(drag), O.cardIds(kb), "键盘与拖动得到同一顺序（SET-003：等价的上移和下移）");
});

test("SET-003/SET-004：重开面板后顺序与停用状态与保存一致", async (t) => {
  const mod = await O.loadClient(t, "SET-003/SET-004");
  if (!mod) return;
  const h = O.makeHarness({
    config: C.makeSavedConfig([
      C.makeEntry({ id: "a", type: "openai" }),
      C.makeEntry({ id: "b", type: "exa", enabled: false }),
      C.makeEntry({ id: "c", type: "brave" }),
    ]),
  });
  const first = await O.openPanel(mod, h);
  first.reorder("c", 0);
  first.reorder("b", 1);
  assert.equal(await O.trySave(first), null);

  const reopened = await O.openPanel(mod, h);
  assert.deepEqual(O.cardIds(reopened), ["c", "b", "a"], "重开后顺序与保存一致（SET-003 重启复查）");
  const b = reopened.view().cards.find((c) => c.id === "b");
  assert.equal(b.enabled, false, "重开后停用状态保持");
});

// ═══════════════════════════════ SET-004 保存与凭据状态 ═══════════════════════════════

test("SET-004：编辑、排序与开关在保存前不写宿主；保存恰好一次写入 editor", async (t) => {
  const mod = await O.loadClient(t, "SET-004");
  if (!mod) return;
  const h = O.makeHarness({ config: O.savedFixture() });
  const panel = await O.openPanel(mod, h);
  const beforeSnap = O.snapshot(h);
  const beforeCalls = h.host.editor.calls.length;

  panel.addTool("exa");
  panel.reorder("e-bing-off", 0);
  panel.setEnabled("e-bing-off", true);
  panel.setOfficialSearch(false);
  panel.editEntry("e-openai-main", { name: "草稿改名" });
  assert.equal(h.host.editor.calls.length, beforeCalls, "保存前任何面板操作都不得写入宿主（SET-004）");
  assert.deepEqual(O.snapshot(h), beforeSnap, "保存前宿主快照不变");
  assert.equal(panel.view().dirty, true, "未保存的编辑须标记为脏状态");

  assert.equal(await O.trySave(panel), null);
  assert.equal(h.host.editor.calls.length, beforeCalls + 1, "保存必须恰好调用 editor 一次");
});

test("SET-004/CFG-004：保存失败时宿主快照保持不变、草稿保留、界面显示 SAVE_FAILED 错误，重试可成功", async (t) => {
  const mod = await O.loadClient(t, "SET-004/CFG-004");
  if (!mod) return;
  const h = O.makeHarness({ config: O.savedFixture() });
  const panel = await O.openPanel(mod, h);
  const beforeSnap = O.snapshot(h);

  const newId = panel.addTool("exa");
  panel.setOfficialSearch(false);
  h.host.editor.failNext = new Error("synthetic save failure");

  await O.trySave(panel);
  const view = panel.view();
  assert.ok(view.saveError, "保存失败必须向界面给出错误（SET-004）");
  assert.equal(view.saveError.code, CONFIG_CODES.SAVE_FAILED, "错误码须为 CONFIG_CODES.SAVE_FAILED");
  assert.ok(typeof view.saveError.message === "string" && view.saveError.message.length > 0, "错误须可操作，给出可读原因");
  assert.deepEqual(O.snapshot(h), beforeSnap, "宿主已生效快照保持不变（CFG-004）；T-2");
  assert.ok(panel.draftEntry(newId), "未提交的新增条目须保留在草稿中（SET-004：保留未提交编辑）");
  assert.equal(view.officialToggle.checked, false, "未提交的开关状态须保留");
  assert.equal(view.dirty, true);

  assert.equal(await O.trySave(panel), null, "保存重试在故障消除后应成功");
  assert.equal(panel.view().saveError, null, "成功后清除错误");
  assert.ok(O.savedIds(h).includes(newId), "重试成功后新增条目生效");
});

test("SET-004：保存成功后 current() 重读与草稿一致（顺序、启用态、字段）", async (t) => {
  const mod = await O.loadClient(t, "SET-004");
  if (!mod) return;
  const h = O.makeHarness({ config: O.savedFixture() });
  const panel = await O.openPanel(mod, h);
  panel.reorder("e-deepseek-search", 0);
  panel.setEnabled("e-bing-off", true);
  panel.editEntry("e-tavily-pac", { name: "重读校验" });

  assert.equal(await O.trySave(panel), null);
  assert.equal(panel.view().dirty, false, "成功保存后不再是脏状态");

  const cur = entriesOf(h);
  assert.deepEqual(
    cur.map((e) => e.id),
    O.cardIds(panel),
    "保存后宿主顺序与界面顺序一致",
  );
  for (const e of cur) {
    assert.deepEqual(e, panel.draftEntry(e.id), `条目 ${e.id} 的重读须与草稿一致`);
  }
});

test("SET-004：版本冲突（配置已被其他界面改动）时不覆盖外部改动，界面给出错误并保留草稿", async (t) => {
  const mod = await O.loadClient(t, "SET-004");
  if (!mod) return;
  const h = O.makeHarness({ config: O.savedFixture() });
  const panel = await O.openPanel(mod, h);
  const draftId = panel.addTool("exa");

  // 外部界面在面板打开之后改写了配置（新增一条、关闭官方开关）。
  await h.host.editor.edit(h.host.entry, (current) => ({
    ...current,
    useOfficialDeepSeekSearch: false,
    entries: [...current.entries, C.makeEntry({ id: "e-external", type: "exa", name: "外部写入" })],
  }));

  await O.trySave(panel);
  assert.ok(O.savedIds(h).includes("e-external"), "外部改动不得被面板的陈旧草稿覆盖（SET-004）");
  const view = panel.view();
  assert.ok(view.saveError, "版本冲突须向用户显示可操作的错误（SET-004）");
  assert.ok(CONFLICT_CODES.includes(view.saveError.code), `冲突错误码须为 ${CONFLICT_CODES.join(" 或 ")}（T-3）`);
  assert.ok(panel.draftEntry(draftId), "未提交草稿保留，供用户重新对齐后保存");
});

test("SET-004：打开、切换、排序、编辑与保存均不发出供应商请求或搜索", async (t) => {
  const mod = await O.loadClient(t, "SET-004");
  if (!mod) return;
  const h = O.makeHarness({ config: O.savedFixture() });
  const panel = await O.openPanel(mod, h);
  const id = panel.addTool("tavily");
  panel.setEnabled("e-bing-off", true);
  panel.reorder(id, 0);
  panel.setOfficialSearch(false);
  panel.editEntry(id, { name: "零请求", proxy: SYNTHETIC_PROXY });
  assert.equal(await O.trySave(panel), null);
  panel.view();

  assert.equal(h.fetchTrap.calls.length, 0, "面板操作不得出站（SET-004：供应商请求数为零）");
  assert.equal(h.chainTrap.calls.length, 0, "面板操作不得发起搜索");
  assert.equal(h.host.traps.webSearch, 0, "面板操作不得经 ctx.web.search");
  assert.equal(h.host.traps.webFetch, 0, "面板操作不得经 ctx.web.fetch");
});

test("SET-004/CFG-003：key 只写不读；保存后存入凭据引用，视图与已保存配置不含明文", async (t) => {
  const mod = await O.loadClient(t, "SET-004/CFG-003");
  if (!mod) return;
  const K = SYNTHETIC_KEY("settings-ui-openai");
  const creds = createFakeCredentials();
  const h = O.makeHarness({
    config: C.makeSavedConfig([C.makeEntry({ id: "k1", type: "openai", name: "密钥条目" })]),
    credentials: creds,
  });
  const panel = await O.openPanel(mod, h);

  panel.editEntry("k1", { apiKey: K });
  assertNoSecrets(t, panel.view(), [K], "编辑未保存时的视图");
  assertNoSecrets(t, panel.draftEntry("k1"), [K], "读取草稿条目（不得回显输入值）");

  assert.equal(await O.trySave(panel), null);
  const ref = entriesOf(h)[0].credentialRef;
  assert.ok(typeof ref === "string" && ref.length > 0, "保存后条目须持有凭据引用（CFG-002）");
  // 真宿主形状（dsh-credentials README，WP7 实机发现）：resolve → { value, source }（不是裸字符串）。
  assert.deepEqual(
    await creds.resolve(ref),
    { value: K, source: "user-env" },
    "明文 key 须经宿主凭据服务保存到该引用",
  );
  assertNoSecrets(t, O.snapshot(h), [K], "已保存的宿主配置");

  const reopened = await O.openPanel(mod, h);
  assertNoSecrets(t, reopened.view(), [K], "重开后的视图（不得回读旧值）");
  assertNoSecrets(t, reopened.draftEntry("k1"), [K], "重开后的草稿（不得回读旧值）");
});

// ═══════════════════════════════ SET-005 DeepSeek 官方搜索开关 ═══════════════════════════════

test("SET-005：未设开关时显示为开启；已保存为 false 时显示为关闭", async (t) => {
  const mod = await O.loadClient(t, "SET-005");
  if (!mod) return;
  const fresh = await O.openPanel(mod, O.makeHarness({ config: {} }));
  assert.equal(fresh.view().officialToggle.checked, true, "缺省必须开启（SET-005）");

  // 注意：makeSavedConfig 会把缺省补为 true，这里手工构造以真正缺省该字段。
  const withEntries = await O.openPanel(mod, O.makeHarness({ config: { entries: [C.makeEntry({ id: "x", type: "openai" })] } }));
  assert.equal(withEntries.view().officialToggle.checked, true, "仅字段缺省时也开启（SET-005 缺省=开）");

  const off = await O.openPanel(mod, O.makeHarness({ config: C.makeSavedConfig([], { useOfficialDeepSeekSearch: false }) }));
  assert.equal(off.view().officialToggle.checked, false, "已保存的关闭状态须如实显示");
});

test("SET-005：开关旁文案写明适用会话、关闭后使用下方工具链，并说明官方搜索不另计费与 token 计费", async (t) => {
  const mod = await O.loadClient(t, "SET-005");
  if (!mod) return;
  const panel = await O.openPanel(mod, O.makeHarness({ config: {} }));
  const hint = panel.view().officialToggle.hint;
  assert.ok(typeof hint === "string" && hint.length > 0, "开关旁须有说明文案");
  for (const re of O.OFFICIAL_HINT_KEYWORDS) {
    assert.match(hint, re, `开关文案须涵盖要素 ${re}（SET-005；措辞不钉死）`);
  }
});

test("SET-005：切换开关不自动保存、不发出请求；保存后状态持久化", async (t) => {
  const mod = await O.loadClient(t, "SET-005");
  if (!mod) return;
  const h = O.makeHarness({ config: O.savedFixture() });
  const panel = await O.openPanel(mod, h);
  const callsBefore = h.host.editor.calls.length;

  panel.setOfficialSearch(false);
  assert.equal(panel.view().officialToggle.checked, false, "界面即时反映切换");
  assert.equal(h.host.editor.calls.length, callsBefore, "切换不得自动保存（DSH-003 / SET-004）");
  assert.equal(h.host.settingsPort.current().useOfficialDeepSeekSearch, true, "未保存前宿主仍为开启");
  assert.equal(h.fetchTrap.calls.length + h.chainTrap.calls.length, 0, "切换不得发出请求");

  assert.equal(await O.trySave(panel), null);
  assert.equal(h.host.settingsPort.current().useOfficialDeepSeekSearch, false);
  const reopened = await O.openPanel(mod, h);
  assert.equal(reopened.view().officialToggle.checked, false, "重开后关闭状态持久化（SET-005 验收）");
});

test("SET-005：切换官方开关不改动自定义列表的配置与位置", async (t) => {
  const mod = await O.loadClient(t, "SET-005");
  if (!mod) return;
  const h = O.makeHarness({ config: O.savedFixture() });
  const panel = await O.openPanel(mod, h);
  const ids = O.cardIds(panel);
  const entries = ids.map((id) => panel.draftEntry(id));

  panel.setOfficialSearch(false);
  panel.setOfficialSearch(true);
  panel.setOfficialSearch(false);

  assert.deepEqual(O.cardIds(panel), ids, "切换开关不改变条目位置（SET-005 验收）");
  assert.deepEqual(ids.map((id) => panel.draftEntry(id)), entries, "切换开关不改变条目配置");
  assert.equal(await O.trySave(panel), null);
  assert.deepEqual(entriesOf(h).map((e) => e.id), ids, "保存后列表与切换前一致");
});

// ═══════════════════════════════ CAT-001 首期类型目录 ═══════════════════════════════

test("CAT-001：目录恰为七种类型，供应商归并正确，需要 key 的类型含凭据字段，Bing 不含", async (t) => {
  const mod = await O.loadClient(t, "CAT-001");
  if (!mod) return;
  const panel = await O.openPanel(mod, O.makeHarness({ config: {} }));
  const catalog = panel.catalog();

  assert.deepEqual([...catalog.map((x) => x.type)].sort(), [...C.TOOL_TYPES].sort(), "首期须提供且仅提供七种类型（CAT-001）");
  for (const item of catalog) {
    assert.equal(item.supplier, C.supplierOfToolType(item.type), `供应商归并：${item.type}`);
    assert.ok(typeof item.label === "string" && item.label.length > 0, `${item.type} 须有显示名`);
    assert.ok(Array.isArray(item.fields), `${item.type} 的 fields 必须是数组`);
    if (C.KEYLESS_TYPES.includes(item.type)) {
      assert.ok(!item.fields.includes("credential"), "Bing RSS 免 key，不得显示凭据字段（CAT-001）");
    } else {
      assert.ok(item.fields.includes("credential"), `${item.type} 需要 key，须显示凭据字段（CAT-001）`);
    }
  }
});

test("CAT-001：每种类型带简明计费说明，规格明确的要素按关键词出现", async (t) => {
  const mod = await O.loadClient(t, "CAT-001");
  if (!mod) return;
  const panel = await O.openPanel(mod, O.makeHarness({ config: {} }));
  const byType = Object.fromEntries(panel.catalog().map((x) => [x.type, x]));

  for (const type of C.TOOL_TYPES) {
    assert.ok(typeof byType[type]?.billingNote === "string" && byType[type].billingNote.length > 0, `${type} 须有计费说明（CAT-001）`);
  }
  for (const [type, res] of Object.entries(O.BILLING_KEYWORDS)) {
    for (const re of res) {
      assert.match(byType[type].billingNote, re, `${type} 计费说明须含规格要素 ${re}（T-6；措辞不钉死）`);
    }
  }
});

test("CAT-001：DeepSeek 两模式同属 deepseek 供应商，编辑页可切换且保留 id 与位置，并显示模式字段", async (t) => {
  const mod = await O.loadClient(t, "CAT-001");
  if (!mod) return;
  const h = O.makeHarness({
    config: C.makeSavedConfig([
      C.makeEntry({ id: "first", type: "openai" }),
      C.makeEntry({ id: "ds", type: "deepseek-search", name: "DeepSeek" }),
    ]),
  });
  const panel = await O.openPanel(mod, h);
  const catalog = Object.fromEntries(panel.catalog().map((x) => [x.type, x]));

  for (const type of ["deepseek-search", "deepseek-agentic-search"]) {
    assert.equal(catalog[type].supplier, "deepseek", `${type} 归属 deepseek 供应商`);
    assert.ok(catalog[type].fields.includes("mode"), `${type} 须显示模式字段（CAT-001：DeepSeek 可选 Search API 或 Agentic Search）`);
    assert.ok(catalog[type].fields.includes("credential"), `${type} 需要 DEEPSEEK_API_KEY 凭据字段`);
  }

  panel.editEntry("ds", { type: "deepseek-agentic-search" });
  assert.equal(panel.draftEntry("ds").type, "deepseek-agentic-search");
  assert.deepEqual(O.cardIds(panel), ["first", "ds"], "切换模式不改变 id 与位置");
});
