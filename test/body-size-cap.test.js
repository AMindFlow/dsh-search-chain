// 体积上限 Oracle（#12 遗留面）— 响应体读取字节上限：PAC 下载与六家供应商正文（审计背景 /tmp/cap-case.txt）。
//
// 审计事实（main 6b26ba7 只读核查）：
//   - src/transport.js loadPac() 对 PAC 响应直接 res.text()，无字节上限：恶意/病态 PAC 服务器可在
//     FB-003 时间预算内缓冲任意大响应（带宽足够时预算拦不住字节）——最高危：直连出站、免凭据。
//   - brave.js / exa.js / gemini.js / tavily.js / openai.js / deepseek.js 六家适配器正文读取同型无上限。
//   - 先例 = BING-002（src/backends/bing.js MAX_BODY_BYTES = 2MiB）：流式主路硬上限（逐块累计、超限
//     即 reader.cancel + BAD_RESPONSE）；仅 text() 退化路为「读后判长」的软上限。
//
// 本 oracle 钉的可观察面（dev 实现方式自定，但不得弱化以下断言）：
//   1) src/constants.js 导出 MAX_RESPONSE_BYTES = 2MiB（名字与数值由本 oracle 钉；dev 对齐复用
//      BING-002 常量，避免第三份权威——同 entry-codes-single-source 的单源精神）。
//   2) PAC：8MB 无限 chunk 流（loopback fixture）下，读取在 ≤ 上限+容差处主动停止——服务端先于
//      全量观测到连接早关（client abort），失败码 PAC_FETCH_FAILED，诊断含尺寸线索，全程 <2s
//      （进程不等全量；时间预算兜底 ≠ 字节上限）。
//   3) 六家供应商：假 fetch 回 4MB 正文（reader 流式计数）→ 超上限即失败（本地 ENTRY_BAD_RESPONSE
//      归类可接受，诊断须含尺寸线索，以区别于「顺带的解析失败」），且 reader 读到 ≤上限+容差即
//      cancel——不断言读满全量。
//   4) bing 的 text()-only 软上限面：取舍 = 流式主路已硬（BING-002 先例），text() 退化路只能读后
//      判长（内存峰值到全量为止，无法网络层早停）；本例只钉「超限即失败」，不强求早停。现预期为
//      绿（守卫回归），非 dev 红面。
//
// 缺陷钉（当前绿=字节上限已落地，回退即红；历史 dev 面 = 无上限）：
//   - 「MAX_RESPONSE_BYTES」1 例（constants.js 缺常量）；
//   - 「PAC 下载」1 例（transport 无上限：读满 8MB、错误为 EVAL/NETWORK 类、无尺寸线索）；
//   - 六家供应商各 1 例（text() 读满 4MB、无 cancel、无尺寸线索）。共 8 红。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import * as C from "./helpers/contract.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { createControlledClock } from "./helpers/clock.js";
import { SYNTHETIC_KEY } from "./helpers/fake-fetch.js";

// ─── 上限常量与容差（oracle 侧镜像；同步义务见 src/constants.js 头注）──────────

/** 上限名面钉死：MAX_RESPONSE_BYTES = 2MiB，复用 BING-002 MAX_BODY_BYTES（bing.js:47）。 */
const MAX_EXPECTED = 2 * 1024 * 1024;
/** 常量所在模块（dev 单源位）。命名空间导入：缺失时只红本用例，不炸整个文件。 */
const constants = await import("../src/constants.js");

/** 假正文流式 chunk 大小。 */
const CHUNK = 64 * 1024;
/** 容差 = 2 chunks：流式上限的合理实现是「读一块再判超限」，允许一块过冲 + 解码边界余量。 */
const TOL = 2 * CHUNK;
/** 供应商面 fixture 全量 = 上限的 2 倍（超上限即足以证，读满 4MB = 未早停）。 */
const VENDOR_TOTAL = 4 * 1024 * 1024;
/** PAC 面 fixture 全量 = 上限的 4 倍：故意远超，用于证伪「进程等全量」。 */
const PAC_TOTAL = 8 * 1024 * 1024;
/** PAC 服务端计数余量：socket/undici 缓冲使「已写入」可略超「客户端已读」；配速后仍须远小于全量。 */
const PAC_MARGIN = 2 * 1024 * 1024;
/** 尺寸线索：区分「超上限失败」与红面上顺带的解析/路由错误（后者无任何尺寸语义）。 */
const SIZE_HINT = /上限|大小|体积|字节|超出|size|bytes|too.?large/i;

// ─── 合成体与假 fetch（内联样本，遵守 fixtures 卫生规则 6；全 ASCII、无凭据形状）──

/** 可解析 JSON 的填充正文（恰好 totalBytes）：现状必须「读满后映射失败」而非解析前被拒。 */
function padJsonBody(totalBytes) {
  const prefix = '{"synthetic":true,"pad":"';
  const suffix = '"}';
  return prefix + "A".repeat(totalBytes - prefix.length - suffix.length) + suffix;
}

const OVERSIZED_TEXT = padJsonBody(VENDOR_TOTAL);
const OVERSIZED_BYTES = new TextEncoder().encode(OVERSIZED_TEXT); // 全 ASCII：byteLength === VENDOR_TOTAL

/** reader 流式计数视图：delivered = 已交付字节；cancelObserved = reader.cancel/流中止已传播。 */
function makeCountedStream(bytesSource) {
  const stats = { delivered: 0, cancelObserved: false, completed: false };
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= bytesSource.byteLength) {
        stats.completed = true;
        controller.close();
        return;
      }
      const end = Math.min(offset + CHUNK, bytesSource.byteLength);
      stats.delivered += end - offset;
      controller.enqueue(bytesSource.subarray(offset, end));
      offset = end;
    },
    cancel() {
      stats.cancelObserved = true;
    },
  });
  return { stream, stats };
}

/** 带 .body 流的上游响应替身（真实 undici 响应同为 ReadableStream；cap 实现须能走流式早停）。 */
function makeStreamingResponse(bytesSource) {
  const { stream, stats } = makeCountedStream(bytesSource);
  const response = {
    ok: true,
    status: 200,
    statusText: "OK",
    url: "https://synthetic-vendor.invalid/oversized",
    headers: new Headers({ "content-type": "application/json" }),
    body: stream,
    async text() {
      const reader = stream.getReader();
      const decoder = new TextDecoder("utf-8");
      let out = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
      return out + decoder.decode();
    },
    async json() {
      return JSON.parse(await response.text());
    },
  };
  return { response, stats };
}

/** 只有 text() 的退化响应（bing 软上限面：无流可读，实现只能读后判长）。 */
function makeTextOnlyResponse(text, contentType) {
  const stats = { fullTextRead: false };
  return {
    stats,
    response: {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": contentType }),
      body: null,
      async text() {
        stats.fullTextRead = true;
        return text;
      },
      async json() {
        return JSON.parse(text);
      },
    },
  };
}

/** 单次出站假 fetch：记录调用；signal 中止时按 undici 语义联动取消体流（对 signal 式 cap 公平）。 */
function capFetch(response, stats) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const signal = init?.signal;
    if (signal?.aborted) {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    signal?.addEventListener(
      "abort",
      () => {
        stats.cancelObserved = true;
        response.body?.cancel?.(new Error("signal aborted")).catch(() => {});
      },
      { once: true },
    );
    return response;
  };
  fetchFn.calls = calls;
  return fetchFn;
}

/** A5 ctx（contract.js）：受控时钟 + 合成凭据；各后端共用同一形状。 */
function makeCapCtx(type, fetchFn) {
  return {
    entry: { id: `cap-${type}`, type, name: `体积上限条目 ${type}`, enabled: true },
    query: "synthetic body cap 合成查询",
    maxResults: 5,
    key: SYNTHETIC_KEY("bodycap"),
    fetch: fetchFn,
    budgetMs: 5000,
    signal: new AbortController().signal,
    clock: createControlledClock(),
    log: () => {},
  };
}

/** 拒绝断言：返回错误对象；意外 resolve 直接判红（超限体不得被当成功接受）。 */
async function rejectionOf(promise) {
  let value;
  try {
    value = await promise;
  } catch (err) {
    return err ?? new Error(`rejected with ${String(err)}`);
  }
  assert.fail(`超限响应必须以失败落定（实际成功 resolve：${JSON.stringify(value)?.slice(0, 120)}）`);
}

// ─── ① 上限常量（constants.js 单源面）────────────────────────────────────────

test("#12 上限常量：src/constants.js 须导出 MAX_RESPONSE_BYTES = 2MiB（复用 BING-002 对齐名字面）", () => {
  // 现状缺陷=dev 面（缺陷钉）：constants.js 无该常量；bing.js 的 MAX_BODY_BYTES 是本地上限，未提升为
  // 跨模块单源。修复 = 新增/对齐导出，值与 BING-002 全等，避免「第三份可漂移权威」。
  assert.equal(
    constants.MAX_RESPONSE_BYTES,
    MAX_EXPECTED,
    `预期红：src/constants.js 缺 MAX_RESPONSE_BYTES（期望 ${MAX_EXPECTED}，实际 ${String(constants.MAX_RESPONSE_BYTES)}）；` +
      "PAC 与六家正文读取须以它作跨模块单源（BING-002 先例同值）",
  );
});

// ─── ② PAC 下载上限（最高危：直连、免凭据、任意大缓冲面）────────────────────

/**
 * loopback PAC 服务器：200 + 无限 chunk 流（合法 PAC 语句前缀 + 填充，写到 totalBytes 为止，
 * 便于服务端精确计数）。逐块配速写并遵守背压；记录「已写入字节」与「连接是否在全部写入前被关闭」。
 * 配速（每 128KiB 间歇一个宏任务）限制 client 早停后的在途超量，使 sent 紧贴 client 实际读取量；
 * 缓冲导致的残余超量由 PAC_MARGIN 吸收——client 早停的强证据是 closedEarly && !fullSent。
 */
async function startPacServer(totalBytes) {
  const chunk = Buffer.from(`${"0".repeat(128 * 1024)}\n`);
  const obs = { sent: 0, closedEarly: false, fullSent: false, closed: false, closeSettled: null };
  const server = http.createServer((req, res) => {
    let written = 0;
    let finished = false;
    obs.closeSettled = new Promise((resolve) => res.on("close", resolve));
    res.on("close", () => {
      obs.closed = true;
      if (!finished) obs.closedEarly = true;
    });
    res.writeHead(200, { "content-type": "application/x-ns-proxy-autoconfig" });
    (async () => {
      try {
        while (written < totalBytes) {
          const slice = chunk.subarray(0, Math.min(chunk.byteLength, totalBytes - written));
          const flushOk = res.write(slice);
          written += slice.byteLength;
          obs.sent = written;
          if (!flushOk) {
            // 注意：drain 事件无参数，必须按事件名区分；败方监听器用 AbortSignal 摘除（防 MaxListeners 泄漏）。
            const ctrl = new AbortController();
            const outcome = await Promise.race([
              once(res, "drain", { signal: ctrl.signal }).then(() => "drain", () => "abort"),
              once(res, "close", { signal: ctrl.signal }).then(() => "close", () => "abort"),
            ]);
            ctrl.abort();
            if (outcome !== "drain") return; // 连接已关/出错：client 早停或异常的直接证据
          }
          await new Promise((resolve) => setTimeout(resolve, 1)); // 配速：避免写侧远超读侧
        }
        if (!res.destroyed && !res.writableEnded) {
          res.end();
          finished = true;
          obs.fullSent = true;
        }
      } catch {
        // client abort 后的写入错误：预期路径，早停证据走 close/fullSent。
      }
    })();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, obs, port: server.address().port };
}

test("#12 PAC 下载上限：8MB 无限流须 ≤上限+余量处早停，PAC_FETCH_FAILED 携尺寸线索，全程 <2s（不等全量）", async (t) => {
  // 现状缺陷=dev 面（缺陷钉）：transport.js loadPac() 直接 res.text()——读满 8MB 才开始求值；
  // 错误落点变成 EVAL_FAILED / 直连出站失败，服务端观测到全量，无尺寸线索。
  const { createEntryTransport } = await import("../src/transport.js");
  const { server, obs, port } = await startPacServer(PAC_TOTAL);
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  // 生产出站语义复刻（index.js productionFetch）：剥 route 标记后照常 globalThis.fetch；
  // 本 oracle 再加保险丝——非 loopback 一律拒发（绝不真出站）。
  const productionFetch = (url, init = {}) => {
    const { route, ...rest } = init ?? {};
    const text = String(url);
    if (!text.startsWith("http://127.0.0.1:")) {
      return Promise.reject(new Error("[cap-oracle] 拒绝 loopback 外出站"));
    }
    return globalThis.fetch(text, rest);
  };

  const transport = createEntryTransport(
    { id: "cap-pac", type: "bing", name: "PAC 体积上限", proxy: { pac: `http://127.0.0.1:${port}/proxy.pac` } },
    { fetch: productionFetch, log: () => {} },
  );

  const t0 = performance.now();
  let err = null;
  try {
    await transport.fetch("https://example.invalid/");
  } catch (e) {
    err = e;
  } finally {
    transport.close();
  }
  const elapsed = performance.now() - t0;
  // 等 close 事件落定（上限命中时 abort 先于 close；给 300ms 收敛窗口）。
  await Promise.race([obs.closeSettled, new Promise((r) => setTimeout(r, 300))]);

  assert.ok(err, "超大 PAC 必须以失败落定");
  assert.equal(
    err.code,
    C.CONFIG_CODES.PAC_FETCH_FAILED,
    "PAC 下载超上限须归 PAC_FETCH_FAILED（CFG-003/PAC 阶段码）；" +
      `实际 ${err.code}：无上限时体积只在解析/求值/路由之后才间接暴露（预期红）`,
  );
  assert.match(
    err.message,
    SIZE_HINT,
    "诊断须含尺寸线索（上限/字节/大小），与一般下载失败可区分、可操作（CFG-003）",
  );
  assert.ok(
    obs.sent <= MAX_EXPECTED + PAC_MARGIN,
    `服务端「已写入」须 ≤ 上限+缓冲余量（期望 ≤${MAX_EXPECTED + PAC_MARGIN}，实际 ${obs.sent}）：` +
      "读满全量 = 无字节上限，进程等全量（预期红）",
  );
  assert.ok(
    obs.closedEarly && !obs.fullSent,
    "须先于全量观测到连接早关（reader cancel / request abort 先于 res.end）；全量送达 = 未早停",
  );
  assert.ok(
    obs.sent > 0 && err !== null,
    "PAC 下载确已发生且失败（防呆：连接失败类假绿）",
  );
  assert.ok(
    elapsed < 2000,
    `字节上限须在秒内命中（实际 ${elapsed.toFixed(0)}ms）：fixture 故意 8MB，慢路径说明在等全量`,
  );
});

// ─── ③ 供应商正文读取上限（参数化，六家各 1 例；缺陷钉=dev 面）───────────────

const VENDOR_CASES = [
  { type: "brave", rel: "backends/brave.js", pick: (m) => m.braveBackend ?? m.default ?? m.createBraveBackend?.() },
  { type: "exa", rel: "backends/exa.js", pick: (m) => m.exaBackend ?? m.default ?? m.createExaBackend?.() },
  { type: "gemini", rel: "backends/gemini.js", pick: (m) => m.createGeminiBackend?.() ?? m.geminiBackend ?? m.default },
  { type: "tavily", rel: "backends/tavily.js", pick: (m) => m.tavilyBackend ?? m.default ?? m.createTavilyBackend?.() },
  { type: "openai", rel: "backends/openai.js", pick: (m) => m.openaiBackend ?? m.default ?? m.createOpenAIBackend?.() },
  {
    type: "deepseek-search",
    rel: "backends/deepseek.js",
    pick: (m) => m.deepseekBackends?.["deepseek-search"] ?? m.deepseekSearchBackend,
  },
];

for (const c of VENDOR_CASES) {
  test(`#12 供应商上限（缺陷钉=dev 面）：${c.type} 4MB 正文须 ≤上限+容差早停 cancel 并以尺寸线索失败`, async (t) => {
    // 现状缺陷：res.text() 无上限——4MB 全量入内存（delivered=4MB、无 cancel），错误只是顺带的
    // 解析/映射失败（无尺寸线索）。修复 = 流式逐块计数，>MAX_RESPONSE_BYTES 即 cancel +
    // ENTRY_BAD_RESPONSE 类（FB-005「异常响应」；本地归类为 ENTRY_BAD_RESPONSE 已被接受）。
    assert.equal(OVERSIZED_BYTES.byteLength, VENDOR_TOTAL, "fixture 自检：合成体恰为 4MiB");
    const res = await tryImportSrc(c.rel);
    if (failIfUnimplemented(t, res, `src/${c.rel}`, "#12 响应体字节上限")) return;
    const backend = c.pick(res.module);
    assert.ok(backend && typeof backend.search === "function", `${c.rel} 须导出 { type, search(ctx) }（A5）`);

    const { response, stats } = makeStreamingResponse(OVERSIZED_BYTES);
    const fetch = capFetch(response, stats);
    const err = await rejectionOf(backend.search(makeCapCtx(c.type, fetch)));

    assert.equal(
      err?.code,
      C.ENTRY_CODES.BAD_RESPONSE,
      "超上限正文按本地 ENTRY_BAD_RESPONSE 类失败（FB-005 异常响应）；实际 " +
        `${err?.code ?? err?.name}: ${err?.message}`,
    );
    assert.match(
      err?.message ?? "",
      SIZE_HINT,
      "诊断须含尺寸线索：与「正文太小/格式坏」类解析失败区分（现状解析失败无尺寸语义，预期红）",
    );
    assert.ok(
      stats.delivered <= MAX_EXPECTED + TOL,
      `reader 至多读 上限+容差=${MAX_EXPECTED + TOL} 字节（实际 ${stats.delivered}）：` +
        "读到全量 4MiB = 无字节上限（预期红）",
    );
    assert.ok(
      !stats.completed && stats.cancelObserved,
      "早停证据：reader 须 cancel（或 signal 中止联动取消体流），不得读完全量" +
        `（completed=${stats.completed}, cancelObserved=${stats.cancelObserved}）`,
    );
    assert.equal(fetch.calls.length, 1, "FB-001：本条目出站恰好一次（失败后不得重试/再发）");
  });
}

// ─── ④ bing text()-only 软上限面（现预期绿：守卫回归，非 dev 红面）───────────

test("#12 bing 软上限面（text() 退化路）：超限即失败（不钉早停——流式主路已硬，BING-002 取舍）", async (t) => {
  // 取舍注释（先例说明）：BING-002 的流式主路（response.body 为 ReadableStream）已钉硬上限——逐块
  // 累计、超限即 reader.cancel，本文件③的早停面若 dev 推广到各家即等价。本例故意提供无流的
  // text()-only 响应：真实 fetch 中即对应「退化路」，实现只能读后判长（内存峰值到全量为止，
  // 网络层早停在契约上不可观察），故只钉「超限即失败 + 尺寸线索」，不强求早停。
  const res = await tryImportSrc("backends/bing.js");
  if (failIfUnimplemented(t, res, "src/backends/bing.js", "#12/BING-002 软上限面")) return;
  const backend = res.module.bingBackend;
  assert.ok(backend && typeof backend.search === "function", "backends/bing.js 须导出 bingBackend（A5）");

  const { response } = makeTextOnlyResponse(OVERSIZED_TEXT, "application/rss+xml");
  const fetch = capFetch(response, { cancelObserved: false, completed: false });
  const ctx = { ...makeCapCtx("bing", fetch), key: undefined }; // bing 免 key（CFG-002）
  const err = await rejectionOf(backend.search(ctx));

  assert.equal(err?.code, C.ENTRY_CODES.BAD_RESPONSE, "BING-002：响应体超出大小上限 → 异常响应类");
  assert.match(err?.message ?? "", SIZE_HINT, "BING-002：诊断须含尺寸线索");
  assert.equal(fetch.calls.length, 1, "FB-001：出站恰好一次");
});
