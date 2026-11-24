// WP1 验收（oracle 增量）— src/transport.js 的三形态路由、逐条隔离、取消与 PAC。
//
// 覆盖条款（docs/specs/draft/config-network.md、fallback.md）：
//   CFG-001：直连 / 固定代理 / PAC 三种网络设置的**实际路由**差异；固定代理故障不得退化为直连，
//            且报告可定位到该条目或其代理端点；代理作用范围限于该条目；绝不读取宿主/全局代理变量。
//   CFG-003：条目 key 只出现在该条目供应商请求的鉴权头；PAC 下载请求与其他条目请求零携带；
//            无「粘性鉴权头」（上次调用的 key 不得进入后续调用）；代理/PAC 故障的返回错误与日志
//            不含 key、代理认证、带认证参数的 PAC URL、原始报错响应体（cause 原文不外泄）。
//   CFG-004：同一 transport（= 一个已保存快照里的一个条目）内多次请求路由一致；close/closeAll 幂等释放；
//            释放不得打断在途请求（在途请求沿用其配置直到完成或取消）；释放后不再产出出站请求；
//            同配置的两个 transport 路由一致（快照语义，与「改用代理 B」的可观察差异归 WP5/WP12）。
//   CFG-005：PAC 脚本直连下载、保留查询参数、只为实际取路由的条目发生；脚本在隔离环境求值；
//            FindProxyForURL 收到目标 URL 与主机；标准助手可用；PROXY/HTTPS/DIRECT 三指令与 pacIndex；
//            请求已提交后零重发；下载 / 求值 / 路由三阶段错误分别带 PAC_FETCH_FAILED / PAC_EVAL_FAILED /
//            PAC_ROUTE_FAILED。
//   FB-003 ：signal 已取消或按受控时钟到点时零出站、在途请求以 AbortError 落定、取消后出站请求不再增加；
//            全部时间只走注入 clock（不拨钟不得落定）。
//
// 与 WP0 test/config-contract.test.js 的去重：proxy 三形态的**校验**（合法/非法/空白=直连）、
// 四层 key 优先级、TRUSTED_ENV_KEYS、明文 key 不落盘、冻结快照、保存一致性均已在该文件锁定；
// 本文件只验 transport 层的运行时路由与取消/释放，不重复校验期断言。
// config 侧仅补两处 WP0 未锁定面，见 test/config-transport-gaps.test.js。
//
// 契约接缝（helpers/contract.js A4/A6/A8）：
//   createEntryTransport(entry, { fetch, clock, log }) → { fetch(url, init), close(), closeAll() }
//   交给注入 fetch 的 init.route = { kind: "direct"|"proxy"|"https-proxy", proxyUrl?, viaPac?,
//                                     pacIndex?, pacSource?, pacRevision?, phase? }
//   注入 fetch = helpers/fake-fetch.js 的 createFakeFetch（default:"never"：未声明出站即抛，
//   因此「不得再发请求」类条款以 fetchFn.calls 计数核查）；时间 = helpers/clock.js 受控时钟。
//
// 本文件写死的 oracle 假设（编号供 PR 讨论；若要改契约，按 contract.js 头注释规则在同一 PR 内改并给理由）：
//   R1 kind 表达**实际使用的代理连接形态**：直连→direct；proxy 为 http:// 正向代理 或 PAC `PROXY`
//      指令→proxy；proxy 为 https:// 正向代理 或 PAC `HTTPS` 指令→https-proxy。
//      （PAC 派生路由一律带 viaPac=true，以便与「未配置代理的直连」区分。）
//   R2 route.proxyUrl 为配置值 / PAC 指令的规范化绝对 URL：`PROXY h:p`→http://h:p，`HTTPS h:p`→https://h:p。
//   R3 route.pacIndex 是该次请求所用**脚本指令列表**中的 0 基序号（仅 PAC 派生路由携带）。
//   R4 PAC 脚本下载请求本身按 CFG-005 首句「须直连获取」：kind=direct、不带 proxyUrl、不带 viaPac。
//   R5 阶段码：下载失败（非 2xx / 网络故障）→PAC_FETCH_FAILED；脚本语法错误、脚本体求值抛错、
//      缺 FindProxyForURL →PAC_EVAL_FAILED；返回空或未知指令→PAC_ROUTE_FAILED。
//      FindProxyForURL 自身抛错落在「求值/路由」边界，本文件放宽到两码之一（已列入报告歧义清单）。
//   R6 取消与释放语义收紧：signal 已取消、或 transport 已释放时，transport **不得把请求交给注入 fetch**
//      （零出站记录）。真实 fetch 在取消后仍会留下连接尝试，本收紧让 FB-003「取消后出站请求数不再增加」
//      与 CFG-004「释放后不得复活连接」在本接缝可机检。
//   R7 注入 fetch 抛出的错误其 message/cause 可能含敏感原文（代理认证、条目 key、原始响应体）。
//      原样上抛会同时违反 CFG-003 与 A7（message 须为脱敏文本）：本文件要求 transport 上抛的错误对象
//      自带脱敏归因（能定位到该条目或其代理端点），日志同样脱敏；错误对象图（含 cause/非枚举属性/stack）
//      全部纳入扫描。
//   R8 最小标准 PAC 助手集合：isPlainHostName / dnsDomainIs / shExpMatch（纯字符串语义，不触网）。
//
// 不在本接缝验证（归属说明，避免重复与越界）：
//   · FB-005 的 ENTRY_* 归因映射与 FB-003 的预算分配公式属 WP5 src/search.js（classifyUpstreamFailure/链）；
//     本文件只证明 transport 在「取消 / 已释放 / 取消后」三种状态下零出站。
//   · 「PAC 建连失败（未提交查询）后换下一条路由」需要建连探测的注入面（A4 deps 只有 fetch/clock/log），
//     本接缝无法确定性复现，见最终报告歧义清单第 3 条。
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "./helpers/contract.js";
import { createControlledClock, flush } from "./helpers/clock.js";
import { createFakeFetch, SYNTHETIC_KEY, SYNTHETIC_PROXY, SYNTHETIC_PAC } from "./helpers/fake-fetch.js";
import { assertNoSecrets, assertNoCredentialUserinfo, assertNoRawBody, createLogCapture } from "./helpers/redact.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";

const WP = "WP1 src/transport.js";
const CLAUSES = "CFG-001/003/004/005 + FB-003";

async function load(t) {
  const res = await tryImportSrc("transport.js");
  if (failIfUnimplemented(t, res, WP, CLAUSES)) return null;
  return res.module;
}

/** 合成供应商目标（保留域；绝不指向真实供应商，见 test/fixtures/README.md 规则 1）。 */
const TARGET = "https://api.tavily.invalid/search?query=%E5%90%88%E6%88%90-synthetic";
const TARGET_OTHER = "https://api.openai.invalid/v1/responses?q=synthetic";

const PAC_PROXY = "http://pac-proxy-a.invalid:3128";
const PAC_TLS = "https://pac-proxy-tls.invalid:4443";
const PAC_MULTI_FIRST = "http://pac-sep-first.invalid:3130";
const ENV_PROXY_LEAK = "http://env-proxy-leak.invalid:9999";

const PROXY_KINDS = new Set(["proxy", "https-proxy"]);

/** 造一个只返回固定指令的 PAC 脚本。 */
function pacBody(instruction) {
  return `function FindProxyForURL(url, host) { return ${JSON.stringify(instruction)}; }`;
}

function declarePac(fetchFn, script, { status = 200 } = {}) {
  fetchFn.when(SYNTHETIC_PAC).responds({
    status,
    body: script,
    headers: { "content-type": "application/x-ns-proxy-autoconfig" },
  });
}

/** 打开一个 transport 及其观测面：受控时钟、假 fetch（未声明出站即抛）、日志采集。 */
function openTransport(mod, entry, opts = {}) {
  assert.equal(
    typeof mod.createEntryTransport,
    "function",
    "src/transport.js 必须导出 createEntryTransport(entry, { fetch, clock, log })（A4）",
  );
  const clock = createControlledClock({ now: opts.now });
  const fetchFn = createFakeFetch({ default: "never", clock });
  const logCapture = createLogCapture();
  const transport = mod.createEntryTransport(entry, { fetch: fetchFn, clock, log: logCapture.log });
  assert.equal(typeof transport?.fetch, "function", "createEntryTransport 必须返回 fetch(url, init)（A4）");
  assert.equal(typeof transport.close, "function", "必须返回 close()（A4/CFG-004）");
  assert.equal(typeof transport.closeAll, "function", "必须返回 closeAll()（A4/CFG-004）");
  return { clock, fetchFn, logCapture, transport };
}

/** 记录 promise 落定状态，避免拨钟期间的 unhandled rejection。 */
function track(promise) {
  const out = { state: "pending", value: undefined, error: undefined };
  promise.then(
    (value) => {
      out.state = "ok";
      out.value = value;
    },
    (error) => {
      out.state = "err";
      out.error = error;
    },
  );
  return out;
}

/** 拨钟 + 冲刷直到 track 结果落定（超时保留 pending 状态，由调用方断言并给出可诊断信息）。 */
async function settle(clock, out, ms = 30_000) {
  await flush(3);
  if (out.state === "pending" && clock.pending().length > 0) clock.advance(ms);
  await flush(6);
  return out;
}

/** 出站记录的路由标记（缺失即红：A4 要求 transport 标注路由）。 */
function routeOf(record) {
  const route = record?.init?.route;
  assert.ok(
    route && typeof route === "object",
    `交给注入 fetch 的 init 必须带 route 路由标记（A4），实际出站：${record?.url}`,
  );
  return route;
}

/** 找出目标请求（排除 PAC 下载等 transport 自身请求）。 */
function targetCall(fetchFn, url = TARGET) {
  const calls = fetchFn.callsFor(url);
  assert.ok(calls.length > 0, `没有向目标 ${url} 的出站记录（实际出站：${JSON.stringify(fetchFn.calls.map((c) => c.url))}）`);
  return calls[0];
}

/**
 * route.proxyUrl 必须指向同一代理端点。允许实现做 URL 规范化（尾斜杠等），
 * 但方案与 host:port 必须一致（明文/ TLS 混用属不同路由）。
 */
function proxyUrlIs(actual, expected, label) {
  assert.equal(typeof actual, "string", `${label}：route.proxyUrl 必须是字符串（R2），实际：${JSON.stringify(actual)}`);
  let got;
  try {
    got = new URL(actual);
  } catch (e) {
    assert.fail(`${label}：route.proxyUrl 必须是绝对 URL（R2），实际：${actual}（${e.message}）`);
  }
  const want = new URL(expected);
  assert.equal(got.protocol, want.protocol, `${label}：代理方案必须一致（http/https 不得互换）：${actual}`);
  assert.equal(got.host, want.host, `${label}：代理 host:port 必须等于该条目配置/脚本指令：${actual}`);
  assert.ok(["", "/", undefined].includes(got.pathname), `${label}：代理 URL 不得夹带路径：${actual}`);
}

// ─── CFG-001 三形态的实际路由 ───────────────────────────────────────────────

test("CFG-001：直连条目——route.kind=direct、无 proxyUrl，init 原样透传（headers/method/body/signal）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = C.makeEntry({ id: "e-direct", type: "tavily" });
  const { fetchFn, transport } = openTransport(mod, entry);
  fetchFn.when(TARGET).responds({ status: 200, body: { results: [] } });

  const ac = new AbortController();
  const res = await transport.fetch(TARGET, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ query: "合成查询" }),
    signal: ac.signal,
  });

  const call = targetCall(fetchFn);
  const route = routeOf(call);
  assert.equal(route.kind, "direct", `未配置 proxy 的条目必须直连（CFG-001），实际：${JSON.stringify(route)}`);
  assert.equal(route.proxyUrl, undefined, `直连路由不得带 proxyUrl（CFG-001）：${JSON.stringify(route)}`);
  assert.notEqual(route.viaPac, true, "未配置 PAC 的条目不得声称路由来自 PAC");
  assert.equal(call.url, TARGET, "目标 URL 必须原样送出（路径与查询参数不得被改写）");
  assert.equal(call.method, "POST", "method 必须透传给注入 fetch（A6：适配器自行构造请求）");
  assert.equal(call.headers.accept, "application/json", "headers 必须透传");
  assert.equal(call.signal, ac.signal, "signal 必须透传（FB-003 取消入口）");
  assert.equal(res.status, 200, "fetch 必须把响应原样交回调用方");
  assert.deepEqual(await res.json(), { results: [] }, "响应体不得被 transport 提前消费");
});

test("CFG-001：固定代理条目——route 标为代理且 proxyUrl 等于条目配置；目标 URL 不被改写", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = C.makeEntry({ id: "e-proxy", type: "tavily", proxy: SYNTHETIC_PROXY });
  const { fetchFn, transport } = openTransport(mod, entry);
  fetchFn.when(TARGET).responds({ body: { results: [] } });

  await transport.fetch(TARGET, { headers: { authorization: `Bearer ${SYNTHETIC_KEY("tavily")}` } });

  const call = targetCall(fetchFn);
  const route = routeOf(call);
  assert.ok(
    PROXY_KINDS.has(route.kind),
    `配置了 HTTP 正向代理的条目必须标为 proxy/https-proxy（CFG-001，oracle 假设 R1），实际：${JSON.stringify(route)}`,
  );
  proxyUrlIs(route.proxyUrl, SYNTHETIC_PROXY, "固定代理条目的 route.proxyUrl");
  assert.notEqual(route.viaPac, true, "固定代理不是 PAC 派生路由");
  assert.equal(call.url, TARGET, "目标 URL 必须原样送出，代理只体现在路由标记（A4）");
  assert.ok(
    !call.url.includes("syn-proxy.invalid"),
    `绝不得把请求目标改写成代理地址（CFG-001）：${call.url}`,
  );
});

test("CFG-001：https:// 正向代理条目必须标为 https-proxy（TLS 到代理，不可降级为明文 proxy）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const proxy = "https://syn-proxy-sec.invalid:8443";
  const entry = C.makeEntry({ id: "e-proxy-tls", type: "openai", proxy });
  const { fetchFn, transport } = openTransport(mod, entry);
  fetchFn.when(TARGET_OTHER).responds({ body: { ok: true } });

  await transport.fetch(TARGET_OTHER);
  const route = routeOf(targetCall(fetchFn, TARGET_OTHER));
  assert.equal(
    route.kind,
    "https-proxy",
    `https:// 代理必须以 https-proxy 标注（R1：kind 反映实际连接形态，明文 CONNECT 到 TLS 代理属安全缺陷），实际：${JSON.stringify(route)}`,
  );
  proxyUrlIs(route.proxyUrl, proxy, "TLS 代理条目的 route.proxyUrl");
});

test("CFG-001：固定代理故障绝不退化为直连；错误可定位到该条目或其代理端点", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = C.makeEntry({ id: "e-proxy-down", type: "tavily", proxy: SYNTHETIC_PROXY });
  const { clock, fetchFn, transport } = openTransport(mod, entry);
  fetchFn
    .when(TARGET)
    .fails({ error: Object.assign(new Error("[synthetic] connect ECONNREFUSED syn-proxy.invalid:8080"), { code: "ECONNREFUSED" }) });

  const out = track(transport.fetch(TARGET));
  const o = await settle(clock, out);
  assert.equal(o.state, "err", "固定代理故障不得静默改为直连后返回成功（CFG-001）");

  const calls = fetchFn.callsFor(TARGET);
  assert.equal(calls.length, 1, `代理故障后同一请求不得再以直连重发（不得绕过代理出站，CFG-001）：${calls.length}`);
  for (const c of calls) {
    const route = routeOf(c);
    assert.ok(
      PROXY_KINDS.has(route.kind),
      `每一次出站都必须留在代理路由上，绝不回退 direct（CFG-001）：${JSON.stringify(route)}`,
    );
    proxyUrlIs(route.proxyUrl, SYNTHETIC_PROXY, "代理故障出站的 route.proxyUrl");
  }
  const msg = String(o.error?.message ?? "");
  assert.ok(msg.length > 0, "错误必须给出可操作原因（CFG-001/FB-005）");
  assert.ok(
    /syn-proxy\.invalid/.test(msg) || msg.includes(entry.id) || msg.includes(entry.name),
    `错误须可定位到该条目或其代理端点（CFG-001「报告相应条目原因」/FB-005 可核查），实际：${JSON.stringify(msg)}`,
  );
});

test("CFG-001：代理作用范围限于该条目——直连/固定代理/PAC 三条目互不污染", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const proxyB = "http://syn-proxy-b.invalid:8081";
  const direct = C.makeEntry({ id: "e-a-direct", type: "bing" });
  const proxied = C.makeEntry({ id: "e-b-proxy", type: "tavily", proxy: proxyB });
  const pac = C.makeEntry({ id: "e-c-pac", type: "openai", proxy: { pac: SYNTHETIC_PAC } });

  const a = openTransport(mod, direct);
  const b = openTransport(mod, proxied);
  const c = openTransport(mod, pac);
  a.fetchFn.when(TARGET).responds({ body: { ok: true } });
  b.fetchFn.when(TARGET).responds({ body: { ok: true } });
  declarePac(c.fetchFn, pacBody("DIRECT"));
  c.fetchFn.when(TARGET).responds({ body: { ok: true } });

  await a.transport.fetch(TARGET);
  await b.transport.fetch(TARGET);
  await c.transport.fetch(TARGET);
  // 交叉再发一次：任何跨 transport 的路由缓存都会在这里暴露
  await a.transport.fetch(TARGET);
  await b.transport.fetch(TARGET);

  for (const call of a.fetchFn.calls) {
    const route = routeOf(call);
    assert.equal(route.kind, "direct", `直连条目不得继承其他条目的代理（CFG-001 作用范围）：${JSON.stringify(route)}`);
    assert.equal(route.proxyUrl, undefined);
  }
  for (const call of b.fetchFn.calls) {
    const route = routeOf(call);
    assert.ok(PROXY_KINDS.has(route.kind), `代理条目必须始终走自己的代理：${JSON.stringify(route)}`);
    proxyUrlIs(route.proxyUrl, proxyB, "代理条目自己的 route.proxyUrl（不得串到别的条目）");
  }
  const pacTargetRoute = routeOf(targetCall(c.fetchFn));
  assert.equal(pacTargetRoute.viaPac, true, "PAC 条目的路由须标记来自 PAC（R1）");
  assert.ok(
    c.fetchFn.calls.every((call) => !JSON.stringify(call.init).includes("syn-proxy-b")),
    "PAC 条目绝不得使用其他条目的固定代理",
  );
});

test("CFG-001：绝不读取宿主/全局代理变量——HTTP(S)_PROXY、ALL_PROXY、小写同名片段一律无视", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"];
  const saved = names.map((name) => [name, Object.hasOwn(process.env, name) ? process.env[name] : undefined]);
  for (const name of names) process.env[name] = /^no_/i.test(name) ? "" : ENV_PROXY_LEAK;
  try {
    const direct = openTransport(mod, C.makeEntry({ id: "e-env-direct", type: "tavily" }));
    direct.fetchFn.when(TARGET).responds({ body: { ok: true } });
    await direct.transport.fetch(TARGET);

    const proxied = openTransport(mod, C.makeEntry({ id: "e-env-proxy", type: "tavily", proxy: SYNTHETIC_PROXY }));
    proxied.fetchFn.when(TARGET).responds({ body: { ok: true } });
    await proxied.transport.fetch(TARGET);

    for (const bag of [direct, proxied]) {
      for (const call of bag.fetchFn.calls) {
        const route = routeOf(call);
        assert.ok(
          !String(route.proxyUrl ?? "").includes("env-proxy-leak"),
          `全局代理变量不得成为条目代理（CFG-001「插件不得改动/借用宿主全局代理」）：${route.proxyUrl}`,
        );
      }
    }
    assert.equal(routeOf(targetCall(direct.fetchFn)).kind, "direct", "环境里有代理变量时未配置代理的条目仍须直连");
    proxyUrlIs(routeOf(targetCall(proxied.fetchFn)).proxyUrl, SYNTHETIC_PROXY, "环境变量存在时条目自己的代理不得被覆盖");
    assert.ok(
      !direct.logCapture.text().includes("env-proxy-leak") && !proxied.logCapture.text().includes("env-proxy-leak"),
      "日志不得出现全局代理变量的值",
    );
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// ─── CFG-003 逐条 key 注入与脱敏 ────────────────────────────────────────────

test("CFG-003：key 只出现在正确供应商的鉴权头；PAC 下载请求零凭据", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const key = SYNTHETIC_KEY("tavily");
  const entry = C.makeEntry({ id: "e-pac-key", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, pacBody("DIRECT"));
  fetchFn.when(TARGET).responds({ body: { results: [] } });

  await transport.fetch(TARGET, { headers: { authorization: `Bearer ${key}`, "x-api-key": key } });

  const target = targetCall(fetchFn);
  assert.equal(
    target.headers.authorization,
    `Bearer ${key}`,
    "供应商请求必须带上调用方给的鉴权头（transport 不得丢弃）",
  );
  assert.equal(fetchFn.count(SYNTHETIC_PAC), 1, "PAC 下载请求必须实际发生");
  const pacCall = fetchFn.callsFor(SYNTHETIC_PAC)[0];
  assert.equal(pacCall.headers.authorization, undefined, "PAC 下载绝不携带条目 key（CFG-003）");
  assert.equal(pacCall.headers["x-api-key"], undefined, "PAC 下载绝不携带条目 key（CFG-003）");
  assertNoSecrets(t, pacCall.init, [key], "PAC 下载请求");
  assertNoSecrets(t, pacCall.headers, [key], "PAC 下载请求头");
  assert.ok(
    fetchFn.calls.filter((c) => c.url.includes("api.tavily.invalid")).every((c) => c.headers.authorization === `Bearer ${key}`),
    "该条目的每个供应商请求都带自己的 key",
  );
});

test("CFG-003：无粘性鉴权头——上一次的 key 不得进入后续调用或其他条目", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const keyA = SYNTHETIC_KEY("openai-a");
  const keyB = SYNTHETIC_KEY("openai-b");
  const a = openTransport(mod, C.makeEntry({ id: "e-a", type: "openai" }));
  const b = openTransport(mod, C.makeEntry({ id: "e-b", type: "openai", proxy: SYNTHETIC_PROXY }));
  a.fetchFn.when(TARGET).responds({ body: { ok: true } });
  a.fetchFn.when(TARGET_OTHER).responds({ body: { ok: true } });
  b.fetchFn.when(TARGET_OTHER).responds({ body: { ok: true } });

  await a.transport.fetch(TARGET, { headers: { authorization: `Bearer ${keyA}` } });
  await a.transport.fetch(TARGET_OTHER); // 无鉴权头的后续调用
  await b.transport.fetch(TARGET_OTHER, { headers: { authorization: `Bearer ${keyB}` } });

  const second = a.fetchFn.callsFor(TARGET_OTHER)[0];
  assert.equal(
    second.headers.authorization,
    undefined,
    "transport 不得缓存/复用上次调用的鉴权头（CFG-003「key 只随对应供应商鉴权头发送」）",
  );
  assertNoSecrets(t, a.fetchFn.callsFor(TARGET_OTHER), [keyA], "同 transport 的后续无鉴权调用");
  assertNoSecrets(t, b.fetchFn.calls, [keyA], "其他条目的出站（逐条 key 不串条，CFG-003）");
  assertNoSecrets(t, a.fetchFn.callsFor(TARGET_OTHER), [keyB], "条目 A 的出站不得带条目 B 的 key");
  assert.equal(targetCall(b.fetchFn, TARGET_OTHER).headers.authorization, `Bearer ${keyB}`);
});

test("CFG-003/CFG-001：代理建连故障——cause 含认证与原始响应体时，上抛错误与日志必须脱敏且可定位", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const proxyUser = "syn-proxy-user";
  const proxyPass = "syn-pass";
  const proxyKey = SYNTHETIC_KEY("proxy");
  const rawBody = "<html><body>synthetic 502 bad gateway</body></html>";
  const entry = C.makeEntry({ id: "e-proxy-auth", type: "tavily", proxy: SYNTHETIC_PROXY });
  const { clock, fetchFn, logCapture, transport } = openTransport(mod, entry);
  const rawCause = new Error(
    `[synthetic] proxy connect failed for http://${proxyUser}:${proxyPass}@syn-proxy.invalid:8080 ` +
      `Authorization: Basic ${proxyKey}; upstream said: ${rawBody}`,
  );
  rawCause.cause = { proxyAuthorization: `Basic ${proxyKey}`, rawBody, proxy: `http://${proxyUser}:${proxyPass}@syn-proxy.invalid:8080` };
  fetchFn.when(TARGET).fails({ error: rawCause });

  const out = track(transport.fetch(TARGET));
  const o = await settle(clock, out);
  assert.equal(o.state, "err", "代理故障必须上抛");
  assert.ok(o.error instanceof Error, "transport 归因必须是错误对象");
  assert.ok(String(o.error.message ?? "").length > 0, "错误须给出可操作原因");

  for (const [label, value] of [["上抛错误", o.error], ["transport 日志", logCapture.text()]]) {
    assertNoSecrets(t, value, [proxyKey], `${label}（CFG-003：代理认证/实际 key 不得外泄）`);
    assertNoSecrets(t, value, [proxyPass], `${label}（CFG-003：代理口令不得外泄）`);
    assertNoCredentialUserinfo(t, value, `${label}（CFG-003：不得出现带认证信息的代理 URL）`);
    assertNoRawBody(t, value, `${label}（CFG-003：原始报错响应体不得进入）`);
  }
  assert.ok(
    !String(o.error.message ?? "").includes(proxyUser),
    "上抛错误不得包含代理用户名",
  );
  assert.ok(
    /syn-proxy\.invalid/.test(String(o.error.message ?? "")) || String(o.error.message ?? "").includes(entry.id),
    `脱敏后仍须可定位到该条目或代理端点（CFG-001/FB-005），实际：${JSON.stringify(String(o.error.message ?? ""))}`,
  );
});

test("CFG-003：代理 URL 的认证参数绝不落到出站目标 URL；日志无带认证信息 URL", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const user = "syn-proxy-user";
  const pass = "syn-pass";
  const entry = C.makeEntry({ id: "e-proxy-auth-url", type: "tavily", proxy: SYNTHETIC_PROXY });
  const { fetchFn, logCapture, transport } = openTransport(mod, entry);
  fetchFn.when(TARGET).responds({ body: { ok: true } });

  await transport.fetch(TARGET);

  const call = targetCall(fetchFn);
  assert.equal(call.url, TARGET, "目标 URL 必须就是供应商地址");
  assert.ok(
    !call.url.includes(user) && !call.url.includes(pass) && !call.url.includes("@"),
    `认证参数不得进入出站 URL（CFG-003）：${call.url}`,
  );
  assertNoCredentialUserinfo(t, logCapture.text(), "transport 日志");
  assertNoSecrets(t, logCapture.text(), [pass], "transport 日志");
});

// ─── CFG-004 快照内一致性与释放 ─────────────────────────────────────────────

test("CFG-004：同一 transport 内多次请求路由一致（PAC 求值幂等），响应原样交回", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = C.makeEntry({ id: "e-reuse", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, pacBody("PROXY pac-reuse.invalid:3129"));
  fetchFn.when(TARGET).responds({ status: 200, body: { n: 1 } });
  fetchFn.when(TARGET_OTHER).responds({ status: 201, body: { n: 2 } });

  const r1 = await transport.fetch(TARGET);
  const r2 = await transport.fetch(TARGET_OTHER);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 201);
  assert.deepEqual(await r2.json(), { n: 2 }, "两次调用的响应体互不干扰（每请求独立）");

  const routes = [targetCall(fetchFn), targetCall(fetchFn, TARGET_OTHER)].map(routeOf);
  assert.deepEqual(routes[1], routes[0], "同一 transport（同一快照条目）的多次请求必须使用同一条已解析路由（CFG-004）");
  assert.equal(routes[0].viaPac, true);
  assert.equal(new URL(String(routes[0].proxyUrl)).host, "pac-reuse.invalid:3129");
});

test("CFG-004：close/closeAll 幂等；释放后不得再产出出站请求（含 closeAll 后再 close）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = C.makeEntry({ id: "e-close", type: "tavily", proxy: SYNTHETIC_PROXY });
  const { clock, fetchFn, transport } = openTransport(mod, entry);
  fetchFn.when(TARGET).responds({ body: { ok: true } });
  await transport.fetch(TARGET);
  const before = fetchFn.calls.length;

  transport.close();
  transport.close();
  transport.closeAll();
  transport.closeAll();
  transport.close();

  const out = track(transport.fetch(TARGET));
  const o = await settle(clock, out);
  assert.equal(o.state, "err", "已释放的 transport 不得再成功发出请求（CFG-004：释放后不得复活连接）");
  assert.equal(fetchFn.calls.length, before, `释放后零出站（oracle 假设 R6）：新增 ${fetchFn.calls.length - before} 条`);
});

test("CFG-004/FB-003：close 不得打断在途请求；完成后释放不留悬挂定时器", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = C.makeEntry({ id: "e-inflight", type: "tavily", proxy: SYNTHETIC_PROXY });
  const { clock, fetchFn, transport } = openTransport(mod, entry);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true }, delayMs: 600 });

  const out = track(transport.fetch(TARGET));
  await flush(3);
  assert.equal(out.state, "pending", "未拨钟不得完成（时间必须走注入 clock）");
  transport.close(); // 在途期间释放：只影响后续新请求
  await flush(3);
  assert.equal(out.state, "pending", "close() 不得取消在途请求（CFG-004：在途请求沿用其配置直到完成或取消）");

  clock.advance(600);
  await flush(6);
  assert.equal(out.state, "ok", `在途请求须正常完成（CFG-004），实际：${out.state} ${out.error?.message ?? ""}`);
  assert.equal(clock.pending().length, 0, `释放后不得留下悬挂的受控定时器（CFG-004/FB-003）：${JSON.stringify(clock.pending())}`);
  assert.equal(clock.invalidTimings.length, 0, `不得向注入 clock 传入非正/非有限延时：${JSON.stringify(clock.invalidTimings)}`);
});

test("CFG-004：同一配置（同一快照条目）的两个 transport 路由一致；改用另一代理即产生不同路由", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = C.makeEntry({ id: "e-snap", type: "tavily", proxy: SYNTHETIC_PROXY });
  const first = openTransport(mod, entry);
  const second = openTransport(mod, entry);
  const switched = openTransport(mod, C.makeEntry({ id: "e-snap", type: "tavily", proxy: "http://syn-proxy-b2.invalid:8082" }));
  for (const bag of [first, second, switched]) bag.fetchFn.when(TARGET).responds({ body: { ok: true } });

  await first.transport.fetch(TARGET);
  await second.transport.fetch(TARGET);
  await switched.transport.fetch(TARGET);

  const r1 = routeOf(targetCall(first.fetchFn));
  const r2 = routeOf(targetCall(second.fetchFn));
  const r3 = routeOf(targetCall(switched.fetchFn));
  assert.equal(r1.kind, r2.kind);
  assert.equal(r1.proxyUrl, r2.proxyUrl, "同一配置的两个 transport 必须解析出同一条路由（CFG-004 快照语义）");
  assert.notEqual(r3.proxyUrl, r1.proxyUrl, "保存改用代理 B 后，新 transport 必须使用 B（旧快照不受影响的完整版归 WP5/WP12）");
});

// ─── FB-003 取消与预算在 transport 层的表现 ─────────────────────────────────

test("FB-003：signal 已取消时零出站——固定代理与 PAC 条目都不得再发任何请求", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const ac = new AbortController();
  ac.abort(); // 模拟总预算耗尽 / 宿主取消后的下一次条目尝试

  const proxied = openTransport(mod, C.makeEntry({ id: "e-cancel-proxy", type: "tavily", proxy: SYNTHETIC_PROXY }));
  proxied.fetchFn.when(TARGET).responds({ body: { ok: true } });
  const o1 = track(proxied.transport.fetch(TARGET, { signal: ac.signal }));
  await flush(3);
  assert.equal(o1.state, "err", "已取消的调用必须以错误落定");
  assert.equal(o1.error?.name, "AbortError", `取消须表现为 AbortError（FB-003/A5），实际：${o1.error?.name}`);
  assert.equal(proxied.fetchFn.calls.length, 0, "已取消时不得把请求交给注入 fetch（FB-003「取消后不得再请求」，R6）");

  const pac = openTransport(mod, C.makeEntry({ id: "e-cancel-pac", type: "openai", proxy: { pac: SYNTHETIC_PAC } }));
  declarePac(pac.fetchFn, pacBody("DIRECT"));
  pac.fetchFn.when(TARGET).responds({ body: { ok: true } });
  const o2 = track(pac.transport.fetch(TARGET, { signal: ac.signal }));
  await flush(3);
  assert.equal(o2.state, "err", "已取消的 PAC 调用必须以错误落定");
  assert.equal(pac.fetchFn.count(SYNTHETIC_PAC), 0, "取消后不得再下载 PAC 脚本（CFG-005 预算与取消约束）");
  assert.equal(pac.fetchFn.calls.length, 0, "取消后出站请求数为零（FB-003 验收「取消后出站请求数不再增加」）");
});

test("FB-003：在途请求被取消时立即以 AbortError 落定，且不得发出替代请求", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = C.makeEntry({ id: "e-cancel-mid", type: "tavily", proxy: SYNTHETIC_PROXY });
  const { fetchFn, transport } = openTransport(mod, entry);
  fetchFn.when(TARGET).hangs();
  const ac = new AbortController();

  const out = track(transport.fetch(TARGET, { signal: ac.signal }));
  await flush(3);
  assert.equal(out.state, "pending", "未取消前不得提前落定");
  ac.abort();
  await flush(6);
  assert.equal(out.state, "err", "取消后必须落定（FB-003：条目到期须取消当前请求）");
  assert.equal(out.error?.name, "AbortError", `取消表现为 AbortError，实际：${out.error?.name} / ${out.error?.message}`);
  assert.equal(fetchFn.calls.length, 1, "取消后不得再发新请求（FB-003）");
  assert.equal(fetchFn.calls[0].aborted, true, "被取消的出站记录必须标为 aborted");
});

test("FB-003：按注入时钟到点即取消在途请求——不拨钟不落定，到点零后续出站", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = C.makeEntry({ id: "e-deadline", type: "tavily", proxy: SYNTHETIC_PROXY });
  const { clock, fetchFn, transport } = openTransport(mod, entry);
  fetchFn.when(TARGET).hangs();

  const ac = new AbortController();
  const budgetMs = 1000;
  clock.setTimeout(() => ac.abort(), budgetMs); // 链侧条目预算到点（FB-003 分配公式归 WP5）
  const out = track(transport.fetch(TARGET, { signal: ac.signal }));

  await flush(3);
  clock.advance(budgetMs - 1);
  await flush(4);
  assert.equal(out.state, "pending", `未到最后 1ms 不得提前取消（受控时钟语义）；clockErrors=${clock.errors.length}`);
  clock.advance(1);
  await flush(6);
  assert.equal(out.state, "err", "条目到期须取消当前请求（FB-003）");
  assert.equal(out.error?.name, "AbortError", `到期取消须为 AbortError，实际：${out.error?.name}`);
  assert.equal(fetchFn.calls.length, 1, "到期后不得再发出站请求（FB-003 预算耗尽不得再发请求）");
  assert.equal(clock.invalidTimings.length, 0, `不得使用真实定时器或非法延时：${JSON.stringify(clock.invalidTimings)}`);
  assert.equal(clock.pending().length, 0, `到期后不得留下悬挂定时器：${JSON.stringify(clock.pending())}`);
});

test("FB-003：取消之后同一 transport 的再次调用仍零出站（预算耗尽/宿主取消后的连环尝试）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = C.makeEntry({ id: "e-after-cancel", type: "tavily", proxy: SYNTHETIC_PROXY });
  const { clock, fetchFn, transport } = openTransport(mod, entry);
  fetchFn.when(TARGET).hangs(); // 在途请求：取消只影响当前请求，之后的连环尝试一律零出站

  const ac = new AbortController();
  const first = track(transport.fetch(TARGET, { signal: ac.signal }));
  await flush(2);
  assert.equal(first.state, "pending", "未取消前不得提前落定");
  ac.abort();
  await flush(4);
  assert.equal(first.state, "err", "在途请求须被取消（FB-003）");
  const afterAbort = fetchFn.calls.length;
  assert.equal(afterAbort, 1, "取消前只有一次出站");

  const second = track(transport.fetch(TARGET, { signal: ac.signal }));
  const o = await settle(clock, second);
  assert.equal(o.state, "err", "已取消 signal 的后续调用不得成功出站");
  assert.equal(second.error?.name, "AbortError", `后续调用同样须表现为 AbortError，实际：${second.error?.name}`);
  assert.equal(fetchFn.calls.length, afterAbort, `取消后出站请求数不得增加（FB-003）：新增 ${fetchFn.calls.length - afterAbort} 条`);
});

// ─── CFG-005 PAC ────────────────────────────────────────────────────────────

test("CFG-005：PAC 脚本直连下载、保留查询参数；派生请求排在下载之后", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = C.makeEntry({ id: "e-pac-fetch", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, pacBody("DIRECT"));
  fetchFn.when(TARGET).responds({ body: { results: [] } });

  await transport.fetch(TARGET);

  const pacCalls = fetchFn.callsFor(SYNTHETIC_PAC);
  assert.equal(pacCalls.length, 1, "PAC 脚本必须被下载（本次条目需要路由）");
  const pacCall = pacCalls[0];
  assert.equal(pacCall.url, SYNTHETIC_PAC, `下载 URL 必须保留查询参数 ?v=3（CFG-005），实际：${pacCall.url}`);
  assert.equal(pacCall.method, "GET", "PAC 脚本按 HTTP GET 获取");
  const route = routeOf(pacCall);
  assert.equal(route.kind, "direct", `PAC 下载本身必须直连（CFG-005 首句，R4），实际：${JSON.stringify(route)}`);
  assert.equal(route.proxyUrl, undefined, "PAC 下载不得使用任何代理");
  const targetIndex = fetchFn.calls.findIndex((c) => c.url === TARGET);
  const pacIndex = fetchFn.calls.findIndex((c) => c.url === SYNTHETIC_PAC);
  assert.ok(pacIndex < targetIndex, "必须先取到路由再向供应商出站");
});

test("CFG-005/CFG-004：只为实际启动的条目下载 PAC——未 fetch 即释放时 PAC 访问次数为零", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = C.makeEntry({ id: "e-pac-idle", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  assert.equal(fetchFn.count(SYNTHETIC_PAC), 0, "取路由发生在真正请求之前，构造阶段零出站（CFG-005「只为实际启动的条目获取」）");
  transport.close();
  assert.equal(fetchFn.count(SYNTHETIC_PAC), 0, "未使用的 transport 释放后 PAC 服务访问次数须为零（CFG-005 验收/停用条目同类）");
  assert.equal(fetchFn.calls.length, 0, "整个生命周期零出站");
});

test("CFG-005：脚本给出 DIRECT 才允许直连——标记 direct + viaPac + pacIndex=0", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = C.makeEntry({ id: "e-pac-direct", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, pacBody("DIRECT"));
  fetchFn.when(TARGET).responds({ body: { ok: true } });

  await transport.fetch(TARGET);
  const route = routeOf(targetCall(fetchFn));
  assert.equal(route.kind, "direct", `PAC 返回 DIRECT 时必须直连（CFG-005），实际：${JSON.stringify(route)}`);
  assert.equal(route.viaPac, true, "脚本给出的 DIRECT 必须标记为 PAC 派生（R1），否则无法与「忽略脚本」区分");
  assert.equal(route.pacIndex, 0, `DIRECT 是脚本指令列表第 0 条（R3），实际：${route.pacIndex}`);
});

test("CFG-005：PROXY host:port 指令——proxyUrl=host:port、pacIndex=0；逗号与分号分隔等价", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const hostPort = new URL(PAC_MULTI_FIRST).host;
  for (const [sep, script] of [
    ["逗号", `function FindProxyForURL(url, host) { return "PROXY ${hostPort}, DIRECT"; }`],
    ["分号", `function FindProxyForURL(url, host) { return "PROXY ${hostPort}; DIRECT"; }`],
  ]) {
    const entry = C.makeEntry({ id: `e-pac-proxy-${sep}`, type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const { fetchFn, transport } = openTransport(mod, entry);
    declarePac(fetchFn, script);
    fetchFn.when(TARGET).responds({ body: { ok: true } });

    await transport.fetch(TARGET);
    const route = routeOf(targetCall(fetchFn));
    assert.equal(route.viaPac, true, `分隔符 ${sep}：路由必须来自 PAC（CFG-005）`);
    assert.ok(PROXY_KINDS.has(route.kind), `分隔符 ${sep}：PROXY 指令须走代理（R1），实际：${JSON.stringify(route)}`);
    assert.equal(new URL(String(route.proxyUrl)).host, new URL(PAC_MULTI_FIRST).host, `分隔符 ${sep}：proxyUrl host:port 须与指令一致（R2）`);
    assert.equal(route.pacIndex, 0, `分隔符 ${sep}：首条指令 pacIndex=0（R3）`);
    assert.equal(fetchFn.count(TARGET), 1, `分隔符 ${sep}：第一条候选成功即结束，不得换路由重发（CFG-005/FB-001）`);
  }
});

test("CFG-005：HTTPS host:port 指令——kind=https-proxy 且 proxyUrl 用 https 方案", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = C.makeEntry({ id: "e-pac-https", type: "openai", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, pacBody(`HTTPS ${new URL(PAC_TLS).host}`));
  fetchFn.when(TARGET_OTHER).responds({ body: { ok: true } });

  await transport.fetch(TARGET_OTHER);
  const route = routeOf(targetCall(fetchFn, TARGET_OTHER));
  assert.equal(route.kind, "https-proxy", `HTTPS 指令必须以 TLS 连代理（CFG-005/R1），实际：${JSON.stringify(route)}`);
  const u = new URL(String(route.proxyUrl));
  assert.equal(u.host, new URL(PAC_TLS).host, `proxyUrl host:port 须与指令一致（R2），实际：${route.proxyUrl}`);
  assert.equal(u.protocol, "https:", `HTTPS 指令的 proxyUrl 必须是 https 方案（R2），实际：${u.protocol}`);
  assert.equal(route.pacIndex, 0);
});

test("CFG-005/FB-001：请求已提交给某条 PAC 路由后失败——绝不换下一条路由重发查询", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = C.makeEntry({ id: "e-pac-noresend", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { clock, fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, pacBody(`PROXY ${new URL(PAC_PROXY).host}, DIRECT`));
  fetchFn.when(TARGET).fails({ error: new Error("[synthetic] 上游已收到查询后连接中断"), delayMs: 10 });

  const out = track(transport.fetch(TARGET));
  const o = await settle(clock, out);
  assert.equal(o.state, "err", "候选路由上失败必须上抛，交由链按 FB-001 降级");
  assert.equal(fetchFn.count(TARGET), 1, `查询已提交后不得重发（CFG-005「上游已收到查询时无重发」/FB-001 每条目最多一次）`);
  assert.equal(routeOf(targetCall(fetchFn)).pacIndex, 0, "失败的是脚本第 0 条候选");
});

test("CFG-005：PAC 三阶段失败各自携带 PAC_FETCH_FAILED / PAC_EVAL_FAILED / PAC_ROUTE_FAILED，且供应商零出站", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const { PAC_FETCH_FAILED, PAC_EVAL_FAILED, PAC_ROUTE_FAILED } = C.CONFIG_CODES;

  const cases = [
    { label: "下载得到 502", status: 502, script: pacBody("DIRECT"), code: PAC_FETCH_FAILED },
    { label: "下载阶段网络故障", network: true, code: PAC_FETCH_FAILED },
    { label: "响应不是可执行脚本（HTML 拦截页）", script: "<!DOCTYPE html><html><body>synthetic pac block page</body></html>", code: PAC_EVAL_FAILED },
    { label: "脚本体顶层抛错", script: 'throw new Error("synthetic pac top-level failure");', code: PAC_EVAL_FAILED },
    { label: "脚本没有 FindProxyForURL", script: "var notAFunction = 1;", code: PAC_EVAL_FAILED },
    { label: "FindProxyForURL 运行期抛错", script: 'function FindProxyForURL(u, h) { throw new Error("synthetic pac eval failure"); }', codes: [PAC_EVAL_FAILED, PAC_ROUTE_FAILED] },
    { label: "脚本返回空列表", script: pacBody(""), code: PAC_ROUTE_FAILED },
    { label: "脚本返回未知指令", script: pacBody("BOGUS bogus-host.invalid:1"), code: PAC_ROUTE_FAILED },
  ];

  for (const c of cases) {
    const entry = C.makeEntry({ id: "e-pac-stage", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const { clock, fetchFn, transport } = openTransport(mod, entry);
    if (c.network) fetchFn.when(SYNTHETIC_PAC).fails({ error: new Error("[synthetic] pac 下载网络故障") });
    else declarePac(fetchFn, c.script, { status: c.status ?? 200 });
    fetchFn.when(TARGET).responds({ body: { ok: true } });

    const out = track(transport.fetch(TARGET));
    const o = await settle(clock, out);
    assert.equal(o.state, "err", `PAC ${c.label}：必须以错误落定（CFG-005「须报告具体阶段」）`);
    const expected = c.codes ?? [c.code];
    assert.ok(
      expected.includes(o.error?.code),
      `PAC ${c.label}：错误码须属于 ${expected.join("|")}（CONFIG_CODES，CFG-005 阶段区分），实际：${JSON.stringify(o.error?.code)}`,
    );
    assert.ok(String(o.error?.message ?? "").length > 0, `PAC ${c.label}：错误须给出可操作原因`);
    assert.equal(fetchFn.count(TARGET), 0, `PAC ${c.label}：未取得路由前不得向供应商出站`);
    assertNoRawBody(t, o.error, `PAC ${c.label} 的上抛错误（CFG-003）`);
  }
});

test("CFG-005/CFG-003：PAC 下载故障的错误含 PAC 主机端口、不含条目 key 与原始响应体", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const key = SYNTHETIC_KEY("openai");
  const rawBody = "<html><body>synthetic pac gateway failure</body></html>";
  const entry = C.makeEntry({ id: "e-pac-fail", type: "openai", proxy: { pac: SYNTHETIC_PAC } });
  const { clock, fetchFn, logCapture, transport } = openTransport(mod, entry);
  fetchFn.when(SYNTHETIC_PAC).responds({ status: 502, body: rawBody, headers: { "content-type": "text/html" } });
  fetchFn.when(TARGET).responds({ body: { ok: true } });

  const out = track(transport.fetch(TARGET, { headers: { authorization: `Bearer ${key}` } }));
  const o = await settle(clock, out);
  assert.equal(o.state, "err", "PAC 下载失败必须上抛");
  const msg = String(o.error?.message ?? "");
  assert.ok(/syn-pac\.invalid/.test(msg), `错误须定位到 PAC 服务主机以便排障（CFG-005/CFG-001 原因可操作），实际：${JSON.stringify(msg)}`);
  assertNoSecrets(t, o.error, [key], "PAC 故障错误（条目 key 不得随 PAC 故障外泄，CFG-003）");
  assertNoSecrets(t, logCapture.text(), [key], "PAC 故障日志");
  assertNoRawBody(t, o.error, "PAC 故障错误（原始报错响应体不得进入，CFG-003）");
  assertNoRawBody(t, logCapture.text(), "PAC 故障日志");
});

test("CFG-005：PAC 脚本在隔离环境求值——看不到 process/require/宿主全局，只用参数", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const canaryToken = SYNTHETIC_KEY("canary");
  assert.equal(globalThis.__wp1TransportCanary, undefined, "canary 名字必须未被占用");
  globalThis.__wp1TransportCanary = { token: canaryToken };
  try {
    const script =
      "function FindProxyForURL(url, host) {" +
      "  var leaked = [];" +
      '  if (typeof process !== "undefined") leaked.push("process");' +
      '  if (typeof require !== "undefined") leaked.push("require");' +
      '  if (typeof module !== "undefined") leaked.push("module");' +
      '  if (typeof Buffer !== "undefined") leaked.push("Buffer");' +
      "  if (typeof globalThis !== \"undefined\" && globalThis.__wp1TransportCanary) leaked.push(\"canary\");" +
      '  return leaked.length === 0 ? "DIRECT" : "PROXY " + leaked.join("") + ".isolation-leak.invalid:1";' +
      "}";
    const entry = C.makeEntry({ id: "e-pac-isolation", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const { clock, fetchFn, logCapture, transport } = openTransport(mod, entry);
    declarePac(fetchFn, script);
    fetchFn.when(TARGET).responds({ body: { ok: true } });
    fetchFn.when("isolation-leak.invalid").fails({ error: new Error("[synthetic] 隔离被突破：脚本看到了宿主全局对象") });

    const out = track(transport.fetch(TARGET));
    const o = await settle(clock, out);
    assert.equal(
      o.state,
      "ok",
      "PAC 脚本必须在隔离环境中成功求值并给出 DIRECT（CFG-005：可访问数据限于参数与标准助手）。" +
        `若脚本看到宿主全局，会被路由到 isolation-leak.invalid 并失败。实际错误：${o.error?.message ?? "(无)"}`,
    );
    assert.equal(routeOf(targetCall(fetchFn)).kind, "direct", "隔离成立时脚本的 DIRECT 生效");
    assert.equal(fetchFn.count("isolation-leak.invalid"), 0, "脚本不得看到宿主全局（process/require/module/Buffer/canary）");
    assertNoSecrets(t, [o.error, logCapture.text()], [canaryToken], "隔离求值的错误与日志（CFG-003）");
  } finally {
    delete globalThis.__wp1TransportCanary;
  }
});

test("CFG-005：FindProxyForURL 收到完整目标 URL 与主机；标准助手 isPlainHostName/dnsDomainIs/shExpMatch 可用", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script =
    "function FindProxyForURL(url, host) {" +
    "  var ok =" +
    '    typeof isPlainHostName === "function" && isPlainHostName("api") === true && isPlainHostName(host) === false &&' +
    '    typeof dnsDomainIs === "function" && dnsDomainIs(host, ".tavily.invalid") === true && dnsDomainIs(host, ".other.invalid") === false &&' +
    '    typeof shExpMatch === "function" && shExpMatch(host, "*.invalid") === true && shExpMatch(host, "*.other.invalid") === false &&' +
    `    url === ${JSON.stringify(TARGET)} && host === "api.tavily.invalid";` +
    '  return ok ? "DIRECT" : "PROXY args-or-helpers-wrong.invalid:1";' +
    "}";
  const entry = C.makeEntry({ id: "e-pac-helpers", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { clock, fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, script);
  fetchFn.when(TARGET).responds({ body: { ok: true } });
  fetchFn.when("args-or-helpers-wrong.invalid").fails({ error: new Error("[synthetic] FindProxyForURL 参数或标准助手不符合 PAC 语义") });

  const out = track(transport.fetch(TARGET));
  const o = await settle(clock, out);
  assert.equal(
    o.state,
    "ok",
    "必须按 PAC 语义以（完整目标 URL, 主机名）调用 FindProxyForURL，并提供标准助手（R8）。" +
      `不成立时脚本返回 args-or-helpers-wrong.invalid 并被路由失败。实际错误：${o.error?.message ?? "(无)"}`,
  );
  assert.equal(routeOf(targetCall(fetchFn)).kind, "direct");
  assert.equal(fetchFn.count("args-or-helpers-wrong.invalid"), 0);
});
