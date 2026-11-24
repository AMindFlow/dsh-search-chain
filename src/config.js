// 配置、凭据与已保存快照（WP1，docs/specs/draft/config-network.md CFG-001..004，settings-ui SET-004/005，
// fallback FB-003 默认预算）。
//
// 运行时零 import test/，零 npm 依赖。
// 常量本地镜像（同步义务）：下列常量与 test/helpers/contract.js 中同名导出一一对应。
// 修改任一值时必须同时修改 contract.js，并在同一 PR 中说明理由（见 contract.js 头注释的变更规则）。

// ── 常量镜像（同步 test/helpers/contract.js）──────────────────────────────────
export const TOOL_TYPES = Object.freeze([
  "openai",
  "tavily",
  "exa",
  "brave",
  "bing",
  "gemini",
  "deepseek-search",
  "deepseek-agentic-search",
]);

/** CFG-002：需要 key 的类型 → 进程环境变量 / DSH 托管记录名。 */
export const KEY_ENV_BY_TYPE = Object.freeze({
  openai: "OPENAI_API_KEY",
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
  brave: "BRAVE_API_KEY",
  gemini: "GEMINI_API_KEY",
  "deepseek-search": "DEEPSEEK_API_KEY",
  "deepseek-agentic-search": "DEEPSEEK_API_KEY",
});

/** CFG-002：免 key 类型（Bing RSS），不读任何凭据。 */
export const KEYLESS_TYPES = Object.freeze(["bing"]);

/** CFG-002：允许读取的进程环境变量白名单。 */
export const TRUSTED_ENV_KEYS = Object.freeze([...new Set(Object.values(KEY_ENV_BY_TYPE))]);

/** CFG-002：仅这三个供应商有旧版 YAML 顶层兼容层。 */
export const LEGACY_YAML_SUPPLIERS = Object.freeze(["openai", "tavily", "deepseek"]);

/** 配置与路由阶段错误码（与 contract.js CONFIG_CODES 同步）。 */
export const CONFIG_CODES = Object.freeze({
  INVALID: "CONFIG_INVALID",
  CREDENTIALS_UNREADABLE: "CONFIG_CREDENTIALS_UNREADABLE",
  SAVE_FAILED: "CONFIG_SAVE_FAILED",
  PAC_FETCH_FAILED: "PAC_FETCH_FAILED",
  PAC_EVAL_FAILED: "PAC_EVAL_FAILED",
  PAC_ROUTE_FAILED: "PAC_ROUTE_FAILED",
});

/** FB-003 默认总预算（毫秒）。与 contract.js DEFAULT_TIMEOUT_MS 同步。 */
export const DEFAULT_TIMEOUT_MS = 25000;

/**
 * 条目级结构中被视为凭据明文的字段。保存与归一化时一律丢弃，只允许 credentialRef 作为引用（CFG-003）。
 * 历史脏数据（如 apiKey）也不得回读进快照。
 */
const SECRET_FIELD_NAMES = Object.freeze([
  "apiKey",
  "api_key",
  "key",
  "secret",
  "token",
  "password",
  "authorization",
]);

const KNOWN_ENTRY_FIELDS = Object.freeze(["id", "type", "name", "enabled", "credentialRef", "proxy"]);

// ── 错误 ─────────────────────────────────────────────────────────────────────

/** 配置错误。message 只含可操作原因与条目名，绝不含 key、代理认证、原始报错体（CFG-003）。 */
export class ConfigError extends Error {
  /**
   * @param {string} code CONFIG_CODES 之一
   * @param {string} message 脱敏、可操作的中文说明
   */
  constructor(code, message) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

function invalid(message) {
  return new ConfigError(CONFIG_CODES.INVALID, `配置无效：${message}`);
}

// ── 归一化（CFG-001/003/004）────────────────────────────────────────────────

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 只复制 JSON 形状的值，拒绝函数、符号、bigint 等无法持久化的内容。 */
function cloneJson(value, where) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid(`${where} 含非有限数字`);
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => cloneJson(v, `${where}[${i}]`));
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue;
      out[key] = cloneJson(value[key], `${where}.${key}`);
    }
    return out;
  }
  throw invalid(`${where} 不是可保存的 JSON 值`);
}

function httpUrlOk(text) {
  try {
    const u = new URL(text);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host.length > 0;
  } catch {
    return false;
  }
}

/**
 * CFG-001：proxy 取值为 string（HTTP(S) 正向代理 URL）| { pac: string } | 省略/空白（直连）。
 * 返回归一化值；直连时返回 undefined。
 */
export function normalizeProxy(proxy) {
  if (proxy === undefined || proxy === null) return undefined;
  if (typeof proxy === "string") {
    const trimmed = proxy.trim();
    if (trimmed === "") return undefined;
    if (!httpUrlOk(trimmed)) throw invalid("proxy 须为 HTTP(S) 正向代理 URL，或 { pac: HTTP(S) URL }");
    return trimmed;
  }
  if (isPlainObject(proxy)) {
    const keys = Object.keys(proxy);
    if (keys.length !== 1 || keys[0] !== "pac") throw invalid("proxy 对象只允许 { pac: HTTP(S) URL }");
    const pac = typeof proxy.pac === "string" ? proxy.pac.trim() : "";
    if (pac === "" || !httpUrlOk(pac)) throw invalid("proxy.pac 须为 HTTP(S) URL");
    return { pac };
  }
  throw invalid("proxy 类型非法");
}

function normalizeEntry(raw, index, seenIds) {
  if (!isPlainObject(raw)) throw invalid(`entries[${index}] 必须是对象`);

  if (typeof raw.id !== "string" || raw.id.trim() === "") throw invalid(`entries[${index}] 缺少稳定 id`);
  const id = raw.id;
  if (seenIds.has(id)) throw invalid(`条目 id「${id}」重复`);
  seenIds.add(id);

  if (typeof raw.type !== "string" || !TOOL_TYPES.includes(raw.type)) {
    throw invalid(`条目「${id}」的工具类型非法`);
  }
  const type = raw.type;

  const name = raw.name === undefined ? type : raw.name;
  if (typeof name !== "string") throw invalid(`条目「${id}」的 name 必须是字符串`);

  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof enabled !== "boolean") throw invalid(`条目「${id}」的 enabled 必须是布尔值`);

  let credentialRef;
  if (raw.credentialRef !== undefined && raw.credentialRef !== null && raw.credentialRef !== "") {
    if (typeof raw.credentialRef !== "string") throw invalid(`条目「${id}」的 credentialRef 必须是字符串`);
    credentialRef = raw.credentialRef.trim();
    if (credentialRef === "") credentialRef = undefined;
  }

  const proxy = normalizeProxy(raw.proxy);

  const entry = { id, type, name, enabled };
  if (credentialRef !== undefined) entry.credentialRef = credentialRef;
  if (proxy !== undefined) entry.proxy = proxy;

  // 其余为条目类型专有参数（如 model），保存时原样保留（CFG-004「适用参数」）。
  for (const field of Object.keys(raw)) {
    if (KNOWN_ENTRY_FIELDS.includes(field)) continue;
    if (SECRET_FIELD_NAMES.includes(field)) continue; // CFG-003：明文凭据字段不入配置
    if (raw[field] === undefined) continue;
    entry[field] = cloneJson(raw[field], `条目「${id}」.${field}`);
  }
  return entry;
}

/**
 * 归一化宿主保存的配置（CFG-004）。非法结构抛 ConfigError（CONFIG_INVALID）。
 * 顺序即搜索顺序，不重排；缺省 useOfficialDeepSeekSearch=true、timeoutMs=25000（SET-005、FB-003）。
 * 未知顶层字段被丢弃，只保留 entries、useOfficialDeepSeekSearch、timeoutMs。
 * @param {unknown} raw
 * @returns {{ entries: object[], useOfficialDeepSeekSearch: boolean, timeoutMs: number }}
 */
export function normalizeConfig(raw) {
  const source = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(source)) throw invalid("配置必须是对象");

  const useOfficialDeepSeekSearch =
    source.useOfficialDeepSeekSearch === undefined ? true : source.useOfficialDeepSeekSearch;
  if (typeof useOfficialDeepSeekSearch !== "boolean") throw invalid("useOfficialDeepSeekSearch 必须是布尔值");

  const timeoutMs = source.timeoutMs === undefined || source.timeoutMs === null ? DEFAULT_TIMEOUT_MS : source.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw invalid("timeoutMs 必须是正整数毫秒");

  const rawEntries = source.entries === undefined || source.entries === null ? [] : source.entries;
  if (!Array.isArray(rawEntries)) throw invalid("entries 必须是数组");

  const seenIds = new Set();
  const entries = rawEntries.map((item, i) => normalizeEntry(item, i, seenIds));

  // 返回对象只含三个已知字段，未知顶层字段不保存。
  return { entries, useOfficialDeepSeekSearch, timeoutMs };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * CFG-004：读取宿主配置的冻结快照。快照与后续保存隔离。
 * @param {{ current: () => unknown }} settings 宿主配置端口
 */
export async function readConfig(settings) {
  const current = settings && typeof settings.current === "function" ? await settings.current() : undefined;
  // normalizeConfig 产出新对象，冻结不会波及宿主保存的原始对象。
  return deepFreeze(normalizeConfig(current));
}

/**
 * CFG-004：经宿主配置编辑器保存（唯一入口 configEditor(ctx.fiber.entry)）。
 * 非法结构在保存前抛 CONFIG_INVALID；宿主拒绝保存则抛 CONFIG_SAVE_FAILED 且不含原始负载。
 * @param {{ editor: { edit: (target: unknown, change: Function) => Promise<unknown> }, entry: unknown }} settings
 * @param {unknown} next
 */
export async function writeConfig(settings, next) {
  const normalized = normalizeConfig(next);
  try {
    await settings.editor.edit(settings.entry, () => cloneJson(normalized, "config"));
  } catch {
    // 不附带宿主错误原文：宿主报错可能回显负载（含明文 key），CFG-003。
    throw new ConfigError(
      CONFIG_CODES.SAVE_FAILED,
      "保存失败：宿主拒绝写入搜索配置，已生效设置保持不变，请重试。",
    );
  }
}

// ── 凭据解析（CFG-002）──────────────────────────────────────────────────────

function credentialsUnreadable(entry, layer) {
  return new ConfigError(
    CONFIG_CODES.CREDENTIALS_UNREADABLE,
    `条目「${entry.name ?? entry.id}」的${layer}无法读取，请检查凭据服务或旧版配置文件是否可访问。`,
  );
}

/** 纯空白视为缺失；有效值去掉首尾空白，内部空白保留。 */
function usableKey(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined; // 调用方转为 CREDENTIALS_UNREADABLE
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * CFG-002：按 条目 credentialRef → 进程环境变量（白名单）→ DSH 托管记录 → 旧版 YAML 解析 key。
 * 只解析实际需要的层；上层命中即停止。停用条目与免 key 类型不读取任何凭据。
 *
 * @param {object} entry 归一化后的条目
 * @param {{ env?: Record<string, string|undefined>, credentials: {
 *   resolve: (ref: string) => Promise<unknown>,
 *   readRecord: (name: string) => Promise<{ value?: unknown } | undefined> }, legacyYaml?: Record<string, unknown> | undefined }} deps
 * @returns {Promise<{ key: string } | null>} 全层缺失返回 null（由链按 SKIPPED_NO_KEY 处理）
 */
export async function resolveEntryApiKey(entry, deps = {}) {
  if (entry.enabled === false) return null;
  if (KEYLESS_TYPES.includes(entry.type)) return null;

  const envName = KEY_ENV_BY_TYPE[entry.type];
  if (!envName) return null;

  // 第一层：条目凭据引用
  if (typeof entry.credentialRef === "string" && entry.credentialRef !== "") {
    let raw;
    try {
      raw = await deps.credentials.resolve(entry.credentialRef);
    } catch {
      throw credentialsUnreadable(entry, "凭据引用");
    }
    const key = usableKey(raw);
    if (key === undefined) throw credentialsUnreadable(entry, "凭据引用");
    if (key) return { key };
  }

  // 第二层：进程环境变量（仅白名单名）
  if (TRUSTED_ENV_KEYS.includes(envName)) {
    const key = usableKey(deps.env?.[envName]);
    if (key) return { key };
  }

  // 第三层：DSH 托管记录（按名称）
  let record;
  try {
    record = await deps.credentials.readRecord(envName);
  } catch {
    throw credentialsUnreadable(entry, "DSH 托管凭据");
  }
  if (record !== undefined && record !== null) {
    const key = usableKey(record.value);
    if (key === undefined) throw credentialsUnreadable(entry, "DSH 托管凭据");
    if (key) return { key };
  }

  // 第四层：旧版 YAML 顶层项（仅 openai/tavily/deepseek，只查所属供应商键）
  const supplier = entry.type.startsWith("deepseek") ? "deepseek" : entry.type;
  if (LEGACY_YAML_SUPPLIERS.includes(supplier) && deps.legacyYaml !== undefined && deps.legacyYaml !== null) {
    let raw;
    try {
      raw = deps.legacyYaml[supplier];
    } catch {
      throw credentialsUnreadable(entry, "旧版配置文件");
    }
    const key = usableKey(raw);
    if (key === undefined) throw credentialsUnreadable(entry, "旧版配置文件");
    if (key) return { key };
  }

  return null;
}
