// bing.md BING-002 失败样本与 CFG-003 脱敏在 Bing 适配器上的验收（docs/specs/draft/bing.md；docs/specs/draft/config-network.md 的 CFG-003 经 helpers/redact.js 落地）。
// 全红：src/backends/bing.js 尚未实现，等待 WP4。
// 覆盖：响应体原文（可能回显用户查询或标记）不得进入错误 message / cause / stack / 日志；
//       畸形 XML 的解析器错误文本不得回显响应片段；注入的 key 不得出现在错误中。
// 待办与歧义见 helpers/bing-oracle.js 文件头。
import test from "node:test";
import assert from "node:assert/strict";
import { assertNoRawBody, assertNoSecrets } from "./helpers/redact.js";
import {
  BING_QUERY,
  BING_UNUSED_KEY,
  BODY_MARKER,
  INLINE,
  loadBingBackend,
  makeBingCtx,
  MARKED_BLOCK_PAGE,
  routeBing,
  settle,
} from "./helpers/bing-oracle.js";

const CLAUSE = "BING-002 脱敏";

test("CFG-003 脱敏：403 拦截页原文（含标记）不进入错误 message、cause、stack 或日志", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch, log } = makeBingCtx();
  routeBing(fetch, { status: 403, body: MARKED_BLOCK_PAGE, headers: { "content-type": "text/html" } });

  const res = await settle(bing.search(ctx));

  assert.equal(res.ok, false, "前置：403 应失败");
  assertNoSecrets(t, res.error, [BODY_MARKER], "错误对象（message/cause/stack）不得含响应体标记（CFG-003）");
  assertNoRawBody(t, res.error, "错误文本不得含 HTML 原始响应体（CFG-003）");
  assertNoSecrets(t, log.text(), [BODY_MARKER], "日志不得含响应体标记（CFG-003）");
});

test("CFG-003 脱敏：畸形 XML 的解析器错误文本不回显响应片段（标记不泄漏）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch, log } = makeBingCtx();
  routeBing(fetch, { status: 200, body: INLINE.malformedWithMarker, headers: { "content-type": "application/rss+xml" } });

  const res = await settle(bing.search(ctx));

  assert.equal(res.ok, false, "前置：畸形 XML 应失败");
  assert.equal(res.error?.code, "ENTRY_BAD_RESPONSE", "畸形 XML 须为 ENTRY_BAD_RESPONSE（BING-002）");
  assertNoSecrets(t, res.error, [BODY_MARKER], "解析器错误（message/cause/stack）不得回显响应片段（CFG-003）");
  assertNoSecrets(t, log.text(), [BODY_MARKER], "日志不得回显响应片段（CFG-003）");
});

test("CFG-003 脱敏：500 响应体回显用户查询与标记时，错误与日志均不含查询或标记", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch, log } = makeBingCtx({ query: BING_QUERY });
  routeBing(fetch, {
    status: 500,
    body: `upstream echoed query ${BING_QUERY} and ${BODY_MARKER}`,
    headers: { "content-type": "text/plain" },
  });

  const res = await settle(bing.search(ctx));

  assert.equal(res.ok, false, "前置：500 应失败");
  assertNoSecrets(t, res.error, [BODY_MARKER, BING_QUERY], "错误不得含响应体标记或用户查询原文（CFG-003；BING-002）");
  assertNoSecrets(t, log.text(), [BODY_MARKER, BING_QUERY], "日志不得含响应体标记或用户查询原文（CFG-003）");
});

test("CFG-003 脱敏：注入的 key 即使被上游回显，也不得进入错误或日志", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch, log } = makeBingCtx({ key: BING_UNUSED_KEY });
  routeBing(fetch, {
    status: 401,
    body: { error: { type: "authentication_error", message: `bad key ${BING_UNUSED_KEY}` } },
    headers: { "content-type": "application/json" },
  });

  const res = await settle(bing.search(ctx));

  assert.equal(res.ok, false, "前置：401 应失败");
  assertNoSecrets(t, res.error, [BING_UNUSED_KEY], "错误不得含注入的 key（CFG-003）");
  assertNoSecrets(t, log.text(), [BING_UNUSED_KEY], "日志不得含注入的 key（CFG-003）");
});
