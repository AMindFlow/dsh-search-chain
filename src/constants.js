// WP5 本地契约常量（字符串值与 test/helpers/contract.js 的冻结值逐字一致）。
//
// 背景：运行时代码不得 import test/（WP0 约定，contract.js 头注释第 7 行：常量
// 编号语义来自 docs/specs 草案，标识符拼写是 oracle 假设）。WP5 的 src/search.js
// 按 A4「实现模块与导出」从本文件取常量；WP6 合并 src/config.js / src/index.js
// 时把同源常量统一到单一模块（本文件届时删除或 re-export，见 WP6 任务）。
//
// 若认为某标识符应改名：必须在同一 PR 中同步修改本文件与 test/helpers/contract.js
// 并给出理由（contract.js 头注释第 7 行；GitHub Flow 审阅）。

/** FB-005 失败分类（条目级）。与 test/helpers/contract.js ENTRY_CODES 同值。 */
export const ENTRY_CODES = Object.freeze({
  CREDENTIALS: "ENTRY_CREDENTIALS", // 凭据或权限
  QUOTA: "ENTRY_QUOTA", // 额度：402 或 insufficient_quota
  RATE_LIMITED: "ENTRY_RATE_LIMITED", // 其他 429
  PROXY: "ENTRY_PROXY", // 代理
  NETWORK: "ENTRY_NETWORK", // 直连网络
  CHANNEL_LIMIT: "ENTRY_CHANNEL_LIMIT", // 通道参数限制
  TIMEOUT: "ENTRY_TIMEOUT", // 单项超时
  BAD_RESPONSE: "ENTRY_BAD_RESPONSE", // 异常响应
  CONTENT_POLICY: "ENTRY_CONTENT_POLICY", // 明确的上游内容策略拒绝：FB-001 终止类，不降级
});

/** FB-001：条目被跳过（缺必要 key）时的诊断标记，非失败分类。 */
export const SKIPPED_NO_KEY = "SKIPPED_NO_KEY";

/**
 * FB-004/FB-003 链级终态码。TODO(spec)：与宿主 WebError.code 的最终映射待 WP5
 * 宿主验收定名（WP0 风险①/HOST-5）；本文件先固定插件侧链码，见 search-classify
 * 末尾待办测试。
 */
export const CHAIN_CODES = Object.freeze({
  NOT_CONFIGURED: "CHAIN_NOT_CONFIGURED", // 空列表或全停用：未配置可用工具
  ALL_KEYS_MISSING: "CHAIN_KEYS_MISSING", // 全因缺必要凭据跳过：须说明缺失项
  UPSTREAM_FAILURES: "CHAIN_UPSTREAM_FAILURES", // 存在失败且全链未获有效来源
  BUDGET_EXHAUSTED: "CHAIN_BUDGET_EXHAUSTED", // 总预算耗尽且无结果
  CONTENT_POLICY: "CHAIN_CONTENT_POLICY", // 上游内容策略拒绝终止
});

/** FB-003 默认总预算（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 25000;

/** CAT-001：需要 key 的类型 → 凭据名（环境变量/托管记录同名，providers.md 表）。 */
export const KEY_ENV_BY_TYPE = {
  openai: "OPENAI_API_KEY",
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
  brave: "BRAVE_API_KEY",
  gemini: "GEMINI_API_KEY",
  "deepseek-search": "DEEPSEEK_API_KEY",
  "deepseek-agentic-search": "DEEPSEEK_API_KEY",
};

/** CFG-002：仅这三个供应商名有旧版 YAML 顶层兼容层（最后一级）。 */
export const LEGACY_YAML_SUPPLIERS = ["openai", "tavily", "deepseek"];

/** 按类型 id 归并到供应商（deepseek-search / deepseek-agentic-search → deepseek）。 */
export function supplierOfToolType(type) {
  return type.startsWith("deepseek") ? "deepseek" : type;
}
