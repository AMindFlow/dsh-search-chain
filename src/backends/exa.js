// WP9 Exa Search API 适配器（Issue #8「WP9 Exa 适配」）。
// 规格来源：
//   docs/specs/draft/exa.md            EXA-001 请求与来源（主规格）
//   docs/specs/draft/fallback.md       FB-001（缺 key 零出站/一次尝试）、FB-002（来源顺序/纯来源）、
//                                     FB-003（预算与取消）、FB-005（失败分类与排查提示）
//   docs/specs/draft/config-network.md CFG-002（key 来源优先级）、CFG-003（凭据隔离与脱敏）
//   docs/specs/draft/providers.md      CAT-001（Exa 类型，凭据 EXA_API_KEY）
// 契约：test/helpers/contract.js A5 —— Backend = { type, search(ctx) }，
//   ctx = { entry, query, maxResults?, key, fetch, budgetMs, signal, clock, log }；
//   成功 resolve { sources, truncated, content? }（空数组=明确无结果，FB-004；截断与 truncated 归链层
//   FB-002，适配器返回全部来源、truncated 恒为 false——见 TODO-EXA-6）；
//   失败 throw 携带 .code ∈ ENTRY_CODES 的错误；内部程序违约 throw 不带 code 的错误（FB-005）。
// 运行时零 import test/：下方常量为 test helpers 的本地镜像（见同步义务）。
//
// ─── TODO-EXA-1..13 裁决记录（规格行号指 docs/specs/draft/exa.md，oracle 头注指 test/helpers/exa-oracle.js）──
// TODO-EXA-1  导出形态：取 oracle 容忍顺序的第一形态——命名导出 exaBackend = { type: "exa", search(ctx) }。
// TODO-EXA-2  highlights 请求体形状：发 contents.highlights = true（exa.md:5 只写「采用 highlights」；
//             oracle 头注 7-8 行断言真值，true 或对象均可）。不请求 contents.text（FB-002 纯来源）。
// TODO-EXA-3  高亮文本落点：全部放入 snippet（按上游顺序换行拼接）；不写 summary；不用正文 text 代替。
// TODO-EXA-4  publishedDate 映射：规格沉默，测试不断言。按 A1 宿主 WebSearchSource 形状，
//             非空白字符串时映射为 publishedAt（已接受假设，若 WP0 主线定名再对齐）。
// TODO-EXA-5  numResults：宿主提供（ctx.maxResults 为 ≥1 整数）时原值透传；适配层不做钳制
//             （exa.md:5「在该类型支持范围内」的上限语义归链/宿主，测试只覆盖 1..10 透传）。
// TODO-EXA-6  maxResults 截断责任（协调裁决，横向契约）：截断与 truncated 归链层（FB-002）。
//             适配器返回全部映射来源，不本地切片；truncated 恒为 false 仅满足 A5 形状。
//             oracle/contract 断言口径待 oracle 轮同步（见 WP9 报告）。
// TODO-EXA-7  5xx 条目码：归类 ENTRY_BAD_RESPONSE（可降级，且非 CREDENTIALS/QUOTA/RATE_LIMITED；
//             FB-005 未列 5xx，oracle 头注 14-15 行只断言可降级）。
// TODO-EXA-8  缺 key 适配器级行为：零出站 + 抛 ENTRY_CREDENTIALS（FB-001 链级跳过发生在适配器之前，
//             此处为纵深防御；oracle 头注 15-17 行只断言零出站+抛错）。
// TODO-EXA-9  中止错误形状（修订，WP9 裁决）：宿主取消 → 无码 AbortError（name=AbortError，无 code）；
//             预算到期 → ENTRY_TIMEOUT（带码）。二者可区分，链以 name+无码识别取消。原记录：
//             同时满足 oracle 头注 17-18 行「二者之一」断言的两个分支。
// TODO-EXA-10 费用说明文案属设置面板（settings-ui.md），不在适配器内，本 WP 不实现。
// TODO-EXA-11 请求体逐字段只允许 query / type / numResults / contents 四键（exa.md:5 逐字段口径；
//             oracle 头注 20-21 行：category 等规格未要求，不得发送；需要时先回写规格）。
// TODO-EXA-12 上游 code 提取形状：body.error.code（字符串）；insufficient_quota 判定按 FB-005 明文
//             （fallback.md:34「HTTP 402 或 insufficient_quota 属额度问题」）。
// TODO-EXA-13 本 WP 不新增 fixtures：Exa 合成样本内联于 test/helpers/exa-oracle.js，本文件不读 fixtures。
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// ─── 常量本地镜像（运行时零 import test/；同步义务）─────────────────────────────────────────────────────
// 同步义务：本分支尚无共享常量模块（src/constants.js 待 WP0 主线提供）。上述字符串若任一侧改动，
// 必须同步另一侧并说明理由：
//   EXA_ENDPOINT          ↔ test/helpers/exa-oracle.js#EXA_ENDPOINT（exa.md:5）
//   ENTRY_CODE.*          ↔ test/helpers/contract.js#ENTRY_CODES（fallback.md:32-34 码表语义）
//   INSUFFICIENT_QUOTA    ↔ fallback.md:34 明文上游 code 字符串
// WP5 src/search.js 合入后 classifyUpstreamFailure 以该模块为准；本文件本地镜像成为死代码，
// 去留（删除或保留为离线兜底）交协调方统一裁决。
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENTRY_CODES, carriesPassthroughCode, readBoundedText, bodyTooLargeMessage } from "../constants.js";

/** Exa Search API 端点（exa.md:5）。 */
const EXA_ENDPOINT = "https://api.exa.ai/search";

/** FB-005 条目级失败码：单一权威为 src/constants.js（P1-3；本地别名仅保留引用名，值零变化）。 */
const ENTRY_CODE = ENTRY_CODES;

/** FB-005：上游额度 code 字符串（非 402 状态命中该 code 时归类额度）。 */
const INSUFFICIENT_QUOTA = "insufficient_quota";

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
  [ENTRY_CODE.CREDENTIALS]: "请核查该条目的 EXA_API_KEY 凭据与权限（CFG-002）",
  [ENTRY_CODE.QUOTA]: "请核查 Exa 账号额度与用量",
  [ENTRY_CODE.RATE_LIMITED]: "请核查 Exa 请求频率限制",
  [ENTRY_CODE.PROXY]: "请核查该条目的代理/PAC 配置（CFG-001/CFG-005）",
  [ENTRY_CODE.NETWORK]: "请核查直连网络与该条目的代理/PAC 配置（CFG-001/CFG-005）",
  [ENTRY_CODE.CHANNEL_LIMIT]: "请核查该条目的通道参数（请求上限等）",
  [ENTRY_CODE.TIMEOUT]: "请核查条目预算与上游延迟（FB-003）",
  [ENTRY_CODE.BAD_RESPONSE]: "请核查上游响应是否为 Exa Search API 预期结构",
  [ENTRY_CODE.CONTENT_POLICY]: "该查询被上游内容策略拒绝，请调整查询措辞",
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
  if (phase === "transport") return ENTRY_CODE.NETWORK;
  if (status === 401 || status === 403) return ENTRY_CODE.CREDENTIALS;
  if (status === 402) return ENTRY_CODE.QUOTA;
  if (status === 429) return upstreamCode === INSUFFICIENT_QUOTA ? ENTRY_CODE.QUOTA : ENTRY_CODE.RATE_LIMITED;
  if (typeof status === "number" && status >= 500 && status < 600) return ENTRY_CODE.BAD_RESPONSE; // TODO-EXA-7
  // FB-005 统一规则：其余 4xx（400/404/422 等）归通道参数限制。
  if (typeof status === "number" && status >= 400 && status < 500) return ENTRY_CODE.CHANNEL_LIMIT;
  return ENTRY_CODE.BAD_RESPONSE; // response 阶段其余状态（含 200 坏 JSON/坏结构）→ 异常响应
}

const SEARCH_MODULE_PATH = fileURLToPath(new URL("../search.js", import.meta.url));
let classifierPromise;

/**
 * 解析通用分类函数（与 WP2/WP3 做法一致，进程内只探测一次）：
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
  // CFG-003：不得把上游原始响应体、请求头（含 x-api-key 值）、fetch init 或原异常附到错误上，
  // 故此处不设置 cause 等附加字段。
  return err;
}

/**
 * 宿主取消（ctx.signal 中止）：无码 AbortError（name=AbortError，无 .code）。
 * 跨后端契约形状（WP1/WP3/WP4/WP11 同口径）：链/装配以 name=AbortError 且无码识别「取消」，
 * 不得打 ENTRY_TIMEOUT 码（否则被当作终态条目超时而非取消）。
 */
function hostAbortFailure(reason) {
  const message = reason && typeof reason.message === "string" && reason.message !== ""
    ? reason.message
    : "This operation was aborted";
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

/** 预算到期（FB-003）：ENTRY_TIMEOUT（带码；name=AbortError 亦满足 TODO-EXA-9 的 oracle 分支）。 */
function budgetFailure() {
  const err = new Error("条目预算到期");
  err.name = "AbortError";
  err.code = ENTRY_CODE.TIMEOUT;
  return err;
}

// ─── 校验与映射（EXA-001）────────────────────────────────────────────────────────────────────────────

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

/**
 * 按 results 顺序映射来源：无效项（缺失/非对象/ url 非法）丢弃、有效项保序。
 * 返回 { sources, dropped }。
 */
function mapExaResults(results) {
  const sources = [];
  let dropped = 0;
  for (const item of results) {
    const url = item !== null && typeof item === "object" ? item.url : undefined;
    if (!isAbsoluteHttpUrl(url)) {
      dropped += 1;
      continue;
    }
    const source = { url };
    if (typeof item.title === "string" && item.title.trim() !== "") source.title = item.title; // A1：title 可选，不编造
    const highlights = Array.isArray(item.highlights)
      ? item.highlights.filter((h) => typeof h === "string" && h.trim() !== "")
      : [];
    if (highlights.length > 0) source.snippet = highlights.join("\n"); // TODO-EXA-3：高亮进 snippet，不用正文 text
    if (typeof item.publishedDate === "string" && item.publishedDate.trim() !== "") {
      source.publishedAt = item.publishedDate; // TODO-EXA-4：规格沉默，按 A1 形状映射
    }
    sources.push(source);
  }
  return { sources, dropped };
}

// ─── 适配器主体（A5 seam）────────────────────────────────────────────────────────────────────────────

/** 真实时钟：无注入 clock 时的缺省（对齐 deepseek.js realClock），保证预算无条件生效。 */
const realClock = Object.freeze({
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
});

/**
 * Exa 单次尝试（FB-001：最多一次出站；FB-003：预算/取消约束；EXA-001：请求与来源）。
 * @param {{ entry?: object, query?: unknown, maxResults?: unknown, key?: unknown,
 *           fetch?: unknown, budgetMs?: unknown, signal?: AbortSignal|null,
 *           clock?: object|null, log?: Function|null }} ctx
 */
async function search(ctx) {
  const entry = ctx?.entry ?? {};
  const log = typeof ctx?.log === "function"
    ? (level, message, fields) => ctx.log(level, message, fields)
    : () => {};
  const entryRef = entry.name ?? entry.id ?? "未知条目";

  // FB-005「内部程序违约向调用方暴露」：fetch 不可用不包装为 ENTRY 码。
  if (typeof ctx?.fetch !== "function") {
    throw new Error(`search-chain: Exa 条目「${entryRef}」上下文缺少可用 fetch（内部程序违约）`);
  }

  // CFG-002/FB-001：key 只来自 ctx.key（解析已在 A4 完成），纯空白视缺失；零出站。
  const key = typeof ctx.key === "string" ? ctx.key.trim() : "";
  if (key === "") {
    log("warn", "exa entry skipped before outbound", { entryId: entry.id, reason: "missing-key" });
    throw entryFailure(
      ENTRY_CODE.CREDENTIALS,
      `Exa 条目「${entryRef}」缺少 EXA_API_KEY 凭据，未发出请求（FB-001/CFG-002）`,
    );
  }

  // FB-003：宿主预取消或无可用时间时不得发出请求（零出站）。
  const signal = ctx.signal;
  if (signal?.aborted) throw hostAbortFailure(signal.reason);
  const budgetMs = typeof ctx.budgetMs === "number" ? ctx.budgetMs : Number.NaN;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw budgetFailure();
  }

  // EXA-001 逐字段：query / type:"auto" / numResults（仅宿主提供上限时）/ contents.highlights；
  // 无 category 等其他键（TODO-EXA-11）。
  const payload = { query: ctx.query, type: "auto" };
  if (Number.isInteger(ctx.maxResults) && ctx.maxResults >= 1) payload.numResults = ctx.maxResults; // TODO-EXA-5
  payload.contents = { highlights: true }; // TODO-EXA-2；不请求 contents.text（FB-002 纯来源）

  // FB-003：ctx.signal 与 ctx.clock 预算定时器合并为单一出站 signal；到期取消在途操作。
  const internal = new AbortController();
  let timedOut = false;
  const onHostAbort = () => {
    if (!internal.signal.aborted) internal.abort(signal.reason);
  };
  signal?.addEventListener?.("abort", onHostAbort, { once: true });
  const clock = ctx.clock ?? realClock; // P1：无 clock 时用真实时钟，预算照常生效
  const budgetTimer = typeof clock?.setTimeout === "function"
    ? clock.setTimeout(() => {
        timedOut = true;
        internal.abort(new Error("条目预算到期"));
      }, budgetMs)
    : null;

  // 中止来源必须可区分：预算定时器到期（timedOut）→ ENTRY_TIMEOUT；否则为宿主取消 → 无码 AbortError。
  const abortedError = (cause) =>
    timedOut ? budgetFailure() : hostAbortFailure(signal?.reason ?? cause);
  const isAbortLike = (err) => timedOut || signal?.aborted === true || err?.name === "AbortError";

  let response;
  let text = "";
  let bodyTooLargeLimit = null;
  try {
    try {
      response = await ctx.fetch(EXA_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key }, // EXA-001 鉴权头
        body: JSON.stringify(payload),
        signal: internal.signal,
      });
    } catch (err) {
      // 取消/预算中止：不重试（FB-003）。
      if (isAbortLike(err)) throw abortedError(err);
      // P1-1：已带码的错误原样上抛（ENTRY_PROXY/CONFIG 码/TRANSPORT_RELEASED），不压成 ENTRY_NETWORK。
      if (carriesPassthroughCode(err)) throw err;
      const code = await classify({ phase: "transport", error: err });
      log("warn", "exa entry request failed without response", { entryId: entry.id, code });
      // CFG-003：不复述 err.message（上游/网络异常可能携带 key 或请求头）。
      throw entryFailure(
        code,
        `Exa 条目「${entryRef}」${CODE_LABEL[code] ?? "请求失败"}：上游未返回 HTTP 响应。${CODE_CHECK[code] ?? "请核查该条目配置"}`,
      );
    }
    // 中止后才解析出的迟到响应不得被采纳（FB-003）。
    if (isAbortLike()) throw abortedError(undefined);

    // P0：响应体读取同样受预算/取消约束，cleanup 延后到 text() 完成或失败之后。
    // CFG-003：原始响应体只参与解析与分类，任何原文不得进入错误文本或日志。
    try {
      // 字节上限（MAX_RESPONSE_BYTES，流式早停）：超限时 text 为空，见下方 2xx 判定。
      const body = await readBoundedText(response);
      text = body.text;
      if (body.tooLarge) bodyTooLargeLimit = body.limit;
    } catch (err) {
      if (isAbortLike(err)) throw abortedError(err);
      if (response.ok) {
        log("warn", "exa upstream body read failed", { entryId: entry.id, status: response.status });
        throw entryFailure(
          ENTRY_CODE.NETWORK,
          `Exa 条目「${entryRef}」响应体读取失败（直连网络）。${CODE_CHECK[ENTRY_CODE.NETWORK]}`,
        );
      }
      // 非 2xx 且读体失败：上游 body code 不可知，仅按状态码归类。
      // 429 此时 quota 不可知（可能是 insufficient_quota），按限流归类（RATE_LIMITED）。
      const code = await classify({ phase: "response", status: response.status });
      log("warn", "exa upstream error body read failed", { entryId: entry.id, status: response.status, code });
      throw entryFailure(
        code,
        `Exa 条目「${entryRef}」上游返回 HTTP ${response.status}，响应体读取失败，归类为${CODE_LABEL[code] ?? "失败"}（响应体不可读，额度与限流无法区分）。${CODE_CHECK[code] ?? "请核查该条目配置"}`,
      );
    }
  } finally {
    if (budgetTimer != null && typeof clock?.clearTimeout === "function") clock.clearTimeout(budgetTimer);
    signal?.removeEventListener?.("abort", onHostAbort);
  }
  // 2xx 正文超上限 → ENTRY_BAD_RESPONSE，诊断含尺寸线索（非 2xx 超限仍按状态码分类，见下）。
  if (bodyTooLargeLimit !== null && response.ok) {
    log("warn", "exa upstream body too large", { entryId: entry.id, status: response.status, limit: bodyTooLargeLimit });
    throw entryFailure(
      ENTRY_CODE.BAD_RESPONSE,
      `Exa 条目「${entryRef}」${bodyTooLargeMessage(bodyTooLargeLimit)}。${CODE_CHECK[ENTRY_CODE.BAD_RESPONSE]}`,
    );
  }

  let data;
  try {
    data = text === "" ? undefined : JSON.parse(text);
  } catch {
    const code = await classify({ phase: "response", status: response.status });
    log("warn", "exa upstream body is not valid JSON", { entryId: entry.id, status: response.status, code });
    throw entryFailure(
      code,
      `Exa 条目「${entryRef}」上游返回 HTTP ${response.status} 且响应体不是合法 JSON（异常响应）。${CODE_CHECK[code] ?? "请核查该条目配置"}`,
    );
  }

  if (!response.ok) {
    // TODO-EXA-12：上游 code 取 body.error.code（字符串），用于 429 的额度/限流分界。
    const upstreamCode =
      data !== null && typeof data === "object" &&
      data.error !== null && typeof data.error === "object" &&
      typeof data.error.code === "string"
        ? data.error.code
        : undefined;
    const code = await classify({ phase: "response", status: response.status, upstreamCode });
    log("warn", "exa upstream error status", { entryId: entry.id, status: response.status, code });
    throw entryFailure(
      code,
      `Exa 条目「${entryRef}」上游返回 HTTP ${response.status}，归类为${CODE_LABEL[code] ?? "失败"}。${CODE_CHECK[code] ?? "请核查该条目配置"}`,
    );
  }

  // EXA-001：results 缺失、null 或非数组 → 响应失败（与有效空数组严格区分）。
  if (data === null || typeof data !== "object" || !Array.isArray(data.results)) {
    log("warn", "exa upstream response structure invalid", { entryId: entry.id });
    throw entryFailure(
      ENTRY_CODE.BAD_RESPONSE,
      `Exa 条目「${entryRef}」响应结构不合法：results 缺失或不是数组（EXA-001）。${CODE_CHECK[ENTRY_CODE.BAD_RESPONSE]}`,
    );
  }

  // EXA-001：按 results 顺序映射 url/title/可用高亮；无效项丢弃、有效项保序。
  // 有效 results: [] → 明确无结果（FB-004 空语义）；「有来源但全部无效」才是响应失败。
  const { sources, dropped } = mapExaResults(data.results);
  if (data.results.length > 0 && sources.length === 0) {
    log("warn", "exa upstream sources all invalid", { entryId: entry.id, total: data.results.length, dropped });
    throw entryFailure(
      ENTRY_CODE.BAD_RESPONSE,
      `Exa 条目「${entryRef}」返回的全部 ${data.results.length} 个来源均无效（url 缺失或非绝对 HTTP(S)）（EXA-001）。${CODE_CHECK[ENTRY_CODE.BAD_RESPONSE]}`,
    );
  }

  // FB-002 截断与 truncated 归链层（协调裁决，横向契约）：本适配器返回全部映射来源，不做本地切片。
  // truncated 恒为 false 仅为满足 A5 形状，由链层按 maxResults 重算。纯来源，不携带 content（FB-002）。
  return { sources, truncated: false };
}

/** A5 后端形状（TODO-EXA-1：命名导出 exaBackend）。 */
export const exaBackend = Object.freeze({
  type: "exa",
  search,
});
