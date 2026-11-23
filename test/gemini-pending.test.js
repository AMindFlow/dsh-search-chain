// WP11 Gemini 待办断言（规格含糊处的唯一集中位置）。
//
// 每条以 P 编号标识，并写明「推断」来源。规格（gemini.md 及引用的 FB/CFG/DSH）未写明这些点，
// oracle 选定一种合理解释并在此断言。若规格确认了不同行为，应先改 docs/specs 草案（经审阅），
// 再改本文件对应断言；不得为通过实现而删除或放宽断言。
//
// 与 gemini-*.test.js 的分工：那些文件只断言规格字面写明的条款；歧义只在本文件。
// 红属预期：src/backends/gemini.js 尚未实现（WP11）。
//
// 待办清单（与 PR 描述一致）：
//   P-01 请求 body 字段名与 model：input 为查询字符串，model 为 gemini- 前缀（Interactions 文档，推断）
//   P-02 生成参数：未指定则省略，不得出现 null 或生成参数键（推断：规格未给生成参数）
//   P-03 tools 仅声明 google_search 一项（推断：规格只要求启用该服务端工具）
//   P-04 Content-Type 为 application/json（推断：JSON body 的标准头）
//   P-05 content 语义：sources-only，不把模型正文作为 content（推断：GMI-002 禁止上游 HTML，且未定义 Gemini 展示通道）
//   P-06 snippet 不从正文段落推导（推断：规格未定义 Gemini snippet 路径）
//   P-07 同一 URL 只保留第一次出现（推断：对齐 OAI-002 的去重约定）
//   P-08 有引用但全部无效 → ENTRY_BAD_RESPONSE（推断：对齐 FB-005 异常响应与 OAI-003）
//   P-09a 有搜索证据且零引用 → 成功且 sources: []（推断：对齐 FB-004 明确无结果）
//   P-09b 无搜索证据（无 google_search_* 步骤）→ ENTRY_BAD_RESPONSE（推断：GMI-001「缺少该证据…按降级」，选失败而非空结果）
//   P-10a status=failed 无安全原因 → ENTRY_BAD_RESPONSE（推断：FB-005 异常响应）
//   P-10b 内容安全拦截 → ENTRY_CONTENT_POLICY（推断：FB-001 明确的上游内容策略拒绝为终止类；拦截体形状未在规格中写明）
//   P-11 429 + RESOURCE_EXHAUSTED + 配额文本 → ENTRY_QUOTA（推断：额度语义；与 FB-005 字面「其他 429 属限流」冲突，见歧义清单）
//   P-12 5xx → ENTRY_BAD_RESPONSE（推断：FB-005 异常响应；规格未给 5xx 映射）
//   P-13 预算为 0 时拒绝且码为 ENTRY_TIMEOUT（推断：FB-005 单项超时；零出站由 gemini-budget 硬断言覆盖）
//   P-14 宿主取消的错误 name 为 AbortError（推断：fetch 取消惯例；硬断言只要求不带 ENTRY 码）
import test from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_ROUTE,
  DEFAULT_QUERY,
  SRC_A,
  SRC_B,
  ENTRY_CODE_SET,
  urlCitation,
  outputsResponse,
  groundedOutputs,
  newRig,
  startSearch,
  settle,
  expectRejected,
  expectCode,
  gemCalls,
  bodyOf,
  urlTitle,
  loadGeminiBackend,
} from "./helpers/gemini-oracle.js";
import { flush } from "./helpers/clock.js";
import { ENTRY_CODES } from "./helpers/contract.js";

const GENERATION_KEYS = [
  "generation_config",
  "generationConfig",
  "temperature",
  "top_p",
  "top_k",
  "max_output_tokens",
  "max_tokens",
  "response_format",
];

/** 深度遍历，找出值为 null 的路径（P-02）。 */
function nullPaths(node, where = "$", out = []) {
  if (node === null) out.push(where);
  else if (Array.isArray(node)) node.forEach((v, i) => nullPaths(v, `${where}[${i}]`, out));
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) nullPaths(v, `${where}.${k}`, out);
  return out;
}

test("P-01（推断）：body.input 为查询字符串，body.model 为 gemini- 前缀的非空字符串", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-001 / P-01");
  const rig = newRig({ query: DEFAULT_QUERY });
  rig.fetch.when(GEMINI_ROUTE).responds({ body: groundedOutputs() });
  await settle(rig, startSearch(backend, rig));
  const [call] = gemCalls(rig.fetch);
  const body = bodyOf(call);
  assert.equal(body.input, DEFAULT_QUERY, "P-01：input 字段须为查询字符串逐字（推断字段名 input）");
  assert.equal(typeof body.model, "string", "P-01：model 须为字符串（规格未写默认模型，推断为 model 字段）");
  assert.match(body.model, /^gemini-/, "P-01：model 须为 gemini- 前缀的 Gemini 模型（GMI-001 要求支持 grounding 的模型）");
});

test("P-02（推断）：未指定的生成参数省略，body 中不出现 null 或生成参数键", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-001 / P-02");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({ body: groundedOutputs() });
  await settle(rig, startSearch(backend, rig));
  const [call] = gemCalls(rig.fetch);
  const body = bodyOf(call);
  assert.deepEqual(nullPaths(body), [], "P-02：未指定的字段必须省略而非 null（推断）");
  for (const key of GENERATION_KEYS) {
    assert.ok(!(key in body), `P-02：规格未指定生成参数，不得发送 ${key}（推断）`);
  }
});

test("P-03（推断）：tools 仅声明一项，type 为 google_search", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-001 / P-03");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({ body: groundedOutputs() });
  await settle(rig, startSearch(backend, rig));
  const body = bodyOf(gemCalls(rig.fetch)[0]);
  assert.ok(Array.isArray(body.tools), "P-03：tools 须为数组");
  assert.equal(body.tools.length, 1, "P-03：规格只要求 google_search，不声明其他工具（推断）");
  assert.equal(body.tools[0].type, "google_search", "P-03：唯一工具须为 google_search");
});

test("P-04（推断）：请求 Content-Type 为 application/json", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-001 / P-04");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({ body: groundedOutputs() });
  await settle(rig, startSearch(backend, rig));
  const [call] = gemCalls(rig.fetch);
  assert.match(String(call.headers["content-type"] ?? ""), /application\/json/, "P-04：JSON body 须声明 application/json（推断）");
});

test("P-05（推断）：Gemini 为 sources-only，成功返回不带 content（模型正文不作为通用 content）", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-002 / P-05");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({ body: groundedOutputs() });
  const outcome = await settle(rig, startSearch(backend, rig));
  assert.equal(outcome.ok, true, "P-05：成功样本应成功");
  assert.equal(
    outcome.value.content,
    undefined,
    "P-05：GMI-002 未定义展示通道前，Gemini 不得把模型正文作为 content（FB-002 sources-only 约定，推断）",
  );
});

test("P-06（推断）：来源不带 snippet（规格未定义 Gemini 摘要路径，不从正文推导）", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-002 / P-06");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({ body: groundedOutputs() });
  const outcome = await settle(rig, startSearch(backend, rig));
  assert.equal(outcome.ok, true, "P-06：成功样本应成功");
  for (const [i, s] of outcome.value.sources.entries()) {
    assert.equal(s.snippet, undefined, `P-06：sources[${i}] 不得推导 snippet（推断）`);
  }
});

test("P-07（推断）：同一 URL 只保留第一次出现的来源（标题取首次）", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-002 / P-07");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({
    body: outputsResponse({
      annotations: [
        urlCitation(SRC_A),
        urlCitation({ url: SRC_A.url, title: "同一 URL 的另一标题" }),
        urlCitation(SRC_B),
      ],
    }),
  });
  const outcome = await settle(rig, startSearch(backend, rig));
  assert.equal(outcome.ok, true, "P-07：应成功");
  assert.deepEqual(urlTitle(outcome.value.sources), [SRC_A, SRC_B], "P-07：同一 URL 去重，保留首次出现（推断，对齐 OAI-002）");
});

test("P-08（推断）：有引用但全部无效 → ENTRY_BAD_RESPONSE（不是空结果）", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-005 / P-08");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({
    body: outputsResponse({
      annotations: [
        { type: "url_citation", url: "ftp://bad.synthetic-host.invalid/x", title: "非 HTTP" },
        { type: "url_citation", url: "not a url", title: "不可解析" },
      ],
    }),
  });
  const outcome = await settle(rig, startSearch(backend, rig));
  const err = expectRejected(outcome, "P-08 全部引用无效");
  expectCode(err, ENTRY_CODES.BAD_RESPONSE, "P-08 全部引用无效（推断，对齐 OAI-003 与 FB-005 异常响应）");
});

test("P-09a（推断）：有搜索证据但零引用 → 成功且 sources 为空数组（明确无结果，FB-004）", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-004 / P-09a");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({ body: outputsResponse({ annotations: [] }) });
  const outcome = await settle(rig, startSearch(backend, rig));
  assert.equal(outcome.ok, true, "P-09a：搜索完成但无引用应为明确无结果，不是错误（FB-004，推断）");
  assert.deepEqual(outcome.value.sources, [], "P-09a：sources 必须为空数组");
});

test("P-09b（推断）：无任何搜索证据（只有模型文本）→ ENTRY_BAD_RESPONSE", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-001 / P-09b");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({
    body: outputsResponse({ withSearch: false, text: "只有模型文本", annotations: [] }),
  });
  const outcome = await settle(rig, startSearch(backend, rig));
  const err = expectRejected(outcome, "P-09b 无搜索证据");
  expectCode(err, ENTRY_CODES.BAD_RESPONSE, "P-09b 无搜索证据（推断，GMI-001「缺少该证据…按降级」选失败码）");
});

test("P-10a（推断）：status=failed 无安全原因 → ENTRY_BAD_RESPONSE", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-005 / P-10a");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({ body: outputsResponse({ status: "failed", annotations: [] }) });
  const outcome = await settle(rig, startSearch(backend, rig));
  const err = expectRejected(outcome, "P-10a status=failed");
  expectCode(err, ENTRY_CODES.BAD_RESPONSE, "P-10a status=failed（推断，FB-005 异常响应）");
});

test("P-10b（推断）：内容安全拦截 → ENTRY_CONTENT_POLICY（终止类，FB-001）", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-001 / P-10b");
  const rig = newRig();
  // 拦截体的确切形状规格未写明；此处为推断形状：status=failed 且 error.code=SAFETY。
  rig.fetch.when(GEMINI_ROUTE).responds({
    body: { id: "synthetic-blocked", status: "failed", error: { code: "SAFETY", message: "合成内容安全拦截" } },
  });
  const outcome = await settle(rig, startSearch(backend, rig));
  const err = expectRejected(outcome, "P-10b 内容安全拦截");
  expectCode(err, ENTRY_CODES.CONTENT_POLICY, "P-10b 内容安全拦截（推断形状与码）");
});

test("P-11（推断，与 FB-005 字面冲突）：429 + RESOURCE_EXHAUSTED 配额文本 → ENTRY_QUOTA", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-005 / P-11");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({
    status: 429,
    body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota (synthetic)" } },
  });
  const outcome = await settle(rig, startSearch(backend, rig));
  const err = expectRejected(outcome, "P-11 配额体 429");
  expectCode(err, ENTRY_CODES.QUOTA, "P-11 配额体 429（推断：额度语义优先；FB-005 字面「其他 429 属限流」会得 RATE_LIMITED，见歧义清单）");
  assert.equal(rig.fetch.count(), 1, "P-11：额度失败后不得重试");
});

test("P-12（推断）：5xx → ENTRY_BAD_RESPONSE（异常响应）且只出站一次", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-005 / P-12");
  for (const status of [500, 503]) {
    const rig = newRig();
    rig.fetch.when(GEMINI_ROUTE).responds({ status, body: { error: { code: status, message: "合成服务端错误" } } });
    const outcome = await settle(rig, startSearch(backend, rig));
    const err = expectRejected(outcome, `P-12 ${status}`);
    expectCode(err, ENTRY_CODES.BAD_RESPONSE, `P-12 ${status}（推断：FB-005 异常响应；规格未给 5xx 映射）`);
    assert.equal(rig.fetch.count(), 1, `P-12 ${status}：不得重试`);
  }
});

test("P-13（推断）：预算为 0 时拒绝且码为 ENTRY_TIMEOUT", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-003 / P-13");
  const rig = newRig({ budgetMs: 0 });
  rig.fetch.when(GEMINI_ROUTE).responds({ body: groundedOutputs() });
  const outcome = await settle(rig, startSearch(backend, rig));
  const err = expectRejected(outcome, "P-13 预算为 0");
  expectCode(err, ENTRY_CODES.TIMEOUT, "P-13 预算为 0（推断：无可用时间归单项超时）");
  assert.equal(rig.fetch.count(), 0, "P-13：零出站（FB-003）");
});

test("P-14（推断）：宿主取消的错误 name 为 AbortError，且不带条目分类码", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-001 / P-14");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).hangs();
  const p = startSearch(backend, rig);
  await flush(3);
  rig.ctl.abort();
  const outcome = await settle(rig, p);
  const err = expectRejected(outcome, "P-14 宿主取消");
  assert.equal(err?.name, "AbortError", "P-14：宿主取消的错误 name 为 AbortError（推断，fetch 取消惯例）");
  assert.ok(!ENTRY_CODE_SET.has(err?.code), "P-14：宿主取消不得带条目分类码（FB-001）");
});
