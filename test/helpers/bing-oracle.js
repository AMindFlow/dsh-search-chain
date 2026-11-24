// WP4 Bing RSS 适配器验收助手（WP0 oracle 新增，仅供 test/bing-*.test.js 使用）。
// 规格来源：docs/specs/draft/bing.md（BING-001 请求与来源、BING-002 空 Feed 与失败）；
// 失败分类依据 docs/specs/draft/fallback.md FB-002 / FB-003 / FB-005；脱敏依据 CFG-003（见 helpers/redact.js）。
//
// ─── 规格含糊：集中待办（全套件只有这一条断言标注为待办）──────────────────────────
// TODO-BING-1 5xx 的条目码未写：bing.md 未列；FB-005 只按类别列出，未把 5xx 映射到具体码。
//             断言只锁定「可降级，且不属于 CREDENTIALS / QUOTA / RATE_LIMITED」，
//             不断言 BAD_RESPONSE 或 NETWORK。位于 bing-failure.test.js。
//
// ─── 规格含糊：未断言（列入交付报告，待规格澄清后再补断言）────────────────────────
// AMB-1 重定向（3xx）：bing.md 与 FB-005 均未规定，本套件无断言。
// AMB-2 计数、时效与 market 参数：BING-001 只规定 q 与 format=rss。本套件只断言「已提交的参数
//       不得为空值、不得为 null/undefined 字面量」，不断言是否应携带 count / freshness / market。
// AMB-3 publishedAt 文本格式：规格只写「可解析的 pubDate」。断言仅为与 pubDate 指向同一时刻。
// AMB-4 description 裁剪长度与「首段」规则：FB-002 没有裁剪长度与首段条款（fixture 注释所称
//       「FB-002 首段规则」指向不存在的条款）。只断言 snippet 包含首段文本，不断言裁剪长度，
//       也不断言第二段被丢弃。
// AMB-5 200 + HTML 拦截页的归类：BING-002 同时把拦截页归为「访问受限」、把「非 RSS」归为「响应失败」。
//       本套件遵循 upstream/bing-outcomes.json 的 blocked-200-html → ENTRY_CREDENTIALS。
//       任务简报写的是 BAD_RESPONSE，与该样本冲突，已在交付报告中提出。
// AMB-6 预算中止的错误形状：FB-003 未规定。断言为 AbortError 或 ENTRY_TIMEOUT 二选一，且不得 resolve。
// AMB-7 maxResults 截断责任：FB-002 的 truncated 由链级负责；适配器是否自行截断未定。
//       断言只要求返回值是上游顺序的前缀。
// AMB-8 描述中的标记：bing.md 要求「以可显示的文本处理」。本套件据此断言 snippet 不含原始 <b> 标签。
//       这是对该措辞的唯一解读，已列入报告。
// AMB-9 导出形状：规格未规定。按 exa 同族约定容忍 bingBackend | default | createBingBackend()，
//       要求具有 search(ctx) 方法（A5）。
//
// ─── 宿主清单（非代码断言，发布前在宿主侧核对，此处仅列出）──────────────────────────
// HOST-BING-1 复查目标网络及错误行为：在真实网络上用公开查询复验 RSS 返回格式，并记录 403 / 拦截页 / 5xx 的实际表现（脱敏样本）。
// HOST-BING-2 切换启用状态与条目代理后，从 dsh 工具复验 BING-001 的请求路径。
// ──────────────────────────────────────────────────────────────────────────────────

import assert from "node:assert/strict";
import { tryImportSrc, failIfUnimplemented } from "./impl.js";
import { createControlledClock, flush } from "./clock.js";
import { createFakeFetch, SYNTHETIC_KEY } from "./fake-fetch.js";
import { createLogCapture } from "./redact.js";
import { ENTRY_CODES } from "./contract.js";

export const BING_WP = "WP4 src/backends/bing.js";
export const BING_ENDPOINT = "https://www.bing.com/search";
export const BING_BUDGET_MS = 25000;
/** 含空格、引号、加号、百分号、井号与 & 的查询，用于验证 URL 编码（BING-001 验收）。 */
export const BING_QUERY = '合成查询 "bing" C++ & 100% #tag';
/** 免 key 条目的测试用合成值：任何情况下都不得出现在出站 URL 或头部中。 */
export const BING_UNUSED_KEY = SYNTHETIC_KEY("bing");
/** 合成的「原始响应体」标记：用于检查错误文本与日志是否泄漏响应体（CFG-003 / BING-002）。 */
export const BODY_MARKER = "BODY-MARKER-synthetic-7f3a-原文片段";

/** FB-005 可降级的条目码（不含终止类 CONTENT_POLICY）。 */
export const DEGRADABLE_CODES = Object.freeze(
  Object.values(ENTRY_CODES).filter((c) => c !== ENTRY_CODES.CONTENT_POLICY),
);

/**
 * 加载 Bing 适配器（未实现则按 impl.js 约定红）。
 * @param {import("node:test").TestContext} t
 * @param {string} clauses 条款编号，如 "BING-001 请求"
 */
export async function loadBingBackend(t, clauses) {
  const res = await tryImportSrc("backends/bing.js");
  failIfUnimplemented(t, res, BING_WP, clauses);
  const mod = res.module;
  const backend =
    mod.bingBackend ?? mod.default ?? (typeof mod.createBingBackend === "function" ? mod.createBingBackend() : undefined);
  assert.ok(
    backend && typeof backend.search === "function",
    `${clauses}: src/backends/bing.js 须导出 bingBackend = { type: "bing", search(ctx) }（A5；AMB-9）`,
  );
  return backend;
}

/**
 * 包装假 fetch：每次调用 ctx.fetch 都记入 dispatched（无论 signal 是否已中止）。
 * 用于「零出站」断言：fake-fetch 自身的 calls 会记录预取消的调用，不能直接用来判断是否出站。
 */
export function spyFetch(inner) {
  const dispatched = [];
  const spy = (url, init = {}) => {
    dispatched.push({ url: String(url), init });
    return inner(url, init);
  };
  spy.dispatched = dispatched;
  spy.inner = inner;
  spy.when = inner.when;
  // 透传底层记录的调用列表（如 bodyHangFetch 的 bodyCancelled 标记；fake-fetch 亦有 calls）。
  spy.calls = inner.calls;
  return spy;
}

/** 把 init.headers（对象 / Headers / 数组）规范化为小写键的普通对象。 */
export function headersOf(init = {}) {
  const out = {};
  const h = init.headers;
  if (!h) return out;
  if (typeof Headers !== "undefined" && h instanceof Headers) {
    for (const [k, v] of h.entries()) out[k.toLowerCase()] = v;
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = String(v);
  return out;
}

/**
 * 构造适配器上下文（contract.js A5）。
 * 默认无 key（BING-001 免 key）；只有显式传入 opts.key 时才设置 ctx.key。
 */
export function makeBingCtx(opts = {}) {
  const clock = opts.clock ?? createControlledClock();
  const fetch = spyFetch(createFakeFetch({ default: "never", clock }));
  const log = createLogCapture();
  const ctx = {
    entry: {
      id: opts.entryId ?? "bing-entry-1",
      type: "bing",
      name: opts.name ?? "Bing RSS 合成条目",
      enabled: true,
    },
    query: opts.query ?? BING_QUERY,
    fetch,
    budgetMs: opts.budgetMs ?? BING_BUDGET_MS,
    signal: opts.signal ?? new AbortController().signal,
    clock,
    log: log.log,
  };
  if ("key" in opts) ctx.key = opts.key;
  if (opts.maxResults !== undefined) ctx.maxResults = opts.maxResults;
  return { ctx, clock, fetch, log };
}

/** 为 Bing 端点声明一条合成响应路由。 */
export function routeBing(fetch, spec) {
  fetch.when(BING_ENDPOINT).responds(spec);
}

/** 为 Bing 端点声明一条挂起路由（直到 signal 中止）。 */
export function hangBing(fetch) {
  fetch.when(BING_ENDPOINT).hangs();
}

/** 为 Bing 端点声明一条网络故障路由。 */
export function failBing(fetch, error) {
  fetch.when(BING_ENDPOINT).fails({ error });
}

/**
 * body 阶段双 fetch（FB-003 覆盖 body 生命周期；审阅缺口 2）：响应头先到——fetch 的 promise
 * 立即 resolve 一个 Response，body 流永不写入任何块，getReader().read() 永不 resolve
 * （模拟上游只发出响应头、body 挂起）。适配器 reader.cancel() 兜底生效时记录 bodyCancelled。
 * 共享 fake-fetch 不承载该形态，故按任务要求写入 Bing 自有 helper。
 */
export function bodyHangFetch(opts = {}) {
  const calls = [];
  const fetchFn = (url, init = {}) => {
    const record = { url: String(url), init, bodyCancelled: false };
    calls.push(record);
    const signal = init?.signal;
    if (signal?.aborted) {
      record.settled = "aborted";
      const err = new Error(signal.reason?.message ?? "This operation was aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    }
    const stream = new ReadableStream({
      start() {
        // 响应头已到（Response 已 resolve）；body 永不写入任何块：read() 挂起。
      },
      cancel() {
        record.bodyCancelled = true;
      },
    });
    record.settled = "ok";
    return Promise.resolve(
      new Response(stream, {
        status: opts.status ?? 200,
        headers: {
          "content-type": opts.contentType ?? "application/rss+xml; charset=utf-8",
          ...(opts.headers ?? {}),
        },
      }),
    );
  };
  fetchFn.calls = calls;
  fetchFn.count = () => calls.length;
  return fetchFn;
}

/**
 * body 阶段测试上下文：与 makeBingCtx 等价，但出站改走 bodyHangFetch（响应头先到、body 挂起）。
 * opts 透传给 makeBingCtx；body 形状经 opts.bodyStatus / opts.bodyContentType 调整。
 */
export function makeBingBodyHangCtx(opts = {}) {
  const { ctx, clock, log } = makeBingCtx(opts);
  const bodyFetch = spyFetch(bodyHangFetch({ status: opts.bodyStatus, contentType: opts.bodyContentType }));
  ctx.fetch = bodyFetch;
  return { ctx, clock, fetch: bodyFetch, log };
}

/** 把 {status, contentType, body} 样本路由到 Bing 端点。 */
export function routeFromResponse(fetch, response) {
  routeBing(fetch, {
    status: response.status,
    body: response.body,
    headers: { "content-type": response.contentType },
  });
}

/** 唯一一次出站记录；出站次数不为 1 时给出可读断言。 */
export function onlyDispatch(fetch) {
  assert.equal(fetch.dispatched.length, 1, "BING-001：每次搜索恰好一次 GET 出站（BING-002：拦截或失败后也不得额外出站）");
  return fetch.dispatched[0];
}

/** 把 promise 归一化为 {ok, value|error}。 */
export async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * 带守护的等待：仅用于检测「挂起未随 signal 中止」，不作为正确性的时间依据。
 * 超时返回 { timedOut: true }，调用方据此报红。
 */
export async function raceWithin(promise, ms = 2000) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([settle(promise), guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** 断言来源形状（A1/FB-002）：url 为绝对 HTTP(S)；可选字段若存在须为字符串。 */
export function assertSourceShape(sources) {
  assert.ok(Array.isArray(sources), "sources 必须是数组（A1/FB-002）");
  for (const [i, s] of sources.entries()) {
    assert.equal(typeof s.url, "string", `sources[${i}].url 必须是字符串（A1）`);
    let u;
    try {
      u = new URL(s.url);
    } catch {
      assert.fail(`sources[${i}].url 必须是可解析 URL（FB-002）：${s.url}`);
    }
    assert.ok(u.protocol === "http:" || u.protocol === "https:", `sources[${i}].url 必须是绝对 HTTP(S)（FB-002）：${s.url}`);
    for (const f of ["title", "snippet", "summary", "publishedAt"]) {
      if (s[f] !== undefined) assert.equal(typeof s[f], "string", `sources[${i}].${f} 若存在须为字符串`);
    }
  }
}

// ─── 合成 RSS 构造（全部使用 .invalid / .test 保留域，见 test/fixtures/README.md 卫生规则 1）──

/** 构造一个 <item>；未给出的字段整体省略。文本须已是 XML 安全的（需要实体时自行写 &amp; 等）。 */
export function rssItem({ title, link, description, pubDate } = {}) {
  return [
    "<item>",
    title !== undefined ? `<title>${title}</title>` : "",
    link !== undefined ? `<link>${link}</link>` : "",
    description !== undefined ? `<description>${description}</description>` : "",
    pubDate !== undefined ? `<pubDate>${pubDate}</pubDate>` : "",
    "</item>",
  ].join("");
}

/** 构造合法 RSS 2.0 文档。 */
export function rssDoc(itemsXml = "") {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    "<title>synthetic bing results (inline)</title>",
    "<link>https://www.bing.synthetic.invalid/search</link>",
    itemsXml,
    "</channel></rss>",
  ].join("");
}

/** 补充样本（内联；复用的 fixture 见 helpers/fixtures.js 的 FIXTURE_NAMES）。 */
export const INLINE = Object.freeze({
  /** 部分无效 item：无 link、非 HTTP(S)、相对 URL 均丢弃，仅保留最后一条有效 item（&amp; 解码为 &）。 */
  partialValid: rssDoc(
    [
      rssItem({ title: "无链接条目", description: "缺少 link，应丢弃" }),
      rssItem({ title: "脚本链接", link: "javascript:alert(1)", description: "非 HTTP(S)，应丢弃" }),
      rssItem({ title: "相对链接", link: "/relative/path", description: "非绝对 URL，应丢弃" }),
      rssItem({
        title: "有效条目",
        link: "https://inline-valid.host.test/ok?x=1&amp;y=2",
        description: "保留的有效描述",
        pubDate: "Wed, 05 Nov 2025 10:00:00 GMT",
      }),
    ].join(""),
  ),
  /** 所有 item 均无有效链接（BING-002：响应失败）。 */
  noValidLinks: rssDoc(
    [
      rssItem({ title: "无链接一", description: "应丢弃" }),
      rssItem({ title: "脚本链接", link: "javascript:alert(2)", description: "应丢弃" }),
    ].join(""),
  ),
  /** 描述中的标记经 XML 解码后为 <b>…</b>（bing.md「以可显示的文本处理」，见 AMB-8）。 */
  markupDescription: rssDoc(
    rssItem({
      title: "标记描述",
      link: "https://markup.host.test/doc",
      description: "&lt;b&gt;关键词&lt;/b&gt; 描述文本",
    }),
  ),
  /** 外部实体声明：不得解析该 SYSTEM 标识符（BING-002「只解析本响应中的 XML，不展开外部实体」）。 */
  externalEntity: [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE rss [<!ENTITY ext SYSTEM "https://xxe.host.test/leak">]>',
    '<rss version="2.0"><channel>',
    "<item><title>外部实体 &ext;</title><link>https://xxe-item.host.test/a</link></item>",
    "</channel></rss>",
  ].join(""),
  /** 非 RSS 的纯文本应答（200）。 */
  plainText: "Service temporarily unavailable. Please retry later.",
  /** 非 RSS 的 JSON 应答（200）。 */
  jsonBody: JSON.stringify({ results: [] }),
  /** 畸形 XML，且其中嵌入原始响应体标记：解析器错误文本不得回显该标记（CFG-003）。 */
  malformedWithMarker: `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item><title>${BODY_MARKER} <link>https://marker.host.test/a</channel></rss>`,
});

/** 合成的 Bing 拦截页（HTML 体中嵌入标记，用于脱敏测试）。 */
export const MARKED_BLOCK_PAGE = `<!DOCTYPE html><html><body><h1>Access restricted</h1><p>${BODY_MARKER}</p></body></html>`;

/** FB-005 上游结局样本：复用已登记的 upstream/http-outcomes.json，去掉 Tavily 专属的 432。 */
export function sharedUpstreamOutcomes(loadFixture, FIXTURE_NAMES) {
  return loadFixture(FIXTURE_NAMES.upstreamErrors).outcomes.filter((o) => o.id !== "channel-limit-tavily-432");
}

/** 5xx 合成样本（TODO-BING-1：只断言可降级，不断言具体码）。 */
export const BING_SERVER_ERRORS = Object.freeze([
  {
    id: "server-500",
    response: { status: 500, contentType: "application/json", body: { error: { type: "server_error", message: "synthetic internal error" } } },
  },
  {
    id: "server-503",
    response: { status: 503, contentType: "text/plain", body: "synthetic unavailable" },
  },
]);
