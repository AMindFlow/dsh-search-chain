// WP8 DeepSeek 自定义条目适配器（docs/specs/draft/deepseek.md DSK-001..DSK-004）。
// 同一模块服务两种模式：
//   - deepseek-search           独立 Search API（DSK-003/DSK-004）
//   - deepseek-agentic-search   Messages 服务端搜索（DSK-001/DSK-002）
// 合同（helpers/contract.js A5）：Backend = { type, search(ctx) }，
//   ctx = { entry, query, maxResults?, key, fetch, budgetMs, signal, clock, log }。
// 结果只返回 { sources }：FB-002 纯来源，不产出 content；截断与 truncated 归链级（P8），适配器不截断。
// 失败 throw 带 .code ∈ ENTRY_CODES 的错误；程序违约 throw 无 code 的普通错误（FB-005）。
//
// 同步义务：本文件的 DSK_* 常量与 test/helpers/deepseek-oracle.js 中同名常量必须保持同值，
// 改一处须同时改另一处。运行时不得 import test/ 下任何文件；ENTRY_CODES 取自本包镜像 ../constants.js。
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENTRY_CODES, carriesPassthroughCode, readBoundedText, bodyTooLargeMessage } from "../constants.js";

// ─── 规格常量（DSK-001..DSK-004 字面值）──────────────────────────────────────
const DSK_AGENTIC_ENDPOINT = "https://api.deepseek.com/anthropic/v1/messages";
const DSK_SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search";
const DSK_MODEL = "deepseek-flash";
const DSK_MAX_TOKENS = 256;
const DSK_TOOL = Object.freeze({ type: "web_search_20250305", name: "web_search", max_uses: 1 });
const DSK_COUNT_CAP = 50;
const DSK_QUERY_MAX_CHARS = 128;
/** DSK-001 固定指令：跨查询不变，只要求模型对用户消息中的查询执行一次搜索，不含查询本身。 */
const DSK_AGENTIC_INSTRUCTION =
  "你是搜索执行器。请对用户消息中的查询恰好调用一次 web_search 工具并等待结果；不要自行作答，不要发起其他搜索。";
/** DSK-002 结果块与工具错误类型（服务端搜索响应）。 */
const DSK_RESULT_BLOCK = "web_search_tool_result";
const DSK_RESULT_ITEM = "web_search_result";
const DSK_RESULT_ERROR_BLOCK = "web_search_tool_result_error";
const DSK_TOOL_RATE_LIMIT = "too_many_requests";

const NOT_JSON = Symbol("not-json");

/** 脱敏的固定文案：不拼接上游正文、请求头、key 或查询（CFG-003）。 */
const MESSAGES = Object.freeze({
  [ENTRY_CODES.CREDENTIALS]: "DeepSeek 拒绝了该条目的凭据或权限，请在该条目中检查 API key 与账户权限",
  [ENTRY_CODES.QUOTA]: "DeepSeek 额度不足，请检查账户余额或用量",
  [ENTRY_CODES.RATE_LIMITED]: "DeepSeek 请求被限流，可稍后重试",
  [ENTRY_CODES.NETWORK]: "无法直连 DeepSeek 接口，请检查网络或该条目的代理设置",
  [ENTRY_CODES.TIMEOUT]: "DeepSeek 请求超出该条目的预算时间",
  [ENTRY_CODES.BAD_RESPONSE]: "DeepSeek 返回了无法识别的响应",
  [ENTRY_CODES.CHANNEL_LIMIT]: "查询超过 DeepSeek Search API 的 128 个字符上限，请缩短查询",
});

/** 条目级失败：携带 ENTRY_CODES 之一的 code。不挂载 cause、headers、init 或 request。 */
function entryError(code, message) {
  const err = new Error(message);
  err.name = "EntryError";
  err.code = code;
  return err;
}

/** 宿主取消：不属于条目失败分类，链级据 AbortError 终止（FB-001/FB-003）。 */
function hostAbortError() {
  const err = new Error("宿主已取消本次搜索，未再发起请求");
  err.name = "AbortError";
  return err;
}

/** 程序违约：不带 ENTRY 码，向调用方暴露（FB-005）。 */
function programError(message) {
  return new Error(`程序违约：${message}`);
}

// ─── FB-005 分类（优先复用 src/search.js 的共享映射，缺失时用本地镜像兜底）──────
const SEARCH_MODULE_PATH = fileURLToPath(new URL("../search.js", import.meta.url));
let sharedClassifier;
/**
 * 解析共享分类函数（与 openai/exa/brave/gemini 同口径，A4）：
 * - ../search.js 不存在 → 本地镜像兜底（resolve null）；
 * - 文件存在但导入失败或未导出 classifyUpstreamFailure → 程序违约上抛（不带 ENTRY 码，不静默兜底）。
 * #12-25：加载失败（rejected）不得永久缓存；失败即重置，下一次调用重新探测。
 */
function loadSharedClassifier() {
  if (!sharedClassifier) {
    const pending = existsSync(SEARCH_MODULE_PATH)
      ? import("../search.js").then((mod) => {
          if (typeof mod.classifyUpstreamFailure !== "function") {
            throw programError("src/search.js 未导出 classifyUpstreamFailure（A4 违约）");
          }
          return mod.classifyUpstreamFailure;
        })
      : Promise.resolve(null);
    sharedClassifier = pending;
    pending.catch(() => {
      if (sharedClassifier === pending) sharedClassifier = undefined;
    });
  }
  return sharedClassifier;
}

/** 本地镜像：与 FB-005 / contract.js A4 的 info 形状一致。 */
function localClassify({ status, upstreamCode, phase }) {
  if (phase === "timeout") return ENTRY_CODES.TIMEOUT;
  if (phase === "transport") return ENTRY_CODES.NETWORK;
  // FB-005：上游错误码 insufficient_quota 优先于任何 HTTP 状态码分支。
  if (upstreamCode === "insufficient_quota") return ENTRY_CODES.QUOTA;
  if (status === 401 || status === 403) return ENTRY_CODES.CREDENTIALS;
  if (status === 402) return ENTRY_CODES.QUOTA;
  if (status === 429) return ENTRY_CODES.RATE_LIMITED;
  return ENTRY_CODES.BAD_RESPONSE;
}

/**
 * 共享分类器输出校验（A4，与 openai/exa/brave/gemini 四先例同构）：
 * 返回值不在 ENTRY_CODES 内（含 undefined/非字符串）→ 无码程序违约上抛，消息嵌入 String(code)；
 * 分类器自身抛异常 → 原样传播（不吞、不兜底）。仅共享分类器文件缺失时才用本地镜像。
 */
async function classifyFailure(info) {
  const shared = await loadSharedClassifier();
  if (!shared) return localClassify(info);
  const code = shared({ ...info });
  if (!Object.values(ENTRY_CODES).includes(code)) {
    throw programError(`classifyUpstreamFailure 返回了未知分类码（A4 违约）：${String(code)}`);
  }
  return code;
}

/** 从错误体取上游码（只用于分类，不进入任何文本）。 */
function upstreamCodeOf(parsed) {
  const e = isPlainObject(parsed) ? parsed.error : undefined;
  if (!isPlainObject(e)) return undefined;
  if (e.code === "insufficient_quota" || e.type === "insufficient_quota") return "insufficient_quota";
  return undefined;
}

// ─── 通用工具 ───────────────────────────────────────────────────────────────
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

/** 绝对 HTTP(S) URL 且无首尾空白；否则返回 null（FB-002）。 */
function absoluteHttpUrl(v) {
  if (typeof v !== "string" || v === "" || v !== v.trim()) return null;
  let u;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  return u.protocol === "http:" || u.protocol === "https:" ? v : null;
}

function note(ctx, code) {
  if (typeof ctx.log === "function") ctx.log("warn", `deepseek 条目 ${ctx.entry?.id ?? "?"} 失败：${code}`);
}

/** 校验程序契约（违约即抛无码错误，且不出站）。 */
function assertProgramContract(ctx) {
  if (typeof ctx?.fetch !== "function") throw programError("缺少 ctx.fetch（A6 应由链注入）");
  if (typeof ctx.query !== "string") throw programError("ctx.query 必须是字符串");
  if (typeof ctx.budgetMs !== "number" || !Number.isFinite(ctx.budgetMs)) {
    throw programError("ctx.budgetMs 必须是有限数字（FB-003）");
  }
}

/** 缺 key：拒绝且零出站（S4；链级 FB-001 已先行跳过）。 */
function requireKey(ctx) {
  if (typeof ctx.key !== "string" || ctx.key.trim() === "") {
    throw entryError(ENTRY_CODES.CREDENTIALS, "该 DeepSeek 条目缺少 API key，未发起请求");
  }
}

const realClock = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

/**
 * 单次出站（FB-003 / FB-001）：恰一次 POST，预算到期或宿主取消时中止在途请求，不重试。
 * 返回 { status, ok, text }；迟到的成功响应不被采纳（已过期则抛 TIMEOUT）。
 */
async function postOnce(ctx, url, body) {
  if (ctx.signal?.aborted) throw hostAbortError();
  const budget = Math.floor(ctx.budgetMs);
  if (!(budget > 0)) throw entryError(ENTRY_CODES.TIMEOUT, "该条目没有可用预算，未发起请求");

  const clock = ctx.clock ?? realClock;
  const budgetCtrl = new AbortController();
  let expired = false;
  const timer = clock.setTimeout(() => {
    expired = true;
    budgetCtrl.abort();
  }, budget);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, budgetCtrl.signal]) : budgetCtrl.signal;

  // 失败优先级：宿主取消 > 预算到期（或 AbortError）> 直连网络故障。
  const fail = async (cause) => {
    if (ctx.signal?.aborted) return hostAbortError();
    if (expired || cause?.name === "AbortError") {
      return entryError(ENTRY_CODES.TIMEOUT, MESSAGES[ENTRY_CODES.TIMEOUT]);
    }
    // P1-1：已带码的错误原样上抛（ENTRY_PROXY/CONFIG 码/TRANSPORT_RELEASED），不压成 ENTRY_NETWORK。
    if (carriesPassthroughCode(cause)) return cause;
    const code = await classifyFailure({ phase: "transport", error: cause });
    return entryError(code, MESSAGES[code] ?? MESSAGES[ENTRY_CODES.NETWORK]);
  };

  try {
    let response;
    try {
      response = await ctx.fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ctx.key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      throw await fail(cause);
    }
    // 字节上限（MAX_RESPONSE_BYTES，流式早停）：超限 tooLarge，2xx 在调用方归 BAD_RESPONSE 带尺寸诊断。
    let resBody;
    try {
      resBody = await readBoundedText(response);
    } catch (cause) {
      throw await fail(cause);
    }
    if (expired) throw entryError(ENTRY_CODES.TIMEOUT, MESSAGES[ENTRY_CODES.TIMEOUT]);
    if (ctx.signal?.aborted) throw hostAbortError();
    return { status: response.status, ok: response.ok, text: resBody.text, tooLarge: resBody.tooLarge, limit: resBody.limit };
  } finally {
    clock.clearTimeout(timer);
  }
}

/** 非 2xx：按 FB-005 分类，错误文案不含上游正文。 */
async function failOnHttpStatus(res) {
  const code = await classifyFailure({
    status: res.status,
    upstreamCode: upstreamCodeOf(parseJson(res.text)),
    phase: "response",
  });
  const msg = MESSAGES[code] ?? MESSAGES[ENTRY_CODES.BAD_RESPONSE];
  return entryError(code, `${msg}（HTTP ${res.status}）`);
}

// ─── DSK-003/DSK-004 Search API ─────────────────────────────────────────────
function toApiSource(item) {
  if (!isPlainObject(item)) return null;
  const url = absoluteHttpUrl(item.url);
  if (!url) return null;
  const out = { url };
  if (typeof item.title === "string") out.title = item.title;
  if (typeof item.snippet === "string") out.snippet = item.snippet;
  if (typeof item.summary === "string") out.summary = item.summary;
  if (typeof item.date === "string") out.publishedAt = item.date;
  return out;
}

async function searchApi(ctx) {
  assertProgramContract(ctx);
  requireKey(ctx);
  if ([...ctx.query].length > DSK_QUERY_MAX_CHARS) {
    throw entryError(ENTRY_CODES.CHANNEL_LIMIT, MESSAGES[ENTRY_CODES.CHANNEL_LIMIT]);
  }

  const body = { query: ctx.query, need_content: false };
  if (Number.isInteger(ctx.maxResults) && ctx.maxResults >= 1) {
    body.count = Math.min(ctx.maxResults, DSK_COUNT_CAP);
  }

  let res;
  try {
    res = await postOnce(ctx, DSK_SEARCH_ENDPOINT, body);
  } catch (err) {
    note(ctx, err.code ?? err.name);
    throw err;
  }
  if (!res.ok) {
    const err = await failOnHttpStatus(res);
    note(ctx, err.code);
    throw err;
  }

  if (res.tooLarge) throw entryError(ENTRY_CODES.BAD_RESPONSE, `DeepSeek ${bodyTooLargeMessage(res.limit)}`);
  const parsed = parseJson(res.text);
  if (!isPlainObject(parsed) || !Array.isArray(parsed.results)) {
    throw entryError(ENTRY_CODES.BAD_RESPONSE, `${MESSAGES[ENTRY_CODES.BAD_RESPONSE]}：缺少 results 数组`);
  }
  const sources = [];
  for (const item of parsed.results) {
    const s = toApiSource(item);
    if (s) sources.push(s);
  }
  if (parsed.results.length > 0 && sources.length === 0) {
    throw entryError(ENTRY_CODES.BAD_RESPONSE, `${MESSAGES[ENTRY_CODES.BAD_RESPONSE]}：结果没有有效 URL`);
  }
  return { sources };
}

// ─── DSK-001/DSK-002 Agentic Search ─────────────────────────────────────────
async function searchAgentic(ctx) {
  assertProgramContract(ctx);
  requireKey(ctx);

  const body = {
    model: DSK_MODEL,
    max_tokens: DSK_MAX_TOKENS,
    thinking: { type: "disabled" },
    system: DSK_AGENTIC_INSTRUCTION,
    messages: [{ role: "user", content: ctx.query }],
    tools: [{ ...DSK_TOOL }],
  };

  let res;
  try {
    res = await postOnce(ctx, DSK_AGENTIC_ENDPOINT, body);
  } catch (err) {
    note(ctx, err.code ?? err.name);
    throw err;
  }
  if (!res.ok) {
    const err = await failOnHttpStatus(res);
    note(ctx, err.code);
    throw err;
  }

  const bad = (why) => entryError(ENTRY_CODES.BAD_RESPONSE, `${MESSAGES[ENTRY_CODES.BAD_RESPONSE]}：${why}`);
  if (res.tooLarge) throw entryError(ENTRY_CODES.BAD_RESPONSE, `DeepSeek ${bodyTooLargeMessage(res.limit)}`);
  const parsed = parseJson(res.text);
  if (!isPlainObject(parsed) || !Array.isArray(parsed.content)) throw bad("缺少 content 数组");

  let toolErrorCode;
  let sawResultBlock = false;
  let hasResultItems = false;
  const sources = [];
  const seen = new Set();

  for (const block of parsed.content) {
    if (!isPlainObject(block)) throw bad("content 块不是对象");
    if (block.type === DSK_RESULT_ERROR_BLOCK) {
      toolErrorCode ??=
        block.error_code === DSK_TOOL_RATE_LIMIT ? ENTRY_CODES.RATE_LIMITED : ENTRY_CODES.BAD_RESPONSE;
      continue;
    }
    if (block.type !== DSK_RESULT_BLOCK) continue;
    sawResultBlock = true;
    if (!Array.isArray(block.content)) throw bad("搜索结果块的 content 不是数组");
    if (block.content.length > 0) hasResultItems = true;
    for (const item of block.content) {
      if (!isPlainObject(item)) throw bad("搜索结果项不是对象");
      if (item.type !== DSK_RESULT_ITEM) continue;
      const url = absoluteHttpUrl(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const src = { url };
      if (typeof item.title === "string") src.title = item.title;
      if (typeof item.snippet === "string") src.snippet = item.snippet;
      sources.push(src);
    }
  }

  if (toolErrorCode) {
    const msg = MESSAGES[toolErrorCode] ?? MESSAGES[ENTRY_CODES.BAD_RESPONSE];
    const err = entryError(toolErrorCode, msg);
    note(ctx, err.code);
    throw err;
  }
  if (!sawResultBlock) throw bad("模型未触发 web_search 工具");
  if (hasResultItems && sources.length === 0) throw bad("搜索结果没有有效 URL");
  return { sources };
}

/** A5 Backend：两模式各一个，按模块导出供链与测试按 entry.type 选取（S1）。 */
export const deepseekSearchBackend = Object.freeze({
  type: "deepseek-search",
  search: (ctx) => searchApi(ctx),
});

export const deepseekAgenticSearchBackend = Object.freeze({
  type: "deepseek-agentic-search",
  search: (ctx) => searchAgentic(ctx),
});

export const deepseekBackends = Object.freeze({
  "deepseek-search": deepseekSearchBackend,
  "deepseek-agentic-search": deepseekAgenticSearchBackend,
});
