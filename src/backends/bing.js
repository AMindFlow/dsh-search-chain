// Bing RSS 适配器（WP4，src/backends/bing.js）。
//
// 规格来源：
//   docs/specs/draft/bing.md          BING-001 请求与来源 / BING-002 空 Feed 与失败
//   docs/specs/draft/fallback.md      FB-003 预算与取消 / FB-005 失败分类
//   docs/specs/draft/config-network.md CFG-003 脱敏（落地断言在 test/helpers/redact.js；
//   本文件保证错误文本、cause 与日志均不含响应体原文、用户查询与 key）
// 契约：test/helpers/contract.js A5 适配器 seam、A6 出站经 ctx.fetch（A8 预算走 ctx.clock）。
// 常量来自 ../constants.js 的本地镜像；运行时绝不 import test/ 下任何文件。
//
// ─── AMB / TODO 裁决（oracle 文件头同义条目，逐条过；依据与规格行号见 WP4 交付报告）──────────────
// AMB-1 3xx：规格未规定。真实 fetch 已自动跟随重定向，3xx 仍作为最终状态说明重定向未完成，
//   归异常响应 ENTRY_BAD_RESPONSE（可降级）。
// AMB-2 参数集：只提交 q（原查询）与 format=rss；未指定参数整体省略，不出现空值 / null / undefined 字面量。
// AMB-3 publishedAt：保留 pubDate 原始文本（已验证 Date.parse 可解析则映射；不可解析同「缺」省略）。
// AMB-4 描述：按可显示文本处理——实体解码 → 剥离标记 → 空白压缩与首尾裁剪；
//   裁剪长度 / 首段规则未定，不在此裁决（FB-002 由链级负责）。
// AMB-5 200 + HTML 拦截页：按 upstream/bing-outcomes.json 的 blocked-200-html 样本归 ENTRY_CREDENTIALS
//   （访问受限）。BING-002 同时把「拦截页」与「非 RSS」写入，本裁决取拦截页一侧；与任务简报的
//   BAD_RESPONSE 冲突已按样本在交付报告上报。
// AMB-6 预算中止错误形状：条目预算到期 → 携带 code=ENTRY_TIMEOUT 的错误；宿主取消 → AbortError。
// AMB-8 描述标记：解码后的原始标签（如 <b>）整体剥离，snippet 为可显示文本。
// AMB-9 导出：bingBackend = { type: "bing", search(ctx) }（A5 首形态）。
// TODO-BING-1 5xx：规格未列条目码。按 FB-005 逐类排除：5xx 不属凭据/权限、额度（仅 402 与
//   insufficient_quota）、限流（仅 429）、代理、直连网络（传输层）、通道参数限制、单项超时，
//   落入「异常响应」→ ENTRY_BAD_RESPONSE（可降级）。oracle 宽松断言（可降级且非
//   CREDENTIALS/QUOTA/RATE_LIMITED）与此一致。
//
// ─── XXE 面（BING-002「只解析本响应中的 XML，不展开外部实体」；审阅重点）────────────────────────
// 下方手写解析器（受限子集：tokenizer + 递归下降）：
//   - DOCTYPE（含内部子集）整体消费并跳过：SYSTEM/PUBLIC 外部实体标识符不解析、不展开、
//     绝不对其发起任何出站；参数实体不展开。
//   - 仅解码 5 个内置实体与数字字符引用；未知 &name; 按字面保留（不查表、不加载 DTD）。
//   - CDATA 按文本保留（不做实体解码）；XML 声明 / 注释 / PI 消费跳过。
//   - 解析错误只携带行号与（受名称字符集限制的）标签名，永不回显响应文本（CFG-003）。

import { ENTRY_CODES } from "../constants.js";

/** BING-001：端点精确为 https://www.bing.com/search。 */
const BING_ENDPOINT = "https://www.bing.com/search";
/** AMB-2：只提交 q 与 format=rss。 */
const RSS_FORMAT_PARAM = "rss";
/**
 * 响应体字节上限（流式累计；真实 Bing RSS 样本为数十 KB）。超限即 cancel 并按异常响应处理，
 * 防止异常体耗尽内存。429 额度扫描遇超限视为「无额度标记」，不因体积改判。
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** 数字字符引用体（# 之后）的最大长度，防止畸形长引用拖慢扫描；超出按字面保留。 */
const NUMERIC_REF_MAX = 12;
/** 额度判定标记（FB-005：insufficient_quota 无论有无状态码均属额度；非 2xx 先于状态门扫描）。只扫描，不保留响应体。 */
const QUOTA_MARKER = "insufficient_quota";

/** 无注入时钟时的回退（生产由链注入；缺省回落真实时钟，预算照常装定时器，禁静默跳过预算）。 */
const SYSTEM_CLOCK = Object.freeze({
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
});

/** 条目级失败（A5）：携带 .code ∈ ENTRY_CODES；程序违约另抛无 code 的 Error。 */
class BingEntryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BingEntryError";
    this.code = code;
  }
}

export const bingBackend = {
  type: "bing",
  search,
};

/**
 * A5 seam：search(ctx) → { sources }（纯来源适配器，不带 content，FB-002）。
 * ctx = { entry, query, maxResults?, key, fetch, budgetMs, signal, clock, log }。
 */
async function search(ctx) {
  const hostSignal = ctx?.signal;

  // FB-003 预取消：宿主信号已中止时立即结束，零出站（不得调用 ctx.fetch）。
  if (hostSignal?.aborted) throw hostCancelledError();

  // 程序违约（A5：无 code）：查询为空不构成可出站请求（FB-001：宿主判定查询无效时无出站请求）。
  const query = String(ctx?.query ?? "");
  if (query.trim() === "") {
    throw new Error("Bing RSS 适配器契约违约：query 非空是出站前置（FB-001）");
  }

  // FB-003：ctx.signal 与条目预算合并为出站 signal；预算计时必须走 ctx.clock（A8/受控时钟）。
  const linked = new AbortController();
  let budgetExpired = false;
  const onHostAbort = () => {
    if (!linked.signal.aborted) linked.abort(hostSignal.reason);
  };
  if (hostSignal) hostSignal.addEventListener("abort", onHostAbort, { once: true });

  let budgetTimer = null;
  const clock = ctx?.clock ?? SYSTEM_CLOCK;
  const budgetMs = ctx?.budgetMs;
  if (
    typeof budgetMs === "number" &&
    Number.isFinite(budgetMs) &&
    budgetMs > 0 &&
    typeof clock.setTimeout === "function"
  ) {
    budgetTimer = clock.setTimeout(() => {
      budgetExpired = true;
      if (!linked.signal.aborted) linked.abort(new Error("条目预算到期"));
    }, budgetMs);
  }

  const cleanup = () => {
    if (budgetTimer !== null && typeof clock.clearTimeout === "function") {
      clock.clearTimeout(budgetTimer);
    }
    if (hostSignal) hostSignal.removeEventListener("abort", onHostAbort);
  };

  // 失败归类（FB-003/FB-005）：先保留已分类的条目错误；其余按「预算到期 → TIMEOUT，宿主取消 → 无码
  // AbortError，否则 → NETWORK」映射。text()/流读取的原始异常（如 terminated）只走这里，绝不裸出栈。
  const classify = (err) => {
    if (err instanceof BingEntryError) return err;
    if (budgetExpired) {
      return new BingEntryError(
        ENTRY_CODES.TIMEOUT,
        "Bing RSS 条目超时：条目预算到期，在途请求已取消（FB-003）",
      );
    }
    if (hostSignal?.aborted || linked.signal.aborted || isAbortError(err)) {
      return hostCancelledError();
    }
    return new BingEntryError(
      ENTRY_CODES.NETWORK,
      "Bing RSS 直连网络失败：未取得上游响应，请检查条目网络与代理配置（FB-005）",
    );
  };

  // BING-001：一次 GET；q 为原查询（URL 编码往返），format=rss；免 key——ctx.key 全路径不使用，
  // 注入也不出现在 URL 或任何头部；无请求体；出站经 ctx.fetch（A6，网络走条目自己的配置）。
  // cleanup 放在 body 读取完成/失败之后（FB-003：预算与宿主取消覆盖整个 fetch + body 生命周期）。
  const url = buildSearchUrl(query);
  let sources;
  try {
    const response = await ctx.fetch(url, { method: "GET", signal: linked.signal });
    sources = await toSources(response, linked.signal);
  } catch (err) {
    throw classify(err);
  } finally {
    cleanup();
  }

  // FB-002：全量返回上游映射来源，不按 maxResults 本地切片；截断与 truncated 由链统一执行。
  return { sources };
}

/** BING-001：https://www.bing.com/search?q=<原查询>&format=rss（URLSearchParams 百分号编码，解码逐字还原）。 */
function buildSearchUrl(query) {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("format", RSS_FORMAT_PARAM);
  return `${BING_ENDPOINT}?${params.toString()}`;
}

function hostCancelledError() {
  const err = new Error("宿主取消了本次搜索（FB-003：在途操作已取消，不再请求）");
  err.name = "AbortError";
  return err;
}

function isAbortError(err) {
  return err != null && err.name === "AbortError";
}

/**
 * 状态与内容分类（BING-002/FB-005）。除 429 扫描与 2xx 解析外不读响应体；
 * 所有错误消息为静态文本（或仅含状态码），不含响应体原文、查询与 key（CFG-003）。
 */
async function toSources(response, signal) {
  const status = Number(response?.status);
  const is2xx = status >= 200 && status < 300;

  // FB-005 额度优先（先于状态门，与 deepseek.js 同款结构）：非 2xx 先扫体码，命中 insufficient_quota
  // 即归 ENTRY_QUOTA，不论 400/401/403/429 等状态；未命中再进入下方状态门。
  if (!is2xx && (await errorBodyHasQuotaMarker(response, signal))) {
    throw new BingEntryError(
      ENTRY_CODES.QUOTA,
      `Bing RSS 额度不足（HTTP ${status} 且含 insufficient_quota，FB-005）`,
    );
  }

  if (status === 401 || status === 403) {
    throw new BingEntryError(
      ENTRY_CODES.CREDENTIALS,
      "Bing RSS 访问受限（HTTP 401/403）：条目被源站拦截或风控，请检查条目网络环境与启用状态（BING-002）",
    );
  }
  if (status === 402) {
    throw new BingEntryError(ENTRY_CODES.QUOTA, "Bing RSS 返回 HTTP 402：额度或计费受限（FB-005）");
  }
  if (status === 429) {
    // 429 + insufficient_quota 已在上方额度优先分支归 QUOTA；此处为纯限流。
    throw new BingEntryError(ENTRY_CODES.RATE_LIMITED, "Bing RSS 被限流（HTTP 429），请稍后重试（FB-005）");
  }
  if (status >= 500) {
    // TODO-BING-1 裁决：5xx 属上游自身「异常响应」，可降级（见文件头）。
    throw new BingEntryError(
      ENTRY_CODES.BAD_RESPONSE,
      `Bing RSS 上游服务器错误（HTTP ${status}）：按异常响应归类，可降级（FB-005；TODO-BING-1 裁决）`,
    );
  }
  if (status >= 400 && status < 500) {
    // FB-005 统一规则：其他 HTTP 4xx（400/422/404 等，401/402/403/429 已在上方特例）→ 通道参数限制。
    throw new BingEntryError(
      ENTRY_CODES.CHANNEL_LIMIT,
      `Bing RSS 上游拒绝了本次请求参数（HTTP ${status}）：请检查该条目的通道设置（FB-005 统一规则）`,
    );
  }
  if (status < 200 || status >= 300) {
    // AMB-1：真实 fetch 已跟随重定向；3xx 作为最终状态按异常响应处理。
    throw new BingEntryError(
      ENTRY_CODES.BAD_RESPONSE,
      `Bing RSS 返回未预期的 HTTP 状态 ${status}（FB-005 异常响应）`,
    );
  }

  const text = await readBodyText(response, signal);

  // AMB-5：200 + HTML 拦截页（含验证码/区域受限页）= 访问受限，按 blocked-200-html 样本归类。
  if (isHtmlPage(text, response)) {
    throw new BingEntryError(
      ENTRY_CODES.CREDENTIALS,
      "Bing RSS 在 HTTP 200 返回 HTML 拦截页（访问受限，如验证码或区域限制），请检查条目网络环境（BING-002；AMB-5）",
    );
  }

  let doc;
  try {
    doc = parseXmlDocument(text);
  } catch (err) {
    // CFG-003：只取行号（解析错误不含响应文本）。
    throw new BingEntryError(
      ENTRY_CODES.BAD_RESPONSE,
      `Bing RSS 响应不是结构合法的 XML（第 ${err instanceof XmlStructureError ? err.line : "?"} 行；BING-002）`,
    );
  }

  const items = extractItems(doc);
  if (items.length === 0) {
    return []; // BING-002：可解析的零 item = 明确无结果（FB-004 返回空数组而非错误）
  }

  const sources = [];
  for (const item of items) {
    const source = mapItem(item);
    if (source !== null) sources.push(source);
  }
  if (sources.length === 0) {
    throw new BingEntryError(
      ENTRY_CODES.BAD_RESPONSE,
      "Bing RSS 所有条目均无有效链接，按响应失败处理（BING-002）",
    );
  }
  return sources;
}

/**
 * 非 2xx 额度证据扫描（FB-005）：只判定体内是否含 insufficient_quota，响应体不保留、不进错误（CFG-003）。
 * 体积超限或读取失败视为「无额度标记」，由状态门按 HTTP 状态分类（状态分类不丢失）；
 * 仅宿主取消 / 预算到期（signal 已中止）上抛，交 classify 映射。
 */
async function errorBodyHasQuotaMarker(response, signal) {
  let text;
  try {
    text = await readBodyText(response, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    return false;
  }
  return text.includes(QUOTA_MARKER);
}

/**
 * 响应体读取（FB-003 取消 + BING-002 体积上限），2xx 解析与非 2xx 额度扫描共用。
 *   流式（response.body 为 ReadableStream）：逐块累计字节，超 MAX_BODY_BYTES 即 cancel + BAD_RESPONSE；
 *     每次 read 与 signal abort 竞速，abort 时 reader.cancel() 终止流。
 *   无流（仅 text()）：同样与 abort 竞速；text 完成后判长（先看 UTF-16 长度的快速上界，再算 UTF-8 字节数）。
 * 注意：fetch 实现若不随 signal 中止 body，竞速 + cancel 是兜底；原始读取异常不在此映射，统一交 classify。
 */
async function readBodyText(response, signal) {
  let onAbort = null;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortedBodyError());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {}); // 竞速已订阅；此句仅防止无人订阅时的未处理拒绝

  try {
    const stream = response?.body;
    if (stream && typeof stream.getReader === "function") {
      return await readStreamText(stream, aborted);
    }
    const text = await Promise.race([response.text(), aborted]);
    if (text.length > MAX_BODY_BYTES || utf8ByteLength(text) > MAX_BODY_BYTES) {
      throw bodyTooLargeError();
    }
    return text;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readStreamText(stream, aborted) {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let out = "";
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      total += bytes.byteLength;
      if (total > MAX_BODY_BYTES) throw bodyTooLargeError();
      out += decoder.decode(bytes, { stream: true });
    }
    out += decoder.decode();
    return out;
  } catch (err) {
    // 超限或中止：终止底层流（兜底：fetch 实现可能不随 signal 中止 body）；cancel 失败不覆盖原因。
    try {
      reader.cancel().catch(() => {});
    } catch {
      // 忽略同步抛出：原因已在 err 中
    }
    throw err;
  }
}

function utf8ByteLength(text) {
  return new TextEncoder().encode(text).byteLength;
}

function bodyTooLargeError() {
  return new BingEntryError(
    ENTRY_CODES.BAD_RESPONSE,
    "Bing RSS 响应体超出大小上限，按异常响应处理（BING-002）",
  );
}

function abortedBodyError() {
  const err = new Error("响应体读取被中止（FB-003）");
  err.name = "AbortError";
  return err;
}

/** AMB-5 拦截页判定：content-type 为 HTML，或体首为 <html 起始（DOCTYPE 不单独判定，由解析器跳过）。 */
function isHtmlPage(text, response) {
  const contentType = contentTypeOf(response);
  if (contentType.includes("html")) return true;
  const head = text.replace(/^\uFEFF/, "").replace(/^\s+/, "").slice(0, 8).toLowerCase();
  return head.startsWith("<html");
}

function contentTypeOf(response) {
  const headers = response?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") {
    const value = headers.get("content-type");
    return value == null ? "" : String(value).toLowerCase();
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "content-type") return String(value).toLowerCase();
  }
  return "";
}

/** BING-001：根须为 rss 且含 channel；item 取 channel 直接子元素，按文档顺序。 */
function extractItems(doc) {
  if (doc.name.toLowerCase() !== "rss") {
    throw new BingEntryError(
      ENTRY_CODES.BAD_RESPONSE,
      "Bing RSS 响应不是 RSS 文档（根元素不是 rss，BING-002）",
    );
  }
  const channel = doc.children.find((c) => typeof c !== "string" && c.name.toLowerCase() === "channel");
  if (channel === undefined) {
    throw new BingEntryError(
      ENTRY_CODES.BAD_RESPONSE,
      "Bing RSS 响应缺少 channel 结构，按非 RSS 处理（BING-002）",
    );
  }
  return channel.children.filter((c) => typeof c !== "string" && c.name.toLowerCase() === "item");
}

/**
 * item → source（BING-001 映射）：
 *   link → url（须为可解析绝对 HTTP(S)，否则该 item 丢弃，BING-002）
 *   title → title；description → snippet（可显示文本，AMB-4/AMB-8）
 *   pubDate → publishedAt（Date.parse 可解析才映射，否则省略，AMB-3）
 * 未知/缺失字段省略（不产出 undefined 值字段）。
 */
function mapItem(item) {
  const link = elementText(item, "link").trim();
  if (!isAbsoluteHttpUrl(link)) return null;

  const source = { url: link };
  const title = toDisplayText(elementText(item, "title"));
  if (title !== "") source.title = title;
  const snippet = toDisplayText(elementText(item, "description"));
  if (snippet !== "") source.snippet = snippet;
  const pubDate = elementText(item, "pubDate").trim();
  if (pubDate !== "" && Number.isFinite(Date.parse(pubDate))) {
    source.publishedAt = pubDate;
  }
  return source;
}

function elementText(item, name) {
  const wanted = name.toLowerCase();
  const el = item.children.find((c) => typeof c !== "string" && c.name.toLowerCase() === wanted);
  return el === undefined ? "" : collectText(el);
}

function collectText(el) {
  let out = "";
  for (const child of el.children) {
    if (typeof child === "string") out += child;
    else out += collectText(child);
  }
  return out;
}

function isAbsoluteHttpUrl(value) {
  const text = String(value ?? "").trim();
  if (text === "") return false;
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

/** AMB-4/AMB-8：可显示文本 = 实体解码后的文本剥离标记、空白压缩、首尾裁剪。 */
function toDisplayText(raw) {
  if (typeof raw !== "string") return "";
  return stripMarkup(raw).replace(/[\s\u00A0]+/g, " ").trim();
}

/** 文本级标记剥离（XML 解码之后的纯文本步骤）：丢弃 <…> 整体；未闭合的尾部 <… 按字面保留。 */
function stripMarkup(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, lt);
    const gt = text.indexOf(">", lt + 1);
    if (gt === -1) {
      out += text.slice(lt);
      break;
    }
    i = gt + 1;
  }
  return out;
}

// ─── 受限 XML 解析（零依赖：tokenizer + 递归下降；安全面见文件头「XXE 面」）─────────────────────

/** 解析错误：message 为静态文本，line 为 1 起始行号；二者均不含响应内容（CFG-003）。 */
class XmlStructureError extends Error {
  constructor(message, line) {
    super(message);
    this.name = "XmlStructureError";
    this.line = line;
  }
}

/**
 * 解析受限 XML 子集为 { name, attrs, children }（children 为字符串文本节点或元素）。
 * 支持：XML 声明 / 注释 / PI / DOCTYPE（整体跳过）/ CDATA / 元素与引号属性 /
 * 5 内置实体与数字字符引用。不支持且不展开：外部实体、参数实体、命名空间声明以外的属性语义。
 */
function parseXmlDocument(text) {
  const src = String(text ?? "");
  const n = src.length;
  let i = n > 0 && src.charCodeAt(0) === 0xfeff ? 1 : 0;

  const lineAt = (p) => {
    let count = 1;
    const end = Math.min(p, n);
    for (let k = 0; k < end; k += 1) if (src.charCodeAt(k) === 10) count += 1;
    return count;
  };
  const fail = (message) => new XmlStructureError(message, lineAt(i));
  const isWs = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";
  const isNameStart = (c) =>
    (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === ":" || c === "_";
  const isNameChar = (c) => isNameStart(c) || (c >= "0" && c <= "9") || c === "." || c === "-";

  const skipTo = (delim, from, message) => {
    const j = src.indexOf(delim, from);
    if (j === -1) throw fail(message);
    i = j + delim.length;
  };

  // <! … >（含 DOCTYPE 内部子集）：只按括号与引号状态消费到匹配的 '>'，内容不解析。
  const skipDeclaration = () => {
    let depth = 0;
    let quote = "";
    for (let k = i; k < n; k += 1) {
      const c = src[k];
      if (quote !== "") {
        if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (c === "[") depth += 1;
      else if (c === "]") depth = Math.max(0, depth - 1);
      else if (c === ">" && depth === 0) {
        i = k + 1;
        return;
      }
    }
    throw fail("声明未闭合");
  };

  // 文档级空白 / 注释 / PI / 声明：消费到下一个元素或 EOF。
  const skipMisc = () => {
    for (;;) {
      while (i < n && isWs(src[i])) i += 1;
      if (i < n && src[i] === "<") {
        if (src.startsWith("<!--", i)) {
          skipTo("-->", i + 4, "注释未闭合");
          continue;
        }
        if (src.startsWith("<?", i)) {
          skipTo("?>", i + 2, "处理指令未闭合");
          continue;
        }
        if (src.startsWith("<!", i)) {
          skipDeclaration();
          continue;
        }
      }
      return;
    }
  };

  const parseName = () => {
    if (i >= n || !isNameStart(src[i])) throw fail("非法名称");
    const start = i;
    i += 1;
    while (i < n && isNameChar(src[i])) i += 1;
    return src.slice(start, i);
  };

  const NAMED_ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" });
  // 内置实体 + 数字引用（&#dd; / &#xhh;）。未知 &name; 与无效引用按字面保留（不查 DTD、不展开）。
  // 线性扫描（AMB/审阅 P1-5）：每个 & 只向前扫到下一个 ; 或 &（数字引用另有长度上限），
  // 段与段不重叠，整体 O(n)；恶意长 & 串不会退化为二次扫描。
  const decodeEntities = (s) => {
    if (!s.includes("&")) return s;
    let out = "";
    let k = 0;
    while (k < s.length) {
      const amp = s.indexOf("&", k);
      if (amp === -1) {
        out += s.slice(k);
        break;
      }
      out += s.slice(k, amp);
      const end = findReferenceEnd(s, amp);
      if (end === -1) {
        out += "&";
        k = amp + 1;
        continue;
      }
      const decoded = decodeReference(s.slice(amp + 1, end));
      out += decoded === null ? s.slice(amp, end + 1) : decoded;
      k = end + 1;
    }
    return out;
  };

  // 返回 ; 的下标；遇到 & 或超长数字引用或串尾仍未见 ; → -1（该 & 按字面）。
  const findReferenceEnd = (s, amp) => {
    const numeric = s[amp + 1] === "#";
    const limit = numeric ? Math.min(s.length, amp + 2 + NUMERIC_REF_MAX + 1) : s.length;
    for (let p = amp + 1; p < limit; p += 1) {
      const c = s[p];
      if (c === ";") return p;
      if (c === "&") return -1;
    }
    return -1;
  };

  // ref 为 & 与 ; 之间的文本。数字引用：先剥 #，#x/#X 为 16 进制，其余为 10 进制，整串必须是数字；
  // 码位须在 1..0x10FFFF 且非代理区（0/超范围/代理 → null，调用方原样保留引用文本）。
  const decodeReference = (ref) => {
    if (ref[0] === "#") {
      const hex = ref[1] === "x" || ref[1] === "X";
      const digits = ref.slice(hex ? 2 : 1);
      if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) return null;
      const cp = Number.parseInt(digits, hex ? 16 : 10);
      if (cp < 1 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
      return String.fromCodePoint(cp);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ref) ? NAMED_ENTITIES[ref] : null;
  };

  // 递归下降：src[i] === "<" 起解析一个元素；返回 { name, attrs, children }。
  const parseElement = () => {
    i += 1; // '<'
    const name = parseName();
    const attrs = {};
    for (;;) {
      while (i < n && isWs(src[i])) i += 1;
      if (i >= n) throw fail("元素开始标签未闭合");
      const c = src[i];
      if (c === ">") {
        i += 1;
        break;
      }
      if (c === "/") {
        if (src[i + 1] === ">") {
          i += 2;
          return { name, attrs, children: [] };
        }
        throw fail("自闭合斜杠后非法字符");
      }
      if (c === "<") throw fail("下一个标签前缺少 '>'");
      const attrName = parseName();
      while (i < n && isWs(src[i])) i += 1;
      if (src[i] !== "=") throw fail("属性缺少 '='");
      i += 1;
      while (i < n && isWs(src[i])) i += 1;
      const quote = src[i];
      if (quote !== '"' && quote !== "'") throw fail("属性值必须加引号");
      const valueEnd = src.indexOf(quote, i + 1);
      if (valueEnd === -1) throw fail("属性值未闭合");
      attrs[attrName] = src.slice(i + 1, valueEnd);
      i = valueEnd + 1;
    }

    const children = [];
    for (;;) {
      if (i >= n) throw fail(`元素 <${name}> 未闭合`);
      if (src[i] !== "<") {
        const next = src.indexOf("<", i);
        const end = next === -1 ? n : next;
        const chunk = src.slice(i, end);
        if (chunk !== "") children.push(decodeEntities(chunk));
        i = end;
        continue;
      }
      if (src.startsWith("</", i)) {
        const gt = src.indexOf(">", i + 2);
        if (gt === -1) throw fail("结束标签未闭合");
        const closeName = src.slice(i + 2, gt).trim();
        if (closeName !== name) throw fail("结束标签与开始标签不匹配");
        i = gt + 1;
        return { name, attrs, children };
      }
      if (src.startsWith("<!--", i)) {
        skipTo("-->", i + 4, "注释未闭合");
        continue;
      }
      if (src.startsWith("<?", i)) {
        skipTo("?>", i + 2, "处理指令未闭合");
        continue;
      }
      if (src.startsWith("<![CDATA[", i)) {
        const end = src.indexOf("]]>", i + 9);
        if (end === -1) throw fail("CDATA 未闭合");
        const raw = src.slice(i + 9, end);
        if (raw !== "") children.push(raw);
        i = end + 3;
        continue;
      }
      if (src.startsWith("<!", i)) {
        skipDeclaration();
        continue;
      }
      children.push(parseElement());
    }
  };

  skipMisc();
  if (i >= n || src[i] !== "<" || src.startsWith("</", i)) {
    throw fail("缺少文档根元素");
  }
  const root = parseElement();
  skipMisc();
  if (i < n) throw fail("根元素后存在多余内容");
  return root;
}
