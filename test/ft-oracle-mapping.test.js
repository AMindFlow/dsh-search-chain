// WP87 fetch 接管 Oracle — FT-008 传输/预算/结果映射 + FT-009 首期提取商范围与接口预留。
// 提取商应答体字段面 = OQ-O3 假定（results[].url/raw_content/response_code；更名只改本文件 extractBody）。
// FT-009#7 真实付费调用 = 发布项（本骨架不执行，规格 FT-009 与 lead 裁决一致）。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { createControlledClock, flush } from "./helpers/clock.js";
import { createFakeFetch } from "./helpers/fake-fetch.js";
import { createFakeTransportFactory } from "./helpers/fake-transport.js";
import { createFakeCredentials } from "./helpers/fake-credentials.js";
import { mountFetch, makeFetchConfig, assertFetchResultShape } from "./helpers/fetch-oracle.js";

const WP = "WP87 fetch 映射（tavily-extract）";
const URL_PUBLIC = "https://pub.example.com/docs";
const MAX_BODY_CHARS = 100_000; // 宿主官方 WEB_FETCH_MAX_BODY_CHARS 常量实证值
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // src/constants.js MAX_RESPONSE_BYTES（提取商响应体上限）

function fetchEntry(over = {}) {
  return { id: "fe-1", type: "tavily-extract", name: "Tavily Extract", enabled: true, credentialRef: "fleetseek/fetch/fe-1", ...over };
}

async function gate(t, { fetchOfficialFallback = false, extra = {} } = {}) {
  const res = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, res, WP, "FT-008/009")) return null;
  const clock = createControlledClock();
  const fetchFn = createFakeFetch({ default: "never", clock });
  const config = makeFetchConfig({ fetchTakeover: true, fetchEntries: [fetchEntry()], fetchOfficialFallback, ...extra });
  const m = await mountFetch(res.module, config, {
    fetchDeps: {
      transport: createFakeTransportFactory({ fetchImpl: fetchFn }),
      clock, env: {},
      credentials: createFakeCredentials({ refs: { "fleetseek/fetch/fe-1": "sk-synthetic-fe1-KEY-DO-NOT-LOG" } }),
    },
  });
  assert.ok(m.provider, "fetch provider 必须已注册（FT-001）");
  return { m, fetchFn, clock };
}

/** 提取商成功体（OQ-O3 假定面单点）。 */
const extractBody = ({ url = URL_PUBLIC, content = "plain-body", code = 200, hops } = {}) => ({
  status: 200,
  body: {
    results: [{
      url,
      raw_content: content,
      response_code: code,
      ...(hops ? { redirect_hops: hops } : {}),
    }],
  },
});

// ───────────────────────── FT-008 结果映射 ─────────────────────────

test("FT-008#2 body.kind 恒 text：正文/markdown/类 html 全 fixture 不伪造 html 不自创 kind", async (t) => {
  const fixtures = [
    { label: "plain", content: "hello text" },
    { label: "markdown", content: "# 标题\n\n**粗体** 与 [链接](https://x.invalid)" },
    { label: "html-source", content: "<!DOCTYPE html><html><body><p>raw html passthrough</p></body></html>" },
    { label: "empty", content: "" },
  ];
  for (const f of fixtures) {
    const g = await gate(t);
    if (!g) return;
    g.fetchFn.when(/.*/).responds(extractBody({ content: f.content }));
    const res = await g.m.provider.fetch({ url: URL_PUBLIC });
    assertFetchResultShape(res, { kind: "text" });
    assert.ok(["html", "text"].includes(res.body.kind), `宿主封闭联合内取值（${f.label}）`);
    assert.equal(res.body.kind, "text", `提取正文如实 text（${f.label}，D-FT5）`);
    await g.m.dispose();
  }
});

test("FT-008#3 url=回报最终 URL；缺回报回落请求 URL", async (t) => {
  const g1 = await gate(t);
  if (!g1) return;
  const final = "https://pub.example.com/final?redirected=1";
  g1.fetchFn.when(/.*/).responds(extractBody({ url: final }));
  const r1 = await g1.m.provider.fetch({ url: URL_PUBLIC });
  assert.equal(r1.url, final, "最终 URL 优先");
  await g1.m.dispose();

  const g2 = await gate(t);
  if (!g2) return;
  g2.fetchFn.when(/.*/).responds({ status: 200, body: { results: [{ raw_content: "x", response_code: 200 }] } }); // 无 url 字段
  const r2 = await g2.m.provider.fetch({ url: URL_PUBLIC });
  assert.equal(r2.url, URL_PUBLIC, "提取商不回报最终 URL 时 = 请求 URL");
  await g2.m.dispose();
});

test("FT-008#4/#5 statusCode：非 2xx 是结果不是异常；缺回报以提取商状态映射", async (t) => {
  const g = await gate(t);
  if (!g) return;
  g.fetchFn.when(/.*/).responds(extractBody({ code: 404, content: "not found page body" }));
  const res = await g.m.provider.fetch({ url: URL_PUBLIC }); // resolve，不 reject
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.content, "not found page body");
  assertFetchResultShape(res);
  await g.m.dispose();

  const g2 = await gate(t);
  if (!g2) return;
  g2.fetchFn.when(/.*/).responds({ status: 200, body: { results: [{ url: URL_PUBLIC, raw_content: "y" }] } }); // 无 response_code
  const r2 = await g2.m.provider.fetch({ url: URL_PUBLIC });
  assert.equal(r2.statusCode, 200, "缺页面码时以提取商自身状态映射");
  await g2.m.dispose();
});

test("FT-008#6 解码正文 100k 截断两侧边界", async (t) => {
  const left = "字".repeat(MAX_BODY_CHARS); // ASCII 等价可用 "a"；用 ascii 稳
  const ascii = (n) => "a".repeat(n);
  for (const [n, expectTrunc] of [[MAX_BODY_CHARS, false], [MAX_BODY_CHARS + 1, true]]) {
    const g = await gate(t);
    if (!g) return;
    void left;
    g.fetchFn.when(/.*/).responds(extractBody({ content: ascii(n) }));
    const res = await g.m.provider.fetch({ url: URL_PUBLIC });
    assert.equal(res.truncated, expectTrunc, `len=${n} → truncated=${expectTrunc}`);
    assert.ok(res.body.content.length <= MAX_BODY_CHARS, "解码正文不越上限");
    await g.m.dispose();
  }
});

test("FT-008#7 提取商响应体 >2MiB：早停归类提取商失败，不产出伪造/半截正文", async (t) => {
  const g = await gate(t, { fetchOfficialFallback: false });
  if (!g) return;
  const huge = "x".repeat(MAX_RESPONSE_BYTES + 1024);
  g.fetchFn.when(/.*/).responds({ status: 200, body: { results: [{ url: URL_PUBLIC, raw_content: huge, response_code: 200 }] } });
  await assert.rejects(g.m.provider.fetch({ url: URL_PUBLIC }), (e) => {
    assert.ok(typeof e?.code === "string", "超限必须带码（FB-005 异常响应归类）");
    assert.ok(!String(e?.message).includes("xxxxx"), "错误不得回带大块正文");
    return true;
  });
  await g.m.dispose();
});

test("FT-008#8 提取商自身 401/429 → FB-005 归类进链决策（attempts 原码）", async (t) => {
  for (const [status, expectCode] of [[401, "ENTRY_CREDENTIALS"], [429, "ENTRY_RATE_LIMITED"]]) {
    const g = await gate(t, { fetchOfficialFallback: false });
    if (!g) return;
    g.fetchFn.when(/.*/).responds({ status, body: { detail: "vendor auth/rate" } });
    await assert.rejects(g.m.provider.fetch({ url: URL_PUBLIC }), (e) => {
      const dump = `${String(e?.code)} ${JSON.stringify(e?.details ?? {})}`;
      assert.ok(dump.includes(expectCode), `提取商 HTTP ${status} 须归 ${expectCode}（FB-005），实得 ${dump}`);
      return true;
    });
    await g.m.dispose();
  }
});

test("FT-008#9 无正文场景不注入占位文本", async (t) => {
  const g = await gate(t);
  if (!g) return;
  g.fetchFn.when(/.*/).responds(extractBody({ code: 204, content: "" }));
  const res = await g.m.provider.fetch({ url: URL_PUBLIC });
  assert.equal(res.statusCode, 204);
  assert.equal(res.body.content, "", "无正文 = 空串，不得伪造占位");
  await g.m.dispose();
});

// ───────────────────────── FT-009 首期范围与预留 ─────────────────────────

test("FT-009#2 免 key fetch 条目形态：写闸拒绝且原因可读", async () => {
  const cfgMod = await tryImportSrc("config.js");
  assert.ok(cfgMod.ok);
  const { writeConfig } = cfgMod.module;
  const { createFakeHost } = await import("./helpers/fake-host.js");
  const host = createFakeHost({ config: makeFetchConfig() });
  await assert.rejects(
    cfgMod.module.writeConfig(host.settingsPort, structuredClone(
      makeFetchConfig({ fetchTakeover: true, fetchEntries: [{ id: "fe-k", type: "tavily-extract", name: "T", enabled: true }] }),
    )),
    (e) => e?.code === "CONFIG_INVALID" && /key|凭据|credential/i.test(String(e?.message)),
    "首期 fetch 条目必须要求 key（FT-009 免 key 拒 + 可操作原因）",
  );
  void writeConfig;
});

test("FT-009#6 scripts/oracle-style-50.mjs 零改动基线钉", () => {
  const buf = readFileSync(new URL("../scripts/oracle-style-50.mjs", import.meta.url));
  const sha = createHash("sha256").update(buf).digest("hex");
  assert.equal(sha, "7f347309aa7b8c57d92c1b5dc44f2823ffa9ef71ab84b43ca2072716698b0d80",
    "FT-009 红线：设置面板 oracle 与 CATALOG_TEXT 零改动（CATALOG_TEXT 内嵌目录不含 fetch 类型）");
});

test("FT-009#6b CATALOG_TEXT 不混入 fetch 目录：oracle-style-50 内容面钉", () => {
  const src = readFileSync(new URL("../scripts/oracle-style-50.mjs", import.meta.url), "utf8");
  assert.ok(!src.includes("tavily-extract"), "CATALOG_TEXT 不得混入 fetch 类型（FT-009#3 设置目录口径）");
});

test("FT-009#4 端到端三态（成功/提取商失败/超限）经链语义齐备", async (t) => {
  // 成功
  const ok = await gate(t);
  if (!ok) return;
  ok.fetchFn.when(/.*/).responds(extractBody({ content: "ok-body" }));
  const r = await ok.m.provider.fetch({ url: URL_PUBLIC });
  assert.equal(r.body.content, "ok-body");
  await ok.m.dispose();
  // 失败（网络级）
  const bad = await gate(t);
  if (!bad) return;
  bad.fetchFn.when(/.*/).fails({ error: new Error("vendor 500") });
  await assert.rejects(bad.m.provider.fetch({ url: URL_PUBLIC }));
  await flush();
  await bad.m.dispose();
  // 超限在 FT-008#7 专项，去重不重复。
});
