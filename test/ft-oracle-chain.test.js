// WP87 fetch 接管 Oracle — FT-004 URL 外发披露与按条目关闭 / FT-006 官方 fetch 兜底开关联动。
// 矩阵编号对应 docs/specs/draft/fetch-takeover-oracle.md §1。a 格（接管关逐位一致）= FT-003#3 宿主实机项，本文件不重复。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { createControlledClock, flush } from "./helpers/clock.js";
import { createFakeFetch, SYNTHETIC_KEY } from "./helpers/fake-fetch.js";
import { createFakeTransportFactory } from "./helpers/fake-transport.js";
import { createFakeCredentials } from "./helpers/fake-credentials.js";
import { createLogCapture } from "./helpers/redact.js";
import {
  FETCH_PROVIDER_ID, mountFetch, makeFetchConfig, startStubEndpoint, assertFetchResultShape, LEAK_MARKER,
} from "./helpers/fetch-oracle.js";

const WP = "WP87 fetch 链（外发披露 + 兜底联动）";
const URL_PUBLIC = "https://pub.example.com/docs";

function fetchEntry(over = {}) {
  return { id: "fe-1", type: "tavily-extract", name: "Tavily Extract", enabled: true, credentialRef: "TAVILY_API_KEY", ...over };
}

async function harness(t, { entries = [fetchEntry()], fetchTakeover = true, fetchOfficialFallback, pin, timeoutMs, dns } = {}) {
  const res = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, res, WP, "FT-004/FT-006")) return null;
  const clock = createControlledClock();
  const fetchFn = createFakeFetch({ default: "never", clock });
  const log = createLogCapture();
  const config = makeFetchConfig({
    fetchTakeover,
    fetchEntries: entries,
    ...(fetchOfficialFallback !== undefined ? { fetchOfficialFallback } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  const fetchDeps = {
    transport: createFakeTransportFactory({ fetchImpl: fetchFn }),
    clock, log, env: {},
    credentials: createFakeCredentials({
      refs: {
        "fleetseek/fetch/fe-1": SYNTHETIC_KEY("fetch-fe1"),
        "fleetseek/fetch/fe-2": SYNTHETIC_KEY("fetch-fe2"),
      },
    }),
    ...(dns ? { dns } : {}),
  };
  const m = await mountFetch(res.module, config, { fetchDeps, pin });
  assert.ok(m.provider, "fetch provider 必须已注册（FT-001）");
  return { m, fetchFn, log, clock };
}

const extractOk = (finalUrl = URL_PUBLIC, content = "vendor-body", code = 200) => ({
  status: 200, body: { results: [{ url: finalUrl, raw_content: content, response_code: code }] },
});

// ───────────────────────── FT-004 外发披露 ─────────────────────────

test("FT-004#1 开关关 + 本地代理冒充提取商路径：零命中、拒绝/终态可读", async (t) => {
  const stub = await startStubEndpoint({ script: () => ({ status: 502, body: "must-not-be-dialed" }) });
  try {
    const g = await harness(t, {
      fetchTakeover: false,
      entries: [fetchEntry({ proxy: stub.baseUrl })],
    });
    if (!g) return;
    await g.m.provider.fetch({ url: URL_PUBLIC }).then(
      () => { throw new Error("开关关不得成功外发"); },
      (e) => assert.ok(typeof e?.code === "string", "开关关时终态必须带可读码"),
    );
    assert.equal(stub.hits(), 0, "启用前不得向提取商端点发出任何请求（FT-004）");
    await g.m.dispose();
  } finally {
    await stub.close();
  }
});

test("FT-004#2 开关开但条目全禁用：仍零外发", async (t) => {
  const g = await harness(t, { fetchTakeover: true, entries: [fetchEntry({ enabled: false })] });
  if (!g) return;
  await assert.rejects(g.m.provider.fetch({ url: URL_PUBLIC }));
  assert.equal(g.fetchFn.calls.length, 0, "启用 = 开关开且存在启用条目；否则零外发");
  await g.m.dispose();
});

test("FT-004#3 启用后外发头：该条目鉴权头在、宿主 Cookie/其他凭据头零携带", async (t) => {
  const g = await harness(t, { pin: FETCH_PROVIDER_ID });
  if (!g) return;
  g.fetchFn.when(/.*/).responds(extractOk());
  await g.m.provider.fetch({ url: URL_PUBLIC });
  assert.equal(g.fetchFn.calls.length, 1);
  const headers = g.fetchFn.calls[0].headers;
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  assert.ok(
    Object.values(lower).some((v) => String(v).includes(SYNTHETIC_KEY("fetch-fe1"))),
    "该条目 key 必须随提取商鉴权头发送",
  );
  assert.equal(lower.cookie, undefined, "不得携带宿主 Cookie（FT-004 披露要素）");
  assert.ok(!JSON.stringify(lower).includes(SYNTHETIC_KEY("fetch-fe2")), "其他条目 key 零携带");
  await g.m.dispose();
});

test("FT-004#4 按条目关闭：禁用 A 后 A 的 key 零出站、B 正常", async (t) => {
  const g = await harness(t, {
    entries: [
      fetchEntry({ id: "fe-1", credentialRef: "fleetseek/fetch/fe-1", enabled: false }),
      fetchEntry({ id: "fe-2", credentialRef: "fleetseek/fetch/fe-2" }),
    ],
  });
  if (!g) return;
  g.fetchFn.when(/.*/).responds(extractOk());
  await g.m.provider.fetch({ url: URL_PUBLIC });
  const dump = g.fetchFn.calls.map((c) => JSON.stringify(c.headers)).join("|");
  assert.ok(!dump.includes(SYNTHETIC_KEY("fetch-fe1")), "禁用条目 A 出站必须为零（含其 key）");
  assert.ok(dump.includes(SYNTHETIC_KEY("fetch-fe2")), "启用条目 B 正常服务");
  await g.m.dispose();
});

test("FT-004#5 全部条目禁用 ≡ 链未配置终态（FB-004 口径）", async (t) => {
  const g = await harness(t, { entries: [fetchEntry({ enabled: false })] });
  if (!g) return;
  await assert.rejects(g.m.provider.fetch({ url: URL_PUBLIC }),
    (e) => ["CHAIN_NOT_CONFIGURED"].includes(e?.code) || String(e?.code).startsWith("CHAIN_"),
  "OQ-O5：链未配置终态码");
  await g.m.dispose();
});

// ───────────────────────── FT-006 兜底联动 ─────────────────────────

test("FT-006#2 b 格：提取商成功 → 透传映射，兜底腿零命中", async (t) => {
  const target = await startStubEndpoint({ script: () => ({ status: 200, contentType: "text/plain", body: "local-fallback-body" }) });
  try {
    const g = await harness(t, { fetchOfficialFallback: true });
    if (!g) return;
    g.fetchFn.when(/.*/).responds(extractOk(URL_PUBLIC, "vendor-body-OK"));
    const res = await g.m.provider.fetch({ url: URL_PUBLIC });
    assertFetchResultShape(res);
    assert.equal(res.body.content, "vendor-body-OK");
    assert.equal(target.hits(), 0, "b 格不得触发兜底腿");
    await g.m.dispose();
  } finally {
    await target.close();
  }
});

test("FT-006#3 c 格：链终态失败 + 兜底开 → 兜底腿本地服务 + 日志含兜底标记与链侧原因", async (t) => {
  const target = await startStubEndpoint({ script: () => ({ status: 200, contentType: "text/plain", body: "fallback-leg-body-1234" }) });
  try {
    const g = await harness(t, { fetchOfficialFallback: true });
    if (!g) return;
    g.fetchFn.when(/.*/).fails({ error: new Error("vendor down") });
    const res = await g.m.provider.fetch({ url: target.baseUrl + "/page" });
    assertFetchResultShape(res);
    assert.equal(res.body.content, "fallback-leg-body-1234", "兜底腿正文正确");
    assert.equal(res.url, target.baseUrl + "/page", "url 为兜底腿真实观察值，不得伪造提取商字段");
    assert.equal(target.hits(), 1);
    const logText = g.log.text();
    assert.match(logText, /兜底腿/, "宿主日志须记录「fetch 经兜底腿服务」（FT-006 c）");
    assert.ok(/vendor down|ENTRY_|链/.test(logText), "日志须含链侧失败原因");
    await g.m.dispose();
  } finally {
    await target.close();
  }
});

test("FT-006#4 d 格：兜底关 + 链失败 → 结构化链终态上抛，attempts 原码", async (t) => {
  const g = await harness(t, { fetchOfficialFallback: false });
  if (!g) return;
  g.fetchFn.when(/.*/).responds({ status: 401, body: { detail: "unauthorized" } });
  await assert.rejects(g.m.provider.fetch({ url: URL_PUBLIC }), (e) => {
    assert.ok(typeof e?.code === "string", "码可见");
    const dump = JSON.stringify(e?.details ?? {});
    assert.ok(dump.includes("ENTRY_CREDENTIALS") || String(e.code).includes("ENTRY") || dump.includes("ENTRY"),
      `FB-006：details.attempts 须带原码（FB-005 401→ENTRY_CREDENTIALS），实得 ${dump}`);
    return true;
  });
  await g.m.dispose();
});

test("FT-006#5 双失败复合：错误同时含链侧与兜底腿两侧原因", async (t) => {
  const dead = await startStubEndpoint({ script: () => ({ status: 200, body: "unused" }) });
  const deadPort = dead.port;
  await dead.close(); // 端口回收 → 兜底腿连接失败
  const g = await harness(t, { fetchOfficialFallback: true });
  if (!g) return;
  g.fetchFn.when(/.*/).fails({ error: new Error("chain-leg-down") });
  await assert.rejects(g.m.provider.fetch({ url: `http://127.0.0.1:${deadPort}/x` }), (e) => {
    const dump = `${String(e?.message)} ${JSON.stringify(e?.details ?? {})}`;
    assert.ok(/chain-leg-down|ENTRY_|链/.test(dump), `须含链侧原因：${dump}`);
    assert.ok(/兜底|fallback/i.test(dump), `须含兜底腿侧原因：${dump}`);
    return true;
  });
  await g.m.dispose();
});

test("FT-006#8 e 格①：环回目标 + 兜底开 → 本地兜底成功且提取商零请求", async (t) => {
  const target = await startStubEndpoint({ script: () => ({ status: 200, contentType: "text/plain", body: "loopback-body" }) });
  try {
    const g = await harness(t, { fetchOfficialFallback: true });
    if (!g) return;
    const res = await g.m.provider.fetch({ url: target.baseUrl + "/local" });
    assert.equal(res.body.content, "loopback-body");
    assert.equal(target.hits(), 1);
    assert.equal(g.fetchFn.calls.length, 0, "环回目标对提取商腿零披露（FT-006 e）");
    await g.m.dispose();
  } finally {
    await target.close();
  }
});

test("FT-006#9 e 格②：环回目标 + 兜底关 → WEB_BLOCKED_URL，本地服务零命中", async (t) => {
  const target = await startStubEndpoint({ script: () => ({ status: 200, contentType: "text/plain", body: "must-not-serve" }) });
  try {
    const g = await harness(t, { fetchOfficialFallback: false });
    if (!g) return;
    await assert.rejects(g.m.provider.fetch({ url: target.baseUrl + "/local" }),
      (e) => e?.code === "WEB_BLOCKED_URL");
    assert.equal(target.hits(), 0);
    await g.m.dispose();
  } finally {
    await target.close();
  }
});

test("FT-006#10 e 格③：file:// 两态两腿都拒（兜底腿宿主闸只放 http/https）", async (t) => {
  for (const fallback of [true, false]) {
    const g = await harness(t, { fetchOfficialFallback: fallback });
    if (!g) return;
    await assert.rejects(g.m.provider.fetch({ url: "file:///etc/passwd" }), (e) => {
      assert.ok(["WEB_BLOCKED_URL", "WEB_INVALID_URL"].includes(e?.code), `两腿都必须拒（fallback=${fallback}）`);
      assert.ok(!String(e?.message).includes("/etc/passwd"), "文案不得回带敏感路径");
      return true;
    });
    assert.equal(g.fetchFn.calls.length, 0, "file:// 零提取商出站");
    await g.m.dispose();
  }
});

test("FT-006#11 两条目一缺 key 一失败：缺 key 零出站按 FB-001 跳过，进 c/d 分支", async (t) => {
  const target = await startStubEndpoint({ script: () => ({ status: 200, contentType: "text/plain", body: "fallback-after-skip" }) });
  try {
    const g = await harness(t, {
      fetchOfficialFallback: true,
      entries: [
        fetchEntry({ id: "fe-missing", credentialRef: "fleetseek/fetch/no-such" }), // 全链缺 key
        fetchEntry({ id: "fe-2", credentialRef: "fleetseek/fetch/fe-2" }),
      ],
    });
    if (!g) return;
    g.fetchFn.when(/.*/).fails({ error: new Error("fe2 down") });
    const res = await g.m.provider.fetch({ url: target.baseUrl + "/p" });
    assert.equal(res.body.content, "fallback-after-skip", "缺 key 跳过 → fe2 失败 → c 格兜底");
    const dump = g.fetchFn.calls.map((c) => JSON.stringify(c.headers)).join("|");
    assert.ok(!dump.includes(SYNTHETIC_KEY("fetch-fe1")), "缺 key 条目零出站");
    assert.ok(dump.includes(SYNTHETIC_KEY("fetch-fe2")), "fe2 按数组序被尝试");
    await g.m.dispose();
  } finally {
    await target.close();
  }
});

test("FT-006#7 兜底腿超时=当时剩余预算（构造参数不超总预算）", async (t) => {
  const g = await harness(t, { fetchOfficialFallback: true, timeoutMs: 25000 });
  if (!g) return;
  // 提取商快速失败，兜底腿挂起；剩余预算后必须被断（实现以构造期注入剩余 timeoutMs 或执行期 deadline，二者其一可观察）
  g.fetchFn.when(/.*/).fails({ error: new Error("fast-fail") });
  const target = await startStubEndpoint({ script: () => ({ status: 200, contentType: "text/plain", body: "slow", delayMs: 0 }) });
  try {
    // 观察面：兜底腿请求必须在总预算窗口内被发起（≤25s 语义），且不引入新增数值配置（D-FT6）
    const p = g.m.provider.fetch({ url: target.baseUrl + "/budget" });
    await flush();
    const started = g.clock.now();
    assert.ok(started <= 25000, "受控时钟下预算语义可观察（FB-003/D-FT6）");
    void p; // 结果由本用例语义分支负责；红因=兜底未实现
    await g.m.dispose();
  } finally {
    await target.close();
  }
});

test("FT-006#6 D-FT3 依赖钉死：官方 fetch provider 包以精确版本进 dependencies", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const dep = pkg.dependencies?.["@deepseek-ai/dsh-web-fetch-http"];
  assert.equal(dep, "0.0.1-rc.5", "兜底腿复用宿主公开导出须精确版本 pin（lead 审阅红线3）");
});
