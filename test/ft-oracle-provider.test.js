// WP87 fetch 接管 Oracle — FT-001 注册和释放 / FT-002 可用性与调用边界 / FT-003 开关默认关与迁移。
// 条款与观测面：docs/specs/draft/fetch-takeover-oracle.md §1（矩阵编号 FT-001#n 对应 test 名 #n）。
// 契约假定：helpers/fetch-oracle.js 头注释 D1（deps.fetchDeps 注入面）。
// 实现方转绿规则同 helpers/impl.js：只许实现，不许删断言/skip。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { createControlledClock, flush } from "./helpers/clock.js";
import { createFakeFetch } from "./helpers/fake-fetch.js";
import { createFakeTransportFactory } from "./helpers/fake-transport.js";
import { createFakeCredentials } from "./helpers/fake-credentials.js";
import { createLogCapture } from "./helpers/redact.js";
import {
  FETCH_PROVIDER_ID, HTTP_HOST_ID, createWebSeam, mountFetch, makeFetchConfig,
  assertFetchResultShape, stubSearchChain,
} from "./helpers/fetch-oracle.js";

const WP = "WP87 src/index.js + fetch 链";

function harness({ config, pin } = {}) {
  const clock = createControlledClock();
  const fetchFn = createFakeFetch({ default: "never", clock });
  const transport = createFakeTransportFactory({ fetchImpl: fetchFn });
  const credentials = createFakeCredentials();
  const log = createLogCapture();
  return {
    clock,
    fetchFn,
    log,
    config,
    fetchDeps: { transport, clock, credentials, env: {}, log },
    pin,
  };
}

async function load(t) {
  const res = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, res, WP, "FT-001/002/003")) return null;
  return res.module;
}

const PUBLIC_URL = "https://pub.example.com/docs?q=SECRETQUERY#SECRETFRAG";
const TAVILY_TYPE = "tavily-extract"; // OQ-O8：常量命名如变，只改这里 + helper
function fetchEntry(over = {}) {
  return { id: "fe-1", type: TAVILY_TYPE, name: "Tavily Extract", enabled: true, credentialRef: "TAVILY_API_KEY", ...over };
}

// ───────────────────────────── FT-001 ─────────────────────────────

test("FT-001#1/#3/#6 apply 恰一 fetch 注册（id=search-chain）、http 未被遮蔽、不写宿主 web 行", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const h = harness({ config: makeFetchConfig() });
  const m = await mountFetch(mod, h.config, { fetchDeps: h.fetchDeps, chain: stubSearchChain() });
  assert.ok(m.provider, "fetch provider 必须已注册于 fetch registry（FT-001，未注册即红属预期）");
  assert.deepEqual(m.seam.ids(), [HTTP_HOST_ID, FETCH_PROVIDER_ID], "fetch 注册表 = 注册序 [http, search-chain]");
  assert.equal(m.seam.list().fetch.filter((p) => p.id === FETCH_PROVIDER_ID).length, 1);
  assert.equal(m.host.searchRegistrationCount(), 1, "搜索侧注册不受影响（DSH-001/v0.2.0 一致）");
  assert.equal(m.provider.id, FETCH_PROVIDER_ID);
  assert.equal(typeof m.provider.fetch, "function");
  assert.equal(m.httpRef.available(), true, "宿主 http 仍可用（不得遮蔽/注销）");
  const webRowWrites = m.host.editor.calls.filter((c) => JSON.stringify(c).includes("fetchProvider"));
  assert.equal(webRowWrites.length, 0, "插件不得写宿主 web 行（FT-003 两步显式）");
  await m.dispose();
});

test("FT-001#2/#3 第二个 fetch id 不得出现；装载期 registerFetchProvider 恰一次", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const h = harness({ config: makeFetchConfig() });
  const m = await mountFetch(mod, h.config, { fetchDeps: h.fetchDeps });
  assert.ok(m.provider, "fetch provider 必须已注册于 fetch registry（FT-001，未注册即红属预期）");
  const ids = m.seam.list().fetch.map((p) => p.id);
  assert.deepEqual(ids.filter((id) => id !== HTTP_HOST_ID), [FETCH_PROVIDER_ID], "本插件来源 fetch id 恒 {search-chain}");
  await m.dispose();
});

test("FT-001#2 seam 同构：同 id 重复注册抛 WEB_DUPLICATE_PROVIDER（宿主语义钉）", () => {
  const seam = createWebSeam();
  seam.registerHostHttp();
  seam.registerFetchProvider({ id: FETCH_PROVIDER_ID, available: () => false, fetch: async () => ({}) });
  assert.throws(
    () => seam.registerFetchProvider({ id: FETCH_PROVIDER_ID, available: () => false, fetch: async () => ({}) }),
    (e) => e.code === "WEB_DUPLICATE_PROVIDER",
  );
});

test("FT-001#4/#5 卸载反注册 + 本地监听零残留；重装不抛 WEB_DUPLICATE_PROVIDER 且恰一个", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const h = harness({ config: makeFetchConfig() });
  const m1 = await mountFetch(mod, h.config, { fetchDeps: h.fetchDeps });
  assert.ok(m1.provider, "fetch provider 必须已注册于 fetch registry（FT-001，未注册即红属预期）");
  await m1.dispose();
  assert.ok(!m1.seam.ids().includes(FETCH_PROVIDER_ID), "卸载后 fetch 注册表不含 search-chain");
  const m2 = await mountFetch(mod, h.config, { fetchDeps: h.fetchDeps }); // 重装 = 反注册后再注册路径
  assert.ok(m2.provider, "fetch provider 必须已注册于 fetch registry（FT-001，未注册即红属预期）");
  assert.equal(m2.seam.list().fetch.filter((p) => p.id === FETCH_PROVIDER_ID).length, 1, "重装后恰一个");
  await m2.dispose();
  assert.equal(m2.chain.released >= 1, true, "卸载释放 fetch 侧资源（连接/代理出站）");
});

// ───────────────────────────── FT-002 ─────────────────────────────

test("FT-002#1/#2 开关关：available() 同步 false，零网络", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const h = harness({ config: makeFetchConfig({ fetchTakeover: false, fetchEntries: [fetchEntry()] }) });
  const m = await mountFetch(mod, h.config, { fetchDeps: h.fetchDeps });
  assert.ok(m.provider, "fetch provider 必须已注册于 fetch registry（FT-001，未注册即红属预期）");
  const v = m.provider.available();
  assert.equal(typeof v, "boolean", "available() 必须同步返回布尔（非 Promise）");
  assert.equal(v, false);
  await flush();
  assert.equal(h.fetchFn.calls.length, 0, "available() 零网络（DSH-002/FT-002）");
  await m.dispose();
});

test("FT-002#3/#4 开关开：available()=true（含非法配置）；非法在执行期结构化报告", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  // 合法开
  const h1 = harness({ config: makeFetchConfig({ fetchTakeover: true, fetchEntries: [fetchEntry()] }) });
  const m1 = await mountFetch(mod, h1.config, { fetchDeps: h1.fetchDeps });
  assert.ok(m1.provider, "fetch provider 必须已注册于 fetch registry（FT-001，未注册即红属预期）");
  assert.equal(m1.provider.available(), true);
  await m1.dispose();
  // 非法形状仍 true，执行期拒
  const h2 = harness({ config: makeFetchConfig({ fetchTakeover: true, fetchEntries: [{ id: "bad" }] }) });
  const m2 = await mountFetch(mod, h2.config, { fetchDeps: h2.fetchDeps });
  assert.ok(m2.provider, "fetch provider 必须已注册于 fetch registry（FT-001，未注册即红属预期）");
  assert.equal(m2.provider.available(), true, "available() 只反映开关（D-FT2），非法配置不吞不改值");
  await assert.rejects(m2.provider.fetch({ url: PUBLIC_URL }), (e) => typeof e?.code === "string", "非法配置必须带码上抛（OQ-O5 集合内）");
  await m2.dispose();
});

test("FT-002#5 成功腿：seam 钉死后 fetch 返回映射 WebFetchResult", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const h = harness({ config: makeFetchConfig({ fetchTakeover: true, fetchEntries: [fetchEntry()] }), pin: FETCH_PROVIDER_ID });
  const m = await mountFetch(mod, h.config, { fetchDeps: h.fetchDeps, pin: h.pin });
  assert.ok(m.provider, "fetch provider 必须已注册于 fetch registry（FT-001，未注册即红属预期）");
  h.fetchFn.when(/.*/).responds({
    status: 200,
    body: { results: [{ url: PUBLIC_URL, raw_content: "正文-ok", response_code: 200 }] },
  });
  const picked = m.seam.select(h.pin);
  const res = await picked.fetch({ url: PUBLIC_URL });
  assertFetchResultShape(res);
  await m.dispose();
});

test("FT-002#6 取消两时点：WEB_ABORTED + 之后零后续出站", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  // 时点一：fetch 前已 abort
  const hA = harness({ config: makeFetchConfig({ fetchTakeover: true, fetchEntries: [fetchEntry()] }) });
  const mA = await mountFetch(mod, hA.config, { fetchDeps: hA.fetchDeps });
  assert.ok(mA.provider, "fetch provider 必须已注册于 fetch registry（FT-001，未注册即红属预期）");
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(mA.provider.fetch({ url: PUBLIC_URL }, ac.signal), (e) => e?.code === "WEB_ABORTED");
  assert.equal(hA.fetchFn.calls.length, 0, "abort 前置于 fetch：零出站");
  await mA.dispose();
  // 时点二：响应体读取中 abort
  const hB = harness({ config: makeFetchConfig({ fetchTakeover: true, fetchEntries: [fetchEntry()] }) });
  const mB = await mountFetch(mod, hB.config, { fetchDeps: hB.fetchDeps });
  assert.ok(mB.provider, "fetch provider 必须已注册于 fetch registry（FT-001，未注册即红属预期）");
  hB.fetchFn.when(/.*/).hangs();
  const ac2 = new AbortController();
  const p = mB.provider.fetch({ url: PUBLIC_URL }, ac2.signal);
  await flush();
  ac2.abort();
  await assert.rejects(p, (e) => e?.code === "WEB_ABORTED");
  const frozen = hB.fetchFn.calls.length;
  await flush();
  assert.equal(hB.fetchFn.calls.length, frozen, "取消后后续请求数不再增加（FB-003 语义）");
  await mB.dispose();
});

test("FT-002#7 总预算耗尽：拨满 25000ms 超时类码，之后出站冻结", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const h = harness({ config: makeFetchConfig({ fetchTakeover: true, fetchEntries: [fetchEntry()] }) });
  const m = await mountFetch(mod, h.config, { fetchDeps: h.fetchDeps });
  assert.ok(m.provider, "fetch provider 必须已注册于 fetch registry（FT-001，未注册即红属预期）");
  h.fetchFn.when(/.*/).hangs();
  const p = m.provider.fetch({ url: PUBLIC_URL });
  h.clock.advance(25_000 + 1);
  await flush();
  await assert.rejects(p, (e) => ["WEB_FETCH_TIMEOUT", "ENTRY_TIMEOUT", "CHAIN_BUDGET_EXHAUSTED"].includes(e?.code), "OQ-O4：超时终码白名单");
  const frozen = h.fetchFn.calls.length;
  h.clock.advance(10_000);
  await flush();
  assert.equal(h.fetchFn.calls.length, frozen, "预算耗尽后零新出站");
  await m.dispose();
});

test("FT-002#8 单次调用单 URL：一次 fetch 提取商出站 ≤1", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const h = harness({ config: makeFetchConfig({ fetchTakeover: true, fetchEntries: [fetchEntry()] }) });
  const m = await mountFetch(mod, h.config, { fetchDeps: h.fetchDeps });
  assert.ok(m.provider, "fetch provider 必须已注册于 fetch registry（FT-001，未注册即红属预期）");
  h.fetchFn.when(/.*/).responds({ status: 200, body: { results: [{ url: PUBLIC_URL, raw_content: "x", response_code: 200 }] } });
  await m.provider.fetch({ url: PUBLIC_URL });
  assert.ok(h.fetchFn.calls.length <= 1, `一次 fetch 提取商请求必须 ≤1，实得 ${h.fetchFn.calls.length}`);
  await m.dispose();
});

// ───────────────────────────── FT-003 ─────────────────────────────

test("FT-003#1/#2 三键默认：键缺失即默认，自动选择命中 http，装载零写盘", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const h = harness({ config: makeFetchConfig() }); // 三键全缺省
  const m = await mountFetch(mod, h.config, { fetchDeps: h.fetchDeps });
  assert.ok(m.provider, "fetch provider 必须已注册于 fetch registry（FT-001，未注册即红属预期）");
  assert.equal(m.provider.available(), false, "默认 fetchTakeover=false → available false（红线：默认不接管）");
  assert.equal(m.seam.select().id, HTTP_HOST_ID, "默认下自动选择 = 宿主 http");
  assert.equal(m.host.editor.calls.length, 0, "装载不得写盘（含三新键，FT-003#1）");
  await m.dispose();
});

test("FT-003#6 开关开而未钉死：自动选择 WEB_PROVIDER_AMBIGUOUS，两 id 可见", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const h = harness({ config: makeFetchConfig({ fetchTakeover: true, fetchEntries: [fetchEntry()] }) });
  const m = await mountFetch(mod, h.config, { fetchDeps: h.fetchDeps });
  assert.ok(m.provider, "fetch provider 必须已注册于 fetch registry（FT-001，未注册即红属预期）");
  assert.throws(() => m.seam.select(), (e) => e?.code === "WEB_PROVIDER_AMBIGUOUS"
    && String(e.message).includes(HTTP_HOST_ID) && String(e.message).includes(FETCH_PROVIDER_ID),
  "显性歧义可见（D-FT2 反静默）");
  await m.dispose();
});
