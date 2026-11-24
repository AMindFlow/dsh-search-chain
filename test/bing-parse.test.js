// bing.md BING-001「RSS 解析与来源」与 BING-002「空 Feed」验收（docs/specs/draft/bing.md）。全红：src/backends/bing.js 尚未实现，等待 WP4。
// 覆盖：channel/item 按顺序映射 link→url、title、description→snippet、可解析的 pubDate→publishedAt；
//       描述作可显示文本；部分无效 item 丢弃保留有效；合法 RSS 零 item 为空数组而非错误；
//       XML 实体解码（含数字字符引用：合法解码、无效引用按字面保留，审阅缺口 1）；
//       恶意 & 串线性扫描性能（审阅缺口 4）；DOCTYPE 开头的合法 RSS 正样本不再误判拦截页（审阅缺口 5）；
//       不展开外部实体；纯来源结果不携带 content（FB-002）。
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
  rssDoc,
  rssItem,
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

test("BING-001 解析：数字字符引用合法解码、无效引用按字面保留（&#39;→'、&#x41;→A；&#0;/&#x110000;/&#xD800;/&#abc;/&unknown; 原样，审阅缺口 1）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  const body = rssDoc(
    rssItem({
      title: "标题&#39;单引号&#x41;",
      link: "https://numeric-ref.host.test/doc",
      description: "描述&#39;单引号&#39;与&#x41;解码，&#0;、&#x110000;、&#xD800;、&#abc;、&unknown;按字面保留",
    }),
  );
  routeBing(fetch, { status: 200, body, headers: RSS_HEADERS });

  const res = await settle(bing.search(ctx));

  assert.equal(res.ok, true, `前置：数字引用样本须成功解析（BING-001），实际错误：${res.error?.code ?? ""} ${res.error?.message ?? ""}`);
  const s = res.value.sources[0];
  assert.equal(s.title, "标题'单引号A", "title 中 &#39;→'、&#x41;→A（十进制/十六进制数字引用解码）");
  assert.equal(
    s.snippet,
    "描述'单引号'与A解码，&#0;、&#x110000;、&#xD800;、&#abc;、&unknown;按字面保留",
    "无效引用（码位 0 / 超 0x10FFFF / 代理区 / 非数字数字引用 / 未知命名实体）须按字面原样保留（BING-001 解码安全面，不查表不加载 DTD）",
  );
});

test("BING-001 解析：DOCTYPE 开头的合法 RSS 正样本解析成功，不再误判为 HTML 拦截页（审阅缺口 5）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const { ctx, fetch } = makeBingCtx();
  const body = [
    '<!DOCTYPE rss>',
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    "<title>synthetic doctype results</title>",
    "<link>https://www.bing.synthetic.invalid/search</link>",
    rssItem({ title: "DOCTYPE 正样本", link: "https://doctype-sample.host.test/doc", description: "DOCTYPE 声明后的合法 RSS 正文" }),
    "</channel></rss>",
  ].join("\n");
  routeBing(fetch, { status: 200, body, headers: RSS_HEADERS });

  const res = await settle(bing.search(ctx));

  assert.equal(res.ok, true, `DOCTYPE 开头的合法 RSS 必须解析成功（不得误判拦截页），实际错误：${res.error?.code ?? ""} ${res.error?.message ?? ""}`);
  assertSourceShape(res.value.sources);
  assert.equal(res.value.sources.length, 1, "唯一 item 必须映射（BING-001）");
  assert.equal(res.value.sources[0].url, "https://doctype-sample.host.test/doc", "link → url（BING-001）");
  assert.equal(res.value.sources[0].snippet, "DOCTYPE 声明后的合法 RSS 正文", "description → snippet（BING-001）");
});

// 计时守护重构（Refs #13）：原断言「单次 <200ms」在共享 CI runner 上偶红（实测 218.7ms，本地全绿），
// 因为绝对阈值量的是机器速度而不是复杂度——本用例真正要防的回归是【实体解码复杂度退化】：
// decodeEntities/findReferenceEnd 由「每个 & 只扫到下一个 ; 或 &，段间不重叠 → O(n)」
// 退化为逐 & 重复向后扫描/整段二次拷贝（src/backends/bing.js 线性扫描注释；审阅缺口 4），
// 1MB 恶意 & 串会从几十毫秒涨到秒级乃至超时。
// 改用同进程对照法，判定只依赖同机相对比较（机器快慢等比作用于所有测量，比值不随环境漂移）：
//   ① 规模倍增：恶意输入 500K→1M。线性实现的比值恒 ≤2（含固定开销：(ovh+2s)/(ovh+s)≤2），
//      本机实测 ~2.0–2.6；上限取 3.5×+40ms。纯二次实现比值→4，且加项要掩盖它需
//      500K 档 ≤80ms——500K 个 & 的二次扫描 ≥1.2e11 次字符比较，JS 里不可能在 80ms 内完成，
//      故纯二次必红。任务简报建议的 4–6 用在 ×2 规模上会直接放过 4× 的纯二次回归，故收紧。
//   ② 绝对对照：与同尺寸、无 & 的同构文档比（该文档不进入 & 扫描路径，回归时耗时不变），
//      1M 恶意档须 ≤max(500ms, 100×对照)。①只防超线性、放行「线性但常数级爆炸」，②补住这一
//      与「不超时」等价的洞；500ms 地板给本机/常规 CI，超慢机上由 100×对照随机器速度放大，
//      不再是死的 200ms。
// 计时纪律：先预热 1 次进入 JIT 稳态；三档交错测量取 3 次最小值（最小值≈纯计算成本，
// 调度抢占与 GC 只抬高个别样本），交错使中途整体变慢等比作用于各档而不扭曲比值。
test("BING-001 解析：1MB 恶意 & 串线性扫描守护（同进程对照：规模 ×2 耗时 ≤3.5×+40ms，绝对耗时 ≤max(500ms, 100×无&对照)，审阅缺口 4）", async (t) => {
  const bing = await loadBingBackend(t, CLAUSE);
  const hostHalf = "&".repeat(500_000);
  const hostFull = "&".repeat(1_000_000);
  const safeFull = "x".repeat(1_000_000); // 同尺寸线性对照：无 & → decodeEntities 早退，& 扫描回归不影响它

  const measureMs = async (description) => {
    const { ctx, fetch } = makeBingCtx();
    routeBing(fetch, {
      status: 200,
      body: rssDoc(rssItem({ title: "perf sample", link: "https://perf-sample.host.test/doc", description })),
      headers: RSS_HEADERS,
    });
    const startedAt = performance.now();
    const res = await settle(bing.search(ctx));
    const elapsedMs = performance.now() - startedAt;
    assert.equal(res.ok, true, `前置：性能样本须成功解析（BING-001），实际错误：${res.error?.code ?? ""} ${res.error?.message ?? ""}`);
    return elapsedMs;
  };

  await measureMs(hostFull); // 预热：JIT 稳态后再计时

  let halfMs = Infinity;
  let fullMs = Infinity;
  let safeMs = Infinity;
  for (let round = 0; round < 3; round += 1) {
    halfMs = Math.min(halfMs, await measureMs(hostHalf));
    fullMs = Math.min(fullMs, await measureMs(hostFull));
    safeMs = Math.min(safeMs, await measureMs(safeFull));
  }

  const ratioCapMs = 3.5 * halfMs + 40;
  assert.ok(
    fullMs <= ratioCapMs,
    `1MB 恶意 & 串耗时须随规模线性增长：500K=${halfMs.toFixed(1)}ms → 1M=${fullMs.toFixed(1)}ms（比值 ${(fullMs / halfMs).toFixed(2)}，上限 3.5×+40ms=${ratioCapMs.toFixed(1)}ms）。` +
      "线性 O(n) 期望 ~×2；若退化为逐 & 二次扫描期望 ~×4 且绝对耗时秒级。",
  );

  const absCapMs = Math.max(500, 100 * safeMs);
  assert.ok(
    fullMs <= absCapMs,
    `1MB 恶意 & 串绝对耗时须留在非超时区间：${fullMs.toFixed(1)}ms ≤ max(500ms, 100×同尺寸无&对照 ${safeMs.toFixed(1)}ms)=${absCapMs.toFixed(1)}ms（对照随机器速度缩放，替代原先死的 200ms 阈值）。`,
  );
});
