// WP12 设置面板 — CAT-001 首期类型目录、SET-005 开关文案与共享常量（本地镜像）。
//
// 规格来源：docs/specs/draft/{providers,settings-ui,config-network,fallback}.md（CAT-001 / SET-005 / CFG-001 / FB-003）。
//
// 同步义务（零 npm 依赖、运行时零 import test/）：
//   本文件的类型 id、免 key 类型、供应商归并、错误码与默认预算镜像 test/helpers/contract.js 的
//   TOOL_TYPES / KEYLESS_TYPES / supplierOfToolType / CONFIG_CODES / DEFAULT_TIMEOUT_MS。
//   运行时不能 import test/，故常量本地镜像；任何一侧改动必须同一 PR 同步修改另一侧，
//   否则冻结测试（CAT-001 / SET / CFG 断言）会红。contract.js 头注与 oracle 约定同规则。
//
// 呈现层边界（铁律：数据层不臆造呈现）：
//   本模块只产出「面板数据」（目录、卡片渲染数据、开关状态与文案、错误信息），
//   不产出任何 DOM/主题/宿主插槽内部结构。真实 settings.section 注册形状与主题控件
//   属宿主实机核对项（test/settings-ui.test.js H-5；报告「面板-宿主投影依赖假设」）。

/** 项目标识（docs/README.md「项目标识」表；镜像 contract.js PROVIDER_ID）。 */
export const PROVIDER_ID = "search-chain";

/** 设置区域挂载插槽（SET-001 设计决定：settings.section；真实 descriptor 形状待 H-5 实机核对）。 */
export const SECTION_SLOT = "settings.section";

/** 设置区域标题（SET-001：DSH 设置中必须出现「网页搜索链」区域）。 */
export const SECTION_TITLE = "网页搜索链";

/** CAT-001 七种首期类型（镜像 contract.js TOOL_TYPES，顺序即目录展示顺序）。 */
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

/** CFG-002：无 key 类型（镜像 contract.js KEYLESS_TYPES）。 */
export const KEYLESS_TYPES = Object.freeze(["bing"]);

/** 按类型 id 归并到供应商（镜像 contract.js supplierOfToolType：DeepSeek 两模式共用 deepseek）。 */
export function supplierOfToolType(type) {
  return type.startsWith("deepseek") ? "deepseek" : type;
}

/** 配置错误码（镜像 contract.js CONFIG_CODES 中 WP12 用到的子集）。 */
export const CONFIG_CODES = Object.freeze({
  INVALID: "CONFIG_INVALID", // 结构非法（缺 type、越界 proxy 等）
  SAVE_FAILED: "CONFIG_SAVE_FAILED", // 保存失败：已生效快照保持一致
});

/**
 * 版本冲突码（T-3 假设）：contract.js CONFIG_CODES 未定义冲突码，冻结测试接受
 * SAVE_FAILED 或 "CONFIG_CONFLICT"。本面板取 CONFIG_CONFLICT 以区分「宿主拒绝保存」
 * 与「配置已被其他界面改动」（SET-004）。若 WP1 在 contract.js 补定义冲突码，
 * 须同 PR 同步本常量（见测试 T-3 待办）。
 */
export const CONFLICT_CODE = "CONFIG_CONFLICT";

/** FB-003 默认总预算（镜像 contract.js DEFAULT_TIMEOUT_MS；面板不暴露该控件，仅读取时兜底）。 */
export const DEFAULT_TIMEOUT_MS = 25000;

/**
 * CAT-001 目录（每类型一行）。
 * fields 语义（oracle 头注）：含 "credential" = 需要 key 字段；deepseek 两模式含 "mode"；
 * "model" / "network" 为 SET-002 编辑面（适用的模型 / 网络设置）的呈现字段提示，措辞不钉死（T-5）。
 * billingNote 关键词钉自各适配规格（T-6）：
 *   tavily.md「Basic 查询消耗一个 credit」；exa.md「费用随 Exa 搜索和内容用量计算」；
 *   gemini.md「计费受所选模型和账户影响」；deepseek.md Search API「按次计费」、
 *   Agentic「不另收搜索次数费用，仍按 token 计费」。
 */
export const CATALOG = Object.freeze([
  {
    type: "openai",
    label: "OpenAI",
    supplier: "openai",
    fields: ["credential", "model", "network"],
    billingNote: "按 OpenAI API 账户用量计费；插件每次搜索只向该通道提交一个查询。",
  },
  {
    type: "tavily",
    label: "Tavily",
    supplier: "tavily",
    fields: ["credential", "network"],
    billingNote: "Basic 查询消耗一个 Tavily credit，免费用量按账户套餐。",
  },
  {
    type: "exa",
    label: "Exa",
    supplier: "exa",
    fields: ["credential", "network"],
    billingNote: "计费费用随 Exa 搜索和内容用量计算。",
  },
  {
    type: "brave",
    label: "Brave",
    supplier: "brave",
    fields: ["credential", "network"],
    billingNote: "按 Brave Web Search API 账户用量计费。",
  },
  {
    type: "bing",
    label: "Bing RSS",
    supplier: "bing",
    fields: ["network"],
    billingNote: "公开 RSS 通道，免 key，不产生供应商计费。",
  },
  {
    type: "gemini",
    label: "Gemini",
    supplier: "gemini",
    fields: ["credential", "model", "network"],
    billingNote: "模型与搜索产品的计费受所选模型和账户影响。",
  },
  {
    type: "deepseek-search",
    label: "DeepSeek Search API",
    supplier: "deepseek",
    fields: ["credential", "mode", "network"],
    billingNote: "Search API 对有结果的成功请求按次计费。",
  },
  {
    type: "deepseek-agentic-search",
    label: "DeepSeek Agentic Search",
    supplier: "deepseek",
    fields: ["credential", "mode", "network"],
    billingNote: "模型触发的服务端搜索工具不另收搜索次数费用，模型输入和输出仍按 token 计费。",
  },
]);

const CATALOG_BY_TYPE = new Map(CATALOG.map((row) => [row.type, row]));

/** 目录行（深拷贝；未知类型返回 undefined）。 */
export function catalogRow(type) {
  const row = CATALOG_BY_TYPE.get(type);
  return row ? structuredClone(row) : undefined;
}

/** 类型显示名（卡片 typeLabel；未知类型回退原始 id，避免空标签）。 */
export function typeLabelOf(type) {
  const row = CATALOG_BY_TYPE.get(type);
  return row ? row.label : String(type);
}

/**
 * SET-005 开关旁文案（区域顶端）。要素钉自冻结测试 OFFICIAL_HINT_KEYWORDS：
 * 适用会话 / 关闭后使用下方工具链 / 官方搜索不另按次收费 / 模型用量仍按 token 计费。
 * 措辞不钉死（T 清单：SET-005 只要求写明这些要素）。
 */
export const OFFICIAL_HINT =
  "仅对 DeepSeek 官方 API 会话生效；关闭后相关会话改用下方工具链。官方搜索不另按次收费，模型用量仍按 token 计费。";

/** 空态引导文案（SET-001：新配置列表为空时引导添加）。 */
export const EMPTY_TEXT = "还没有配置搜索工具，点击下方「添加搜索工具」添加第一条。";

/** 「添加搜索工具」入口标签（SET-001）。 */
export const ADD_ACTION_LABEL = "添加搜索工具";

/**
 * 条目状态三态（T-4：只表示本地配置与启用情况，不读凭据、不出站）。
 * 已关闭 ≠ 缺凭据引用 ≠ 就绪；免 key 类型（Bing RSS）无凭据概念，启用即就绪
 * （SET-002 验收：免 key 条目的就绪态与带凭据引用的就绪态一致）。
 */
export function entryStatus(entry) {
  if (!entry.enabled) return "已关闭";
  const hasRef = typeof entry.credentialRef === "string" && entry.credentialRef.length > 0;
  if (!KEYLESS_TYPES.includes(entry.type) && !hasRef) return "缺凭据引用";
  return "就绪";
}

/** 构造携带 CONFIG_CODES 码的错误（与 WP1 src/config.js 的错误形状同约定）。 */
export function configError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
