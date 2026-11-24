// 条目级传输（WP1，docs/specs/draft/config-network.md CFG-001/003/004/005，fallback FB-003 取消）。
//
// 设计要点
//  - 每个已保存条目对应一个 transport，只负责该条目的路由（直连 / 固定代理 / PAC），不改宿主或全局代理。
//  - 路由结果以 init.route 标记交给注入的 fetch（A4 接缝），真正的出站 dispatcher 由装配层提供。
//  - PAC：仅在该条目真正出站时下载（直连 GET，保留查询参数）；成功脚本缓存到本 transport，释放即失效；
//    每次求值在隔离的 vm 上下文中进行，只暴露 FindProxyForURL 所需的参数和标准助手。
//  - 取消：signal 已中止或在途中止时以 AbortError 落定，不再向注入 fetch 发出新请求。
//  - 错误与日志只含条目名、代理 host:port、PAC host:port 与脱敏原因码，绝不含 key、代理认证、
//    带认证参数的 URL 或原始报错响应体（CFG-003）。
//
// 运行时零 import test/，零 npm 依赖。
// 常量本地镜像（同步义务）：与 test/helpers/contract.js 中 CONFIG_CODES.PAC_* 与 ENTRY_CODES 同步，
// 修改任一值须同时修改 contract.js 并在同一 PR 说明。

import vm from "node:vm";
import { carriesPassthroughCode } from "./constants.js";

const PAC_CODES = Object.freeze({
  FETCH_FAILED: "PAC_FETCH_FAILED",
  EVAL_FAILED: "PAC_EVAL_FAILED",
  ROUTE_FAILED: "PAC_ROUTE_FAILED",
});
const CONFIG_INVALID = "CONFIG_INVALID";
/** FB-005 条目级传输归因提示（分类由 WP5 决定，这里只标注路由类别）。 */
const ENTRY_NETWORK_CODE = "ENTRY_NETWORK";
const ENTRY_PROXY_CODE = "ENTRY_PROXY";

/** 同步 PAC 求值的 CPU 护栏（防止死循环卡住进程）。这不是等待时长，不属于 FB-003 的预算。 */
const PAC_EVAL_CPU_LIMIT_MS = 500;

/** 传输层错误。message 已脱敏，不含原始 cause。 */
export class TransportError extends Error {
  /**
   * @param {string} code CONFIG_CODES 或 ENTRY_* 之一
   * @param {string} message 脱敏、可操作的中文说明
   */
  constructor(code, message) {
    super(message);
    this.name = "TransportError";
    this.code = code;
  }
}

function abortError() {
  const err = new Error("搜索已取消");
  err.name = "AbortError";
  return err;
}

function isAbort(err, signal) {
  return err?.name === "AbortError" || Boolean(signal?.aborted);
}

/** 把 promise 与 signal 竞速：signal 中止时立即以 AbortError 落定，并吞掉迟到的结果。 */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** 同步调用注入 fetch，并把同步抛错转为拒绝的 promise。 */
function invoke(fn) {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

/** 仅保留形如 ECONNREFUSED 的错误码，其余一律视为未知原因（不带入原始 message）。 */
function safeReason(err) {
  const code = err?.code;
  return typeof code === "string" && /^[A-Z_]{2,40}$/.test(code) ? code : "网络或响应异常";
}

/** 取 host:port，剥离 userinfo、路径与查询。 */
function endpointOf(urlText) {
  try {
    return new URL(urlText).host;
  } catch {
    return "无效端点";
  }
}

/** PAC 来源标识：origin + pathname，不含查询（查询可能带认证参数，CFG-003）。 */
function pacSourceOf(urlText) {
  try {
    const u = new URL(urlText);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "无效来源";
  }
}

function describeEntry(entry) {
  return `「${entry.name ?? entry.type}」(${entry.id})`;
}

/** 解析条目 proxy 配置为传输模式（CFG-001）。 */
function classifyProxy(entry) {
  const proxy = entry.proxy;
  if (proxy === undefined || proxy === null || proxy === "") return { kind: "direct" };
  if (typeof proxy === "string") {
    let u;
    try {
      u = new URL(proxy.trim());
    } catch {
      throw new TransportError(CONFIG_INVALID, `条目${describeEntry(entry)}的代理地址无效`);
    }
    if (u.protocol === "http:") return { kind: "proxy", proxyUrl: proxy.trim() };
    if (u.protocol === "https:") return { kind: "https-proxy", proxyUrl: proxy.trim() };
    throw new TransportError(CONFIG_INVALID, `条目${describeEntry(entry)}的代理须为 HTTP(S) 地址`);
  }
  if (proxy && typeof proxy === "object" && typeof proxy.pac === "string") {
    return { kind: "pac", pacUrl: proxy.pac.trim() };
  }
  throw new TransportError(CONFIG_INVALID, `条目${describeEntry(entry)}的代理配置类型无效`);
}

// ── PAC 标准助手（纯字符串语义，不触网）────────────────────────────────────────

function isPlainHostName(host) {
  return typeof host === "string" && !host.includes(".");
}

function dnsDomainIs(host, domain) {
  if (typeof host !== "string" || typeof domain !== "string") return false;
  return host.toLowerCase().endsWith(domain.toLowerCase());
}

function shExpMatch(text, pattern) {
  if (typeof text !== "string" || typeof pattern !== "string") return false;
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\/-]/g, "\\$&");
  }
  return new RegExp(`${re}$`).test(text);
}

/**
 * 在隔离上下文中求值 PAC 脚本（CFG-005）。
 * 上下文不含 process/require/module/Buffer 或宿主全局；代码生成（eval/Function）已禁用。
 * @returns {string} FindProxyForURL 返回的指令文本
 */
function evaluatePac(script, targetUrl, host) {
  const context = vm.createContext(
    { isPlainHostName, dnsDomainIs, shExpMatch },
    { codeGeneration: { strings: false, wasm: false } },
  );
  try {
    new vm.Script(String(script), { filename: "proxy.pac" }).runInContext(context, {
      timeout: PAC_EVAL_CPU_LIMIT_MS,
    });
  } catch {
    throw new TransportError(PAC_CODES.EVAL_FAILED, "PAC 脚本求值失败（脚本无法解析或顶层执行出错）");
  }
  if (typeof context.FindProxyForURL !== "function") {
    throw new TransportError(PAC_CODES.EVAL_FAILED, "PAC 脚本缺少 FindProxyForURL");
  }
  context.__pacUrl = targetUrl;
  context.__pacHost = host;
  let directive;
  try {
    directive = vm.runInContext("FindProxyForURL(__pacUrl, __pacHost)", context, {
      timeout: PAC_EVAL_CPU_LIMIT_MS,
    });
  } catch {
    throw new TransportError(PAC_CODES.EVAL_FAILED, "PAC 脚本求值失败（FindProxyForURL 运行出错）");
  }
  if (typeof directive !== "string") {
    throw new TransportError(PAC_CODES.ROUTE_FAILED, "PAC 脚本返回值不是指令文本");
  }
  return directive;
}

/** 校验 host:port，拒绝 userinfo、路径与空端口。 */
function validHostPort(hp) {
  if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(hp)) return false;
  try {
    const u = new URL(`http://${hp}`);
    return u.host === hp.toLowerCase() && u.port !== "";
  } catch {
    return false;
  }
}

/**
 * 按脚本顺序挑选第一个受支持的指令（CFG-005）。
 * 指令按 `;` 或 `,` 分隔；序号为去空白后的指令列表位置（pacIndex）。
 * 不支持的指令（如 SOCKS）在请求提交前跳过；全部不可用则 PAC_ROUTE_FAILED。
 * @returns {{ index: number, kind: "direct"|"proxy"|"https-proxy", proxyUrl?: string }}
 */
function pickPacRoute(directive) {
  const candidates = String(directive)
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (let index = 0; index < candidates.length; index += 1) {
    const tokens = candidates[index].split(/\s+/);
    const keyword = tokens[0].toUpperCase();
    if (keyword === "DIRECT" && tokens.length === 1) return { index, kind: "direct" };
    if ((keyword === "PROXY" || keyword === "HTTPS") && tokens.length === 2 && validHostPort(tokens[1])) {
      const scheme = keyword === "PROXY" ? "http" : "https";
      return { index, kind: keyword === "PROXY" ? "proxy" : "https-proxy", proxyUrl: `${scheme}://${tokens[1]}` };
    }
  }
  throw new TransportError(PAC_CODES.ROUTE_FAILED, "PAC 脚本未给出可用路由（无受支持的指令）");
}

/**
 * 为一个已保存条目创建传输。
 * @param {object} entry 归一化后的条目（含 proxy）
 * @param {{ fetch: (url: string, init: object) => Promise<any>, clock?: { now?: () => number }, log?: (level: string, message: string) => void }} deps
 * @returns {{ fetch: (url: string, init?: object) => Promise<any>, close: () => void, closeAll: () => void }}
 */
export function createEntryTransport(entry, deps = {}) {
  const { fetch: fetchFn, clock, log } = deps;
  if (typeof fetchFn !== "function") throw new TypeError("createEntryTransport 需要注入 fetch");

  const label = describeEntry(entry);
  const mode = classifyProxy(entry);
  const now = () => (typeof clock?.now === "function" ? clock.now() : 0);

  let closed = false;
  /** 成功加载的 PAC 脚本缓存（随本 transport 生命周期，释放即失效）。失败不缓存。 */
  let pacCache = null;

  function raise(error) {
    if (typeof log === "function") log("warn", error.message);
    return error;
  }

  async function loadPac(signal) {
    if (pacCache) return pacCache;
    const pacUrl = mode.pacUrl;
    const pending = (async () => {
      let res;
      try {
        res = await raceAbort(
          invoke(() => fetchFn(pacUrl, { method: "GET", route: { kind: "direct", phase: "pac-download" }, signal })),
          signal,
        );
      } catch (err) {
        if (isAbort(err, signal)) throw abortError();
        throw new TransportError(
          PAC_CODES.FETCH_FAILED,
          `条目${label}PAC 下载失败：${endpointOf(pacUrl)}（${safeReason(err)}）`,
        );
      }
      if (!res || !res.ok) {
        throw new TransportError(
          PAC_CODES.FETCH_FAILED,
          `条目${label}PAC 下载失败：${endpointOf(pacUrl)}（HTTP ${res?.status ?? "未知"}）`,
        );
      }
      let script;
      try {
        script = await raceAbort(Promise.resolve().then(() => res.text()), signal);
      } catch (err) {
        if (isAbort(err, signal)) throw abortError();
        throw new TransportError(PAC_CODES.FETCH_FAILED, `条目${label}PAC 脚本读取失败：${endpointOf(pacUrl)}`);
      }
      return { script, revision: now(), source: pacSourceOf(pacUrl) };
    })();
    pacCache = pending;
    pending.catch(() => {
      if (pacCache === pending) pacCache = null;
    });
    return pending;
  }

  /** 中止的 PAC 加载不应拖累另一个仍有效的请求：自己的 signal 未中止时重试一次。 */
  async function loadPacFor(signal) {
    try {
      return await loadPac(signal);
    } catch (err) {
      if (err?.name === "AbortError" && !signal?.aborted) return loadPac(signal);
      throw err;
    }
  }

  async function resolveRoute(url, signal) {
    if (mode.kind === "direct") return { kind: "direct" };
    if (mode.kind === "proxy" || mode.kind === "https-proxy") {
      return { kind: mode.kind, proxyUrl: mode.proxyUrl };
    }
    const pac = await loadPacFor(signal);
    if (signal?.aborted) throw abortError();
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new TransportError(CONFIG_INVALID, `条目${label}的目标地址无效`);
    }
    const directive = evaluatePac(pac.script, url, host);
    const picked = pickPacRoute(directive);
    const route = { kind: picked.kind, viaPac: true, pacIndex: picked.index, pacRevision: pac.revision, pacSource: pac.source };
    if (picked.proxyUrl !== undefined) route.proxyUrl = picked.proxyUrl;
    return route;
  }

  function mapFetchError(err, route) {
    if (err instanceof TransportError) return err;
    // P1-1：已带归因/程序码的错误原样上抛，不压成 ENTRY_NETWORK（代理故障须与直连网络区分）。
    if (carriesPassthroughCode(err)) return err;
    const reason = safeReason(err);
    if (route.kind === "direct") {
      const via = route.viaPac ? "（PAC 直连）" : "";
      return raise(new TransportError(ENTRY_NETWORK_CODE, `条目${label}直连请求失败${via}（${reason}）`));
    }
    const via = route.viaPac ? "PAC 代理" : "代理";
    return raise(
      new TransportError(ENTRY_PROXY_CODE, `条目${label}经${via} ${endpointOf(route.proxyUrl)} 请求失败（${reason}）`),
    );
  }

  return {
    /**
     * 按条目路由发出请求。init 原样透传（method/headers/body/signal），仅追加 route 标记。
     * @returns {Promise<any>} 注入 fetch 的响应，原样交回
     */
    async fetch(url, init = {}) {
      const signal = init?.signal;
      if (closed) {
        throw new TransportError("TRANSPORT_RELEASED", `条目${label}已释放，不再发出请求`);
      }
      if (signal?.aborted) throw abortError();

      const route = await resolveRoute(String(url), signal);
      if (signal?.aborted) throw abortError();

      try {
        return await raceAbort(invoke(() => fetchFn(url, { ...init, route })), signal);
      } catch (err) {
        if (isAbort(err, signal)) throw abortError();
        throw mapFetchError(err, route);
      }
    },

    /** 释放：此后不再产出出站请求；在途请求沿用其配置直到完成或取消（CFG-004）。幂等。 */
    close() {
      closed = true;
      pacCache = null;
    },

    /** 同 close（单条目 transport 的释放即全部释放）。幂等。 */
    closeAll() {
      closed = true;
      pacCache = null;
    },
  };
}
