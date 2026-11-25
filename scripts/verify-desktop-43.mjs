#!/usr/bin/env node
// Issue #43 实机验收面（不在 npm test 内：node --test 只收 test/ 目录；本脚本走独立隔离 Host）。
//
// 复现面（对齐 #43 报告）：隔离 DSH_HOME + profiles/desktop 只装 bundle（@deepseek-ai/dsh-base +
// @deepseek-ai/dsh-web-app）与本 checkout 的 link 插件、空 patch 层，然后按 Desktop 主进程的
// 同款命令行拉起 app 内置 dsh-desktop-host（同版本 Electron/asar，零改动），走环回 cookie 认证后
// POST /api/settings/describe：
//   缺陷态（手写 Config 无 meta）：volatileForm 在 schema.meta.volatile 取属性抛 TypeError →
//     settings.describe 返回 gateway/internal → 本脚本红；
//   修复态：result.ok 且命名空间含 search-chain → 本脚本绿。
// 本仓库无 Desktop 二进制时【绝不静默绿】：打印醒目 SKIP 块并 exit 2（CI/巡检必须把 exit 2 当
// 「未验证」而不是「通过」）。
//
// 用法：node scripts/verify-desktop-43.mjs
// 覆盖：DSH_VERIFY_APP=/path/to/DeepSeek Harness.app （默认 /Applications/DeepSeek Harness.app）
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = process.env.DSH_VERIFY_APP ?? "/Applications/DeepSeek Harness.app";
const ELECTRON = join(APP, "Contents", "MacOS", "DeepSeek Harness");
const ASAR = join(APP, "Contents", "Resources", "app.asar");
const MODULE_DIR = join(ASAR, "dsh"); // argv[2]：runtimeDir（installAnchor = 其下 @deepseek-ai/dsh）
const ENTRY = join(MODULE_DIR, "node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js");
const RES = join(APP, "Contents", "Resources", "runtime");
const PRIMARY_RUNTIME = join(RES, "primary-runtime");
const PNPM_MJS = join(PRIMARY_RUNTIME, "dependencies/pnpm/bin/pnpm.mjs");
const NODE_BIN = join(RES, "bin", "node");
const NODE_BIN_DIR = join(RES, "bin");

const REPO_ROOT = realpathSync(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
// runtime/bin/node 是 shim：`exec "$DSH_DESKTOP_NODE_EXECUTABLE" --expose-internals "$@"`——
// 变量由 Desktop 主进程注入且真身就是 Electron 二进制（ELECTRON_RUN_AS_NODE 模式）。如实复刻。
process.env.DSH_DESKTOP_NODE_EXECUTABLE = process.env.DSH_DESKTOP_NODE_EXECUTABLE ?? ELECTRON;
const WATCHDOG_MS = 420_000; // 全程硬上限
const READY_MS = 180_000; // ready IPC 等待上限（首次 install 后装载含 link 插件）

function fail(msg, code = 1) {
  console.log(`\n[verify-desktop-43] FAIL: ${msg}\n`);
  process.exit(code);
}
function banner(text) {
  console.log(`\n${"=".repeat(72)}\n${text}\n${"=".repeat(72)}\n`);
}

// asar 内路径对普通 fs 不可见（app.asar 是归档文件；只有 Electron 的补丁 fs 能打开其虚拟路径）。
// 入口存在性由 Electron 子进程实证（缺失 → 子进程 ENOENT 提前退出 → 本脚本红），此处只查归档本体。
if (!existsSync(ELECTRON) || !existsSync(ASAR) || !existsSync(NODE_BIN)) {
  banner(
    "SKIP — issue #43 Desktop 实机面未执行（未验证，≠ 通过）\n" +
      `  Electron 主程序: ${existsSync(ELECTRON) ? "OK" : "缺失"} ${ELECTRON}\n` +
      `  app.asar（desktop-host 入口所在归档）: ${existsSync(ASAR) ? "OK" : "缺失"} ${ASAR}\n` +
      `  runtime node: ${existsSync(NODE_BIN) ? "OK" : "缺失"} ${NODE_BIN}\n` +
      "  二进制不在本机 → fail-closed exit 2；巡检/CI 必须把 exit 2 记为 UNVERIFIED，禁止视为通过。",
  );
  process.exit(2);
}

// ── 隔离 DSH_HOME / profiles/desktop（模拟 Desktop 主进程的 profile 布局，空 patch 层） ──────────
const home = mkdtempSync(join(tmpdir(), "dsh-verify-43-"));
const DSH_HOME = join(home, "dsh-home");
const PROFILE = join(DSH_HOME, "profiles", "desktop");
mkdirSync(PROFILE, { recursive: true });
writeFileSync(join(PROFILE, "package.json"), JSON.stringify({
  name: "verify-desktop-43-profile",
  private: true,
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-search-chain"] } },
  dependencies: { "dsh-search-chain": `link:${REPO_ROOT}` },
}, null, 2) + "\n");
// 注：bundle 必须进 bundles 数组才会装载（link 依赖本身不激活）；装载后包自带 dsh.bundle.patch
// （src/cordis.patch.yml）插入 search-chain 行——正是 #43 现场：该行的 runtime.Config 进 describe。
writeFileSync(join(PROFILE, "cordis.yml"), "[]\n");
writeFileSync(join(PROFILE, "cordis.patch.yml"), "[]\n");

let child = null;
function cleanup() {
  if (child && child.exitCode === null && !child.killed) {
    try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
  }
  if (home.includes("dsh-verify-43-")) rmSync(home, { recursive: true, force: true });
}
process.on("exit", cleanup);
const watchdog = setTimeout(() => { cleanup(); fail(`看门狗超时（${WATCHDOG_MS} ms）：Desktop host 未在预算内就绪`); }, WATCHDOG_MS);
watchdog.unref?.();

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out }));
  });
}

// ── 1) profile 安装（link → 本 checkout；bundles 由 installAnchor 解析在 app.asar 内） ──────────
console.log(`[verify-desktop-43] pnpm install @ ${PROFILE}`);
const inst = await run(NODE_BIN, [PNPM_MJS, "install", "--prefer-offline"], { cwd: PROFILE });
if (inst.code !== 0) {
  console.log(inst.out.slice(-4000));
  fail(`profile pnpm install 失败（exit ${inst.code}）——隔离面未建立，无法宣称修复；见上方输出`);
}

// ── 2) 拉起 Desktop 同款 host 子进程（argv 契约实证自本机运行中主进程的 ps 原文） ───────────────
console.log("[verify-desktop-43] 启动 dsh-desktop-host（ELECTRON_RUN_AS_NODE + 同版本 asar）…");
child = spawn(
  ELECTRON,
  ["--expose-internals", ENTRY, MODULE_DIR, PROFILE, PRIMARY_RUNTIME, PNPM_MJS, NODE_BIN_DIR],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DSH_HOME },
    stdio: ["ipc", "pipe", "pipe"],
  },
);
let log = "";
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
child.on("exit", (code, sig) => { log += `\n[host exited code=${code} sig=${sig}]\n`; });

const ready = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`等待 {type:'ready'} IPC 超时（${READY_MS} ms）`)), READY_MS);
  child.on("message", (m) => {
    if (m && m.type === "ready" && typeof m.url === "string") {
      clearTimeout(t);
      resolve(m.url);
    }
  });
  child.on("exit", (c) => { clearTimeout(t); reject(new Error(`host 提前退出 code=${c}`)); });
  child.on("error", reject);
}).catch((e) => { console.log(log.slice(-4000)); fail(`Desktop host 未就绪：${e.message}`); });

// ── 3) 环回认证：authenticatedUrl（token query）→ Set-Cookie 铸造 ──────────────────────────────
let cookie = null;
let target = new URL(ready);
for (let hop = 0; hop < 6 && cookie === null; hop++) {
  const res = await fetch(target, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const c of sc) cookie = c.split(";")[0];
  if (res.status === 200 && cookie) break;
  const loc = res.headers.get("location");
  if (!loc) break;
  target = new URL(loc, target);
}
if (!cookie) { console.log(log.slice(-4000)); fail(`token→cookie 铸造失败（authenticatedUrl=${ready.replace(/[?&]token=[^&]*/, "?token=…")}）`); }

// ── 4) settings.describe：#43 崩溃面直测 ───────────────────────────────────────────────────────
// 环回网关线格式（本机实机实测原文，两级报错 schema 自证）：
//   请求 POST /api/settings/describe，body = {type:"client-request", rpcId:string, method:string,
//                                              payload:{args:{…}}}   ← Remote payload 恰含一个 plain-object args
//   响应 = {type:"server-response", rpcId, result:{ok, value|error{code,message,details}}}
//   ——#43 缺陷态即 result.error.code = "gateway/internal"（且 message 非本脚本负载畸形所致）。
const origin = `${target.protocol}//${target.host}`;
const res = await fetch(`${origin}/api/settings/describe`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ type: "client-request", rpcId: "verify-43", method: "settings/describe", payload: { args: {} } }),
});
const lastRaw = await res.text(); // 响应是逐命名空间 refs 大对象：解析必须全文，展示才截断
let parsed = null;
try { parsed = JSON.parse(lastRaw); } catch { /* 下方红 */ }
if (!parsed) { console.log(log.slice(-4000)); fail(`describe 响应不可解析：${lastRaw.slice(0, 3000)}`); }

const ok = parsed.ok === true || parsed.result?.ok === true;
if (!ok) {
  const txt = JSON.stringify(parsed);
  banner("FAIL — #43 复现确认（修复前预期形态）");
  console.log(txt.slice(0, 4000));
  if (/gateway\/internal/.test(txt)) console.log("→ settings.describe = gateway/internal（#43 报告原文一致）");
  if (/Cannot read properties of undefined \(reading 'volatile'\)/.test(txt)) {
    console.log("→ 崩溃签名命中 volatileForm 读取位：schema.meta.volatile（手写 Config 无 meta）");
  }
  console.log(`--- host log tail ---\n${log.slice(-2500)}`);
  fail("settings.describe 非 ok：settings-form 契约未修复");
}

const flat = [];
(function dig(v) {
  if (v === null || typeof v !== "object") return;
  if (typeof v.ns === "string") flat.push(v.ns);
  if (typeof v.namespace === "string") flat.push(v.namespace);
  for (const c of Object.values(v)) dig(c);
})(parsed);
const namespaces = [...new Set(flat)];
if (!namespaces.some((ns) => ns.includes("search-chain"))) {
  banner("FAIL — describe.ok 但 search-chain 命名空间缺席");
  console.log(`发现命名空间：${JSON.stringify(namespaces)}\n（无 volatile 字段 ⇒ volatileForm=undefined ⇒ describe 静默丢行，同属 #43 症状；亦可能是行未激活，见下方宿主日志）`);
  console.log(`--- host log tail ---\n${log.slice(-4000)}`);
  fail("search-chain 未出现在 settings.describe 结果中");
}

clearTimeout(watchdog);
banner("PASS — issue #43 Desktop 实机面：settings.describe ok 且 search-chain 命名空间在场");
console.log(`命名空间：${JSON.stringify(namespaces)}`);
try { child.send({ type: "shutdown" }); } catch { /* 尽力而为 */ }
setTimeout(() => { child.kill("SIGTERM"); process.exit(0); }, 1500);
