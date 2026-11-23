// bing.md BING-001「RSS 解析与来源」与 BING-002「空 Feed」验收（docs/specs/draft/bing.md）。全红：src/backends/bing.js 尚未实现，等待 WP4。
// 覆盖：channel/item 按顺序映射 link→url、title、description→snippet、可解析的 pubDate→publishedAt；
//       描述作可显示文本；部分无效 item 丢弃保留有效；合法 RSS 零 item 为空数组而非错误；
//       XML 实体解码；不展开外部实体；纯来源结果不携带 content（FB-002）。
// 待办与未断言歧义见 helpers/bing-oracle.js 文件头（AMB-3 publishedAt 格式、AMB-4 描述裁剪、AMB-7 截断责任、AMB-8 标记文本）。
import test from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_NAMES, loadFixture } from "./helpers/fixtures.js";
import {
  assertSourceShape,
  INLINE,
  loadBingBackend,
  makeBingCtx,
  onlyDispatch,
  routeBing,
  settle,
} from "./helpers/bing-oracle.js";

const CLAUSE = "BING-001 解析";
const RSS_HEADERS = { "content-type": "application/rss+xml" };

test("BING-001 解析：复用 bingResults 样本，三条来源按顺序映射 url/title/snippet/publishedAt", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  routeBing(fetch, { status: 200, body: loadFixture(FIXTURE_NAMES.bingResults), headers: RSS_HEADERS });

  const res = await settle(bing.search(ctx));

  assert.equal(res.ok, true, "合法 RSS 样本必须成功返回（BING-001）");
  const sources = res.value.sources;
  assertSourceShape(sources);
  assert.equal(sources.length, 3, "三个 item 必须全部映射（BING-001）");
  const [a, b, c] = sources;

  assert.equal(a.url, "https://docs-one.host.test/api/reference?src=bing-fixture", "item1 link → url（BING-001）");
  assert.equal(a.title, "合成来源 1：接口文档", "item1 title（BING-001）");
  assert.equal(a.snippet, "第一个合成结果的描述文本，用于 snippet 映射与首段裁剪验证。", "item1 description → snippet（BING-001）");
  assert.equal(Date.parse(a.publishedAt), Date.parse("Mon, 03 Nov 2025 08:00:00 GMT"), "item1 pubDate → publishedAt，指向同一时刻（BING-001；AMB-3）");

  assert.equal(b.url, "https://docs-two.host.test/guide/getting-started?src=bing-fixture", "item2 link → url（BING-001）");
  assert.equal(b.title, "合成来源 2：入门指南", "item2 title（BING-001）");
  assert.ok(b.snippet?.includes("第二个合成结果"), "item2 snippet 须含描述的可显示正文（BING-001；裁剪规则见 AMB-4）");
  assert.equal(Date.parse(b.publishedAt), Date.parse("Tue, 04 Nov 2025 09:30:00 GMT"), "item2 pubDate → publishedAt（BING-001）");

  assert.equal(c.url, "https://docs-three.host.test/changelog?src=bing-fixture", "item3 link → url（BING-001）");
  assert.equal(c.title, "合成来源 3：无发布日期", "item3 title（BING-001）");
  assert.equal(c.snippet, "第三个合成结果，item 故意缺少 pubDate，验证 publishedAt 可缺省。", "item3 description → snippet（BING-001）");
  assert.equal(c.publishedAt, undefined, "缺 pubDate 的 item 不得产生 publishedAt（BING-001：可缺省）");
});

test("BING-001 解析：成功的纯来源结果不携带 content（FB-002：供应商正文不作为通用 content）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  routeBing(fetch, { status: 200, body: loadFixture(FIXTURE_NAMES.bingResults), headers: RSS_HEADERS });

  const res = await settle(bing.search(ctx));

  assert.equal(res.ok, true, "前置：样本应成功返回");
  assert.equal(res.value.content, undefined, "Bing 为纯来源适配器，不得返回 content（FB-002）");
});

test("BING-001 解析：部分无效 item（无 link、非 HTTP(S)、相对 URL）被丢弃，保留有效 item", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  routeBing(fetch, { status: 200, body: INLINE.partialValid, headers: RSS_HEADERS });

  const res = await settle(bing.search(ctx));

  assert.equal(res.ok, true, "存在至少一个有效 item 时整体必须成功（BING-002：所有条目无有效链接才算失败）");
  assertSourceShape(res.value.sources);
  assert.deepEqual(
    res.value.sources.map((s) => s.url),
    ["https://inline-valid.host.test/ok?x=1&y=2"],
    "无效 item 必须丢弃；仅保留有效 item，且 &amp; 经 XML 解码为 &（BING-001）",
  );
  assert.equal(res.value.sources[0].title, "有效条目", "有效 item 的 title 不得因丢弃其他 item 而错位（BING-001）");
});

test("BING-002 空 Feed：可解析的 RSS 且零 item 为明确无结果，resolve 空数组，不是错误", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  routeBing(fetch, { status: 200, body: loadFixture(FIXTURE_NAMES.bingEmpty), headers: RSS_HEADERS });

  const res = await settle(bing.search(ctx));

  assert.equal(res.ok, true, "零 item 的合法 RSS 必须 resolve，不得抛错（BING-002）");
  assert.deepEqual(res.value.sources, [], "sources 必须为空数组（BING-002/FB-004 明确无结果）");
  assert.equal(res.value.content, undefined, "空结果不得携带 content（FB-002）");
  onlyDispatch(fetch);
});

test("BING-001 解析：标记描述按可显示文本处理，snippet 不含原始 <b> 标签（AMB-8）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  routeBing(fetch, { status: 200, body: INLINE.markupDescription, headers: RSS_HEADERS });

  const res = await settle(bing.search(ctx));

  assert.equal(res.ok, true, "前置：标记描述样本应成功返回");
  const snippet = res.value.sources[0].snippet;
  assert.ok(snippet.includes("描述文本"), "描述正文必须保留（BING-001）");
  assert.ok(!snippet.includes("<b>") && !snippet.includes("</b>"), "snippet 须为可显示文本，不得含原始 HTML 标签（BING-001；AMB-8）");
});

test("BING-002 解析：外部实体声明不得展开，且不得对实体 SYSTEM 地址发起出站", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  routeBing(fetch, { status: 200, body: INLINE.externalEntity, headers: RSS_HEADERS });

  const res = await settle(bing.search(ctx));

  assert.equal(fetch.dispatched.length, 1, "只允许对 Bing 端点的一次 GET；不得为外部实体发起出站（BING-002）");
  assert.equal(fetch.dispatched[0].url.startsWith("https://www.bing.com/search"), true, "唯一出站必须是 Bing 端点");
  if (res.ok) {
    for (const s of res.value.sources) {
      assert.ok(!String(s.url).includes("xxe.host.test"), "外部实体地址不得出现在来源 url 中（BING-002）");
      assert.ok(!String(s.title ?? "").includes("xxe.host.test"), "外部实体地址不得出现在标题中（BING-002）");
    }
  } else {
    assert.equal(res.error?.code, "ENTRY_BAD_RESPONSE", "若拒绝该文档，须归为 ENTRY_BAD_RESPONSE（BING-002）");
  }
});

test("BING-001 解析：返回值为上游顺序的前缀（maxResults 截断语义见 AMB-7）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const all = loadFixture(FIXTURE_NAMES.bingResults);
  const upstreamUrls = [
    "https://docs-one.host.test/api/reference?src=bing-fixture",
    "https://docs-two.host.test/guide/getting-started?src=bing-fixture",
    "https://docs-three.host.test/changelog?src=bing-fixture",
  ];
  const { ctx, fetch } = makeBingCtx({ maxResults: 2 });
  routeBing(fetch, { status: 200, body: all, headers: RSS_HEADERS });

  const res = await settle(bing.search(ctx));

  assert.equal(res.ok, true, "前置：样本应成功返回");
  const urls = res.value.sources.map((s) => s.url);
  assert.ok(urls.length >= 1 && urls.length <= upstreamUrls.length, "返回条数必须在 1 与上游条数之间");
  assert.deepEqual(urls, upstreamUrls.slice(0, urls.length), "返回值必须是上游顺序的前缀（BING-001 顺序；FB-002）");
});
