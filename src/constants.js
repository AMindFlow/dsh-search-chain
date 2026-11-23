// 共享常量（与 test/helpers/contract.js 保持同值；见 PR 交付记录的「常量复制」说明）。
// 运行时代码不得 import test/ 下的任何文件，故在此复制一份。

export const BUNDLE_NAME = "dsh-search-chain";
export const PROVIDER_ID = "search-chain";

/** dsh 宿主官方 DeepSeek Messages 搜索路由 id（inspect `web` 服务实证）。 */
export const OFFICIAL_ROUTE_ID = "deepseek-official";
/** 账号模式路由 id：DSH-005 要求走自定义链。 */
export const DEEPSEEK_ACCOUNT_ROUTE_ID = "deepseek-account";

/** CAT-001 八个类型 id（DeepSeek 两模式各占一个）。 */
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

/** 类型 → 目录供应商（deepseek-* 归并到 deepseek）。 */
export function supplierOfToolType(type) {
  return type.startsWith("deepseek") ? "deepseek" : type;
}

/** CAT-001 凭据环境变量名 / 托管记录名。 */
export const KEY_ENV_BY_TYPE = Object.freeze({
  openai: "OPENAI_API_KEY",
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
  brave: "BRAVE_API_KEY",
  gemini: "GEMINI_API_KEY",
  "deepseek-search": "DEEPSEEK_API_KEY",
  "deepseek-agentic-search": "DEEPSEEK_API_KEY",
});

/** CFG-002：免 key 类型。 */
export const KEYLESS_TYPES = Object.freeze(["bing"]);

/** CFG-002：允许读取的进程环境变量白名单。 */
export const TRUSTED_ENV_KEYS = Object.freeze([...new Set(Object.values(KEY_ENV_BY_TYPE))]);

/** CFG-002：仅这三个供应商有旧版 YAML 顶层兼容。 */
export const LEGACY_YAML_SUPPLIERS = Object.freeze(["openai", "tavily", "deepseek"]);

/** FB-005 条目级失败分类。 */
export const ENTRY_CODES = Object.freeze({
  CREDENTIALS: "ENTRY_CREDENTIALS",
  QUOTA: "ENTRY_QUOTA",
  RATE_LIMITED: "ENTRY_RATE_LIMITED",
  PROXY: "ENTRY_PROXY",
  NETWORK: "ENTRY_NETWORK",
  CHANNEL_LIMIT: "ENTRY_CHANNEL_LIMIT",
  TIMEOUT: "ENTRY_TIMEOUT",
  BAD_RESPONSE: "ENTRY_BAD_RESPONSE",
  CONTENT_POLICY: "ENTRY_CONTENT_POLICY",
});

/** FB-001 跳过诊断标记（非失败分类）。 */
export const SKIPPED_NO_KEY = "SKIPPED_NO_KEY";

/** FB-004 链级终态码。 */
export const CHAIN_CODES = Object.freeze({
  NOT_CONFIGURED: "CHAIN_NOT_CONFIGURED",
  ALL_KEYS_MISSING: "CHAIN_KEYS_MISSING",
  UPSTREAM_FAILURES: "CHAIN_UPSTREAM_FAILURES",
  BUDGET_EXHAUSTED: "CHAIN_BUDGET_EXHAUSTED",
  CONTENT_POLICY: "CHAIN_CONTENT_POLICY",
});

/** CFG 配置与 PAC 阶段码。 */
export const CONFIG_CODES = Object.freeze({
  INVALID: "CONFIG_INVALID",
  CREDENTIALS_UNREADABLE: "CONFIG_CREDENTIALS_UNREADABLE",
  SAVE_FAILED: "CONFIG_SAVE_FAILED",
  PAC_FETCH_FAILED: "PAC_FETCH_FAILED",
  PAC_EVAL_FAILED: "PAC_EVAL_FAILED",
  PAC_ROUTE_FAILED: "PAC_ROUTE_FAILED",
});

/** FB-003 默认总预算（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 25000;
