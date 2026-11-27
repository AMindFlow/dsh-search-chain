// Issue #61 装配面代理出站 oracle —— PROXY_UNSUPPORTED 退役后，代理路由的真实出站钉。
//
// 覆盖条款与依据：
//   CFG-001（config-network.md）：条目级固定代理出站，不得静默改走直连；代理失败按 FB-001 降级下一条。
//   CFG-003：key 只随对应供应商鉴权头发送；日志/错误不得含代理认证（本文件 (e) 面钉 user:pass 不泄漏）。
//   FB-005：代理故障归 ENTRY_PROXY（transport.mapFetchError 既有语义），与直连网络失败区分。
//   Issue #61 判据（harness 本地 CONNECT 代理 fixture：隧道计数 + 转发标记）：
//     a) 条目配 proxy → 隧道计数 > 0 且转发请求 Host 正确；
//     b) 供应商鉴权头只出现在转发请求、不出现在 CONNECT；
//     c) 未配 proxy 的条目零隧道；
//     d) 代理端口关闭 → 错误按 transport 既有语义归 ENTRY_PROXY，链降级下一条；
//     e) proxy URL 含 user:pass → 凭据不出现在任何日志/错误对象文本。
//   规格运输段设计决定（undici dispatcher）：直连维持 globalThis.fetch、代理经 undici ProxyAgent
//   （按 proxyUrl 缓存复用）——口径出入与决策来源（Issue #61 用户指令）在 config-network.md 文中注明。
//   PR #62 P2（codex 复审 discussion_r4709786331）：closeAll 与在途搜索协调——卸载后不得再有新建
//   agent 逃逸于关闭之外（本文件 (f) 面钉：closeAll 后代理路由显式拒绝 ENTRY_PROXY 语义/明确文案、
//   零新隧道；closeAll 幂等；CONNECT 挂起在途时 closeAll 不提前落定、结算后零未管理 agent）。
//
// 接线方式（复用仓库既有链测试注入风格，同 chain-coded-failure-policy ⑥ 的 transport.open 替换）：
//   真实 createSearchChain + 真实 createEntryTransport(entry, { fetch: 真实 createProductionFetch() })；
//   后端适配器按 A5 seam 双替为 localEchoBackend——真实供应商端点是生产域名（离线测试不可达），
//   双替只替换「请求哪个 URL」，ctx.fetch 出站路径（transport → productionFetch → undici 隧道）全程真实。
//   全部网络只打 127.0.0.1（node net/http 本地 fixture），绝不触真实外网。
//   真实网络不走受控时钟：search 经 realAwait 以真实时间守卫结算（受控时钟永不拨动，预算定时器不触发）。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { DEFAULT_QUERY } from "./helpers/chain-harness.js";
import { chainHarness, keyedEntry, refsFor } from "./helpers/search-oracle.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { ENTRY_CODES, CHAIN_CODES, makeSources, assertSearchResult } from "./helpers/contract.js";
import { SYNTHETIC_KEY } from "./helpers/fake-fetch.js";
import { createHostShapeFakeHost } from "./helpers/fake-host.js";

// ─── 本地最小 CONNECT 代理 + origin fixture（Issue #61 判据 3）─────────────────────────

const ECHO_SOURCES = makeSources(2, "https://tunnel-echo.invalid/doc");

/**
 * 本地最小 CONNECT 代理 + 转发记录 origin（node net/http，全 127.0.0.1、端口 0 自动分配）。
 *  - proxy：只应答 CONNECT（其余方法 405——直连误打代理在此可见）；记录隧道目标与 CONNECT 请求头。
 *  - origin：记录转发请求的 method/url/headers/body，回固定 JSON（ECHO_SOURCES）。
 * close()：先关两侧监听，再 closeAllConnections 断掉 keep-alive 隧道（调用方须先关生产 fetch 连接池）。
 */
async function startTunnelFixture({ connectStallMs = 0 } = {}) {
  const state = { connects: [], requests: [] };
  const origin = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      state.requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ sources: ECHO_SOURCES }));
    });
  });
  const proxy = http.createServer((req, res) => {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("CONNECT ONLY");
  });
  proxy.on("connect", (req, socket, head) => {
    state.connects.push({ target: req.url, headers: req.headers });
    const tunnel = () => {
      const [host, port] = req.url.split(":");
      const upstream = net.connect(Number(port), host, () => {
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    };
    // (f3) 在途模拟：CONNECT 应答挂起 connectStallMs（>0 时），期间隧道内请求为在途态。
    if (connectStallMs > 0) setTimeout(tunnel, connectStallMs);
    else tunnel();
  });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const originUrl = `http://127.0.0.1:${origin.address().port}`;
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const originClosed = new Promise((r) => origin.once("close", r));
  const proxyClosed = new Promise((r) => proxy.once("close", r));
  async function close() {
    origin.close();
    proxy.close();
    origin.closeAllConnections?.();
    proxy.closeAllConnections?.();
    await Promise.all([originClosed, proxyClosed]);
  }
  return { state, originUrl, proxyUrl, originHost: new URL(originUrl).host, close };
}

/** 取一个确认已关闭的本地端口（bind 后立即释放），用于「代理端口关闭」面。 */
async function closedPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

// ─── 测试台装配 ────────────────────────────────────────────────────────────────────────

/**
 * A5 seam 双替：形状同真实后端（ctx.fetch 出站 + 供应商鉴权头 Bearer key），仅端点换成本地 origin
 * （真实后端端点是生产域名，离线不可达）。传输/生产出站/链三面均为真实实现。
 */
function localEchoBackend(originUrl) {
  const calls = [];
  let seq = 0;
  return {
    type: "tavily",
    calls, // 与 scripted backend 同形（chain-harness executions() 读取 { entryId, at, seq }）
    callCount(entryId) {
      return calls.filter((c) => c.entryId === entryId).length;
    },
    async search(ctx) {
      calls.push({ entryId: ctx.entry?.id, at: Date.now(), seq: ++seq });
      const res = await ctx.fetch(`${originUrl}/echo`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ctx.key}`,
        },
        body: JSON.stringify({ query: ctx.query, entry: ctx.entry?.id }),
        signal: ctx.signal,
      });
      if (!res.ok) throw new Error(`本地 origin 返回 HTTP ${res.status}`);
      const data = await res.json();
      return { sources: data.sources ?? [] };
    },
  };
}

async function loadIndex(t) {
  const res = await tryImportSrc("index.js");
  failIfUnimplemented(t, res, "WP6 src/index.js", "Issue#61 代理出站");
  return res.module;
}

async function loadTransport(t) {
  const res = await tryImportSrc("transport.js");
  failIfUnimplemented(t, res, "WP1 src/transport.js", "Issue#61 代理出站");
  return res.module;
}

/**
 * 链台 + 真实 transport + 真实生产出站（本文件注入风格，同 P2-b⑥ 的 open 替换）：
 *  - h.deps.backends 的 tavily 换成 localEchoBackend(fixture.originUrl)（A5 seam）；
 *  - h.transport.open 换成真实 createEntryTransport(entry, { fetch: 真实 createProductionFetch() })。
 * configure(fixture) 在 fixture 就绪后构造条目（条目 proxy 可引用 fixture.proxyUrl），返回 entries 数组。
 * 返回 { h, pf, fixture }；结束须 await pf.closeAll() 再 fixture.close()（隧道 keep-alive 归连接池）。
 */
async function makeProxyChain(t, { ids, configure, fixtureOpts }) {
  const indexMod = await loadIndex(t);
  const transportMod = await loadTransport(t);
  if (typeof indexMod.createProductionFetch !== "function") {
    assert.fail("src/index.js 须导出 createProductionFetch（Issue #61：装配面 dispatcher 注入，PROXY_UNSUPPORTED 退役后的生产出站）");
  }
  const fixture = await startTunnelFixture(fixtureOpts);
  const entries = configure(fixture);
  const h = await chainHarness(t, "Issue#61/CFG-001", {
    entries,
    credentialRefs: refsFor(...ids),
    timeoutMs: 60_000,
  });
  const pf = indexMod.createProductionFetch();
  const echo = localEchoBackend(fixture.originUrl);
  h.deps.backends.set("tavily", echo); // 链执行时 get（A5 seam）
  h.backendByType.set("tavily", echo); // 台架 executions()/executionCount() 同指该替身
  const open = transportMod.createEntryTransport;
  h.transport.open = (entry) => open(entry, { fetch: pf, clock: h.clock, log: h.logCapture.log });
  return { h, pf, fixture };
}

/** 真实网络守卫：受控时钟永不拨动（预算定时器不触发），只以真实时间上限兜底。 */
async function realAwait(promise, label, ms = 20_000) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[${label}] 真实网络 ${ms}ms 未收敛（本地 fixture 不应如此慢）`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** 收集错误对象全部可观察文本（message/stack/details/cause 链），用于脱敏断言（CFG-003）。 */
function collectErrorText(err, seen = new Set()) {
  const parts = [];
  let cur = err;
  let guard = 0;
  while (cur && guard < 10) {
    guard += 1;
    if (seen.has(cur)) break;
    seen.add(cur);
    if (typeof cur.message === "string") parts.push(cur.message);
    if (typeof cur.stack === "string") parts.push(cur.stack);
    if (cur.details !== undefined) {
      try {
        parts.push(JSON.stringify(cur.details));
      } catch {
        /* 循环引用：message/stack 面已覆盖 */
      }
    }
    cur = cur.cause;
  }
  return parts.join("\n");
}

/** 日志捕获全部可观察文本（level + message + rest 序列化）。 */
function logText(h) {
  return h.logCapture.text();
}

// ─── (a) 条目配 proxy：真实隧道 + 转发 Host 正确 ────────────────────────────────────────

test("a) 条目配 proxy：隧道计数>0、CONNECT 目标=origin、转发请求 Host 正确，链照常成功", async (t) => {
  const { h, pf, fixture } = await makeProxyChain(t, {
    ids: ["po-a1"],
    configure: (fx) => [keyedEntry("po-a1", "tavily", "条目甲", { proxy: fx.proxyUrl })],
  });
  try {
    const res = await realAwait(h.search({ query: DEFAULT_QUERY }), "po-a");

    // 隧道真实发生且目标正确：CONNECT <origin host:port>。
    assert.ok(fixture.state.connects.length > 0, "配 proxy 的条目出站必须经 CONNECT 隧道（隧道计数>0）");
    assert.equal(
      fixture.state.connects[0].target,
      fixture.originHost,
      "CONNECT 目标必须是条目的出站目标 origin（host:port），不得是别的地址",
    );
    // 转发请求完整：method/path/Host 头正确（隧道不篡改原始请求）。
    assert.equal(fixture.state.requests.length, 1, "转发请求恰 1 次（FB-001 每条目至多一次）");
    const fwd = fixture.state.requests[0];
    assert.equal(fwd.method, "POST");
    assert.equal(fwd.url, "/echo");
    assert.equal(fwd.headers.host, fixture.originHost, "转发请求 Host 头必须是目标 origin（隧道保真）");
    const body = JSON.parse(fwd.body);
    assert.equal(body.query, DEFAULT_QUERY, "转发请求体携带查询（端到端可达）");

    // 链层照常成功：代理可用时行为与直连一致（FB-001 首个有效来源即停；单条目成功无接管 content）。
    assertSearchResult(t, res, { sources: ECHO_SOURCES, truncated: false });
    assert.deepEqual(h.executions().map((c) => c.entryId), ["po-a1"]);
  } finally {
    await pf.closeAll();
    await fixture.close();
  }
});

// ─── (b) 供应商鉴权头只进转发请求，不进 CONNECT ─────────────────────────────────────────

test("b) 供应商鉴权头只出现在转发请求、不出现在 CONNECT（CFG-003：key 只随供应商鉴权头发送）", async (t) => {
  const key = SYNTHETIC_KEY("po-b1");
  const { h, pf, fixture } = await makeProxyChain(t, {
    ids: ["po-b1"],
    configure: (fx) => [keyedEntry("po-b1", "tavily", "条目甲", { proxy: fx.proxyUrl })],
  });
  try {
    await realAwait(h.search({ query: DEFAULT_QUERY }), "po-b");

    // 转发请求：供应商鉴权头在场且取值正确。
    assert.equal(fixture.state.requests.length, 1, "转发请求恰 1 次");
    assert.equal(
      fixture.state.requests[0].headers.authorization,
      `Bearer ${key}`,
      "供应商鉴权头必须随转发请求到达 origin",
    );
    // CONNECT：不得携带供应商鉴权头（或任何含 key 的头）。
    assert.ok(fixture.state.connects.length > 0, "前提：隧道已发生");
    for (const [i, c] of fixture.state.connects.entries()) {
      assert.equal(c.headers.authorization, undefined, `CONNECT[${i}] 不得携带供应商鉴权头`);
      const allValues = Object.values(c.headers).join(" ");
      assert.ok(!allValues.includes(key), `CONNECT[${i}] 任何请求头不得出现供应商 key 值`);
    }
    // 端到端文本面再钉一次：origin 侧看到的头里没有以 CONNECT 头部形态泄漏的 key。
    const fwdAll = Object.entries(fixture.state.requests[0].headers)
      .filter(([k]) => k !== "authorization")
      .map(([, v]) => (Array.isArray(v) ? v.join(" ") : String(v)))
      .join(" ");
    assert.ok(!fwdAll.includes(key), "key 不得以非鉴权头形式出现在转发请求的其他头里");
  } finally {
    await pf.closeAll();
    await fixture.close();
  }
});

// ─── (c) 未配 proxy 的条目零隧道 ────────────────────────────────────────────────────────

test("c) 未配 proxy 的条目零隧道（代理 fixture 运行中但未被触碰）", async (t) => {
  const { h, pf, fixture } = await makeProxyChain(t, {
    ids: ["po-c1"],
    configure: () => [keyedEntry("po-c1", "tavily", "条目甲")], // 无 proxy 字段
  });
  try {
    const res = await realAwait(h.search({ query: DEFAULT_QUERY }), "po-c");

    assert.equal(fixture.state.connects.length, 0, "直连条目不得发起任何 CONNECT（零隧道）");
    assert.equal(fixture.state.requests.length, 1, "出站仍发生，但直达 origin（不经代理）");
    assertSearchResult(t, res, { sources: ECHO_SOURCES, truncated: false });
    assert.deepEqual(h.executions().map((c) => c.entryId), ["po-c1"]);
  } finally {
    await pf.closeAll();
    await fixture.close();
  }
});

// ─── (d) 代理端口关闭：ENTRY_PROXY 既有语义 + 链降级下一条 ──────────────────────────────

test("d) 代理端口关闭：错误按 transport 既有语义归 ENTRY_PROXY，链降级下一条成功", async (t) => {
  const deadPort = await closedPort();
  const deadProxyUrl = `http://127.0.0.1:${deadPort}`;
  const { h, pf, fixture } = await makeProxyChain(t, {
    ids: ["po-d1", "po-d2"],
    configure: () => [
      keyedEntry("po-d1", "tavily", "条目甲", { proxy: deadProxyUrl }),
      keyedEntry("po-d2", "tavily", "条目乙"),
    ],
  });
  try {
    const res = await realAwait(h.search({ query: DEFAULT_QUERY }), "po-d");

    // 降级成功：甲（代理死）失败 → 乙（直连本地 origin）接管（FB-001 首个有效来源即停）。
    assertSearchResult(t, res, { sources: ECHO_SOURCES, truncated: false, entryName: "条目乙" });
    assert.deepEqual(
      h.executions().map((c) => c.entryId),
      ["po-d1", "po-d2"],
      "代理条目失败必须降级到下一启用条目（FB-001/CFG-001），不得整链终止",
    );
    assert.equal(h.executionCount("po-d1"), 1, "FB-001：失败条目至多提交一次，不重试");
    // 甲的出站确实打向了死代理端口（零成功连接），且没有改走直连（CFG-001 红线）。
    assert.equal(fixture.state.requests.length, 1, "只有乙（直连）的转发请求到达 origin——甲绝不静默改走直连");

    // transport 既有语义：经代理请求失败 → TransportError(ENTRY_PROXY)，message 含代理 host:port。
    const warn = h.logCapture.entries.find((e) => e.message.includes(`经代理 ${new URL(deadProxyUrl).host}`));
    assert.ok(warn, `transport 必须留下经 ${new URL(deadProxyUrl).host} 的代理失败 warn 日志，实际：${logText(h)}`);
    assert.equal(warn.level, "warn");
    // 链 attempts 记录保留原码 ENTRY_PROXY（成功路径可观察面 = warn 日志，同 P2-b① 面）。
    const rec = h.logCapture.entries.find(
      (e) => e.message === "search-chain 条目失败" && e.rest?.[0]?.entryId === "po-d1",
    );
    assert.ok(rec, "降级条目须留一次条目失败记录（attempts 可观察面）");
    assert.equal(rec.rest[0].code, ENTRY_CODES.PROXY, `attempts 码须为 ${ENTRY_CODES.PROXY}（FB-005 区分代理/直连），不得压成 ENTRY_NETWORK`);
    // 接管提示首行标注前序条目为代理失败（FB-002）。
    const firstLine = res.content.split("\n")[0];
    assert.match(firstLine, /条目甲/, "接管提示须标注失败的条目名（FB-002）");
    assert.match(firstLine, /代理失败/, "接管提示须可诊断到代理失败（FB-002 ISSUE_DESC.PROXY）");
  } finally {
    await pf.closeAll();
    await fixture.close();
  }
});

// ─── (e) proxy URL 含 user:pass：凭据不泄漏 ─────────────────────────────────────────────

const PROXY_USER = "proxy-user-61x";
const PROXY_PASS = "proxy-pass-61y";

test("e1) proxy URL 含 user:pass：凭据以 Proxy-Authorization 进 CONNECT（真实使用），转发请求与日志均不含凭据", async (t) => {
  const { h, pf, fixture } = await makeProxyChain(t, {
    ids: ["po-e1"],
    configure: (fx) => [
      keyedEntry("po-e1", "tavily", "条目甲", {
        proxy: `http://${PROXY_USER}:${PROXY_PASS}@${fx.proxyUrl.slice("http://".length)}`,
      }),
    ],
  });
  try {
    await realAwait(h.search({ query: DEFAULT_QUERY }), "po-e1");

    // 凭据真实被使用：CONNECT 携带 Proxy-Authorization: Basic（undici ProxyAgent 对 userinfo 的既定行为）。
    assert.ok(fixture.state.connects.length > 0, "前提：隧道已发生");
    const expectedAuth = `Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString("base64")}`;
    assert.equal(
      fixture.state.connects[0].headers["proxy-authorization"],
      expectedAuth,
      "CONNECT 必须携带 Proxy-Authorization: Basic（代理凭据经隧道控制面使用）",
    );
    // 转发请求（供应商面）不得携带代理凭据：鉴权头只有供应商 key，其他头无凭据值。
    const fwd = fixture.state.requests[0];
    assert.equal(
      fwd.headers.authorization,
      `Bearer ${SYNTHETIC_KEY("po-e1")}`,
      "转发请求鉴权头必须是供应商 key（不是代理凭据）",
    );
    const fwdAll = Object.entries(fwd.headers)
      .map(([, v]) => (Array.isArray(v) ? v.join(" ") : String(v)))
      .join(" ");
    assert.ok(!fwdAll.includes(PROXY_USER) && !fwdAll.includes(PROXY_PASS), "转发请求任何头不得出现代理凭据");
    // 日志面：凭据（用户名/密码原文）不得出现在任何日志条目文本。
    const text = logText(h);
    assert.ok(!text.includes(PROXY_USER), `日志不得含代理用户名：${text}`);
    assert.ok(!text.includes(PROXY_PASS), `日志不得含代理密码：${text}`);
  } finally {
    await pf.closeAll();
    await fixture.close();
  }
});

test("e2) proxy URL 含 user:pass 且代理端口关闭：错误对象全部文本（message/stack/details/cause）与日志均不含凭据", async (t) => {
  const deadPort = await closedPort();
  const { h, pf, fixture } = await makeProxyChain(t, {
    ids: ["po-e2"],
    configure: () => [
      keyedEntry("po-e2", "tavily", "条目甲", {
        proxy: `http://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:${deadPort}`,
      }),
    ],
  });
  try {
    const err = await realAwait(
      h.search({ query: DEFAULT_QUERY }).then(
        () => {
          throw new Error("预期单条目全败（死代理端口）");
        },
        (e) => e,
      ),
      "po-e2",
    );

    // 终态形状：单条目全败 → CHAIN_UPSTREAM_FAILURES，attempts[0] 原码 ENTRY_PROXY（与 (d) 同语义）。
    assert.equal(err?.name, "WebError");
    assert.equal(err?.code, CHAIN_CODES.UPSTREAM_FAILURES, "单条目全败终态码（出口 v0.2 不变）");
    assert.equal(err?.details?.attempts?.[0]?.code, ENTRY_CODES.PROXY, "attempts[0].code 须为 ENTRY_PROXY");

    // 脱敏面（CFG-003）：错误对象全部可观察文本与日志均不含代理凭据明文。
    const errText = collectErrorText(err);
    assert.ok(!errText.includes(PROXY_USER) && !errText.includes(PROXY_PASS), `错误对象文本不得含代理凭据：${errText}`);
    const log = logText(h);
    assert.ok(!log.includes(PROXY_USER) && !log.includes(PROXY_PASS), `日志不得含代理凭据：${log}`);
    // transport warn 仍给出可操作的代理端点（host:port），且端点不含 userinfo（endpointOf 既定行为）。
    assert.ok(log.includes(`127.0.0.1:${deadPort}`), "代理失败诊断须保留代理 host:port（可操作原因）");
    assert.ok(!log.includes(`${PROXY_USER}:`), "诊断端点不得含 userinfo（凭据脱敏）");
  } finally {
    await pf.closeAll();
    await fixture.close();
  }
});

// ─── (f) 卸载 closeAll 与在途搜索协调（PR #62 P2，discussion_r4709786331）─────────────────
// P2 根因：closeAll 只关闭当时已存在的 ProxyAgent；若在途搜索（await 凭据/准备降级条目）其后到达
// fetchFn，agentFor() 会在已清空/已关闭的池上再造新 agent——唯一一次卸载清理已完成，该 agent 的
// 连接池永不被管理。修复语义：closeAll 同步置 closed 位（幂等）；代理路由 fetch 入口先查位显式拒绝
// （CFG-001 红线：绝不静默改走直连；direct 路由无插件自有连接池、维持放行），拒绝错误复用既有
// ENTRY_PROXY 阶段码经 transport.mapFetchError 的 carriesPassthroughCode 原样透传（不新增公开码）。
// pf.agentCount：createProductionFetch 返回值上暴露的池内 agent 数（map size），本面断言用。

/** 轮询等待条件成立（真实时间上限兜底）：用于等 CONNECT fixture 数到在途请求。 */
async function waitFor(cond, label, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - t0 > ms) throw new Error(`[${label}] ${ms}ms 内未收敛（本地 fixture 不应如此慢）`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("f1) closeAll 之后代理路由请求：显式拒绝（ENTRY_PROXY 语义/明确文案）、零新隧道、绝不静默改走直连", async (t) => {
  const { h, pf, fixture } = await makeProxyChain(t, {
    ids: ["po-f1"],
    configure: (fx) => [keyedEntry("po-f1", "tavily", "条目甲", { proxy: fx.proxyUrl })],
  });
  try {
    // 前提：真实隧道已发生、池内恰一个 agent。
    await realAwait(h.search({ query: DEFAULT_QUERY }), "po-f1-pre");
    assert.ok(fixture.state.connects.length > 0, "前提：隧道已发生");
    const connectsBefore = fixture.state.connects.length;
    assert.equal(fixture.state.requests.length, 1, "前提：转发请求恰 1 次");
    assert.equal(pf.agentCount, 1, "前提：池内恰一个 agent（按 proxyUrl 缓存复用）");

    // P2：卸载清理。
    await pf.closeAll();
    assert.equal(pf.agentCount, 0, "closeAll 须同步清空池（无未管理 agent 残留）");

    // 边界面：closeAll 之后直接经 A4 接缝发代理路由请求——显式拒绝、不得再建新 agent、零出站。
    const boundaryErr = await realAwait(
      pf(`${fixture.originUrl}/echo`, {
        method: "POST",
        route: { kind: "proxy", proxyUrl: fixture.proxyUrl },
      }).then(
        () => {
          throw new Error("预期拒绝（closeAll 之后代理路由不得到达 undici）");
        },
        (e) => e,
      ),
      "po-f1-boundary",
    );
    assert.equal(
      boundaryErr.code,
      ENTRY_CODES.PROXY,
      "拒绝错误须复用既有 ENTRY_PROXY 阶段码（carriesPassthroughCode 透传，不新增公开码）",
    );
    assert.match(boundaryErr.message, /插件已卸载，代理出站不可用/, "拒绝文案须明确可操作（不得是网络异常口径）");
    assert.equal(fixture.state.connects.length, connectsBefore, "closeAll 之后不得发起新 CONNECT（不得在已清空池上造新 agent）");

    // 链条面：closeAll 之后才到达 fetch 的搜索（在途 await 凭据/准备降级条目的窗口）——
    // 归 ENTRY_PROXY（FB-005 代理阶段归因，不压成 ENTRY_NETWORK），终态形状出口 v0.2 不变。
    const err = await realAwait(
      h.search({ query: DEFAULT_QUERY }).then(
        () => {
          throw new Error("预期单条目全败（closeAll 之后代理路由被拒绝）");
        },
        (e) => e,
      ),
      "po-f1-chain",
    );
    assert.equal(err?.name, "WebError");
    assert.equal(err?.code, CHAIN_CODES.UPSTREAM_FAILURES, "单条目全败终态码（出口 v0.2 不变）");
    assert.equal(
      err?.details?.attempts?.[0]?.code,
      ENTRY_CODES.PROXY,
      "closeAll 之后 attempts[0].code 须为 ENTRY_PROXY（代理阶段归因，不得压成网络失败）",
    );
    const reasons = (err?.details?.attempts ?? []).map((a) => a.reason).join(" ");
    assert.match(reasons, /代理失败/, "attempts.reason 须按代理失败归因（FB-002/FAILURE_REASON.PROXY）");
    // 零隧道计数 + 零直连出站（CFG-001 红线：绝不静默改走直连）。
    assert.equal(fixture.state.connects.length, connectsBefore, "链条面 closeAll 后搜索零新 CONNECT（CONNECT fixture 计数不变）");
    assert.equal(fixture.state.requests.length, 1, "closeAll 之后不得静默改走直连（origin 只见前提那一次转发）");
  } finally {
    await pf.closeAll();
    await fixture.close();
  }
});

test("f2) closeAll 幂等：两次调用不抛，池已清空且代理路由仍显式拒绝", async (t) => {
  const { h, pf, fixture } = await makeProxyChain(t, {
    ids: ["po-f2"],
    configure: (fx) => [keyedEntry("po-f2", "tavily", "条目甲", { proxy: fx.proxyUrl })],
  });
  try {
    await realAwait(h.search({ query: DEFAULT_QUERY }), "po-f2-pre");
    assert.equal(pf.agentCount, 1, "前提：池内恰一个 agent");

    await pf.closeAll(); // 第一次：关闭真实 agent
    await pf.closeAll(); // 第二次：幂等，不得抛
    assert.equal(pf.agentCount, 0, "幂等重复调用后池仍为空");

    // 双重 closeAll 之后代理路由仍显式拒绝（closed 位不因重复调用而失效）。
    const boundaryErr = await realAwait(
      pf(`${fixture.originUrl}/echo`, { route: { kind: "proxy", proxyUrl: fixture.proxyUrl } }).then(
        () => {
          throw new Error("预期拒绝（双重 closeAll 之后代理路由仍不可用）");
        },
        (e) => e,
      ),
      "po-f2",
    );
    assert.equal(boundaryErr.code, ENTRY_CODES.PROXY);
    assert.match(boundaryErr.message, /插件已卸载，代理出站不可用/);
    assert.equal(fixture.state.connects.length, 1, "双重 closeAll 之后零新 CONNECT");
  } finally {
    await pf.closeAll();
    await fixture.close();
  }
});

test("f3) 在途模拟：CONNECT 挂起中途 closeAll——在途照常结算、零未管理 agent、其后请求被拒绝", async (t) => {
  const STALL_MS = 150;
  const { h, pf, fixture } = await makeProxyChain(t, {
    ids: ["po-f3"],
    configure: (fx) => [keyedEntry("po-f3", "tavily", "条目甲", { proxy: fx.proxyUrl })],
    fixtureOpts: { connectStallMs: STALL_MS },
  });
  try {
    // 发起代理请求：fixture 的 CONNECT 应答挂起 STALL_MS（模拟在途，agent 已建、请求未结算）。
    const pending = h.search({ query: DEFAULT_QUERY });
    await waitFor(() => fixture.state.connects.length > 0, "po-f3 CONNECT");
    assert.equal(pf.agentCount, 1, "在途：池内恰一个 agent（真实隧道已发起、未结算）");

    // P2：在途中途 closeAll——closed 位同步置位，agent.close 等待在途请求结算后关闭池。
    let closingSettled = false;
    const closing = pf.closeAll().then(() => {
      closingSettled = true;
    });
    assert.equal(closingSettled, false, "在途未结算时 closeAll 不得提前落定（须等待在途请求完成，不中断其配置）");
    assert.equal(pf.agentCount, 0, "closeAll 须同步清空池（在途 agent 已交给 close 流程管理，不留逃逸窗口）");

    // 在途请求照常结算（挂起有限、隧道随后建立完成）。
    const res = await realAwait(pending, "po-f3", 10_000);
    assertSearchResult(t, res, { sources: ECHO_SOURCES, truncated: false });
    await realAwait(closing, "po-f3 closeAll");
    assert.equal(closingSettled, true, "在途结算后 closeAll 必须落定（关闭流程收敛）");

    // 零未管理 agent：池仍空；其后代理路由请求被拒绝且零新 CONNECT（agentFor 不得在已关闭池上再造 agent）。
    assert.equal(pf.agentCount, 0, "在途请求结算后池仍为空（无未关闭 agent 残留）");
    const connectsTotal = fixture.state.connects.length;
    const boundaryErr = await realAwait(
      pf(`${fixture.originUrl}/echo`, { route: { kind: "proxy", proxyUrl: fixture.proxyUrl } }).then(
        () => {
          throw new Error("预期拒绝（在途结算后代理路由仍不可用）");
        },
        (e) => e,
      ),
      "po-f3-post",
    );
    assert.equal(boundaryErr.code, ENTRY_CODES.PROXY);
    assert.match(boundaryErr.message, /插件已卸载，代理出站不可用/);
    assert.equal(fixture.state.connects.length, connectsTotal, "在途结算后其后请求零新 CONNECT（无未管理 agent 逃逸）");
  } finally {
    await pf.closeAll();
    await fixture.close();
  }
});

// ─── 生产接线面：真实 apply 全链（provider → 链 → 真实 transport → 真实生产出站 → undici）───
// 与上面各面（harness 注入风格）互补：本例不经任何 testDeps 注入 fetch/transport，走 src/index.js
// apply 的生产装配（dsh-official-routing CFG-004 生产接线面同款）。条目用 bing（免 key，避免凭据面
// 干扰）+ 死代理端口：零真实外网（CONNECT 在建连阶段即被拒），只钉「生产接线上代理失败归 ENTRY_PROXY」。

test("生产接线：真实 apply 下配 proxy（死端口）的条目 → attempts[0].code=ENTRY_PROXY、零直连出站（CFG-001 红线）", async (t) => {
  const mod = await loadIndex(t);
  const deadPort = await closedPort();
  const entry = {
    id: "po-w1",
    type: "bing",
    name: "条目甲",
    enabled: true,
    proxy: `http://127.0.0.1:${deadPort}`,
  };
  const config = { entries: [entry], useOfficialDeepSeekSearch: false, timeoutMs: 60_000 };
  const host = createHostShapeFakeHost({
    inject: mod.inject,
    config: structuredClone(config),
  });
  await Promise.resolve(mod.apply(host.ctx, structuredClone(config)));
  const provider = host.searchRegistrations()[0];
  assert.ok(provider && provider.id === "search-chain", "provider 须经 apply 注册（DSH-001）");

  const err = await realAwait(
    provider.search({ query: DEFAULT_QUERY }).then(
      () => {
        throw new Error("预期单条目全败（死代理端口）");
      },
      (e) => e,
    ),
    "po-w",
  );
  try {
    assert.equal(err.name, "WebError");
    assert.equal(err?.code, CHAIN_CODES.UPSTREAM_FAILURES, "生产装配下代理全败终态（出口 v0.2 不变）");
    assert.equal(
      err?.details?.attempts?.[0]?.code,
      ENTRY_CODES.PROXY,
      "生产装配（apply → createProductionChain → 真实 productionFetch）下代理故障仍归 ENTRY_PROXY（FB-005）",
    );
    const reasons = (err?.details?.attempts ?? []).map((a) => a.reason).join(" ");
    assert.match(reasons, /代理失败/, "attempts.reason 须按代理失败归因（FB-002/FAILURE_REASON.PROXY）");
  } finally {
    await host.disposeAll(); // 经生产 cleanup 释放代理连接池（closeAll 幂等）
  }
});
