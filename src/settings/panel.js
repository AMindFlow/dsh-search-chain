// WP12 设置面板 — 数据层（逻辑端口面，oracle 见 test/helpers/settings-oracle.js 头注）。
//
// 规格来源：docs/specs/draft/settings-ui.md SET-001…SET-005、providers.md CAT-001、
// config-network.md CFG-001/CFG-002/CFG-003/CFG-004、fallback.md FB-001/FB-003。
//
// 职责边界：
//   本模块只做「面板数据」——条目列表渲染数据、启用开关、顺序（拖动/键盘等价）、
//   每条目 type/key 状态与 priority 展示字段、SET-005 官方开关行、保存与冲突检测、
//   凭据只写不读（CFG-003 UI 层）。它不渲染 DOM、不接触主题、不发任何供应商请求
//   （SET-004：打开/切换/排序/保存供应商请求数为零；注入的 fetch/chain 是陷阱，绝不使用）。
//
// 对 config 模块的调用经 seam 注入：
//   settings = { editor, entry, current() }（CFG-004 唯一配置入口；fake-host.settingsPort 同形）。
//   面板不 import src/config.js（WP1）：WP1 未合入时面板必须可独立验收（DAG：WP12 可按 WP0
//   接口先验证界面交互）；常量与校验语义本地镜像 catalog.js / proxy.js（同步义务见两文件头注）。
//   WP1 合入后 index.js（WP6 装配）将真实宿主读写接入同一端口，面板代码不变。
//
// 保存语义（SET-004 / CFG-004）：
//   - 一切编辑都只改草稿；保存前宿主快照不变，editor 恰好调用一次。
//   - 保存前检测版本冲突：current() 与 open() 时基线不同 = 配置已被其他界面改动，
//     不覆盖外部改动，界面给出 CONFIG_CONFLICT（T-3 假设；冻结测试亦接受 SAVE_FAILED），草稿保留。
//   - editor 写入失败（宿主拒绝/异常）→ SAVE_FAILED，已生效快照保持不变，草稿保留可重试。
//   - 成功 → 基线刷新为最新快照，dirty 清零，saveError 清除。

import {
  CATALOG,
  CONFLICT_CODE,
  CONFIG_CODES,
  DEFAULT_TIMEOUT_MS,
  EMPTY_TEXT,
  ADD_ACTION_LABEL,
  KEYLESS_TYPES,
  OFFICIAL_HINT,
  TOOL_TYPES,
  catalogRow,
  configError,
  entryStatus,
  typeLabelOf,
} from "./catalog.js";
import { validateProxy } from "./proxy.js";

/** 条目凭据引用命名（宿主托管 ref 的真实格式属 H 清单实机项；此处只要求稳定且全局唯一）。 */
const CREDENTIAL_REF_PREFIX = "search-chain-credential:";

let idCounter = 0; // 模块级单调计数：保证同进程内新生成 id 不复用（T-1：格式不钉死）

function deepClone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/** 结构化深比较（配置数据为 JSON 安全集；键序无关，NaN/undefined 语义按 JSON 值处理）。 */
function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.hasOwn(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

/** 把宿主错误消息中的秘密值替换为占位（CFG-003：错误文案不泄露凭据）。 */
function redactSecrets(message, secrets) {
  let out = typeof message === "string" ? message : String(message ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0 && out.includes(secret)) {
      out = out.split(secret).join("****");
    }
  }
  return out;
}

/**
 * 面板状态机（createSettingsPanel 返回的对象）。
 * @param {{
 *   settings: { editor: { edit(target, change): Promise<any> }, entry: object, current(): any },
 *   credentials: { set(ref, value): Promise<any>, resolve?(ref): Promise<string|undefined> },
 *   fetch?: Function,   // SET-004 陷阱：面板不得使用
 *   chain?: object,     // SET-004 陷阱：面板不得使用
 *   now?: () => number, // 可选时钟（id 生成用；缺省 Date.now）
 * }} deps
 */
export function createSettingsPanel(deps) {
  if (
    !deps ||
    !deps.settings ||
    typeof deps.settings.current !== "function" ||
    typeof deps.settings.editor?.edit !== "function"
  ) {
    throw configError(CONFIG_CODES.INVALID, "createSettingsPanel：settings 端口（editor.edit/entry/current）必填");
  }
  const settings = deps.settings;
  const credentials = deps.credentials ?? null;

  const state = {
    opened: false,
    base: null, // open() 时的宿主快照（版本冲突基线；保存成功后刷新）
    official: true, // SET-005 草稿开关
    entries: [], // 草稿条目（顺序即列表/执行顺序，SET-003）
    pendingKeys: new Map(), // id → { ref: string|null, value: string }（apiKey 只写不读，绝不进条目/视图）
    pendingRemoveId: null,
    dirty: false,
    saveError: null,
    unregister: null, // mountSettingsSection 幂等句柄
  };

  const nowFn = typeof deps.now === "function" ? deps.now : () => Date.now();

  // ─── 读取与视图 ───────────────────────────────────────────────────────────

  /**
   * 读取宿主快照生成草稿（readConfig 语义经 settings 端口：current() 即唯一配置读数）。
   * 缺省补默认（SET-005 缺省开启；timeoutMs 面板不编辑，仅随宿主原样保留，FB-003 默认 25000）。
   */
  async function open() {
    const raw = settings.current();
    state.base = deepClone(raw) ?? {};
    const source = state.base;
    state.entries = Array.isArray(source.entries) ? deepClone(source.entries) : [];
    state.official =
      typeof source.useOfficialDeepSeekSearch === "boolean" ? source.useOfficialDeepSeekSearch : true;
    state.pendingKeys = new Map();
    state.pendingRemoveId = null;
    state.dirty = false;
    state.saveError = null;
    state.opened = true;
    return view();
  }

  /** 视图（同步；只含状态，不含任何 key 值）。每次调用返回新对象。 */
  function view() {
    return {
      officialToggle: { checked: state.official, hint: OFFICIAL_HINT },
      emptyState: state.entries.length === 0,
      ...(state.entries.length === 0 ? { emptyText: EMPTY_TEXT } : {}),
      addAction: { label: ADD_ACTION_LABEL },
      cards: state.entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        type: entry.type,
        typeLabel: typeLabelOf(entry.type),
        enabled: entry.enabled,
        status: entryStatus(entry),
        editable: true,
        removable: true,
      })),
      pendingRemoveId: state.pendingRemoveId,
      dirty: state.dirty,
      saveError: state.saveError,
    };
  }

  /** CAT-001 目录（每类型 { type, label, supplier, fields, billingNote }）。 */
  function catalog() {
    return structuredClone(CATALOG);
  }

  /** 草稿条目深拷贝（测试观测用；条目本身不含明文 key，apiKey 只存在于 pendingKeys）。 */
  function draftEntry(id) {
    const entry = state.entries.find((e) => e.id === id);
    return entry ? deepClone(entry) : null;
  }

  // ─── 草稿命令（全部同步；非法值立即抛 CONFIG_CODES.INVALID 且草稿不变）────────

  function requireOpened() {
    if (!state.opened) {
      throw configError(CONFIG_CODES.INVALID, "面板尚未 open()，无法执行命令");
    }
  }

  function findEntry(id) {
    return state.entries.find((e) => e.id === id);
  }

  /** 生成稳定唯一 id（T-1：不钉格式；唯一、不复用、不冲突）。 */
  function generateId(type) {
    const stamp = nowFn().toString(36);
    const existing = new Set(state.entries.map((e) => e.id));
    let candidate = "";
    do {
      idCounter += 1;
      candidate = `e-${type}-${stamp}-${idCounter.toString(36)}`;
    } while (existing.has(candidate));
    return candidate;
  }

  /**
   * SET-002 添加工具：追加末尾、默认启用。type 必须是 CAT-001 目录内类型，否则 INVALID。
   * @returns {string} 新条目 id
   */
  function addTool(type) {
    requireOpened();
    if (typeof type !== "string" || !TOOL_TYPES.includes(type)) {
      throw configError(CONFIG_CODES.INVALID, `添加工具失败：类型「${String(type)}」不在首期目录（CAT-001）内`);
    }
    const row = catalogRow(type);
    const entry = {
      id: generateId(type),
      type,
      name: row.label,
      enabled: true, // SET-002：保存后该条目追加到末尾并启用
    };
    state.entries.push(entry);
    state.dirty = true;
    return entry.id;
  }

  /**
   * SET-002 编辑条目：patch 可含 name / type / proxy / apiKey。
   * 全部字段先校验后落草稿（被拒绝的编辑草稿不变）。
   *   - name：非空字符串；
   *   - type：CAT-001 目录内类型（DeepSeek 两模式互切保留 id 与位置）；
   *   - proxy：CFG-001 三形态（委托语义见 proxy.js 头注）；
   *   - apiKey：只写不读（CFG-003）——记录到 pendingKeys，保存时经宿主凭据服务落为引用；
   *     纯空白视为未提供（无操作）；免 key 类型（Bing RSS）不接受 key。
   */
  function editEntry(id, patch) {
    requireOpened();
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      throw configError(CONFIG_CODES.INVALID, "编辑条目失败：patch 必须是对象");
    }
    const entry = findEntry(id);
    if (!entry) {
      throw configError(CONFIG_CODES.INVALID, `编辑条目失败：条目「${String(id)}」不存在`);
    }

    // 先校验全部字段，任一非法即抛错且不改草稿。
    let nextName = undefined;
    let nextType = undefined;
    let nextProxy = undefined; // undefined = patch 未含 proxy；否则为 validateProxy 结果
    let nextApiKey = undefined;
    let hasProxyKey = false;
    for (const [key, value] of Object.entries(patch)) {
      if (key === "name") {
        if (typeof value !== "string" || value.trim() === "") {
          throw configError(CONFIG_CODES.INVALID, "编辑条目失败：名称必须是非空字符串");
        }
        nextName = value;
      } else if (key === "type") {
        if (typeof value !== "string" || !TOOL_TYPES.includes(value)) {
          throw configError(CONFIG_CODES.INVALID, `编辑条目失败：类型「${String(value)}」不在首期目录（CAT-001）内`);
        }
        nextType = value;
      } else if (key === "proxy") {
        hasProxyKey = true;
        const verdict = validateProxy(value);
        if (verdict === null) {
          throw configError(
            CONFIG_CODES.INVALID,
            "编辑条目失败：代理须为 HTTP(S) URL 或 { pac: HTTP(S) URL }，空白即直连（CFG-001）",
          );
        }
        nextProxy = verdict;
      } else if (key === "apiKey") {
        if (typeof value !== "string") {
          throw configError(CONFIG_CODES.INVALID, "编辑条目失败：apiKey 必须是字符串");
        }
        if (value.trim() !== "") {
          if (KEYLESS_TYPES.includes(entry.type)) {
            throw configError(CONFIG_CODES.INVALID, "编辑条目失败：该类型免 key，不接受凭据输入（CFG-002）");
          }
          nextApiKey = value.trim();
        }
        // 纯空白 = 未提供：不改动既有凭据引用（清空语义未冻结，见报告契约意见增量）。
      }
      // 其余键（如 model）不是本面板数据层字段：忽略（条目自定义参数归 WP1/WP6 编辑面扩展）。
    }

    // 校验通过 → 落草稿。
    if (nextName !== undefined) entry.name = nextName;
    if (nextType !== undefined) entry.type = nextType;
    if (hasProxyKey) {
      if (nextProxy.kind === "direct") delete entry.proxy; // 空白=直连：已保存形状省略 proxy
      else entry.proxy = deepClone(nextProxy.value);
    }
    if (nextApiKey !== undefined) {
      // 已有引用则沿用（更新值），否则保存时按条目生成新引用。
      const ref =
        typeof entry.credentialRef === "string" && entry.credentialRef.length > 0
          ? entry.credentialRef
          : null;
      state.pendingKeys.set(id, { ref, value: nextApiKey });
    }
    state.dirty = true;
  }

  /** SET-002 启用/停用（只改草稿；停用保留配置与位置）。 */
  function setEnabled(id, enabled) {
    requireOpened();
    const entry = findEntry(id);
    if (!entry) return; // 未知 id 无操作（UI 只会对现存卡片调用）
    entry.enabled = Boolean(enabled);
    state.dirty = true;
  }

  // ─── 移除确认语义（SET-002）──────────────────────────────────────────────

  function requestRemove(id) {
    requireOpened();
    if (!findEntry(id)) return;
    state.pendingRemoveId = id;
  }

  function cancelRemove() {
    requireOpened();
    state.pendingRemoveId = null;
  }

  function confirmRemove(id) {
    requireOpened();
    if (state.pendingRemoveId !== id) return; // 只确认当前待移除条目
    state.entries = state.entries.filter((e) => e.id !== id);
    state.pendingKeys.delete(id); // 未保存的 key 随条目作废，绝不落凭据服务
    state.pendingRemoveId = null;
    state.dirty = true;
    // 注意：不调用 credentials.unset——复用的宿主凭据不得被移除（SET-002/CFG-003）。
  }

  // ─── 顺序（SET-003：拖动把手与键盘上移/下移等价）──────────────────────────

  function reorder(id, toIndex) {
    requireOpened();
    const from = state.entries.findIndex((e) => e.id === id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(state.entries.length - 1, Math.trunc(toIndex)));
    if (to === from) return;
    const [moved] = state.entries.splice(from, 1);
    state.entries.splice(to, 0, moved);
    state.dirty = true;
  }

  function moveUp(id) {
    requireOpened();
    const from = state.entries.findIndex((e) => e.id === id);
    if (from <= 0) return; // 首项上移为无操作（T-8）
    reorder(id, from - 1);
  }

  function moveDown(id) {
    requireOpened();
    const from = state.entries.findIndex((e) => e.id === id);
    if (from < 0 || from >= state.entries.length - 1) return; // 末项下移为无操作（T-8）
    reorder(id, from + 1);
  }

  /** SET-005 官方搜索开关（只改草稿；路由效果由 DSH-005 定义，面板不触达路由）。 */
  function setOfficialSearch(enabled) {
    requireOpened();
    state.official = Boolean(enabled);
    state.dirty = true;
  }

  // ─── 保存（SET-004 / CFG-004）────────────────────────────────────────────

  function markSaveError(code, message) {
    const secrets = [...state.pendingKeys.values()].map((p) => p.value);
    state.saveError = { code, message: redactSecrets(message, secrets) };
  }

  /**
   * 保存草稿到宿主（唯一写入入口 settings.editor，目标 settings.entry）。
   * 成功：恰好一次 editor 写入，基线刷新，dirty/saveError 清零。
   * 失败（冲突或写入异常）：已生效快照不变，草稿保留，view().saveError 为界面真值，
   * 同时 reject（oracle：save() 可 reject 或 resolve，调用方以 view().saveError 为准）。
   */
  async function save() {
    requireOpened();

    // 1) 版本冲突：面板打开后配置已被其他界面改动 → 不覆盖外部改动（SET-004）。
    const current = settings.current();
    if (!deepEqual(current, state.base)) {
      const message = "配置已被其他界面修改；未保存的编辑已保留，请重新打开面板核对差异后再保存。";
      markSaveError(CONFLICT_CODE, message);
      throw configError(CONFLICT_CODE, message);
    }

    // 2) 凭据落引用（CFG-002/CFG-003：明文 key 经宿主凭据服务保存为引用；key 只写不读）。
    for (const [id, pending] of state.pendingKeys) {
      const entry = findEntry(id);
      if (!entry) continue;
      if (!credentials || typeof credentials.set !== "function") {
        const message = "保存失败：当前宿主未提供凭据服务，无法保存凭据输入。";
        markSaveError(CONFIG_CODES.SAVE_FAILED, message);
        throw configError(CONFIG_CODES.SAVE_FAILED, message);
      }
      const ref = pending.ref ?? `${CREDENTIAL_REF_PREFIX}${id}`;
      await credentials.set(ref, pending.value);
      entry.credentialRef = ref;
    }
    state.pendingKeys.clear();

    // 3) 写入宿主：保留基线顶层其余字段（如 timeoutMs），只替换 entries 与官方开关（CFG-004 同一份配置）。
    const candidate = deepClone(state.base);
    candidate.entries = deepClone(state.entries);
    candidate.useOfficialDeepSeekSearch = state.official;
    if (candidate.timeoutMs === undefined) candidate.timeoutMs = DEFAULT_TIMEOUT_MS;

    try {
      await settings.editor.edit(settings.entry, async () => candidate);
    } catch (error) {
      const message = `保存失败：${error?.message ?? String(error)}。已生效的配置未改动，请检查宿主配置状态后重试。`;
      markSaveError(CONFIG_CODES.SAVE_FAILED, message);
      const wrapped = configError(CONFIG_CODES.SAVE_FAILED, message);
      wrapped.cause = error;
      throw wrapped;
    }

    // 4) 成功：基线刷新为最新宿主快照（含宿主可能的规范化），清脏与错误。
    state.base = deepClone(settings.current());
    state.dirty = false;
    state.saveError = null;
  }

  return {
    open,
    view,
    catalog,
    draftEntry,
    addTool,
    editEntry,
    setEnabled,
    requestRemove,
    cancelRemove,
    confirmRemove,
    reorder,
    moveUp,
    moveDown,
    setOfficialSearch,
    save,
    // 内部句柄（mountSettingsSection 幂等用；测试不直接依赖）。
    _state: state,
  };
}
