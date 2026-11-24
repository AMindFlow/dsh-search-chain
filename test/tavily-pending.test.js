// WP3 验收 — 规格含糊处的集中待办断言（全部为 oracle 推断，见下表与各条注释）。
//
// 【约定】本文件是 Tavily 验收中唯一允许表达「规格未定」的地方。每条断言都以 [待办] 开头，
//         注明依据条款与未定点。由 dev 或规格维护者裁决：要么修改 docs/specs/draft/*.md 定名，
//         要么在 PR 说明中改写本文件对应断言并给出理由。不得把这些断言散落到其他测试文件，也不得 skip。
//
// 待办清单：
//   P1 TAV-002/FB-002  已裁决：截断与 truncated 置位归链层（WP5 统一执行）；适配器返回全部映射来源、
//      不本地截断，maxResults 仅作上游参数 max_results 入请求体。对应测试已按定案契约改写。
//   P2 TAV-002/FB-002  answer 字段不得成为 content（FB-002「供应商生成的正文不得作为通用 content」推断）。
//   P3 FB-001/FB-003   宿主取消的错误形状未定；推断：不得以可降级 ENTRY_* 码抛出（否则链会误以为可继续）。
//   P4 TAV-001/FB-001  缺 key 时适配器抛出的码未定（CREDENTIALS 或由链给 SKIPPED_NO_KEY）；本文件选 CREDENTIALS。
//   P5 FB-005/TAV-002  HTTP 400（参数错误）归类未定；推断为 ENTRY_CHANNEL_LIMIT（「通道参数限制」）。
//   P6 FB-005/TAV-002  已裁决（2026-11-24 协调）：432/433 是 Tavily 厂商码，通用分类器不做特例（链层按其他-4xx →
//      CHANNEL_LIMIT，见 src/search.js classifyUpstreamFailure）；「额度语义必须可达 QUOTA」由 Tavily 适配器本地映射承担
//      （432/433 → ENTRY_QUOTA）。对应测试已按定案改写：适配器层假 fetch 432/433 → QUOTA + 新增链层用例 432/433 → CHANNEL_LIMIT。
//   P7 FB-003          budgetMs=0 时失败码未定；推断为 ENTRY_TIMEOUT。
//
// 另有两处仅在报告中列出、本文件不断言（规格未给出可观察条款）：
//   - 429 且 body 为 Tavily 用量文案（非 insufficient_quota）是否归额度；
//   - publishedAt 字段映射（TAV-002 只写 url/title/content）。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import {
  WP_SEARCH,
  SAMPLE_RESULTS,
  successBody,
  SYNTH_QUOTA_BODY,
  tavilyFetch,
  tavilyFetchHangs,
  loadTavilyBackend,
  makeCtx,
  rejectionOf,
  withGuard,
  singleCall,
  bodyOf,
} from "./helpers/tavily-oracle.js";

const ENTRY_CODE_VALUES = Object.values(C.ENTRY_CODES);

test("TAV-002/FB-002 上游超发（3 条 > maxResults=2）：适配器返回全量来源不截断（截断与 truncated 归链层）", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-002/FB-002");
  if (!backend) return;
  const fetch = tavilyFetch({ status: 200, body: successBody(SAMPLE_RESULTS) });
  const out = await backend.search(makeCtx({ fetch, maxResults: 2 }));
  const call = singleCall(fetch, "超发");
  // maxResults 仍作为上游参数发送（TAV-001：max_results=min(maxResults,20)）；本用例钉住「发送但不本地裁剪」。
  assert.equal(bodyOf(call).max_results, 2, "maxResults=2 仍须入请求体 max_results（TAV-001 上游参数），实际未发送或值不符");
  assert.equal(
    out.sources.length,
    SAMPLE_RESULTS.length,
    `裁决（FB-002）：截断与 truncated 置位归链层（WP5）统一执行，适配器返回全部 ${SAMPLE_RESULTS.length} 条映射来源、不本地截断，实际 ${out.sources.length} 条`,
  );
});

test("[待办 TAV-002/FB-002] P2 answer 字段存在时不得映射为 content（供应商生成正文）", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-002/FB-002");
  if (!backend) return;
  const fetch = tavilyFetch({ status: 200, body: successBody(SAMPLE_RESULTS, { answer: "synthetic provider answer" }) });
  const out = await backend.search(makeCtx({ fetch, maxResults: 10 }));
  singleCall(fetch, "answer 字段");
  assert.equal(
    out.content,
    undefined,
    `[待办 P2] answer 映射未在 TAV-002 写明；推断 Tavily 为纯来源适配器（FB-002），content 不得为供应商正文，实际：${JSON.stringify(out.content)}`,
  );
});

test("[待办 FB-001/FB-003] P3 宿主取消的错误不得带可降级 ENTRY_* 码（链需据此终止而非降级）", async (t) => {
  const backend = await loadTavilyBackend(t, "FB-001/FB-003");
  if (!backend) return;
  const ac = new AbortController();
  const fetch = tavilyFetchHangs();
  const p = backend.search(makeCtx({ fetch, signal: ac.signal, budgetMs: 5000 }));
  p.catch(() => {});
  await new Promise((r) => setImmediate(r));
  ac.abort(new Error("synthetic host cancel"));
  const err = await rejectionOf(withGuard(p, "宿主取消"));
  assert.ok(
    !ENTRY_CODE_VALUES.includes(err?.code),
    `[待办 P3] 取消错误形状未定。推断：宿主取消不得以 ENTRY_* 码抛出（否则链会当作可降级继续），实际码：${err?.code}`,
  );
});

test("[待办 TAV-001/FB-001] P4 缺 key 时适配器抛出的码（本文件选 CREDENTIALS；链也可给 SKIPPED_NO_KEY）", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-001/FB-001");
  if (!backend) return;
  const fetch = tavilyFetch({ status: 200, body: successBody() });
  const err = await rejectionOf(backend.search(makeCtx({ fetch, key: undefined })));
  assert.equal(fetch.count(), 0, "零出站（FB-001）已在 tavily-request.test.js 断言");
  assert.equal(
    err.code,
    C.ENTRY_CODES.CREDENTIALS,
    `[待办 P4] 缺 key 的码未定（CREDENTIALS 或链层 ${C.SKIPPED_NO_KEY}）。本文件选 CREDENTIALS，实际：${err.code}`,
  );
});

test("[待办 FB-005/TAV-002] P5 HTTP 400（参数错误）→ ENTRY_CHANNEL_LIMIT（「通道参数限制」推断）", async (t) => {
  const backend = await loadTavilyBackend(t, "FB-005/TAV-002");
  if (!backend) return;
  const fetch = tavilyFetch({ status: 400, body: { detail: { error: "synthetic bad parameter" } } });
  const err = await rejectionOf(backend.search(makeCtx({ fetch })));
  singleCall(fetch, "400");
  assert.equal(
    err.code,
    C.ENTRY_CODES.CHANNEL_LIMIT,
    `[待办 P5] 400 的归类未在 FB-005 明文。推断为 ENTRY_CHANNEL_LIMIT，实际：${err.code}`,
  );
});

test("FB-005/TAV-002 P6 432/433（Tavily 厂商码）→ ENTRY_QUOTA：额度语义在适配器层可达（2026-11-24 裁决）", async (t) => {
  // 2026-11-24 协调裁决：432/433 是 Tavily 厂商码，通用分类器不做特例；「额度语义必须可达 QUOTA」
  // 由 Tavily 适配器本地映射承担（432/433 → ENTRY_QUOTA），故本用例在适配器层断言（假 fetch 发 432/433）。
  const res = await tryImportSrc("backends/tavily.js");
  if (!res.ok) {
    t.skip(`src/backends/tavily.js 不可用（reason=${res.reason}）：本用例依赖合并后 main 的 WP3 Tavily 适配器，跳过`);
    return;
  }
  const mod = res.module;
  const backend =
    mod.tavilyBackend ??
    mod.default ??
    (typeof mod.createTavilyBackend === "function" ? mod.createTavilyBackend() : undefined);
  assert.ok(
    backend && typeof backend.search === "function",
    "src/backends/tavily.js 须导出 Backend（{ type, search(ctx) }，A5）；oracle 接受 tavilyBackend / default / createTavilyBackend() 三种形态之一",
  );
  for (const status of [432, 433]) {
    const fetch = tavilyFetch({ status, body: SYNTH_QUOTA_BODY });
    const err = await rejectionOf(backend.search(makeCtx({ fetch })));
    singleCall(fetch, `HTTP ${status}（TAV-002 验收）`);
    assert.equal(
      err.code,
      C.ENTRY_CODES.QUOTA,
      `裁决（2026-11-24）：${status} 为 Tavily 用量超限码，额度语义必须可达 QUOTA，由 Tavily 适配器本地映射承担；实际：${err.code}`,
    );
    assert.equal(err.status, status, `条目级错误须携带上游状态以供核查（FB-005）；实际：${err.status}`);
  }
});

test("FB-005/TAV-002 P6 链层：通用分类器对 432/433 无状态特例，按其他-4xx 归 ENTRY_CHANNEL_LIMIT（2026-11-24 裁决）", async (t) => {
  // 2026-11-24 协调裁决：432/433 是 Tavily 厂商码，链层按其他-4xx → CHANNEL_LIMIT；
  // 通用 classifyUpstreamFailure 保持厂商中立，不得为 Tavily 码增设特例（A4 归属不变）。
  const res = await tryImportSrc("search.js");
  if (failIfUnimplemented(t, res, WP_SEARCH, "FB-005/TAV-002 P6 链层")) return;
  const { classifyUpstreamFailure } = res.module;
  assert.equal(typeof classifyUpstreamFailure, "function");
  for (const status of [432, 433]) {
    assert.equal(
      classifyUpstreamFailure({ status }),
      C.ENTRY_CODES.CHANNEL_LIMIT,
      `裁决（2026-11-24）：通用分类器对 ${status}（Tavily 厂商码）无状态特例，链层按其他-4xx 统一归 ENTRY_CHANNEL_LIMIT；实际：${classifyUpstreamFailure({ status })}`,
    );
  }
});

test("[待办 FB-003] P7 budgetMs=0 时的失败码推断为 ENTRY_TIMEOUT（无可用时间）", async (t) => {
  const backend = await loadTavilyBackend(t, "FB-003");
  if (!backend) return;
  const fetch = tavilyFetchHangs();
  const err = await rejectionOf(withGuard(backend.search(makeCtx({ fetch, budgetMs: 0 })), "budgetMs=0"));
  assert.equal(
    err.code,
    C.ENTRY_CODES.TIMEOUT,
    `[待办 P7] 无可用时间时的码未定（推断 ENTRY_TIMEOUT，链可据 FB-003 视为超时），实际：${err.code}`,
  );
});
