// WP2 OpenAI 适配器验收的共享助手（oracle 定义；dev 不得为通过而修改本文件的断言语义）。
//
// 规格来源：docs/specs/draft/openai.md（OAI-001 查询与模型、OAI-002 引用提取与顺序、OAI-003 无引用与响应失败），
//   跨条款：providers.md CAT-001（type=openai，凭据 OPENAI_API_KEY）、fallback.md FB-001..FB-005、
//   config-network.md CFG-002/CFG-003、contract.js A5（适配器 seam）、A6（ctx.fetch）、A7/A8。
//
// 本文件约定：
//   - 适配器按 A5 形状调用：backend.search(ctx)，ctx = { entry, query, maxResults?, key, fetch,
//     budgetMs, signal, clock, log }。resolve → { sources, content? }；失败 throw 带 .code ∈ ENTRY_CODES。
//   - 模块导出形状未在规格定义（A5 只定义 Backend 形状）。本助手接受三种之一：
//     `openaiBackend`、`default`、`createOpenAIBackend()`（同族 WP3 tavily-oracle.js 先例）。oracle 假设，见报告。
//   - 条目的模型参数假定落在 `entry.model`（CFG-004「其余类型参数」，字段拼写为 oracle 假设）；
//     含糊处集中在 test/openai-pending.test.js（P1），不散落。
//   - 合成样本全部内联于本文件，未放入 test/fixtures/：fixtures 卫生规则 6 要求每个 fixture 文件登记到
//     helpers/fixtures.js 的 FIXTURE_NAMES，而该文件属既有 test/，本轮禁止编辑。内联样本同样受
//     openai-redaction.test.js 中的卫生检查约束（保留 TLD、无真实凭据形状）。
//   - 响应样本形状对齐规格来源链接（OpenAI Web search「output and citations」指南）：
//     url_citation 注释嵌套在 `url_citation` 对象内（{type:"url_citation", url_citation:{url,title,start_index,end_index}}），
//     正文块为 {type:"output_text", text, annotations}，消息项为 {type:"message", role, content:[…]}，
//     工具项为 {type:"web_search_call", …}。字段拼写以规格来源为准；结构容忍度（输入承载形状）见待办 P3。
import assert from "node:assert/strict";
import * as C from "./contract.js";
import { createFakeFetch, SYNTHETIC_KEY } from "./fake-fetch.js";
import { createControlledClock, flush } from "./clock.js";
import { tryImportSrc, failIfUnimplemented } from "./impl.js";

/** 实现模块的工作包标签（用于缺失时的红色诊断）。 */
export const WP_OPENAI = "WP2 src/backends/openai.js";
/** 分类函数 classifyUpstreamFailure 所在模块（A4，WP5 负责）。 */
export const WP_SEARCH = "WP5 src/search.js";

/** OAI-001：单查询 POST 端点（固定，无查询串）。 */
export const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
/** OAI-001：省略 model 时的默认模型。 */
export const OPENAI_MODEL_DEFAULT = "gpt-5.6-luna";
/** OAI-001 验收：显式自定义模型（合成模型名）。 */
export const OPENAI_MODEL_CUSTOM = "synthetic-model-1";
/** 合成凭据（可辨识，见 fake-fetch.js SYNTHETIC_KEY 约定）。 */
export const OPENAI_KEY = SYNTHETIC_KEY("openai");
/** 第二个合成条目的 key，用于「每条目 key 只发给自己」断言。 */
export const OPENAI_KEY_B = SYNTHETIC_KEY("openai-second");
/** 合成查询（含中文与空格，验证原查询逐字出现在任务文本中）。 */
export const SAMPLE_QUERY = "synthetic openai query 合成查询";
/** 真实 Promise 守卫时长：仅用于防止挂起测试卡死，不得作为预算依据（预算走 ctx.clock）。 */
export const GUARD_MS = 3000;

// ─── 内联合成样本（保留 TLD，结构与规格来源文档一致，内容虚构）────────────────

/** 三条 url_citation 注释的期望来源描述（有序）；snippet 是所在文本块的首个非空段落。 */
export const SAMPLE_CITATIONS = Object.freeze([
  {
    url: "https://synthetic-host.invalid/openai/c1",
    title: "合成引用一",
    snippet: "第一段甲。",
    text: "第一段甲。\n\n第二段甲续。",
  },
  {
    url: "https://synthetic-host.invalid/openai/c2",
    title: "合成引用二",
    snippet: "第一段乙。",
    text: "  \n第一段乙。\n\n第二段乙续。", // 首段前有空行：首个「非空」段落仍是「第一段乙。」
  },
  {
    url: "https://synthetic-host.invalid/openai/c3",
    title: undefined, // 无 title：来源须省略 title（不得编造）
    snippet: "第一段丙。",
    text: "第一段丙。",
  },
]);

/** 按期望描述造一条嵌套形状注释（指南格式：字段在 url_citation 对象内）。 */
export function citationOf(c) {
  return {
    type: "url_citation",
    url_citation: {
      start_index: c.start ?? 0,
      end_index: c.end ?? 12,
      url: c.url,
      ...(c.title !== undefined ? { title: c.title } : {}),
    },
  };
}

/** output_text 内容块。 */
export function outputText(text, annotations = []) {
  return { type: "output_text", text, annotations };
}

/** assistant 消息项（content 可为字符串或内容块数组）。 */
export function assistantMessage(content, extra = {}) {
  return {
    type: "message",
    id: "msg_synth",
    role: "assistant",
    status: "completed",
    content: Array.isArray(content) ? content : [outputText(content)],
    ...extra,
  };
}

/** web_search 工具调用项（OAI-002 验收「混有工具项」：不得产出来源）。 */
export function webSearchCallItem(query = SAMPLE_QUERY) {
  return { type: "web_search_call", id: "ws_synth", status: "completed", action: { type: "search", query } };
}

/** 完成态响应包装（OAI-002「OpenAI 返回完成的响应时」）。 */
export function completedResponse(output, extra = {}) {
  return {
    id: "resp_synth_1",
    object: "response",
    created_at: 1700000000,
    status: "completed",
    model: OPENAI_MODEL_DEFAULT,
    output,
    ...extra,
  };
}

/** 按样本生成一条带一条注释的消息项。 */
export function messageWithCitation(c) {
  return assistantMessage([outputText(c.text, [citationOf(c)])]);
}

/** 三条引用分属三条消息（正常有序映射用例）。 */
export function threeCitationOutput() {
  return SAMPLE_CITATIONS.map(messageWithCitation);
}

/** 未完成响应（OAI-003 验收「未完成状态」）。 */
export function incompleteResponse(output = threeCitationOutput(), status = "incomplete") {
  return completedResponse(output, { status });
}

/** 显式拒绝响应（OAI-003 验收「显式拒绝」；消息级 refusal 字段，指南形状）。 */
export function refusalResponse(reason = "synthetic refusal: policy declined") {
  return completedResponse([
    {
      type: "message",
      id: "msg_refusal_synth",
      role: "assistant",
      status: "completed",
      refusal: reason,
      content: [outputText("")],
    },
  ]);
}

/** 仅模型正文、零引用（OAI-003 验收「只有模型正文」→ 响应失败，非正常空结果）。 */
export function textOnlyResponse(text = "合成正文，没有任何引用注释。") {
  return completedResponse([assistantMessage(text)]);
}

/** 上游鉴权失败的合成错误体（不含真实 key）。 */
export const SYNTH_AUTH_BODY = Object.freeze({
  error: { type: "authentication_error", message: "Incorrect API key provided. (synthetic)" },
});
/** 上游额度错误体（error.code=insufficient_quota，FB-005 明文 + OpenAI 典型形状）。 */
export const SYNTH_QUOTA_BODY = Object.freeze({
  error: { code: "insufficient_quota", message: "synthetic quota message" },
});
/** 上游限流错误体（其他 429）。 */
export const SYNTH_RATE_BODY = Object.freeze({
  error: { type: "rate_limit_exceeded", message: "synthetic rate limit" },
});
/** 上游内容过滤错误体（非 200 的拒绝载体，载体含糊见待办 P7）。 */
export const SYNTH_CONTENT_FILTER_BODY = Object.freeze({
  error: { code: "content_filter", message: "synthetic content policy decline" },
});

// ─── 加载与上下文 ─────────────────────────────────────────────────────────

/**
 * 加载 OpenAI 适配器。模块缺失时在 test 内记红（failIfUnimplemented）。
 * @returns {Promise<{ type?: string, search: Function } | null>} null 表示已记红并已抛错（调用方 return）。
 */
export async function loadOpenAIBackend(t, clauses = "OAI-001/OAI-002/OAI-003") {
  const res = await tryImportSrc("backends/openai.js");
  if (failIfUnimplemented(t, res, WP_OPENAI, clauses)) return null;
  const mod = res.module;
  const backend =
    mod.openaiBackend ??
    mod.default ??
    (typeof mod.createOpenAIBackend === "function" ? mod.createOpenAIBackend() : undefined);
  assert.ok(
    backend && typeof backend.search === "function",
    "src/backends/openai.js 须导出 Backend（{ type, search(ctx) }，A5）；oracle 接受 openaiBackend / default / createOpenAIBackend() 三种形态之一（形状未在规格定义，见报告）",
  );
  return backend;
}

/**
 * 构造 A5 ctx。条目的模型参数放 entry.model（oracle 假设，见待办 P1 头注）；
 * maxResults 未指定时整体省略该字段。
 */
export function makeCtx(overrides = {}) {
  const fetch = overrides.fetch ?? createFakeFetch();
  const entry = C.makeEntry({
    id: overrides.entryId ?? "oai-entry-1",
    type: "openai",
    name: overrides.name ?? "合成 OpenAI 条目",
  });
  if ("model" in overrides) entry.model = overrides.model;
  return {
    entry,
    query: overrides.query ?? SAMPLE_QUERY,
    ...(overrides.maxResults !== undefined ? { maxResults: overrides.maxResults } : {}),
    key: "key" in overrides ? overrides.key : OPENAI_KEY,
    fetch,
    budgetMs: overrides.budgetMs ?? 5000,
    signal: overrides.signal,
    clock: overrides.clock ?? createControlledClock(),
    log: overrides.log ?? (() => {}),
  };
}

/**
 * 只声明一条 OpenAI 路由的假 fetch。spec 形如 { status, body?, headers? }。
 * 未声明的出站由 fake-fetch 抛错，便于发现多余请求。
 */
export function openaiFetch(spec) {
  const f = createFakeFetch();
  f.when(OPENAI_ENDPOINT).responds(spec);
  return f;
}

/** 无任何路由的假 fetch（零出站断言用：任何抵达都会抛「未声明的出站调用」）。 */
export function openaiFetchNoRoutes() {
  return createFakeFetch();
}

/** OpenAI 路由以网络层错误失败（无 HTTP 状态）。 */
export function openaiFetchFails(error) {
  const f = createFakeFetch();
  f.when(OPENAI_ENDPOINT).fails({ error });
  return f;
}

/** OpenAI 路由挂起直到 signal 中止。 */
export function openaiFetchHangs() {
  const f = createFakeFetch();
  f.when(OPENAI_ENDPOINT).hangs();
  return f;
}

// ─── 出站断言 ─────────────────────────────────────────────────────────────

/** 恰好一次出站到 OpenAI 端点，返回该次调用记录。OAI-001 要求1 + FB-001（每条目最多一次）。 */
export function singleCall(fetch, label = "OpenAI 请求") {
  const calls = fetch.callsFor(OPENAI_ENDPOINT);
  assert.equal(
    calls.length,
    1,
    `${label}：必须恰好一次 POST 到 ${OPENAI_ENDPOINT}（OAI-001 / FB-001 每条目最多一次）；实际出站共 ${fetch.count()} 次`,
  );
  return calls[0];
}

/** 解析请求正文 JSON。 */
export function bodyOf(call) {
  assert.equal(typeof call.init.body, "string", "请求正文须为字符串（JSON）");
  return JSON.parse(call.init.body);
}

/** 断言端点与方法，且 URL 不带查询串（OAI-001 要求1、CFG-003：key 不得进入 URL）。 */
export function assertEndpoint(call) {
  assert.equal(call.method, "POST", "OAI-001：方法必须为 POST");
  const u = new URL(call.url);
  assert.equal(`${u.origin}${u.pathname}`, OPENAI_ENDPOINT, `OAI-001：端点必须为 ${OPENAI_ENDPOINT}`);
  assert.equal(u.search, "", "OAI-001/CFG-003：端点不得带查询串（key 只进鉴权头）");
}

// ─── 任务文本提取（OAI-001「与任务有关的内容仅为当前查询和固定搜索指令」）────

/**
 * 从 Responses 请求体收集全部任务文本。覆盖两种合法承载（见待办 P3，二者之一即可）：
 * - body.input：字符串，或消息项数组（content 为字符串或 {type:"input_text",text} 部件数组）；
 * - body.instructions：字符串（固定指令的常见承载）。
 * 找不到任何承载时返回 []，由断言报错并指向待办 P3。
 */
export function collectTaskTextParts(body) {
  const parts = [];
  const input = body?.input;
  if (typeof input === "string") parts.push(input);
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const content = item.content;
      if (typeof content === "string") parts.push(content);
      else if (Array.isArray(content)) {
        for (const p of content) {
          if (p && typeof p === "object" && typeof p.text === "string") parts.push(p.text);
        }
      }
    }
  }
  if (typeof body?.instructions === "string" && body.instructions.length > 0) parts.push(body.instructions);
  return parts;
}

/** 任务文本中不承载本次查询的部分 = 「固定搜索指令」（OAI-001：省略模型参数后跨查询不变）。 */
export function fixedInstructionParts(body, query) {
  return collectTaskTextParts(body)
    .filter((p) => p !== query && !p.includes(query))
    .join("\n");
}

// ─── 结果与错误断言 ──────────────────────────────────────────────────────

/** 去掉值为 undefined 的键，便于与期望对象做严格比较（不误伤「缺字段」语义）。 */
export function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** 把适配器返回的 sources 归一为去掉 undefined 键的对象数组。 */
export function normalizeSources(sources) {
  assert.ok(Array.isArray(sources), "适配器须 resolve 出 sources 数组（A5）");
  return sources.map(stripUndefined);
}

/** OAI-002 映射期望：url→url、title→title（可用才给）、snippet=所在文本块首个非空段落。 */
export function expectedSourceOf(c) {
  return stripUndefined({ url: c.url, title: c.title, snippet: c.snippet });
}

/** 等待适配器 promise 失败并返回错误；若成功则测试失败。 */
export async function rejectionOf(promise) {
  let err;
  let threw = false;
  try {
    await promise;
  } catch (e) {
    err = e;
    threw = true;
  }
  if (!threw) assert.fail("期望适配器失败（抛错），实际却成功返回");
  return err;
}

/** 条目级失败：code ∈ ENTRY_CODES，且带可操作的非空 message（FB-004/FB-005）。 */
export function assertEntryError(err, code) {
  assert.ok(err && typeof err === "object", "失败须以错误对象抛出");
  assert.ok(
    Object.values(C.ENTRY_CODES).includes(err.code),
    `失败码须属于 ENTRY_CODES（A5/FB-005），实际：${err.code}`,
  );
  assert.equal(err.code, code, `分类码须为 ${code}（FB-005/OAI-003），实际：${err.code}`);
  assert.equal(typeof err.message, "string", "错误 message 须为文本");
  assert.ok(err.message.length > 0, "错误 message 须给出可操作原因（FB-005）");
}

/**
 * 守卫：超过真实 GUARD_MS 仍未结束即失败，防止挂起测试卡死。
 * 预算语义必须由 ctx.clock 驱动，不得依赖此真实计时。
 */
export async function withGuard(promise, why = "") {
  promise.catch(() => {}); // 守卫超时后原 promise 迟到的拒绝不得成为未处理拒绝
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new assert.AssertionError({
            message: `超过 ${GUARD_MS}ms 仍未结束${why ? `：${why}` : ""}（超时/取消应由 ctx.clock 或 ctx.signal 驱动）`,
          }),
        ),
      GUARD_MS,
    );
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

export { flush };
