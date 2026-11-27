// 条目级传输（WP1，docs/specs/draft/config-network.md CFG-001/003/004/005，fallback FB-003 取消）。
//
// 设计要点
//  - 每个已保存条目对应一个 transport，只负责该条目的路由（直连 / 固定代理 / PAC），不改宿主或全局代理。
//  - 路由结果以 init.route 标记交给注入的 fetch（A4 接缝），真正的出站 dispatcher 由装配层提供。
//  - PAC：仅在该条目真正出站时下载（直连 GET，保留查询参数）；成功脚本缓存到本 transport，释放即失效；
//    每次未命中结果缓存的求值在可独立终止的短命子进程内进行，子进程内保留隔离 vm 上下文与标准助手。
//  - 取消：signal 已中止或在途中止时以 AbortError 落定，不再向注入 fetch 发出新请求。
//  - 错误与日志只含条目名、代理 host:port、PAC host:port 与脱敏原因码，绝不含 key、代理认证、
//    带认证参数的 URL 或原始报错响应体（CFG-003）。
//
// 运行时零 import test/，零 npm 依赖。
// 常量本地镜像（同步义务）：与 test/helpers/contract.js 中 CONFIG_CODES.PAC_* 与 ENTRY_CODES 同步，
// 修改任一值须同时修改 contract.js 并在同一 PR 说明。

import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { carriesPassthroughCode, readBoundedText } from "./constants.js";

const PAC_CODES = Object.freeze({
  FETCH_FAILED: "PAC_FETCH_FAILED",
  EVAL_FAILED: "PAC_EVAL_FAILED",
  ROUTE_FAILED: "PAC_ROUTE_FAILED",
});
const CONFIG_INVALID = "CONFIG_INVALID";
/** FB-005 条目级传输归因提示（分类由 WP5 决定，这里只标注路由类别）。 */
const ENTRY_NETWORK_CODE = "ENTRY_NETWORK";
const ENTRY_PROXY_CODE = "ENTRY_PROXY";

/**
 * 子进程 PAC 求值的墙上时钟上限（毫秒，≈ spawn 开销 + 子进程内三段各 500ms 护栏 + IPC 余量）。
 * 这不是等待时长，不属于 FB-003 的预算。
 */
const PAC_EVAL_WALL_LIMIT_MS = 2000;
/**
 * 两层内存边界（工单 12b 裁定）：
 * 1) 脚本可控堆内存 = 24 MiB 硬限（--max-old-space-size=24，V8 即时 SIGABRT）。
 * 2) PAC_WORKER_RSS_LIMIT_KIB = 144 * 1024 = 进程 RSS 兜底闸。
 * 串行链 + URL 结果缓存下 PAC 求值本就罕见事件；Electron-as-node 底座物理下限 ~64 MiB，
 * OS 级配额 #64 承接更紧上界。
 */
const PAC_WORKER_HEAP_LIMIT_MB = 24;
/**
 * 进程 RSS 兜底闸（144 MiB，RSS 是唯一真值口径）：
 * 三运行时实测 worker 底座 RSS 40~63.5 MiB（Electron-as-node 更肥，物理下限 ~64 MiB），
 * 24 MiB 堆 OOM 自爆前瞬时峰值 96~124 MiB；96 MiB 级阈值会抢杀 V8 自检路径（T10-1）。
 * 144 MiB 覆盖「底座 + 堆自爆峰值 + 采样超射」，仍远低于 256 MiB 级外部内存爆发，
 * 用于捕获未来任何堆帽外分配面。
 */
const PAC_WORKER_RSS_LIMIT_KIB = 144 * 1024;
const PAC_WORKER_RSS_POLL_MS = 25;
const PAC_WORKER_PATH = fileURLToPath(new URL("./pac-eval-worker.js", import.meta.url));

/**
 * 模块级全局在飞闸（跨 transport 共享）：共用单一并发槽位排队等待，未取得槽位前不得 spawn 新 worker。
 * 并发上限为 1（单 worker 受脚本可控堆 24 MiB 硬限 + 进程 RSS 144 MiB 兜底闸约束）。
 */
let pacWorkerSlot = null;
const pacSlotWaiters = [];

function acquirePacSlot(signal, pendingWaiters) {
  if (signal?.aborted) return Promise.reject(abortError());
  if (pacWorkerSlot === null) {
    const token = {};
    pacWorkerSlot = token;
    return Promise.resolve(token);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      pendingWaiters.delete(waiter);
      const idx = pacSlotWaiters.indexOf(waiter);
      if (idx >= 0) pacSlotWaiters.splice(idx, 1);
    };
    const waiter = {
      grant(token) {
        if (settled) return false;
        if (signal?.aborted) {
          settled = true;
          cleanup();
          reject(abortError());
          return false;
        }
        settled = true;
        cleanup();
        resolve(token);
        return true;
      },
      close() {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new TransportError(PAC_CODES.EVAL_FAILED, "PAC 脚本求值失败（FindProxyForURL 运行出错）"));
      },
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    pendingWaiters.add(waiter);
    pacSlotWaiters.push(waiter);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function releasePacSlot(token) {
  if (pacWorkerSlot !== token) return;
  while (pacSlotWaiters.length > 0) {
    const next = pacSlotWaiters.shift();
    const nextToken = {};
    pacWorkerSlot = nextToken;
    if (next.grant(nextToken)) return;
  }
  pacWorkerSlot = null;
}

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
 * @param {{ fetch: (url: string, init: object) => Promise<any>, clock?: { now?: () => number }, log?: (level: string, message: string) => void, spawnProcess?: typeof spawn }} deps
 * @returns {{ fetch: (url: string, init?: object) => Promise<any>, close: () => void, closeAll: () => void }}
 */
export function createEntryTransport(entry, deps = {}) {
  const { fetch: fetchFn, clock, log, spawnProcess = spawn } = deps;
  if (typeof fetchFn !== "function") throw new TypeError("createEntryTransport 需要注入 fetch");

  const label = describeEntry(entry);
  const mode = classifyProxy(entry);
  const now = () => (typeof clock?.now === "function" ? clock.now() : 0);

  let closed = false;
  /** 成功加载的 PAC 脚本缓存（随本 transport 生命周期，释放即失效）。失败不缓存。 */
  let pacCache = null;
  /**
   * 已解析的 PAC 路由缓存（key = `${url}\0${host}`，≥128 条整表清空）。
   * 仅缓存 pickPacRoute 成功的轻量结构化 route 对象（kind/proxyUrl/viaPac/pacIndex/pacRevision/pacSource），
   * 不存原始指令文本；命中时直接返回该 route 对象，不重复求值或解析。
   */
  const pacResultCache = new Map();
  /** 在飞 PAC 求值子进程控制器，供 close/closeAll 立即强杀并收敛。 */
  const activePacWorkers = new Set();
  /** 本 transport 正在全局配额池等待槽位的求值请求，供 close/closeAll 立即清空并收敛。 */
  const pendingPacWaiters = new Set();
  let evalSeq = 0;

  /**
   * 在可独立终止的子进程边界内求值 PAC 脚本（CFG-005，工单 5）。
   *
   * 威胁模型：PAC 脚本来自远端配置（可能恶意、被攻陷或被劫持）。
   * 为何子进程边界是受支持运行时上唯一可终止方案：在 DSH 内嵌 Electron 44.7（Node 24.21.0）
   * 实测中，accessor getter 触发的全局读取（如 FindProxyForURL 或 __pacHost 死循环 getter）
   * 完全不响应 node:vm 的 synchronous timeout，会在进程内永久挂死线程；只有可独立终止的
   * 子进程边界才能从外部 SIGKILL。
   * 纵深防御：worker（src/pac-eval-worker.js）内仍保留无宿主对象的隔离 vm 上下文、
   * codeGeneration:{strings:false,wasm:false} 与三段各 500ms 的 CPU 护栏——普通死循环
   * 由子内 vm timeout 快速失败，getter 类死循环则由父侧 PAC_EVAL_WALL_LIMIT_MS（2000ms）外杀。
   *
   * @returns {Promise<string>} FindProxyForURL 返回的指令文本
   */
  function runPacWorker(script, targetUrl, host, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    const evalId = ++evalSeq;

    return new Promise((resolve, reject) => {
      let settled = false;
      let receivedOutcome = null;
      let terminationReason = null; // "timeout" | "rss_limit" | "closed" | "abort" | null
      let child = null;
      let watchdog = null;
      let wallTimer = null;
      let rssTimer = null;
      let rssSampling = false;
      let rssDisabled = false;

      const stopRssWatchdog = () => {
        if (!rssTimer) return;
        clearInterval(rssTimer);
        rssTimer = null;
      };

      const killWatchdog = () => {
        if (!watchdog) return;
        const wd = watchdog;
        watchdog = null;
        try {
          wd.kill();
        } catch {}
      };

      const killChild = () => {
        if (!child) return;
        try {
          child.kill("SIGKILL");
        } catch {}
      };

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (wallTimer) {
          clearTimeout(wallTimer);
          wallTimer = null;
        }
        stopRssWatchdog();
        activePacWorkers.delete(workerHandle);
        signal?.removeEventListener("abort", onAbort);
        killWatchdog();
        if (err) reject(err);
        else resolve(value);
      };

      const onAbort = () => {
        if (settled) return;
        terminationReason = "abort";
        killChild();
        finish(abortError());
      };

      const workerHandle = {
        close() {
          if (settled) return;
          terminationReason = "closed";
          killChild();
          finish(new TransportError(PAC_CODES.EVAL_FAILED, "PAC 脚本求值失败（FindProxyForURL 运行出错）"));
        },
      };

      activePacWorkers.add(workerHandle);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      try {
        child = spawnProcess(process.execPath, [`--max-old-space-size=${PAC_WORKER_HEAP_LIMIT_MB}`, PAC_WORKER_PATH], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: { ELECTRON_RUN_AS_NODE: "1" },
          cwd: undefined,
          signal,
          killSignal: "SIGKILL",
        });
      } catch (err) {
        if (isAbort(err, signal)) {
          finish(abortError());
        } else {
          finish(new TransportError(PAC_CODES.EVAL_FAILED, "PAC 脚本求值失败（FindProxyForURL 运行出错）"));
        }
        return;
      }

      // 父侧看门狗：防父进程被 SIGKILL 时挂死子进程成为永转 CPU 的孤儿。
      // PID 复用在 3s 窗口内不可实际达成，且威胁模型是远端 PAC 脚本。
      if (typeof child?.pid === "number" && child.pid > 0) {
        try {
          watchdog = spawn("/bin/sh", ["-c", `sleep 3; kill -9 ${child.pid} 2>/dev/null`], {
            stdio: "ignore",
          });
          watchdog.on("error", () => {});
          if (typeof watchdog.unref === "function") watchdog.unref();
        } catch {
          watchdog = null;
        }

        // 父进程 RSS 采样看门狗（真·闸）：堆帽只限老生代，外部/未触页之外的实际物理占用以 RSS 为唯一真值。
        const pidArg = String(child.pid);
        const sampleRss = () => {
          if (settled || rssDisabled || rssSampling) return;
          rssSampling = true;
          try {
            execFile("ps", ["-o", "rss=", "-p", pidArg], { encoding: "utf8", timeout: 500 }, (err, stdout) => {
              rssSampling = false;
              if (settled) return;
              if (err) {
                if (err.code === "ENOENT" || err.code === "EPERM" || err.code === "EACCES") {
                  rssDisabled = true;
                  stopRssWatchdog();
                }
                return;
              }
              const rssKiB = Number.parseInt(String(stdout).trim(), 10);
              if (Number.isFinite(rssKiB) && rssKiB >= PAC_WORKER_RSS_LIMIT_KIB) {
                terminationReason = "rss_limit";
                stopRssWatchdog();
                killChild();
              }
            });
          } catch (err) {
            rssSampling = false;
            if (err?.code === "ENOENT" || err?.code === "EPERM" || err?.code === "EACCES") {
              rssDisabled = true;
              stopRssWatchdog();
            }
          }
        };
        rssTimer = setInterval(sampleRss, PAC_WORKER_RSS_POLL_MS);
        if (typeof rssTimer.unref === "function") rssTimer.unref();
      }

      // 墙上时限 PAC_EVAL_WALL_LIMIT_MS 从取得槽位、worker 实际 spawn 后起算（排队时间不计入 2s——
      // 否则并发链会因排队被误判超时）。
      wallTimer = setTimeout(() => {
        if (settled) return;
        terminationReason = "timeout";
        killChild();
      }, PAC_EVAL_WALL_LIMIT_MS);

      child.on("message", (msg) => {
        if (settled) return;
        if (msg && typeof msg === "object" && msg.id === evalId && typeof msg.outcome === "string") {
          receivedOutcome = msg.outcome;
        }
      });

      child.on("error", (err) => {
        if (isAbort(err, signal) || terminationReason === "abort") {
          finish(abortError());
          return;
        }
        killChild();
        finish(new TransportError(PAC_CODES.EVAL_FAILED, "PAC 脚本求值失败（FindProxyForURL 运行出错）"));
      });

      child.on("exit", () => {
        stopRssWatchdog();
        killWatchdog();
      });

      child.on("close", () => {
        if (terminationReason === "abort" || signal?.aborted) {
          finish(abortError());
          return;
        }
        if (
          terminationReason === "timeout" ||
          terminationReason === "rss_limit" ||
          terminationReason === "closed" ||
          receivedOutcome === null
        ) {
          finish(new TransportError(PAC_CODES.EVAL_FAILED, "PAC 脚本求值失败（FindProxyForURL 运行出错）"));
          return;
        }
        // 新增失败类别（工单 6）：沙箱密封后逃逸金丝雀自检未通过，归入 EVAL_FAILED，不影响既有三阶段消息。
        if (receivedOutcome === "E") {
          finish(new TransportError(PAC_CODES.EVAL_FAILED, "PAC 脚本求值失败（沙箱安全自检未通过）"));
          return;
        }
        if (receivedOutcome === "P") {
          finish(new TransportError(PAC_CODES.EVAL_FAILED, "PAC 脚本求值失败（脚本无法解析或顶层执行出错）"));
          return;
        }
        if (receivedOutcome === "N") {
          finish(new TransportError(PAC_CODES.EVAL_FAILED, "PAC 脚本缺少 FindProxyForURL"));
          return;
        }
        if (receivedOutcome === "R") {
          finish(new TransportError(PAC_CODES.EVAL_FAILED, "PAC 脚本求值失败（FindProxyForURL 运行出错）"));
          return;
        }
        if (receivedOutcome === "T") {
          finish(new TransportError(PAC_CODES.ROUTE_FAILED, "PAC 脚本返回值不是指令文本"));
          return;
        }
        // 新增失败类别（工单 8）：指令长度超过 worker 侧 PAC_DIRECTIVE_MAX_LEN（4096），归入 ROUTE_FAILED。
        if (receivedOutcome === "L") {
          finish(new TransportError(PAC_CODES.ROUTE_FAILED, "PAC 脚本返回值超过长度上限"));
          return;
        }
        if (receivedOutcome.startsWith("S")) {
          finish(null, receivedOutcome.slice(1));
          return;
        }
        finish(new TransportError(PAC_CODES.EVAL_FAILED, "PAC 脚本求值失败（FindProxyForURL 运行出错）"));
      });

      try {
        child.send({ id: evalId, script: String(script), url: String(targetUrl), host: String(host) });
      } catch {
        if (signal?.aborted) {
          finish(abortError());
        } else {
          killChild();
          finish(new TransportError(PAC_CODES.EVAL_FAILED, "PAC 脚本求值失败（FindProxyForURL 运行出错）"));
        }
      }
    });
  }

  async function evaluatePac(script, targetUrl, host, signal) {
    if (signal?.aborted) throw abortError();
    if (closed) {
      throw new TransportError(PAC_CODES.EVAL_FAILED, "PAC 脚本求值失败（FindProxyForURL 运行出错）");
    }
    const slotToken = await acquirePacSlot(signal, pendingPacWaiters);
    try {
      if (signal?.aborted) throw abortError();
      if (closed) {
        throw new TransportError(PAC_CODES.EVAL_FAILED, "PAC 脚本求值失败（FindProxyForURL 运行出错）");
      }
      return await runPacWorker(script, targetUrl, host, signal);
    } finally {
      releasePacSlot(slotToken);
    }
  }

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
      // 字节上限（MAX_RESPONSE_BYTES，流式早停）：超限归 PAC_FETCH_FAILED 并带尺寸诊断，不落成 EVAL 类。
      let script;
      try {
        const body = await raceAbort(readBoundedText(res), signal);
        if (body.tooLarge) {
          throw new TransportError(
            PAC_CODES.FETCH_FAILED,
            `条目${label}PAC 脚本超出大小上限（${body.limit} 字节），已中止下载：${endpointOf(pacUrl)}`,
          );
        }
        script = body.text;
      } catch (err) {
        if (err instanceof TransportError) throw err;
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
    const cacheKey = `${url}\0${host}`;
    let route = pacResultCache.get(cacheKey);
    if (route === undefined) {
      const directive = await evaluatePac(pac.script, url, host, signal);
      const picked = pickPacRoute(directive);
      route = { kind: picked.kind, viaPac: true, pacIndex: picked.index, pacRevision: pac.revision, pacSource: pac.source };
      if (picked.proxyUrl !== undefined) route.proxyUrl = picked.proxyUrl;
      // 仅缓存 pickPacRoute 成功的已解析路由对象（proxyUrl 经 WHATWG URL 校验规范化，天然有界）。
      if (pacResultCache.size >= 128) pacResultCache.clear();
      pacResultCache.set(cacheKey, route);
    }
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
      pacResultCache.clear();
      for (const worker of [...activePacWorkers]) worker.close();
      for (const waiter of [...pendingPacWaiters]) waiter.close();
    },

    /** 同 close（单条目 transport 的释放即全部释放）。幂等。 */
    closeAll() {
      closed = true;
      pacCache = null;
      pacResultCache.clear();
      for (const worker of [...activePacWorkers]) worker.close();
      for (const waiter of [...pendingPacWaiters]) waiter.close();
    },
  };
}
