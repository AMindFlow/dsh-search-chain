// WP0 共享契约常量与断言（oracle 定义，实现以本文件与 docs/specs 草案为准）。
//
// 规格来源：docs/specs/draft/{fallback,config-network,dsh-integration,providers,settings-ui}.md。
// 本文件只做两件事：
//   1. 固化跨工作包共享的字符串常量与错误码枚举（编号语义来自规格，标识符拼写是 oracle 假设）；
//   2. 提供 host 结果 / 终态错误的形状断言。
// 任何实现若认为某标识符应改名，必须在对应 WP 的 PR 中同步修改本文件并给出理由（GitHub Flow 审阅）。
//
// ─── 契约形状（oracle 假设清单，最终报告同步列出）────────────────────────────
// A1 宿主接口（已用 dsh 运行时 inspect 实证，0.2.2-rc.5+，Host Service `web` 编码契约）：
//    WebSearchProvider { id, title?, description?: LocalizedText, available(): boolean,
//      ready?(llmProvider: string|undefined): Promise<boolean>,
//      search(request, signal?): Promise<WebSearchResult> }
//    WebSearchRequest { query, maxResults?, llmProvider? }  // llmProvider = 模型请求的路由 id
//    WebSearchResult { content?, sources: WebSearchSource[], truncated: boolean }
//    WebSearchSource { url, title?, snippet?, summary?, publishedAt? }
//    ctx.web.registerSearchProvider(provider) → 同步返回 () => void 反注册函数；
//      同 id 重复注册抛 WebError WEB_DUPLICATE_PROVIDER（假宿主复刻该语义）。
//    宿主选择语义按 request.llmProvider 在调用时解析；内置官方 Messages 搜索路由 id 为
//    "deepseek-official"（官方 provider 与之同名），"deepseek-account" 是账号模式路由——
//    DSH-005 要求账号模式走自定义链。宿主 seam 也会按 maxResults 截断 provider 超发结果；
//    本插件仍须按 FB-002 自行截断并置 truncated（不依赖宿主兜底）。
// A2 结果字段语义补充（FB-002/BING-001）：source.url 必须是可解析的绝对 HTTP(S) URL；
//    sources 严格按成功条目供应商返回顺序；不新增 per-source 供应商字段（规格未给，来源标注走 content 首行）。
// A3 配置形状（CFG-004）：宿主插件配置保存
//    { entries: Entry[], useOfficialDeepSeekSearch: boolean, timeoutMs?: number }
//    Entry { id(稳定), type, name, enabled, credentialRef?, proxy?, 其余类型参数… }
//    proxy 取值（CFG-001）：string（HTTP(S) 正向代理 URL）| { pac: string } | 省略/空白=直连。
// A4 实现模块与导出（尚未实现；测试按此 import，缺失即红并等待对应工作包，见 impl.js failIfUnimplemented）：
//    src/search.js   : export function createSearchChain(deps) → { search(request, signal), release?() }
//                     export function classifyUpstreamFailure(info) → ENTRY_* 码 （FB-005 映射，
//                     info = { status?, upstreamCode?, phase?("transport"|"response"|"timeout"), error? }）
//    src/config.js   : export function normalizeConfig(raw) → 已保存形状（非法抛 CONFIG_CODES.INVALID）
//                     export function readConfig(settings) → 冻结快照（settings = 宿主配置端口 { editor, entry, current() }，测试用 fake-host.settingsPort；
//                     实现方在 index.js 将真实宿主读写接入同一端口）
//                     export function writeConfig(settings, next) → 通过 normalizeConfig 校验后写入；
//                       失败抛携带 CONFIG_CODES 的错误且不改动已生效快照（CFG-004）
//                     export function resolveEntryApiKey(entry, { env, credentials, legacyYaml }) →
                       // legacyYaml = 供应商名→顶层 key 的解析映射或 undefined；env 为注入的进程环境映射
//                       { key } 或 null（CFG-002 优先级；凭据文件不可读/损坏抛 CREDENTIALS_UNREADABLE；
//                       纯空白一律视为缺失；只允许读 TRUSTED_ENV_KEYS 中的环境变量名）
//    src/transport.js: export function createEntryTransport(entry, { fetch, clock, log }) →
//                       { fetch(url, init), close(), closeAll() }
//                     transport 产出的 init 带 `route` 标记
//                       { kind: "direct"|"proxy"|"https-proxy", proxyUrl?, viaPac?, pacIndex?,
//                         pacSource?, pacRevision?, phase? } 以便假 fetch 断言路由。
//    src/index.js    : export const PROVIDER_ID = "search-chain";
//                     export const Config;  // 行配置 schema（宿主装载时校验 config 行）
//                     export function apply(ctx, config, testDeps?)
//                       // bundle 入口（dsh-doc host-plugin：apply(ctx, config)，inject + Config 声明）。
//                       // 在 ctx.effect 内注册搜索 provider；cleanup = 反注册 + provider.release()（DSH-001）。
//                       // 第三参 testDeps 为测试专用注入面 { chain, official, officialRouteId, routeOf }，
//                       // 生产调用只有两参（宿主核对项 HOST-1；WP6 若改注入方式须同步本契约）。
//                     export function createSearchProvider(deps) → provider（含 release() 追加方法）
//                       deps = { getConfig, chain, official,
//                                routeOf = (request) => request?.llmProvider,
//                                officialRouteId = OFFICIAL_ROUTE_ID }
// A5 适配器 seam（供链级测试注入替身；实际适配器须满足同一形状，见各 backends 规格）：
//    Backend = { type, search(ctx) }, ctx = { entry, query, maxResults?, key, fetch, budgetMs,
//      signal, clock, log }；resolve → { sources, content? }（空数组=明确无结果，FB-004）；
//    失败 throw 携带 `.code` ∈ ENTRY_CODES 的错误；程序违约 throw 无 code 的错误。
// A6 链调用适配器前经 transport.open(entry) 取得 ctx.fetch；适配器自身用 ctx.fetch 出站。
// A7 错误形状（FB-004/DSH-002）：search() 终态抛错
//    { name: "WebError", code: CHAIN_CODES 之一, message: 脱敏文本,
//      details: { attempts: [{ entryId, entryType, entryName,
//                               code: ENTRY_CODE|CONFIG_CODES 原码（含 PAC_*；条目执行期带码错误
//                                     条目级降级，PR#35 裁决补充）|"SKIPPED_NO_KEY",
//                               reason }] } }（attempts 按尝试顺序，FB-004）。
//    最终 WebError 由宿主类构造的细节属宿主核对项（checklist HOST-5）。
// A8 预算（FB-003）：deps.clock = { now, setTimeout, clearTimeout, abortSignal }，测试注入受控时钟。
// ──────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";

/** 项目标识（docs/README.md「项目标识」表）。 */
export const BUNDLE_NAME = "dsh-search-chain";
export const PROVIDER_ID = "search-chain";

/**
 * 宿主内置官方 DeepSeek Messages 搜索的路由与 provider id（dsh 运行时 inspect 实证）。
 * DSH-005：仅当实际模型路由为该 id 且开关开启时走宿主官方路径。
 */
export const OFFICIAL_ROUTE_ID = "deepseek-official";
export const OFFICIAL_PROVIDER_ID = OFFICIAL_ROUTE_ID;
/** 宿主 DeepSeek 账号模式路由 id：按 DSH-005 必须走自定义链。 */
export const DEEPSEEK_ACCOUNT_ROUTE_ID = "deepseek-account";

/**
 * CAT-001 七种首期类型。数量与凭据列来自规格；字符串 id 为 oracle 假设（A4 同规则可协商）。
 * DeepSeek 的两种模式各占一个 type id（docs/README 的 src/backends 文件表）。
 */
export const TOOL_TYPES = [
  "openai",
  "tavily",
  "exa",
  "brave",
  "bing",
  "gemini",
  "deepseek-search",
  "deepseek-agentic-search",
];
/** CAT-001：七家供应商（DeepSeek 两模式共用一个供应商）。 */
export const TOOL_SUPPLIERS = Object.freeze([
  "openai",
  "tavily",
  "exa",
  "brave",
  "bing",
  "gemini",
  "deepseek",
]);
/** 按类型 id 归并到供应商（deepseek-search / deepseek-agentic-search → deepseek）。 */
export function supplierOfToolType(type) {
  return type.startsWith("deepseek") ? "deepseek" : type;
}

/** 需要 key 的类型 → CAT-001 表中的凭据名（环境变量/托管记录同名）。 */
export const KEY_ENV_BY_TYPE = {
  openai: "OPENAI_API_KEY",
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
  brave: "BRAVE_API_KEY",
  gemini: "GEMINI_API_KEY",
  "deepseek-search": "DEEPSEEK_API_KEY",
  "deepseek-agentic-search": "DEEPSEEK_API_KEY",
};
/** CFG-002：无 key 类型。 */
export const KEYLESS_TYPES = ["bing"];

/** CFG-002：允许读入的进程环境变量白名单。 */
export const TRUSTED_ENV_KEYS = [...new Set(Object.values(KEY_ENV_BY_TYPE))];

/** CFG-002：仅这三个供应商名有旧版 YAML 顶层兼容层。 */
export const LEGACY_YAML_SUPPLIERS = ["openai", "tavily", "deepseek"];

/** FB-005 失败分类（条目级）。命名 UPPER_SNAKE 与宿主 WebError 风格一致；分类集合逐条来自 FB-005。 */
export const ENTRY_CODES = Object.freeze({
  CREDENTIALS: "ENTRY_CREDENTIALS", // 凭据或权限
  QUOTA: "ENTRY_QUOTA", // 额度：402 或 insufficient_quota
  RATE_LIMITED: "ENTRY_RATE_LIMITED", // 其他 429
  PROXY: "ENTRY_PROXY", // 代理
  NETWORK: "ENTRY_NETWORK", // 直连网络
  CHANNEL_LIMIT: "ENTRY_CHANNEL_LIMIT", // 通道参数限制
  TIMEOUT: "ENTRY_TIMEOUT", // 单项超时
  BAD_RESPONSE: "ENTRY_BAD_RESPONSE", // 异常响应
  CONTENT_POLICY: "ENTRY_CONTENT_POLICY", // 明确的上游内容策略拒绝：FB-001 规定的终止类，不降级
});

/** FB-001：条目被跳过（缺必要 key）时的诊断标记，非失败分类。 */
export const SKIPPED_NO_KEY = "SKIPPED_NO_KEY";

/** FB-004/FB-003 链级终态码。TODO(spec)：终态码与宿主 WebError.code 的映射待 WP5 宿主验收定名。 */
export const CHAIN_CODES = Object.freeze({
  NOT_CONFIGURED: "CHAIN_NOT_CONFIGURED", // 空列表或全停用：未配置可用工具
  ALL_KEYS_MISSING: "CHAIN_KEYS_MISSING", // 全因缺必要凭据跳过：须说明缺失项
  UPSTREAM_FAILURES: "CHAIN_UPSTREAM_FAILURES", // 存在失败且全链未获有效来源
  BUDGET_EXHAUSTED: "CHAIN_BUDGET_EXHAUSTED", // 总预算耗尽且无结果
  CONTENT_POLICY: "CHAIN_CONTENT_POLICY", // 上游内容策略拒绝终止
});

/** CFG-002/CFG-004/CFG-005 配置与路由阶段错误。 */
export const CONFIG_CODES = Object.freeze({
  INVALID: "CONFIG_INVALID", // 结构非法（负预算、缺 id 等）
  CREDENTIALS_UNREADABLE: "CONFIG_CREDENTIALS_UNREADABLE", // 凭据文件无法访问或解析
  SAVE_FAILED: "CONFIG_SAVE_FAILED", // 保存失败：已生效快照保持一致
  PAC_FETCH_FAILED: "PAC_FETCH_FAILED", // CFG-005：下载阶段
  PAC_EVAL_FAILED: "PAC_EVAL_FAILED", // CFG-005：求值阶段
  PAC_ROUTE_FAILED: "PAC_ROUTE_FAILED", // CFG-005：路由/建连阶段
  ROW_UNAVAILABLE: "CONFIG_ROW_UNAVAILABLE", // 宿主行不可得（configuration() 无我行）——CFG-004 生产接线面
});

/** FB-003 默认总预算（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 25000;

/** A5 适配器能力声明（FB-002 contentMode 判定依据，oracle 假设）。 */
export const CONTENT_MODE = Object.freeze({ SOURCES_ONLY: "sources-only", ADAPTER: "adapter" });

// ─── 结果契约断言（FB-002 + A1/A2）──────────────────────────────────────────

/**
 * 断言 search() 的成功/终态结果满足 host WebSearchResult 形状与 FB-002 语义。
 * @param {object} t node:test t
 * @param {any} result
 * @param {{ sources?: Array<object>, entryName?: string }} [expect]
 *   expect.sources: 期望的完整来源（deepEqual，锁顺序）；
 *   expect.entryName: 此前有启用条目被跳过/失败时，content 首行必须含该条目名（FB-002）。
 */
export function assertSearchResult(t, result, expect = {}) {
  assert.equal(typeof result, "object", "结果必须是对象");
  assert.ok(Array.isArray(result.sources), "sources 必须是数组（FB-002）");
  assert.equal(typeof result.truncated, "boolean", "truncated 必须是布尔（FB-002）");
  for (const [i, s] of result.sources.entries()) {
    assert.equal(typeof s.url, "string", `sources[${i}].url 必须是字符串（A1）`);
    let u;
    try {
      u = new URL(s.url);
    } catch {
      assert.fail(`sources[${i}].url 必须是可解析 URL（FB-002）: ${s.url}`);
    }
    assert.ok(
      u.protocol === "http:" || u.protocol === "https:",
      `sources[${i}].url 必须是绝对 HTTP(S)（FB-002）: ${s.url}`,
    );
    for (const f of ["title", "snippet", "summary", "publishedAt"]) {
      if (s[f] !== undefined) assert.equal(typeof s[f], "string", `sources[${i}].${f} 若存在须为字符串`);
    }
  }
  if (expect.sources) {
    assert.deepEqual(result.sources, expect.sources, "sources 必须严格按成功条目的供应商顺序（FB-002）");
  }
  if (expect.truncated !== undefined) {
    assert.equal(result.truncated, expect.truncated, `truncated 必须为 ${expect.truncated}（FB-002：超限截断才为 true）`);
  }
  if (expect.maxResults !== undefined) {
    assert.ok(
      result.sources.length <= expect.maxResults,
      `sources 不得超过 maxResults=${expect.maxResults}，插件必须自行截断而非依赖宿主 seam（FB-002）`,
    );
  }
  if (expect.entryName !== undefined) {
    assert.equal(typeof result.content, "string", "接管场景 content 必须存在（FB-002）");
    const firstLine = result.content.split("\n")[0];
    assert.ok(
      firstLine.includes(expect.entryName),
      `content 首行须标明实际使用的条目「${expect.entryName}」（FB-002），实际：${firstLine}`,
    );
  }
  if (expect.noEntryMark !== undefined) {
    const head = typeof result.content === "string" ? result.content.split("\n")[0] : "";
    assert.ok(
      !head.includes(expect.noEntryMark),
      `停用条目不构成「启用条目被跳过/失败」，首行不得标注（FB-002）：${head}`,
    );
  }
}

// PR#35 裁决补充（lead 同判）：条目执行期 CONFIG_*/PAC_* 按条目级降级进 attempts →
// attempts 码白名单并入 CONFIG_CODES 原码面（含 PAC_*）；全局 CONFIG_* 仍硬失败原样上抛，不经 attempts。
const ALLOWED_ATTEMPT_CODES = new Set([
  ...Object.values(ENTRY_CODES),
  ...Object.values(CONFIG_CODES),
  SKIPPED_NO_KEY,
]);

/**
 * 断言终态错误形状（A7）。FB-004：抛 WebError，attempts 按尝试顺序附条目与脱敏原因。
 * @param {unknown} err
 * @param {{ code: string, attempts: Array<{ entryId: string, code: string }> }} expect
 */
export function assertWebError(err, expect) {
  assert.equal(typeof err, "object", "终态须抛错误对象");
  assert.equal(err?.name, "WebError", "终态错误 name 须为 WebError（FB-004/A1）");
  assert.equal(typeof err.message, "string", "message 必须是文本");
  assert.ok(err.message.length > 0, "message 须给出可操作原因（FB-004）");
  assert.equal(err.code, expect.code, `终态码应为 ${expect.code}（FB-004/FB-005）`);
  assert.ok(Array.isArray(err.details?.attempts), "details.attempts 必须是数组（FB-004）");
  assert.deepEqual(
    err.details.attempts.map((a) => a.entryId),
    expect.attempts.map((a) => a.entryId),
    "attempts 必须按尝试顺序列出条目（FB-004）",
  );
  for (const [i, a] of err.details.attempts.entries()) {
    const want = expect.attempts[i];
    assert.ok(
      ALLOWED_ATTEMPT_CODES.has(a.code),
      `attempts[${i}].code 必须属于 ENTRY_CODES ∪ CONFIG_CODES ∪ {SKIPPED_NO_KEY}（A7/FB-005/PR#35 裁决补充），实际：${a.code}`,
    );
    assert.equal(typeof a.entryType, "string", `attempts[${i}].entryType 须存在（FB-005 可定位）`);
    assert.equal(typeof a.entryName, "string", `attempts[${i}].entryName 须存在（FB-005 可定位）`);
    assert.equal(a.code, want.code, `attempts[${i}] 分类码须为 ${want.code}（FB-005）`);
    assert.equal(typeof a.reason, "string", `attempts[${i}].reason 须为可核查文本（FB-005）`);
    assert.ok(a.reason.length > 0, `attempts[${i}].reason 不得为空`);
  }
}

// ─── 配置/条目工厂（A3）─────────────────────────────────────────────────────

let seq = 0;

/** 造一个最小合法条目（CFG-004 字段集）。 */
export function makeEntry(overrides = {}) {
  const type = overrides.type ?? "tavily";
  return {
    id: overrides.id ?? `entry-${++seq}`,
    type,
    name: overrides.name ?? `${type} 条目`,
    enabled: overrides.enabled ?? true,
    ...(overrides.credentialRef !== undefined ? { credentialRef: overrides.credentialRef } : {}),
    ...(overrides.proxy !== undefined ? { proxy: overrides.proxy } : {}),
    ...overrides,
  };
}

/** 造一份合成来源（永远使用 .invalid / host.test，绝不指向真实服务）。 */
export function makeSource(i, base = "https://synthetic-host.invalid/doc") {
  return {
    url: `${base}?n=${i}`,
    title: `合成来源 ${i}`,
    snippet: `合成片段 ${i}`,
  };
}

export function makeSources(count, base) {
  return Array.from({ length: count }, (_, i) => makeSource(i + 1, base));
}

/** 造一份已保存配置快照（CFG-004）。 */
export function makeSavedConfig(entries, extra = {}) {
  return {
    entries,
    useOfficialDeepSeekSearch: extra.useOfficialDeepSeekSearch ?? true,
    ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
  };
}
