// WP11 Gemini Google Search grounding 适配器（Issue #10「WP11 Gemini 适配」）。
// 规格来源：
//   docs/specs/draft/gemini.md          GMI-001 搜索请求与证据（主规格：/v1beta/interactions、
//                                       x-goog-api-key、google_search 工具、store:false、单查询）；
//                                       GMI-002 宿主展示与发布条件（上游搜索建议 HTML 不入库）
//   docs/specs/draft/fallback.md        FB-001（每条目最多一次出站、宿主取消终止、内容策略终止）、
//                                       FB-002（绝对 HTTP(S) URL、来源顺序、纯来源语义）、
//                                       FB-003（预算与取消、受控时钟）、FB-005（失败分类与脱敏排查）
//   docs/specs/draft/config-network.md  CFG-002（key 解析在链完成，ctx.key 即条目 key）、
//                                       CFG-003（凭据隔离与脱敏）
//   docs/specs/draft/providers.md       CAT-001（Gemini 类型，凭据 GEMINI_API_KEY）
//
// 契约（test/helpers/contract.js A5 / test/helpers/gemini-oracle.js 头注）：
//   createGeminiBackend() → { type: "gemini", search(ctx) }
//   ctx = { entry, query, maxResults, key, fetch, budgetMs, signal, clock, log }
//   成功 resolve { sources: [{ url, title? }] }——不带 content（P-05）、不带 snippet（P-06）、
//     不带 truncated（FB-002 截断与标记由链补齐，适配器不负责）；空数组=明确无结果（FB-004/P-09a）。
//   失败 throw 携带 .code ∈ ENTRY_CODES 的错误（FB-005）；宿主取消 throw 不带 ENTRY 码的
//     AbortError（FB-001/P-14）；内部程序违约 throw 不带 code 的错误（FB-005）。
//   出站恰一次（GMI-001/FB-001）；init.signal = ctx.signal 与预算中止的合并信号（FB-003）；
//   预算只经 ctx.clock.setTimeout 调度（受控时钟，禁止全局 setTimeout/Date.now）。
//
// 运行时零 import test/：ENTRY_CODES 复用 src/constants.js 本地镜像（镜像 test/helpers/contract.js，
// 同步义务见该文件头注）。
//
// ─── P-01..P-14 逐条裁决（规格行号指 docs/specs/draft/gemini.md；FB/CFG 行号指各自草案）──────────────
// P-01 请求字段：body.input = 查询字符串逐字，body.model = gemini- 前缀模型（gemini.md:5 只钉「支持
//      grounding 的 Gemini 模型」，未钉字段名与默认值）。默认 gemini-2.5-flash（官方 grounding 文档
//      长期支持的 GA 模型，推断，见 PR 报告「未验证项」）；entry.model 非空字符串可覆盖，
//      非字符串/空白 → CONFIG_INVALID 零出站（对齐 OAI 做法）。
// P-02 生成参数：规格未指定任何生成参数 → body 只含 model/input/store/tools 四键，无 null、
//      无 generation 键（gemini.md:5）。
// P-03 tools：仅一项 { type: "google_search" }（gemini.md:5 只要求启用该服务端工具）。
// P-04 Content-Type: application/json（JSON body 标准头；官方 curl 样例同形）。
// P-05 content：sources-only。GMI-002（gemini.md:12）禁止上游 HTML 入模型文本或普通来源摘要，且
//      未定义 Gemini 展示通道（gemini.md:18 设计决定：dsh 默认只投影 sources/content/truncated）→
//      成功结果不带 content，模型正文与搜索建议 HTML 一律不返回。
// P-06 snippet：规格未定义 Gemini 摘要路径，不从正文推导 → 来源只含 url/title（title 缺失时省略键）。
// P-07 去重：同一 URL 字符串只保留首次出现（对齐 OAI-002 去重约定，推断）。
// P-08 有引用但全部无效 → ENTRY_BAD_RESPONSE（对齐 FB-005 异常响应与 OAI-003，推断）。
// P-09a 有搜索证据且零引用 → 成功 sources: []（明确无结果，FB-004）。
// P-09b 无搜索证据（无 google_search_call/google_search_result 步骤）→ ENTRY_BAD_RESPONSE
//      （gemini.md:6「缺少该证据…按降级规格处理」，选失败码而非空结果，推断）。
// P-10a status=failed 无安全原因 → ENTRY_BAD_RESPONSE（FB-005 异常响应）。
// P-10b 内容安全拦截 → ENTRY_CONTENT_POLICY（FB-001 fallback.md:8 终止类）。拦截体形状规格未写明，
//      按冻结测试形状 { status: "failed", error: { code: "SAFETY" } } 实现；并把官方 API errors 文档
//      列出的 generation-blocked 码族（safety/recitation/prohibited_content/spii/blocklist/content_policy，
//      大小写不敏感，error.code 或 error.status 命中即算）一并归 CONTENT_POLICY——超冻结面的合理扩展，
//      不影响任何冻结断言（见 PR 报告「官方文档核对结论」）。
// P-11 429 + RESOURCE_EXHAUSTED + 配额文案 → ENTRY_QUOTA。与 FB-005 字面（fallback.md:34「其他 429
//      属限流」）冲突：按协调暂裁执行 pending 双收面——Gemini 专属额度载荷在 httpFailure 内先行判定
//      （QUOTA），其余 429 交通用分类器（RATE_LIMITED）；WP6 契约轮统一定案前本实现为临时口径。
// P-12 5xx → ENTRY_BAD_RESPONSE（FB-005 异常响应；规格未给 5xx 映射，推断）且只出站一次（FB-001）。
// P-13 预算为 0/负/非有限 → 拒绝且码 ENTRY_TIMEOUT（FB-005 单项超时），零出站（FB-003）。
// P-14 宿主取消：err.name = "AbortError" 且不带条目分类码（fetch 取消惯例，FB-001 不可降级）。
// ────────────────────────────────────────────────────────────────────────────────────────────────────
//
// 失败分类（FB-005）：Gemini 专属载荷（安全拦截、429 配额体）由本文件直接判定；其余 HTTP/传输分类
// 优先动态加载 src/search.js 的 classifyUpstreamFailure（A4，WP5 负责）。该文件不存在时使用本地镜像
// localClassifyUpstreamFailure 兜底（同 WP3 openai.js / WP8 exa.js 做法）。WP5 合入后本镜像即为死代码，
// 去留交协调（见 PR 交付记录「契约意见增量」）。
//
// ─── 官方文档核对结论（2026-11-24，联网核对；详见 PR 报告）──────────────────────────────────────────
// 已确认：POST /v1beta/interactions 端点；x-goog-api-key 头鉴权（无 Bearer/无 ?key=）；请求字段
// model/input/tools/store；响应 status（completed/in_progress/failed）；steps 形状
// （user_input / thought / model_output.content[].text.annotations / google_search_call /
// google_search_result / function_call / function_result）；url_citation 扁平字段
// url/title/start_index/end_index；google_search_result 含搜索建议 HTML（Terms 要求完整展示）；
// HTTP 错误包络 { error: { code, message } } 与 generation-blocked 码族（safety 等）。
// 未确认：Interactions 下 SAFETY 拦截的精确响应体（官方只公布 generateContent 的
// promptFeedback.blockReason / finishReason=SAFETY 与错误码表；冻结测试钉的是
// status=failed + error.code=SAFETY，按冻结面实现）；outputs 旧式形状（oracle 标注推断）。
// ────────────────────────────────────────────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONFIG_CODES, ENTRY_CODES } from "../constants.js";

/** GMI-001：规定端点，精确匹配（无 query、无路径模型参数，模型置于 body）。 */
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
/** P-01：默认模型（支持 Google Search grounding 的 GA 模型，规格未钉默认值，推断，见报告未验证项）。 */
const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * P-10b：官方 API errors 文档的 generation-blocked 码族（小写归一后匹配）。
 * 命中即「明确的上游内容策略拒绝」（FB-001 终止类，FB-005 CONTENT_POLICY）。
 * 冻结测试只钉 SAFETY；扩展为码族是对官方文档的合理超集，不触碰任何冻结断言。
 */
const SAFETY_BLOCK_CODES = new Set([
  "safety",
  "recitation",
  "prohibited_content",
  "spii",
  "blocklist",
  "content_policy",
]);

/** 固定脱敏文案（CFG-003 / FB-005：不含 key、不回显响应体、不挂原始 cause，只指向可核查配置）。 */
const MESSAGES = Object.freeze({
  [ENTRY_CODES.CREDENTIALS]: "Gemini 条目「%ENTRY%」返回鉴权或权限错误（401/403）：请核对该条目的 GEMINI_API_KEY 凭据及权限（CFG-002）",
  [ENTRY_CODES.QUOTA]: "Gemini 条目「%ENTRY%」额度不足或计费未生效（402 / 429 配额）：请在 Google 账户核对额度与计费",
  [ENTRY_CODES.RATE_LIMITED]: "Gemini 条目「%ENTRY%」被限流（429）：请稍后重试，或降低该条目的调用频率",
  [ENTRY_CODES.PROXY]: "Gemini 条目「%ENTRY%」代理失败：请核对该条目的代理/PAC 配置（CFG-001/CFG-005）",
  [ENTRY_CODES.NETWORK]: "Gemini 条目「%ENTRY%」无法连接 Gemini 端点（直连网络故障）：请检查直连网络或该条目的代理设置（CFG-001）",
  [ENTRY_CODES.CHANNEL_LIMIT]: "Gemini 条目「%ENTRY%」请求被上游拒绝（HTTP 4xx）：请检查该条目的模型设置与请求参数",
  [ENTRY_CODES.TIMEOUT]: "Gemini 条目「%ENTRY%」请求超过本条目的时间预算，已取消在途请求（FB-003）",
  [ENTRY_CODES.BAD_RESPONSE]: "Gemini 条目「%ENTRY%」上游返回了无法使用的响应：非 JSON、结构不符、未完成、缺少搜索证据或没有有效引用",
  [ENTRY_CODES.CONTENT_POLICY]: "Gemini 条目「%ENTRY%」本次搜索被上游内容策略拒绝（安全拦截）：该条目终止，不再向其重试（FB-001）",
  keyMissing: "Gemini 条目「%ENTRY%」缺少 GEMINI_API_KEY：请在该条目或 GEMINI_API_KEY 环境变量中配置（CFG-002），未发出请求",
  configInvalid: "Gemini 条目「%ENTRY%」的 model 必须为非空字符串；删除该项即使用默认模型 %MODEL%",
  noBudget: "Gemini 条目「%ENTRY%」没有可用的时间预算，未发出请求（FB-003）",
  hostCancelled: "搜索已被宿主取消",
});

/** 无注入时钟时的回退（ctx.clock 缺省才用；正常由链提供受控/真实时钟）。 */
const SYSTEM_CLOCK = Object.freeze({
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
});

// ─── 错误构造（CFG-003：不附 cause/headers/init/原始响应体）─────────────────────────────────────────

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function entryRefOf(ctx) {
  const entry = ctx?.entry;
  return entry?.name ?? entry?.id ?? "未知条目";
}

/** 由固定文案模板生成脱敏错误文本（%ENTRY%/%MODEL% 只替换为配置侧标识，不含凭据或上游内容）。 */
function withEntry(template, entryRef, extraModel = "") {
  return template.replaceAll("%ENTRY%", entryRef).replaceAll("%MODEL%", extraModel);
}

/** 条目级失败：携带 .code，面向链（WP5）按 FB-004/FB-005 聚合。 */
function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function entryErrorFor(code, entryRef) {
  return coded(code, withEntry(MESSAGES[code] ?? `Gemini 请求失败（${code}）`, entryRef));
}

/** 宿主取消（P-14）：name=AbortError，不带 ENTRY 码（FB-001 不可降级）。 */
function hostCancelled() {
  const err = new Error(MESSAGES.hostCancelled);
  err.name = "AbortError";
  return err;
}

/** 程序违约：无 code，向调用方暴露（FB-005「内部程序违约向调用方暴露」）。 */
function programError(message) {
  return new Error(message);
}

// ─── 失败分类（FB-005）────────────────────────────────────────────────────────────────────────────

/**
 * 本地镜像分类器（search.js 缺失时兜底）：与 A4/WP5 classifyUpstreamFailure(info) 同契约——
 * info = { status?, upstreamCode?, phase? ("transport"|"response"|"timeout"), error? } → ENTRY_* 码。
 * 语义逐条来自 FB-005（fallback.md:34）；4xx 其余归通道参数限制，5xx/无法解析归异常响应。
 */
function localClassifyUpstreamFailure(info) {
  const { phase, status, upstreamCode } = info ?? {};
  if (phase === "timeout") return ENTRY_CODES.TIMEOUT;
  if (phase === "transport") return ENTRY_CODES.NETWORK;
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
 * 解析通用分类函数（与 WP3/WP8 做法一致，进程内只探测一次）：
 * - ../search.js 不存在（本分支 WP5 未合入）→ 本地镜像兜底；
 * - 文件存在但导入失败或未导出 classifyUpstreamFailure → A4 程序违约，向上抛出（不带 ENTRY 码）。
 */
function upstreamClassifier() {
  classifierPromise ??= existsSync(SEARCH_MODULE_PATH)
    ? import("../search.js").then((mod) => {
        if (typeof mod?.classifyUpstreamFailure !== "function") {
          throw programError("src/search.js 未导出 classifyUpstreamFailure（A4 违约）");
        }
        return mod.classifyUpstreamFailure;
      })
    : Promise.resolve(localClassifyUpstreamFailure);
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

/** 上游错误包络解析失败返回 undefined（JSON 不会产生 undefined，故可区分）。 */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorOf(parsed) {
  return isObj(parsed) && isObj(parsed.error) ? parsed.error : null;
}

/** P-10b：安全拦截判定（顶层载荷或其 error 的 code/status 命中 generation-blocked 码族）。 */
function isSafetyBlock(payload) {
  if (!isObj(payload)) return false;
  const candidates = [payload, errorOf(payload)].filter(Boolean);
  for (const candidate of candidates) {
    for (const field of ["code", "status"]) {
      const value = candidate[field];
      if (typeof value === "string" && SAFETY_BLOCK_CODES.has(value.toLowerCase())) return true;
    }
  }
  return false;
}

/** P-11：Gemini 额度载荷（insufficient_quota / RESOURCE_EXHAUSTED / 配额文案），用于 429 的额度/限流分界。 */
function isQuotaPayload(payload) {
  const err = errorOf(payload);
  if (!err) return false;
  const code = typeof err.code === "string" ? err.code.toLowerCase() : "";
  const status = typeof err.status === "string" ? err.status.toLowerCase() : "";
  const message = typeof err.message === "string" ? err.message : "";
  return (
    code === "insufficient_quota" ||
    code === "resource_exhausted" ||
    status === "resource_exhausted" ||
    /quota/i.test(message)
  );
}

/** A4 的 upstreamCode：仅取字符串形态的 error.code（数字码不参与分类，由 status 兜底）。 */
function upstreamCodeOf(parsed) {
  const err = errorOf(parsed);
  if (!err) return undefined;
  return typeof err.code === "string" ? err.code : undefined;
}

async function httpFailure(status, text, entryRef) {
  const parsed = parseJson(text);
  // Gemini 专属拒绝载荷优先于状态码（P-10b / P-11 裁决）。
  if (isSafetyBlock(parsed)) return entryErrorFor(ENTRY_CODES.CONTENT_POLICY, entryRef);
  if (status === 429 && isQuotaPayload(parsed)) return entryErrorFor(ENTRY_CODES.QUOTA, entryRef);
  const code = await classifyFailure({ status, upstreamCode: upstreamCodeOf(parsed), phase: "response" });
  return entryErrorFor(code, entryRef);
}

async function transportFailure(entryRef) {
  return entryErrorFor(await classifyFailure({ phase: "transport" }), entryRef);
}

// ─── 请求成形（GMI-001 / P-01..P-04）──────────────────────────────────────────────────────────────

/** P-01：省略 model → 默认；显式值必须为非空白字符串，否则 CONFIG_INVALID（零出站，对齐 OAI 做法）。 */
function resolveModel(entry) {
  const raw = entry?.model;
  if (raw === undefined) return GEMINI_DEFAULT_MODEL;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw coded(CONFIG_CODES.INVALID, withEntry(MESSAGES.configInvalid, entryRefOf({ entry }), GEMINI_DEFAULT_MODEL));
  }
  return raw;
}

function isUsableKey(key) {
  return typeof key === "string" && key.trim().length > 0;
}

/**
 * GMI-001 请求体：只含 model / input / store / tools 四键（P-02：无生成参数、无 null）；
 * input 为查询字符串逐字（单查询只出现一次，P-01）；tools 仅 google_search 一项（P-03）；
 * store 严格 false。key 只随 x-goog-api-key 头发送（CFG-003），不进 URL、不进 body。
 */
function buildBody(model, query) {
  return JSON.stringify({
    model,
    input: query,
    store: false,
    tools: [{ type: "google_search" }],
  });
}

// ─── 响应映射（GMI-001 证据与引用 / GMI-002 展示边界 / FB-002 来源有效性）──────────────────────────

/** FB-002/A1：仅接受可解析的绝对 HTTP(S) URL；返回原字符串以保持「同一 URL 字符串」的去重语义。 */
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

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function badResponse(entryRef) {
  return entryErrorFor(ENTRY_CODES.BAD_RESPONSE, entryRef);
}

/**
 * outputs（旧式）与 steps（新式）双收（P-01 说明 / oracle 双收约定）：
 * 顶层数组优先 outputs；否则 steps；两者皆非数组 → 结构错误。
 */
function itemsOf(json) {
  if (Array.isArray(json.outputs)) return json.outputs;
  if (Array.isArray(json.steps)) return json.steps;
  return null;
}

/** GMI-001 证据：存在 google_search_call 或 google_search_result 步骤才算实际完成服务端搜索。 */
function hasSearchEvidence(items) {
  return items.some(
    (item) => isObj(item) && (item.type === "google_search_call" || item.type === "google_search_result"),
  );
}

/**
 * 统一取注释数组：outputs 旧式的 { type: "text", annotations } 顶层项，
 * 与 steps 新式 model_output.content[].annotations 部件，两者同语义（P-01 双收）。
 * google_search_result 的搜索建议 HTML（rendered_content/search_suggestions）不在此列（GMI-002）。
 */
function* annotationArraysOf(item) {
  if (!isObj(item)) return;
  if (Array.isArray(item.annotations)) yield item.annotations;
  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (isObj(part) && Array.isArray(part.annotations)) yield part.annotations;
    }
  }
}

/**
 * GMI-001/FB-002/P-07：按注释出现顺序提取 url_citation；无效条目丢弃（null、非 url_citation、
 * 非字符串/不可解析/非 HTTP(S) url），同一 URL 字符串只保留首现（标题取首次）。
 * 正文裸链接与模型文本不产生来源（GMI-001：来源只来自引用）。
 */
function collectSources(items) {
  const seen = new Set();
  const sources = [];
  let citationCount = 0;
  for (const item of items) {
    for (const annotations of annotationArraysOf(item)) {
      for (const annotation of annotations) {
        if (!isObj(annotation) || annotation.type !== "url_citation") continue;
        citationCount += 1;
        const url = validHttpUrl(annotation.url);
        if (url === null || seen.has(url)) continue;
        seen.add(url);
        const source = { url };
        const title = nonEmptyString(annotation.title);
        if (title !== undefined) source.title = title; // P-06：不带 snippet/summary，不编造
        sources.push(source);
      }
    }
  }
  return { sources, citationCount };
}

/**
 * GMI-001 成功判据：只有 status=completed、具备搜索证据、且引用可映射时才算成功。
 * - 非 completed（含 failed）：安全拦截 → CONTENT_POLICY（P-10b），其余 → BAD_RESPONSE（P-10a）。
 * - 缺 outputs/steps 或皆非数组 → BAD_RESPONSE（FB-005 结构错）。
 * - 无搜索证据 → BAD_RESPONSE（P-09b）。
 * - 有 url_citation 但全部无效 → BAD_RESPONSE（P-08）；零引用（有证据）→ 成功 sources: []（P-09a）。
 * 成功结果不带 content（P-05）、不带 truncated（链补齐）。
 */
function mapResponse(json, entryRef) {
  if (!isObj(json)) throw badResponse(entryRef); // 顶层数组/标量 → 结构错
  if (json.status !== "completed") {
    throw isSafetyBlock(json)
      ? entryErrorFor(ENTRY_CODES.CONTENT_POLICY, entryRef)
      : badResponse(entryRef);
  }
  const items = itemsOf(json);
  if (items === null) throw badResponse(entryRef);
  if (!hasSearchEvidence(items)) throw badResponse(entryRef);
  const { sources, citationCount } = collectSources(items);
  if (citationCount > 0 && sources.length === 0) throw badResponse(entryRef);
  return { sources };
}

// ─── 预算与取消（FB-003）──────────────────────────────────────────────────────────────────────────

/**
 * 发出唯一一次 POST（FB-001：不重试）。ctx.signal 与预算中止合并到同一内部 AbortController：
 * 预算到期 → ENTRY_TIMEOUT（P-13 语义的终态）；宿主取消 → AbortError 无码（P-14）。
 * 读取响应正文也在预算之内；任何原因都不得二次提交查询。
 */
async function roundTrip(ctx, clock, payload) {
  const { fetch, key, budgetMs, signal } = ctx;
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
    const res = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      // P-04/GMI-001/CFG-003：application/json + x-goog-api-key 头；无 Authorization、无 ?key=。
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: payload,
      signal: ac.signal,
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  } catch {
    if (cause === "host" || (cause === null && signal?.aborted)) throw hostCancelled();
    if (cause === "budget") throw entryErrorFor(ENTRY_CODES.TIMEOUT, entryRefOf(ctx));
    // 网络层故障：不保留原始 error（可能含 key 或 cause 链），只输出分类后的脱敏错误（CFG-003）。
    throw await transportFailure(entryRefOf(ctx));
  } finally {
    clock.clearTimeout(timer);
    signal?.removeEventListener("abort", onHostAbort);
  }
}

// ─── 入口（A5 seam）──────────────────────────────────────────────────────────────────────────────

/**
 * 搜索一次。顺序（均零出站）：fetch 可用（程序违约）→ 模型配置（CONFIG_INVALID）→ key（CREDENTIALS）
 * → 预算（TIMEOUT）→ 宿主预取消（AbortError 无码）→ 唯一一次 POST → 分类或映射。
 */
async function search(ctx) {
  const log = typeof ctx?.log === "function" ? ctx.log : () => {};
  const entryRef = entryRefOf(ctx);

  // FB-005「内部程序违约向调用方暴露」：fetch 不可用不包装为 ENTRY 码。
  if (typeof ctx?.fetch !== "function") {
    throw programError(`search-chain: Gemini 条目「${entryRef}」上下文缺少可用 fetch（内部程序违约）`);
  }

  const model = resolveModel(ctx.entry);
  if (!isUsableKey(ctx.key)) throw entryErrorFor(ENTRY_CODES.CREDENTIALS, entryRef);
  const budgetMs = typeof ctx.budgetMs === "number" ? ctx.budgetMs : Number.NaN;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw coded(ENTRY_CODES.TIMEOUT, withEntry(MESSAGES.noBudget, entryRef)); // P-13
  }
  if (ctx.signal?.aborted) throw hostCancelled(); // 预取消零出站（FB-003）

  const clock = ctx.clock ?? SYSTEM_CLOCK;
  const res = await roundTrip(ctx, clock, buildBody(model, ctx.query));
  log("info", "gemini interactions", { entryId: ctx.entry?.id, status: res.status });

  if (!res.ok) {
    log("warn", "gemini upstream error status", { entryId: ctx.entry?.id, status: res.status });
    throw await httpFailure(res.status, res.text, entryRef);
  }
  const parsed = parseJson(res.text);
  if (parsed === undefined) {
    // 200 但非 JSON：异常响应（FB-005），经通用分类器归码（镜像：BAD_RESPONSE）。
    const code = await classifyFailure({ phase: "response", status: res.status });
    log("warn", "gemini upstream body is not valid JSON", { entryId: ctx.entry?.id, status: res.status, code });
    throw entryErrorFor(code, entryRef);
  }
  return mapResponse(parsed, entryRef);
}

/** A5 后端形状：{ type: "gemini", search(ctx) }。sources-only（P-05），content 永不携带。 */
export function createGeminiBackend() {
  return Object.freeze({ type: "gemini", search });
}
