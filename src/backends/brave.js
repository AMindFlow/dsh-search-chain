// WP10 Brave Web Search API 适配器（Issue #9「WP10 Brave 适配」）。
// 规格来源：
//   docs/specs/draft/brave.md             BRV-001 要求1（请求与来源）、要求2（映射与失败）、验收（主规格）
//   docs/specs/draft/fallback.md          FB-001（缺 key 零出站/每条目一次提交/取消终止）、FB-002（来源顺序/纯来源/
//                                         truncated）、FB-003（预算与取消）、FB-005（失败分类）
//   docs/specs/draft/config-network.md    CFG-002（key 来源）、CFG-003（凭据隔离与脱敏）
//   docs/specs/draft/providers.md         CAT-001（Brave 类型，凭据 BRAVE_API_KEY）
// 契约：test/helpers/contract.js A5 —— Backend = { type: "brave", search(ctx) }，
//   ctx = { entry, query, maxResults?, key, fetch, budgetMs, signal, clock, log }；
//   成功 resolve { sources, truncated }（空数组=明确无结果 FB-004；truncated 按 FB-002 由适配器给出，
//   oracle assertSearchResult 直接断言该布尔——A5 形状分歧已由 WP9 提请统一，见 TODO-BRV-P8）；
//   纯来源适配器不携带 content（FB-002）；
//   失败 throw 携带 .code ∈ ENTRY_CODES 的错误；宿主取消 throw 不带 ENTRY_* 码的 AbortError（P7）；
//   内部程序违约 throw 不带 code 的错误（FB-005）。
// 运行时零 import test/：下方常量为 test helpers 的本地镜像（见同步义务）。
//
// ─── P1..P9 裁决记录（test/brave-pending.test.js 待办清单；行号指各草案）──────────────────────────────
// TODO-BRV-P1   description 精确落点：取 snippet（FB-002「标题和摘要按适配规格提供」；A1 宿主
//               WebSearchSource 的 snippet 为摘要标准字段；brave.md:6 只写 description，未定字段）。
// TODO-BRV-P2   缺 title 但 URL 有效：保留该来源（FB-002 只强制 URL 为可解析绝对 HTTP(S)；
//               A1 中 title 可选；brave.md:6「提取有效 url、title、description」的「有效」按 FB-002 收口）。
// TODO-BRV-P3   200 且缺 web 字段：ENTRY_BAD_RESPONSE（brave.md:6「可识别的空网页结果」指 web.results 为
//               空数组；结构缺失属「畸形数据」，同一行按降级规格报告）。
// TODO-BRV-P4   5xx 精确码：ENTRY_BAD_RESPONSE（FB-005「异常响应」类目；可降级且非凭据/额度/限流；
//               FB-005:34 未列 5xx，同族 WP2/WP9 同口径）。
// TODO-BRV-P5   直连网络失败：ENTRY_NETWORK（FB-005「直连网络」；适配器层只经 ctx.fetch（A6），
//               代理/直连区分在 transport 路由标记，条目级统一 NETWORK，同族口径）。
// TODO-BRV-P6   budgetMs=0：ENTRY_TIMEOUT（FB-005「单项超时」类目；零出站已由 brave-cancel 断言，
//               FB-003:21「无可用时间时不得发出请求」）。
// TODO-BRV-P7   宿主取消错误形状：name="AbortError" 且不带 ENTRY_* code（FB-001:8 宿主取消为终止类，
//               链不得当作可降级失败继续；预取消与在途取消同形状）。
// TODO-BRV-P8   截断责任（已裁决：归链）：适配器返回全量来源且 truncated:false；maxResults 截断与
//               truncated 置位由链 WP5 buildSuccessResult 实现（FB-002 在插件边界满足；适配器不截断为全后端契约）。
// TODO-BRV-P9   计数口径：字符数取 UTF-16 码元（JS String.length），词数取空白拆分后非空段计数；
//               600/75 边界含；超限 → ENTRY_CHANNEL_LIMIT 且零出站（不得出站后截断，brave.md:5）。
// ─── 其余 oracle 头注（test/helpers/brave-oracle.js）裁决 ──────────────────────────────────────────
// TODO-BRV-1    导出形状：取 oracle 容忍顺序第一形态——命名导出 braveBackend = { type: "brave", search }。
// TODO-BRV-2    freshness/时效参数：brave.md 未定义任何 freshness 参数 → 不发送（未指定参数省略而非 null，
//               任务简报口径；若后续规格定名先回写 brave.md）。
// TODO-BRV-3    publishedAt：brave.md 只写 url/title/description，未定映射。本实现取 page_age（ISO 8601 校验，
//               非 ISO 丢弃该字段），不回落相对时间文本 age（A1 WebSearchSource 形状）；测试不断言。
// TODO-BRV-4    其余 4xx（非 401/402/403/429，如 400/422）本地镜像归类 ENTRY_CHANNEL_LIMIT
//               （FB-005「通道参数限制」类目；Brave 请求参数为固定集合，4xx 即参数被拒；
//               无 Brave 测试样本覆盖此档，WP5 classifyUpstreamFailure 合入后以其为准）。
// TODO-BRV-5    上游 code 提取形状：body.error.code（字符串）优先，其次 body.error.type（字符串），
//               用于 429 的额度/限流分界（FB-005:34「HTTP 402 或 insufficient_quota 属额度问题」）。
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// ─── 常量本地镜像（运行时零 import test/；同步义务）────────────────────────────────────────────────────
// 同步义务：本分支尚无共享常量模块（src/constants.js 由 WP1/WP2 主线提供）。上述字符串若任一侧改动，
// 必须同步另一侧并说明理由：
//   BRAVE_ENDPOINT          ↔ test/helpers/brave-oracle.js#BRAVE_ENDPOINT（brave.md:5 规格原文）
//   BRAVE_MAX_CHARS/WORDS   ↔ test/helpers/brave-oracle.js#BRAVE_MAX_CHARS/BRAVE_MAX_WORDS（brave.md:5）
//   BRAVE_MAX_COUNT         ↔ test/helpers/brave-oracle.js#BRAVE_MAX_COUNT（brave.md:5「取其与 20 中较小值」）
//   ENTRY_CODE.*            ↔ test/helpers/contract.js#ENTRY_CODES（fallback.md:34 码表语义）
//   QUOTA_UPSTREAM_CODES    ↔ fallback.md:34 明文 insufficient_quota（+ 第三方文档 QUOTA_LIMITED，待 WP7 实机验证）
// WP5 src/search.js 合入后 classifyUpstreamFailure 以该模块为准；本文件本地镜像成为死代码，
// 去留（删除或保留为离线兜底）交协调方统一裁决（与 WP2/WP9 一致）。
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENTRY_CODES, carriesPassthroughCode, readBoundedText, bodyTooLargeMessage } from "../constants.js";

/** BRV-001 要求1：固定端点（规格原文）。 */
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
/** BRV-001 要求1：Brave 查询上限（字符 600、词 75，边界含）。 */
const BRAVE_MAX_CHARS = 600;
const BRAVE_MAX_WORDS = 75;
/** BRV-001 要求1：count 取宿主结果数与 20 中较小值。 */
const BRAVE_MAX_COUNT = 20;

/** FB-005 条目级失败码：单一权威为 src/constants.js（P1-3；本地别名仅保留引用名，值零变化）。 */
const ENTRY_CODE = ENTRY_CODES;

/**
 * FB-005:34：上游额度 code 字符串集合（429 且 code 命中即归类额度，其余 429 → 限流）。
 * 注：QUOTA_LIMITED 来自第三方文档，Brave 实机样本待 WP7 验证；insufficient_quota 为规格明文。
 */
const QUOTA_UPSTREAM_CODES = Object.freeze(new Set(["insufficient_quota", "QUOTA_LIMITED"]));

/** 条目码 → 中文短语（仅用于脱敏错误文本，不含 key/原始体/请求头名）。 */
const CODE_LABEL = Object.freeze({
  [ENTRY_CODE.CREDENTIALS]: "认证或权限失败",
  [ENTRY_CODE.QUOTA]: "额度用尽",
  [ENTRY_CODE.RATE_LIMITED]: "被限流",
  [ENTRY_CODE.PROXY]: "代理失败",
  [ENTRY_CODE.NETWORK]: "直连网络失败",
  [ENTRY_CODE.CHANNEL_LIMIT]: "通道参数限制",
  [ENTRY_CODE.TIMEOUT]: "条目超时",
  [ENTRY_CODE.BAD_RESPONSE]: "异常响应",
  [ENTRY_CODE.CONTENT_POLICY]: "上游内容策略拒绝",
});

/** 条目码 → 可核查的配置指引（FB-005「错误须指出对应条目和可核查的配置」）。 */
const CODE_CHECK = Object.freeze({
  [ENTRY_CODE.CREDENTIALS]: "请核查该条目的 BRAVE_API_KEY 凭据与权限（CFG-002）",
  [ENTRY_CODE.QUOTA]: "请核查 Brave 账号额度与用量（Brave Search API 套餐）",
  [ENTRY_CODE.RATE_LIMITED]: "请核查 Brave 请求频率限制",
  [ENTRY_CODE.PROXY]: "请核查该条目的代理/PAC 配置（CFG-001/CFG-005）",
  [ENTRY_CODE.NETWORK]: "请核查直连网络与该条目的代理/PAC 配置（CFG-001/CFG-005）",
  [ENTRY_CODE.CHANNEL_LIMIT]: "请核查查询字数/词数是否超出 Brave 通道上限（BRV-001）",
  [ENTRY_CODE.TIMEOUT]: "请核查条目预算与上游延迟（FB-003）",
  [ENTRY_CODE.BAD_RESPONSE]: "请核查上游响应是否为 Brave Web Search API 预期结构",
  [ENTRY_CODE.CONTENT_POLICY]: "该查询被上游内容策略拒绝，请调整查询措辞",
});

/** 固定脱敏文案（CFG-003：不含 key、不回显响应体、不挂原始 cause）。 */
const MESSAGES = Object.freeze({
  keyMissing: (ref) => `Brave 条目「${ref}」缺少 BRAVE_API_KEY 凭据，未发出请求（FB-001/CFG-002）`,
  hostCancelled: "搜索已被宿主取消，Brave 在途请求已中止（FB-001/FB-003）",
  noBudget: (ref) => `Brave 条目「${ref}」没有可用的时间预算，未发出请求（FB-003）`,
  channelLimit: `查询超出 Brave 通道参数上限（最多 ${BRAVE_MAX_CHARS} 字符 / ${BRAVE_MAX_WORDS} 词），未发出请求（BRV-001）`,
  timeoutOutbound: "Brave 请求超过本条目的时间预算，已取消在途请求（FB-003）",
});

// ─── 失败分类（FB-005）────────────────────────────────────────────────────────────────────────────────

/**
 * 本地镜像分类器：与 A4/WP5 src/search.js 的 classifyUpstreamFailure(info) 同契约——
 * info = { status?, upstreamCode?, phase? ("transport"|"response"|"timeout"), error? } → ENTRY_CODE.*。
 * 仅当 ../search.js 缺失（本分支 WP5 未合入）时启用；死代码去留交协调方。
 */
function localClassifyUpstreamFailure(info) {
  const { phase, status, upstreamCode } = info ?? {};
  if (phase === "timeout") return ENTRY_CODE.TIMEOUT;
  if (phase === "transport") return ENTRY_CODE.NETWORK; // TODO-BRV-P5
  if (status === 401 || status === 403) return ENTRY_CODE.CREDENTIALS; // FB-005 凭据或权限
  if (status === 402) return ENTRY_CODE.QUOTA; // FB-005:34 明文
  // P2-4：429 中 code ∈ {insufficient_quota, QUOTA_LIMITED} → 额度；其他 429 → 限流（实机样本待 WP7）。
  if (status === 429) {
    return QUOTA_UPSTREAM_CODES.has(upstreamCode) ? ENTRY_CODE.QUOTA : ENTRY_CODE.RATE_LIMITED;
  }
  if (typeof status === "number" && status >= 500 && status < 600) return ENTRY_CODE.BAD_RESPONSE; // TODO-BRV-P4
  if (typeof status === "number" && status >= 400 && status < 500) return ENTRY_CODE.CHANNEL_LIMIT; // TODO-BRV-4
  return ENTRY_CODE.BAD_RESPONSE; // 其余（含 200 坏 JSON/坏结构）→ 异常响应
}

const SEARCH_MODULE_PATH = fileURLToPath(new URL("../search.js", import.meta.url));
let classifierPromise;

/**
 * 解析通用分类函数（与 WP2/WP9 做法一致，进程内只探测一次）：
 * - ../search.js 不存在（本分支 WP5 未合入）→ 本地镜像兜底；
 * - 文件存在但导入失败或未导出 classifyUpstreamFailure → A4 程序违约，向上抛出（不带 ENTRY 码）。
 */
function loadClassifier() {
  if (!classifierPromise) {
    const pending = existsSync(SEARCH_MODULE_PATH)
      ? import("../search.js").then((mod) => {
          if (typeof mod?.classifyUpstreamFailure !== "function") {
            throw new Error("search-chain: src/search.js 未导出 classifyUpstreamFailure（A4 违约）");
          }
          return mod.classifyUpstreamFailure;
        })
      : Promise.resolve(localClassifyUpstreamFailure);
    classifierPromise = pending;
    // #12-25：加载失败（rejected）不得永久缓存；失败即重置，下一次调用重新探测。
    pending.catch(() => {
      if (classifierPromise === pending) classifierPromise = undefined;
    });
  }
  return classifierPromise;
}

async function classify(info) {
  const classifyUpstreamFailure = await loadClassifier();
  const code = classifyUpstreamFailure(info);
  if (!Object.values(ENTRY_CODE).includes(code)) {
    // FB-005：分类器只产出条目码；未知码属内部程序违约，向调用方暴露。
    throw new Error(`search-chain: classifyUpstreamFailure 返回了未知分类码（A4 违约）：${String(code)}`);
  }
  return code;
}

// ─── 错误构造（CFG-003 脱敏：不附 cause/headers/init/原始响应体）──────────────────────────────────────

/** 条目级失败：携带 .code，面向链（WP5）按 FB-004/FB-005 聚合。 */
function entryFailure(code, message) {
  const err = new Error(message);
  err.code = code;
  // CFG-003：不得把上游原始响应体、请求头（含 x-subscription-token 值）、fetch init 或原异常
  // 附到错误上，故此处不设置 cause 等附加字段。
  return err;
}

/** 宿主取消（预取消与在途取消同形状）：不带 ENTRY_* 码，链据此终止而非降级（P7）。 */
function hostCancelled() {
  const err = new Error(MESSAGES.hostCancelled);
  err.name = "AbortError";
  return err;
}

/** 内部程序违约：无 code，向调用方暴露（FB-005「内部程序违约向调用方暴露」）。 */
function programError(message) {
  return new Error(message);
}

// ─── 校验与映射（BRV-001 要求1/2）────────────────────────────────────────────────────────────────────

/** TODO-BRV-3 / P2-3：page_age 须为 ISO 8601 日期或日期时间（可选时区）且可被 Date 解析，否则丢弃。 */
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
function isoDateString(value) {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (!ISO_8601_PATTERN.test(s) || Number.isNaN(Date.parse(s))) return undefined;
  return s;
}

/** FB-002/A1：可解析的绝对 HTTP(S) URL。 */
function isAbsoluteHttpUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * BRV-001 要求2：按 web.results 顺序映射 url/title/description；无效项（缺失/非对象/
 * url 缺失或非绝对 HTTP(S)）丢弃、有效项保序（P2：缺 title 仍保留）。
 * 返回 { sources, dropped }。
 */
function mapBraveResults(results) {
  const sources = [];
  let dropped = 0;
  for (const item of results) {
    const url = item !== null && typeof item === "object" ? item.url : undefined;
    if (!isAbsoluteHttpUrl(url)) {
      dropped += 1;
      continue;
    }
    const source = { url };
    const title = nonEmptyString(item.title);
    if (title !== undefined) source.title = title;
    const description = nonEmptyString(item.description);
    if (description !== undefined) source.snippet = description; // TODO-BRV-P1：description → snippet
    const publishedAt = isoDateString(item.page_age);
    if (publishedAt !== undefined) source.publishedAt = publishedAt; // TODO-BRV-3：page_age（ISO），不用 age
    sources.push(source);
  }
  return { sources, dropped };
}

/**
 * BRV-001 要求1：Brave 查询上限（P9 口径：字符数=UTF-16 码元，词数=空白拆分非空段；边界含）。
 * 超过 600 字符或 75 词 → 须报告通道参数限制（零出站，不得出站后截断）。
 */
function queryExceedsLimit(query) {
  const charCount = query.length;
  const wordCount = query.split(/\s+/).filter((w) => w !== "").length;
  return charCount > BRAVE_MAX_CHARS || wordCount > BRAVE_MAX_WORDS;
}

/**
 * BRV-001 要求1：构造唯一出站 URL。固定参数 result_filter=web、text_decorations=false；
 * 宿主提供结果数时 count = min(maxResults, 20)，未提供则省略（未指定参数省略而非 null）；
 * 不发送 freshness（brave.md 未定义，TODO-BRV-2）。
 */
function buildRequestUrl(query, maxResults) {
  const u = new URL(BRAVE_ENDPOINT);
  u.searchParams.set("q", query);
  u.searchParams.set("result_filter", "web");
  u.searchParams.set("text_decorations", "false");
  if (Number.isInteger(maxResults) && maxResults >= 1) {
    u.searchParams.set("count", String(Math.min(maxResults, BRAVE_MAX_COUNT)));
  }
  return u.href;
}

/** 解析 JSON；失败返回 undefined（JSON 不可能解析为 undefined，故可区分「解析失败」与「顶层 null」）。 */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** TODO-BRV-5：上游 code 取 body.error.code（字符串）优先，其次 body.error.type（字符串）。 */
function upstreamCodeOf(parsed) {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const errorObj = parsed.error;
  if (errorObj === null || typeof errorObj !== "object") return undefined;
  if (typeof errorObj.code === "string") return errorObj.code;
  if (typeof errorObj.type === "string") return errorObj.type;
  return undefined;
}

// ─── 出站（FB-001 单次请求 / FB-003 预算与取消）────────────────────────────────────────────────────────

/**
 * 唯一一次 GET（FB-001：不重试）。ctx.signal 与预算定时器合并为同一出站 signal；到期/取消都中止在途请求，
 * 并按原因区分结果（FB-003）。响应读取也在预算之内（FB-003「涵盖…请求和解析」）。
 *
 * P1-1 竞速：fetch(headers) 与 res.text() 均与内部 abort promise 竞速，故即使上游/宿主 fetch 忽略 signal，
 * 预算到期或宿主取消也立即结束等待；cleanup（清定时器、摘宿主监听）后置于 finally。
 * P1-1 clock：定时器取 ctx.clock ?? globalThis，clock 缺省时不得静默跳过预算。
 *
 * 返回值：
 *   { status, ok, text }          拿到响应且读体成功；
 *   { failed: code }              未拿到 HTTP 响应（网络层，分类为条目码）；
 *   { status, ok, bodyFailed:true } 已拿到状态码但读体失败（P5-6：归 ENTRY_BAD_RESPONSE）。
 * 中止以 throw 表达：宿主取消 → 无码 AbortError；预算到期 → ENTRY_TIMEOUT（两者严格区分）。
 * 只返回上列字段；原始异常不外泄（CFG-003）。
 */
async function roundTrip(ctx, url, key) {
  const { fetch, budgetMs, signal } = ctx;
  const clock = ctx.clock ?? globalThis;
  const ac = new AbortController();
  let cause = null; // "host" | "budget"
  const abortError = () =>
    cause === "host" ? hostCancelled() : entryFailure(ENTRY_CODE.TIMEOUT, MESSAGES.timeoutOutbound);
  // 竞速源：ac 中止（先置 cause 再 abort）即以对应原因拒绝；未参与竞速的拒绝不得成为未处理拒绝。
  const aborted = new Promise((_, reject) => {
    ac.signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
  aborted.catch(() => {});
  const onHostAbort = () => {
    if (cause === null) cause = "host";
    ac.abort(signal?.reason);
  };
  const onBudget = () => {
    if (cause === null) cause = "budget";
    ac.abort(new Error("条目预算到期"));
  };
  let timer = null;
  try {
    signal?.addEventListener?.("abort", onHostAbort, { once: true });
    timer = clock.setTimeout(onBudget, budgetMs);

    let res;
    try {
      res = await Promise.race([
        fetch(url, {
          method: "GET",
          // BRV-001 要求1：X-Subscription-Token 鉴权（key 只出现在此头，CFG-003）；不用 Authorization。
          headers: { "x-subscription-token": key },
          signal: ac.signal,
        }),
        aborted,
      ]);
    } catch (err) {
      if (cause !== null) throw abortError();
      // P1-1：已带码的错误原样上抛（ENTRY_PROXY/CONFIG 码/TRANSPORT_RELEASED），不压成 ENTRY_NETWORK。
      if (carriesPassthroughCode(err)) throw err;
      // 网络层故障：不复述 err.message（可能携带 URL/key），只输出分类后的脱敏错误。
      return { failed: await classify({ phase: "transport", error: err }) };
    }

    // 字节上限（MAX_RESPONSE_BYTES）：流式早停，超限 tooLarge（2xx 在 search 归 BAD_RESPONSE；非 2xx 仍按状态分类）。
    let body;
    try {
      body = await Promise.race([readBoundedText(res), aborted]);
    } catch {
      if (cause !== null) throw abortError();
      // P5-6：已拿到状态码，仅读体失败 → 调用方归 ENTRY_BAD_RESPONSE（不得记为未返回响应）。
      return { status: res.status, ok: res.ok, bodyFailed: true };
    }
    return { status: res.status, ok: res.ok, text: body.text, tooLarge: body.tooLarge, limit: body.limit };
  } finally {
    if (timer != null) clock.clearTimeout?.(timer);
    signal?.removeEventListener?.("abort", onHostAbort);
  }
}

// ─── 适配器主体（A5 seam）────────────────────────────────────────────────────────────────────────────

/**
 * Brave 单次尝试（FB-001：最多一次出站；FB-003：预算/取消约束；BRV-001：请求与来源）。
 * @param {{ entry?: object, query?: unknown, maxResults?: unknown, key?: unknown,
 *           fetch?: unknown, budgetMs?: unknown, signal?: AbortSignal|null,
 *           clock?: object|null, log?: Function|null }} ctx
 */
async function search(ctx) {
  const entry = ctx?.entry ?? {};
  const entryRef = entry.name ?? entry.id ?? "未知条目";
  const log = typeof ctx?.log === "function"
    ? (level, message, fields) => ctx.log(level, message, fields)
    : () => {};

  // FB-005「内部程序违约向调用方暴露」：fetch/query 不可用不包装为 ENTRY 码。
  if (typeof ctx?.fetch !== "function") {
    throw programError(`search-chain: Brave 条目「${entryRef}」上下文缺少可用 fetch（内部程序违约）`);
  }
  if (typeof ctx?.query !== "string") {
    throw programError(`search-chain: Brave 条目「${entryRef}」上下文缺少查询（内部程序违约）`);
  }

  // CFG-002/FB-001：key 只来自 ctx.key（解析已在 A4 完成），纯空白视缺失；零出站。
  // 纵深防御：链对缺 key 条目在适配器之前跳过（FB-001），此处兜底。
  const key = typeof ctx.key === "string" ? ctx.key.trim() : "";
  if (key === "") {
    log("warn", "brave entry skipped before outbound", { entryId: entry.id, reason: "missing-key" });
    throw entryFailure(ENTRY_CODE.CREDENTIALS, MESSAGES.keyMissing(entryRef));
  }

  // FB-003/FB-001：宿主预取消时不得发出请求（零出站；P7：不带 ENTRY_* 码）。
  const signal = ctx.signal;
  if (signal?.aborted) {
    log("warn", "brave entry pre-cancelled", { entryId: entry.id });
    throw hostCancelled();
  }

  // FB-003：无可用时间时不得发出请求（零出站；P6：归 ENTRY_TIMEOUT）。
  const budgetMs = typeof ctx.budgetMs === "number" ? ctx.budgetMs : Number.NaN;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    log("warn", "brave entry has no budget", { entryId: entry.id });
    throw entryFailure(ENTRY_CODE.TIMEOUT, MESSAGES.noBudget(entryRef));
  }

  // BRV-001 要求1：超过 600 字符 / 75 词 → 报告该条目的参数限制，零出站（后继条目收到完整查询）。
  if (queryExceedsLimit(ctx.query)) {
    log("warn", "brave entry query exceeds channel limit", {
      entryId: entry.id,
      chars: ctx.query.length,
      words: ctx.query.split(/\s+/).filter((w) => w !== "").length,
    });
    throw entryFailure(ENTRY_CODE.CHANNEL_LIMIT, MESSAGES.channelLimit);
  }

  const url = buildRequestUrl(ctx.query, ctx.maxResults);
  const outcome = await roundTrip(ctx, url, key);

  // 网络层失败（roundTrip 以 { failed: code } 归一）：脱敏错误，单次请求不重试。
  if (outcome.failed) {
    log("warn", "brave entry request failed without response", { entryId: entry.id, code: outcome.failed });
    throw entryFailure(
      outcome.failed,
      `Brave 条目「${entryRef}」${CODE_LABEL[outcome.failed] ?? "请求失败"}：上游未返回 HTTP 响应。${CODE_CHECK[outcome.failed] ?? "请核查该条目配置"}`,
    );
  }
  // P5-6：拿到状态码后读体失败 → ENTRY_BAD_RESPONSE（phase=response）；未拿到响应才是 ENTRY_NETWORK（上文）。
  if (outcome.bodyFailed) {
    log("warn", "brave upstream body read failed", { entryId: entry.id, status: outcome.status, phase: "response" });
    throw entryFailure(
      ENTRY_CODE.BAD_RESPONSE,
      `Brave 条目「${entryRef}」上游响应体读取失败（HTTP ${outcome.status}），归类为${CODE_LABEL[ENTRY_CODE.BAD_RESPONSE]}。${CODE_CHECK[ENTRY_CODE.BAD_RESPONSE]}`,
    );
  }
  const { status, ok, text } = outcome;

  // 2xx 正文超上限 → ENTRY_BAD_RESPONSE，诊断含尺寸线索（非 2xx 超限仍按状态码分类，见下）。
  if (outcome.tooLarge && ok) {
    log("warn", "brave upstream body too large", { entryId: entry.id, status, limit: outcome.limit });
    throw entryFailure(
      ENTRY_CODE.BAD_RESPONSE,
      `Brave 条目「${entryRef}」${bodyTooLargeMessage(outcome.limit)}。${CODE_CHECK[ENTRY_CODE.BAD_RESPONSE]}`,
    );
  }

  // CFG-003：原始响应体只参与解析与分类，任何原文不得进入错误文本或日志。
  if (!ok) {
    const upstreamCode = upstreamCodeOf(parseJson(text));
    const code = await classify({ phase: "response", status, upstreamCode });
    log("warn", "brave upstream error status", { entryId: entry.id, status, code });
    throw entryFailure(
      code,
      `Brave 条目「${entryRef}」上游返回 HTTP ${status}，归类为${CODE_LABEL[code] ?? "失败"}。${CODE_CHECK[code] ?? "请核查该条目配置"}`,
    );
  }

  const data = parseJson(text);
  if (data === undefined) {
    // 200 非 JSON（含空体）→ 异常响应（BRV-001 要求2）。
    const code = await classify({ phase: "response", status });
    log("warn", "brave upstream body is not valid JSON", { entryId: entry.id, status, code });
    throw entryFailure(
      code,
      `Brave 条目「${entryRef}」上游返回 HTTP ${status} 且响应体不是合法 JSON（异常响应）。${CODE_CHECK[code] ?? "请核查该条目配置"}`,
    );
  }

  // BRV-001 要求2 结构检查：顶层 null、缺 web 字段（P3）、web.results 缺失或非数组均为无效结构。
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    data.web === null ||
    typeof data.web !== "object" ||
    Array.isArray(data.web) ||
    !Array.isArray(data.web.results)
  ) {
    log("warn", "brave upstream response structure invalid", { entryId: entry.id });
    throw entryFailure(
      ENTRY_CODE.BAD_RESPONSE,
      `Brave 条目「${entryRef}」响应结构不合法：web.results 缺失或不是数组（BRV-001）。${CODE_CHECK[ENTRY_CODE.BAD_RESPONSE]}`,
    );
  }

  // BRV-001 要求2：web.results=[] 为可识别的空网页结果（明确无结果 FB-004）；
  // 「有 results 但全部无效」才是畸形数据（BAD_RESPONSE）。
  const { sources } = mapBraveResults(data.web.results);
  if (data.web.results.length > 0 && sources.length === 0) {
    log("warn", "brave upstream sources all invalid", { entryId: entry.id, total: data.web.results.length });
    throw entryFailure(
      ENTRY_CODE.BAD_RESPONSE,
      `Brave 条目「${entryRef}」返回的全部 ${data.web.results.length} 个来源均无效（url 缺失或非绝对 HTTP(S)）（BRV-001）。${CODE_CHECK[ENTRY_CODE.BAD_RESPONSE]}`,
    );
  }

  // TODO-BRV-P8（已裁决）：截断归链——适配器返回全量来源，truncated:false；
  // maxResults 截断与 truncated 置位由链 WP5 buildSuccessResult 实现（FB-002 插件边界，适配器不截断为全后端契约）。
  log("info", "brave upstream ok", { entryId: entry.id, status, sources: sources.length });

  // FB-002：Brave 为纯来源适配器，供应商正文（faq 等）不得作为通用 content。
  return { sources, truncated: false };
}

/** A5 后端形状（TODO-BRV-1：命名导出 braveBackend）。 */
export const braveBackend = Object.freeze({
  type: "brave",
  contentMode: "sources-only",
  search,
});
