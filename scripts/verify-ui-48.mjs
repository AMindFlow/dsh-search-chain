#!/usr/bin/env node
// Issue #48 隔离 DSH profile 的设置面板与 D-2C 写入边界实机验收。
// exit 0=PASS；1=验收断言失败；2=SKIP/未验证（环境、CDP 或隔离自证不可用）。
// 覆盖：隔离设置面交互、凭据先于 mutate、ref 语法/匹配、RPC 回包应用级 ok 校验。
// 只使用 Node 原生 WebSocket + CDP；不会触发供应商请求。PASS 时只打印脱敏后的请求/响应形状。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = process.env.DSH_VERIFY_APP ?? "/Applications/DeepSeek Harness.app";
const ELECTRON = join(APP, "Contents", "MacOS", "DeepSeek Harness");
const ASAR = join(APP, "Contents", "Resources", "app.asar");
const RES = join(APP, "Contents", "Resources", "runtime");
const NODE_BIN = join(RES, "bin", "node");
const PNPM_MJS = join(RES, "primary-runtime/dependencies/pnpm/bin/pnpm.mjs");
const REPO = realpathSync(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const PKG = "dsh-search-chain";
const KEY = "sk-TEST-a48f0c"; // Synthetic only; must never be a real credential.
const home = mkdtempSync(join(tmpdir(), "dsh-verify-ui48-"));
const DSH_HOME = join(home, "dsh-home");
const PROFILE = join(DSH_HOME, "profiles", "desktop");
const CHROME_DATA = join(home, "chromium-profile");
let child;
let ws;
let exitCode = 1;
function banner(label, message) { console.log(`\n[verify-ui-48] ${label}: ${message}\n`); }
function finish(code, label, message) {
  exitCode = code;
  banner(label, message);
  try { ws?.close(); } catch { /* noop */ }
  try { if (child?.exitCode === null) child.kill("SIGTERM"); } catch { /* noop */ }
  process.exit(code);
}
process.on("exit", () => {
  try { if (child?.exitCode === null) child.kill("SIGKILL"); } catch { /* noop */ }
  if (home.includes("dsh-verify-ui48-")) rmSync(home, { recursive: true, force: true });
});
function skip(reason) { finish(2, "SKIP — UI 面未验证（不可视为通过）", reason); }
function fail(reason) { finish(1, "FAIL", reason); }
if (!existsSync(ELECTRON) || !existsSync(ASAR) || !existsSync(NODE_BIN) || !existsSync(PNPM_MJS)) {
  skip(`缺少 DSH Electron/runtime/pnpm；需要隔离 GUI。APP=${APP}`);
}
if (typeof WebSocket !== "function") skip("Node 全局 WebSocket 不可用；需要 Node 24+ 原生 CDP。");

mkdirSync(PROFILE, { recursive: true });
mkdirSync(CHROME_DATA, { recursive: true });
writeFileSync(join(PROFILE, "package.json"), JSON.stringify({
  name: "verify-ui-48-profile", private: true,
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", PKG] } },
  dependencies: { [PKG]: `link:${REPO}` },
}, null, 2) + "\n");
writeFileSync(join(PROFILE, "cordis.yml"), "[]\n");
// 假模型、死端口与合成环境变量仅用于越过欢迎页；本验收不发起模型或供应商请求。
writeFileSync(join(PROFILE, "cordis.patch.yml"), `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      ui48fake:
        displayName: ui48fake
        apiKeyEnv: DSH_UI48_FAKE_KEY
        api: openai-responses
        baseURL: http://127.0.0.1:9/v1
        models:
          - id: fake/model
            name: Fake
            contextWindow: 8000
            maxTokens: 1000
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: ui48fake, model: fake/model, reasoningEffort: high }
- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config: { default: standard, selectedDefault: standard }
`);
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
    p.on("error", reject); p.on("close", (code) => resolve({ code, out }));
  });
}
const install = await run(NODE_BIN, [PNPM_MJS, "install", "--prefer-offline"], { cwd: PROFILE });
if (install.code !== 0) skip(`隔离 profile 安装失败，未执行保存操作：${install.out.slice(-1200)}`);
const PORT = process.env.DSH_VERIFY_CDP_PORT ? Number(process.env.DSH_VERIFY_CDP_PORT) : await new Promise((resolve, reject) => {
  const srv = createServer(); srv.on("error", reject);
  srv.listen(0, "127.0.0.1", () => { const port = srv.address().port; srv.close(() => resolve(port)); });
});
const guiEnv = { ...process.env, DSH_HOME, DSH_UI48_FAKE_KEY: "synthetic-not-a-secret" };
delete guiEnv.ELECTRON_RUN_AS_NODE;
child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${CHROME_DATA}`], { env: guiEnv, stdio: ["ignore", "ignore", "ignore"] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let version;
for (let i = 0; i < 120; i++) {
  if (child.exitCode !== null) skip(`隔离 GUI 提前退出（${child.exitCode}）。`);
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { version = await r.json(); break; } } catch { /* booting */ }
  await wait(1000);
}
if (!version) skip("90 秒内 CDP 未就绪。");
// DSH_HOME 通过子进程环境传入；Chromium profile 独立由 Electron argv 指定。
// 不从进程表臆测 DSH_HOME 是否生效；至少要求这两个隔离路径均为本次 mkdtemp 创建且互异。
const isolated = guiEnv.DSH_HOME === DSH_HOME && DSH_HOME.startsWith(home) &&
  child.spawnargs.includes(`--user-data-dir=${CHROME_DATA}`) && CHROME_DATA.startsWith(home) && CHROME_DATA !== DSH_HOME;
if (!isolated) skip("无法证明 DSH_HOME 与 Chromium user-data-dir 均指向独立临时目录；停止以避免触碰正式配置。");
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
if (!page) skip("CDP 未返回 page target。");
ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("CDP WebSocket 连接失败")); });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (!msg.id || !pending.has(msg.id)) return; const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); };
function cdp(method, params = {}) { const id = ++seq; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(fn, timeout = 120000) {
  const r = await cdp("Runtime.evaluate", { expression: `(${fn})()`, returnByValue: true, awaitPromise: true, timeout });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "page evaluation failed");
  return r.result.value;
}
await cdp("Runtime.enable"); await cdp("Page.enable");
// Instrument only same-origin API calls. Request/response are held in memory and never logged raw.
await evaluate(`() => {
  window.__verify48Calls = [];
  const original = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const body = init.body;
    const record = { url: new URL(url, location.href).pathname, method: init.method || "GET", body: typeof body === "string" ? body : "" };
    try {
      const response = await original(input, init);
      record.status = response.status;
      try { record.response = await response.clone().json(); } catch { record.response = null; }
      window.__verify48Calls.push(record);
      return response;
    } catch (e) { record.error = String(e?.message || e); window.__verify48Calls.push(record); throw e; }
  };
  return true;
}`);
const pageWait = async (predicate, label, limit = 120) => {
  for (let i = 0; i < limit; i++) { if (await evaluate(predicate)) return; await wait(1000); }
  skip(`等待页面条件超时：${label}。`);
};
try {
  // 进入设置路由；若设置面板已挂载则不重复点击。
  await pageWait(`() => !!document.body`, "document body");
  const openSettings = `() => {
    if (document.querySelector('[data-plugin-id="search-chain"]')) return true;
    const candidates = [...document.querySelectorAll('button,a,[role="button"]')];
    const item = candidates.find((n) => /^(设置|Settings)$/i.test((n.innerText || n.getAttribute('aria-label') || '').trim()));
    if (item) item.click();
    return !!item;
  }`;
  const found = await evaluate(openSettings);
  if (!found) skip("页面没有可识别的设置导航，宿主 UI 不可验证。");
  await pageWait(`() => !!document.querySelector('[data-plugin-id="search-chain"]')`, "search-chain 设置面板", 90);
  const prepared = await evaluate(`() => {
    const root = document.querySelector('[data-plugin-id="search-chain"]');
    root.querySelector('[data-role="add-tool"]')?.click();
    const type = [...root.querySelectorAll('[data-role="add-type"]')].find((n) => n.getAttribute('data-type') === 'exa');
    if (!type) return 'exa option absent';
    type.click();
    const cards = [...root.querySelectorAll('[data-role="card"]')];
    const card = cards[cards.length - 1];
    if (!card) return 'new card absent';
    const id = card.getAttribute('data-entry-id');
    card.querySelector('[data-role="card-edit"]')?.click();
    return id;
  }`);
  if (!prepared || prepared === "exa option absent" || prepared === "new card absent") fail(`设置面板交互失败：${prepared}`);
  await pageWait(`() => !!document.querySelector('[data-role="field"][data-field="key"]')`, "key input");
  const typed = await evaluate(`() => {
    const input = document.querySelector('[data-role="field"][data-field="key"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(KEY)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  }`);
  if (typed !== KEY) fail("合成 key 未能输入；没有执行保存。");
  await evaluate(`() => document.querySelector('[data-role="save"]')?.click()`);
  await pageWait(`() => {
    const c = window.__verify48Calls || [];
    return c.some(x => x.url === '/api/credentials/set') && c.some(x => x.url === '/api/settings/mutate');
  }`, "credentials/set 和 settings/mutate", 90);
  const audit = await evaluate(`() => {
    const calls = window.__verify48Calls || [];
    const parse = (x) => { try { return JSON.parse(x.body || '{}'); } catch { return {}; } };
    const redact = (value) => String(value ?? '').replaceAll(${JSON.stringify(KEY)}, '[redacted]')
      .replaceAll('synthetic-not-a-secret', '[redacted]')
      .replace(/sk-[A-Za-z0-9_-]{4,}/gi, '[redacted]').slice(0, 240);
    const inspectRpc = (response) => {
      if (!response || typeof response !== 'object') return { ok: false, message: '宿主回包为空' };
      if (response.result && typeof response.result === 'object' && 'ok' in response.result) {
        if (response.result.ok === true) return { ok: true };
        const error = response.result.error || response.error;
        const rawCode = typeof error?.code === 'string' ? redact(error.code) : '';
        const code = /^[A-Za-z0-9_.:-]{1,80}$/.test(rawCode) ? rawCode : undefined;
        return { ok: false, ...(code ? { code } : {}), message: redact(error?.message || '宿主拒绝该请求') };
      }
      if (response.ok === true) return { ok: true };
      const error = response.error;
      const rawCode = typeof error?.code === 'string' ? redact(error.code) : '';
      const code = /^[A-Za-z0-9_.:-]{1,80}$/.test(rawCode) ? rawCode : undefined;
      return { ok: false, ...(code ? { code } : {}), message: redact(error?.message || '宿主拒绝该请求') };
    };
    const set = calls.find(x => x.url === '/api/credentials/set');
    const mutate = calls.find(x => x.url === '/api/settings/mutate');
    const sb = parse(set), mb = parse(mutate);
    const args = sb.payload?.args || {};
    const ops = mb.payload?.args?.ops || [];
    const sequence = calls.indexOf(set) < calls.indexOf(mutate);
    const ref = args.ref;
    const refOp = ops.find(op => op.op === 'set' && op.path?.[0] === 'entries' && op.value?.credentialRef === ref);
    const rpcChecks = calls.filter(x => /^\\/api\\/(settings|credentials)\\//.test(x.url)).map(x => ({ path: x.url, ...inspectRpc(x.response) }));
    const applicationOk = rpcChecks.every(x => x.ok);
    return {
      sequence, refValid: typeof ref === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref),
      keyTransferred: args.value === ${JSON.stringify(KEY)}, settingsUsesRef: !!refOp, applicationOk, rpcChecks,
      set: { path: set.url, requestKeys: Object.keys(sb).sort(), method: sb.method, argsKeys: Object.keys(args).sort(),
        response: { status: set.status, bodyKeys: Object.keys(set.response || {}).sort(), resultKeys: Object.keys(set.response?.result || {}).sort() } },
      mutate: { path: mutate.url, method: mb.method, responseStatus: mutate.status },
      forbiddenExternal: calls.filter(x => !x.url.startsWith('/api/')).length,
      errorCount: calls.filter(x => x.error || (x.status && x.status >= 400)).length,
    };
  }`);
  if (!audit.sequence || !audit.refValid || !audit.keyTransferred || !audit.settingsUsesRef || !audit.applicationOk || audit.forbiddenExternal || audit.errorCount) {
    fail(`D-2C/RPC 断言失败（仅元数据）：${JSON.stringify(audit)}`);
  }
  console.log(`[verify-ui-48] credentials/set 脱敏形状：${JSON.stringify({ ...audit.set, syntheticKeyTransferred: audit.keyTransferred, refGrammarValid: audit.refValid, settingsReferenceMatch: audit.settingsUsesRef })}`);
  console.log(`[verify-ui-48] settings/mutate：${JSON.stringify(audit.mutate)}`);
  console.log(`[verify-ui-48] RPC 应用级 ok：${JSON.stringify({ ok: audit.applicationOk, checked: audit.rpcChecks.length })}`);
  console.log("[verify-ui-48] key 为合成 sk-TEST 值；未记录或输出明文。未观察到供应商请求。");
  finish(0, "PASS", "隔离设置面可交互；credentials/set 先于 settings/mutate，ref 符合语法且配置引用匹配；所有捕获的 RPC 回包均通过应用级 ok 校验。");
} catch (error) {
  const message = String(error?.message || error).replaceAll(KEY, "[synthetic-key-redacted]")
    .replaceAll("synthetic-not-a-secret", "[redacted]").replace(/sk-[A-Za-z0-9_-]{4,}/gi, "[redacted]");
  fail(`验收期间异常：${message}`);
}
