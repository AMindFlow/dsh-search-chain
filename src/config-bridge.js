// 宿主半配置桥（Issue #46，docs/specs/draft/bundle-config-ui.md BCF-003/004/005）。
//
// createConfigBridge(settings) → { "config.get": fn, "config.put": fn }
//   settings 与 config.js 的 readConfig / writeConfig 同形：{ editor, entry, current() }。
//   组件侧（client-entry.js）经 host.call("config.get"/"config.put", input) 调用这两个方法。
//
// 合并写语义（BCF-004）：
//   - 表单只覆盖自己管理的字段：entries（整体列表权威，顺序 = 优先级）、useOfficialDeepSeekSearch、
//     timeoutMs；表单省略的管理键保持当前值，不重置缺省。
//   - 条目内只覆盖 MANAGED_ENTRY_KEYS（id/type/name/enabled/credentialRef）；其余字段（既有 apiKey、
//     未知标量与对象字段）原样保留，表单产物中的明文字段一律忽略、不落盘，不新增 apiKey。
//   - credentialRef 空串 = 删除引用（与 normalizeConfig 读路径同义）。
//   - 写入 raw 层合并结果（不写 normalizeConfig 产物，否则既有 apiKey 与对象型未知字段会被清洗）；
//     normalizeConfig 只作写闸：校验不过则零写入。
//
// 错误回传（BCF-003/005）：读取故障 → { ok:false, code, message }；写闸拒绝 → CONFIG_INVALID + issues；
// 宿主写入失败 → CONFIG_SAVE_FAILED，message 固定且不回显负载或凭据（writeConfig 同一裁决，CFG-003）。
import { CONFIG_CODES } from "./constants.js";
import { ConfigError, normalizeConfig, readConfig } from "./config.js";

/** 表单管理的条目子字段；其余条目字段在合并时保留既有值。 */
const MANAGED_ENTRY_KEYS = ["id", "type", "name", "enabled", "credentialRef"];
/** 表单管理的顶层键（entries / 开关 / 超时）；其余顶层键（未知/他插件）保留。 */
const MANAGED_TOP_KEYS = ["useOfficialDeepSeekSearch", "timeoutMs"];

const SAVE_FAILED_MESSAGE = "保存搜索配置失败，已生效配置保持不变，请重试";
const READ_UNAVAILABLE_MESSAGE = "读取本插件配置失败：配置行不可用，请关闭后重新打开配置表单";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 读取故障：ConfigError 保留其 code 与文案；其余（配置行不可用等）统一为 ROW_UNAVAILABLE 固定文案。 */
function readFailure(err) {
  if (err instanceof ConfigError) return { ok: false, code: err.code, message: err.message };
  return { ok: false, code: CONFIG_CODES.ROW_UNAVAILABLE, message: READ_UNAVAILABLE_MESSAGE };
}

function invalid(issues) {
  const list = issues.map((i) => ({ message: i.message }));
  return {
    ok: false,
    code: CONFIG_CODES.INVALID,
    issues: list,
    message: `配置未保存：${list.map((i) => i.message).join("；")}`,
  };
}

/** 按 id 找到既有条目（仅用于取回未管理字段；表单给出的 id 是行标识）。 */
function indexPrior(entries) {
  const prior = new Map();
  if (!Array.isArray(entries)) return prior;
  for (const e of entries) {
    if (isPlainObject(e) && typeof e.id === "string") prior.set(e.id, e);
  }
  return prior;
}

/** 单条目合并：既有条目为底，仅覆盖管理子字段；非对象原样交给写闸拒绝。 */
function mergeEntry(prior, formEntry) {
  if (!isPlainObject(formEntry)) return formEntry;
  const saved = typeof formEntry.id === "string" ? prior.get(formEntry.id) : undefined;
  const next = saved ? { ...saved } : {};
  for (const key of MANAGED_ENTRY_KEYS) {
    if (formEntry[key] !== undefined) next[key] = formEntry[key];
  }
  if (next.credentialRef === "") delete next.credentialRef;
  return next;
}

/**
 * 合并表单到 base（只产出管理键；未知键由调用方决定是否保留）。
 * base 缺某管理键且表单也未给 → 不产出该键（不凭空补缺省）。
 */
function mergeManaged(base, form) {
  const out = {};
  if (form.entries !== undefined) {
    const prior = indexPrior(base.entries);
    out.entries = form.entries.map((fe) => mergeEntry(prior, fe));
  } else if (base.entries !== undefined) {
    out.entries = base.entries;
  }
  for (const key of MANAGED_TOP_KEYS) {
    if (form[key] !== undefined) out[key] = form[key];
    else if (base[key] !== undefined) out[key] = base[key];
  }
  return out;
}

/**
 * @param {{ editor: { edit(entry: unknown, mutate: (raw: object, inherited: object) => object): Promise<void> }, entry: unknown, current(): object }} settings
 * @returns {{ "config.get": () => Promise<object>, "config.put": (form?: object) => Promise<object> }}
 */
export function createConfigBridge(settings) {
  async function getConfig() {
    try {
      return { ok: true, config: readConfig(settings) };
    } catch (err) {
      return readFailure(err);
    }
  }

  async function putConfig(form = {}) {
    if (!isPlainObject(form)) return invalid([{ message: "表单产物必须是对象" }]);
    if (form.entries !== undefined && !Array.isArray(form.entries)) {
      return invalid([{ message: "entries 必须是数组" }]);
    }

    let current;
    try {
      const snapshot = settings.current();
      current = isPlainObject(snapshot) ? structuredClone(snapshot) : {};
    } catch (err) {
      return readFailure(err);
    }

    // 写闸：合并候选过 normalizeConfig；拒绝即零写入（BCF-005）。
    const candidate = { ...current, ...mergeManaged(current, form) };
    try {
      normalizeConfig(candidate);
    } catch (err) {
      const text = err instanceof ConfigError ? err.message : "配置未通过校验";
      return invalid([{ message: text }]);
    }

    try {
      await settings.editor.edit(settings.entry, (raw, inherited) => {
        const layer = isPlainObject(raw) ? raw : {};
        const effective = { ...(isPlainObject(inherited) ? inherited : {}), ...layer };
        // 写合并 raw：保留 override 层未知键，仅替换管理键。
        return { ...layer, ...mergeManaged(effective, form) };
      });
    } catch {
      // 不附宿主 cause：宿主报错可能回显被拒负载（含明文 key，CFG-003）。
      return { ok: false, code: CONFIG_CODES.SAVE_FAILED, message: SAVE_FAILED_MESSAGE };
    }

    try {
      return { ok: true, config: readConfig(settings) };
    } catch (err) {
      return readFailure(err);
    }
  }

  return {
    "config.get": () => getConfig(),
    "config.put": (form) => putConfig(form),
  };
}
