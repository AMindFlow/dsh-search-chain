// WP12 设置面板 oracle 共享辅助（仅测试用，不属于实现）。
//
// 本文件固化 test/settings-ui.test.js 对 src/client.js 的「逻辑端口面」假设（oracle 假设，
// 实现须满足；任何改名须在 WP12 PR 中同步修改本文件并给出理由）：
//
//   mod = src/client.js
//   mod.createSettingsPanel({ settings, credentials, fetch, chain, now? }) → panel   （同步）
//     settings    : fake-host.settingsPort = { editor, entry, current() }（CFG-004 唯一配置入口）
//     credentials : 宿主凭据替身（ctx.credentials 的 resolve/set/readRecord 面）
//     fetch/chain : 出站与搜索陷阱；面板操作不得调用（SET-004「供应商请求数为零」）
//   panel.open()              → Promise<view>   读取快照生成草稿（经 readConfig 语义）
//   panel.view()              → view（同步；只含状态，不含任何 key 值）
//       view = {
//         officialToggle: { checked: boolean, hint: string },          // SET-005，区域顶端
//         emptyState: boolean, emptyText?: string,
//         addAction: { label: string },
//         cards: [{ id, name, type, typeLabel, enabled, status, editable, removable }],
//         pendingRemoveId: string|null,
//         dirty: boolean,
//         saveError: null | { code: string, message: string },
//       }
//   panel.catalog()           → [{ type, label, supplier, fields: string[], billingNote: string }]
//                               fields 中 "credential" 表示需要 key 字段；deepseek 两模式含 "mode"
//   panel.draftEntry(id)      → 草稿条目深拷贝（测试观测用，不得含明文 key）
//   panel.addTool(type)       → id（同步；追加末尾、默认启用；非法 type 抛 CONFIG_CODES.INVALID）
//   panel.editEntry(id, patch)→ void（同步；patch 可含 name/type/proxy/apiKey；
//                               非法值立即抛 CONFIG_CODES.INVALID 且草稿不变；apiKey 只写不读）
//   panel.setEnabled(id, bool)→ void（只改草稿）
//   panel.requestRemove(id) / cancelRemove() / confirmRemove(id) → void（删除确认语义）
//   panel.reorder(id, toIndex)→ void（拖动重排的命令式结果）
//   panel.moveUp(id) / moveDown(id) → void（键盘等价操作；首末项为无操作）
//   panel.setOfficialSearch(bool) → void（只改草稿）
//   panel.save()              → Promise（成功：恰一次 editor 写入；失败：可 reject 或 resolve，
//                               统一以 view().saveError 为准，见 trySave）
//   mountSettingsSection(slots, panel) → cleanup
//       slots : { register(slot, descriptor) → unregister }（替身，见 createSlotRegistry；
//               真实 settings.section 注册形状待宿主核对，见 settings-ui.test.js 宿主清单）
//
// 失败/缺失：src/client.js 不存在时，loadClient 经 failIfUnimplemented 记红（非 skip）。
import assert from "node:assert/strict";
import * as C from "./contract.js";
import { tryImportSrc, failIfUnimplemented } from "./impl.js";
import { createFakeHost } from "./fake-host.js";
import { loadFixture, FIXTURE_NAMES } from "./fixtures.js";
import { assertNoSecrets } from "./redact.js";

export const WP_CLIENT = "WP12 src/client.js（含 src/settings/）";
export const WP_CONFIG = "WP1 src/config.js";

/** SET-005 开关旁文案须涵盖的要素（关键词断言，不钉死措辞）。 */
export const OFFICIAL_HINT_KEYWORDS = Object.freeze([/会话/, /关闭/, /token/i, /不另/]);

/**
 * CAT-001 计费说明关键要素（来自 providers.md / 各供应商规格）。
 * 只钉规格中明确写出的要素；其余类型只要求非空。
 */
export const BILLING_KEYWORDS = Object.freeze({
  tavily: [/credit/i], // tavily.md：Basic 查询消耗一个 credit
  exa: [/费用/, /用量/], // exa.md：费用随 Exa 搜索和内容用量计算
  gemini: [/计费/], // gemini.md：计费受所选模型和账户影响
  "deepseek-search": [/次/], // deepseek.md：Search API 对有结果的成功请求按次计费
  "deepseek-agentic-search": [/token/i], // deepseek.md：Agentic 不另收搜索次数费用，仍按 token
});

/** 与 contract.js 一致的类型 → 是否需要 key 字段（CAT-001 表）。 */
export const KEYED_TYPES = C.TOOL_TYPES.filter((t) => !C.KEYLESS_TYPES.includes(t));

/** 加载 src/client.js；缺失即红。 */
export async function loadClient(t, clauses) {
  const res = await tryImportSrc("client.js");
  if (failIfUnimplemented(t, res, WP_CLIENT, clauses)) return null;
  return res.module;
}

/** 加载 src/config.js（委托比对用）；缺失即红。 */
export async function loadConfig(t, clauses) {
  const res = await tryImportSrc("config.js");
  if (failIfUnimplemented(t, res, WP_CONFIG, clauses)) return null;
  return res.module;
}

/** 已保存配置样本（去掉 $comment；条目只带 credentialRef，无明文 key）。 */
export function savedFixture() {
  const { $comment: _ignored, ...rest } = loadFixture(FIXTURE_NAMES.savedConfig);
  return structuredClone(rest);
}

/** 同步命令必须抛出指定 CONFIG_CODES 码的错误。 */
export function assertThrowsCode(fn, code, message = "必须抛错") {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, message);
  assert.equal(threw.code, code, `错误码须为 ${code}，实际：${threw.code ?? threw.message}`);
}

/** 同步命令是否会抛错（用于与 normalizeConfig 比对）。 */
export function throwsSync(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/** 陷阱 fetch：面板操作若出站即记录（SET-004：供应商请求数为零）。 */
export function createTrapFetch() {
  const calls = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(String(url));
      throw new Error("synthetic: 设置面板不得出站");
    },
  };
}

/** 陷阱搜索链：面板操作若发起搜索即记录。 */
export function createTrapChain() {
  const calls = [];
  return {
    calls,
    release() {},
    async search(request) {
      calls.push(request);
      throw new Error("synthetic: 设置面板不得发起搜索");
    },
  };
}

/**
 * 插槽注册替身（SET-001 挂载形状）。register 返回 unregister；
 * regs 为当前仍注册的记录数组。
 */
export function createSlotRegistry() {
  const regs = [];
  return {
    regs,
    register(slot, descriptor) {
      const rec = { slot, ...descriptor };
      regs.push(rec);
      return () => {
        const i = regs.indexOf(rec);
        if (i >= 0) regs.splice(i, 1);
      };
    },
  };
}

/** 组合 host 替身与两类陷阱。 */
export function makeHarness({ config = {}, credentials, validate } = {}) {
  // P1-5 inject 收敛：面板消费的宿主服务面只有 credentials（settings 走 settingsPort 结构面），
  // 显式声明后替身才挂载它——host.credentials 句柄（openPanel 的 deps.credentials）即挂载体。
  const host = createFakeHost({ inject: ["credentials"], config, credentials, validate });
  return { host, fetchTrap: createTrapFetch(), chainTrap: createTrapChain() };
}

/** 构造并 open 面板；缺省 deps 与 makeHarness 对齐。 */
export async function openPanel(mod, h, extra = {}) {
  const panel = mod.createSettingsPanel({
    settings: h.host.settingsPort,
    credentials: h.host.credentials,
    fetch: h.fetchTrap.fetch,
    chain: h.chainTrap,
    ...extra,
  });
  await panel.open();
  return panel;
}

/**
 * 保存并统一返回错误（或 null）。实现可 reject 或 resolve 后设置 saveError，
 * 调用方以 panel.view().saveError 作为界面真值。
 */
export async function trySave(panel) {
  try {
    await panel.save();
    return null;
  } catch (e) {
    return e;
  }
}

/** 卡片 id 顺序（界面视觉顺序的真值）。 */
export function cardIds(panel) {
  return panel.view().cards.map((c) => c.id);
}

/** 宿主快照中的条目 id 顺序。 */
export function savedIds(h) {
  return h.host.settingsPort.current().entries.map((e) => e.id);
}

/** 深拷贝的宿主快照（用于前后对比）。 */
export function snapshot(h) {
  return structuredClone(h.host.settingsPort.current());
}

export { createFakeHost, assertNoSecrets, C };
