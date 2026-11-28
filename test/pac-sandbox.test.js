// PAC 沙箱 realm 泄漏回归（codex Security Review P2，Refs #58，落在 PR #63 分支）。
//
// 需求来源：codex Security Review 在 PR #63 行内发现的 P2——V5-7 编辑器允许用户填 pac:http(s)://…，
// 出站时 src/transport.js 的 evaluatePac() 用 node:vm 求值下载的 PAC 脚本，context 初始对象注入宿主
// realm 函数 { isPlainHostName, dnsDomainIs, shExpMatch }；脚本内 isPlainHostName.constructor("return process")()
// 即可拿到宿主 Function、绕过 codeGeneration:{strings:false}，改写宿主 process（恶意/被攻陷 PAC 端点
// 获得宿主进程代码执行）。lead 已在 Node v26.13.0 本机复现。
//
// 可观察验收（本文件锁定）：
//   P2-1 逃逸回归 6 例：顶层 / FindProxyForURL 内经任何路径逃逸（沙箱函数 .constructor、
//         this.constructor、new Function、eval）必须失败：求值抛 TransportError，code=PAC_EVAL_FAILED，
//         宿主 process 零改动（canary 用例前 "baseline"、用例后仍 "baseline"、finally 删除）。
//   P2-2 沙箱形状钉死：合法脚本内 typeof process/require/module/Buffer === "undefined"、
//         三个标准助手 typeof === "function"；缺 FindProxyForURL 仍 PAC_EVAL_FAILED。
//   P2-3 shExpMatch 等价表（核心）：把现宿主实现原文内联为 reference-only，在测试侧以其实际计算值
//         生成数据表 expected，一次 PAC 求值批量表驱动比对；全过返回 DIRECT、任一失配返回
//         PROXY 1.2.3.4:8080，测试据此断言。isPlainHostName / dnsDomainIs 同法各一张钉死小表。
//         一切 expected 以 reference 实现实际计算值为准（禁止凭直觉）。
//   P2-4 行为保持：合法脚本用 shExpMatch 返回 PROXY 1.2.7.9:8080 → 目标请求 init.route 的
//         kind/proxyUrl/viaPac/pacIndex 与 test/network-contract.test.js 既有期望同构（只参考，不改它）；
//         用户脚本顶层重定义 shExpMatch 仍允许且用户版本生效；同一 transport 两次 fetch →
//         SYNTHETIC_PAC 只下载一次。
//
// 契约接缝（与 test/network-contract.test.js 相同）：
//   createEntryTransport(entry, { fetch }) → { fetch(url, init), close(), closeAll() }
//   注入 fetch = helpers/fake-fetch.js 的 createFakeFetch（default:"never"：未声明出站即抛）。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./helpers/contract.js";
import { createFakeFetch, SYNTHETIC_PAC } from "./helpers/fake-fetch.js";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";

const WP = "WP1 src/transport.js（PAC 沙箱 realm 泄漏修复）";
const CLAUSES = "CFG-005 + codex Security Review P2 (#58)";

async function load(t) {
  const res = await tryImportSrc("transport.js");
  if (failIfUnimplemented(t, res, WP, CLAUSES)) return null;
  return res.module;
}

/** 合成供应商目标（保留域；绝不指向真实供应商，见 test/fixtures/README.md 规则 1）。 */
const TARGET = "https://api.tavily.invalid/pac-sandbox?q=synthetic";

const LEAK_HOST = "pac-sandbox-leak.invalid:1";
const MISMATCH_PROXY = "1.2.3.4:8080";
const BEHAVIOR_PROXY = "1.2.7.9:8080";

// ─── reference-only：现宿主实现原文（src/transport.js 修复前 L139-157 逐字转写）─────────────────
// 仅作测试侧计算数据表 expected 的基准；运行时（src/）不得复制此实现，沙箱助手必须是沙箱 realm 自身。

function isPlainHostNameRef(host) {
  return typeof host === "string" && !host.includes(".");
}

function dnsDomainIsRef(host, domain) {
  if (typeof host !== "string" || typeof domain !== "string") return false;
  return host.toLowerCase().endsWith(domain.toLowerCase());
}

function shExpMatchRef(text, pattern) {
  if (typeof text !== "string" || typeof pattern !== "string") return false;
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\/-]/g, "\\$&");
  }
  return new RegExp(`${re}$`).test(text);
}

// ─── 数据表（expected 一律由 reference 实际计算，禁止手填）─────────────────────────────────────

const SH_EXP_ROWS_RAW = [
  // 字面量匹配/失配
  ["hello", "hello"],
  ["hello", "hell"],
  ["hello", "helloo"],
  ["Hello", "hello"],
  ["hello", "Hello"],
  ["hello", "HELLO"],
  ["", ""],
  ["", "a"],
  ["a", ""],
  [" ", " "],
  [" a ", " a "],
  // ? 单个 / 过长
  ["a", "?"],
  ["ab", "?"],
  ["", "?"],
  ["ab", "??"],
  ["abc", "??"],
  ["a?b", "a.b"],
  ["axb", "a.b"],
  ["aXb", "a.b"],
  // * 零次 / 单次 / 多次 / 首尾 / 单独
  ["abc", "*"],
  ["", "*"],
  ["abc", "**"],
  ["ab", "a*b"],
  ["axxb", "a*b"],
  ["aXb", "a*b"],
  ["b", "a*b"],
  ["a*b", "a*b"],
  ["abc", "a*"],
  ["ba", "a*"],
  ["abc", "*c"],
  ["abc", "*d"],
  ["xbcx", "*b*"],
  ["xaxx", "*b*"],
  ["abc123", "abc*3"],
  ["abcx123", "abc*3"],
  ["xabc", "*abc*"],
  // 正则元字符一律字面量
  ["a.c", "a.c"],
  ["axc", "a.c"],
  ["a+b", "a+b"],
  ["ab", "a+b"],
  ["a[b]", "a[b]"],
  ["ab", "a[b]"],
  ["a(c)", "a(c)"],
  ["ac", "a(c)"],
  ["a{2}", "a{2}"],
  ["aa", "a{2}"],
  ["a|b", "a|b"],
  ["b", "a|b"],
  ["^a", "^a"],
  ["a", "^a"],
  ["a$", "a$"],
  ["a", "a$"],
  ["a\\b", "a\\b"],
  ["ab", "a\\b"],
  ["a/b", "a/b"],
  ["axb", "a/b"],
  ["a-b", "a-b"],
  ["axb", "a-b"],
  ["[", "["],
  ["]", "["],
  // 含行终止符文本（\n \r \u2028 \u2029）配 * 与 ?：* / ? 不得越过行终止符
  ["a\nb", "a*b"],
  ["a\nb", "*"],
  ["ab\ncd", "*\n*"],
  ["a\nb", "a\nb"],
  ["a\nb", "a?b"],
  ["a\rb", "a*b"],
  ["a\u2028b", "a*b"],
  ["a\u2029b", "a*b"],
  ["a\n", "*\n"],
  ["\n", "?"],
  ["a\u2028b", "a\nb"],
  // emoji（代理对 = 两个 UTF-16 码元）
  ["😀", "?"],
  ["😀", "??"],
  ["😀", "???"],
  ["😀", "*"],
  ["😀", "😀"],
  ["a😀b", "a*b"],
  // 回溯型
  ["aaaaaab", "a*a*a*a*b"],
  ["aab", "a*a*b"],
  ["ab", "a*a*b"],
  ["aab", "a*a*c"],
  ["abcabc", "a*bc*"],
  // 非 string 参数（null / 数字 / undefined / 布尔 / 数组 → false）
  [null, "a"],
  [123, "*"],
  [undefined, "*"],
  ["a", null],
  ["a", 123],
  ["a", undefined],
  [true, "*"],
  [null, null],
  [[], "a"],
  // 第二轮补行（codex P2-2 跟进）：pattern 字面 \n 命中 / 回溯路径撞 \n 失配 / 星字面组合
  ["ab\ncd", "ab\ncd"],
  ["a\nxb", "a*x*xb"],
  ["z", "*z"],
  // 第三轮补行（lead 独立 DP 差分探针逮出：分支顺序 bug——pattern 的 * 与 text 同位 * 被字面消耗，
  // 通配星失效；最小复现 ["*b.\\*","*"] reference=true 沙箱=false）
  ["*", "*"],
  ["*b.\\*", "*"],
  ["a*a", "*"],
  ["*a", "*?*"],
  ["a**b", "a**b"],
  ["**", "*"],
];

const IS_PLAIN_ROWS_RAW = [
  "api",
  "api.tavily.invalid",
  "",
  "sub.domain",
  "domain.",
  ".domain",
  null,
  123,
  undefined,
  true,
];

const DNS_DOMAIN_ROWS_RAW = [
  ["api.tavily.invalid", ".tavily.invalid"],
  ["API.TAVILY.INVALID", ".tavily.invalid"],
  ["api.tavily.invalid", "TAVILY.INVALID"],
  ["api.tavily.invalid", ".other.invalid"],
  ["api.tavily.invalid", "tavily.invalid."],
  ["tavily.invalid", ".tavily.invalid"],
  ["", ".tavily.invalid"],
  ["api.tavily.invalid", ""],
  [null, ".x.invalid"],
  ["api.tavily.invalid", null],
  [undefined, undefined],
  [123, 456],
];

/** 表格行：args... + 最后一位为 reference 实际计算的 expected。 */
const SH_EXP_ROWS = SH_EXP_ROWS_RAW.map(([text, pattern]) => [text, pattern, shExpMatchRef(text, pattern)]);
const IS_PLAIN_ROWS = IS_PLAIN_ROWS_RAW.map((host) => [host, isPlainHostNameRef(host)]);
const DNS_DOMAIN_ROWS = DNS_DOMAIN_ROWS_RAW.map(([host, domain]) => [host, domain, dnsDomainIsRef(host, domain)]);

// ─── 工具 ─────────────────────────────────────────────────────────────────────

/** 打开一个 PAC transport 及其观测面：假 fetch（未声明出站即抛）。 */
function openTransport(mod, entry) {
  assert.equal(
    typeof mod.createEntryTransport,
    "function",
    "src/transport.js 必须导出 createEntryTransport(entry, { fetch })（A4）",
  );
  const fetchFn = createFakeFetch({ default: "never" });
  const transport = mod.createEntryTransport(entry, { fetch: fetchFn });
  assert.equal(typeof transport?.fetch, "function", "createEntryTransport 必须返回 fetch(url, init)（A4）");
  return { fetchFn, transport };
}

function declarePac(fetchFn, script) {
  fetchFn.when(SYNTHETIC_PAC).responds({
    status: 200,
    body: script,
    headers: { "content-type": "application/x-ns-proxy-autoconfig" },
  });
}

/** 捕获一次 transport.fetch 的落定（ok/err），避免 unhandled rejection。 */
async function captureFetch(transport, url = TARGET) {
  try {
    const value = await transport.fetch(url);
    return { state: "ok", value, error: undefined };
  } catch (error) {
    return { state: "err", value: undefined, error };
  }
}

/** 目标请求的路由标记（缺失即红：A4 要求 transport 标注路由）。 */
function routeOf(fetchFn, url = TARGET) {
  const calls = fetchFn.callsFor(url);
  assert.ok(
    calls.length > 0,
    `没有向目标 ${url} 的出站记录（实际出站：${JSON.stringify(fetchFn.calls.map((c) => c.url))}）`,
  );
  const route = calls[0]?.init?.route;
  assert.ok(
    route && typeof route === "object",
    `交给注入 fetch 的 init 必须带 route 路由标记（A4），实际：${JSON.stringify(route)}`,
  );
  return route;
}

/** 表格行 → JS 字面量（undefined 无 JSON 表示，单独处理）。 */
function jsLit(value) {
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

/**
 * 组装「表驱动比对」PAC 脚本：每行 = [args..., expected(末位)]。
 * 全部行与沙箱助手实际结果一致 → DIRECT；任一行失配 → PROXY 1.2.3.4:8080（测试断言 direct 即红）。
 * expected 由测试侧 reference 实现实际计算后内嵌（reference 语义在沙箱内不可用，以数据表兜底）。
 */
function tableScript(rows, callExpr) {
  const rowsLit = rows.map((r) => "[" + r.map(jsLit).join(", ") + "]").join(", ");
  return (
    "var ROWS = [" + rowsLit + "];\n" +
    "function FindProxyForURL(url, host) {\n" +
    "  for (var i = 0; i < ROWS.length; i++) {\n" +
    "    var r = ROWS[i];\n" +
    `    var got = ${callExpr};\n` +
    "    if (got !== ROWS[i][ROWS[i].length - 1]) return \"PROXY " + MISMATCH_PROXY + "\";\n" +
    "  }\n" +
    "  return \"DIRECT\";\n" +
    "}\n"
  );
}

/** 一次 PAC 求值批量跑完一张表；失配（路由变代理）即红，诊断消息附全表（reference expected）。 */
async function runTableCase(t, mod, id, rows, callExpr, label) {
  const script = tableScript(rows, callExpr);
  const entry = C.makeEntry({ id, type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, script);
  fetchFn.when(TARGET).responds({ body: { ok: true } });

  const out = await captureFetch(transport);
  assert.equal(out.state, "ok", `${label}：合法表驱动脚本必须求值成功。实际错误：${out.error?.message ?? "(无)"}`);
  const route = routeOf(fetchFn);
  assert.equal(
    route.kind,
    "direct",
    `${label}：任一行与 reference 实现失配会被路由到 PROXY ${MISMATCH_PROXY}。` +
      `全部 ${rows.length} 行必须逐行一致。失配时对照表（...末位为 reference expected）：${JSON.stringify(rows)}`,
  );
  assert.equal(route.viaPac, true, `${label}：PAC 派生路由须标记 viaPac（R1）`);
}

// ─── P2-1 逃逸回归 6 例 ──────────────────────────────────────────────────────

const ESCAPE_CASES = [
  {
    label: "顶层 helper.constructor",
    script:
      'const P = isPlainHostName.constructor("return process")();' +
      ' if (P) P.__pac_canary="pwned"; function FindProxyForURL(){return "DIRECT";}',
  },
  {
    label: "FindProxyForURL 内 helper.constructor",
    script:
      'function FindProxyForURL(u, h){ const P = isPlainHostName.constructor("return process")();' +
      ' if (P) P.__pac_canary="pwned"; return "DIRECT"; }',
  },
  {
    label: "顶层 this.constructor",
    script:
      'const P = this.constructor("return process")();' +
      ' if (P) P.__pac_canary="pwned"; function FindProxyForURL(){return "DIRECT";}',
  },
  {
    label: "FindProxyForURL 内 FindProxyForURL.constructor",
    script:
      'function FindProxyForURL(u, h){ const P = FindProxyForURL.constructor("return process")();' +
      ' if (P) P.__pac_canary="pwned"; return "DIRECT"; }',
  },
  {
    label: "FindProxyForURL 内 new Function",
    script:
      'function FindProxyForURL(u, h){ const P = new Function("return process")();' +
      ' if (P) P.__pac_canary="pwned"; return "DIRECT"; }',
  },
  {
    label: "FindProxyForURL 内 eval(process)",
    script:
      'function FindProxyForURL(u, h){ const P = eval("process");' +
      ' if (P) P.__pac_canary="pwned"; return "DIRECT"; }',
  },
];

for (const c of ESCAPE_CASES) {
  test(`P2 逃逸回归：${c.label} → PAC_EVAL_FAILED 且宿主 process 零改动`, async (t) => {
    const mod = await load(t);
    if (!mod) return;
    process.__pac_canary = "baseline";
    try {
      const entry = C.makeEntry({ id: "e-pac-escape", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
      const { fetchFn, transport } = openTransport(mod, entry);
      declarePac(fetchFn, c.script);
      fetchFn.when(TARGET).responds({ body: { ok: true } });

      const out = await captureFetch(transport);
      assert.equal(
        out.state,
        "err",
        `${c.label}：逃逸脚本不得成功路由（修复前会以「DIRECT 路由成功 + canary 被写」的形态通过——正是要锁死的行为差异）。实际：${out.state}`,
      );
      assert.ok(out.error instanceof mod.TransportError, `${c.label}：错误必须是 TransportError（带程序码）`);
      assert.equal(
        out.error.code,
        "PAC_EVAL_FAILED",
        `${c.label}：错误码必须为 PAC_EVAL_FAILED（求值阶段失败，三阶段码不变），实际：${JSON.stringify(out.error.code)}`,
      );
      assert.equal(
        process.__pac_canary,
        "baseline",
        `${c.label}：宿主 process.__pac_canary 被 PAC 脚本改写——realm 泄漏`,
      );
    } finally {
      delete process.__pac_canary;
    }
  });
}

// ─── P2-2 沙箱形状钉死 ──────────────────────────────────────────────────────

test("P2 沙箱形状：合法脚本内 process/require/module/Buffer 不可见，三个标准助手可用", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script =
    "function FindProxyForURL(url, host) {" +
    "  var bad = [];" +
    '  if (typeof process !== "undefined") bad.push("process");' +
    '  if (typeof require !== "undefined") bad.push("require");' +
    '  if (typeof module !== "undefined") bad.push("module");' +
    '  if (typeof Buffer !== "undefined") bad.push("Buffer");' +
    '  if (typeof isPlainHostName !== "function") bad.push("isPlainHostName");' +
    '  if (typeof dnsDomainIs !== "function") bad.push("dnsDomainIs");' +
    '  if (typeof shExpMatch !== "function") bad.push("shExpMatch");' +
    `  return bad.length === 0 ? "DIRECT" : "PROXY " + bad.join(".") + ".pac-sandbox-leak.invalid:1";` +
    "}";
  const entry = C.makeEntry({ id: "e-pac-shape", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, script);
  fetchFn.when(TARGET).responds({ body: { ok: true } });

  const out = await captureFetch(transport);
  assert.equal(
    out.state,
    "ok",
    "合法脚本（只见参数与标准助手）必须求值成功。实际错误：" + String(out.error?.message ?? "(无)"),
  );
  assert.equal(routeOf(fetchFn).kind, "direct", "沙箱形状正确时脚本的 DIRECT 生效");
});

test("P2 沙箱形状：缺 FindProxyForURL → 仍 PAC_EVAL_FAILED（三阶段错误码不变）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const entry = C.makeEntry({ id: "e-pac-nofpu", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, "var notAFunction = 1;");
  fetchFn.when(TARGET).responds({ body: { ok: true } });

  const out = await captureFetch(transport);
  assert.equal(out.state, "err", "缺 FindProxyForURL 必须失败");
  assert.ok(out.error instanceof mod.TransportError, "错误必须是 TransportError");
  assert.equal(out.error.code, "PAC_EVAL_FAILED", `缺 FindProxyForURL 的码不得漂移，实际：${JSON.stringify(out.error.code)}`);
  assert.equal(fetchFn.count(TARGET), 0, "未取得路由前不得向供应商出站");
});

// ─── P2-3 等价表（reference 实现逐行比对）────────────────────────────────────

test("P2 shExpMatch 等价表（≥30 行，reference 实现实际计算值逐行比对）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  assert.ok(SH_EXP_ROWS.length >= 30, `shExpMatch 等价表须 ≥30 行，实际 ${SH_EXP_ROWS.length} 行`);
  await runTableCase(t, mod, "e-pac-shexp-table", SH_EXP_ROWS, "shExpMatch(r[0], r[1])", "shExpMatch 等价表");
});

test("P2 isPlainHostName 钉死表（reference 实现实际计算值逐行比对）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  await runTableCase(t, mod, "e-pac-isplain-table", IS_PLAIN_ROWS, "isPlainHostName(r[0])", "isPlainHostName 钉死表");
});

test("P2 dnsDomainIs 钉死表（reference 实现实际计算值逐行比对）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  await runTableCase(t, mod, "e-pac-dnsdomain-table", DNS_DOMAIN_ROWS, "dnsDomainIs(r[0], r[1])", "dnsDomainIs 钉死表");
});

// ─── P2-4 行为保持 ──────────────────────────────────────────────────────────

test("行为保持：shExpMatch 路由返回 PROXY 1.2.7.9:8080 → kind/proxyUrl/viaPac/pacIndex 与既有契约同构", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script =
    "function FindProxyForURL(url, host) {" +
    '  if (shExpMatch(host, "*.tavily.invalid")) return "PROXY ' + BEHAVIOR_PROXY + ', DIRECT";' +
    '  return "DIRECT";' +
    "}";
  const entry = C.makeEntry({ id: "e-pac-behavior", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, script);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const res = await transport.fetch(TARGET);
  assert.equal(res.status, 200, "PAC 路由成功时响应原样交回");
  const route = routeOf(fetchFn);
  assert.equal(route.kind, "proxy", `shExpMatch 命中 PROXY 指令须走代理（R1），实际：${JSON.stringify(route)}`);
  assert.equal(route.proxyUrl, `http://${BEHAVIOR_PROXY}`, `proxyUrl 须为指令的规范化绝对 URL（R2），实际：${route.proxyUrl}`);
  assert.equal(route.viaPac, true, "PAC 派生路由须标记 viaPac（R1）");
  assert.equal(route.pacIndex, 0, `首条指令 pacIndex=0（R3），实际：${route.pacIndex}`);
  assert.equal(fetchFn.count(TARGET), 1, "第一条候选成功即结束，不得换路由重发");
});

test("行为保持：用户脚本顶层重定义 shExpMatch → 用户版本生效（prelude 不覆盖用户脚本）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script =
    "function shExpMatch() { return true; }" +
    "function FindProxyForURL(url, host) {" +
    '  if (shExpMatch("whatever", "nonsense-never-matches")) return "PROXY ' + BEHAVIOR_PROXY + '";' +
    '  return "DIRECT";' +
    "}";
  const entry = C.makeEntry({ id: "e-pac-redefine", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, script);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const out = await captureFetch(transport);
  assert.equal(out.state, "ok", "重定义助手的合法脚本必须求值成功。实际错误：" + String(out.error?.message ?? "(无)"));
  const route = routeOf(fetchFn);
  assert.equal(route.kind, "proxy", "用户版 shExpMatch 恒 true 时必须走 PROXY 分支（用户版本生效）");
  assert.equal(route.proxyUrl, `http://${BEHAVIOR_PROXY}`, `用户版本生效时 proxyUrl 须为 ${BEHAVIOR_PROXY}`);
  assert.equal(route.viaPac, true);
  assert.equal(route.pacIndex, 0);
});

test("行为保持：同一 transport 两次 fetch → SYNTHETIC_PAC 只下载一次（缓存不变）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script =
    "function FindProxyForURL(url, host) {" +
    '  return shExpMatch(host, "*.invalid") ? "DIRECT" : "DIRECT";' +
    "}";
  const entry = C.makeEntry({ id: "e-pac-oncedl", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, script);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  await transport.fetch(TARGET);
  await transport.fetch(TARGET);
  assert.equal(fetchFn.count(SYNTHETIC_PAC), 1, `PAC 脚本每 transport 只下载一次，实际 ${fetchFn.count(SYNTHETIC_PAC)} 次`);
  assert.equal(fetchFn.count(TARGET), 2, "两次目标请求都须出站");
  assert.equal(routeOf(fetchFn).kind, "direct", "脚本 DIRECT 生效");
});

// ─── P2-5 长文本与栈深度（codex P2-2 跟进：递归 matcher 栈溢出回归）──────────────
// 需求来源：codex 在 54b0f66 上复现——shExpMatch 的 memo 递归每字符消耗一层栈帧，
// 10,000 字符路径即 PAC_EVAL_FAILED（8,000 字符尚可）；src/backends/bing.js 把用户查询
// 直接拼进请求 URL 且无长度上限（百分号编码还放大长度），被接受的长查询会因 PAC 匹配
// 栈溢出而路由失败。旧 RegExp 实现无此问题，属修复引入的可用性回归。
// 长串在沙箱内用 String.repeat 运行时生成（PAC 脚本本体很小，不触下载尺寸上限）。

const LONG_URL_LENS = [10_000, 50_000, 200_000];

for (const len of LONG_URL_LENS) {
  test(`P2 长 URL：shExpMatch("https://example.org/"+${len} 字符, "https://example.org/*") → 求值成功且路由 DIRECT`, async (t) => {
    const mod = await load(t);
    if (!mod) return;
    const script =
      "function FindProxyForURL(url, host) {" +
      `  return shExpMatch("https://example.org/" + "a".repeat(${len}), "https://example.org/*")` +
      `    ? "DIRECT" : "PROXY ${MISMATCH_PROXY}";` +
      "}";
    const entry = C.makeEntry({ id: `e-pac-long-${len}`, type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const { fetchFn, transport } = openTransport(mod, entry);
    declarePac(fetchFn, script);
    fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

    const out = await captureFetch(transport);
    assert.equal(
      out.state,
      "ok",
      `${len} 字符路径必须匹配成功（单星线性，须远在 500ms CPU 护栏内完成；修复前会因沙箱栈溢出落 PAC_EVAL_FAILED）。实际错误：${String(out.error?.message ?? "(无)")}`,
    );
    assert.equal(routeOf(fetchFn).kind, "direct", `${len} 字符路径匹配命中时 DIRECT 生效`);
  });
}

test("P2 深度钉死：pattern *.repeat(200000)+'z' vs text 'y'.repeat(200000) → 求值完成（无栈溢出）且失配走 DIRECT", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script =
    "function FindProxyForURL(url, host) {" +
    `  return shExpMatch("y".repeat(200000), "*".repeat(200000) + "z")` +
    `    ? "PROXY ${MISMATCH_PROXY}" : "DIRECT";` +
    "}";
  const entry = C.makeEntry({ id: "e-pac-deep", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, script);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const out = await captureFetch(transport);
  assert.equal(
    out.state,
    "ok",
    "200k 星 pattern 必须求值完成（迭代式 O(1) 栈深度；修复前 RangeError 落 PAC_EVAL_FAILED）。实际错误：" + String(out.error?.message ?? "(无)"),
  );
  assert.equal(routeOf(fetchFn).kind, "direct", "失配结果须正常走 DIRECT 分支（不是异常）");
});

// ─── P2-6 漏网回归：LCG 种子固定伪随机差分（入仓永久）────────────────────────
// 需求来源：第三轮工单——第二轮仓外 v2 模糊（双侧星频 1/24 偏低）漏网分支顺序 bug
// （pattern 的 * 与 text 同位 * 被字面消耗）。本用例种子与字母表写死在仓内，
// 双侧高星频使对齐 * 高频出现：LCG seed=(seed*1103515245+12345)&0x7fffffff 起手 20261127
// （BigInt 保真 31 位算术），字母表 14 字符（* 占 1/14），text/pattern 各 0–8 字符，
// 生成 3000 行，expected 运行时由内联 reference（正则版 shExpMatchRef）实算，
// 走既有批驱动表机制（一次 PAC 求值跑完全表，任一行失配即红）。

const LCG_ALPHABET = ["a", "b", "*", "?", "\n", "\r", "\u2028", "\u2029", "A", "B", ".", "[", "x", "\\", "😀"];

function makeLcgRng(seed) {
  let s = BigInt(seed);
  return () => {
    s = (s * 1103515245n + 12345n) & 0x7fffffffn;
    return Number(s) / 0x80000000; // [0, 1)
  };
}

const LCG_ROWS = (() => {
  const lcg = makeLcgRng(20261127);
  const build = (len) => {
    let s = "";
    for (let k = 0; k < len; k++) s += LCG_ALPHABET[Math.floor(lcg() * LCG_ALPHABET.length)];
    return s;
  };
  const rows = [];
  for (let i = 0; i < 3000; i++) {
    const text = build(Math.floor(lcg() * 9)); // 0–8 字符
    const pattern = build(Math.floor(lcg() * 9));
    rows.push([text, pattern, shExpMatchRef(text, pattern)]);
  }
  return rows;
})();

test("P2 漏网回归：LCG 种子固定 3000 行伪随机差分（对齐星高频，内联 reference 运行时实算）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  assert.equal(LCG_ROWS.length, 3000, "LCG 表必须恰 3000 行（种子 20261127，种子固定）");
  await runTableCase(t, mod, "e-pac-lcg3000", LCG_ROWS, "shExpMatch(r[0], r[1])", "LCG 3000 行伪随机差分");
});

// ─── T4 安全复审 P2：消除 user script 之后的全部宿主侧 context 访问 ─────────────

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function runPacInSubprocess(script) {
  const childCode = [
    'import { createEntryTransport, TransportError } from "./src/transport.js";',
    'import { createFakeFetch, SYNTHETIC_PAC } from "./test/helpers/fake-fetch.js";',
    'import * as C from "./test/helpers/contract.js";',
    'const target = "https://api.tavily.invalid/pac-sandbox?q=synthetic";',
    'const fetchFn = createFakeFetch({ default: "never" });',
    'const entry = C.makeEntry({ id: "e-pac-subproc", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });',
    'const transport = createEntryTransport(entry, { fetch: fetchFn });',
    `fetchFn.when(SYNTHETIC_PAC).responds({ status: 200, body: ${JSON.stringify(script)}, headers: { "content-type": "application/x-ns-proxy-autoconfig" } });`,
    'fetchFn.when(target).responds({ status: 200, body: { ok: true } });',
    'try {',
    '  await transport.fetch(target);',
    '  const route = fetchFn.callsFor(target)[0]?.init?.route;',
    '  console.log("RESULT:" + (route?.kind ?? "unknown"));',
    '} catch (err) {',
    '  const code = err instanceof TransportError ? err.code : (err?.name ?? "Error") + ":" + (err?.message ?? "");',
    '  console.log("RESULT:" + code);',
    '}',
  ].join("\n");
  const startedAt = Date.now();
  const stdout = execFileSync(process.execPath, ["-e", childCode], {
    cwd: REPO_ROOT,
    timeout: 4000,
    encoding: "utf8",
  });
  return { stdout: stdout.trim(), elapsedMs: Date.now() - startedAt };
}

test("T4-1 FindProxyForURL 死循环 getter → 子进程不冻结，500ms 护栏内落定 PAC_EVAL_FAILED", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script = 'Object.defineProperty(this, "FindProxyForURL", { get() { while (true) {} } });';
  const res = runPacInSubprocess(script);
  assert.equal(res.stdout, "RESULT:PAC_EVAL_FAILED", `FindProxyForURL 死循环 getter 应落定 PAC_EVAL_FAILED，实际：${res.stdout}`);
  assert.ok(res.elapsedMs < 4000, `子进程应在硬超时 4000ms 内完成，实际 ${res.elapsedMs}ms`);
});

test("T4-2 __pacUrl 死循环 setter（get 正常返回）+ 正常 FindProxyForURL → setter 不被宿主触发，DIRECT 路由成功", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script =
    `Object.defineProperty(this, "__pacUrl", { get() { return ${JSON.stringify(TARGET)}; }, set() { while (true) {} } }); ` +
    'function FindProxyForURL(u, h) { return "DIRECT"; }';
  const res = runPacInSubprocess(script);
  assert.equal(res.stdout, "RESULT:direct", `__pacUrl setter 不得被宿主触发，DIRECT 应路由成功，实际：${res.stdout}`);
  assert.ok(res.elapsedMs < 4000, `子进程应在硬超时 4000ms 内完成，实际 ${res.elapsedMs}ms`);
});

test("T4-3 __pacHost 死循环 getter → 计时 vm 脚本内读触发超时并落定 PAC_EVAL_FAILED", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script =
    'Object.defineProperty(this, "__pacHost", { get() { while (true) {} } }); ' +
    'function FindProxyForURL(u, h) { return "DIRECT"; }';
  const res = runPacInSubprocess(script);
  assert.equal(res.stdout, "RESULT:PAC_EVAL_FAILED", `__pacHost 死循环 getter 应触发 vm 超时并落定 PAC_EVAL_FAILED，实际：${res.stdout}`);
  assert.ok(res.elapsedMs < 4000, `子进程应在硬超时 4000ms 内完成，实际 ${res.elapsedMs}ms`);
});

test("T4-4 恶意返回值伪哨兵：\"N\" / \"T\" / \"S1.2.3.4:8080\" 仍按指令文本解析（PAC_ROUTE_FAILED，零归因漂移）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  for (const ret of ["N", "T", "S1.2.3.4:8080"]) {
    const entry = C.makeEntry({ id: `e-pac-sentinel-${ret}`, type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const { fetchFn, transport } = openTransport(mod, entry);
    declarePac(fetchFn, `function FindProxyForURL(u, h) { return ${JSON.stringify(ret)}; }`);
    fetchFn.when(TARGET).responds({ body: { ok: true } });

    const out = await captureFetch(transport);
    assert.equal(out.state, "err", `伪哨兵返回值 ${JSON.stringify(ret)} 必须按不支持指令失败`);
    assert.ok(out.error instanceof mod.TransportError, `伪哨兵返回值 ${JSON.stringify(ret)} 错误必须是 TransportError`);
    assert.equal(
      out.error.code,
      "PAC_ROUTE_FAILED",
      `伪哨兵返回值 ${JSON.stringify(ret)} 错误码必须保持 PAC_ROUTE_FAILED，实际：${JSON.stringify(out.error.code)}`,
    );
    assert.equal(
      out.error.message,
      "PAC 脚本未给出可用路由（无受支持的指令）",
      `伪哨兵返回值 ${JSON.stringify(ret)} 错误消息不得漂移`,
    );
    assert.equal(fetchFn.count(TARGET), 0, "无可用路由时不得向目标出站");
  }
});

// ─── T5 工单 5（P1·受支持运行时超时绕过）：PAC 求值移入可终止子进程边界 ──────

const PAC_WORKER_FILE = fileURLToPath(new URL("../src/pac-eval-worker.js", import.meta.url));

test("T5-1 FindProxyForURL 死循环 getter → PAC_EVAL_FAILED 且子进程 harness 正常落定（版本依赖：node26 本就绿，产品运行时修前挂死）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script = 'Object.defineProperty(this, "FindProxyForURL", { get() { while (true) {} } });';
  const res = runPacInSubprocess(script);
  assert.equal(res.stdout, "RESULT:PAC_EVAL_FAILED", `FindProxyForURL 死循环 getter 应落定 PAC_EVAL_FAILED，实际：${res.stdout}`);
  assert.ok(res.elapsedMs < 4000, `子进程应在硬超时 4000ms 内完成，实际 ${res.elapsedMs}ms`);
});

test("T5-2 codex 原样复现 __pacHost 死循环 getter + 正常 FindProxyForURL → PAC_EVAL_FAILED（双运行时均绿）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script =
    'Object.defineProperty(this,"__pacHost",{get(){while(true){}}})\n' +
    'function FindProxyForURL(u,h){return "DIRECT";}';
  const res = runPacInSubprocess(script);
  assert.equal(res.stdout, "RESULT:PAC_EVAL_FAILED", `__pacHost 死循环 getter 应落定 PAC_EVAL_FAILED，实际：${res.stdout}`);
  assert.ok(res.elapsedMs < 4000, `子进程应在硬超时 4000ms 内完成，实际 ${res.elapsedMs}ms`);
});

test("T5-3 顶层 while(1) 用户脚本 → PAC_EVAL_FAILED（子内 vm 护栏快路径）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script = 'while (1) {} function FindProxyForURL() { return "DIRECT"; }';
  const res = runPacInSubprocess(script);
  assert.equal(res.stdout, "RESULT:PAC_EVAL_FAILED", `顶层死循环应落定 PAC_EVAL_FAILED，实际：${res.stdout}`);
  assert.ok(res.elapsedMs < 2000, `顶层死循环应走子内 500ms vm 护栏快路径（远小于 2000ms wall 上限），实际 ${res.elapsedMs}ms`);
});

test("T5-4 worker 自救：直接 spawn worker 文件（ipc）不发任务直接 disconnect → 子进程 1s 内 exit", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const startedAt = Date.now();
  const child = spawn(process.execPath, [PAC_WORKER_FILE], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
  const res = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("worker 未在 1000ms 内响应 disconnect 退出"));
    }, 1000);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, elapsedMs: Date.now() - startedAt });
    });
    child.disconnect();
  });
  assert.equal(res.code, 0, `worker 收到 disconnect 后应以 exit code 0 自救退出，实际 code=${res.code} signal=${res.signal}`);
  assert.ok(res.elapsedMs < 1000, `worker 自救退出应在 1000ms 内完成，实际 ${res.elapsedMs}ms`);
});

test("T5-5 结果缓存：deps.spawnProcess 计数，同 transport 同 URL 两次 fetch 只 spawn 一次且 PAC 只下载一次", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  let spawnCount = 0;
  const countingSpawn = (...args) => {
    spawnCount += 1;
    return spawn(...args);
  };
  const fetchFn = createFakeFetch({ default: "never" });
  const entry = C.makeEntry({ id: "e-pac-result-cache", type: "openai", proxy: { pac: SYNTHETIC_PAC } });
  const transport = mod.createEntryTransport(entry, { fetch: fetchFn, spawnProcess: countingSpawn });
  declarePac(fetchFn, `function FindProxyForURL(u, h) { return "PROXY ${BEHAVIOR_PROXY}"; }`);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  await transport.fetch(TARGET);
  await transport.fetch(TARGET);

  assert.equal(spawnCount, 1, `同 transport 同 URL 两次 fetch 应命中结果缓存，evaluatePac 只 spawn 1 次，实际 ${spawnCount} 次`);
  assert.equal(fetchFn.count(SYNTHETIC_PAC), 1, `SYNTHETIC_PAC 仍只下载 1 次，实际 ${fetchFn.count(SYNTHETIC_PAC)} 次`);
  assert.equal(fetchFn.count(TARGET), 2, "两次目标请求都须正常出站");
  const routes = fetchFn.callsFor(TARGET).map((c) => c.init?.route);
  assert.deepEqual(routes[1], routes[0], "两次请求解析出的路由指令必须完全一致");
  assert.equal(routes[0].proxyUrl, `http://${BEHAVIOR_PROXY}`);
});

test("T5-6 求值中 closeAll() → 在飞 promise 以运行出错落定、子进程退出、无悬挂", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  let onSpawned;
  const spawnedReady = new Promise((resolve) => {
    onSpawned = resolve;
  });
  const spySpawn = (...args) => {
    const child = spawn(...args);
    onSpawned(child);
    return child;
  };
  const fetchFn = createFakeFetch({ default: "never" });
  const entry = C.makeEntry({ id: "e-pac-closeall-inflight", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const transport = mod.createEntryTransport(entry, { fetch: fetchFn, spawnProcess: spySpawn });
  declarePac(fetchFn, 'Object.defineProperty(this, "FindProxyForURL", { get() { while (true) {} } });');
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const startedAt = Date.now();
  const fetchPromise = captureFetch(transport);
  const child = await spawnedReady;
  const childExited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  transport.closeAll();

  const [out, exitInfo] = await Promise.all([fetchPromise, childExited]);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(out.state, "err", "closeAll() 后在飞 PAC 求值 promise 必须以错误落定");
  assert.ok(out.error instanceof mod.TransportError, "错误必须是 TransportError");
  assert.equal(out.error.code, "PAC_EVAL_FAILED", `错误码必须为 PAC_EVAL_FAILED，实际：${out.error.code}`);
  assert.equal(
    out.error.message,
    "PAC 脚本求值失败（FindProxyForURL 运行出错）",
    `错误消息必须为运行出错归因，实际：${out.error.message}`,
  );
  assert.ok(elapsedMs < 1500, `closeAll() 应立即强杀子进程而非等 2000ms 超时，实际 ${elapsedMs}ms`);
  assert.ok(
    exitInfo.signal === "SIGKILL" || exitInfo.signal === "SIGTERM" || exitInfo.code !== null,
    `子进程必须已退出，实际：${JSON.stringify(exitInfo)}`,
  );
  assert.equal(fetchFn.count(TARGET), 0, "closeAll() 中止后不得向目标出站");
});

// ─── T6 工单 6（安全复审 P2·全局代理逃逸）：沙箱密封 seal + 逐次求值 canary ──────

const EVIL_HIJACK_PROXY = "9.9.9.9:8080";

test("T6-1 全局代理 constructor 链逃逸（try/catch 形态）→ 不得劫持至 9.9.9.9，落定 DIRECT", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script =
    'function FindProxyForURL(u,h){try{var P=this.constructor.constructor("return process")();' +
    `return (P&&P.versions)?"PROXY ${EVIL_HIJACK_PROXY}":"DIRECT";}catch(e){return "DIRECT";}}`;
  const entry = C.makeEntry({ id: "e-pac-t6-ctor", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, script);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const out = await captureFetch(transport);
  assert.equal(out.state, "ok", `try/catch 逃逸脚本捕获 EvalError 后应回退 DIRECT，实际错误：${out.error?.message ?? "(无)"}`);
  const route = routeOf(fetchFn);
  assert.equal(route.kind, "direct", `全局代理 constructor 链不得逃逸劫持流量，实际路由：${JSON.stringify(route)}`);
  assert.notEqual(route.proxyUrl, `http://${EVIL_HIJACK_PROXY}`, `不得出现 ${EVIL_HIJACK_PROXY} 代理路由`);
});

for (const method of ["toString", "valueOf", "hasOwnProperty", "propertyIsEnumerable"]) {
  test(`T6-2 全局代理继承方法 ${method} 链逃逸（try/catch 形态）→ 不得劫持至 9.9.9.9，落定 DIRECT`, async (t) => {
    const mod = await load(t);
    if (!mod) return;
    const script =
      `function FindProxyForURL(u,h){try{var P=this.${method}.constructor("return process")();` +
      `return (P&&P.versions)?"PROXY ${EVIL_HIJACK_PROXY}":"DIRECT";}catch(e){return "DIRECT";}}`;
    const entry = C.makeEntry({ id: `e-pac-t6-${method}`, type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const { fetchFn, transport } = openTransport(mod, entry);
    declarePac(fetchFn, script);
    fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

    const out = await captureFetch(transport);
    assert.equal(out.state, "ok", `try/catch ${method} 链捕获 EvalError 后应回退 DIRECT，实际错误：${out.error?.message ?? "(无)"}`);
    const route = routeOf(fetchFn);
    assert.equal(route.kind, "direct", `全局代理 ${method} 链不得逃逸劫持流量，实际路由：${JSON.stringify(route)}`);
    assert.notEqual(route.proxyUrl, `http://${EVIL_HIJACK_PROXY}`, `不得出现 ${EVIL_HIJACK_PROXY} 代理路由`);
  });
}

test("T6-3 裸标识符 constructor(\"return process\")() 与 constructor.constructor(\"return process\")() 逃逸（try/catch 形态）→ 不得劫持至 9.9.9.9，落定 DIRECT", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  for (const [tag, expr] of [
    ["bare-call", 'constructor("return process")()'],
    ["bare-chain", 'constructor.constructor("return process")()'],
  ]) {
    const script =
      `function FindProxyForURL(u,h){try{var P=${expr};` +
      `return (P&&P.versions)?"PROXY ${EVIL_HIJACK_PROXY}":"DIRECT";}catch(e){return "DIRECT";}}`;
    const entry = C.makeEntry({ id: `e-pac-t6-${tag}`, type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const { fetchFn, transport } = openTransport(mod, entry);
    declarePac(fetchFn, script);
    fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

    const out = await captureFetch(transport);
    assert.equal(out.state, "ok", `try/catch 裸 ${tag} 捕获异常后应回退 DIRECT，实际错误：${out.error?.message ?? "(无)"}`);
    const route = routeOf(fetchFn);
    assert.equal(route.kind, "direct", `裸标识符 ${tag} 不得逃逸劫持流量，实际路由：${JSON.stringify(route)}`);
    assert.notEqual(route.proxyUrl, `http://${EVIL_HIJACK_PROXY}`, `不得出现 ${EVIL_HIJACK_PROXY} 代理路由`);
  }
});

test("T6-4 行为保持（密封后）：合法 PAC 路由同构且用户顶层重定义 shExpMatch 仍生效", async (t) => {
  const mod = await load(t);
  if (!mod) return;

  // 1) 合法 PAC（含标准助手）路由与既有契约同构
  {
    const script =
      "function FindProxyForURL(url, host) {" +
      '  if (!isPlainHostName(host) && dnsDomainIs(host, ".tavily.invalid") && shExpMatch(host, "*.tavily.invalid")) {' +
      `    return "PROXY ${BEHAVIOR_PROXY}, DIRECT";` +
      "  }" +
      '  return "DIRECT";' +
      "}";
    const entry = C.makeEntry({ id: "e-pac-t6-keep-legal", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const { fetchFn, transport } = openTransport(mod, entry);
    declarePac(fetchFn, script);
    fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

    const out = await captureFetch(transport);
    assert.equal(out.state, "ok", `合法 PAC 必须求值成功，实际错误：${out.error?.message ?? "(无)"}`);
    const route = routeOf(fetchFn);
    assert.equal(route.kind, "proxy");
    assert.equal(route.proxyUrl, `http://${BEHAVIOR_PROXY}`);
    assert.equal(route.viaPac, true);
    assert.equal(route.pacIndex, 0);
  }

  // 2) 用户顶层重定义 shExpMatch 不受密封影响且用户版本生效
  {
    const script =
      "function shExpMatch() { return true; }" +
      "function FindProxyForURL(url, host) {" +
      `  return shExpMatch("x", "never-match") ? "PROXY ${BEHAVIOR_PROXY}" : "DIRECT";` +
      "}";
    const entry = C.makeEntry({ id: "e-pac-t6-keep-redef", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const { fetchFn, transport } = openTransport(mod, entry);
    declarePac(fetchFn, script);
    fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

    const out = await captureFetch(transport);
    assert.equal(out.state, "ok", `重定义 shExpMatch 必须求值成功，实际错误：${out.error?.message ?? "(无)"}`);
    const route = routeOf(fetchFn);
    assert.equal(route.kind, "proxy");
    assert.equal(route.proxyUrl, `http://${BEHAVIOR_PROXY}`);
    assert.equal(route.viaPac, true);
    assert.equal(route.pacIndex, 0);
  }
});

test("T6-5 密封不可解除：defineProperty / delete / 赋值均无效，且 this.toString 仍等于沙箱 Object.prototype.toString", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script =
    "function FindProxyForURL(u, h) {" +
    "  var dpThrew = false;" +
    '  try { Object.defineProperty(this, "toString", { value: function () { return "hijacked"; } }); } catch (e) { dpThrew = true; }' +
    "  var delOk = false;" +
    "  try { delOk = delete this.toString; } catch (e) { delOk = false; }" +
    "  try { this.constructor = 1; } catch (e) {}" +
    "  var evalBlocked = false;" +
    '  try { this.toString.constructor("return process")(); } catch (e) { evalBlocked = (e instanceof EvalError); }' +
    "  if (!dpThrew || delOk || this.constructor !== Object || this.toString !== Object.prototype.toString || typeof this.toString !== \"function\" || !evalBlocked) {" +
    `    return "PROXY ${MISMATCH_PROXY}";` +
    "  }" +
    '  return "DIRECT";' +
    "}";
  const entry = C.makeEntry({ id: "e-pac-t6-immutable", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, script);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const out = await captureFetch(transport);
  assert.equal(out.state, "ok", `密封不可解除验证脚本必须正常求值，实际错误：${out.error?.message ?? "(无)"}`);
  const route = routeOf(fetchFn);
  assert.equal(
    route.kind,
    "direct",
    `密封必须不可解除（defineProperty 抛错、delete 无效、赋值无效、this.toString===Object.prototype.toString 且触发 EvalError），实际路由：${JSON.stringify(route)}`,
  );
});

// ─── T8 工单 8（安全复审 P2·指令无界缓存）：worker 侧指令长度闸 + 缓存改存已解析路由 ──────

test("T8-1 超长指令：PAC 返回 200k 字符指令 → TransportError code=PAC_ROUTE_FAILED", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script = 'function FindProxyForURL(u, h) { return "DIRECT;" + "X".repeat(200000); }';
  const entry = C.makeEntry({ id: "e-pac-t8-toolong", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, script);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const out = await captureFetch(transport);
  assert.equal(out.state, "err", "超长 PAC 返回指令必须被拒绝（不得经 IPC 放大内存）");
  assert.ok(out.error instanceof mod.TransportError, "错误必须是 TransportError");
  assert.equal(
    out.error.code,
    C.CONFIG_CODES.PAC_ROUTE_FAILED,
    `超长指令错误码必须为 PAC_ROUTE_FAILED，实际：${JSON.stringify(out.error.code)}`,
  );
  assert.equal(out.error.message, "PAC 脚本返回值超过长度上限", `错误消息须明确超限原因，实际：${out.error.message}`);
  assert.equal(fetchFn.count(TARGET), 0, "指令被拒绝后不得向目标出站");
});

test("T8-2 边界（接受）：恰 4096 字符的合法指令（DIRECT 填充至 4096）→ 求值成功且路由 direct", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const directive = "DIRECT" + " ".repeat(4096 - 6);
  assert.equal(directive.length, 4096, "前置检查：指令长度须恰为 4096");
  const script = `function FindProxyForURL(u, h) { return ${JSON.stringify(directive)}; }`;
  const entry = C.makeEntry({ id: "e-pac-t8-4096", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, script);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const out = await captureFetch(transport);
  assert.equal(out.state, "ok", `恰 4096 字符合法指令必须被接受，实际错误：${out.error?.message ?? "(无)"}`);
  const route = routeOf(fetchFn);
  assert.equal(route.kind, "direct", "恰 4096 字符 DIRECT 填充指令应路由到 direct");
  assert.equal(route.viaPac, true);
  assert.equal(route.pacIndex, 0);
});

test("T8-2 边界（拒绝）：4097 字符指令（DIRECT 填充至 4097）→ TransportError code=PAC_ROUTE_FAILED", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const directive = "DIRECT" + " ".repeat(4097 - 6);
  assert.equal(directive.length, 4097, "前置检查：指令长度须恰为 4097");
  const script = `function FindProxyForURL(u, h) { return ${JSON.stringify(directive)}; }`;
  const entry = C.makeEntry({ id: "e-pac-t8-4097", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, script);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const out = await captureFetch(transport);
  assert.equal(out.state, "err", "4097 字符指令（超过 4096 上限）必须被拒绝");
  assert.ok(out.error instanceof mod.TransportError, "错误必须是 TransportError");
  assert.equal(
    out.error.code,
    C.CONFIG_CODES.PAC_ROUTE_FAILED,
    `4097 字符超限错误码必须为 PAC_ROUTE_FAILED，实际：${JSON.stringify(out.error.code)}`,
  );
  assert.equal(out.error.message, "PAC 脚本返回值超过长度上限", `错误消息须明确超限原因，实际：${out.error.message}`);
  assert.equal(fetchFn.count(TARGET), 0, "指令被拒绝后不得向目标出站");
});

test("T8-3 缓存存解析结果：同 URL 两次 fetch 只 spawn 一次 worker 且第二次 route 与首次一致", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  let spawnCount = 0;
  const countingSpawn = (...args) => {
    spawnCount += 1;
    return spawn(...args);
  };
  const fetchFn = createFakeFetch({ default: "never" });
  const entry = C.makeEntry({ id: "e-pac-t8-cache-route", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const transport = mod.createEntryTransport(entry, { fetch: fetchFn, spawnProcess: countingSpawn });
  declarePac(fetchFn, `function FindProxyForURL(u, h) { return "PROXY ${BEHAVIOR_PROXY}; DIRECT"; }`);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  await transport.fetch(TARGET);
  await transport.fetch(TARGET);

  assert.equal(spawnCount, 1, `同 URL 两次 fetch 应命中缓存只 spawn 1 次 worker，实际 ${spawnCount} 次`);
  assert.equal(fetchFn.count(SYNTHETIC_PAC), 1, `SYNTHETIC_PAC 仍只下载 1 次，实际 ${fetchFn.count(SYNTHETIC_PAC)} 次`);
  assert.equal(fetchFn.count(TARGET), 2, "两次目标请求都须出站");
  const routes = fetchFn.callsFor(TARGET).map((c) => c.init?.route);
  assert.deepEqual(routes[1], routes[0], "缓存命中的第二次路由对象必须与首次解析结果完全一致");
  assert.equal(routes[0].kind, "proxy");
  assert.equal(routes[0].proxyUrl, `http://${BEHAVIOR_PROXY}`);
  assert.equal(routes[0].viaPac, true);
  assert.equal(routes[0].pacIndex, 0);
});

// ─── T9 工单 9（安全复审 P2·__proto__ 双跳逃逸）：__proto__ 自有数据属性遮蔽 + 双跳探针 ──────

test('T9-1 globalThis.__proto__.constructor.constructor("return process")() 逃逸（try/catch 形态）→ 不得劫持至 9.9.9.9，落定 DIRECT', async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script =
    'function FindProxyForURL(u,h){try{var P=globalThis.__proto__.constructor.constructor("return process")();' +
    `return (P&&P.versions)?"PROXY ${EVIL_HIJACK_PROXY}":"DIRECT";}catch(e){return "DIRECT";}}`;
  const entry = C.makeEntry({ id: "e-pac-t9-globalthis-proto", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, script);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const out = await captureFetch(transport);
  assert.equal(out.state, "ok", `try/catch 逃逸脚本捕获 EvalError 后应回退 DIRECT，实际错误：${out.error?.message ?? "(无)"}`);
  const route = routeOf(fetchFn);
  assert.equal(route.kind, "direct", `globalThis.__proto__ 双跳不得逃逸劫持流量，实际路由：${JSON.stringify(route)}`);
  assert.notEqual(route.proxyUrl, `http://${EVIL_HIJACK_PROXY}`, `不得出现 ${EVIL_HIJACK_PROXY} 代理路由`);
});

test('T9-2 this.__proto__.constructor.constructor("return process")() 逃逸（try/catch 形态）→ 不得劫持至 9.9.9.9，落定 DIRECT', async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script =
    'function FindProxyForURL(u,h){try{var P=this.__proto__.constructor.constructor("return process")();' +
    `return (P&&P.versions)?"PROXY ${EVIL_HIJACK_PROXY}":"DIRECT";}catch(e){return "DIRECT";}}`;
  const entry = C.makeEntry({ id: "e-pac-t9-this-proto", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, script);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const out = await captureFetch(transport);
  assert.equal(out.state, "ok", `try/catch 逃逸脚本捕获 EvalError 后应回退 DIRECT，实际错误：${out.error?.message ?? "(无)"}`);
  const route = routeOf(fetchFn);
  assert.equal(route.kind, "direct", `this.__proto__ 双跳不得逃逸劫持流量，实际路由：${JSON.stringify(route)}`);
  assert.notEqual(route.proxyUrl, `http://${EVIL_HIJACK_PROXY}`, `不得出现 ${EVIL_HIJACK_PROXY} 代理路由`);
});

test("T9-3 语义回归钉：({}).__proto__ === Object.prototype 与 Object.prototype.hasOwnProperty.call 等常规用法照常", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script =
    "function FindProxyForURL(u, h) {" +
    "  var failed = [];" +
    '  if (({}).__proto__ !== Object.prototype) failed.push("obj-proto");' +
    '  if (Object.prototype.hasOwnProperty.call({}, "toString") !== false) failed.push("hasown-tostring");' +
    '  if (Object.prototype.hasOwnProperty.call({ ok: 1 }, "ok") !== true) failed.push("hasown-ok");' +
    '  if (Object.prototype.toString.call({}) !== "[object Object]") failed.push("tostring-call");' +
    '  var sub = {}; sub.__proto__ = { inherited: 42 }; if (sub.inherited !== 42) failed.push("sub-proto-set");' +
    '  if (globalThis.__proto__ !== Object.prototype || this.__proto__ !== Object.prototype) failed.push("global-proto-realm");' +
    `  return failed.length === 0 ? "DIRECT" : "PROXY " + failed.join("-") + ".${LEAK_HOST}";` +
    "}";
  const entry = C.makeEntry({ id: "e-pac-t9-semantic", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, script);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const out = await captureFetch(transport);
  assert.equal(out.state, "ok", `合法语义回归脚本必须求值成功，实际错误：${out.error?.message ?? "(无)"}`);
  const route = routeOf(fetchFn);
  assert.equal(
    route.kind,
    "direct",
    `普通对象 __proto__ 与 Object.prototype 常规用法须全部保持正常，实际路由：${JSON.stringify(route)}`,
  );
});

const T9_CHAIN_PROBES = [
  ["globalthis-proto", "globalThis.__proto__双跳", 'globalThis.__proto__.constructor.constructor("return process")()'],
  ["this-proto", "this.__proto__双跳", 'this.__proto__.constructor.constructor("return process")()'],
  ["gop-globalthis", "gOP(globalThis)双跳", 'Object.getPrototypeOf(globalThis).constructor.constructor("return process")()'],
  ["reflect-gop", "Reflect.getPrototypeOf 双跳", 'Reflect.getPrototypeOf(globalThis).constructor.constructor("return process")()'],
  ["gop-3hop", "gOP 三跳", 'Object.getPrototypeOf(Object.getPrototypeOf(globalThis)).constructor.constructor("return process")()'],
  ["obj-proto", "({}).__proto__ 双跳", '({}).__proto__.constructor.constructor("return process")()'],
  ["gop-math", "gOP(Math)双跳", 'Object.getPrototypeOf(Math).constructor.constructor("return process")()'],
  ["gop-object", "gOP(Object)双跳", 'Object.getPrototypeOf(Object).constructor.constructor("return process")()'],
  ["gop-json", "gOP(JSON)双跳", 'Object.getPrototypeOf(JSON).constructor.constructor("return process")()'],
  [
    "desc-value",
    "descriptor.value 双跳",
    'Object.getOwnPropertyDescriptor(globalThis, "toString").value.constructor.constructor("return process")()',
  ],
  [
    "desc-proto-value",
    "descriptor.__proto__.value 双跳",
    'Object.getOwnPropertyDescriptor(globalThis.__proto__, "toString").value.constructor.constructor("return process")()',
  ],
];

test("T9-4 链闭包回归钉：11 条原型/描述符双跳与三跳逃逸链逐一过真实传输层 → 全部拦截，落定 DIRECT 且无 9.9.9.9 路由", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  for (const [tag, label, expr] of T9_CHAIN_PROBES) {
    const script =
      `function FindProxyForURL(u,h){try{var P=${expr};` +
      `return (P&&P.versions)?"PROXY ${EVIL_HIJACK_PROXY}":"DIRECT";}catch(e){return "DIRECT";}}`;
    const entry = C.makeEntry({ id: `e-pac-t9-4-${tag}`, type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const { fetchFn, transport } = openTransport(mod, entry);
    declarePac(fetchFn, script);
    fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

    const out = await captureFetch(transport);
    assert.equal(out.state, "ok", `${label}：try/catch 逃逸链捕获异常后应回退 DIRECT，实际错误：${out.error?.message ?? "(无)"}`);
    const route = routeOf(fetchFn);
    assert.equal(route.kind, "direct", `${label}：不得逃逸劫持流量，实际路由：${JSON.stringify(route)}`);
    assert.notEqual(route.proxyUrl, `http://${EVIL_HIJACK_PROXY}`, `${label}：不得出现 ${EVIL_HIJACK_PROXY} 代理路由`);
  }
});

// ─── T10 工单 11（用户裁定·内存配额池）：worker 24 MiB 堆帽 + 模块级全局在飞闸（串行排队）──

test("T10-1 堆帽 24 MiB：无限分配内存恶意脚本 → V8 OOM 快速以 TransportError(PAC_EVAL_FAILED) 落定且耗时 < 8s", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  let capturedArgs = null;
  let settleExit;
  const exitPromise = new Promise((resolve) => {
    settleExit = resolve;
  });
  const spySpawn = (cmd, args, opts) => {
    capturedArgs = args;
    const child = spawn(cmd, args, opts);
    child.once("exit", (code, signal) => settleExit({ code, signal }));
    return child;
  };
  const fetchFn = createFakeFetch({ default: "never" });
  const entry = C.makeEntry({ id: "e-pac-t10-oom", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const transport = mod.createEntryTransport(entry, { fetch: fetchFn, spawnProcess: spySpawn });
  declarePac(fetchFn, 'function FindProxyForURL(u,h){var a=[];while(true){a.push("x".repeat(1<<20));}}');
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const startedAt = Date.now();
  const [out, exitInfo] = await Promise.all([captureFetch(transport), exitPromise]);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(out.state, "err", "无限分配内存脚本必须失败落定");
  assert.ok(out.error instanceof mod.TransportError, "错误必须是 TransportError");
  assert.equal(out.error.code, C.CONFIG_CODES.PAC_EVAL_FAILED, `错误码须为 PAC_EVAL_FAILED，实际：${out.error.code}`);
  assert.equal(
    out.error.message,
    "PAC 脚本求值失败（FindProxyForURL 运行出错）",
    `错误消息须沿用既有运行出错语义，实际：${out.error.message}`,
  );
  assert.ok(elapsedMs < 8000, `堆帽下 V8 OOM 须在 8000ms 内落定，实际 ${elapsedMs}ms`);
  assert.ok(
    Array.isArray(capturedArgs) && capturedArgs.includes("--max-old-space-size=24"),
    `spawn 参数须携带 24 MiB 堆帽 --max-old-space-size=24，实际：${JSON.stringify(capturedArgs)}`,
  );
  // 内存边界两层都是设计内强制路径：24 MiB V8 堆帽自爆 → SIGABRT；
  // 144 MiB RSS 看门狗（或宿主 cgroup OOM 先手）→ SIGKILL。
  // 退出信号只标识哪层赢下竞态；安全契约由上方 TransportError/PAC_EVAL_FAILED/
  // <8s/零出站断言钉死。三者之外（超时正常退出或 code 0）才是本测试要拒的。
  assert.ok(
    exitInfo.signal === "SIGABRT" ||
      exitInfo.signal === "SIGKILL" ||
      (exitInfo.code !== null && exitInfo.code !== 0),
    `堆帽 OOM 应使 worker 被 V8 堆帽或 RSS 看门狗异常终止而非超时正常退出，实际：${JSON.stringify(exitInfo)}`,
  );
  assert.equal(fetchFn.count(TARGET), 0, "求值失败后不得向目标出站");
});

test("T10-2 全局在飞闸：两个独立 transport 并发求值 PAC → worker spawn-to-close 区间不相交（串行化）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const pacA = "https://syn-pac-t10-a.invalid/a.pac?v=1";
  const pacB = "https://syn-pac-t10-b.invalid/b.pac?v=2";
  const intervals = [];
  const recordingSpawn = (cmd, args, opts) => {
    const startNs = process.hrtime.bigint();
    const child = spawn(cmd, args, opts);
    const rec = { startNs, endNs: null };
    intervals.push(rec);
    child.once("close", () => {
      rec.endNs = process.hrtime.bigint();
    });
    return child;
  };
  const spinScript =
    "function FindProxyForURL(u, h) { var end = Date.now() + 120; while (Date.now() < end) {} return \"DIRECT\"; }";

  const fetchA = createFakeFetch({ default: "never" });
  fetchA.when(pacA).responds({ status: 200, body: spinScript, headers: { "content-type": "application/x-ns-proxy-autoconfig" } });
  fetchA.when(TARGET).responds({ status: 200, body: { ok: true } });
  const transportA = mod.createEntryTransport(
    C.makeEntry({ id: "e-pac-t10-gate-a", type: "tavily", proxy: { pac: pacA } }),
    { fetch: fetchA, spawnProcess: recordingSpawn },
  );

  const fetchB = createFakeFetch({ default: "never" });
  fetchB.when(pacB).responds({ status: 200, body: spinScript, headers: { "content-type": "application/x-ns-proxy-autoconfig" } });
  fetchB.when(TARGET).responds({ status: 200, body: { ok: true } });
  const transportB = mod.createEntryTransport(
    C.makeEntry({ id: "e-pac-t10-gate-b", type: "openai", proxy: { pac: pacB } }),
    { fetch: fetchB, spawnProcess: recordingSpawn },
  );

  const [outA, outB] = await Promise.all([captureFetch(transportA), captureFetch(transportB)]);
  assert.equal(outA.state, "ok", `transportA 必须成功，实际错误：${outA.error?.message ?? "(无)"}`);
  assert.equal(outB.state, "ok", `transportB 必须成功，实际错误：${outB.error?.message ?? "(无)"}`);
  assert.equal(intervals.length, 2, `两次未命中缓存的 PAC 求值应各 spawn 一次，实际 ${intervals.length} 次`);
  assert.ok(intervals[0].endNs !== null && intervals[1].endNs !== null, "两个 worker 都必须已关闭");

  const sorted = [...intervals].sort((a, b) => (a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : 0));
  assert.ok(
    sorted[0].endNs <= sorted[1].startNs,
    `全局在飞闸必须使两 worker 区间严格不相交（串行化），实际区间：first=[${sorted[0].startNs}, ${sorted[0].endNs}], second=[${sorted[1].startNs}, ${sorted[1].endNs}]`,
  );
  assert.equal(routeOf(fetchA).kind, "direct");
  assert.equal(routeOf(fetchB).kind, "direct");
});

function createControlledSpawn() {
  const children = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.killed = false;
    child.lastMsg = null;
    child.send = (msg) => {
      child.lastMsg = msg;
    };
    child.kill = () => {
      child.killed = true;
    };
    child.disconnect = () => {};
    children.push(child);
    return child;
  };
  return { children, spawnProcess };
}

test("T10-3 abort 排队者：transport1 占住槽位时 transport2 abort → AbortError 落定且槽位不泄漏（transport3 正常求值）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const { children, spawnProcess } = createControlledSpawn();

  const makeBag = (id, pacUrl) => {
    const fetchFn = createFakeFetch({ default: "never" });
    fetchFn.when(pacUrl).responds({
      status: 200,
      body: 'function FindProxyForURL(){return "DIRECT";}',
      headers: { "content-type": "application/x-ns-proxy-autoconfig" },
    });
    fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });
    const transport = mod.createEntryTransport(C.makeEntry({ id, type: "tavily", proxy: { pac: pacUrl } }), {
      fetch: fetchFn,
      spawnProcess,
    });
    return { fetchFn, transport };
  };

  const bag1 = makeBag("e-pac-t10-abort-1", "https://syn-pac-t10-1.invalid/p.pac");
  const bag2 = makeBag("e-pac-t10-abort-2", "https://syn-pac-t10-2.invalid/p.pac");
  const bag3 = makeBag("e-pac-t10-abort-3", "https://syn-pac-t10-3.invalid/p.pac");

  const p1 = captureFetch(bag1.transport);
  for (let i = 0; i < 10 && children.length < 1; i++) await new Promise((r) => setImmediate(r));
  assert.equal(children.length, 1, "transport1 必须已占住全局槽位并 spawn worker 1");

  const ac2 = new AbortController();
  const p2 = (async () => {
    try {
      const value = await bag2.transport.fetch(TARGET, { signal: ac2.signal });
      return { state: "ok", value, error: undefined };
    } catch (error) {
      return { state: "err", value: undefined, error };
    }
  })();
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.equal(children.length, 1, "transport1 占住槽位期间，transport2 必须排队不得提前 spawn");

  ac2.abort();
  const out2 = await p2;
  assert.equal(out2.state, "err", "排队中 abort 必须立即落定错误");
  assert.equal(out2.error?.name, "AbortError", `排队 abort 须沿用既有 AbortError 语义，实际：${out2.error?.name}`);
  assert.equal(children.length, 1, "被 abort 的排队者不得触发额外 spawn");
  assert.equal(bag2.fetchFn.count(TARGET), 0, "abort 后不得向目标出站");

  // 释放 worker 1
  const c1 = children[0];
  c1.emit("message", { id: c1.lastMsg.id, outcome: "SDIRECT" });
  c1.emit("close", 0, null);
  const out1 = await p1;
  assert.equal(out1.state, "ok", `transport1 应正常完成，实际错误：${out1.error?.message ?? "(无)"}`);

  // 验证槽位不泄漏：transport3 正常获取槽位并求值成功
  const p3 = captureFetch(bag3.transport);
  for (let i = 0; i < 10 && children.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.equal(children.length, 2, "槽位释放后 transport3 必须能正常取得槽位并 spawn worker");
  const c3 = children[1];
  c3.emit("message", { id: c3.lastMsg.id, outcome: "SDIRECT" });
  c3.emit("close", 0, null);
  const out3 = await p3;
  assert.equal(out3.state, "ok", `transport3 应正常求值成功，实际错误：${out3.error?.message ?? "(无)"}`);
  assert.equal(routeOf(bag3.fetchFn).kind, "direct");
});

test("T10-3b 排队中 closeAll() → 等待者以运行出错落定、不影响他条在飞 worker、槽位不泄漏", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const { children, spawnProcess } = createControlledSpawn();

  const makeBag = (id, pacUrl) => {
    const fetchFn = createFakeFetch({ default: "never" });
    fetchFn.when(pacUrl).responds({
      status: 200,
      body: 'function FindProxyForURL(){return "DIRECT";}',
      headers: { "content-type": "application/x-ns-proxy-autoconfig" },
    });
    fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });
    const transport = mod.createEntryTransport(C.makeEntry({ id, type: "tavily", proxy: { pac: pacUrl } }), {
      fetch: fetchFn,
      spawnProcess,
    });
    return { fetchFn, transport };
  };

  const bag1 = makeBag("e-pac-t10-close-1", "https://syn-pac-t10-c1.invalid/p.pac");
  const bag2 = makeBag("e-pac-t10-close-2", "https://syn-pac-t10-c2.invalid/p.pac");
  const bag3 = makeBag("e-pac-t10-close-3", "https://syn-pac-t10-c3.invalid/p.pac");

  const p1 = captureFetch(bag1.transport);
  for (let i = 0; i < 10 && children.length < 1; i++) await new Promise((r) => setImmediate(r));
  assert.equal(children.length, 1);

  const p2 = captureFetch(bag2.transport);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.equal(children.length, 1, "transport2 须处于排队状态");

  bag2.transport.closeAll();
  const out2 = await p2;
  assert.equal(out2.state, "err", "closeAll() 后排队等待者必须落定错误");
  assert.ok(out2.error instanceof mod.TransportError, "错误必须是 TransportError");
  assert.equal(out2.error.code, C.CONFIG_CODES.PAC_EVAL_FAILED, `错误码须为 PAC_EVAL_FAILED，实际：${out2.error.code}`);
  assert.equal(out2.error.message, "PAC 脚本求值失败（FindProxyForURL 运行出错）");
  assert.equal(children[0].killed, false, "关闭 transport2 不得误杀 transport1 的在飞 worker");

  const c1 = children[0];
  c1.emit("message", { id: c1.lastMsg.id, outcome: "SDIRECT" });
  c1.emit("close", 0, null);
  const out1 = await p1;
  assert.equal(out1.state, "ok", "transport1 应不受影响正常完成");

  const p3 = captureFetch(bag3.transport);
  for (let i = 0; i < 10 && children.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.equal(children.length, 2, "后续 transport3 须正常取得槽位");
  const c3 = children[1];
  c3.emit("message", { id: c3.lastMsg.id, outcome: "SDIRECT" });
  c3.emit("close", 0, null);
  const out3 = await p3;
  assert.equal(out3.state, "ok");
  assert.equal(routeOf(bag3.fetchFn).kind, "direct");
});

// ─── T12 工单 12（真·内存上限）：外部内存名称全封 + 父进程 RSS 采样看门狗 ─────────────

test("T12-1 SAB 256MiB（lead 原案表达式）经真实传输层：无 try 落定 TransportError，try/catch 回退 DIRECT 且无 9.9.9.9 劫持", async (t) => {
  const mod = await load(t);
  if (!mod) return;

  // 1) 无 try 版（lead 原案）：封名后抛出运行错误，TransportError(PAC_EVAL_FAILED)，目标零出站
  {
    const script = 'function FindProxyForURL(u,h){new Uint8Array(new SharedArrayBuffer(256<<20)).fill(1);return "DIRECT";}';
    const entry = C.makeEntry({ id: "e-pac-t12-sab-raw", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const { fetchFn, transport } = openTransport(mod, entry);
    declarePac(fetchFn, script);
    fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

    const out = await captureFetch(transport);
    assert.equal(out.state, "err", "无 try SAB 256MiB 必须因封名抛错失败落定（不得返回 DIRECT）");
    assert.ok(out.error instanceof mod.TransportError, "错误必须是 TransportError");
    assert.equal(
      out.error.code,
      C.CONFIG_CODES.PAC_EVAL_FAILED,
      `错误码须为 PAC_EVAL_FAILED，实际：${JSON.stringify(out.error.code)}`,
    );
    assert.equal(
      out.error.message,
      "PAC 脚本求值失败（FindProxyForURL 运行出错）",
      `错误消息须沿用运行出错归因，实际：${out.error.message}`,
    );
    assert.equal(fetchFn.count(TARGET), 0, "求值失败后目标必须零出站");
  }

  // 2) try/catch 劫持形态：封名后进 catch 回退 DIRECT，无 PROXY 标记、无 9.9.9.9 劫持，DIRECT 干净出站
  {
    const script =
      "function FindProxyForURL(u,h){try{var b=new Uint8Array(new SharedArrayBuffer(256<<20));b.fill(1);" +
      `return "PROXY ${EVIL_HIJACK_PROXY}";}catch(e){return "DIRECT";}}`;
    const entry = C.makeEntry({ id: "e-pac-t12-sab-try", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const { fetchFn, transport } = openTransport(mod, entry);
    declarePac(fetchFn, script);
    fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

    const out = await captureFetch(transport);
    assert.equal(out.state, "ok", `try/catch SAB 捕获后应回退 DIRECT，实际错误：${out.error?.message ?? "(无)"}`);
    const route = routeOf(fetchFn);
    assert.equal(route.kind, "direct", `try/catch SAB 必须走 DIRECT 无 PROXY 标记，实际：${JSON.stringify(route)}`);
    assert.equal(route.proxyUrl, undefined, `DIRECT 路由不得含 proxyUrl，实际：${route.proxyUrl}`);
    assert.notEqual(route.proxyUrl, `http://${EVIL_HIJACK_PROXY}`, `不得出现 ${EVIL_HIJACK_PROXY} 劫持路由`);
    assert.equal(route.viaPac, true);
    assert.equal(fetchFn.count(TARGET), 1, "DIRECT 干净出站恰好一次");
  }
});

test("T12-2 typeof 探测钉：外部内存入口全为 undefined 才 DIRECT，否则 PROXY 标记", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const script =
    "function FindProxyForURL(url, host) {" +
    "  var allSealed = (" +
    '    typeof ArrayBuffer === "undefined" &&' +
    '    typeof SharedArrayBuffer === "undefined" &&' +
    '    typeof DataView === "undefined" &&' +
    '    typeof TextEncoder === "undefined" &&' +
    '    typeof Int8Array === "undefined" &&' +
    '    typeof Uint8Array === "undefined" &&' +
    '    typeof Uint8ClampedArray === "undefined" &&' +
    '    typeof Int16Array === "undefined" &&' +
    '    typeof Uint16Array === "undefined" &&' +
    '    typeof Int32Array === "undefined" &&' +
    '    typeof Uint32Array === "undefined" &&' +
    '    typeof Float16Array === "undefined" &&' +
    '    typeof Float32Array === "undefined" &&' +
    '    typeof Float64Array === "undefined" &&' +
    '    typeof BigInt64Array === "undefined" &&' +
    '    typeof BigUint64Array === "undefined" &&' +
    '    typeof Atomics === "undefined"' +
    "  );" +
    `  return allSealed ? "DIRECT" : "PROXY ${MISMATCH_PROXY}";` +
    "}";
  const entry = C.makeEntry({ id: "e-pac-t12-typeof", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const { fetchFn, transport } = openTransport(mod, entry);
  declarePac(fetchFn, script);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const out = await captureFetch(transport);
  assert.equal(out.state, "ok", `typeof 探测脚本必须求值成功，实际错误：${out.error?.message ?? "(无)"}`);
  const route = routeOf(fetchFn);
  assert.equal(
    route.kind,
    "direct",
    `所有外部内存名称必须封为 undefined 才走 DIRECT，实际路由：${JSON.stringify(route)}`,
  );
  assert.equal(route.viaPac, true);
});

test("T12-3 RSS 看门狗端到端：有限分配 >144MiB 子进程（1s 内自然完成）→ 被 SIGKILL 截杀并落定 PAC_EVAL_FAILED（< 8s）", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  let settleExit;
  const exitPromise = new Promise((resolve) => {
    settleExit = resolve;
  });
  const allocChildCode = [
    'process.on("message", (msg) => {',
    "  const a = new Uint8Array(256 << 20);",
    "  a.fill(1);",
    "  globalThis.__hold = a;",
    "  setTimeout(() => {",
    '    if (typeof process.send === "function") {',
    '      process.send({ id: msg.id, outcome: "SDIRECT" }, () => process.exit(0));',
    "    } else {",
    "      process.exit(0);",
    "    }",
    "  }, 1000);",
    "});",
  ].join("\n");
  const rssProbeSpawn = (cmd, args, opts) => {
    const execIdx = Array.isArray(args) ? args.findIndex((a) => String(a).startsWith("--max-old-space-size=")) : -1;
    const childArgs = execIdx > 0 ? [...args.slice(0, execIdx), "-e", allocChildCode] : ["-e", allocChildCode];
    const child = spawn(cmd, childArgs, opts);
    child.once("exit", (code, signal) => settleExit({ code, signal }));
    return child;
  };

  const fetchFn = createFakeFetch({ default: "never" });
  const entry = C.makeEntry({ id: "e-pac-t12-rss-watchdog", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const transport = mod.createEntryTransport(entry, { fetch: fetchFn, spawnProcess: rssProbeSpawn });
  declarePac(fetchFn, 'function FindProxyForURL(u,h){return "DIRECT";}');
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const startedAt = Date.now();
  const [out, exitInfo] = await Promise.all([captureFetch(transport), exitPromise]);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(out.state, "err", "超过 144MiB RSS 上限的子进程必须被看门狗截杀并失败落定");
  assert.ok(out.error instanceof mod.TransportError, "错误必须是 TransportError");
  assert.equal(
    out.error.code,
    C.CONFIG_CODES.PAC_EVAL_FAILED,
    `RSS 超限错误码须为 PAC_EVAL_FAILED，实际：${out.error.code}`,
  );
  assert.equal(
    out.error.message,
    "PAC 脚本求值失败（FindProxyForURL 运行出错）",
    `RSS 超限对外错误消息须沿用既有运行出错文案，实际：${out.error.message}`,
  );
  assert.equal(exitInfo.signal, "SIGKILL", `RSS 看门狗必须以 SIGKILL 强杀子进程，实际：${JSON.stringify(exitInfo)}`);
  assert.ok(elapsedMs < 8000, `RSS 看门狗应在 8000ms 内完成强杀收敛，实际 ${elapsedMs}ms`);
  assert.equal(fetchFn.count(TARGET), 0, "RSS 超限失败后不得向目标出站");
});

test("T12-4 语义回归：常规路由与助手重定义照常，repeat/JSON.parse 30MiB 成功且 while(true) 受 24MiB 堆帽 OOM 落定", async (t) => {
  const mod = await load(t);
  if (!mod) return;

  // 1) 常规 DIRECT / PROXY / 多候选 directive 与 shExpMatch/dnsDomainIs 用户重定义照常
  const semanticCases = [
    {
      id: "e-pac-t12-sem-direct",
      script: 'function FindProxyForURL(u, h) { return "DIRECT"; }',
      expectedKind: "direct",
      expectedProxyUrl: undefined,
      expectedIndex: 0,
    },
    {
      id: "e-pac-t12-sem-proxy",
      script: `function FindProxyForURL(u, h) { return "PROXY ${BEHAVIOR_PROXY}"; }`,
      expectedKind: "proxy",
      expectedProxyUrl: `http://${BEHAVIOR_PROXY}`,
      expectedIndex: 0,
    },
    {
      id: "e-pac-t12-sem-multi",
      script: `function FindProxyForURL(u, h) { return "SOCKS 127.0.0.1:1080; PROXY ${BEHAVIOR_PROXY}; DIRECT"; }`,
      expectedKind: "proxy",
      expectedProxyUrl: `http://${BEHAVIOR_PROXY}`,
      expectedIndex: 1,
    },
    {
      id: "e-pac-t12-sem-redef",
      script:
        "function shExpMatch() { return true; }" +
        "function dnsDomainIs() { return true; }" +
        "function FindProxyForURL(u, h) {" +
        `  return (shExpMatch("a", "never") && dnsDomainIs("x", ".never")) ? "PROXY ${BEHAVIOR_PROXY}" : "DIRECT";` +
        "}",
      expectedKind: "proxy",
      expectedProxyUrl: `http://${BEHAVIOR_PROXY}`,
      expectedIndex: 0,
    },
  ];
  for (const sc of semanticCases) {
    const entry = C.makeEntry({ id: sc.id, type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const { fetchFn, transport } = openTransport(mod, entry);
    declarePac(fetchFn, sc.script);
    fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

    const out = await captureFetch(transport);
    assert.equal(out.state, "ok", `${sc.id}：合法 PAC 必须求值成功，实际错误：${out.error?.message ?? "(无)"}`);
    const route = routeOf(fetchFn);
    assert.equal(route.kind, sc.expectedKind);
    assert.equal(route.proxyUrl, sc.expectedProxyUrl);
    assert.equal(route.pacIndex, sc.expectedIndex);
    assert.equal(route.viaPac, true);
  }

  // 2) "".repeat / JSON.parse 构造 30MiB 字符串数组成功（合法堆内操作不受封名与 144MiB RSS 闸误伤）
  {
    const script =
      "function FindProxyForURL(u, h) {" +
      '  var a = []; for (var i = 0; i < 30; i++) a.push("x".repeat(1 << 20));' +
      "  var parsed = JSON.parse('{\"route\":\"DIRECT\"}');" +
      '  return (a.length === 30 && a[0].length === (1 << 20)) ? parsed.route : "PROXY ' + MISMATCH_PROXY + '";' +
      "}";
    const entry = C.makeEntry({ id: "e-pac-t12-repeat-30m", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const { fetchFn, transport } = openTransport(mod, entry);
    declarePac(fetchFn, script);
    fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

    const out = await captureFetch(transport);
    assert.equal(out.state, "ok", `30MiB 字符串数组与 JSON.parse 必须求值成功，实际错误：${out.error?.message ?? "(无)"}`);
    assert.equal(routeOf(fetchFn).kind, "direct");
  }

  // 3) 随后 while(true) JSON.parse 堆爆 OOM 落定（复用 T10-1 断言口径）
  {
    let capturedArgs = null;
    let settleExit;
    const exitPromise = new Promise((resolve) => {
      settleExit = resolve;
    });
    const spySpawn = (cmd, args, opts) => {
      capturedArgs = args;
      const child = spawn(cmd, args, opts);
      child.once("exit", (code, signal) => settleExit({ code, signal }));
      return child;
    };
    const fetchFn = createFakeFetch({ default: "never" });
    const entry = C.makeEntry({ id: "e-pac-t12-json-oom", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const transport = mod.createEntryTransport(entry, { fetch: fetchFn, spawnProcess: spySpawn });
    declarePac(
      fetchFn,
      'function FindProxyForURL(u,h){var a=[];var s=JSON.stringify("x".repeat(1<<20));while(true){a.push(JSON.parse(s));}}',
    );
    fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

    const startedAt = Date.now();
    const [out, exitInfo] = await Promise.all([captureFetch(transport), exitPromise]);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(out.state, "err", "无限 JSON.parse 堆分配必须失败落定");
    assert.ok(out.error instanceof mod.TransportError, "错误必须是 TransportError");
    assert.equal(out.error.code, C.CONFIG_CODES.PAC_EVAL_FAILED, `错误码须为 PAC_EVAL_FAILED，实际：${out.error.code}`);
    assert.equal(
      out.error.message,
      "PAC 脚本求值失败（FindProxyForURL 运行出错）",
      `错误消息须沿用既有运行出错语义，实际：${out.error.message}`,
    );
    assert.ok(elapsedMs < 8000, `堆帽下 V8 OOM 须在 8000ms 内落定，实际 ${elapsedMs}ms`);
    assert.ok(
      Array.isArray(capturedArgs) && capturedArgs.includes("--max-old-space-size=24"),
      `spawn 参数须携带 24 MiB 堆帽 --max-old-space-size=24，实际：${JSON.stringify(capturedArgs)}`,
    );
    assert.ok(
      exitInfo.signal === "SIGABRT" || (exitInfo.code !== null && exitInfo.code !== 0),
      `堆帽 OOM 应使 worker 异常终止，实际：${JSON.stringify(exitInfo)}`,
    );
    assert.equal(fetchFn.count(TARGET), 0, "求值失败后不得向目标出站");
  }
});

// ─── T13 Issue #64：macOS sandbox-exec OS 级最小权限加固单测与集成 PoC ─────────────

function makeStubChildWithOutcome(outcome = "SDIRECT") {
  const child = new EventEmitter();
  child.pid = 42424;
  child.killed = false;
  child.send = (msg) => {
    queueMicrotask(() => {
      child.emit("message", { id: msg.id, outcome });
      child.emit("close", 0, null);
    });
  };
  child.kill = () => {
    child.killed = true;
  };
  child.disconnect = () => {};
  return child;
}

test("T13-1 命令形态（OSB-001/002）：darwin 且探测通过时以 /usr/bin/sandbox-exec -p <profile> 直接 exec 包裹 worker", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  const calls = [];
  const stubSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return makeStubChildWithOutcome("SDIRECT");
  };
  const fetchFn = createFakeFetch({ default: "never" });
  const entry = C.makeEntry({ id: "e-pac-t13-cmd", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const transport = mod.createEntryTransport(entry, {
    fetch: fetchFn,
    spawnProcess: stubSpawn,
    sandbox: {
      platform: "darwin",
      sandboxExecPath: "/usr/bin/sandbox-exec",
      probe: () => true,
      cache: new Map(),
    },
  });
  declarePac(fetchFn, 'function FindProxyForURL() { return "DIRECT"; }');
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const out = await captureFetch(transport);
  assert.equal(out.state, "ok", `包裹命令形态下合法 PAC 必须成功，实际：${out.error?.message ?? "(无)"}`);
  assert.equal(calls.length, 1);

  const { cmd, args, opts } = calls[0];
  assert.equal(cmd, "/usr/bin/sandbox-exec", "首参必须为 /usr/bin/sandbox-exec（禁止 sh -c 包装壳）");
  assert.equal(args[0], "-p");
  assert.equal(typeof args[1], "string");
  const profile = args[1];
  const execReal = realpathSync(process.execPath);
  assert.equal(args[2], execReal, "第 3 参数必须为 process.execPath 的 realpath");
  assert.equal(args[3], "--max-old-space-size=24");
  assert.equal(args[4], PAC_WORKER_FILE);
  assert.deepEqual(opts.stdio, ["ignore", "ignore", "ignore", "ipc"]);
  assert.deepEqual(opts.env, { ELECTRON_RUN_AS_NODE: "1" });

  assert.ok(profile.includes("(version 1)"));
  assert.ok(profile.includes("(deny default)"));
  assert.ok(profile.includes("(deny file-write*)"));
  assert.ok(profile.includes("(deny network*)"));
  assert.ok(profile.includes("(deny process-fork)"));
  assert.ok(profile.includes(`(allow process-exec (literal ${JSON.stringify(execReal)}))`));
  assert.ok(profile.includes("(allow dynamic-code-generation)"));
  assert.ok(profile.includes("(allow sysctl-read)"));
});

test("T13-2 能力探测缓存（OSB-001）：连续多次未命中缓存求值，probe 只执行一次", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  let probeCount = 0;
  const sharedCache = new Map();
  const stubSpawn = () => makeStubChildWithOutcome("SDIRECT");

  for (const suffix of ["one", "two"]) {
    const fetchFn = createFakeFetch({ default: "never" });
    const entry = C.makeEntry({ id: `e-pac-t13-cache-${suffix}`, type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const transport = mod.createEntryTransport(entry, {
      fetch: fetchFn,
      spawnProcess: stubSpawn,
      sandbox: {
        platform: "darwin",
        sandboxExecPath: "/usr/bin/sandbox-exec",
        probe: () => {
          probeCount += 1;
          return true;
        },
        cache: sharedCache,
      },
    });
    declarePac(fetchFn, 'function FindProxyForURL() { return "DIRECT"; }');
    const url = `${TARGET}&seq=${suffix}`;
    fetchFn.when(url).responds({ status: 200, body: { ok: true } });
    const out = await captureFetch(transport, url);
    assert.equal(out.state, "ok");
  }

  assert.equal(probeCount, 1, `能力探测结果必须跨多次求值缓存，只探测 1 次，实际 ${probeCount} 次`);
});

test("T13-3 非 darwin 平台回退（OSB-001）：跳过探测并直 spawn process.execPath", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  let probeCount = 0;
  const calls = [];
  const stubSpawn = (cmd, args) => {
    calls.push({ cmd, args });
    return makeStubChildWithOutcome(`SPROXY ${BEHAVIOR_PROXY}`);
  };
  const fetchFn = createFakeFetch({ default: "never" });
  const entry = C.makeEntry({ id: "e-pac-t13-linux", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
  const transport = mod.createEntryTransport(entry, {
    fetch: fetchFn,
    spawnProcess: stubSpawn,
    sandbox: {
      platform: "linux",
      probe: () => {
        probeCount += 1;
        return true;
      },
      cache: new Map(),
    },
  });
  declarePac(fetchFn, `function FindProxyForURL() { return "PROXY ${BEHAVIOR_PROXY}"; }`);
  fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

  const out = await captureFetch(transport);
  assert.equal(out.state, "ok");
  assert.equal(probeCount, 0, "非 darwin 平台不得调用 sandbox-exec 探测");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, ["--max-old-space-size=24", PAC_WORKER_FILE]);
  assert.equal(routeOf(fetchFn).proxyUrl, `http://${BEHAVIOR_PROXY}`);
});

test("T13-4 探测失败/缺失/抛错回退（OSB-001）：回退现状直 spawn 且复用负数缓存", async (t) => {
  const mod = await load(t);
  if (!mod) return;

  // 1) probe 返回 false + 负数缓存
  {
    let probeCount = 0;
    const cache = new Map();
    const calls = [];
    const stubSpawn = (cmd, args) => {
      calls.push({ cmd, args });
      return makeStubChildWithOutcome("SDIRECT");
    };
    for (const seq of [1, 2]) {
      const fetchFn = createFakeFetch({ default: "never" });
      const entry = C.makeEntry({ id: `e-pac-t13-fb-false-${seq}`, type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
      const transport = mod.createEntryTransport(entry, {
        fetch: fetchFn,
        spawnProcess: stubSpawn,
        sandbox: {
          platform: "darwin",
          probe: () => {
            probeCount += 1;
            return false;
          },
          cache,
        },
      });
      declarePac(fetchFn, 'function FindProxyForURL() { return "DIRECT"; }');
      const url = `${TARGET}&fb=${seq}`;
      fetchFn.when(url).responds({ status: 200, body: { ok: true } });
      const out = await captureFetch(transport, url);
      assert.equal(out.state, "ok");
    }
    assert.equal(probeCount, 1, "失败探测也必须缓存，不得重复探测");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].cmd, process.execPath);
    assert.equal(calls[1].cmd, process.execPath);
  }

  // 2) probe 抛错
  {
    const calls = [];
    const stubSpawn = (cmd, args) => {
      calls.push({ cmd, args });
      return makeStubChildWithOutcome("SDIRECT");
    };
    const fetchFn = createFakeFetch({ default: "never" });
    const entry = C.makeEntry({ id: "e-pac-t13-fb-throw", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const transport = mod.createEntryTransport(entry, {
      fetch: fetchFn,
      spawnProcess: stubSpawn,
      sandbox: {
        platform: "darwin",
        probe: () => {
          throw new Error("sandbox_apply: Operation not permitted");
        },
        cache: new Map(),
      },
    });
    declarePac(fetchFn, 'function FindProxyForURL() { return "DIRECT"; }');
    fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });
    const out = await captureFetch(transport);
    assert.equal(out.state, "ok");
    assert.equal(calls[0].cmd, process.execPath);
  }

  // 3) 不存在的 sandboxExecPath 走默认探测回退直 spawn
  {
    const calls = [];
    const stubSpawn = (cmd, args) => {
      calls.push({ cmd, args });
      return makeStubChildWithOutcome("SDIRECT");
    };
    const fetchFn = createFakeFetch({ default: "never" });
    const entry = C.makeEntry({ id: "e-pac-t13-fb-missing", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const transport = mod.createEntryTransport(entry, {
      fetch: fetchFn,
      spawnProcess: stubSpawn,
      sandbox: {
        platform: "darwin",
        sandboxExecPath: "/nonexistent/sandbox-exec-64",
        cache: new Map(),
      },
    });
    declarePac(fetchFn, 'function FindProxyForURL() { return "DIRECT"; }');
    fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });
    const out = await captureFetch(transport);
    assert.equal(out.state, "ok");
    assert.equal(calls[0].cmd, process.execPath);
  }
});

test("T13-5 Profile 构造（OSB-002）：symlink realpath 沿途 metadata、Electron Frameworks 豁免与异常路径返回 null", async (t) => {
  const mod = await load(t);
  if (!mod) return;
  assert.equal(typeof mod.buildPacSandboxProfile, "function");

  // 1) symlink 挂载路径 + Electron .app/Contents/Frameworks
  const map = new Map([
    ["/profile/node_modules/dsh-fleetseek/src/pac-eval-worker.js", "/repo/src/pac-eval-worker.js"],
    ["/profile/node_modules/dsh-fleetseek/src", "/repo/src"],
    ["/profile/node_modules/dsh-fleetseek", "/repo"],
    ["/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness", "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"],
    ["/Applications/DeepSeek Harness.app/Contents/Frameworks", "/Applications/DeepSeek Harness.app/Contents/Frameworks"],
  ]);
  const built = mod.buildPacSandboxProfile({
    execPath: "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
    workerPath: "/profile/node_modules/dsh-fleetseek/src/pac-eval-worker.js",
    realpathFn: (p) => map.get(p) ?? p,
    existsFn: (p) => p === "/Applications/DeepSeek Harness.app/Contents/Frameworks",
  });
  assert.ok(built);
  assert.equal(built.frameworksRealpath, "/Applications/DeepSeek Harness.app/Contents/Frameworks");
  assert.ok(built.profile.includes('(literal "/profile/node_modules/dsh-fleetseek")'));
  assert.ok(built.profile.includes('(literal "/repo")'));
  assert.ok(built.profile.includes('(subpath "/repo")'));
  assert.ok(built.profile.includes('(subpath "/Applications/DeepSeek Harness.app/Contents/Frameworks")'));
  assert.ok(built.profile.includes('(allow process-exec (literal "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"))'));

  // 2) 非法控制字符或 realpath 失败返回 null
  assert.equal(mod.buildPacSandboxProfile({ execPath: "/bad\npath", workerPath: PAC_WORKER_FILE }), null);
  assert.equal(
    mod.buildPacSandboxProfile({
      execPath: process.execPath,
      workerPath: PAC_WORKER_FILE,
      realpathFn: () => {
        throw new Error("ENOENT");
      },
    }),
    null,
  );
});

test(
  "T13-6 darwin-only 集成 PoC（OSB-002/003）：包裹 worker 内写盘/连网/监听/fork 全被 OS 拒（EACCES/EPERM），PID 不变且 IPC 正常",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const mod = await load(t);
    if (!mod) return;

    const probeFileTmp = path.join(os.tmpdir(), `pac-sbx-poc-${process.pid}-${Date.now()}.txt`);
    const probeFileRepo = path.join(REPO_ROOT, `.pac-sbx-poc-${process.pid}-${Date.now()}.txt`);
    const server = net.createServer();
    let serverConnections = 0;
    server.on("connection", (sock) => {
      serverConnections += 1;
      sock.destroy();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    try {
      const pocCode = [
        'import fs from "node:fs";',
        'import net from "node:net";',
        'import { spawnSync } from "node:child_process";',
        `const probeFiles = ${JSON.stringify([probeFileTmp, probeFileRepo])};`,
        `const targetPort = ${port};`,
        "function isOsDenied(err) { return err && (err.code === 'EACCES' || err.code === 'EPERM'); }",
        'process.on("message", async (msg) => {',
        "  const failures = [];",
        "  if (msg.expectPid !== process.pid) failures.push('pid-changed:' + msg.expectPid + '!=' + process.pid);",
        "  for (const f of probeFiles) {",
        "    try { fs.writeFileSync(f, 'pwned'); failures.push('write-succeeded:' + f); } catch (e) {",
        "      if (!isOsDenied(e)) failures.push('write-unexpected:' + (e && e.code));",
        "    }",
        "  }",
        "  const forkRes = spawnSync(process.execPath, ['-e', '0']);",
        "  if (!isOsDenied(forkRes.error)) failures.push('fork-unexpected:' + (forkRes.error && forkRes.error.code) + ':' + forkRes.status);",
        "  const connectDenied = await new Promise((resolve) => {",
        "    const sock = net.connect({ host: '127.0.0.1', port: targetPort });",
        "    sock.once('connect', () => { sock.destroy(); resolve('connected'); });",
        "    sock.once('error', (e) => resolve(isOsDenied(e) ? 'ok' : ('err:' + e.code)));",
        "  });",
        "  if (connectDenied !== 'ok') failures.push('net-connect-' + connectDenied);",
        "  const listenDenied = await new Promise((resolve) => {",
        "    const srv = net.createServer();",
        "    srv.once('error', (e) => resolve(isOsDenied(e) ? 'ok' : ('err:' + e.code)));",
        "    srv.listen(0, '127.0.0.1', () => { srv.close(); resolve('listened'); });",
        "  });",
        "  if (listenDenied !== 'ok') failures.push('net-listen-' + listenDenied);",
        "  const outcome = failures.length === 0 ? 'SDIRECT' : ('SPROXY 9.9.9.9:8080');",
        "  process.send({ id: msg.id, outcome }, () => process.exit(0));",
        "});",
      ].join("\n");

      let seenCmd = null;
      let seenArgs = null;
      const pocSpawn = (cmd, args, opts) => {
        seenCmd = cmd;
        seenArgs = args;
        assert.equal(cmd, "/usr/bin/sandbox-exec", "darwin 下必须启用 /usr/bin/sandbox-exec 包裹");
        const execIdx = args.findIndex((a) => String(a).startsWith("--max-old-space-size="));
        assert.ok(execIdx > 0);
        const patchedArgs = [...args.slice(0, execIdx), "--input-type=module", "-e", pocCode];
        const child = spawn(cmd, patchedArgs, opts);
        const origSend = child.send.bind(child);
        child.send = (msg, ...rest) => origSend({ ...msg, expectPid: child.pid }, ...rest);
        return child;
      };

      const fetchFn = createFakeFetch({ default: "never" });
      const entry = C.makeEntry({ id: "e-pac-t13-poc", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
      const transport = mod.createEntryTransport(entry, { fetch: fetchFn, spawnProcess: pocSpawn });
      declarePac(fetchFn, 'function FindProxyForURL() { return "DIRECT"; }');
      fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

      const out = await captureFetch(transport);
      assert.equal(seenCmd, "/usr/bin/sandbox-exec");
      assert.ok(Array.isArray(seenArgs) && seenArgs[0] === "-p");
      assert.equal(out.state, "ok", `PoC 沙箱进程内 IPC 回传失败：${out.error?.message ?? "(无)"}`);
      const route = routeOf(fetchFn);
      assert.equal(route.kind, "direct", `OS 拒写/拒网/拒fork/同PID 任一项未成立会路由到 9.9.9.9，实际：${JSON.stringify(route)}`);
      assert.equal(existsSync(probeFileTmp), false, "sandbox-exec 内不得写出临时文件");
      assert.equal(existsSync(probeFileRepo), false, "sandbox-exec 内不得写出仓库文件");
      assert.equal(serverConnections, 0, "sandbox-exec 内不得连入父进程监听端口");
    } finally {
      server.close();
      rmSync(probeFileTmp, { force: true });
      rmSync(probeFileRepo, { force: true });
    }
  },
);

test(
  "T13-7 darwin-only 集成（OSB-001/002/003）：真实 sandbox-exec 包裹 src/pac-eval-worker.js，合法 FindProxyForURL 行为不变",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const mod = await load(t);
    if (!mod) return;
    let capturedCmd = null;
    let capturedArgs = null;
    const spySpawn = (cmd, args, opts) => {
      capturedCmd = cmd;
      capturedArgs = args;
      return spawn(cmd, args, opts);
    };
    const fetchFn = createFakeFetch({ default: "never" });
    const entry = C.makeEntry({ id: "e-pac-t13-legal-darwin", type: "tavily", proxy: { pac: SYNTHETIC_PAC } });
    const transport = mod.createEntryTransport(entry, { fetch: fetchFn, spawnProcess: spySpawn });
    declarePac(
      fetchFn,
      "function FindProxyForURL(url, host) {" +
        '  if (!isPlainHostName(host) && dnsDomainIs(host, ".tavily.invalid") && shExpMatch(host, "*.tavily.invalid")) {' +
        `    return "PROXY ${BEHAVIOR_PROXY}; DIRECT";` +
        "  }" +
        '  return "DIRECT";' +
        "}",
    );
    fetchFn.when(TARGET).responds({ status: 200, body: { ok: true } });

    const out = await captureFetch(transport);
    assert.equal(capturedCmd, "/usr/bin/sandbox-exec", "darwin 下真跑须走 /usr/bin/sandbox-exec 包裹");
    assert.ok(Array.isArray(capturedArgs) && capturedArgs.includes(PAC_WORKER_FILE));
    assert.equal(out.state, "ok", `包裹模式下合法 PAC 必须求值成功，实际：${out.error?.message ?? "(无)"}`);
    const route = routeOf(fetchFn);
    assert.equal(route.kind, "proxy");
    assert.equal(route.proxyUrl, `http://${BEHAVIOR_PROXY}`);
    assert.equal(route.viaPac, true);
    assert.equal(route.pacIndex, 0);
  },
);
