// WP8 DeepSeek 适配器验收共享助手（oracle 定义；dev 不得为通过而修改本文件的断言语义）。
//
// 规格入口：docs/specs/draft/deepseek.md（DSK-001..DSK-004，本 WP 主验收入口）。
// 跨条款：providers.md CAT-001（DeepSeek 条目凭据 DEEPSEEK_API_KEY、两模式 choice；字段呈现/计费文案
//   属 WP12 设置面板，不在适配器测试内断言）、fallback.md FB-001..FB-005、
//   config-network.md CFG-002/CFG-003、helpers/contract.js A1..A8。
//
// 范围界定（与 DSH-005 的区别）：本套件只测「用户把 DeepSeek 配成链内普通条目」的两模式适配器
//   src/backends/deepseek.js。宿主官方 API 委派分支（复用宿主 DeepSeekSearchProvider）由
//   dsh-integration.md DSH-005 与 WP6/dsh-official-routing 测试管辖，不在本文件。
//
// 适配器 seam（A5）：backend.search(ctx)，ctx = { entry, query, maxResults?, key, fetch, budgetMs,
//   signal, clock, log }。resolve → { sources, content? }（空数组=明确无结果，FB-004）；
//   失败 throw 携带 .code ∈ ENTRY_CODES；程序违约 throw 无 code 的错误。
//   两种模式（entry.type ∈ {deepseek-search, deepseek-agentic-search}）按规格共用一个供应商；
//   本助手按 entry.type 解析出对应 search 入口（解析形状见 S1）。
//
// ─── 接缝假设（dev seam；集中记录，不属于规格含糊待办）─────────────────────────
// S1 模块导出形状未在规格定义。src/backends/deepseek.js 任一形状可接受：
//    a) 命名/默认导出单个 Backend（{ type, search(ctx) }），search 按 ctx.entry.type 分发；
//    b) 映射导出 `deepseekBackends = { "deepseek-search": B1, "deepseek-agentic-search": B2 }`
//       （键∈ TOOL_TYPES 且 supplierOfToolType(key)==="deepseek"）；
//    c) 命名导出 `deepseekSearchBackend` / `deepseekAgenticSearchBackend`。
//    择一实现即可；type 若存在须为 deepseek* 字符串。
// S2 模式归属按 ctx.entry.type（contract.js TOOL_TYPES 的两个 deepseek 类型 id）。
// S3 预算中止的错误形状未写（同族先例 TODO-EXA-9）：接受 ENTRY_TIMEOUT 或 name==="AbortError"。
// S4 缺 key 适配器级形状未写（链级 FB-001 保证跳过零出站）：只断言零出站且拒绝。
// S5 挂起 fake fetch 只有 signal，没有真实 body 流：适配器须把该 signal（单独或合并 ctx.signal 的
//    合并 signal）作为 init.signal 传给 fetch——取消断言据此成立（A6 由链注入 ctx.fetch）。
// S6 FB-002 截断责任归属未在规格写（同族先例 TODO-EXA-6）：适配器级只断言结果是上游顺序的前缀，
//    不断言谁截断、是否置 truncated。
// S7 合成样本全部内联于本文件，未放入 test/fixtures/：卫生规则 6 要求每个 fixture 文件登记到
//    helpers/fixtures.js 的 FIXTURE_NAMES，而该文件属既有 test/，本任务禁止编辑。内联样本仍遵守
//    fixtures/README.md 卫生规则：来源 URL 只用保留域、key 用 SYNTHETIC_KEY 可辨识形状；
//    端点常量按规格字面值书写（同族先例 exa-oracle/or openai-oracle，helper 不在 fixture 卫生扫描内）。
// ──────────────────────────────────────────────────────────────────────────────
//
// 规格含糊待办的断言文件：test/deepseek-pending.test.js（P1..P8，推断注明）。

import assert from "node:assert/strict";
import * as C from "./contract.js";
import { createFakeFetch, SYNTHETIC_KEY } from "./fake-fetch.js";
import { createControlledClock } from "./clock.js";
import { loadFixture, FIXTURE_NAMES } from "./fixtures.js";
import { tryImportSrc, failIfUnimplemented } from "./impl.js";

/** 实现模块的工作包标签（缺失时红色诊断指向 WP8）。 */
export const WP_DEEPSEEK = "WP8 src/backends/deepseek.js";
/** classifyUpstreamFailure 所在模块（A4，WP5 负责）。 */
export const WP_SEARCH = "WP5 src/search.js";

/** DSK-001：Agentic Search 端点（规格字面）。 */
export const DSK_AGENTIC_ENDPOINT = "https://api.deepseek.com/anthropic/v1/messages";
/** DSK-003：独立 Search API 端点（规格字面）。 */
export const DSK_SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search";
/** DSK-001：固定模型名（规格字面）。 */
export const DSK_MODEL = "deepseek-flash";
/** DSK-001：固定 max_tokens。 */
export const DSK_MAX_TOKENS = 256;
/** DSK-001：工具声明三字段。 */
export const DSK_TOOL = Object.freeze({ type: "web_search_20250305", name: "web_search", max_uses: 1 });
/** DSK-003：count 上限。 */
export const DSK_COUNT_CAP = 50;
/** DSK-003：查询长度上限（Unicode 字符）。 */
export const DSK_QUERY_MAX_CHARS = 128;
/** CAT-001：合成凭据（可辨识，见 fake-fetch.js SYNTHETIC_KEY 约定）。 */
export const DSK_KEY = SYNTHETIC_KEY("deepseek");
/** 第二条目的合成 key（脱敏套件用）。 */
export const DSK_KEY_B = SYNTHETIC_KEY("deepseek-second");
/** 合成查询（含中文与引号，验证原查询逐字出现）。 */
export const DSK_QUERY = "synthetic deepseek query 合成查询 \"q\"";
/** 默认条目预算（毫秒）。 */
export const DSK_BUDGET_MS = 25000;
/** 真实 Promise 守卫：仅防挂起测试卡死，预算语义必须走 ctx.clock。 */
export const GUARD_MS = 3000;

/** FB-005 可降级条目码（不含终止类 CONTENT_POLICY）。 */
export const DEGRADABLE_CODES = Object.freeze(
  Object.values(C.ENTRY_CODES).filter((c) => c !== C.ENTRY_CODES.CONTENT_POLICY),
);

// ─── 加载与上下文（S1..S2）─────────────────────────────────────────────────

function pickBackend(mod, type) {
  if (mod.deepseekBackends && typeof mod.deepseekBackends === "object") {
    for (const [k, v] of Object.entries(mod.deepseekBackends)) {
      if (k === type && v && typeof v.search === "function") return v;
    }
  }
  if (type === "deepseek-search" && mod.deepseekSearchBackend) return mod.deepseekSearchBackend;
  if (type === "deepseek-agentic-search" && mod.deepseekAgenticSearchBackend)
    return mod.deepseekAgenticSearchBackend;
  const single = mod.deepseekBackend ?? mod.default;
  if (single && typeof single.search === "function") return single;
  const byKey = mod[type];
  if (byKey && typeof byKey.search === "function") return byKey;
  return null;
}

/**
 * 加载 DeepSeek 适配器某个模式的 search（模块缺失时按 impl.js 约定记红）。
 * @param {import("node:test").TestContext} t
 * @param {"deepseek-search"|"deepseek-agentic-search"} type
 * @param {string} clauses 条款编号，如 "DSK-003 请求"
 */
export async function loadDeepseek(t, type, clauses) {
  assert.ok(["deepseek-search", "deepseek-agentic-search"].includes(type), `未知 DeepSeek 类型: ${type}`);
  const res = await tryImportSrc("backends/deepseek.js");
  failIfUnimplemented(t, res, WP_DEEPSEEK, clauses);
  const backend = pickBackend(res.module, type);
  assert.ok(
    backend,
    `${clauses}: src/backends/deepseek.js 须按 S1 任一形状提供 entry.type="${type}" 的 Backend` +
      `（{ type, search(ctx) }，A5；oracle 假设见 helpers/deepseek-oracle.js 头注 S1）`,
  );
  if (backend.type !== undefined) {
    assert.equal(typeof backend.type, "string", `Backend.type 若存在须为字符串（A5），实际：${typeof backend.type}`);
    assert.ok(
      String(backend.type).startsWith("deepseek"),
      `Backend.type 须为 deepseek* 之一（A5/S2），实际：${backend.type}`,
    );
  }
  return { search: (ctx) => backend.search(ctx) };
}

/**
 * 构造 A5 ctx（默认受控时钟 + 未声明即抛错的假 fetch）。
 * maxResults 未指定时整体省略字段；key 显式传 undefined 保持缺失。
 */
export function makeCtx(overrides = {}) {
  const clock = overrides.clock ?? createControlledClock();
  const fetch = overrides.fetch ?? createFakeFetch({ default: "never", clock });
  const entry = C.makeEntry({
    id: overrides.entryId ?? "dsk-entry-1",
    type: overrides.type ?? "deepseek-search",
    name: overrides.name ?? "DeepSeek 合成条目",
    enabled: true,
  });
  const ctx = {
    entry,
    query: overrides.query ?? DSK_QUERY,
    key: "key" in overrides ? overrides.key : DSK_KEY,
    fetch,
    budgetMs: overrides.budgetMs ?? DSK_BUDGET_MS,
    signal: overrides.signal ?? new AbortController().signal,
    clock,
    log: overrides.log ?? (() => {}),
  };
  if (overrides.maxResults !== undefined) ctx.maxResults = overrides.maxResults;
  return { ctx, clock, fetch };
}

/** 一次调用内对两种模式各执行一次 search（共用面共用工厂）。 */
export async function runBothModes(t, clauses, fn) {
  for (const type of ["deepseek-search", "deepseek-agentic-search"]) {
    const backend = await loadDeepseek(t, type, `${clauses}（${type}）`);
    await fn(backend, type);
  }
}

/** 按 entry.type 选择端点常量。 */
export function endpointOf(type) {
  return type === "deepseek-agentic-search" ? DSK_AGENTIC_ENDPOINT : DSK_SEARCH_ENDPOINT;
}

/** 为 entry.type 对应端点声明响应路由。 */
export function routeFor(fetch, type, spec) {
  fetch.when(endpointOf(type)).responds(spec);
}

/** 为 entry.type 对应端点声明挂起路由。 */
export function hangFor(fetch, type) {
  fetch.when(endpointOf(type)).hangs();
}

/** 把 {status, contentType, body} 样本路由到 entry.type 端点。 */
export function routeFromResponse(fetch, type, response) {
  routeFor(fetch, type, {
    status: response.status,
    body: response.body,
    headers: { "content-type": response.contentType },
  });
}

// ─── 出站断言 ──────────────────────────────────────────────────────────────

/** 恰好一次出站（FB-001 每条目最多一次 + 条款「一次 POST」），返回该记录。 */
export function singleCall(fetch, type, label = "DeepSeek 请求") {
  const calls = fetch.callsFor(endpointOf(type));
  assert.equal(
    calls.length,
    1,
    `${label}：必须恰好一次 POST 到 ${endpointOf(type)}（FB-001 每条目最多一次 + DSK 条款「一次 POST」）；实际共 ${fetch.count()} 次`,
  );
  return calls[0];
}

/** 解析请求正文 JSON（须为字符串）。 */
export function bodyOf(call) {
  assert.equal(typeof call.init.body, "string", "请求正文须为 JSON 字符串");
  return JSON.parse(call.init.body);
}

/** 断言方法 POST + 端点精确 + 无查询串（key 只进鉴权头）。 */
export function assertEndpoint(call, type) {
  assert.equal(call.method, "POST", "必须使用 POST（DSK-001/DSK-003）");
  const u = new URL(call.url);
  assert.equal(`${u.origin}${u.pathname}`, endpointOf(type), `端点必须为 ${endpointOf(type)}（DSK 规格字面）`);
  assert.equal(u.search, "", "端点不得带查询串（CFG-003：key 只进鉴权头）");
}

/** Bearer 鉴权头 = "Bearer " + ctx.key（DSK-003 明文；DSK-001 形状见 pending P1）。 */
export function assertBearerAuth(call, key = DSK_KEY) {
  assert.equal(
    call.headers.authorization,
    `Bearer ${key}`,
    "鉴权头须为 Authorization: Bearer <ctx.key>（DSK-003 明文；两模式共用 DeepSeek key 约定）",
  );
}

/** 128 字符 BMP 查询（按「Unicode 字符」计量，长度=码点）。 */
export function queryChars(n) {
  return "合".repeat(n);
}

// ─── Agentic Search（DSK-001/DSK-002）请求辅助 ─────────────────────────────

/**
 * 收集请求体中的任务文本（推断载体：body.system 字符串或 text 块数组、messages[].content
 * 字符串或 {type:"text",text} 块数组）。找不到载体返回 []，由断言指向 pending P2。
 */
export function collectAgenticTaskText(body) {
  const parts = [];
  const pushContent = (content) => {
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const p of content) if (p && typeof p === "object" && typeof p.text === "string") parts.push(p.text);
    }
  };
  pushContent(body?.system);
  if (Array.isArray(body?.messages)) for (const m of body.messages) pushContent(m?.content);
  return parts;
}

/** 关闭思考的指示是否存在（推断集合，规范载体见 pending P3）。 */
export function thinkingDisabledIndicated(body) {
  if (body.thinking && typeof body.thinking === "object" && body.thinking.type === "disabled") return true;
  if (body.thinking === false) return true;
  if (body.thinking_enabled === false) return true;
  if (body.reasoning_effort === "none" || body.reasoning === "disabled") return true;
  return false;
}

// ─── Agentic Search 响应样本（结构对齐规格来源：Anthropic Messages 服务端搜索形状）──

/** web_search_result 结果项（snippet 可缺省）。 */
export function dsSearchResult(i, overrides = {}) {
  const base = {
    type: "web_search_result",
    url: `https://ds-sample.invalid/agent/doc/${i}`,
    title: `合成搜索结果 ${i}`,
    snippet: `合成搜索结果摘要 ${i}`,
  };
  const merged = { ...base, ...overrides };
  return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
}

/** 结果块：{type:"web_search_tool_result", tool_use_id, content:[...]}。 */
export function dsToolResultBlock(content, toolUseId = "srvtoolu_synth_1") {
  return { type: "web_search_tool_result", tool_use_id: toolUseId, content };
}

/** 空数组结果块（DSK-002「搜索结果块明确返回空数组」）。 */
export function dsEmptyResultBlock(toolUseId = "srvtoolu_synth_1") {
  return dsToolResultBlock([], toolUseId);
}

/** 工具错误块（HTTP 200 内；DSK-002 要求识别）。 */
export function dsToolErrorBlock(errorCode, toolUseId = "srvtoolu_synth_1") {
  return { type: "web_search_tool_result_error", tool_use_id: toolUseId, error_code: errorCode };
}

/** 服务端工具调用块（正常样本前置，非结果来源）。 */
export function dsServerToolUseBlock(query = DSK_QUERY, toolUseId = "srvtoolu_synth_1") {
  return { type: "server_tool_use", id: toolUseId, name: "web_search", input: { queries: [query] } };
}

/** 模型正文块（含裸链接：DSK-002「生成的回答和裸链接不得构造成来源」）。 */
export function dsTextBlock(
  text = "合成模型回答。裸链接 https://ds-bare-link.invalid/should-not-be-source 不得成为来源。",
) {
  return { type: "text", text };
}

/** 完整 Agentic 成功响应（含服务端搜索用量计数，形状对齐规格来源「服务端工具用量」）。 */
export function agenticOk(blocks, extra = {}) {
  return {
    id: "msg_synth_ds_1",
    type: "message",
    role: "assistant",
    model: DSK_MODEL,
    content: blocks,
    usage: { input_tokens: 120, output_tokens: 48, server_tool_use: { web_search_requests: 1 } },
    ...extra,
  };
}

/** 三结果块的正常样本（顺序基准）。 */
export function agenticThreeResults() {
  return agenticOk([
    dsServerToolUseBlock(),
    dsToolResultBlock([dsSearchResult(1), dsSearchResult(2), dsSearchResult(3)]),
    dsTextBlock(),
  ]);
}

/** 仅模型正文、未触发工具（DSK-002：通道失败，非正常空结果）。 */
export function agenticNoTool(text = "合成正文，没有触发任何搜索工具。") {
  return agenticOk([dsTextBlock(text)]);
}

// ─── Search API（DSK-003/DSK-004）响应样本 ─────────────────────────────────

/** 独立 Search API 结果项；date→publishedAt（DSK-004 明文）；site_name/icon 为必丢弃字段。 */
export function dsApiResult(i, overrides = {}) {
  const base = {
    url: `https://ds-sample.invalid/api/doc/${i}`,
    title: `合成搜索结果 ${i}`,
    snippet: `合成摘要 ${i}`,
    summary: `合成总结 ${i}`,
    date: `2026-01-0${(i % 9) + 1}T00:00:00Z`,
    site_name: `synthetic-site-${i}.invalid`,
    icon: `https://ds-sample.invalid/favicon/${i}.ico`,
  };
  const merged = { ...base, ...overrides };
  return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
}

/** 成功响应包装。 */
export function dsApiOk(results, extra = {}) {
  return { request_id: "req-synthetic-ds-1", results, ...extra };
}

/** 期望映射后的来源（A2：不新增 per-source 供应商字段；缺省字段省略）。 */
export function expectedApiSource(r) {
  return Object.fromEntries(
    Object.entries({
      url: r.url,
      ...(r.title !== undefined ? { title: r.title } : {}),
      ...(r.snippet !== undefined ? { snippet: r.snippet } : {}),
      ...(r.summary !== undefined ? { summary: r.summary } : {}),
      ...(r.date !== undefined ? { publishedAt: r.date } : {}),
    }).filter(([, v]) => v !== undefined),
  );
}

// ─── 通用辅助 ──────────────────────────────────────────────────────────────

/** 复用已登记 upstream/http-outcomes.json（去掉 Tavily 专属 432 通道样本）。 */
export function sharedUpstreamOutcomes() {
  return loadFixture(FIXTURE_NAMES.upstreamErrors).outcomes.filter((o) => o.id !== "channel-limit-tavily-432");
}

/** 5xx 合成样本（FB-005 未列 5xx 具体码；只断言可降级，同族先例 TODO-EXA-7）。 */
export const DSK_SERVER_ERRORS = Object.freeze([
  {
    id: "server-500",
    response: {
      status: 500,
      contentType: "application/json",
      body: { error: { type: "internal_server_error", message: "synthetic internal error" } },
    },
  },
  {
    id: "server-503",
    response: { status: 503, contentType: "text/plain", body: "synthetic service unavailable" },
  },
]);

/** 去掉 undefined 值键，便于 deepEqual 不误伤「缺字段」语义。 */
export function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** 归一化适配器返回的 sources。 */
export function normalizeSources(sources) {
  assert.ok(Array.isArray(sources), "适配器须 resolve 出 sources 数组（A5）");
  return sources.map(stripUndefined);
}

/** promise → { ok, value|error }。 */
export async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 等待失败并返回错误；成功则测试失败。 */
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

/** 条目级失败形状：code ∈ ENTRY_CODES + 非空可操作 message。 */
export function assertEntryError(err, code) {
  assert.ok(err && typeof err === "object", "失败须以错误对象抛出");
  assert.ok(Object.values(C.ENTRY_CODES).includes(err.code), `失败码须属于 ENTRY_CODES（A5/FB-005），实际：${err.code}`);
  assert.equal(err.code, code, `分类码须为 ${code}（FB-005/DSK 条款），实际：${err.code}`);
  assert.equal(typeof err.message, "string", "错误 message 须为文本");
  assert.ok(err.message.length > 0, "错误 message 须给出可操作原因（FB-005）");
}

/** 真实计时守卫（防挂起卡死；预算语义必须走 ctx.clock/signal）。 */
export async function withGuard(promise, why = "") {
  promise.catch(() => {});
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

export { createControlledClock };

/** A5 适配器结果形状：sources 必填数组，url 为绝对 HTTP(S)；content/truncated 若存在类型合规。
 *  注意：A4 中 truncated 为可选（截断责任推断归链级，pending P8），故此处不用 contract.assertSearchResult。 */
export function assertAdapterResultShape(t, out, label = "适配器结果") {
  assert.ok(out && typeof out === "object" && !Array.isArray(out), `${label}：必须 resolve 为对象`);
  assert.ok(Array.isArray(out.sources), `${label}：sources 必须是数组（A5）`);
  for (const [i, src] of out.sources.entries()) {
    assert.ok(src && typeof src === "object" && !Array.isArray(src), `${label}：sources[${i}] 必须是对象`);
    assert.equal(typeof src.url, "string", `${label}：sources[${i}].url 必须是字符串（A1）`);
    let u;
    try {
      u = new URL(src.url);
    } catch {
      assert.fail(`${label}：sources[${i}].url 必须是绝对 URL（FB-002）：${src.url}`);
    }
    assert.ok(u.protocol === "http:" || u.protocol === "https:", `${label}：sources[${i}].url 必须 HTTP(S)（FB-002）：${src.url}`);
    for (const k of ["title", "snippet", "summary", "publishedAt"]) {
      if (src[k] !== undefined) assert.equal(typeof src[k], "string", `${label}：sources[${i}].${k} 若存在须为字符串（A1）`);
    }
  }
  if (out.content !== undefined) assert.equal(typeof out.content, "string", `${label}：content 若存在须为字符串（A5）`);
  if (out.truncated !== undefined) assert.equal(typeof out.truncated, "boolean", `${label}：truncated 若存在须为布尔（A4 可选）`);
}
