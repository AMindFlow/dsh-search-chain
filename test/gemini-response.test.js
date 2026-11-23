// WP11 Gemini 响应映射验收（GMI-001 证据与引用；GMI-002 宿主展示边界；FB-002 来源有效性与内容约束）。
//
// 条款：
//   GMI-001 要求：只有实际完成服务端搜索且具有可展示的 grounded 结果才算成功；保留引用供展示。
//   GMI-002 要求：上游 HTML（搜索建议）不得放入模型文本或普通来源摘要。
//   FB-002  要求：有效来源须为绝对 HTTP(S) URL；sources 按供应商顺序；插件不依赖宿主兜底截断。
//   FB-005  要求：结构错与异常响应归为 ENTRY_BAD_RESPONSE（可降级）。
//
// 红属预期：src/backends/gemini.js 尚未实现（WP11）。
// 响应形状有 outputs（旧式）与 steps（新式）两种，本文件两者都要求得到相同映射（P-01 说明）。
// 未在规格中写明的 content/snippet/去重/全无效/无证据语义见 gemini-pending.test.js（P 编号）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  GEMINI_ROUTE,
  SRC_A,
  SRC_B,
  ENTRY_CODE_SET,
  SUGGESTION_MARK,
  urlCitation,
  outputsResponse,
  stepsResponse,
  groundedOutputs,
  newRig,
  startSearch,
  settle,
  expectRejected,
  expectCode,
  assertSourceShape,
  urlTitle,
  loadGeminiBackend,
} from "./helpers/gemini-oracle.js";
import { ENTRY_CODES } from "./helpers/contract.js";

test("GMI-001/FB-002：outputs 结构的 url_citation 按顺序映射为 sources（url、title）", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-001 / FB-002");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({ body: groundedOutputs() });

  const outcome = await settle(rig, startSearch(backend, rig));
  assert.equal(outcome.ok, true, `合法 grounded 样本应成功：${outcome.ok ? "" : outcome.error?.message}`);
  assertSourceShape(outcome.value.sources);
  assert.deepEqual(urlTitle(outcome.value.sources), [SRC_A, SRC_B], "sources 必须按引用在响应中的出现顺序");
});

test("GMI-001/FB-002：steps 结构（新式）得到与 outputs 相同的映射", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-001 / FB-002");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({
    body: stepsResponse({ annotations: [urlCitation(SRC_A), urlCitation(SRC_B)] }),
  });

  const outcome = await settle(rig, startSearch(backend, rig));
  assert.equal(outcome.ok, true, `steps 结构的 grounded 样本应成功：${outcome.ok ? "" : outcome.error?.message}`);
  assertSourceShape(outcome.value.sources);
  assert.deepEqual(urlTitle(outcome.value.sources), [SRC_A, SRC_B], "steps 与 outputs 的映射必须一致");
});

test("FB-002：无效引用条目被丢弃，有效条目保留且顺序不变", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-002");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({
    body: outputsResponse({
      annotations: [
        urlCitation(SRC_A),
        null,
        { type: "other_annotation", url: "https://ignored.synthetic-host.invalid/o" },
        { type: "url_citation", url: "ftp://bad.synthetic-host.invalid/x", title: "非 HTTP(S)" },
        { type: "url_citation", url: "not a url", title: "不可解析" },
        { type: "url_citation", title: "缺 url" },
        { type: "url_citation", url: 42, title: "非字符串 url" },
        urlCitation(SRC_B),
      ],
    }),
  });

  const outcome = await settle(rig, startSearch(backend, rig));
  assert.equal(outcome.ok, true, `含部分有效引用时应成功：${outcome.ok ? "" : outcome.error?.message}`);
  assertSourceShape(outcome.value.sources);
  assert.deepEqual(urlTitle(outcome.value.sources), [SRC_A, SRC_B], "无效条目须被丢弃，有效条目按原顺序保留（FB-002）");
});

test("GMI-001：模型正文中的裸链接不得成为来源（来源只来自 url_citation 引用）", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-001");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({
    body: outputsResponse({ text: "参见 https://bare.synthetic-host.invalid/z 的说明", annotations: [] }),
  });

  const outcome = await settle(rig, startSearch(backend, rig));
  if (outcome.ok) {
    const urls = outcome.value.sources.map((s) => s.url);
    assert.ok(
      !urls.some((u) => u.includes("bare.synthetic-host")),
      `正文裸链接不得成为来源（GMI-001 来源仅为引用），实际：${JSON.stringify(urls)}`,
    );
  } else {
    assert.ok(ENTRY_CODE_SET.has(outcome.error?.code), `拒绝时须为条目分类码（FB-005），实际：${String(outcome.error?.code)}`);
  }
});

test("FB-005：结构错误的响应（顶层数组、缺 outputs/steps、outputs 非数组）归为 ENTRY_BAD_RESPONSE", async (t) => {
  const backend = await loadGeminiBackend(t, "FB-005");
  const badBodies = [
    { label: "顶层数组", body: [] },
    { label: "缺 outputs/steps", body: { id: "synthetic-x", status: "completed" } },
    { label: "outputs 非数组", body: { id: "synthetic-x", status: "completed", outputs: "not-an-array" } },
  ];
  for (const { label, body } of badBodies) {
    const rig = newRig();
    rig.fetch.when(GEMINI_ROUTE).responds({ body });
    const outcome = await settle(rig, startSearch(backend, rig));
    const err = expectRejected(outcome, `结构错误（${label}）`);
    expectCode(err, ENTRY_CODES.BAD_RESPONSE, `结构错误（${label}）`);
  }
});

test("GMI-001：response.status 为 failed 时不得算搜索成功（只有完成的 grounded 结果才成功）", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-001");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({
    body: outputsResponse({ status: "failed", annotations: [urlCitation(SRC_A)] }),
  });

  const outcome = await settle(rig, startSearch(backend, rig));
  const err = expectRejected(outcome, "status=failed");
  assert.ok(ENTRY_CODE_SET.has(err?.code), `status=failed 须为条目分类码（FB-005），实际：${String(err?.code)}`);
});

test("GMI-002：搜索建议 HTML 不进入 content，也不进入任何来源字段", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-002");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({
    body: outputsResponse({
      annotations: [urlCitation(SRC_A)],
      suggestion: `<div class="${SUGGESTION_MARK}">合成建议</div>`,
    }),
  });

  const outcome = await settle(rig, startSearch(backend, rig));
  assert.equal(outcome.ok, true, `应成功：${outcome.ok ? "" : outcome.error?.message}`);
  const { content, sources } = outcome.value;
  if (content !== undefined) {
    assert.equal(typeof content, "string", "content 若存在须为字符串");
    assert.ok(!content.includes(SUGGESTION_MARK), "GMI-002：搜索建议 HTML 不得放入模型文本/content");
    assert.ok(!content.includes("<div"), "GMI-002：上游 HTML 不得放入 content");
  }
  for (const [i, s] of sources.entries()) {
    const flat = JSON.stringify(s);
    assert.ok(!flat.includes(SUGGESTION_MARK), `GMI-002：sources[${i}] 不得含搜索建议 HTML（不得放入普通来源摘要）`);
  }
});

test("GMI-001：没有任何 grounded 证据的完成响应不得返回非空来源", async (t) => {
  const backend = await loadGeminiBackend(t, "GMI-001");
  const rig = newRig();
  rig.fetch.when(GEMINI_ROUTE).responds({
    body: outputsResponse({ withSearch: false, text: "只有模型文本，没有搜索证据", annotations: [] }),
  });

  const outcome = await settle(rig, startSearch(backend, rig));
  if (outcome.ok) {
    assert.equal(outcome.value.sources.length, 0, "缺少服务端搜索证据时不得产生来源（GMI-001）");
  } else {
    assert.ok(ENTRY_CODE_SET.has(outcome.error?.code), `拒绝时须为条目分类码（FB-005），实际：${String(outcome.error?.code)}`);
  }
});
