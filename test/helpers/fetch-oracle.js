// WP87 fetch 接管 Oracle 共用 helper（docs/specs/draft/fetch-takeover-oracle.md）。
// 只新增、不触碰既有 helper/测试。依赖注入假定（OQ-O1..O8 之注入面）在下方各装具注明；
// 实现 PR 若更名注入面，仅改本文件单点。
//
// 依赖假定（供实现对齐；未满足前骨架全红属预期）：
//   D1 src/index.js `apply(ctx, cfg, deps)` 经 ctx.web.registerFetchProvider 注册 fetch provider
//      （id = contract.PROVIDER_ID = "search-chain"）；deps 支持可选注入
//      `deps.fetchDeps = { transport, clock, credentials, env, log, dns, officialFetchProvider, backends? }`
//      （transport/clock/credentials/env/log 语义同搜索链 harness 的注入面）。
//   D2 兜底腿 = 宿主公开导出 HttpFetchProvider 构造（D-FT3）；deps.fetchDeps.officialFetchProvider
//      允许注入（缺省由插件以官方默认构造）。
//   D3 提取商回报字段面（OQ-O3 假定）：`final_url` 必有；`redirect_hops`（数组，可选预留）。
//      真实字段名以实施实证回写，此处仅在提取商桩应答体使用。
import http from "node:http";
import assert from "node:assert/strict";
import { PROVIDER_ID, makeSavedConfig } from "./contract.js";
import { createFakeHost } from "./fake-host.js";

export { PROVIDER_ID as FETCH_PROVIDER_ID };
/** 宿主官方 fetch provider id（@deepseek-ai/dsh-web-fetch-http LOCAL_FETCH_PROVIDER_ID 实证值）。 */
export const HTTP_HOST_ID = "http";

// ── 可辨识合成片段（脱敏断言用；任何拒绝文案/回传正文出现即泄密）────────────────
export const SECRET_QUERY = "SECRETQUERY";
export const SECRET_FRAGMENT = "SECRETFRAG";
export const SECRET_PATH = "secretpath";
export const SECRET_USER = "secretuser";
export const SECRET_PASS = "secretpass";
export const LEAK_MARKER = "LEAK-MARKER-SSRF-7f3a";

/** 最小 WebError 同构（宿主 types.ts：{name,code,message,cause}）。 */
export class OracleWebError extends Error {
  constructor(message, code, opts = {}) {
    super(message, opts);
    this.name = "WebError";
    this.code = code;
  }
}

/**
 * web seam 替身：忠实复刻 @deepseek-ai/dsh-web src/index.ts 的 fetch 侧注册与选择语义
 *（注册序列表、重复 id 抛 WEB_DUPLICATE_PROVIDER、disposer 反注册、providers-changed 计数；
 *  选择：钉死优先 → 恰一可用自动选中 → 多可用 WEB_PROVIDER_AMBIGUOUS → 零可用 WEB_PROVIDER_UNAVAILABLE；
 *  钉死缺失/不可用 → WEB_PROVIDER_CONFIGURED_MISSING / WEB_PROVIDER_CONFIGURED_UNAVAILABLE）。
 */
export function createWebSeam({ pin, envPin } = {}) {
  const ordered = []; // [{provider}] 注册序
  let changed = 0;
  const seam = {
    providersChangedCount: () => changed,
    list() {
      return {
        search: [],
        fetch: ordered.map(({ provider }) => ({ id: provider.id, title: provider.title })),
      };
    },
    ids() {
      return ordered.map(({ provider }) => provider.id);
    },
    provider(id) {
      return ordered.find((e) => e.provider.id === id)?.provider;
    },
    registerFetchProvider(provider) {
      if (ordered.some((e) => e.provider.id === provider.id)) {
        throw new OracleWebError(
          `a web provider with id "${provider.id}" is already registered`,
          "WEB_DUPLICATE_PROVIDER",
        );
      }
      const entry = { provider };
      ordered.push(entry);
      changed += 1;
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        const i = ordered.indexOf(entry);
        if (i >= 0) ordered.splice(i, 1);
        changed += 1;
      };
    },
    /** 预置一个恒可用 http 宿主 provider（模拟装载序：http 先注册）。 */
    registerHostHttp() {
      return seam.registerFetchProvider({
        id: HTTP_HOST_ID,
        available: () => true,
        async fetch() {
          throw new OracleWebError("host http stub must not be called in this case", "HOST_STUB_CALLED");
        },
      });
    },
    /** 选择语义（fetch 侧）。configuredId = web.fetchProvider 钉死 ?? env ?? envPin（构造期）。 */
    select(configuredId) {
      const id = configuredId ?? envPin;
      if (id !== undefined) {
        const e = ordered.find((x) => x.provider.id === id);
        if (!e) throw new OracleWebError(`configured web provider "${id}" is not registered`, "WEB_PROVIDER_CONFIGURED_MISSING");
        if (!e.provider.available())
          throw new OracleWebError(`configured web provider "${id}" is registered but unavailable`, "WEB_PROVIDER_CONFIGURED_UNAVAILABLE");
        return e.provider;
      }
      const usable = ordered.filter((x) => x.provider.available());
      if (usable.length === 1) return usable[0].provider;
      if (usable.length > 1)
        throw new OracleWebError(
          `multiple usable web providers are registered (${usable.map((x) => x.provider.id).join(", ")}); configure one explicitly`,
          "WEB_PROVIDER_AMBIGUOUS",
        );
      throw new OracleWebError("no usable web provider is registered", "WEB_PROVIDER_UNAVAILABLE");
    },
  };
  return seam;
}

/**
 * 本地监听提取商桩：127.0.0.1:0 http 服务；script(hitIndex, req) → {status, headers?, body}。
 * 观测面：requests[]（含 headers）、hits()、activeSockets()、port/baseUrl。
 */
export async function startStubEndpoint({ script = () => ({ status: 200, body: "" }) } = {}) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const hit = requests.length;
      requests.push({ url: req.url, method: req.method, headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8") });
      const spec = script(hit, requests[hit]) ?? { status: 200, body: "" };
      const payload = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body ?? "");
      res.writeHead(spec.status ?? 200, { "content-type": spec.contentType ?? "application/json", ...spec.headers });
      res.end(payload);
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return {
    port: addr.port,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    family: addr.family,
    address: addr.address,
    requests,
    hits: () => requests.length,
    headersOf: (i) => requests[i]?.headers ?? {},
    activeSockets: () => sockets.size,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

/** fetch 面配置装具：makeSavedConfig 会丢弃未知 extra，三键直接铺在其结果上；参数防护（误传数组会解构到 Array.prototype.entries）。 */
export function makeFetchConfig(opts = {}) {
  if (opts === null || typeof opts !== "object" || Array.isArray(opts)) {
    throw new TypeError("makeFetchConfig 只接受选项对象");
  }
  const { fetchTakeover, fetchEntries, fetchOfficialFallback, entries = [], ...rest } = opts;
  return {
    ...makeSavedConfig(entries, rest),
    ...(fetchTakeover !== undefined ? { fetchTakeover } : {}),
    ...(fetchEntries !== undefined ? { fetchEntries } : {}),
    ...(fetchOfficialFallback !== undefined ? { fetchOfficialFallback } : {}),
  };
}

/** 典型敏感片段 URL 装饰：拒绝文案脱敏断言的可辨识 query/fragment/path。 */
export function withSecrets(pathLike) {
  const joiner = pathLike.includes("?") ? "&" : "?";
  return `${pathLike}${joiner}q=${SECRET_QUERY}#${SECRET_FRAGMENT}`;
}

/**
 * 拒绝断言：码 ∈ codes；文案脱敏 = 不含 query/fragment/路径/用户名/密码、不含任何 host 字面变体，
 * 且含规则类别词与 scheme 提示（categoryHint/schemeHint 由行数据给出）。
 */
export function assertBlocked(err, { codes = ["WEB_BLOCKED_URL"], forbidden = [], categoryHints = [], schemeHint } = {}) {
  assert.ok(err, "拒绝必须产生错误对象");
  assert.ok(codes.includes(err.code), `预期拒绝码 ∈ ${codes.join("/")}，实得 ${String(err?.code)}：${String(err?.message)}`);
  const msg = String(err.message ?? "") + JSON.stringify(err.details ?? {});
  for (const f of [...forbidden, SECRET_QUERY, SECRET_FRAGMENT, SECRET_PATH, SECRET_USER, SECRET_PASS]) {
    assert.ok(!msg.includes(f), `拒绝文案泄漏敏感片段「${f}」：${msg}`);
  }
  for (const hint of categoryHints) {
    assert.ok(msg.includes(hint), `拒绝文案应含规则类别词「${hint}」：${msg}`);
  }
  if (schemeHint) assert.ok(msg.toLowerCase().includes(schemeHint), `拒绝文案应含 scheme「${schemeHint}」：${msg}`);
}

/** 正文零回传断言：结果/文本不得带出任何 LEAK-MARKER。 */
export function assertNoLeak(value, label = "结果") {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  assert.ok(!text.includes(LEAK_MARKER), `${label} 不得回传提取商已取回的正文（含 ${LEAK_MARKER}）`);
}

/** 标准 WebFetchResult 形态断言（宿主封闭联合 + kind 恒 text 由调用方指定期望 kind）。 */
export function assertFetchResultShape(result, { kind = "text" } = {}) {
  assert.equal(typeof result.url, "string");
  assert.equal(typeof result.statusCode, "number");
  assert.equal(typeof result.truncated, "boolean");
  assert.equal(result.body?.kind, kind);
  assert.equal(typeof result.body?.content, "string");
}

/** 搜索链替身（DSH-001 装载需要 search 侧；fetch 用例不驱动它）。 */
export function stubSearchChain() {
  return {
    calls: [],
    released: 0,
    async search(request) {
      this.calls.push(request);
      return { sources: [], truncated: false };
    },
    release() {
      this.released += 1;
    },
  };
}

/**
 * 装载装具（D1）：既有 fake-host 提供非 web 面 ctx，fetch 注册捕获替换为 web seam 替身。
 * ctx.web 经 Proxy 覆盖 registerFetchProvider/listProviders，其余（registerSearchProvider、
 * search/fetch 陷阱）原样留给 fake-host（既有断言语义不受影响）。
 * @returns {Promise<{host,seam,ctx,ret,provider,httpRef,dispose}>} provider 未注册时 provider=undefined
 *   （由调用方断言红）。
 */
export async function mountFetch(mod, cfg, { fetchDeps, chain = stubSearchChain(), pin } = {}) {
  const host = createFakeHost({ inject: mod.inject, config: cfg });
  const seam = createWebSeam({ pin });
  seam.registerHostHttp();
  const httpRef = seam.provider(HTTP_HOST_ID);
  const web = new Proxy(host.ctx.web, {
    get(target, prop) {
      if (prop === "registerFetchProvider") return seam.registerFetchProvider;
      if (prop === "listProviders") return () => seam.list();
      return Reflect.get(target, prop);
    },
  });
  const ctx = Object.create(host.ctx, { web: { value: web, enumerable: true } });
  const ret = await mod.apply(ctx, cfg, { chain, ...(fetchDeps ? { fetchDeps } : {}) });
  return {
    host,
    seam,
    ctx,
    ret,
    chain,
    httpRef,
    provider: seam.provider(PROVIDER_ID),
    async dispose() {
      if (typeof ret === "function") await ret();
      await host.disposeAll?.();
    },
  };
}
