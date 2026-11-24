// OpenAI Responses 搜索适配器（OAI-001 查询与模型、OAI-002 引用提取与顺序、OAI-003 无引用与响应失败；
// 跨条款 FB-003 预算与取消、FB-005 失败分类、CFG-003 脱敏）。
//
// 形状（A5）：Backend = { type, search(ctx) }，ctx = { entry, query, maxResults?, key, fetch, budgetMs,
//   signal, clock, log }。resolve → { sources }（永不带 content，见 OAI-002/FB-002「纯来源」推断，待办 P11）；
//   失败 throw 带 .code ∈ ENTRY_CODES 的错误；宿主取消抛不带 ENTRY_* 码的 AbortError；
//   模型参数无效抛 CONFIG_CODES.INVALID（待办 P1）。
//
// 依赖：仅 Node 内置与 ../constants.js（src 内的常量镜像；运行时代码不 import test/）。
// 同步义务：常量与 test/helpers/contract.js 保持同值，改动须同时更新两处。
//
// 失败分类（FB-005）：OpenAI 专属载荷（content_filter、响应内 refusal）由本文件直接判定；其余
// HTTP/传输分类优先动态加载 src/search.js 的 classifyUpstreamFailure（A4，WP5 负责）。
// 该文件不存在时使用本地镜像 localClassify 兜底（同 WP3 做法）。WP5 合入后本镜像即为死代码，
// 去留交协调（见 PR 交付记录「已接受假设」）。
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONFIG_CODES, ENTRY_CODES, carriesPassthroughCode } from "../constants.js";

/** OAI-001：固定端点，无查询串；key 只进 Authorization 头（CFG-003）。 */
const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
/** OAI-001：省略 model 时的默认模型。 */
const OPENAI_DEFAULT_MODEL = "gpt-5.6-luna";

/**
 * OAI-001：固定搜索指令。跨查询逐字不变；只要求列出引用、附摘要、用查询的语言作答（待办 P4）。
 * 不包含任何查询文本，便于 fixedInstructionParts 将其与查询区分。
 */
const FIXED_INSTRUCTIONS = [
  "Use the web_search tool once to search for the user's query.",
  "Reply in the same language as the query.",
  "List the citations you used as sources, with a short summary for each source.",
  "请用与查询相同的语言，列出引用的来源并为每条来源给出简短摘要。",
].join("\n");

/** 固定脱敏文案：不含 key、不回显响应体、不挂原始 cause（CFG-003 / FB-005）。 */
const MESSAGES = Object.freeze({
  [ENTRY_CODES.CREDENTIALS]: "OpenAI 返回鉴权或权限错误（401/403）：请核对该条目的 API key 及其权限",
  [ENTRY_CODES.QUOTA]: "OpenAI 额度不足或计费未生效（402 / insufficient_quota）：请在 OpenAI 账户核对余额或计费",
  [ENTRY_CODES.RATE_LIMITED]: "OpenAI 限流（429）：请稍后重试，或降低该条目的调用频率",
  [ENTRY_CODES.NETWORK]: "无法连接 OpenAI 端点（网络故障）：请检查直连网络或该条目的代理设置",
  [ENTRY_CODES.CHANNEL_LIMIT]: "OpenAI 拒绝了本次请求参数（HTTP 4xx）：请检查该条目的模型设置",
  [ENTRY_CODES.TIMEOUT]: "OpenAI 请求超过本条目的时间预算，已取消在途请求",
  [ENTRY_CODES.BAD_RESPONSE]: "OpenAI 返回了无法使用的响应：非 JSON、结构不符、未完成或没有有效引用",
  [ENTRY_CODES.CONTENT_POLICY]: "OpenAI 以内容策略拒绝了本次搜索：该条目终止，不再向其重试",
  configInvalid: "OpenAI 条目的 model 必须为非空字符串；删除该项即使用默认模型 gpt-5.6-luna",
  keyMissing: "OpenAI 条目缺少 API key：请在该条目或 OPENAI_API_KEY 中配置",
  noBudget: "OpenAI 条目没有可用的时间预算，未发出请求",
  hostCancelled: "搜索已被宿主取消",
});

/** 无注入时钟时的回退（ctx.clock 缺省才用；正常由宿主提供受控/真实时钟）。 */
const SYSTEM_CLOCK = Object.freeze({
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
});

// ─── 错误构造 ────────────────────────────────────────────────────────────────

function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function hostCancelled() {
  // 宿主取消不携带 ENTRY_* 码：链据此终止而非降级（FB-001，待办 P8）。
  const err = new Error(MESSAGES.hostCancelled);
  err.name = "AbortError";
  return err;
}

/** 程序违约：无 code，向调用方暴露（FB-005「内部程序违约向调用方暴露」）。 */
function programError(message) {
  return new Error(message);
}

// ─── 失败分类（FB-005）────────────────────────────────────────────────────────

/** 本地镜像分类（search.js 缺失时兜底；语义与 FB-005 一致）。 */
function localClassify({ status, upstreamCode, phase }) {
  if (upstreamCode === "content_filter") return ENTRY_CODES.CONTENT_POLICY;
  if (phase === "transport") return ENTRY_CODES.NETWORK;
  if (phase === "timeout") return ENTRY_CODES.TIMEOUT;
  if (upstreamCode === "insufficient_quota") return ENTRY_CODES.QUOTA;
  if (status === 401 || status === 403) return ENTRY_CODES.CREDENTIALS;
  if (status === 402) return ENTRY_CODES.QUOTA;
  if (status === 429) return ENTRY_CODES.RATE_LIMITED;
  if (Number.isInteger(status) && status >= 400 && status < 500) return ENTRY_CODES.CHANNEL_LIMIT;
  return ENTRY_CODES.BAD_RESPONSE; // 5xx、无法解析及其他
}

const SEARCH_MODULE_PATH = fileURLToPath(new URL("../search.js", import.meta.url));
let classifierPromise = null;

/**
 * 解析通用分类函数：search.js 存在则动态加载其 classifyUpstreamFailure（A4）；
 * 不存在则用本地镜像。加载出错（文件存在但导入失败或未导出）视为程序违约，向上抛出。
 */
function upstreamClassifier() {
  if (!classifierPromise) {
    const pending = existsSync(SEARCH_MODULE_PATH)
      ? import("../search.js").then((mod) => {
          if (typeof mod.classifyUpstreamFailure !== "function") {
            throw programError("src/search.js 未导出 classifyUpstreamFailure（A4 违约）");
          }
          return mod.classifyUpstreamFailure;
        })
      : Promise.resolve(localClassify);
    classifierPromise = pending;
    // #12-25：加载失败（rejected）不得永久缓存；失败即重置，下一次调用重新探测。
    pending.catch(() => {
      if (classifierPromise === pending) classifierPromise = null;
    });
  }
  return classifierPromise;
}

async function classifyFailure(info) {
  const classify = await upstreamClassifier();
  const code = classify(info);
  if (!Object.values(ENTRY_CODES).includes(code)) {
    throw programError(`classifyUpstreamFailure 返回了未知分类码（A4 违约）：${String(code)}`);
  }
  return code;
}

/** 由分类码生成脱敏错误；分类码缺少文案时使用通用说明（不回显上游内容）。 */
function entryErrorFor(code) {
  return coded(code, MESSAGES[code] ?? `OpenAI 请求失败（${code}）`);
}

function upstreamCodeOf(parsed) {
  if (!isObj(parsed) || !isObj(parsed.error)) return undefined;
  const code = parsed.error.code ?? parsed.error.type;
  return typeof code === "string" ? code : undefined;
}

async function httpFailure(status, text) {
  const upstreamCode = upstreamCodeOf(parseJson(text));
  // OpenAI 专属拒绝载荷优先于状态码（待办 P7）。
  if (upstreamCode === "content_filter") return entryErrorFor(ENTRY_CODES.CONTENT_POLICY);
  const code = await classifyFailure({ status, upstreamCode, phase: "response" });
  return entryErrorFor(code);
}

async function transportFailure() {
  return entryErrorFor(await classifyFailure({ phase: "transport" }));
}

// ─── 请求 ────────────────────────────────────────────────────────────────────

/** OAI-001 配置：省略 model → 默认；显式值必须为非空白字符串（待办 P1：CONFIG_INVALID，零出站）。 */
function resolveModel(entry) {
  const raw = entry?.model;
  if (raw === undefined) return OPENAI_DEFAULT_MODEL;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw coded(CONFIG_CODES.INVALID, MESSAGES.configInvalid);
  }
  return raw;
}

function isUsableKey(key) {
  return typeof key === "string" && key.trim().length > 0;
}

/** OAI-001 要求2：只声明 web_search；required、max_tool_calls=1、store=false；无 stream、无结果数参数。 */
function buildBody(model, query) {
  return JSON.stringify({
    model,
    input: query,
    instructions: FIXED_INSTRUCTIONS,
    tools: [{ type: "web_search" }],
    tool_choice: "required",
    max_tool_calls: 1,
    store: false,
  });
}

/**
 * 发出唯一一次 POST（FB-001：不重试）。预算到期与宿主取消都经同一个内部 AbortController
 * 取消在途请求，并按原因区分结果（FB-003）。读取正文也在预算之内。
 */
async function roundTrip(ctx, clock, payload) {
  const { fetch, key, budgetMs, signal } = ctx;
  // FB-005 程序违约暴露：注入的 fetch 缺失属于装配错误，不是网络故障，因此不得落入下方 catch
  // 被吞成 ENTRY_NETWORK；此处在发出任何请求、挂接计时器之前直接抛出无码错误。
  if (typeof fetch !== "function") {
    throw programError("ctx.fetch 必须是函数（程序违约，非网络故障）");
  }
  const ac = new AbortController();
  let cause = null; // "host" | "budget"
  const onHostAbort = () => {
    cause ??= "host";
    ac.abort();
  };
  const onBudget = () => {
    cause ??= "budget";
    ac.abort();
  };
  signal?.addEventListener("abort", onHostAbort, { once: true });
  const timer = clock.setTimeout(onBudget, budgetMs);
  try {
    const res = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: payload,
      signal: ac.signal,
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  } catch (err) {
    if (cause === "host" || (cause === null && signal?.aborted)) throw hostCancelled();
    if (cause === "budget") throw coded(ENTRY_CODES.TIMEOUT, MESSAGES[ENTRY_CODES.TIMEOUT]);
    // P1-1：已带码的错误原样上抛（ENTRY_PROXY/CONFIG 码/TRANSPORT_RELEASED），不压成 ENTRY_NETWORK。
    if (carriesPassthroughCode(err)) throw err;
    // 网络层故障：不保留原始 error（可能含 key 或 cause 链），只输出分类后的脱敏错误。
    throw await transportFailure();
  } finally {
    clock.clearTimeout(timer);
    signal?.removeEventListener("abort", onHostAbort);
  }
}

// ─── 响应映射（OAI-002 / OAI-003）──────────────────────────────────────────────

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 解析失败返回 undefined（JSON 不会产生 undefined，故可区分）。 */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function badResponse() {
  return coded(ENTRY_CODES.BAD_RESPONSE, MESSAGES[ENTRY_CODES.BAD_RESPONSE]);
}

/** 仅接受绝对 HTTP(S) URL（FB-002）。返回原字符串以保持「同一 URL 字符串」的去重语义。 */
function validHttpUrl(value) {
  if (typeof value !== "string") return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : null;
}

/** snippet：文本块中首个非空段落（段落以空行分隔）。无则返回 undefined。 */
function firstParagraph(text) {
  if (typeof text !== "string") return undefined;
  for (const block of text.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** 拒绝终态：消息级 refusal 或 content 中的 refusal 部件（OAI-003 显式拒绝）。 */
function hasRefusal(output) {
  return (
    Array.isArray(output) &&
    output.some(
      (item) =>
        isObj(item) &&
        ((typeof item.refusal === "string" && item.refusal.length > 0) ||
          (Array.isArray(item.content) && item.content.some((part) => isObj(part) && part.type === "refusal"))),
    )
  );
}

/**
 * 取一条 url_citation 注释的来源字段承载对象。
 * 官方 Responses 形状为扁平（url/title 与 type 平级，见 developers.openai.com 工具指南「Output and citations」），
 * 故优先读扁平字段。兼容分支：历史 Chat-Completions 形状容错，官方 Responses 形状以扁平为准，
 * 仅当扁平 url 缺失或无效而嵌套 annotation.url_citation.url 存在时才使用嵌套对象。两形都缺 → null。
 */
function citationOf(annotation) {
  if (validHttpUrl(annotation.url) !== null) return annotation;
  if (isObj(annotation.url_citation) && validHttpUrl(annotation.url_citation.url) !== null) {
    return annotation.url_citation;
  }
  return null;
}

/**
 * OAI-002：按 output → 消息 content → 注释 的数组顺序，从 output_text 的 url_citation 提取来源。
 * 工具项与正文裸链接不产生来源；同一 URL 字符串只保留首现（仅有效来源参与去重）。
 */
function collectSources(output) {
  const seen = new Set();
  const sources = [];
  for (const item of output) {
    if (!isObj(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isObj(part) || part.type !== "output_text" || !Array.isArray(part.annotations)) continue;
      const snippet = firstParagraph(part.text);
      for (const annotation of part.annotations) {
        if (!isObj(annotation) || annotation.type !== "url_citation") continue;
        const citation = citationOf(annotation);
        if (citation === null) continue;
        const url = validHttpUrl(citation.url);
        if (url === null || seen.has(url)) continue;
        seen.add(url);
        const source = { url };
        const title = nonEmptyString(citation.title);
        if (title !== undefined) source.title = title;
        if (snippet !== undefined) source.snippet = snippet;
        sources.push(source);
      }
    }
  }
  return sources;
}

/** OAI-002/OAI-003：成功映射；无有效引用、未完成、结构错误均为 BAD_RESPONSE；拒绝为 CONTENT_POLICY。 */
function mapResponse(json, maxResults) {
  if (!isObj(json)) throw badResponse();
  // refusal / content_filter 优先于状态码（待办 P7）。
  if (hasRefusal(json.output) || json.incomplete_details?.reason === "content_filter") {
    throw coded(ENTRY_CODES.CONTENT_POLICY, MESSAGES[ENTRY_CODES.CONTENT_POLICY]);
  }
  if (json.status !== "completed" || !Array.isArray(json.output)) throw badResponse();
  const sources = collectSources(json.output);
  if (sources.length === 0) throw badResponse();
  // 返回全部映射来源；截断与 truncated 由链层统一执行（横向契约，FB-002）。
  return { sources };
}

// ─── 入口 ────────────────────────────────────────────────────────────────────

/**
 * 搜索一次。顺序：模型配置（零出站）→ key（零出站）→ 预算（零出站）→ 宿主取消（零出站）→ 唯一一次 POST。
 */
async function search(ctx) {
  const { entry, query, key, budgetMs, maxResults, signal, log } = ctx;
  const model = resolveModel(entry);
  if (!isUsableKey(key)) throw coded(ENTRY_CODES.CREDENTIALS, MESSAGES.keyMissing);
  if (!(budgetMs > 0)) throw coded(ENTRY_CODES.TIMEOUT, MESSAGES.noBudget);
  if (signal?.aborted) throw hostCancelled();

  const clock = ctx.clock ?? SYSTEM_CLOCK;
  const res = await roundTrip(ctx, clock, buildBody(model, query));
  log?.("info", "openai responses", { entryId: entry?.id, status: res.status });
  if (!res.ok) throw await httpFailure(res.status, res.text);
  return mapResponse(parseJson(res.text), maxResults);
}

/** Backend（A5）。contentMode 为 sources-only：resolve 永不携带 content（待办 P11）。 */
export const openaiBackend = Object.freeze({ type: "openai", contentMode: "sources-only", search });

export function createOpenAIBackend() {
  return openaiBackend;
}

export default openaiBackend;
