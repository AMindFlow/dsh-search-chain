// WP87 fetch 接管 Oracle — FT-005 SSRF 边界与重定向逐 hop 过闸（全枚举矩阵）。
// 行号 S-xx 与 docs/specs/draft/fetch-takeover-oracle.md §5 一一对应；改行必须两处同改。
// 观测面：provider.fetch(url) 码 + 文案脱敏（assertBlocked）+ fake-fetch 零出站（default:"never"，
// 任何未声明出站直接抛错）。归一化列为 Node new URL() 实测值。
// 码白名单含 WEB_INVALID_URL 的行 = OQ-O1 未裁决面（parse 失败/超长），裁决后收紧为单码。
import test from "node:test";
import assert from "node:assert/strict";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { createControlledClock, flush } from "./helpers/clock.js";
import { createFakeFetch } from "./helpers/fake-fetch.js";
import { createFakeTransportFactory } from "./helpers/fake-transport.js";
import {
  FETCH_PROVIDER_ID, mountFetch, makeFetchConfig, assertBlocked, assertNoLeak,
  withSecrets, LEAK_MARKER, SECRET_PATH,
} from "./helpers/fetch-oracle.js";

const WP = "WP87 src/index.js + fetch 链（SSRF 闸）";
const BLOCK = ["WEB_BLOCKED_URL"];
const EITHER_OQ1 = ["WEB_BLOCKED_URL", "WEB_INVALID_URL"]; // OQ-O1：parse 失败面双码待裁决
const EITHER_OQ2 = ["WEB_BLOCKED_URL", "WEB_INVALID_URL"]; // OQ-O2：超长码规格 vs 宿主先例待裁决

const fetchEntry = () => ({
  id: "fe-1", type: "tavily-extract", name: "Tavily Extract", enabled: true, credentialRef: "TAVILY_API_KEY",
});

async function gate(t, { dns } = {}) {
  const res = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, res, WP, "FT-005")) return null;
  const clock = createControlledClock();
  const fetchFn = createFakeFetch({ default: "never", clock });
  const cfg = makeFetchConfig({ fetchTakeover: true, fetchEntries: [fetchEntry()] });
  const fetchDeps = {
    transport: createFakeTransportFactory({ fetchImpl: fetchFn }),
    clock, env: {},
    ...(dns ? { dns } : {}),
  };
  const m = await mountFetch(res.module, cfg, { fetchDeps });
  assert.ok(m.provider, "fetch provider 必须已注册（FT-001）");
  return { m, fetchFn };
}

/** 提取商成功应答体（OQ-O3 假定字段：final_url 必有、redirect_hops 可选）。 */
const extractOk = (finalUrl, content = "public-body") => ({
  status: 200, body: { results: [{ url: finalUrl, raw_content: content, response_code: 200 }] },
});

// 每行：{ id, url(或 mk), codes, hosts=文案禁现的 host 字面变体, categoryHints=[类别词], schemeHint, allow? }
const L = SECRET_PATH; // /secretpath 尾缀由 withSecrets 统一装饰
const rows = [
  // R1 scheme
  { id: "S-01", url: `file:///${L}`, codes: BLOCK, hosts: [], schemeHint: "file", categoryHints: ["scheme"] },
  { id: "S-02", url: `gopher://127.0.0.1:6379/${L}`, codes: BLOCK, hosts: ["127.0.0.1", "6379"], schemeHint: "gopher", categoryHints: ["scheme"] },
  { id: "S-03", url: `data:text/html,${L}`, codes: EITHER_OQ1, hosts: [], schemeHint: "data", categoryHints: ["scheme"] },
  { id: "S-04", url: `javascript:alert(1)`, codes: EITHER_OQ1, hosts: [], schemeHint: "javascript", categoryHints: ["scheme"] },
  { id: "S-05", url: `FILE://host.invalid/${L}`, codes: BLOCK, hosts: [], schemeHint: "file", categoryHints: ["scheme"] },
  { id: "S-06", url: ` file://host.invalid/${L}`, codes: BLOCK, hosts: [], schemeHint: "file", categoryHints: ["scheme"] },
  { id: "S-07", url: `file\t://host.invalid/${L}`, codes: BLOCK, hosts: [], schemeHint: "file", categoryHints: ["scheme"] },
  { id: "S-08", url: `https://pub.example.com/docs`, allow: "https://pub.example.com/docs" },
  // R2 内嵌凭据
  { id: "S-09", url: `http://secretuser:secretpass@pub.invalid/${L}`, codes: BLOCK, hosts: ["pub.invalid"], categoryHints: ["凭据"] },
  { id: "S-10", url: `http://secretuser@pub.invalid/${L}`, codes: BLOCK, hosts: ["pub.invalid"], categoryHints: ["凭据"] },
  { id: "S-11", url: `http://secretuser:secretpass@127.0.0.1/${L}`, codes: BLOCK, hosts: ["127.0.0.1"], categoryHints: ["凭据"] },
  // R3 超长（S-13 对照）
  { id: "S-12", raw: true, url: `http://pub.invalid/${"a".repeat(2030)}`, codes: EITHER_OQ2, hosts: [], categoryHints: ["超长"] }, // 总长恰 2049
  { id: "S-13", raw: true, url: `http://pub.invalid/${"b".repeat(2029)}`, allow: "http://pub.invalid/" }, // 总长恰 2048 对照
  // R4 localhost/空 host
  { id: "S-14", url: `http://localhost/${L}`, codes: BLOCK, hosts: ["localhost"], categoryHints: ["localhost"] },
  { id: "S-15", url: `http://localhost./${L}`, codes: BLOCK, hosts: ["localhost"], categoryHints: ["localhost"] },
  { id: "S-16", url: `http://api.localhost/${L}`, codes: BLOCK, hosts: ["api.localhost", "localhost"], categoryHints: ["localhost"] },
  { id: "S-17", url: `https://sub.deep.localhost:8443/${L}`, codes: BLOCK, hosts: ["localhost", "8443"], categoryHints: ["localhost"] },
  { id: "S-18", url: `http://LOCALHOST/${L}`, codes: BLOCK, hosts: ["localhost", "LOCALHOST"], categoryHints: ["localhost"] },
  { id: "S-19", url: `http:///${L}`, codes: EITHER_OQ1, hosts: [], categoryHints: ["host"] },
  // R5a IPv4 段（每段字面 + 等价绕过 + 归一化）
  { id: "S-20a", url: `http://127.0.0.1/${L}`, codes: BLOCK, hosts: ["127.0.0.1"], categoryHints: ["环回"] },
  { id: "S-20b", url: `http://2130706433/${L}`, codes: BLOCK, hosts: ["127.0.0.1", "2130706433"], categoryHints: ["环回"] },
  { id: "S-20c", url: `http://0x7f000001/${L}`, codes: BLOCK, hosts: ["127.0.0.1", "0x7f000001"], categoryHints: ["环回"] },
  { id: "S-20d", url: `http://0x7f.0x0.0x0.0x1/${L}`, codes: BLOCK, hosts: ["127.0.0.1"], categoryHints: ["环回"] },
  { id: "S-20e", url: `http://0177.0.0.1/${L}`, codes: BLOCK, hosts: ["127.0.0.1", "0177.0.0.1"], categoryHints: ["环回"] },
  { id: "S-20f", url: `http://017700000001/${L}`, codes: BLOCK, hosts: ["127.0.0.1"], categoryHints: ["环回"] },
  { id: "S-20g", url: `http://127.1/${L}`, codes: BLOCK, hosts: ["127.0.0.1", "127.1"], categoryHints: ["环回"] },
  { id: "S-20h", url: `http://127.0.1/${L}`, codes: BLOCK, hosts: ["127.0.0.1"], categoryHints: ["环回"] },
  { id: "S-20i", url: `http://127.255.255.255/${L}`, codes: BLOCK, hosts: ["127.255.255.255"], categoryHints: ["环回"] },
  { id: "S-20j", url: `http://127.0.0.1./${L}`, codes: BLOCK, hosts: ["127.0.0.1"], categoryHints: ["环回"] },
  { id: "S-21a", url: `http://10.0.0.1/${L}`, codes: BLOCK, hosts: ["10.0.0.1"], categoryHints: ["私网"] },
  { id: "S-21b", url: `http://167772161/${L}`, codes: BLOCK, hosts: ["10.0.0.1", "167772161"], categoryHints: ["私网"] },
  { id: "S-21c", url: `http://012.0.0.1/${L}`, codes: BLOCK, hosts: ["10.0.0.1", "012.0.0.1"], categoryHints: ["私网"] },
  { id: "S-21d", url: `http://10/${L}`, codes: BLOCK, hosts: ["0.0.0.10"], categoryHints: ["保留"] }, // WHATWG→0.0.0.10 → 0/8
  { id: "S-21e", url: `http://10.255.255.255/${L}`, codes: BLOCK, hosts: ["10.255.255.255"], categoryHints: ["私网"] },
  { id: "S-22a", url: `http://172.16.0.1/${L}`, codes: BLOCK, hosts: ["172.16.0.1"], categoryHints: ["私网"] },
  { id: "S-22b", url: `http://172.31.255.255/${L}`, codes: BLOCK, hosts: ["172.31.255.255"], categoryHints: ["私网"] },
  { id: "S-22c", url: `http://0xac100001/${L}`, codes: BLOCK, hosts: ["172.16.0.1", "0xac100001"], categoryHints: ["私网"] },
  { id: "S-22d", url: `http://172.15.0.1/${L}`, allow: "http://172.15.0.1/" },
  { id: "S-22e", url: `http://172.32.0.1/${L}`, allow: "http://172.32.0.1/" },
  { id: "S-23a", url: `http://192.168.1.1/${L}`, codes: BLOCK, hosts: ["192.168.1.1"], categoryHints: ["私网"] },
  { id: "S-23b", url: `http://3232235777/${L}`, codes: BLOCK, hosts: ["192.168.1.1", "3232235777"], categoryHints: ["私网"] },
  { id: "S-23c", url: `http://0300.0250.0.1/${L}`, codes: BLOCK, hosts: ["192.168.0.1", "0300.0250.0.1"], categoryHints: ["私网"] },
  { id: "S-23d", url: `http://192.168.1/${L}`, codes: BLOCK, hosts: ["192.168.0.1", "192.168.1"], categoryHints: ["私网"] },
  { id: "S-24a", url: `http://169.254.169.254/${L}`, codes: BLOCK, hosts: ["169.254.169.254"], categoryHints: ["链路本地"] },
  { id: "S-24b", url: `http://2852039166/${L}`, codes: BLOCK, hosts: ["169.254.169.254", "2852039166"], categoryHints: ["链路本地"] },
  { id: "S-24c", url: `http://169.254.1.1/${L}`, codes: BLOCK, hosts: ["169.254.1.1"], categoryHints: ["链路本地"] },
  { id: "S-25a", url: `http://0.0.0.0/${L}`, codes: BLOCK, hosts: ["0.0.0.0"], categoryHints: ["保留"] },
  { id: "S-25b", url: `http://0/${L}`, codes: BLOCK, hosts: ["0.0.0.0"], categoryHints: ["保留"] },
  { id: "S-25c", url: `http://0.255.255.255/${L}`, codes: BLOCK, hosts: ["0.255.255.255"], categoryHints: ["保留"] },
  { id: "S-26a", url: `http://100.64.0.1/${L}`, codes: BLOCK, hosts: ["100.64.0.1"], categoryHints: ["保留"] },
  { id: "S-26b", url: `http://100.127.255.255/${L}`, codes: BLOCK, hosts: ["100.127.255.255"], categoryHints: ["保留"] },
  { id: "S-26c", url: `http://100.128.0.1/${L}`, allow: "http://100.128.0.1/" },
  { id: "S-27a", url: `http://224.0.0.1/${L}`, codes: BLOCK, hosts: ["224.0.0.1"], categoryHints: ["组播"] },
  { id: "S-27b", url: `http://239.255.255.255/${L}`, codes: BLOCK, hosts: ["239.255.255.255"], categoryHints: ["组播"] },
  { id: "S-27c", url: `http://240.0.0.0/${L}`, codes: BLOCK, hosts: ["240.0.0.0"], categoryHints: ["保留"] },
  { id: "S-28", url: `http://255.255.255.255/${L}`, codes: BLOCK, hosts: ["255.255.255.255"], categoryHints: ["广播"] },
  { id: "S-29", url: `http://2130706433:8080/${L}`, codes: BLOCK, hosts: ["127.0.0.1", "2130706433", "8080"], categoryHints: ["环回"] },
  // R5b IPv6
  { id: "S-30", url: `http://[::1]/${L}`, codes: BLOCK, hosts: ["::1"], categoryHints: ["环回"] },
  { id: "S-31", url: `http://[0:0:0:0:0:0:0:1]/${L}`, codes: BLOCK, hosts: ["::1", "0:0:0:0:0:0:0:1"], categoryHints: ["环回"] },
  { id: "S-32", url: `http://[0::1]/${L}`, codes: BLOCK, hosts: ["::1"], categoryHints: ["环回"] },
  { id: "S-33", url: `http://[::ffff:127.0.0.1]/${L}`, codes: BLOCK, hosts: ["127.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1"], categoryHints: ["环回"] },
  { id: "S-34", url: `http://[::127.0.0.1]/${L}`, codes: BLOCK, hosts: ["127.0.0.1", "::127.0.0.1", "::7f00:1"], categoryHints: ["环回"] }, // IPv4 兼容形态须解压判定
  { id: "S-35", url: `http://[::ffff:7f00:1]/${L}`, codes: BLOCK, hosts: ["127.0.0.1", "::ffff:7f00:1"], categoryHints: ["环回"] },
  { id: "S-36", url: `http://[::]/${L}`, codes: BLOCK, hosts: ["::"], categoryHints: ["未指定"] },
  { id: "S-36b", url: `http://[::ffff:0:0]/${L}`, codes: BLOCK, hosts: ["0.0.0.0"], categoryHints: ["保留"] },
  { id: "S-37a", url: `http://[fc00::1]/${L}`, codes: BLOCK, hosts: ["fc00::1"], categoryHints: ["私网"] },
  { id: "S-37b", url: `http://[fd12:3456::1]/${L}`, codes: BLOCK, hosts: ["fd12:3456::1"], categoryHints: ["私网"] },
  { id: "S-38a", url: `http://[fe80::1]/${L}`, codes: BLOCK, hosts: ["fe80::1"], categoryHints: ["链路本地"] },
  { id: "S-38b", url: `http://[fe80:1::2]/${L}`, codes: BLOCK, hosts: ["fe80"], categoryHints: ["链路本地"] },
  { id: "S-38c", url: `http://[febf::1]/${L}`, codes: BLOCK, hosts: ["febf::1"], categoryHints: ["链路本地"] },
  { id: "S-39", url: `http://[::ffff:192.168.1.1]/${L}`, codes: BLOCK, hosts: ["192.168.1.1"], categoryHints: ["私网"] },
  { id: "S-39b", url: `http://[::ffff:a]/${L}`, codes: BLOCK, hosts: ["10.0.0.0"], categoryHints: ["私网"] },
];

for (const row of rows.filter((r) => !r.allow)) {
  test(`FT-005 ${row.id}：${JSON.stringify(row.url.slice(0, 40))} → 拒绝零出站`, async (t) => {
    const g = await gate(t);
    if (!g) return;
    const url = row.raw ? row.url : withSecrets(row.url);
    await assert.rejects(g.m.provider.fetch({ url }), (e) => {
      assertBlocked(e, { codes: row.codes, forbidden: row.hosts, categoryHints: row.categoryHints, schemeHint: row.schemeHint });
      return true;
    }, `${row.id} 必须以 ${row.codes.join("/")} 拒绝`);
    await flush();
    assert.equal(g.fetchFn.calls.length, 0, `${row.id} 闸拒绝必须零出站（fake-fetch never 无一命中）`);
    await g.m.dispose();
  });
}

for (const row of rows.filter((r) => r.allow)) {
  test(`FT-005 ${row.id}：对照不误拦 ${row.url.slice(0, 46)}`, async (t) => {
    const g = await gate(t);
    if (!g) return;
    g.fetchFn.when(/.*/).responds(extractOk(row.allow));
    const res = await g.m.provider.fetch({ url: row.url });
    assert.equal(res.statusCode, 200, `${row.id} 对照行必须完整通过`);
    assert.ok(g.fetchFn.calls.length >= 1);
    await g.m.dispose();
  });
}

// ── R7 尽力预解析（OQ-O6：fetchDeps.dns 注入桩）──────────────────────────────
const dnsTable = {
  "evil.test": ["127.0.0.1"],
  "multi.test": ["::1", "93.184.216.34"], // 任一命中即拒
};
const dnsStub = {
  async lookup(host) {
    if (host in dnsTable) return dnsTable[host];
    const err = new Error(`ENOTFOUND ${host}`);
    err.code = "ENOTFOUND";
    throw err;
  },
};

test("FT-005 S-40/S-41：预解析命中环回/多 A 任一命中 → 拒绝且提取商零出站", async (t) => {
  const g = await gate(t, { dns: dnsStub });
  if (!g) return;
  for (const host of Object.keys(dnsTable)) {
    await assert.rejects(g.m.provider.fetch({ url: withSecrets(`http://${host}/${L}`) }),
      (e) => (assertBlocked(e, { codes: BLOCK, hosts: [host], categoryHints: ["环回"] }), true), `${host} 必须被拒`);
  }
  assert.equal(g.fetchFn.calls.length, 0, "预解析命中即拒：提取商零出站");
  await g.m.dispose();
});

test("FT-005 S-42：解析失败=未定可外发（尽力而为），交由提取商失败", async (t) => {
  const g = await gate(t, { dns: dnsStub });
  if (!g) return;
  g.fetchFn.when(/.*/).responds({ status: 500, body: { detail: "vendor-side failure" } });
  await assert.rejects(g.m.provider.fetch({ url: withSecrets(`http://fail.test/${L}`) }),
    (e) => typeof e?.code === "string", "提取商失败按 FB-005 带码归类");
  assert.equal(g.fetchFn.calls.length, 1, "解析失败不视为命中：放行一次外发");
  await g.m.dispose();
});

// ── R7 重定向链 fixture（内容零回传专项）─────────────────────────────────────
const leaked = `page-body ${LEAK_MARKER} tail`;
test("FT-005 R-1：链报 公网→私网 且已带回正文 → 整份作废零回传", async (t) => {
  const g = await gate(t);
  if (!g) return;
  g.fetchFn.when(/.*/).responds({
    status: 200,
    body: {
      results: [{
        url: `http://192.168.1.1/b`, // final_url 私网
        redirect_hops: [`http://pub-a.invalid/a`, `http://192.168.1.1/b`],
        raw_content: leaked,
        response_code: 200,
      }],
    },
  });
  await assert.rejects(g.m.provider.fetch({ url: "http://pub-a.invalid/a" }),
    (e) => (assertBlocked(e, { codes: BLOCK, hosts: ["192.168.1.1"], categoryHints: ["私网"] }), true));
  await g.m.dispose();
});

test("FT-005 R-2：链报 公网→公网→环回 → 整份作废零回传", async (t) => {
  const g = await gate(t);
  if (!g) return;
  g.fetchFn.when(/.*/).responds({
    status: 200,
    body: {
      results: [{
        url: "http://127.0.0.1:9/x", // final_url 环回
        redirect_hops: ["http://pub-a.invalid/a", "http://pub-b.invalid/b", "http://127.0.0.1:9/x"],
        raw_content: leaked,
        response_code: 200,
      }],
    },
  });
  await assert.rejects(g.m.provider.fetch({ url: "http://pub-a.invalid/a" }),
    (e) => (assertBlocked(e, { codes: BLOCK, hosts: ["127.0.0.1"], categoryHints: ["环回"] }), true));
  await g.m.dispose();
});

test("FT-005 R-2b：仅报最终 URL（环回）无 hop 链 → 终闸同拒，正文不外传", async (t) => {
  const g = await gate(t);
  if (!g) return;
  g.fetchFn.when(/.*/).responds({
    status: 200,
    body: { results: [{ url: "http://127.0.0.1:9/x", raw_content: leaked, response_code: 200 }] },
  });
  await assert.rejects(g.m.provider.fetch({ url: "http://pub-a.invalid/a" }),
    (e) => (assertBlocked(e, { codes: BLOCK, hosts: ["127.0.0.1"], categoryHints: ["环回"] }), true), "终闸缺 hop 链也必须拒");
  await g.m.dispose();
});

test("FT-005 R-3：对照全公网链完整通过", async (t) => {
  const g = await gate(t);
  if (!g) return;
  g.fetchFn.when(/.*/).responds({
    status: 200,
    body: {
      results: [{
        url: "http://pub-b.invalid/final",
        redirect_hops: ["http://pub-a.invalid/a", "http://pub-b.invalid/final"],
        raw_content: "clean-public-body",
        response_code: 200,
      }],
    },
  });
  const res = await g.m.provider.fetch({ url: "http://pub-a.invalid/a" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.content, "clean-public-body", "正文透传");
  assert.equal(res.url, "http://pub-b.invalid/final", "url=回报最终 URL");
  assertNoLeak(res, "对照链");
  await g.m.dispose();
});
