// WP3 Tavily 适配器（seam A5：{ type, search(ctx) }）。
//
// 契约注记（修复轮 P1-1/P1-2/P2）：
//   - 截断归链：适配器返回全部映射来源，不按 maxResults 本地切片；truncated 由 WP5 链层统一设置（FB-002）。
//     maxResults 仍写入请求体（上游参数，封顶 20）。
//   - 预算/取消覆盖正文读取：正文 text() 在 fetch+body 全程受合并信号约束（FB-003）。
//   - key 先 trim 再判空与发送。
//
// 规格来源：
//   docs/specs/draft/tavily.md           TAV-001 单查询与服务上限 / TAV-002 结果映射与正常空结果
//   docs/specs/draft/fallback.md         FB-001 缺 key 零出站、每条目最多一次 / FB-002 绝对 HTTP(S) 与顺序 /
//                                        FB-003 预算与取消、无可用时间不得发请求 / FB-004 空数组=明确无结果 /
//                                        FB-005 失败分类 / FB-004·FB-005 可核查且脱敏的错误
//   docs/specs/draft/config-network.md   CFG-002 条目 key 由链注入 / CFG-003 key 不得进入 URL、正文、错误、日志、堆栈
//   docs/specs/draft/providers.md        CAT-001 type=tavily，凭据 TAVILY_API_KEY
//   test/helpers/contract.js             A4 classifyUpstreamFailure 归属 / A5 适配器 seam / A8 预算时钟
//
// ─── 常量本地镜像（同步义务）──────────────────────────────────────────────
// 运行时代码不得 import test/ 下任何文件（项目规则；做法同 WP0 src/constants.js）。
// 以下值与 test/helpers/contract.js（ENTRY_CODES）、test/helpers/tavily-oracle.js
//（TAVILY_URL / TAVILY_MAX_RESULTS_CAP）保持同值；改动任一值必须在同一 PR 同步 test/ 对应文件（GitHub Flow 审阅）。
// ─────────────────────────────────────────────────────────────────────────

// P1-3：ENTRY_CODES 单一权威为 src/constants.js，本文件不再导出镜像（删除第二权威）。
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENTRY_CODES, carriesPassthroughCode } from "../constants.js";

const ENTRY_CODE_VALUES = Object.freeze(Object.values(ENTRY_CODES));

/** TAV-001：单查询 POST 端点（固定，无查询串；CFG-003：key 只进鉴权头，不进 URL）。 */
const TAVILY_ENDPOINT = "https://api.tavily.com/search";
/** TAV-001：max_results 服务上限（maxResults 与其取较小值；未指定则整体省略该字段）。 */
const TAVILY_MAX_RESULTS_CAP = 20;
/** TAV-002 验收：用量超限状态码（432/433），适配器本地特例面（待办 P6，见报告）。 */
const TAVILY_QUOTA_STATUSES = new Set([432, 433]);

/** 无注入时钟时的回退（生产由链注入；缺省回落真实时钟，防装配外调用崩溃）。 */
const SYSTEM_CLOCK = Object.freeze({
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
});

// ─── 失败分类 ──────────────────────────────────────────────────────────────

/**
 * FB-005 通用分类函数归属 WP5 src/search.js（A4；开发 DAG：WP3 与 WP5 并行、互不可见）。
 * WP5 合入后本适配器对「通用部分」委托该函数；在此之前的本地兜底（localGeneralCode）
 * 只覆盖本轮验收所需的 FB-005 通用映射，不是通用分类器的完整替代——通用分类器的
 * 正式定义权在 WP5（其验收在 test/search-classify.test.js 与 tavily 两文件的直连用例）。
 * WP5 合入并稳定后，应删除本地兜底或由协调方裁决保留为防御层（见交付报告）。
 */
const SEARCH_JS_URL = new URL("../search.js", import.meta.url).href;
const SEARCH_MODULE_PATH = fileURLToPath(new URL("../search.js", import.meta.url));
let generalClassifierPromise = null;

/**
 * 解析通用分类函数（与 openai/exa/brave/gemini/deepseek 同口径，A4）：
 * - ../search.js 不存在 → 本地兜底（resolve null）；
 * - 文件存在但导入失败或未导出 classifyUpstreamFailure → 程序违约上抛（不带 ENTRY 码，不静默兜底）。
 * #12-25：加载失败（rejected）不得永久缓存；失败即重置，下一次调用重新探测。
 */
function generalClassifier() {
  if (!generalClassifierPromise) {
    const pending = existsSync(SEARCH_MODULE_PATH)
      ? import(SEARCH_JS_URL).then((mod) => {
          if (typeof mod.classifyUpstreamFailure !== "function") {
            throw new Error("程序违约：src/search.js 未导出 classifyUpstreamFailure（A4 违约）");
          }
          return mod.classifyUpstreamFailure;
        })
      : Promise.resolve(null);
    generalClassifierPromise = pending;
    pending.catch(() => {
      if (generalClassifierPromise === pending) generalClassifierPromise = null;
    });
  }
  return generalClassifierPromise;
}

/**
 * FB-005 通用映射的本地兜底（仅 WP5 src/search.js 不可用时使用）。
 * 映射依据：FB-005 明文（402/insufficient_quota→额度；其他 429→限流；凭据或权限→凭据；
 * 通道参数限制；单项超时；异常响应）+ tavily-failures.test.js 头部标注的推断
 * （403→凭据或权限；5xx→异常响应）。
 */
function localGeneralCode({ status, upstreamCode, phase }) {
  if (phase === "timeout") return ENTRY_CODES.TIMEOUT;
  if (phase === "transport" || status === undefined || status === null) return ENTRY_CODES.NETWORK;
  if (status === 402) return ENTRY_CODES.QUOTA;
  if (status === 401 || status === 403) return ENTRY_CODES.CREDENTIALS;
  if (status === 429) {
    return upstreamCode === "insufficient_quota" ? ENTRY_CODES.QUOTA : ENTRY_CODES.RATE_LIMITED;
  }
  if (status === 400) return ENTRY_CODES.CHANNEL_LIMIT;
  if (status >= 500) return ENTRY_CODES.BAD_RESPONSE;
  return ENTRY_CODES.BAD_RESPONSE; // 其余 4xx（规格沉默）：异常响应（oracle 宽松面，见报告）
}

/**
 * 条目级失败分类（FB-005/TAV-002）：
 *  1) Tavily/通道特例面（测试钉死、规格未交给通用分类器）本地裁决：
 *     432/433→额度（TAV-002 验收）、403→凭据或权限（FB-005「凭据或权限」）、
 *     400→通道参数限制（待办 P5 推断）；
 *  2) 通用部分委托 WP5 classifyUpstreamFailure（A4）；
 *  3) WP5 不可用时用本地兜底（localGeneralCode）。
 */
async function classifyFailure(info) {
  const { status } = info;
  if (TAVILY_QUOTA_STATUSES.has(status)) return ENTRY_CODES.QUOTA;
  if (status === 403) return ENTRY_CODES.CREDENTIALS;
  if (status === 400) return ENTRY_CODES.CHANNEL_LIMIT;
  const general = await generalClassifier();
  if (general) {
    try {
      const code = general(info);
      if (typeof code === "string" && ENTRY_CODE_VALUES.includes(code)) return code;
    } catch {
      // 通用分类器异常时退回本地兜底（防御；不吞错不重试，FB-001 每条目最多一次）
    }
  }
  return localGeneralCode(info);
}

// ─── 错误构造（CFG-003 脱敏）──────────────────────────────────────────────

/**
 * FB-005：错误须指出可核查的配置；文案为固定模板（只注入 HTTP 状态），
 * 永不包含 key、Authorization 头或上游原始体（CFG-003）。
 */
function entryMessage(code, status) {
  switch (code) {
    case ENTRY_CODES.CREDENTIALS:
      return status === undefined
        ? "Tavily 条目缺少 TAVILY_API_KEY：请检查条目凭据配置（CFG-002）"
        : `Tavily 返回凭据或权限错误（HTTP ${status}）：请检查 TAVILY_API_KEY 是否有效且有权限`;
    case ENTRY_CODES.QUOTA:
      return `Tavily 用量超限（HTTP ${status}）：请检查套餐用量与按量上限（TAV-001）`;
    case ENTRY_CODES.RATE_LIMITED:
      return "Tavily 被限流（HTTP 429）：请降低查询频率后重试（FB-005）";
    case ENTRY_CODES.PROXY:
      return "Tavily 代理路由请求失败：请检查条目代理配置（CFG-001）";
    case ENTRY_CODES.NETWORK:
      return "Tavily 直连网络请求失败：请检查网络与代理连通性（FB-005）";
    case ENTRY_CODES.CHANNEL_LIMIT:
      return `Tavily 拒绝了请求参数（HTTP ${status}）：请核对该通道的参数限制（FB-005）`;
    case ENTRY_CODES.TIMEOUT:
      return "Tavily 请求超时：单项预算内未收到响应（FB-003）";
    case ENTRY_CODES.BAD_RESPONSE:
      return status === undefined
        ? "Tavily 返回无法解析的响应：请检查上游服务状态（FB-005）"
        : `Tavily 返回异常响应（HTTP ${status}）：请检查上游服务状态（FB-005）`;
    case ENTRY_CODES.CONTENT_POLICY:
      return "Tavily 被上游内容策略明确拒绝（FB-001）";
    default:
      return "Tavily 请求失败";
  }
}

function makeEntryError(code, { status } = {}) {
  const err = new Error(entryMessage(code, status));
  err.name = "TavilyEntryError";
  err.code = code;
  if (status !== undefined) err.status = status;
  // CFG-003：刻意不挂上游原始错误为 cause（其 message/stack 可能回显 key/Authorization）；
  // 上游原始体与原始错误文本不进入任何可观察位置（错误须可核查：条目由链层 A7 补充，状态已附）。
  return err;
}

function makeHostCancelError() {
  const err = new Error("宿主取消了本次搜索：须终止，不得降级到后续条目（FB-001/FB-003）");
  // 映射既有取消语义：与 fetch 中止同名（AbortError），便于链层与原生取消一致识别。
  err.name = "AbortError";
  // [待办 P3] 宿主取消的错误形状规格未定。oracle 推断：不得携带可降级 ENTRY_* 码
  // （否则链会当作可降级失败继续下一条）。此错误因此刻意不设 .code（属性不存在）。
  return err;
}

/**
 * 让 promise 在信号中止时以 AbortError 拒绝（正文读取可能不响应 init.signal 的实现也能被预算/取消终止）。
 * promise 迟到的结果被忽略；监听在任一结局后移除。
 */
function rejectOnAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const err = new Error("Tavily 正文读取已中止");
      err.name = "AbortError";
      reject(err);
    };
    if (signal.aborted) {
      onAbort();
      promise.catch(() => {});
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// ─── 请求成形（TAV-001）────────────────────────────────────────────────────

function buildRequestBody(query, maxResults) {
  // TAV-001：正文发送单个原查询（逐字不改写）；固定参数面；
  // maxResults 未提供时整体省略 max_results（用 Tavily 默认；不得写 null/0）。
  const body = {
    query,
    search_depth: "basic",
    auto_parameters: false,
    include_answer: false,
    include_raw_content: false,
  };
  if (typeof maxResults === "number" && Number.isFinite(maxResults) && maxResults > 0) {
    body.max_results = Math.min(Math.floor(maxResults), TAVILY_MAX_RESULTS_CAP);
  }
  return body;
}

// ─── 结果映射（TAV-002/FB-002）────────────────────────────────────────────

/** FB-002：可解析的绝对 HTTP(S) URL 才有效；否则返回 null（该条被剔除）。 */
function validHttpUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * TAV-002：按数组顺序把有效项的 url / 可用的 title / content 映射为链接、标题、snippet。
 * 只产出 url/title/snippet 三个字段（score 等不搬移，规格沉默，见报告）；
 * 缺 title 或缺 content 时不产生对应字段（不编造占位文本）；空字符串视为不可用。
 */
function mapResults(results) {
  const sources = [];
  for (const item of results) {
    const url = validHttpUrl(item && item.url);
    if (url === null) continue;
    const source = { url };
    if (typeof item.title === "string" && item.title.length > 0) source.title = item.title;
    if (typeof item.content === "string" && item.content.length > 0) source.snippet = item.content;
    sources.push(source);
  }
  return sources;
}

/**
 * FB-005：提取上游错误码（供通用分类器区分额度/限流；与 WP5 验收同规则，
 * 只看 code 字段，不依赖正文文本）。非 JSON 体退化为 insufficient_quota 标记扫描。
 */
function extractUpstreamCode(text) {
  let code;
  try {
    const data = JSON.parse(text);
    const c = (data && typeof data === "object" ? (data.error && data.error.code) ?? data.code : undefined);
    if (typeof c === "string" && c.length > 0) code = c;
  } catch {
    // 非 JSON 体：退化为标记扫描
  }
  if (code === undefined && typeof text === "string" && text.includes("insufficient_quota")) {
    code = "insufficient_quota";
  }
  return code;
}

// ─── 适配器主流程 ──────────────────────────────────────────────────────────

async function searchTavily(ctx) {
  const { entry, query, maxResults, key, fetch, budgetMs, signal, log } = ctx;
  const clock = ctx.clock ?? SYSTEM_CLOCK;
  const logWarn =
    typeof log === "function"
      ? (message, meta) => {
          try {
            log("warn", message, meta); // 日志只含固定文案与 entryId/码/状态（CFG-003）
          } catch {
            /* 日志失败不影响主流程 */
          }
        }
      : null;

  // FB-001/CFG-002：缺 key（undefined/非字符串/纯空白）条目由链跳过，适配器不得发无鉴权请求。
  // key 先 trim 再判空与发送：首尾空白不进入 Bearer 头（CFG-003 之外的卫生项，见交付记录）。
  const apiKey = typeof key === "string" ? key.trim() : "";
  if (apiKey.length === 0) {
    // [待办 P4] 缺 key 的码规格未定（CREDENTIALS 或链层 SKIPPED_NO_KEY）；待办文件选 CREDENTIALS。
    logWarn?.("tavily 条目缺 key，零出站", { entryId: entry && entry.id });
    throw makeEntryError(ENTRY_CODES.CREDENTIALS);
  }

  // FB-003：预算计时只用 ctx.clock；无可用时间（≤0/非数值）不得发出请求。
  const deadlineMs =
    typeof budgetMs === "number" && Number.isFinite(budgetMs) ? Math.floor(budgetMs) : 0;
  if (deadlineMs <= 0) {
    // [待办 P7] 无可用时间时的码规格未定；推断 ENTRY_TIMEOUT（链按 FB-003 单项超时语义处理）。
    throw makeEntryError(ENTRY_CODES.TIMEOUT);
  }

  // FB-003：调用前宿主信号已中止 → 不得有请求抵达网络。
  if (signal && signal.aborted) throw makeHostCancelError();

  // 宿主取消与预算到期合并为一个信号，作为 init.signal 传给 ctx.fetch（A8/FB-003）。
  const merged = new AbortController();
  let hostCancelled = false;
  let budgetExpired = false;
  const onHostAbort = () => {
    hostCancelled = true;
    merged.abort(signal ? signal.reason : undefined);
  };
  if (signal) signal.addEventListener("abort", onHostAbort, { once: true });
  const budgetTimer = clock.setTimeout(() => {
    budgetExpired = true;
    merged.abort(new Error("Tavily 条目预算耗尽"));
  }, deadlineMs);

  const cleanup = () => {
    clock.clearTimeout(budgetTimer);
    if (signal) signal.removeEventListener("abort", onHostAbort);
  };

  let response;
  try {
    response = await fetch(TAVILY_ENDPOINT, {
      method: "POST", // TAV-001
      headers: {
        authorization: `Bearer ${apiKey}`, // TAV-001：Bearer 鉴权（key 只进鉴权头，CFG-003）
        "content-type": "application/json",
      },
      body: JSON.stringify(buildRequestBody(query, maxResults)),
      signal: merged.signal,
    });
  } catch (error) {
    cleanup();
    // FB-001/FB-003：宿主取消须终止（不得降级）；预算到期 = 单项超时。
    if (hostCancelled) throw makeHostCancelError();
    if (budgetExpired) {
      logWarn?.("tavily 单项预算到期", { entryId: entry && entry.id });
      throw makeEntryError(ENTRY_CODES.TIMEOUT);
    }
    // P1-1：已带码的错误原样上抛（ENTRY_PROXY/CONFIG 码/TRANSPORT_RELEASED），不压成 ENTRY_NETWORK。
    if (carriesPassthroughCode(error)) throw error;
    // 传输层故障（无 HTTP 状态）→ FB-005 直连网络/代理。
    // 原始错误（可能含 key 回显，CFG-003）不读取、不挂 cause。
    const code = await classifyFailure({ phase: "transport" });
    logWarn?.("tavily 请求失败（传输层）", { entryId: entry && entry.id, code });
    throw makeEntryError(code);
  }
  // 正文读取同样处于预算与宿主取消之下（FB-003）：cleanup 推迟到 text() 完成或合并信号中止之后，
  // 正文挂起时预算到期 → TIMEOUT；宿主取消 → 无码 AbortError 上抛（不降级）。
  // 响应体只读一次；原始文本永不进入错误/日志（CFG-003），仅用于解析与额度标记检测。
  let text = "";
  try {
    text = await rejectOnAbort(response.text(), merged.signal);
  } catch {
    if (hostCancelled) throw makeHostCancelError();
    if (budgetExpired) {
      logWarn?.("tavily 单项预算到期（正文读取）", { entryId: entry && entry.id });
      throw makeEntryError(ENTRY_CODES.TIMEOUT);
    }
    // 非中止类读取失败：沿用既有语义，视为空体（下游按 ok/解析规则判定）。
    text = "";
  } finally {
    cleanup();
  }

  if (!response.ok) {
    const code = await classifyFailure({
      status: response.status,
      upstreamCode: extractUpstreamCode(text),
      phase: "response",
    });
    logWarn?.("tavily 请求失败（上游）", { entryId: entry && entry.id, code, status: response.status });
    throw makeEntryError(code, { status: response.status });
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // FB-005/TAV-002：200 但正文非 JSON → 异常响应
    throw makeEntryError(ENTRY_CODES.BAD_RESPONSE, { status: response.status });
  }

  if (data === null || typeof data !== "object" || !Array.isArray(data.results)) {
    // TAV-002：results 缺失或类型错误 → 响应失败
    throw makeEntryError(ENTRY_CODES.BAD_RESPONSE, { status: response.status });
  }

  const sources = mapResults(data.results);
  if (data.results.length > 0 && sources.length === 0) {
    // TAV-002：非空数组但没有有效来源 → 响应失败（不是正常空结果）
    throw makeEntryError(ENTRY_CODES.BAD_RESPONSE, { status: response.status });
  }

  // 截断归链（协调裁决 P1-2，FB-002；与 WP8 agentic「截断归链」对齐）：
  // 适配器不按 maxResults 本地切片，返回全部映射来源；截断与 truncated 置位由 WP5 链层统一执行。
  // maxResults 仍入请求体（TAV-001 上游参数），仅不在本地裁剪。

  // [待办 P2] Tavily 为纯来源适配器：answer/供应商生成正文不得作为通用 content（FB-002），
  // 故结果永不带 content 字段（TAV-001 亦固定 include_answer:false）。
  return { sources };
}

/** A5 后端形状：{ type, search(ctx) }。type 与 CAT-001 目录 id 一致。 */
export function createTavilyBackend() {
  return { type: "tavily", search: searchTavily };
}

/** oracle 接受的三种导出形态之一（tavilyBackend / default / createTavilyBackend()，见 A5 报告）。 */
export const tavilyBackend = createTavilyBackend();
export default tavilyBackend;
