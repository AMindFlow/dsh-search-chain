// WP3 验收 — 规格含糊处的集中待办断言（全部为 oracle 推断，见下表与各条注释）。
//
// 【约定】本文件是 Tavily 验收中唯一允许表达「规格未定」的地方。每条断言都以 [待办] 开头，
//         注明依据条款与未定点。由 dev 或规格维护者裁决：要么修改 docs/specs/draft/*.md 定名，
//         要么在 PR 说明中改写本文件对应断言并给出理由。不得把这些断言散落到其他测试文件，也不得 skip。
//
// 待办清单：
//   P1 TAV-002/FB-002  上游超发时截断责任（适配器 vs 链）未定；本文件推断适配器输出 ≤ maxResults。
//   P2 TAV-002/FB-002  answer 字段不得成为 content（FB-002「供应商生成的正文不得作为通用 content」推断）。
//   P3 FB-001/FB-003   宿主取消的错误形状未定；推断：不得以可降级 ENTRY_* 码抛出（否则链会误以为可继续）。
//   P4 TAV-001/FB-001  缺 key 时适配器抛出的码未定（CREDENTIALS 或由链给 SKIPPED_NO_KEY）；本文件选 CREDENTIALS。
//   P5 FB-005/TAV-002  HTTP 400（参数错误）归类未定；推断为 ENTRY_CHANNEL_LIMIT（「通道参数限制」）。
//   P6 FB-005/TAV-002  432 归属未定：Tavily 特例在适配器，还是通用 classifyUpstreamFailure；本文件两者都要求为 QUOTA。
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
  tavilyFetch,
  tavilyFetchHangs,
  loadTavilyBackend,
  makeCtx,
  rejectionOf,
  withGuard,
  singleCall,
} from "./helpers/tavily-oracle.js";

const ENTRY_CODE_VALUES = Object.values(C.ENTRY_CODES);

test("[待办 TAV-002/FB-002] P1 上游超发（3 条 > maxResults=2）：适配器输出不得超过 maxResults", async (t) => {
  const backend = await loadTavilyBackend(t, "TAV-002/FB-002");
  if (!backend) return;
  const fetch = tavilyFetch({ status: 200, body: successBody(SAMPLE_RESULTS) });
  const out = await backend.search(makeCtx({ fetch, maxResults: 2 }));
  singleCall(fetch, "超发");
  assert.ok(
    out.sources.length <= 2,
    `[待办 P1] 截断责任未定（TAV-002 未写；FB-002 写在结果层）。推断适配器输出 ≤ maxResults，实际 ${out.sources.length} 条`,
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

test("[待办 FB-005/TAV-002] P6 432 归属：通用 classifyUpstreamFailure 也必须判 QUOTA（WP5）", async (t) => {
  const res = await tryImportSrc("search.js");
  if (failIfUnimplemented(t, res, WP_SEARCH, "FB-005/TAV-002 P6")) return;
  const { classifyUpstreamFailure } = res.module;
  assert.equal(typeof classifyUpstreamFailure, "function");
  assert.equal(
    classifyUpstreamFailure({ status: 432 }),
    C.ENTRY_CODES.QUOTA,
    "[待办 P6] 432 特例归属未定：若适配器自处理则通用分类器可不认 432；本文件要求通用分类器亦判 QUOTA",
  );
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
