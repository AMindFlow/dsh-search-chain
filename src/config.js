// 配置、凭据与代理形状（CFG-001..004，SET-005，FB-003 默认值）。
// 只做校验、快照和 key 解析；不发起网络请求，不写宿主全局代理。
//
// WP1 整合轮（feat/2-config-transport，与 main 93b99f4 取并集、以 main 语义为准绳）：
//   - normalizeConfig / readConfig / writeConfig 的校验严格度、错误码（CONFIG_INVALID /
//     CONFIG_SAVE_FAILED）、深冻结与快照不变全部对齐 main 终审语义。
//   - 保留 WP1 独有增量：导出 normalizeProxy（校验语义与 main 一致）、常量再导出面、
//     resolveEntryApiKey 的「停用条目直接 null、零凭据读取」护栏。
//   - 唯一刻意偏离 main 处：writeConfig 的 catch 不附宿主 cause——宿主报错可能回显被拒
//     负载（含明文 key），CFG-003 与 WP1 oracle（config-transport-gaps.test.js）断言
//     返回错误不可达任何秘密（含经 cause 属性）。错误码与文本仍取 main。
//   - 常量面改自主线 constants.js 再导出（移除旧本地镜像，值单一事实源）。
import {
  CONFIG_CODES,
  DEFAULT_TIMEOUT_MS,
  KEY_ENV_BY_TYPE,
  KEYLESS_TYPES,
  LEGACY_YAML_SUPPLIERS,
  PROXY_PINS,
  PROXY_PIN_VALUES,
  TOOL_TYPES,
  TRUSTED_ENV_KEYS,
  supplierOfToolType,
  stripSecretClosure,
} from "./constants.js";

// WP1 导出增量：常量面（值以主线 constants.js 为单一事实源）。
export {
  TOOL_TYPES,
  KEY_ENV_BY_TYPE,
  KEYLESS_TYPES,
  TRUSTED_ENV_KEYS,
  LEGACY_YAML_SUPPLIERS,
  CONFIG_CODES,
  DEFAULT_TIMEOUT_MS,
  PROXY_PINS,
  PROXY_PIN_VALUES,
};

/** 配置类错误：携带 CONFIG_CODES 之一的 code，message 不含任何凭据。 */
export class ConfigError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ConfigError";
    this.code = code;
  }
}

const SECRET_FIELD = /^(apikey|api_key|key|secret|token|password|auth|authorization)$/i;
const POSIX_CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HANDLED_ENTRY_FIELDS = new Set(["id", "type", "name", "enabled", "credentialRef", "proxy", "proxyPin"]);

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

/**
 * CFG-001：proxy 为 string（HTTP(S) 代理 URL）| { pac } | 省略/空白=直连。
 * WP1 导出面：where 为条目位置前缀（如 "entries[0]"，内部调用传入）；缺省时文案以 "proxy" 开头。
 */
export function normalizeProxy(raw, where) {
  const w = where ? `${where}.proxy` : "proxy";
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s === "") return undefined;
    assertHttpUrl(s, w);
    return s;
  }
  if (isPlainObject(raw) && Object.keys(raw).length === 1 && typeof raw.pac === "string") {
    const pac = raw.pac.trim();
    if (pac === "") throw invalid(`${w}.pac 不得为空白`);
    assertHttpUrl(pac, `${w}.pac`);
    return { pac };
  }
  throw invalid(`${w} 形态非法（须为代理 URL 字符串或 { pac }）`);
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

  let proxyPin = PROXY_PINS.INHERIT;
  if (raw.proxyPin !== undefined) {
    if (typeof raw.proxyPin !== "string" || !PROXY_PIN_VALUES.includes(raw.proxyPin)) {
      throw invalid(`${where}.proxyPin 必须是 "inherit" | "directOnly" | "proxyOnly"`);
    }
    proxyPin = raw.proxyPin;
  }
  if (proxy !== undefined && proxyPin !== PROXY_PINS.INHERIT) {
    throw invalid(`${where}.proxyPin 与条目自有 proxy 互斥（已有自有代理时仅允许 inherit）`);
  }
  out.proxyPin = proxyPin;

  // 其余参数只保留原始标量；对象与明文 key 字段一律丢弃（CFG-003：明文 key 不落盘）。
  for (const [k, v] of Object.entries(raw)) {
    if (HANDLED_ENTRY_FIELDS.has(k) || SECRET_FIELD.test(k)) continue;
    if (["string", "number", "boolean"].includes(typeof v)) out[k] = v;
  }
  return out;
}

function normalizeGlobalProxyRef(raw) {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string") {
    throw invalid("globalProxy 只允许保存凭据引用名（禁止非字符串或 null），请改由设置面板保存全局代理地址");
  }
  const s = raw.trim();
  if (s === "") {
    throw invalid("globalProxy 不得为空白字符串（未配置请省略，或在设置面板保存）");
  }
  if (s.includes("://") || s.includes("@")) {
    throw invalid("globalProxy 只允许保存凭据引用名（禁止明文代理 URL），请改由设置面板保存全局代理地址");
  }
  if (!POSIX_CREDENTIAL_REF.test(s)) {
    throw invalid("globalProxy 只允许保存 POSIX 凭据引用名（禁止明文地址或非法字符），请改由设置面板保存全局代理地址");
  }
  return s;
}

/**
 * 校验并规范化已保存形状（CFG-004）。非法输入抛 ConfigError(CONFIG_INVALID)。
 * 缺省：entries=[]、useOfficialDeepSeekSearch=true（SET-005）、timeoutMs=25000（FB-003）、
 * proxyEscalation=false（PX-001）、globalProxy 省略。
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

  const proxyEscalation = raw.proxyEscalation === undefined ? false : raw.proxyEscalation;
  if (typeof proxyEscalation !== "boolean") {
    throw invalid("proxyEscalation 必须是布尔值");
  }

  const globalProxy = normalizeGlobalProxyRef(raw.globalProxy);
  if (proxyEscalation === true && globalProxy === undefined) {
    throw invalid("proxyEscalation 开启前请先配置并保存全局代理地址");
  }

  const out = { entries, useOfficialDeepSeekSearch: useOfficial, timeoutMs, proxyEscalation };
  if (globalProxy !== undefined) out.globalProxy = globalProxy;
  return out;
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
export const OWN_CONFIG_KEYS = Object.freeze([
  "entries",
  "useOfficialDeepSeekSearch",
  "timeoutMs",
  "proxyEscalation",
  "globalProxy",
]);

/**
 * 校验后经 configEditor 写入（CFG-004）。非法输入在写入前即抛错；
 * 宿主保存失败抛 ConfigError(CONFIG_SAVE_FAILED)，已生效快照不变。
 * editor.edit 第二参为变异函数 (raw, inherited) => newRawLayer，返回新 raw 整体对象落该行 override 层。
 * 注意：SAVE_FAILED 错误不附宿主 cause（宿主报错可能回显被拒负载，含明文 key，CFG-003）。
 */
export async function writeConfig(settings, next) {
  const normalized = normalizeConfig(structuredClone(next ?? {}));
  try {
    await settings.editor.edit(settings.entry, (raw) => {
      const merged = { ...(raw ?? {}) };
      for (const k of OWN_CONFIG_KEYS) delete merged[k];
      // #88 第二批②（Refs #88）：raw 保留面先按 secret 字段名闭集递归剥离（任意深度）再 spread 保留其余未知键——
      // PX-009 的降级保留故事只对非 secret 未知键成立（全局代理明文族任何位置不留存，与面板清理面同一闭集）。
      return { ...stripSecretClosure(merged), ...structuredClone(normalized) };
    });
  } catch {
    throw new ConfigError(CONFIG_CODES.SAVE_FAILED, "保存搜索配置失败，已生效配置保持不变");
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
 * WP1 增量：停用条目（enabled=false）直接返回 null，不读取任何凭据层。
 */
export async function resolveEntryApiKey(entry, { env, credentials, legacyYaml } = {}) {
  if (entry.enabled === false) return null;
  if (KEYLESS_TYPES.includes(entry.type)) return null;
  const envName = KEY_ENV_BY_TYPE[entry.type];
  if (!envName) return null;

  if (entry.credentialRef) {
    let hit;
    try {
      hit = await credentials.resolve(entry.credentialRef);
    } catch (cause) {
      // dsh-credentials REF_PATTERN 是 POSIX identifier；R-1 将超语法值视为该层未命中。
      // 合法引用的其他读取故障仍是配置错误，不会静默降级。
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.credentialRef) || !(cause instanceof TypeError)) {
        throw new ConfigError(
          CONFIG_CODES.CREDENTIALS_UNREADABLE,
          `条目「${entry.name}」的凭据引用无法读取，请在设置中重新保存该条目的 API key`,
          { cause },
        );
      }
    }
    const key = nonblank(hit?.value);
    if (key) return { key };
  }

  if (TRUSTED_ENV_KEYS.includes(envName)) {
    const key = nonblank(env?.[envName]);
    if (key) return { key };
  }

  let hosted;
  try {
    hosted = await credentials.resolve(envName);
  } catch (cause) {
    throw new ConfigError(CONFIG_CODES.CREDENTIALS_UNREADABLE, `DSH 托管凭据 ${envName} 无法读取`, { cause });
  }
  const hostedKey = nonblank(hosted?.value);
  if (hostedKey) return { key: hostedKey };

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
