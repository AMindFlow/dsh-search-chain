// WP8 DeepSeek 规格含糊待办断言（唯一集中处；条款深读见 docs/specs/draft/deepseek.md）。
// 全红：src/backends/deepseek.js 尚未实现，等待 WP8。
// 本文件规则（同族先例：WP2 openai-pending、WP10 brave pending）：
//   - 规格未写死的行为按最合理推断写成可执行断言，每条以 P 编号 + 推断理由标注；
//   - 主套件只断言规格明确（或推断极稳）的部分；若 dev 的合理实现与本文件冲突，
//     以回写规格后的裁决为准，不得反向弱化主套件；
//   - CAT-001 的编辑页字段联动与计费说明、DSK-001/DSK-003「用户配置说明须注明…」是设置面板/文档
//     展示面（settings-ui，WP12），不在适配器测试内断言（同族先例 TODO-EXA-10）。
//
// ─── P 编号清单（推断 + 待裁决点）───────────────────────────────────────────
// P1 Agentic Search 的鉴权载体。deepseek.md 只在 DSK-003 写明「Bearer key」，DSK-001 仅说「核对鉴权」，
//    且端点是 DeepSeek 域名（非 Anthropic 官方）。推断：两模式同一 DeepSeek key 约定，
//    Authorization: Bearer <ctx.key>（主套件 DSK-001 已按此断言）。待裁决：Anthropic 风格
//    x-api-key + anthropic-version 头是否允许/必需（允许则主套件需放宽）。
// P2 DSK-001「只提交当前查询」的载体。推断：messages 恰一条 {role:"user"}、逐字=查询；固定指令走
//    顶层 system。待裁决：指令拼入 user 文本（messages 仍 1 条）也可行；若实现采用多消息承载则
//    主套件「恰一条」需按裁决放宽。
// P3 DSK-001「关闭思考」的协议字段。DeepSeek 思考开关公开形状为 {type:"disabled"} 的 thinking 对象；
//    anthropic/messages 变体的确切载体未在规格给出。推断：body.thinking.type==="disabled"。
//    主套件仅要求「存在关闭指示」（helpers thinkingDisabledIndicated 容错集）。
//    待裁决：若 DeepSeek 接受省略字段表示默认关闭，允许字段缺省需回写规格后调整主套件。
//    思考关闭与 token 计费口径（DSK-001「输入输出按 token 计费」）属配置说明文案（WP12/文档面），不在适配器断言。
// P4 DSK-002 in-band 工具错误码除 too_many_requests→限流外的细分。规格只点名 too_many_requests，
//    并说「认证、额度、限流、内容拒绝…按降级规格」。推断：通用错误码（tool_exec_timeout、
//    invalid_tool_input 等）无法映射到更具体类目时归 ENTRY_BAD_RESPONSE（通道异常响应）。
//    主套件只要求可降级；本文件锁推断值。
// P5 DSK-003 超长查询的条目码定名。FB-005 类目「通道参数限制」的契约常量名。推断：ENTRY_CHANNEL_LIMIT
//    （主套件 DSK-003 已按此名断言）；本文件断言其与 helpers/contract.js ENTRY_CODES.CHANNEL_LIMIT 一致。
//    「下一条收到完整原查询」属链级（FB-001/WP5）：适配器不得改写 query —— 本文件以 127 字符查询 +
//    超长对照验证透传（适配器级可证部分）。
// P6 DSK-002「只有模型回答而未触发工具」的条目码。规格定性为通道失败（非正常空结果），未给细分。
//    推断：属「结果结构无效」→ ENTRY_BAD_RESPONSE（与畸形块同码；主套件已按此断言）。
//    与 DSK-004「非空数组没有有效 URL→BAD_RESPONSE」对称，符合 FB-005「异常响应」类目。
// P7 Agentic 模式两 mode 语义收口：适配器对「有搜索结果块」的响应只产出 sources（FB-002 纯来源，
//    主套件已断言 content 缺省）。另锁一个模型拒绝形状：DeepSeek 服务端搜索通道无显式内容拒绝码，
//    模型拒绝按「只有模型回答」类失败处理，不得伪装成正常空结果或 content 透传。
// P8 FB-002 截断责任与 truncated 标志归属。规格写「插件须…超过 maxResults 保留前若干条并置
//    truncated」，未区分适配器 vs 链（WP5）。推断：适配器透传全部有效结果，链级统一截断并置
//    truncated；故主套件只断言前缀性，不断言适配器截断/标志。待裁决：若裁决为适配器截断，
//    本文件的「透传」断言需反转。
// ──────────────────────────────────────────────────────────────────────────────
import test from "node:test";
import assert from "node:assert/strict";
import { ENTRY_CODES, TOOL_TYPES, supplierOfToolType } from "./helpers/contract.js";
import { createFakeFetch } from "./helpers/fake-fetch.js";
import {
  DSK_AGENTIC_ENDPOINT,
  DSK_KEY,
  WP_DEEPSEEK,
  agenticNoTool,
  agenticOk,
  bodyOf,
  dsApiOk,
  dsSearchResult,
  dsToolErrorBlock,
  dsEmptyResultBlock,
  dsToolResultBlock,
  loadDeepseek,
  makeCtx,
  queryChars,
  routeFor,
  settle,
  singleCall,
} from "./helpers/deepseek-oracle.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";

const AG = "deepseek-agentic-search";
const API = "deepseek-search";

test("P1 Agentic 鉴权载体：Authorization: Bearer <key>（推断：两模式共用 DSK-003 Bearer 约定；Anthropic 风格头待裁决）", async (t) => {
  const backend = await loadDeepseek(t, AG, "P1 Agentic 鉴权载体");
  const { ctx, fetch } = makeCtx({ type: AG });
  routeFor(fetch, AG, { status: 200, body: agenticOk([dsEmptyResultBlock()]) });
  await backend.search(ctx);
  const call = singleCall(fetch, AG, "P1");
  assert.equal(call.headers.authorization, `Bearer ${DSK_KEY}`, "P1：Bearer 形状（主套件同断言，此处锁定待裁决点）");
  assert.equal(call.headers["x-api-key"], undefined, "P1：不得同时发明 x-api-key 双通道（裁决前单载体）");
});

test("P2 DSK-001 载体：messages 恰一条 user 消息，固定指令在顶层 system（推断载体，待裁决可放宽）", async (t) => {
  const backend = await loadDeepseek(t, AG, "P2 消息载体");
  const { ctx, fetch } = makeCtx({ type: AG, query: "P2 合成查询" });
  routeFor(fetch, AG, { status: 200, body: agenticOk([dsEmptyResultBlock()]) });
  await backend.search(ctx);
  const body = bodyOf(singleCall(fetch, AG));
  assert.equal(body.messages.length, 1, "P2：恰一条消息（只提交当前查询的最紧载体）");
  assert.equal(body.messages[0].role, "user", "P2：消息角色为 user（Anthropic messages 约定）");
  assert.ok(typeof body.system === "string" && body.system.length > 0, "P2：固定指令走顶层 system（载体推断）");
});

test("P3 DSK-001 关闭思考载体：body.thinking.type === \"disabled\"（DeepSeek thinking 开关形状推断）", async (t) => {
  const backend = await loadDeepseek(t, AG, "P3 关闭思考载体");
  const { ctx, fetch } = makeCtx({ type: AG });
  routeFor(fetch, AG, { status: 200, body: agenticOk([dsEmptyResultBlock()]) });
  await backend.search(ctx);
  const body = bodyOf(singleCall(fetch, AG));
  assert.deepEqual(body.thinking, { type: "disabled" }, "P3：thinking:{type:\"disabled\"}（载体含糊，规范形状待裁决）");
});

test("P4 DSK-002 in-band 通用工具错误码 → ENTRY_BAD_RESPONSE（推断：无法细分时按通道异常响应）", async (t) => {
  const backend = await loadDeepseek(t, AG, "P4 in-band 通用错误码");
  const { ctx, fetch } = makeCtx({ type: AG });
  routeFor(fetch, AG, { status: 200, body: agenticOk([dsToolErrorBlock("tool_exec_timeout")]) });
  const res = await settle(backend.search(ctx));
  assert.equal(res.ok, false, "P4：工具错误必须失败（DSK-002）");
  assert.equal(res.error?.code, ENTRY_CODES.BAD_RESPONSE, "P4：通用错误码按异常响应类目（FB-005 推断）");
});

test("P5 DSK-003 超长条目码定名：ENTRY_CHANNEL_LIMIT 与契约常量同源；127 字符对照证明查询透传不改写", async (t) => {
  assert.equal(ENTRY_CODES.CHANNEL_LIMIT, "ENTRY_CHANNEL_LIMIT", "P5：契约常量定名（contract.js A7 同值）");
  const backend = await loadDeepseek(t, API, "P5 通道限制定名");
  const q = queryChars(127);
  const { ctx, fetch } = makeCtx({ type: API, query: q });
  routeFor(fetch, API, { status: 200, body: dsApiOk([]) });
  const res = await settle(backend.search(ctx));
  assert.equal(res.ok, true, "P5：127 字符必须放行（对照上限）");
  assert.equal(bodyOf(singleCall(fetch, API)).query, q, "P5：适配器不得截断/改写查询（「下一条收到完整原查询」把改写责任排除在条目级之外）");
});

test("P6 DSK-002 无工具触发 → ENTRY_BAD_RESPONSE（推断：非正常空结果，与畸形块同码）", async (t) => {
  const backend = await loadDeepseek(t, AG, "P6 无工具触发定码");
  const { ctx, fetch } = makeCtx({ type: AG });
  routeFor(fetch, AG, { status: 200, body: agenticNoTool("合成正文：我无法回答这类问题，且未触发搜索。") });
  const res = await settle(backend.search(ctx));
  assert.equal(res.ok, false, "P6：未触发工具即失败（DSK-002）");
  assert.equal(res.error?.code, ENTRY_CODES.BAD_RESPONSE, "P6：归异常响应类目（推断，见文件头 P6）");
  assert.notEqual(res.error?.code, ENTRY_CODES.CONTENT_POLICY, "P6：无显式内容拒绝载体时不得伪装 CONTENT_POLICY（终止类误伤降级）");
});

test("P7 两 mode 语义收口：同模块双模式；成功响应不产出 content；模型拒绝不得成正常空结果", async (t) => {
  const res = await tryImportSrc("backends/deepseek.js");
  failIfUnimplemented(t, res, WP_DEEPSEEK, "P7 两 mode 语义");
  const exportedTypes = Object.values(res.module)
    .filter((v) => v && typeof v === "object" && typeof v.search === "function" && typeof v.type === "string")
    .map((v) => v.type);
  const mapKeys = res.module.deepseekBackends ? Object.keys(res.module.deepseekBackends) : [];
  const served = new Set([...exportedTypes, ...mapKeys]);
  for (const type of TOOL_TYPES.filter((x) => supplierOfToolType(x) === "deepseek")) {
    assert.ok(
      served.size === 0 || served.has(type) || served.has("deepseek"),
      `P7：模块须能服务 entry.type=${type}（S1 任一形状；type 标记若存在须覆盖两模式）`,
    );
  }
  // 成功响应无 content（主套件已锁）+ 模型拒绝（无工具触发）仍为失败，两者状态不同。
  const ag = await loadDeepseek(t, AG, "P7 拒绝形态");
  const { ctx, fetch } = makeCtx({ type: AG });
  routeFor(fetch, AG, { status: 200, body: agenticNoTool("抱歉，合成模型拒绝，未执行搜索。") });
  const refusal = await settle(ag.search(ctx));
  assert.equal(refusal.ok, false, "P7：模型拒绝/未搜索不是正常空结果（DSK-002）");
});

test("P8 FB-002 截断责任：适配器透传全部有效来源（推断：链级统一截断并置 truncated；若裁决相反本断言反转）", async (t) => {
  const backend = await loadDeepseek(t, API, "P8 透传截断责任");
  const results = [dsSearchResult(1), dsSearchResult(2), dsSearchResult(3)];
  const fake = createFakeFetch({ default: "never" });
  fake.when("https://api.deepseek.com/v1/tools/search").responds({ status: 200, body: dsApiOk(results) });
  const { ctx } = makeCtx({ type: API, maxResults: 2, fetch: fake });
  const res = await settle(backend.search(ctx));
  assert.equal(res.ok, true, "P8：maxResults 小于上游条数不得是适配器错误");
  assert.equal(res.value.sources.length, 3, "P8：适配器透传 3 条（链级 WP5 依 FB-002 截断并置 truncated）");
});
