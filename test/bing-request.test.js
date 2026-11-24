// bing.md BING-001「请求与来源」请求段验收（docs/specs/draft/bing.md）。全红：src/backends/bing.js 尚未实现，等待 WP4。
// 覆盖：每次搜索恰好一次 GET https://www.bing.com/search；q 为原查询、format=rss；
//       免 key 且无认证头/认证参数；URL 编码；未指定参数省略而非 null；出站经 ctx.fetch（A6）。
// 待办与未断言歧义见 helpers/bing-oracle.js 文件头（TODO-BING-1、AMB-2）。
// 宿主清单（非代码断言）：HOST-BING-2 切换条目代理后从 dsh 工具复验请求路径。
import test from "node:test";
import assert from "node:assert/strict";
import {
  BING_ENDPOINT,
  BING_QUERY,
  BING_UNUSED_KEY,
  headersOf,
  loadBingBackend,
  makeBingCtx,
  onlyDispatch,
  routeBing,
  rssDoc,
  rssItem,
  settle,
} from "./helpers/bing-oracle.js";
import { assertNoSecrets } from "./helpers/redact.js";

const CLAUSE = "BING-001 请求";
const OK_BODY = rssDoc(rssItem({ title: "请求侧样本", link: "https://request-sample.host.test/a", description: "请求侧描述" }));

function routeOk(fetch) {
  routeBing(fetch, { status: 200, body: OK_BODY, headers: { "content-type": "application/rss+xml" } });
}

test("BING-001 请求：每次搜索恰好一次 GET，端点精确为 https://www.bing.com/search", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  routeOk(fetch);

  await bing.search(ctx);

  const call = onlyDispatch(fetch);
  const u = new URL(call.url);
  assert.equal(`${u.origin}${u.pathname}`, BING_ENDPOINT, "端点必须精确为 https://www.bing.com/search（BING-001）");
  assert.equal(String(call.init.method ?? "GET").toUpperCase(), "GET", "必须使用 GET（BING-001）");
  assert.equal(call.init.body, undefined, "GET 请求不得带请求体（BING-001）");
});

test("BING-001 请求：查询参数 q 为原查询逐字，format 为 rss", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx({ query: BING_QUERY });
  routeOk(fetch);

  await bing.search(ctx);

  const u = new URL(onlyDispatch(fetch).url);
  assert.deepEqual(u.searchParams.getAll("q"), [BING_QUERY], "q 必须且只出现一次，值为原查询（BING-001）");
  assert.deepEqual(u.searchParams.getAll("format"), ["rss"], "format 必须且只出现一次，值为 rss（BING-001）");
});

test("BING-001 请求：查询做 URL 编码，原始 URL 中不出现未编码空白、井号或中文字符", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx({ query: BING_QUERY });
  routeOk(fetch);

  await bing.search(ctx);

  const call = onlyDispatch(fetch);
  assert.doesNotMatch(call.url, /\s/, "URL 不得含未编码空白（BING-001 URL 编码）");
  assert.ok(!call.url.includes("#"), "URL 不得含未编码 #（否则查询被截断）");
  const rawQ = call.url.split("?")[1].split("&").find((p) => p.startsWith("q="));
  assert.ok(rawQ, "URL 查询串中必须有 q 参数");
  assert.doesNotMatch(rawQ, /[\u4e00-\u9fff"'<>]/, "q 的原始文本不得含未编码中文或引号（须百分号编码）");
  assert.equal(new URL(call.url).searchParams.get("q"), BING_QUERY, "编码后解码须逐字还原（含 + 与 & 不被误解析）");
});

test("BING-001 请求：免 key，即使注入 key 也不得出现在 URL 或任何头部中（无认证头、无认证参数）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx({ key: BING_UNUSED_KEY });
  routeOk(fetch);

  await bing.search(ctx);

  const call = onlyDispatch(fetch);
  const headers = headersOf(call.init);
  for (const h of ["authorization", "x-api-key", "api-key", "ocp-apim-subscription-key", "cookie", "proxy-authorization"]) {
    assert.equal(headers[h], undefined, `不得发送认证头 ${h}（BING-001：免 key）`);
  }
  const u = new URL(call.url);
  for (const name of ["key", "api_key", "apikey", "token", "subscription-key"]) {
    assert.equal(u.searchParams.has(name), false, `不得携带认证参数 ${name}（BING-001：免 key）`);
  }
  assertNoSecrets(t, call, [BING_UNUSED_KEY], "出站 URL/头部不得包含注入的 key（CFG-002/BING-001）");
});

test("BING-001 请求：免 key 条目不需要凭据即可出站并完成搜索（ctx 不带 key）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  assert.equal("key" in ctx, false, "前置：本用例 ctx 不带 key");
  routeOk(fetch);

  const res = await settle(bing.search(ctx));

  assert.equal(res.ok, true, "免 key 条目缺 key 不得报凭据错误（BING-001：免 key）");
  onlyDispatch(fetch);
});

test("BING-001 请求：未指定的参数整体省略，不以空值、null 或 undefined 字面量提交", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  routeOk(fetch);

  await bing.search(ctx);

  const call = onlyDispatch(fetch);
  for (const [name, value] of new URL(call.url).searchParams) {
    assert.notEqual(value, "", `参数 ${name} 不得为空值（未指定则省略）`);
    assert.doesNotMatch(value, /^(null|undefined)$/, `参数 ${name} 不得以 null/undefined 字面量提交（未指定则省略）`);
  }
});

test("BING-001 请求：出站经 ctx.fetch（A6），不直接调用全局 fetch", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  routeOk(fetch);

  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("直接调用全局 fetch 违反 A6：须经 ctx.fetch（网络走条目自己的配置，BING-001）");
  };
  let res;
  try {
    res = await settle(bing.search(ctx));
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(res.ok, true, "出站必须经 ctx.fetch 完成（BING-001：网络走条目配置）");
  onlyDispatch(fetch);
});
