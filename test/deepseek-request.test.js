// WP8 DeepSeek 适配器请求侧验收（docs/specs/draft/deepseek.md）。
// 全红：src/backends/deepseek.js 尚未实现，等待 WP8（impl.js failIfUnimplemented 诊断）。
// 覆盖条款：
//   DSK-001 Agentic Search 请求：一次 POST https://api.deepseek.com/anthropic/v1/messages；
//     鉴权；model=deepseek-flash；关闭思考（指示存在，载体见 pending P3）；max_tokens:256；
//     只声明 web_search_20250305 / name=web_search / max_uses:1；固定指令存在且跨查询不变；
//     只提交当前查询（单消息、逐字）；受 FB-003（取消断言见 deepseek-cancel）。
//   DSK-003 Search API 请求：一次 POST https://api.deepseek.com/v1/tools/search + Bearer key；
//     只发送原查询；need_content:false；count=min(maxResults,50)，未提供省略（非 null）；
//     查询超 128 Unicode 字符 → 长度限制且零出站，完整查询透传归链级（WP5）。
//   FB-001：缺 key（undefined/空白）适配器级零出站且拒绝（S4）。
// 待办：helpers/deepseek-oracle.js 头注 S1..S7；test/deepseek-pending.test.js P1..P8。
import test from "node:test";
import assert from "node:assert/strict";
import { SYNTHETIC_KEY } from "./helpers/fake-fetch.js";
import {
  DSK_AGENTIC_ENDPOINT,
  DSK_BUDGET_MS,
  DSK_COUNT_CAP,
  DSK_KEY,
  DSK_MAX_TOKENS,
  DSK_MODEL,
  DSK_QUERY,
  DSK_SEARCH_ENDPOINT,
  DSK_TOOL,
  assertBearerAuth,
  agenticOk,
  assertEndpoint,
  bodyOf,
  collectAgenticTaskText,
  dsEmptyResultBlock,
  loadDeepseek,
  makeCtx,
  queryChars,
  routeFor,
  settle,
  singleCall,
  thinkingDisabledIndicated,
} from "./helpers/deepseek-oracle.js";

const AG = "deepseek-agentic-search";
const API = "deepseek-search";
const AG_OK = { status: 200, body: agenticOk([dsEmptyResultBlock()]) };
const API_OK = { status: 200, body: { results: [] } };

// ─── 共用面（两模式一致）────────────────────────────────────────────────────

test("DSK-001/DSK-003 共用：FB-001 缺 key（undefined/空串/纯空白）零出站且拒绝，错误不得带 ENTRY 额度/凭据伪装之外的断言", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `FB-001 缺 key 零出站（${type}）`);
    for (const key of [undefined, "", "   "]) {
      const { ctx, fetch } = makeCtx({ type, key });
      routeFor(fetch, type, type === API ? API_OK : AG_OK);
      const res = await settle(backend.search(ctx));
      assert.equal(fetch.count(), 0, `type=${type} key=${JSON.stringify(key)}：不得发出任何请求（FB-001 零出站）`);
      assert.equal(res.ok, false, `type=${type} key=${JSON.stringify(key)}：必须拒绝，不得返回结果（S4）`);
    }
  }
});

test("DSK-001/DSK-003 共用：key 只取 ctx.key，适配器不得改读进程环境变量 DEEPSEEK_API_KEY（CFG-002 解析在 A4 完成）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `key 来源（${type}）`);
    const { ctx, fetch } = makeCtx({ type });
    routeFor(fetch, type, type === API ? API_OK : AG_OK);
    const prev = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = SYNTHETIC_KEY("env-different");
    try {
      await backend.search(ctx);
    } finally {
      if (prev === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = prev;
    }
    assertBearerAuth(singleCall(fetch, type), DSK_KEY);
  }
});

test("DSK-001/DSK-003 共用：失败恰一次出站，不重试（FB-001 每条目最多一次）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `失败不重试（${type}）`);
    for (const spec of [
      { status: 500, body: { error: { type: "internal_server_error", message: "synthetic" } } },
      { status: 401, body: { error: { type: "authentication_error", message: "synthetic" } } },
    ]) {
      const { ctx, fetch } = makeCtx({ type });
      routeFor(fetch, type, spec);
      const res = await settle(backend.search(ctx));
      assert.equal(res.ok, false, `HTTP ${spec.status} 必须失败`);
      assert.equal(fetch.count(), 1, `HTTP ${spec.status} 后不得重试第二次（FB-001）`);
    }
  }
});

test("DSK-001/DSK-003 共用：方法 POST、端点精确、URL 无查询串（key 只进鉴权头）", async (t) => {
  for (const type of [API, AG]) {
    const backend = await loadDeepseek(t, type, `端点与方法（${type}）`);
    const { ctx, fetch } = makeCtx({ type });
    routeFor(fetch, type, type === API ? API_OK : AG_OK);
    await backend.search(ctx);
    assertEndpoint(singleCall(fetch, type), type);
    void 0;
  }
});

// ─── DSK-003 Search API 请求 ────────────────────────────────────────────────

test("DSK-003 请求：一次 POST https://api.deepseek.com/v1/tools/search 且 Authorization: Bearer <ctx.key>", async (t) => {
  const backend = await loadDeepseek(t, API, "DSK-003 请求");
  const { ctx, fetch } = makeCtx({ type: API });
  routeFor(fetch, API, API_OK);
  await backend.search(ctx);
  const call = singleCall(fetch, API, "DSK-003");
  assert.equal(call.url, DSK_SEARCH_ENDPOINT, "端点必须精确为规格字面（DSK-003）");
  assert.equal(call.method, "POST", "必须 POST（DSK-003）");
  assertBearerAuth(call);
});

test("DSK-003 请求体：query 逐字、need_content:false、键集合恰为 {query, need_content}（未指定 count 时省略，非 null）", async (t) => {
  const backend = await loadDeepseek(t, API, "DSK-003 请求体");
  const { ctx, fetch } = makeCtx({ type: API, query: DSK_QUERY });
  routeFor(fetch, API, API_OK);
  await backend.search(ctx);
  const body = bodyOf(singleCall(fetch, API));
  assert.equal(body.query, DSK_QUERY, "query 必须逐字等于当前查询（DSK-003「只发送原查询」）");
  assert.equal(body.need_content, false, "need_content 必须显式为 false（DSK-003）");
  assert.ok(!("count" in body), "宿主未提供 maxResults 时不得发送 count（DSK-003「采用服务默认值」，省略非 null）");
  assert.notEqual(body.count, null, "count 不得为 null");
  assert.deepEqual(Object.keys(body).sort(), ["need_content", "query"], "请求体键集合须逐字段符合 DSK-003");
});

test("DSK-003 count 边界：maxResults 3/50/51/60 → count 3/50/50/50（min 与 50 封顶）", async (t) => {
  const backend = await loadDeepseek(t, API, "DSK-003 count");
  for (const [maxResults, want] of [
    [3, 3],
    [DSK_COUNT_CAP, DSK_COUNT_CAP],
    [DSK_COUNT_CAP + 1, DSK_COUNT_CAP],
    [60, DSK_COUNT_CAP],
  ]) {
    const { ctx, fetch } = makeCtx({ type: API, maxResults });
    routeFor(fetch, API, API_OK);
    await backend.search(ctx);
    const body = bodyOf(singleCall(fetch, API));
    assert.equal(body.count, want, `maxResults=${maxResults} → count=${want}（DSK-003「取其与 50 中较小值」）`);
    assert.deepEqual(
      Object.keys(body).sort(),
      ["count", "need_content", "query"],
      `maxResults=${maxResults} 时键集合为 {query, need_content, count}`,
    );
  }
});

test("DSK-003 长度限制：查询超过 128 Unicode 字符 → 通道长度限制（ENTRY_CHANNEL_LIMIT）且零出站", async (t) => {
  const backend = await loadDeepseek(t, API, "DSK-003 长度限制");
  const { ctx, fetch } = makeCtx({ type: API, query: queryChars(129) });
  routeFor(fetch, API, API_OK);
  const res = await settle(backend.search(ctx));
  assert.equal(res.ok, false, "超 128 字符必须报告该条目失败（DSK-003）");
  assert.equal(res.error?.code, "ENTRY_CHANNEL_LIMIT", "长度限制属通道参数限制 ENTRY_CHANNEL_LIMIT（FB-005 类目；定名见 pending P5）");
  assert.equal(fetch.count(), 0, "超长查询不得发出请求（DSK-003 验收「独立接口无请求」）");
});

test("DSK-003 长度边界：恰 128 个 Unicode 字符的查询正常发出且逐字", async (t) => {
  const backend = await loadDeepseek(t, API, "DSK-003 长度边界");
  const q = queryChars(128);
  const { ctx, fetch } = makeCtx({ type: API, query: q });
  routeFor(fetch, API, API_OK);
  const res = await settle(backend.search(ctx));
  assert.equal(res.ok, true, "128 字符为合法上界，不得拒绝（DSK-003「超过…上限」）");
  assert.equal(bodyOf(singleCall(fetch, API)).query, q, "128 字符查询须逐字出站");
});

// ─── DSK-001 Agentic Search 请求 ────────────────────────────────────────────

test("DSK-001 请求：一次 POST https://api.deepseek.com/anthropic/v1/messages 并携带鉴权（Bearer 形状，见 P1）", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-001 请求");
  const { ctx, fetch } = makeCtx({ type: AG });
  routeFor(fetch, AG, AG_OK);
  await backend.search(ctx);
  const call = singleCall(fetch, AG, "DSK-001");
  assert.equal(call.url, DSK_AGENTIC_ENDPOINT, "端点必须精确为规格字面（DSK-001）");
  assert.equal(call.method, "POST", "必须 POST（DSK-001）");
  assertBearerAuth(call);
});

test("DSK-001 请求体：model=deepseek-flash、max_tokens=256（规格字面）", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-001 模型与预算");
  const { ctx, fetch } = makeCtx({ type: AG });
  routeFor(fetch, AG, AG_OK);
  await backend.search(ctx);
  const body = bodyOf(singleCall(fetch, AG));
  assert.equal(body.model, DSK_MODEL, "model 必须为 deepseek-flash（DSK-001）");
  assert.equal(body.max_tokens, DSK_MAX_TOKENS, "max_tokens 必须为 256（DSK-001）");
});

test("DSK-001 请求体：只声明 web_search_20250305 工具，name=web_search，max_uses:1（恰一个工具对象恰三字段）", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-001 工具声明");
  const { ctx, fetch } = makeCtx({ type: AG });
  routeFor(fetch, AG, AG_OK);
  await backend.search(ctx);
  const body = bodyOf(singleCall(fetch, AG));
  assert.ok(Array.isArray(body.tools) && body.tools.length === 1, "必须只声明一个工具（DSK-001「只声明」）");
  assert.deepEqual({ ...body.tools[0] }, { ...DSK_TOOL }, "工具对象须逐字段 = {type,name,max_uses}（DSK-001）");
});

test("DSK-001 请求体：关闭思考的指示必须存在（推断载体集，规范载体见 pending P3）", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-001 关闭思考");
  const { ctx, fetch } = makeCtx({ type: AG });
  routeFor(fetch, AG, AG_OK);
  await backend.search(ctx);
  const body = bodyOf(singleCall(fetch, AG));
  assert.ok(thinkingDisabledIndicated(body), "必须携带「关闭思考」指示（DSK-001；载体形状含糊归 pending P3）");
});

test("DSK-001 任务文本：messages 恰一条且逐字承载当前查询（「只提交当前查询」，推断恰一条，见 pending P2）", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-001 只提交当前查询");
  const { ctx, fetch } = makeCtx({ type: AG });
  routeFor(fetch, AG, AG_OK);
  await backend.search(ctx);
  const body = bodyOf(singleCall(fetch, AG));
  assert.ok(Array.isArray(body.messages) && body.messages.length === 1, "messages 须恰一条（只提交当前查询；P2）");
  const texts = collectAgenticTaskText({ messages: body.messages });
  assert.equal(texts.length, 1, `消息 content 必须承载文本（载体见 pending P2），实际载体数：${texts.length}`);
  assert.equal(texts[0], DSK_QUERY, "消息文本必须逐字等于当前查询且不含其它注入内容（DSK-001）");
});

test("DSK-001 固定指令：跨查询不变的指令存在且不同于查询（system 载体推断，见 pending P2）", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-001 固定指令");
  const queries = ["首次合成查询 alpha", "二次合成查询 beta"];
  const fixedByQuery = [];
  for (const q of queries) {
    const { ctx, fetch } = makeCtx({ type: AG, query: q });
    routeFor(fetch, AG, AG_OK);
    await backend.search(ctx);
    const body = bodyOf(singleCall(fetch, AG));
    const all = collectAgenticTaskText(body);
    assert.ok(all.length >= 2, `任务文本须同时含固定指令与查询两个部分（DSK-001），实际：${all.length}`);
    assert.ok(all.some((p) => p === q || p.includes(q)), `文本中必须逐字包含当前查询「${q}」（DSK-001）`);
    fixedByQuery.push(all.filter((p) => p !== q && !p.includes(q)).join("\n"));
  }
  assert.ok(fixedByQuery[0].length > 0, "必须存在「固定指令」文本要求模型执行本次查询（DSK-001）");
  assert.equal(fixedByQuery[0], fixedByQuery[1], "固定指令须跨查询不变（DSK-001「固定指令」）");
});

test("DSK-001 请求预算入参：ctx.budgetMs 存在时不阻塞、不额外出站（FB-003 取消/中止面见 deepseek-cancel）", async (t) => {
  const backend = await loadDeepseek(t, AG, "DSK-001 FB-003 预算入参");
  const { ctx, fetch } = makeCtx({ type: AG, budgetMs: DSK_BUDGET_MS });
  routeFor(fetch, AG, AG_OK);
  const res = await settle(backend.search(ctx));
  assert.equal(res.ok, true, "有预算有响应时必须正常完成");
  assert.equal(fetch.count(), 1, "单次尝试不得多出请求（FB-003 涵盖请求）");
});
