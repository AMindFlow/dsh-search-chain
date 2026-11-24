// 配置、凭据与代理形状（CFG-001..004，SET-005，FB-003 默认值）。
// 只做校验、快照和 key 解析；不发起网络请求，不写宿主全局代理。
import {
  CONFIG_CODES,
  DEFAULT_TIMEOUT_MS,
  KEY_ENV_BY_TYPE,
  KEYLESS_TYPES,
  LEGACY_YAML_SUPPLIERS,
  TOOL_TYPES,
  TRUSTED_ENV_KEYS,
  supplierOfToolType,
} from "./constants.js";

/** 配置类错误：携带 CONFIG_CODES 之一的 code，message 不含任何凭据。 */
export class ConfigError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ConfigError";
    this.code = code;
  }
}

const SECRET_FIELD = /^(apikey|api_key|key|secret|token|password|auth|authorization)$/i;
const HANDLED_ENTRY_FIELDS = new Set(["id", "type", "name", "enabled", "credentialRef", "proxy"]);

function invalid(message) {
  return new ConfigError(CONFIG_CODES.INVALID, message);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function assertHttpUrl(text, where) {
  let u;
  try {
    u = new URL(text);
  } catch {
    throw invalid(`${where} 必须是绝对 HTTP(S) URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw invalid(`${where} 必须是 HTTP(S) URL`);
  }
}

/** CFG-001：proxy 为 string（HTTP(S) 代理 URL）| { pac } | 省略/空白=直连。 */
function normalizeProxy(raw, where) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s === "") return undefined;
    assertHttpUrl(s, `${where}.proxy`);
    return s;
  }
  if (isPlainObject(raw) && Object.keys(raw).length === 1 && typeof raw.pac === "string") {
    const pac = raw.pac.trim();
    if (pac === "") throw invalid(`${where}.proxy.pac 不得为空白`);
    assertHttpUrl(pac, `${where}.proxy.pac`);
    return { pac };
  }
  throw invalid(`${where}.proxy 形态非法（须为代理 URL 字符串或 { pac }）`);
}

function normalizeEntry(raw, index) {
  const where = `entries[${index}]`;
  if (!isPlainObject(raw)) throw invalid(`${where} 必须是对象`);
  if (typeof raw.id !== "string" || raw.id.trim() === "") throw invalid(`${where}.id 必须是非空字符串`);
  if (typeof raw.type !== "string" || !TOOL_TYPES.includes(raw.type)) {
    throw invalid(`${where}.type 不是已知工具类型`);
  }
  const name = raw.name === undefined ? raw.type : raw.name;
  if (typeof name !== "string") throw invalid(`${where}.name 必须是字符串`);
  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof enabled !== "boolean") throw invalid(`${where}.enabled 必须是布尔值`);

  const out = { id: raw.id.trim(), type: raw.type, name, enabled };

  if (raw.credentialRef !== undefined && raw.credentialRef !== null && raw.credentialRef !== "") {
    if (typeof raw.credentialRef !== "string" || raw.credentialRef.trim() === "") {
      throw invalid(`${where}.credentialRef 非法`);
    }
    out.credentialRef = raw.credentialRef.trim();
  }
  const proxy = normalizeProxy(raw.proxy, where);
  if (proxy !== undefined) out.proxy = proxy;

  // 其余参数只保留原始标量；对象与明文 key 字段一律丢弃（CFG-003：明文 key 不落盘）。
  for (const [k, v] of Object.entries(raw)) {
    if (HANDLED_ENTRY_FIELDS.has(k) || SECRET_FIELD.test(k)) continue;
    if (["string", "number", "boolean"].includes(typeof v)) out[k] = v;
  }
  return out;
}

/**
 * 校验并规范化已保存形状（CFG-004）。非法输入抛 ConfigError(CONFIG_INVALID)。
 * 缺省：entries=[]、useOfficialDeepSeekSearch=true（SET-005）、timeoutMs=25000（FB-003）。
 */
export function normalizeConfig(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isPlainObject(raw)) throw invalid("配置必须是对象");

  const rawEntries = raw.entries === undefined ? [] : raw.entries;
  if (!Array.isArray(rawEntries)) throw invalid("entries 必须是数组");
  const entries = rawEntries.map((e, i) => normalizeEntry(e, i));
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.id)) throw invalid(`entries 中 id 重复：${e.id}`);
    seen.add(e.id);
  }

  const useOfficial = raw.useOfficialDeepSeekSearch === undefined ? true : raw.useOfficialDeepSeekSearch;
  if (typeof useOfficial !== "boolean") throw invalid("useOfficialDeepSeekSearch 必须是布尔值");

  const timeoutMs = raw.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : raw.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw invalid("timeoutMs 必须是正整数毫秒");
  }

  return { entries, useOfficialDeepSeekSearch: useOfficial, timeoutMs };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * 读取冻结快照（CFG-004）。settings = { editor, entry, current() }。
 * 快照与宿主当前对象脱钩；后续保存不改变已读出的快照。
 */
export function readConfig(settings) {
  const current = settings.current();
  return deepFreeze(normalizeConfig(structuredClone(current ?? {})));
}

/** 本插件在 override 层自有的顶层配置键（normalizeConfig 输出键集）；写入时整体替换，其余键（未知/他插件）保留。 */
const OWN_CONFIG_KEYS = ["entries", "useOfficialDeepSeekSearch", "timeoutMs"];

/**
 * 校验后经 configEditor 写入（CFG-004）。非法输入在写入前即抛错；
 * 宿主保存失败抛 ConfigError(CONFIG_SAVE_FAILED)，已生效快照不变。
 * editor.edit 第二参为变异函数 (raw, inherited) => newRawLayer，返回新 raw 整体对象落该行 override 层。
 */
export async function writeConfig(settings, next) {
  const normalized = normalizeConfig(structuredClone(next ?? {}));
  try {
    await settings.editor.edit(settings.entry, (raw) => {
      const merged = { ...(raw ?? {}) };
      for (const k of OWN_CONFIG_KEYS) delete merged[k];
      return { ...merged, ...structuredClone(normalized) };
    });
  } catch (cause) {
    throw new ConfigError(CONFIG_CODES.SAVE_FAILED, "保存搜索配置失败，已生效配置保持不变", { cause });
  }
  return readConfig(settings);
}

function nonblank(value) {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t === "" ? undefined : t;
}

/**
 * CFG-002 key 解析（只解析实际准备尝试的条目；上层命中即停止）：
 *   条目 credentialRef → 白名单环境变量 → DSH 托管记录 → 旧版 YAML（仅 openai/tavily/deepseek）。
 * 返回 { key } 或 null（缺失，由链按 SKIPPED_NO_KEY 处理）。免 key 类型直接返回 null，零读取。
 */
export async function resolveEntryApiKey(entry, { env, credentials, legacyYaml } = {}) {
  if (KEYLESS_TYPES.includes(entry.type)) return null;
  const envName = KEY_ENV_BY_TYPE[entry.type];
  if (!envName) return null;

  if (entry.credentialRef) {
    let value;
    try {
      value = await credentials.resolve(entry.credentialRef);
    } catch (cause) {
      throw new ConfigError(
        CONFIG_CODES.CREDENTIALS_UNREADABLE,
        `条目「${entry.name}」的凭据引用无法读取，请在设置中重新保存该条目的 API key`,
        { cause },
      );
    }
    const key = nonblank(value);
    if (key) return { key };
  }

  if (TRUSTED_ENV_KEYS.includes(envName)) {
    const key = nonblank(env?.[envName]);
    if (key) return { key };
  }

  let record;
  try {
    record = await credentials.readRecord(envName);
  } catch (cause) {
    throw new ConfigError(CONFIG_CODES.CREDENTIALS_UNREADABLE, `DSH 托管凭据 ${envName} 无法读取`, { cause });
  }
  const recordKey = nonblank(record?.value);
  if (recordKey) return { key: recordKey };

  const supplier = supplierOfToolType(entry.type);
  if (legacyYaml && LEGACY_YAML_SUPPLIERS.includes(supplier)) {
    let legacy;
    try {
      legacy = legacyYaml[supplier];
    } catch (cause) {
      throw new ConfigError(CONFIG_CODES.CREDENTIALS_UNREADABLE, `旧版凭据文件无法解析（供应商 ${supplier}）`, { cause });
    }
    const legacyKey = nonblank(legacy);
    if (legacyKey) return { key: legacyKey };
  }

  return null;
}
