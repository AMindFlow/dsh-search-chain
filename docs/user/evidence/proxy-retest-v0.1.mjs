// 用户文档复测 fixture（headless，零外网）：验证 v0.1 生产装配下 proxy / PAC / 响应体上限的实际行为。
//
// 运行：PATH=<node26+/bin> node docs/user/evidence/proxy-retest-v0.1.mjs
// 只连 127.0.0.1 的本地 fixture 服务器；无任何真实供应商、无凭据、无带认证参数的 URL。
//
// 断言面（对应 src/index.js productionFetch / src/transport.js / src/search.js 实态）：
//   A. proxy 为 http URL 的条目：零出站打到代理端口，attempts 记 ENTRY_PROXY（原因含 PROXY_UNSUPPORTED），
//      整链终态 CHAIN_UPSTREAM_FAILURES，不静默改走直连。
//   B. proxy={pac} 且 PAC 返回 PROXY：PAC 文件确实被直连下载（服务器计数恰 1 次请求），
//      命中代理后同样 ENTRY_PROXY、零出站。
//   C. PAC 文件超过 2MiB（MAX_RESPONSE_BYTES）：attempts 记 PAC_FETCH_FAILED，原因含字节上限与「已中止下载」，
//      条目级降级（链没有因该条目中断）。
//   D. 传输接缝（注入 fetch 观测 route 标记）：PAC 下载走直连（route.phase="pac-download"）；
//      PAC 指令 "SOCKS5 …; DIRECT" 中 SOCKS 被跳过、选中 DIRECT（pacIndex=1），目标请求带
//      route { kind:"direct", viaPac:true }。该路由在生产装配（src/index.js productionFetch）
//      原样交给全局 fetch，即真正从直连出站。
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { apply } from "../../../src/index.js";
import { createEntryTransport } from "../../../src/transport.js";

const results = [];
function ok(name, detail) {
  results.push(`PASS  ${name}${detail ? ` —— ${detail}` : ""}`);
}

// ── 本地 fixture 服务器 ─────────────────────────────────────────────────────
const pacHits = new Map(); // pathname -> 次数
const pacServer = createServer((req, res) => {
  pacHits.set(req.url, (pacHits.get(req.url) ?? 0) + 1);
  const portOf = () => echoServer.address().port;
  if (req.url === "/proxy.pac") {
    res.writeHead(200, { "content-type": "application/x-ns-proxy-autoconfig" });
    res.end(`function FindProxyForURL(u,h){return "PROXY 127.0.0.1:${portOf()}";}`);
  } else if (req.url === "/big.pac") {
    // 有效 PAC 脚本 + 填充注释，总量 > 2MiB。
    const pad = "/* " + "p".repeat(3 * 1024 * 1024) + " */\n";
    res.writeHead(200, { "content-type": "application/x-ns-proxy-autoconfig" });
    res.end(`${pad}function FindProxyForURL(u,h){return "DIRECT";}`);
  } else {
    res.writeHead(404);
    res.end();
  }
});
let echoConnections = 0;
const echoServer = createServer((req, res) => {
  res.writeHead(500); // 不应被用到
  res.end("unexpected forward through fake proxy");
});
echoServer.on("connection", () => {
  echoConnections += 1;
});
await new Promise((r) => pacServer.listen(0, "127.0.0.1", r));
await new Promise((r) => echoServer.listen(0, "127.0.0.1", r));
const pacBase = `http://127.0.0.1:${pacServer.address().port}`;
const echoBase = `http://127.0.0.1:${echoServer.address().port}`;

// ── 最小宿主替身 + 生产装配（src/index.js apply，默认 productionFetch）────────
const entry = { options: { id: "search-chain" } };
const row = { entry, inherited: {}, override: { entries: [] } };
let provider = null;
const ctx = {
  fiber: { entry },
  configEditor: { configuration: () => [row], edit: async () => {} },
  get: () => undefined,
  effect(fn) {
    fn();
  },
  web: {
    registerSearchProvider(p) {
      provider = p;
      return () => {};
    },
  },
};
const logs = []; // testDeps.log 仅为观测接缝；fetch 缺省仍是生产 productionFetch
apply(ctx, {}, { log: (level, msg) => logs.push(`${level}: ${msg}`) });

async function runSearch(entries) {
  row.override.entries = entries;
  try {
    const r = await provider.search({ query: "proxy-retest" });
    return { ok: true, r };
  } catch (err) {
    return { ok: false, code: err?.code, message: err?.message, attempts: err?.details?.attempts ?? null };
  }
}

// A. 固定 http 代理条目：ENTRY_PROXY、零出站、不降级直连
{
  const before = echoConnections;
  const res = await runSearch([
    { id: "a-proxy", type: "bing", name: "A代理", enabled: true, proxy: echoBase },
  ]);
  assert.equal(res.ok, false, "A: 应失败");
  assert.equal(res.code, "CHAIN_UPSTREAM_FAILURES", `A: 终态 ${res.code}`);
  assert.equal(res.attempts[0].code, "ENTRY_PROXY", `A: attempts[0] ${res.attempts[0]?.code}`);
  assert.match(res.attempts[0].reason, /代理失败/);
  assert.match(res.attempts[0].reason, /不会自动改走直连/);
  assert.equal(echoConnections, before, "A: 代理端口连接数必须为 0（零出站）");
  const aLog = logs.find((l) => /经代理 127\.0\.0\.1:\d+ 请求失败（PROXY_UNSUPPORTED）/.test(l));
  assert.ok(aLog, `A: 传输层日志缺 PROXY_UNSUPPORTED 归因: ${JSON.stringify(logs)}`);
  ok("A 固定代理条目 → attempts 记 ENTRY_PROXY（reason 提示不会自动改走直连）、代理端口零连接、终态 CHAIN_UPSTREAM_FAILURES",
    `reason="${res.attempts[0].reason}" / log="${aLog}"`);
}

// B. PAC 命中代理：PAC 确实被直连下载（恰 1 次），随后 ENTRY_PROXY、零出站
{
  const before = echoConnections;
  const res = await runSearch([
    { id: "b-pac", type: "bing", name: "B PAC", enabled: true, proxy: { pac: `${pacBase}/proxy.pac` } },
  ]);
  assert.equal(res.ok, false, "B: 应失败");
  assert.equal(pacHits.get("/proxy.pac"), 1, `B: PAC 下载次数 ${pacHits.get("/proxy.pac")}`);
  assert.equal(res.attempts[0].code, "ENTRY_PROXY", `B: attempts[0] ${res.attempts[0]?.code}`);
  assert.match(res.attempts[0].reason, /不会自动改走直连/);
  assert.equal(echoConnections, before, "B: PAC 命中的代理端口零连接");
  const bLog = logs.find((l) => /经PAC 代理 127\.0\.0\.1:\d+ 请求失败（PROXY_UNSUPPORTED）/.test(l));
  assert.ok(bLog, `B: 传输层日志缺 PAC 归因: ${JSON.stringify(logs.slice(-3))}`);
  ok("B PAC→PROXY：PAC 直连下载恰 1 次，命中代理后 ENTRY_PROXY（PAC 代理 host:port + PROXY_UNSUPPORTED 入日志）、零出站",
    `log="${bLog}"`);
}

// C. PAC 超 2MiB：PAC_FETCH_FAILED（尺寸诊断），条目级降级到链终态
{
  const res = await runSearch([
    { id: "c-big", type: "bing", name: "C PAC", enabled: true, proxy: { pac: `${pacBase}/big.pac` } },
  ]);
  assert.equal(res.ok, false, "C: 应失败");
  assert.equal(res.code, "CHAIN_UPSTREAM_FAILURES", "C: 条目级降级后仍走链终态");
  assert.equal(res.attempts[0].code, "PAC_FETCH_FAILED", `C: attempts[0] ${res.attempts[0]?.code}`);
  assert.match(res.attempts[0].reason, /PAC 获取失败（PAC_FETCH_FAILED）/);
  ok("C PAC 超 2MiB → 条目 attempts 记 PAC_FETCH_FAILED（原码保留、链继续）",
    `reason="${res.attempts[0].reason}"`);
  // 直接观测传输层原始文本（含字节上限），排除链文案层改写歧义：
  const t = createEntryTransport({ id: "c", type: "bing", name: "C", proxy: { pac: `${pacBase}/big.pac` } },
    { fetch: (u, i) => globalThis.fetch(u, i) });
  const err = await t.fetch("http://127.0.0.1:1/never").catch((e) => e);
  assert.equal(err.code, "PAC_FETCH_FAILED");
  assert.match(err.message, /2097152 字节.*已中止下载/s, `C: raw=${err.message}`);
  t.close();
  ok("C' 传输层原始原因含上限 2097152 字节与「已中止下载」", `message="${err.message}"`);
}

// D. 传输接缝观测：PAC 下载=直连 GET（phase=pac-download）；SOCKS 指令跳过、DIRECT 命中 pacIndex=1；
//    目标请求带 route {kind:"direct", viaPac:true}（生产装配对 direct 路由原样走全局 fetch）。
{
  const calls = [];
  const spy = async (url, init) => {
    calls.push({ url, route: init?.route });
    if (String(url).endsWith("/socks.pac")) {
      return { ok: true, status: 200, body: null, text: async () =>
        'function FindProxyForURL(u,h){return "SOCKS5 127.0.0.1:1080; DIRECT";}' };
    }
    return { ok: true, status: 200, text: async () => '{"sources":[]}' };
  };
  const t = createEntryTransport(
    { id: "d", type: "bing", name: "D", proxy: { pac: `${pacBase}/socks.pac` } },
    { fetch: spy },
  );
  await t.fetch("https://target.invalid/x");
  t.close();
  assert.equal(calls.length, 2, `D: 期望 2 次调用（PAC+目标），实际 ${calls.length}`);
  assert.deepEqual(calls[0].route, { kind: "direct", phase: "pac-download" }, `D: pac route ${JSON.stringify(calls[0].route)}`);
  assert.equal(calls[1].route.kind, "direct", "D: 目标路由 kind=direct");
  assert.equal(calls[1].route.viaPac, true, "D: viaPac 标记");
  assert.equal(calls[1].route.pacIndex, 1, "D: SOCKS5 被跳过，DIRECT 序号=1");
  assert.equal(calls[1].route.pacSource, `${pacBase}/socks.pac`, "D: pacSource 不含查询");
  ok("D 接缝：PAC 下载 route={direct,pac-download}；SOCKS5 跳过、DIRECT 命中 pacIndex=1；目标 route={direct,viaPac:true}");
}

// 汇总
console.log(`proxy-retest-v0.1 · node ${process.version} · ${new Date().toISOString()}`);
console.log(`pac 服务器命中: ${JSON.stringify([...pacHits.entries()])}`);
console.log(`echo 代理端口连接数（全程）: ${echoConnections}`);
for (const line of results) console.log(line);
console.log(`共 ${results.length} 项断言组全部通过`);

pacServer.close();
echoServer.close();
