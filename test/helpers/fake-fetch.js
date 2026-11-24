// 假 HTTP transport（可注入响应/错误/延迟/取消）。
// 注入形态与真实 fetch 一致：fetch(url, init) → Promise<Response>。
// 每次调用记录 { url, init, headers, method, signal, aborted, settled, startedNow }，其中
// init.route 为 src/transport.js 产出的路由标记（见 helpers/contract.js A4），用于断言直连/代理/PAC。
// 传 opts.clock（helpers/clock.js 受控时钟）时，delayMs 走受控调度，测试不得依赖真实等待；
// 未传 clock 时 delayMs 用真实定时器（仅限无受控时钟的单测）。

/** 可辨识的合成鉴权头值，便于脱敏与「只发给正确供应商」断言。 */
export const SYNTHETIC_KEY = (owner) => `sk-synthetic-${owner}-KEY-DO-NOT-LOG`;
export const SYNTHETIC_PROXY = "http://syn-proxy.invalid:8080";
export const SYNTHETIC_PAC = "http://syn-pac.invalid:8765/acceleration.pac?v=3";

function abortError(reason) {
  const err = new Error(reason?.message ?? "This operation was aborted");
  err.name = "AbortError";
  return err;
}

/**
 * 创建假 fetch。
 * @param {{ default?: "never" | { status:number, body?:any }, clock?: any }} [opts]
 *   default:"never" 时未匹配路由的调用直接抛错（测试必须显式声明期望的出站）。
 */
export function createFakeFetch(opts = {}) {
  const routes = [];
  const calls = [];

  const fetchFn = async (url, init = {}) => {
    const record = {
      url: String(url),
      init,
      headers: normalizeHeaders(init.headers),
      method: init.method ?? "GET",
      signal: init.signal ?? null,
      aborted: false,
      settled: null, // "ok" | "error" | "aborted"
      startedNow: opts.clock?.now?.() ?? null,
      clock: opts.clock ?? null,
    };
    calls.push(record);
    if (record.signal?.aborted) {
      record.aborted = true;
      record.settled = "aborted";
      throw abortError(record.signal.reason);
    }
    const route = routes.find((r) => matches(r.match, record.url)) ?? null;
    if (!route) {
      if (opts.default && opts.default !== "never") {
        return respond(opts.default, record);
      }
      throw new Error(`[fake-fetch] 未声明的出站调用: ${record.url}`);
    }
    return settle(route, record);
  };

  fetchFn.calls = calls;
  fetchFn.count = (match) => (match ? calls.filter((c) => matches(match, c.url)).length : calls.length);
  fetchFn.callsFor = (match) => calls.filter((c) => matches(match, c.url));
  fetchFn.reset = () => {
    calls.length = 0;
    routes.length = 0;
  };
  /** 声明路由：when(匹配) .responds(...) .fails(...) .hangs() */
  fetchFn.when = (match) => ({
    responds({ status = 200, body = "", headers = {}, delayMs = 0 } = {}) {
      routes.push({ match, kind: "respond", status, body, headers, delayMs });
    },
    fails({ error = new Error("[fake-fetch] 合成网络故障"), delayMs = 0 } = {}) {
      routes.push({ match, kind: "fail", error, delayMs });
    },
    hangs() {
      routes.push({ match, kind: "hang", delayMs: 0 });
    },
  });

  return fetchFn;
}

function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    for (const [k, v] of headers.entries()) out[k.toLowerCase()] = v;
    return out;
  }
  for (const [k, v] of Object.entries(headers)) out[String(k).toLowerCase()] = String(v);
  return out;
}

function matches(match, url) {
  if (typeof match === "function") return Boolean(match(url));
  if (match instanceof RegExp) return match.test(url);
  return url.includes(String(match));
}

function respond(spec, record) {
  record.settled = "ok";
  return toResponse(spec);
}

function toResponse({ status, body, headers }) {
  let payload = body;
  const h = { "content-type": "application/json", ...headers };
  if (body && typeof body === "object" && !(body instanceof Uint8Array)) {
    payload = JSON.stringify(body);
  } else if (typeof body === "number" || typeof body === "boolean") {
    payload = String(body);
  }
  return new Response(payload, { status, headers: h });
}

async function settle(route, record) {
  if (route.kind === "hang") {
    await waitForever(record);
    record.settled = "aborted";
    throw abortError(record.signal?.reason);
  }
  if (route.delayMs > 0) {
    await delayCancellable(route.delayMs, record);
    if (record.aborted) {
      record.settled = "aborted";
      throw abortError(record.signal?.reason);
    }
  }
  if (route.kind === "fail") {
    record.settled = "error";
    throw route.error;
  }
  record.settled = "ok";
  return toResponse(route);
}

/** 延迟可取消：优先受控时钟（chain-harness 注入 clock），否则真实定时器。 */
function delayCancellable(ms, record) {
  return new Promise((resolve) => {
    const timer = record.clock ? record.clock.setTimeout(resolve, ms) : setTimeout(resolve, ms);
    record.signal?.addEventListener(
      "abort",
      () => {
        if (record.clock && timer != null) record.clock.clearTimeout(timer);
        else clearTimeout(timer);
        record.aborted = true;
        resolve();
      },
      { once: true },
    );
  });
}

function waitForever(record) {
  return new Promise((resolve) => {
    if (record.signal?.aborted) {
      record.aborted = true;
      return resolve();
    }
    record.signal?.addEventListener(
      "abort",
      () => {
        record.aborted = true;
        resolve();
      },
      { once: true },
    );
  });
}
