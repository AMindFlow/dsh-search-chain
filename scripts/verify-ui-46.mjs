#!/usr/bin/env node
// Issue #46 v0.1 配置 UI 实机 DOM 验收（BCF-007，docs/specs/draft/bundle-config-ui.md）。
// 不在 npm test 内（node --test 只收 test/ 目录）。npm run verify:ui-46
//
// 与 verify-desktop-43.mjs 的关系：复用其隔离 DSH_HOME + profiles/desktop（link 本 checkout、
// 空 patch 层、pnpm install）基建；但 #43 是无窗 dsh-desktop-host + HTTP RPC，本脚本要真 DOM：
// 拉起 **真实 GUI 主程序**（Electron），经 **CDP（--remote-debugging-port）** 驱动窗口内真 DOM：
//   侧栏逐个点击直到 [data-plugin-panel] 在场（插件页无 URL 路由，契约 [C6]）
//   → li[data-plugin-package="dsh-search-chain"] 卡片 → [data-plugin-detail]（[C5] 锚点）
//   → 断言 [data-bundle-config] 配置表单在场（#46 症状：当前只有启用开关 → 本步红）
//   → 改三字段（新增条目名 / timeoutMs / 官方开关）→ [data-config-action="save"]
//   → 返回面包屑关页 → 重开卡片 → 读回三字段
//   → 回归：页内 fetch POST /api/settings/describe 必须 result.ok（#43 面不回归）。
//
// ── CDP 选型（锁死，规格「设计决定」）：node ≥24 全局 WebSocket 裸写 CDP，零 npm 依赖。
//    否决 puppeteer-core：本 worktree node_modules 是跨工作包共享软链，`npm i --no-save`
//    会污染共享 store；裸 WebSocket 足够（Runtime/Page 两个域）。
//
// ── 隔离自证（fail-closed，AGENTS「实机验证使用独立测试 profile」）：
//    主程序带独立 --user-data-dir（不触正式 Chromium profile）+ DSH_HOME=隔离目录；
//    之后在 ps 中实证 desktop-host 子进程 argv 含隔离 profile 路径（本机运行实例 argv 布局
//    实证，契约 [C7]）——证不到就 SKIP，绝不赌「可能在正式 profile 上点保存」。
//
// 退出码：0=PASS；1=断言 FAIL（预期：现实现表单不在场 → 本步红）；2=醒目 SKIP（无二进制 /
// CDP 不可达 / 全局 WebSocket 缺席 / 隔离不可证）。**禁静默绿**：exit 2 必须被巡检记为 UNVERIFIED。
// 覆盖：DSH_VERIFY_APP=/path/to/DeepSeek Harness.app （默认 /Applications/DeepSeek Harness.app）
// CDP 端口：DSH_VERIFY_CDP_PORT=<port>（默认取临时空闲端口）
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = process.env.DSH_VERIFY_APP ?? "/Applications/DeepSeek Harness.app";
const ELECTRON = join(APP, "Contents", "MacOS", "DeepSeek Harness");
const ASAR = join(APP, "Contents", "Resources", "app.asar");
const RES = join(APP, "Contents", "Resources", "runtime");
const PRIMARY_RUNTIME = join(RES, "primary-runtime");
const PNPM_MJS = join(PRIMARY_RUNTIME, "dependencies/pnpm/bin/pnpm.mjs");
const NODE_BIN = join(RES, "bin", "node");
const PKG = "dsh-search-chain";

const WATCHDOG_MS = 600_000; // 全程硬上限
const CDP_UP_MS = 90_000; // --remote-debugging-port 端点出现
const SHELL_READY_MS = 300_000; // 真 GUI 首启（profile 首装载含 link 插件）→ 侧栏在场

const REPO_ROOT = realpathSync(join(fileURLToPath(new URL(".", import.meta.url)), ".."));

function banner(text) {
  console.log(`\n${"=".repeat(72)}\n${text}\n${"=".repeat(72)}\n`);
}
function fail(msg) {
  console.log(`\n[verify-ui-46] FAIL: ${msg}\n`);
  process.exit(1);
}
function skip(reason) {
  banner("SKIP — issue #46 配置 UI 实机 DOM 面未执行（未验证，≠ 通过）\n" + reason);
  process.exit(2);
}

// ── 0) 前置：二进制 + 全局 WebSocket（选型锁死，不降级装包） ─────────────────────────────
if (!existsSync(ELECTRON) || !existsSync(ASAR) || !existsSync(NODE_BIN)) {
  skip(
    `  Electron 主程序: ${existsSync(ELECTRON) ? "OK" : "缺失"} ${ELECTRON}\n` +
      `  app.asar: ${existsSync(ASAR) ? "OK" : "缺失"} ${ASAR}\n` +
      `  runtime node: ${existsSync(NODE_BIN) ? "OK" : "缺失"} ${NODE_BIN}\n` +
      "  二进制不在本机 → fail-closed exit 2；巡检/CI 必须把 exit 2 记为 UNVERIFIED，禁止视为通过。",
  );
}
if (typeof WebSocket !== "function") {
  skip("  node 全局 WebSocket 缺席（需 node ≥24）——本脚本锁定原生 CDP，不安装 puppeteer-core。");
}
// runtime/bin/node 是 shim：`exec "$DSH_DESKTOP_NODE_EXECUTABLE" --expose-internals "$@"`——
// pnpm install 步即要用到，与 verify-desktop-43 同因在最早的时点置位。
process.env.DSH_DESKTOP_NODE_EXECUTABLE = process.env.DSH_DESKTOP_NODE_EXECUTABLE ?? ELECTRON;

// ── 1) 隔离 DSH_HOME / profiles/desktop（同 #43）+ 隔离 Chromium userData ────────────────────
const home = mkdtempSync(join(tmpdir(), "dsh-verify-ui46-"));
const DSH_HOME = join(home, "dsh-home");
const PROFILE = join(DSH_HOME, "profiles", "desktop");
const CHROME_DATA = join(home, "chromium-profile");
mkdirSync(PROFILE, { recursive: true });
mkdirSync(CHROME_DATA, { recursive: true });
writeFileSync(join(PROFILE, "package.json"), JSON.stringify({
  name: "verify-ui-46-profile",
  private: true,
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", PKG] } },
  dependencies: { [PKG]: `link:${REPO_ROOT}` },
}, null, 2) + "\n");
writeFileSync(join(PROFILE, "cordis.yml"), "[]\n");
// [C9] welcome 闸过闸配方：假 provider（apiKeyEnv 指向假环境变量名，值由下方 env 注入；baseURL 指死端口，零外呼）
// + 默认模型行 + preset 行。零真实凭据、零落盘 key。
const FAKE_ENV_NAME = "DSH_UI46_FAKE_KEY";
const FAKE_ENV_VALUE = "ui46-fake-not-a-secret";
writeFileSync(join(PROFILE, "cordis.patch.yml"), `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      ui46fake:
        displayName: ui46fake
        apiKeyEnv: ${FAKE_ENV_NAME}
        api: openai-responses
        baseURL: http://127.0.0.1:9/v1
        models:
          - id: fake/model
            name: Fake
            contextWindow: 8000
            maxTokens: 1000
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: ui46fake
    model: fake/model
    reasoningEffort: high
- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: standard
    selectedDefault: standard
`);

let child = null;
function cleanup() {
  if (child && child.exitCode === null && !child.killed) {
    try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
  }
  if (home.includes("dsh-verify-ui46-")) rmSync(home, { recursive: true, force: true });
}
process.on("exit", cleanup);
const watchdog = setTimeout(() => { cleanup(); fail(`看门狗超时（${WATCHDOG_MS} ms）`); }, WATCHDOG_MS);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 2) profile 安装（link → 本 checkout；同 #43 步骤） ─────────────────────────────────────
console.log(`[verify-ui-46] pnpm install @ ${PROFILE}`);
const inst = await run(NODE_BIN, [PNPM_MJS, "install", "--prefer-offline"], { cwd: PROFILE });
if (inst.code !== 0) {
  console.log(inst.out.slice(-4000));
  fail(`profile pnpm install 失败（exit ${inst.code}）——隔离面未建立，无法宣称通过`);
}

// ── 3) 真实 GUI 主程序 + CDP ────────────────────────────────────────────────────────────────
async function freePort() {
  if (process.env.DSH_VERIFY_CDP_PORT) return Number(process.env.DSH_VERIFY_CDP_PORT);
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const PORT = await freePort();
console.log(`[verify-ui-46] 启动真实 GUI（--remote-debugging-port=${PORT}，隔离 user-data-dir/DSH_HOME）…`);
// 陷阱（本机实测）：本会话环境带 ELECTRON_RUN_AS_NODE=1（桌面宿主注入）。若继承给 GUI 子进程，
// Electron 以纯 Node 模式解析命令行 → `bad option: --remote-debugging-port=…`、exit 9。必须剥除。
const GUI_ENV = { ...process.env };
delete GUI_ENV.ELECTRON_RUN_AS_NODE;
child = spawn(
  ELECTRON,
  [`--remote-debugging-port=${PORT}`, `--user-data-dir=${CHROME_DATA}`],
  { env: { ...GUI_ENV, DSH_HOME, [FAKE_ENV_NAME]: FAKE_ENV_VALUE }, stdio: ["ignore", "pipe", "pipe"] },
);
let log = "";
child.stdout.on("data", (d) => { log += d; });
child.stderr.on("data", (d) => { log += d; });
child.on("exit", (code, sig) => { log += `\n[app exited code=${code} sig=${sig}]\n`; });

async function until(label, budgetMs, probe) {
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) return { childExited: child.exitCode };
    const r = await probe();
    if (r) return { ok: r };
    if (Date.now() - t0 > budgetMs) return { timeout: label };
    await sleep(1500);
  }
}

const up = await until("CDP 端点", CDP_UP_MS, async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return res.ok ? await res.json() : null;
  } catch { return null; }
});
if (!up.ok) {
  if (up.childExited !== undefined) {
    skip(`  主程序提前退出（code=${up.childExited}）。可能：正式 profile GUI 在运行且实例锁未按 --user-data-dir 分离，或启动异常（tail：${log.slice(-300)}）`);
  }
  skip(`  ${CDP_UP_MS}ms 内 CDP 端点未出现在 127.0.0.1:${PORT}（无 CDP → fail-closed；不赌降级）`);
}

// ── 4) 隔离自证：desktop-host 子进程 argv 必须含隔离 profile 路径（契约 [C7]） ───────────────
const iso = await until("隔离 profile 自证", SHELL_READY_MS, () => {
  try {
    const ps = execSync("ps -ax -o command=", { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return ps.includes(PROFILE) ? true : null;
  } catch { return null; }
});
if (!iso.ok) {
  skip(
    `  未能从 ps 实证 desktop-host 以隔离 profile（${PROFILE}）启动——可能主进程未按 DSH_HOME 装载\n` +
      "  隔离 profile。为避免在正式 profile 的 GUI 上执行「保存」，fail-closed exit 2。",
  );
}
console.log("[verify-ui-46] 隔离自证 OK：desktop-host argv 含隔离 profile 路径");

// ── 5) CDP 客户端（裸 WebSocket；Runtime/Page 两域） ─────────────────────────────────────────
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) skip("  /json/list 无 page target（窗口未开）→ fail-closed exit 2");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP WS 连接失败")); });
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(`${m.error.code}: ${m.error.message}`));
    else resolve(m.result);
  }
};
function cdp(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalInPage(fnBody, timeoutMs = 120_000) {
  const r = await cdp("Runtime.evaluate", {
    expression: `(${fnBody})()`,
    returnByValue: true,
    awaitPromise: true,
    timeout: timeoutMs,
  });
  if (r.exceptionDetails) {
    throw new Error(`页内求值异常：${r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
  }
  return r.result.value;
}
await cdp("Runtime.enable");
await cdp("Page.enable");

let shot = 0;
async function snapshot(tag) {
  try {
    const png = await cdp("Page.captureScreenshot", { format: "png" });
    const p = join(tmpdir(), `dsh-verify-ui46-${tag}-${++shot}.png`);
    writeFileSync(p, Buffer.from(png.data, "base64"));
    console.log(`[verify-ui-46] 截图：${p}`);
  } catch { /* 截图尽力而为 */ }
}

// ── 6) 真 DOM 验收 ──────────────────────────────────────────────────────────────────────────
const shell = await until("侧栏在场", SHELL_READY_MS, () =>
  evalInPage(`async () => document.querySelectorAll("nav button").length > 0 || null`, 20_000).catch(() => null),
);
if (!shell.ok) {
  await snapshot("no-shell");
  const gate = await evalInPage(`async () => {
    const text = document.body?.innerText ?? "";
    return /添加 API Key|Add API key|Add API Key|登录|Sign in/.test(text) && !document.querySelector("nav button") ? text.slice(0, 300) : null;
  }`).catch(() => null);
  if (gate) {
    fail(
      "真 GUI 停在 welcome 认证闸（登录 / 添加 API Key）：隔离 profile 无登录态，未达主 shell，未进入插件页 DOM 面。" +
        "这是本机实证的实机前置条件（规格 BCF-007 注②）：dev 转绿需在脚本内补「过闸」步骤（登录或添加 key 后等待侧栏）。" +
        `页面文本头：${gate.replace(/\s+/g, " ")}`,
    );
  }
  fail(`真 GUI ${SHELL_READY_MS}ms 内未出现侧栏（nav button）——窗口未就绪/首启异常；host log tail：\n${log.slice(-2000)}`);
}

// 6a) 打开插件面板：无 URL 路由（[C6]）→ 逐个点击侧栏面板按钮直到 [data-plugin-panel] 在场
const panel = await evalInPage(`async () => {
  const q = (s) => document.querySelector(s);
  if (q("[data-plugin-panel]")) return "already";
  const navs = Array.from(document.querySelectorAll("nav button"));
  navs.sort((a, b) => (/插件|Plugins/.test(b.innerText || "") ? 1 : 0) - (/插件|Plugins/.test(a.innerText || "") ? 1 : 0));
  for (const b of navs) {
    b.click();
    await new Promise((r) => setTimeout(r, 500));
    if (q("[data-plugin-panel]")) return "opened";
  }
  return null;
}`);
if (!panel) {
  await snapshot("no-panel");
  fail("侧栏逐个点击后 [data-plugin-panel] 仍未在场（插件面板未打开——宿主 DOM 锚点漂移或窗口态异常）");
}

// 6b) 抵达 bundle 详情页（[C5] 锚点）
const detail = await evalInPage(`async () => {
  const q = (s) => document.querySelector(s);
  const card = q('li[data-plugin-package="${PKG}"]');
  if (!card) return "no-card";
  const open = () => card.querySelector("button")?.click();
  if (!q('[data-plugin-detail="${PKG}"]')) open();
  for (let i = 0; i < 40; i++) {
    if (q('[data-plugin-detail="${PKG}"]')) return "open";
    await new Promise((r) => setTimeout(r, 250));
    if (!q('[data-plugin-detail="${PKG}"]')) open();
  }
  return q('[data-plugin-detail="${PKG}"]') ? "open" : "detail-missing";
}`);
if (detail === "no-card") { fail("安装页无 li[data-plugin-package] 卡片：隔离 profile 未装载/启用本插件（见截图）"); }
if (detail !== "open") { await snapshot("detail"); fail("bundle 详情页 [data-plugin-detail] 未能打开"); }

// 6c) 断言配置表单在场（#46 症状：只有启用开关 → 现实现此处红）
const formPresent = await evalInPage(`async () =>
  !!document.querySelector('[data-plugin-detail="${PKG}"] [data-bundle-config]')`);
if (!formPresent) {
  await snapshot("no-form");
  const snippet = await evalInPage(`async () => (document.querySelector('[data-plugin-detail="${PKG}"]')?.innerText ?? "").slice(0, 600)`).catch(() => "");
  fail(
    "#46 症状复现：bundle 页描述与 rows 之间无 [data-bundle-config] 配置表单（只有启用开关）。" +
      `client 未注册 plugins.bundle.config（契约见 docs/specs/draft/bundle-config-ui.md）。详情页文本：\n${snippet}`,
  );
}

// 6c′) [C10] 反例钉：配置区不得落进 slot 错误边界（组件渲染崩溃 = FAIL，真机曾实证 host.call 版崩于此）
const slotError = await evalInPage(`async () => {
  const detail = document.querySelector('[data-plugin-detail="${PKG}"]');
  if (!detail || !detail.querySelector("[data-slot-error]")) return null;
  const host = detail.querySelector("section[data-plugin-config]") ?? detail;
  return (host.innerText ?? "").slice(0, 300);
}`);
if (slotError !== null) {
  await snapshot("slot-error");
  fail(`配置区落进 data-slot-error 错误边界（[C10] 反例钉：组件渲染抛错）；区域内文本：${slotError.replace(/\s+/g, " ")}`);
}

// 6c″a) 证据截图：表单在场（就绪前）
await snapshot("form-present");
// 6c″) 等待表单就绪（describe 投影回填前保存禁用，见组件 phase）：保存钮可用即 ready，否则 FAIL 带诊断
const ready = await until("表单就绪", 60_000, () =>
  evalInPage(`async () => { const b = document.querySelector('[data-plugin-detail="${PKG}"] [data-bundle-config] [data-config-action="save"]'); return !!b && !b.disabled; }`, 10_000).catch(() => false),
);
if (!ready.ok) {
  await snapshot("not-ready");
  const st = await evalInPage(`async () => (document.querySelector('[data-plugin-detail="${PKG}"] [data-bundle-config]')?.innerText ?? "").slice(0, 300)`).catch(() => "");
  fail(`配置表单未就绪（投影读取未回填，保存钮仍禁用）；表单文本：${st.replace(/\s+/g, " ")}`);
}

// 6d0) 诊断采集：包一层 fetch，记录页内 /api/settings/* 的回包（失败时入失败信息，不改变判定）
await evalInPage(`() => { window.__ui46 = []; window.__ui46err = []; const oce = console.error; console.error = (...x) => { window.__ui46err.push(String(x[0]).slice(0, 300)); oce.apply(console, x); }; window.addEventListener('error', (e) => window.__ui46err.push('ERR ' + String(e.message).slice(0, 300))); const of = window.fetch.bind(window);
  window.fetch = async (...args) => { const r = await of(...args); try { const u = String(args[0]); if (u.includes("/api/settings/")) { r.clone().text().then((t) => window.__ui46.push({ url: u, status: r.status, body: t.slice(0, 700) })); } } catch {} return r; };
  return true; }`);
// 6d) 改三字段 → 保存
const save = await evalInPage(`async () => {
  const root = document.querySelector('[data-plugin-detail="${PKG}"] [data-bundle-config]');
  if (!root) return "form-gone";
  const native = (el, val) => {
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const stateOf = (sw) => (sw && sw.type === "checkbox") ? sw.checked : sw?.getAttribute("aria-checked") === "true";
  root.querySelector('[data-config-action="add-entry"]')?.click();
  await new Promise((r) => setTimeout(r, 400));
  const nameFields = root.querySelectorAll('[data-config-field="entry-name"]');
  if (nameFields.length === 0) return "no-name-field";
  native(nameFields[nameFields.length - 1], "verify-46条目");
  const timeout = root.querySelector('[data-config-field="timeoutMs"]');
  if (!timeout) return "no-timeout-field";
  native(timeout, "30000");
  const sw = root.querySelector('[data-config-field="useOfficialDeepSeekSearch"]');
  if (!sw) return "no-switch-field";
  const want = !stateOf(sw);
  sw.click();
  root.querySelector('[data-config-action="save"]')?.click();
  for (let i = 0; i < 60; i++) {
    if (root.querySelector('[data-config-status="saved"]')) return JSON.stringify({ saved: true, want });
    const err = root.querySelector('[data-config-status="error"] [data-config-error], [data-config-error]');
    if (err) return JSON.stringify({ saved: false, error: (err.textContent || "").slice(0, 300) });
    await new Promise((r) => setTimeout(r, 250));
  }
  return JSON.stringify({ saved: false, error: "save-timeout（60×250ms 无 saved/error 锚点）", form: (root.innerText || "").slice(0, 400), net: window.__ui46, errs: window.__ui46err || [] });
}`);
let saveRes = null;
try { saveRes = JSON.parse(save); } catch { saveRes = { saved: false, error: String(save) }; }
if (!saveRes.saved) {
  await snapshot("save");
  fail(`保存未成功（${saveRes.error ?? saveRes}）；表单文本：${(saveRes.form ?? "").replace(/\s+/g, " ")}；页内 settings 回包：${JSON.stringify(saveRes.net ?? []).slice(0, 1500)}；控制台错误：${JSON.stringify(saveRes.errs ?? []).slice(0, 800)}——写闸/宿主写入/状态锚点（BCF-002/005）见截图`);
}

// 6e) 关页（面包屑返回）→ 重开 → 读回三字段
const readback = await evalInPage(`async () => {
  const q = (s) => document.querySelector(s);
  q('[data-plugin-detail="${PKG}"] button')?.click(); // DetailTop 面包屑 = 详情页第一个按钮
  for (let i = 0; i < 40 && q('[data-plugin-detail="${PKG}"]'); i++) await new Promise((r) => setTimeout(r, 250));
  const card = q('li[data-plugin-package="${PKG}"]');
  if (!card) return "card-missing";
  card.querySelector("button")?.click();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (q('[data-plugin-detail="${PKG}"] [data-bundle-config]')) break;
  }
  const root = q('[data-plugin-detail="${PKG}"] [data-bundle-config]');
  if (!root) return "form-missing";
  const stateOf = (sw) => (sw && sw.type === "checkbox") ? sw.checked : sw?.getAttribute("aria-checked") === "true";
  const out = { timeout: null, want: ${JSON.stringify(saveRes.want)}, official: null, entry: false };
  for (let i = 0; i < 80; i++) {
    const t = root.querySelector('[data-config-field="timeoutMs"]');
    out.timeout = t ? String(t.value ?? t.getAttribute("value")) : null;
    out.official = stateOf(root.querySelector('[data-config-field="useOfficialDeepSeekSearch"]'));
    out.entry = Array.from(root.querySelectorAll("[data-config-entry]")).some((row) => (row.textContent || "").includes("verify-46条目"));
    if (out.timeout === "30000" && out.official === out.want && out.entry) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return JSON.stringify(out);
}`);
let rb = null;
try { rb = JSON.parse(readback); } catch { rb = null; }
if (!rb || rb.timeout !== "30000" || rb.official !== rb.want || rb.entry !== true) {
  await snapshot("readback");
  fail(`关页重开读回不一致（期望 timeout=30000 / official=${saveRes.want} / 条目「verify-46条目」在场；实收 ${readback}）——保存生效面 BCF-005`);
}

// 6f) 回归：页内 fetch settings.describe 必须 ok（#43 面不回归）
const describeRaw = await evalInPage(`async () => {
  const res = await fetch(location.origin + "/api/settings/describe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "verify-46", method: "settings/describe", payload: { args: {} } }),
  });
  return JSON.stringify({ status: res.status, body: (await res.text()).slice(0, 200000) });
}`);
let d = null;
try { d = JSON.parse(describeRaw); } catch { /* 下方红 */ }
const dOk = d && (d.status === 200) && (() => {
  try { const p = JSON.parse(d.body); return p.ok === true || p.result?.ok === true; } catch { return false; }
})();
if (!dOk) {
  await snapshot("describe");
  fail(`settings.describe 非 ok（status=${d?.status}）：#43 回归被破；body 头：${(d?.body ?? describeRaw).slice(0, 500)}`);
}
if (!/search-chain/.test(d.body)) {
  await snapshot("describe-ns");
  fail("settings.describe ok 但 search-chain 命名空间缺席（#43 同款静默丢行症状，回归不通过）");
}

// ── 7) PASS ─────────────────────────────────────────────────────────────────────────────────
clearTimeout(watchdog);
await snapshot("final");
banner(`PASS — issue #46 真 DOM 面：bundle 页配置表单在场，三字段改-存-关-重开读回一致，settings.describe 回归 ok`);
try { ws.close(); } catch { /* 尽力 */ }
try { child.send?.({ type: "shutdown" }); } catch { /* 非 IPC 通道，忽略 */ }
child.kill("SIGTERM");
setTimeout(() => { child.kill("SIGKILL"); process.exit(0); }, 1500);
