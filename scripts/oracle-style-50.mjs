#!/usr/bin/env node
// Issue #50/#52 样式锁定 + 保存读回 Oracle（Refs #50）。
// 断言目录 = GPT-6 Luna High（codex exec -m gpt-6-luna -c model_reasoning_effort='"high"'）定稿，
// 原样嵌入于下方 CATALOG_TEXT（运行时 JSON.parse 校验字节完整性）；本脚本是忠实转录层：
// 每行 id/spec/target/method/expected/failPolicy 逐字来自该目录（docs/specs/draft/settings-panel-style-lock.md
// SPC-001..030 + §4 token 表、docs/specs/draft/settings-ui.md SET-001..005 为其值来源），实现者不增删改断言语义。
// Luna 裁定（meta.verdicts）：暗态=真实宿主页直设 body[data-ds-dark-theme]（真实暗色 CSS 状态实证，
// 注明非宿主主题 UI 切换实证）；原生 HTML5 拖拽不可达→SKIP 记 gap（不得伪装 PASS），键盘排序必做；
// HEAD fdf09e8 校准首跑全量运行 A+B，不因首个 FAIL 短路。
// exit 0=零 FAIL（SKIP 如实登记 gap）；1=存在 FAIL；2=环境/隔离自证失败（整轮 SKIP，不可视为通过）。
// 复用 scripts/verify-ui-48.mjs 模式：隔离 DSH_HOME + 独立 Chromium user-data-dir + 假模型越欢迎页 +
// 原生 WebSocket CDP + fetch/XHR 插桩（跨 reload 经 sessionStorage 累加）。
// 凭据仅合成 sk-TEST-oracle-* 值；断言表/日志/raw 证据零明文（B-003 自证）。不 push。
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
const PNPM_MJS = join(RES, "primary-runtime", "dependencies", "pnpm", "bin", "pnpm.mjs");
const REPO = realpathSync(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const PKG = "dsh-search-chain";
const ART_DIR = join(REPO, "artifacts", "oracle-style-50");
const KEY_A = "sk-TES…cle-a1";
const KEY_B = "sk-TES…cle-b2";
const FAKE_ENV = "synthetic-not-a-secret";
const HOME_MARKER = "dsh-oracle-style50-";
const home = mkdtempSync(join(tmpdir(), HOME_MARKER));
const DSH_HOME = join(home, "dsh-home");
const PROFILE = join(DSH_HOME, "profiles", "desktop");
const CHROME_DATA = join(home, "chromium-profile");
const ROOT = '[data-plugin-id="search-chain"]';

let child;
let ws;
function banner(label, message) { console.log(`\n[oracle-style-50] ${label}: ${message}\n`); }
function finish(code, label, message) {
  banner(label, message);
  try { ws?.close(); } catch { /* noop */ }
  try { if (child?.exitCode === null) child.kill("SIGTERM"); } catch { /* noop */ }
  process.exit(code);
}
process.on("exit", () => {
  try { if (child?.exitCode === null) child.kill("SIGKILL"); } catch { /* noop */ }
  if (home.includes(HOME_MARKER)) rmSync(home, { recursive: true, force: true });
});
function skipAll(reason) { finish(2, "SKIP — 环境/隔离自证未通过（不可视为通过）", reason); }
if (!existsSync(ELECTRON) || !existsSync(ASAR) || !existsSync(PNPM_MJS)) skipAll(`缺少 DSH Electron/app.asar/pnpm；APP=${APP}`);
if (typeof WebSocket !== "function") skipAll("Node 全局 WebSocket 不可用；需要 Node 24+。");
// 环境纠偏（harness 自证范围内）：0.2.2-rc.5 runtime/bin/node 是依赖 DSH_DESKTOP_NODE_EXECUTABLE 的 wrapper，
// 直接 spawn 报 `exec: : not found`；以本进程 Node（engines>=24）驱动 pnpm。
const NODE_BIN = process.execPath;

mkdirSync(PROFILE, { recursive: true });
mkdirSync(CHROME_DATA, { recursive: true });
mkdirSync(ART_DIR, { recursive: true });
writeFileSync(join(PROFILE, "package.json"), JSON.stringify({
  name: "oracle-style-50-profile", private: true,
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", PKG] } },
  dependencies: { [PKG]: `link:${REPO}` },
}, null, 2) + "\n");
writeFileSync(join(PROFILE, "cordis.yml"), "[]\n");
// 假模型 provider 指向死端口仅用于越过欢迎页；全程模型与供应商请求应为零（B-006 审计）。
writeFileSync(join(PROFILE, "cordis.patch.yml"), `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      oracle50fake:
        displayName: oracle50fake
        apiKeyEnv: DSH_ORACLE50_FAKE_KEY
        api: openai-responses
        baseURL: http://127.0.0.1:9/v1
        models:
          - id: fake/model
            name: Fake
            contextWindow: 8000
            maxTokens: 1000
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: { provider: oracle50fake, model: fake/model, reasoningEffort: high }
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
if (install.code !== 0) skipAll(`隔离 profile 安装失败：${install.out.slice(-1200)}`);
const PORT = process.env.DSH_ORACLE_CDP_PORT ? Number(process.env.DSH_ORACLE_CDP_PORT) : await new Promise((resolve, reject) => {
  const srv = createServer(); srv.on("error", reject);
  srv.listen(0, "127.0.0.1", () => { const port = srv.address().port; srv.close(() => resolve(port)); });
});
const guiEnv = { ...process.env, DSH_HOME, DSH_ORACLE50_FAKE_KEY: FAKE_ENV };
delete guiEnv.ELECTRON_RUN_AS_NODE;
child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${CHROME_DATA}`], { env: guiEnv, stdio: ["ignore", "ignore", "ignore"] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let version;
for (let i = 0; i < 120; i++) {
  if (child.exitCode !== null) skipAll(`隔离 GUI 提前退出（${child.exitCode}）。`);
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { version = await r.json(); break; } } catch { /* booting */ }
  await wait(1000);
}
if (!version) skipAll("120 秒内 CDP 未就绪。");
const isolated = guiEnv.DSH_HOME === DSH_HOME && DSH_HOME.startsWith(home) &&
  child.spawnargs.includes(`--user-data-dir=${CHROME_DATA}`) && CHROME_DATA.startsWith(home) && CHROME_DATA !== DSH_HOME;
if (!isolated) skipAll("无法证明 DSH_HOME 与 Chromium user-data-dir 均指向本次独立临时目录；停止以避免触碰正式配置。");
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
if (!page) skipAll("CDP 未返回 page target。");
ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("CDP WebSocket 连接失败")); });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (!msg.id || !pending.has(msg.id)) return; const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); };
function cdp(method, params = {}) { const id = ++seq; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(fn, timeout = 120000) {
  // 兼容三种调用形态：真实函数（toString 包裹）、`() => ...` 箭头串（包裹调用）、`(() => {...})()` 自执行 IIFE 串（原样传递）。
  const raw = typeof fn === "function" ? `(${fn.toString()})()` : String(fn).trim().endsWith(")()") ? String(fn) : `(${String(fn)})()`;
  const r = await cdp("Runtime.evaluate", { expression: raw, returnByValue: true, awaitPromise: true, timeout });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text || "page evaluation failed").slice(0, 400));
  return r.result.value;
}
await cdp("Runtime.enable"); await cdp("Page.enable");
// 宽视口稳定（SPC-001 720px 钳制前提）+ 插桩跨 reload 存活（addScriptToEvaluateOnNewDocument + sessionStorage 累加器）。
await cdp("Emulation.setDeviceMetricsOverride", { width: 1300, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => {});
const INSTRUMENT = () => {
  window.__oracle50 = window.__oracle50 || { onlySynthetic: true, responseEchos: 0, envEchoes: 0 };
  // 记录为紧凑形态（页内解析的应用级 ok 布尔，绝不存回包原文——run-4 实证大回包会打满 sessionStorage 配额）。
  // 权威累加器是 sessionStorage 追加数组：跨 Page.reload 历史连续，且紧凑尺寸不会触顶配额。
  const KEYS = window.__oracle50Keys || [];
  const okFrom = (json) => {
    try {
      if (json && json.result && typeof json.result === "object" && "ok" in json.result) return json.result.ok === true;
      return !!(json && json.ok === true);
    } catch { return null; }
  };
  const store = (rec) => {
    try {
      const arr = JSON.parse(sessionStorage.getItem("__oracle50Calls") || "[]");
      arr.push(rec); sessionStorage.setItem("__oracle50Calls", JSON.stringify(arr));
    } catch { /* 存储异常不得影响被测应用；紧凑记录实测远低于配额 */ }
  };
  const inspectValue = (body) => {
    try {
      const args = JSON.parse(body)?.payload?.args || {};
      if ("value" in args && !KEYS.includes(args.value)) window.__oracle50.onlySynthetic = false;
    } catch { /* 非 JSON body */ }
  };
  const inspectResponse = (json) => {
    try {
      const s = JSON.stringify(json) || "";
      if (KEYS.some((k) => s.includes(k))) window.__oracle50.responseEchos += 1;
      if (s.includes("synthetic-not-a-secret")) window.__oracle50.envEchoes += 1;
    } catch { /* noop */ }
  };
  if (!window.__oracle50Patched) {
    window.__oracle50Patched = true;
    const original = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : (input && input.url) || String(input);
      const body = init && init.body;
      const record = { url: new URL(url, location.href).pathname, method: (init && init.method) || "GET", hasBody: typeof body === "string", via: "fetch", t: Date.now() };
      inspectValue(typeof body === "string" ? body : "");
      try {
        const response = await original(input, init);
        record.status = response.status;
        try { const json = await response.clone().json(); record.ok = okFrom(json); inspectResponse(json); } catch { record.ok = null; }
        store(record);
        return response;
      } catch (e) { record.error = String((e && e.message) || e); record.ok = false; store(record); throw e; }
    };
    const X = window.XMLHttpRequest;
    const open = X.prototype.open; const send = X.prototype.send;
    X.prototype.open = function (method, url) { this.__o50 = { method, path: new URL(url, location.href).pathname, via: "xhr", t: Date.now() }; return open.apply(this, arguments); };
    X.prototype.send = function (body) {
      if (this.__o50) {
        inspectValue(typeof body === "string" ? body : "");
        const rec2 = this.__o50;
        this.addEventListener("load", () => { try { rec2.status = this.status; const json = JSON.parse(this.responseText); rec2.ok = okFrom(json); inspectResponse(json); } catch { rec2.ok = null; } store(rec2); });
      }
      return send.apply(this, arguments);
    };
  }
  return true;
};
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `window.__oracle50Keys=${JSON.stringify([KEY_A, KEY_B])};(${INSTRUMENT.toString()})();` });
await evaluate(`() => { window.__oracle50Keys=${JSON.stringify([KEY_A, KEY_B])}; return (${INSTRUMENT.toString()})(); }`);
const pageWait = async (predicate, label, limit = 120) => {
  for (let i = 0; i < limit; i++) { if (await evaluate(predicate)) return; await wait(1000); }
  skipAll(`等待页面条件超时：${label}。`);
};

// ───────── Luna 断言目录（GPT-6 Luna High 定稿，原样嵌入） ─────────
const CATALOG_TEXT = "{\n  \"meta\": {\n    \"model\": \"GPT-6 Luna High\",\n    \"role\": \"independent read-only acceptance oracle\",\n    \"basis\": [\n      \"docs/specs/draft/settings-panel-style-lock.md\",\n      \"docs/specs/draft/settings-ui.md\",\n      \"src/client-entry.js\",\n      \"scripts/verify-ui-48.mjs\"\n    ],\n    \"calibrationHead\": \"fdf09e8\",\n    \"verdicts\": {\n      \"darkTheme\": \"\u8bbe\u7f6e\u771f\u5b9e\u5bbf\u4e3b\u9875 body[data-ds-dark-theme] \u5c5e\u6027\u540e\u6267\u884c\u53cc\u4e3b\u9898\u65ad\u8a00\uff1b\u79f0\u4e3a\u771f\u5b9e\u6697\u8272 CSS \u72b6\u6001\u5b9e\u8bc1\uff0c\u5e76\u6ce8\u660e\u4e0d\u662f\u5bbf\u4e3b\u4e3b\u9898 UI \u5207\u6362\u5b9e\u8bc1\u3002\",\n      \"html5Drag\": \"\u539f\u751f\u62d6\u62fd\u5c1d\u8bd5\u540e\u4e0d\u53ef\u8fbe\u53ef SKIP \u5e76\u8bb0 gap\uff1b\u952e\u76d8 ArrowUp/ArrowDown \u6392\u5e8f\u5fc5\u505a\u3002\u62d6\u62fd\u89c4\u5219\u6587\u672c\u548c data-dragging \u89c4\u5219\u5fc5\u505a\u3002\",\n      \"calibration\": \"HEAD \u9996\u8dd1\u5168\u91cf\u8fd0\u884c A+B\uff1b\u4e0d\u56e0\u9996\u4e2a FAIL \u77ed\u8def\u3002\",\n      \"exit\": \"\u73af\u5883\u6216\u9694\u79bb\u81ea\u8bc1\u5931\u8d25 exit 2\uff1b\u4efb\u4e00\u65ad\u8a00 FAIL exit 1\uff1b\u96f6 FAIL exit 0\uff0c\u4fdd\u7559 SKIP gaps\u3002\"\n    },\n    \"redaction\": \"\u65ad\u8a00\u8868\u4e0e\u65e5\u5fd7\u4e0d\u5f97\u5305\u542b sk-TEST-oracle-* \u660e\u6587\uff1b\u53d1\u73b0\u660e\u6587\u5219\u8131\u654f\u81ea\u8bc1 FAIL\u3002\"\n  },\n  \"phases\": [\n    {\n      \"name\": \"dataSetup\",\n      \"steps\": [\n        \"\u542f\u52a8\u771f DSH Electron\uff0c\u8bbe\u7f6e\u672c\u6b21 mkdtemp DSH_HOME \u4e0e\u72ec\u7acb Chromium user-data-dir\uff1b\u5047\u6a21\u578b provider \u6307\u5411\u6b7b\u7aef\u53e3\u3002\",\n        \"\u7b49\u5f85 CDP\u3001\u9875\u9762 body\u3001\u8bbe\u7f6e\u8def\u7531\u548c [data-plugin-id=\\\"search-chain\\\"]\uff1bfetch \u63d2\u6869\u5728\u8bbe\u7f6e\u4ea4\u4e92\u524d\u5b89\u88c5\u3002\",\n        \"\u9996\u6b21\u7a7a\u914d\u7f6e\u8fdb\u5165\u8bbe\u7f6e\uff1b\u7b49\u5f85 /api/settings/describe \u6210\u529f\u3001empty-state \u53ef\u89c1\u3002\"\n      ],\n      \"waitFor\": \"\u9694\u79bb\u81ea\u8bc1\u6210\u7acb\uff1b\u8bbe\u7f6e\u9762\u677f\u6302\u8f7d\uff1bdescribe \u5e94\u7528\u7ea7 ok\u3002\u5931\u8d25\u6309\u5168\u5c40\u73af\u5883\u89c4\u5219 exit 2\u3002\"\n    },\n    {\n      \"name\": \"default\",\n      \"steps\": [\n        \"\u7a7a\u914d\u7f6e\u65f6\u91c7\u96c6\u57fa\u7840\u6837\u5f0f\u3001\u9ed8\u8ba4 official-toggle checked \u548c\u7a7a\u72b6\u6001\u3002\",\n        \"\u521b\u5efa token probe \u540e\u8bfb\u53d6\u540c\u4e3b\u9898\u8ba1\u7b97\u8272\uff1b\u4eae\u8272\u5148\u6d4b\u3002\"\n      ],\n      \"waitFor\": \"React \u72b6\u6001\u7a33\u5b9a\u4e14\u76ee\u6807\u5143\u7d20\u5b58\u5728\u3002\"\n    },\n    {\n      \"name\": \"pickerOpen\",\n      \"steps\": [\n        \"\u70b9\u51fb [data-role=\\\"add-tool\\\"]\u3002\",\n        \"\u7b49\u5f85 [data-role=\\\"add-type\\\"] \u53ef\u89c1\uff0c\u91c7\u96c6 picker \u5bb9\u5668\u3001\u9879\u3001\u6807\u9898\u3001\u8ba1\u8d39\u4e0e\u622a\u56fe\u3002\"\n      ],\n      \"waitFor\": \"picker \u81f3\u5c11\u4e00\u9879\u53ef\u89c1\u3002\"\n    },\n    {\n      \"name\": \"editorOpen\",\n      \"steps\": [\n        \"\u9009\u62e9 exa\uff0c\u7b49\u5f85\u65b0\u5361\uff1b\u70b9\u5176 [data-role=\\\"card-edit\\\"]\u3002\",\n        \"\u7b49\u5f85 [data-role=\\\"editor\\\"] \u4e0e field[name, credentialRef, key] \u6302\u8f7d\uff1bkey \u4ec5\u7528 password \u8f93\u5165\u4e14\u4efb\u4f55\u8bb0\u5f55\u8131\u654f\u3002\"\n      ],\n      \"waitFor\": \"editor \u4e0e\u9884\u671f\u5b57\u6bb5\u53ef\u89c1\u3002\"\n    },\n    {\n      \"name\": \"afterSave\",\n      \"steps\": [\n        \"\u65b0\u5efa exa\u3001exa\u3001bing\uff0c\u987a\u5e8f\u5373\u521b\u5efa\u987a\u5e8f\uff1b\u4e24\u4e2a exa \u5206\u522b\u8f93\u5165\u4e0d\u540c sk-TEST-oracle-* \u5408\u6210 key\uff0cbing \u4e0d\u8f93\u5165 key\u3002\",\n        \"\u70b9\u51fb\u4fdd\u5b58\uff1b\u7b49\u5f85\u672c\u8f6e credentials/set\uff08\u4ec5\u4e24\u4e2a exa\uff09\u4e0e settings/mutate \u5747\u8fd4\u56de\u5e94\u7528\u7ea7 ok\uff0c\u4e14\u4fdd\u5b58\u72b6\u6001\u7ed3\u675f\u3002\"\n      ],\n      \"waitFor\": \"\u4fdd\u5b58\u64cd\u4f5c\u5b8c\u6210\uff1b\u6bcf\u4e2a\u51ed\u636e\u5199\u5165\u5148\u4e8e\u5bf9\u5e94 mutate\uff1b\u65e0\u5916\u90e8\u8bf7\u6c42\u3002\"\n    },\n    {\n      \"name\": \"afterReload\",\n      \"steps\": [\n        \"Page.reload\uff1b\u7b49\u5f85\u9875\u9762 body \u540e\u91cd\u65b0\u8fdb\u5165\u8bbe\u7f6e\u8def\u7531\u3002\",\n        \"\u7b49\u5f85 search-chain \u9762\u677f\u91cd\u65b0\u6302\u8f7d\u3001describe \u8fd4\u56de\u5e94\u7528\u7ea7 ok\u3001\u5217\u8868\u7a33\u5b9a\uff1b\u91c7\u96c6\u540d\u79f0\u3001\u987a\u5e8f\u3001enabled\u3001\u5fbd\u6807\u548c\u5bc6\u7801\u8f93\u5165\u56de\u663e\u72b6\u6001\u3002\"\n      ],\n      \"waitFor\": \"\u771f\u5b9e reload \u540e\u91cd\u65b0 describe \u6210\u529f\u3002\"\n    },\n    {\n      \"name\": \"confirmOpen\",\n      \"steps\": [\n        \"\u70b9\u51fb\u76ee\u6807\u5361\u7684 [data-role=\\\"card-remove\\\"]\u3002\",\n        \"\u7b49\u5f85 [data-role=\\\"confirm-remove\\\"] \u53ef\u89c1\uff1b\u91c7\u96c6\u5371\u9669\u8272\u540e\u53d6\u6d88\uff0c\u907f\u514d\u6b64\u9636\u6bb5\u8bef\u5220\u6d4b\u8bd5\u6570\u636e\u3002\"\n      ],\n      \"waitFor\": \"\u786e\u8ba4\u79fb\u9664\u6309\u94ae\u53ef\u89c1\u3002\"\n    },\n    {\n      \"name\": \"focusPass\",\n      \"steps\": [\n        \"\u4f7f\u7528 Input.dispatchKeyEvent \u771f\u6b63 Tab \u904d\u5386\u6309\u94ae\u3001\u62d6\u62fd\u628a\u624b\u3001picker \u9879\u3001switch \u548c\u8f93\u5165\u6846\u3002\",\n        \"\u6bcf\u6b21\u6309\u952e\u540e\u7b49\u5f85\u7126\u70b9\u7a33\u5b9a\uff0c\u8bb0\u5f55 activeElement\u3001:focus-visible\u3001outline/box-shadow\uff1b\u8f93\u5165\u6846\u5355\u72ec\u6838 :focus\u3002\",\n        \"\u4e0d\u4f7f\u7528 el.focus() \u4f5c\u4e3a focus-visible \u8bc1\u636e\u3002\"\n      ],\n      \"waitFor\": \"\u76ee\u6807\u63a7\u4ef6\u83b7\u5f97\u771f\u5b9e\u952e\u76d8\u7126\u70b9\uff1b\u82e5\u63a7\u4ef6\u7f3a\u5931\u5219\u8be5\u65ad\u8a00 FAIL\u3002\"\n    },\n    {\n      \"name\": \"reducedMotion\",\n      \"steps\": [\n        \"\u8c03\u7528 Emulation.setEmulatedMedia \u8bbe\u7f6e prefers-reduced-motion: reduce\u3002\",\n        \"\u626b\u63cf\u6ce8\u5165 style \u7684 reduced-motion \u89c4\u5219\uff0c\u5e76\u6838 switch track \u4e0e ::after transition\u3002\"\n      ],\n      \"waitFor\": \"\u5a92\u4f53\u6a21\u62df\u751f\u6548\uff1brule-text \u65ad\u8a00\u6267\u884c\u3002\"\n    },\n    {\n      \"name\": \"dark\",\n      \"steps\": [\n        \"\u5728\u771f\u5b9e\u5bbf\u4e3b\u9875\u8bbe\u7f6e body[data-ds-dark-theme] \u5c5e\u6027\uff1b\u540c\u9875\u5efa dark token probe\u3002\",\n        \"\u8fd0\u884c\u4e3b\u9898\u989c\u8272\u65ad\u8a00\u4e0e\u6697\u8272\u622a\u56fe\uff1b\u7ed3\u675f\u540e\u79fb\u9664\u6b64\u5c5e\u6027\u3002\"\n      ],\n      \"waitFor\": \"\u5c5e\u6027\u5b58\u5728\u4e14 probe/\u76ee\u6807\u5143\u7d20\u8ba1\u7b97\u6837\u5f0f\u53ef\u8bfb\u3002\"\n    },\n    {\n      \"name\": \"keyboardReorder\",\n      \"steps\": [\n        \"\u805a\u7126\u76ee\u6807 [data-role=\\\"drag-handle\\\"]\uff0c\u53d1\u9001 ArrowUp/ArrowDown\uff0c\u4f7f\u987a\u5e8f\u53d1\u751f\u5224\u522b\u6027\u53d8\u5316\u3002\",\n        \"\u4fdd\u5b58\uff0c\u7b49\u5f85 RPC \u6210\u529f\uff1bPage.reload \u5e76\u91cd\u8fdb\u8bbe\u7f6e\uff0c\u6838\u987a\u5e8f\u3002\"\n      ],\n      \"waitFor\": \"\u5217\u8868\u987a\u5e8f\u53d8\u5316\u5e76\u5728 reload \u540e\u8bfb\u56de\u3002\"\n    },\n    {\n      \"name\": \"dragAttempt\",\n      \"steps\": [\n        \"\u4ee5 Input.dispatchMouseEvent \u5c1d\u8bd5 HTML5 \u539f\u751f\u62d6\u62fd\u5e76\u89c2\u5bdf data-dragging/data-drop-target\uff1b\u4e0d\u5f97\u5c06\u4e0d\u53ef\u8fbe\u4f2a\u88c5\u4e3a PASS\u3002\",\n        \"\u4e0d\u8bba\u62d6\u62fd\u72b6\u6001\u80fd\u5426\u8fbe\u5230\uff0c\u5747\u626b\u63cf data-dragging \u900f\u660e\u5ea6\u4e0e gradient \u6307\u793a\u7ebf\u89c4\u5219\u6587\u672c\u3002\"\n      ],\n      \"waitFor\": \"\u89c4\u5219\u6587\u672c\u65ad\u8a00\u5fc5\u987b\u6267\u884c\uff1bruntime \u4e0d\u53ef\u8fbe\u53ea\u5bf9\u76f8\u5e94 runtime \u5c55\u793a\u65ad\u8a00 SKIP \u5e76\u8bb0 gap\u3002\"\n    },\n    {\n      \"name\": \"emptyState\",\n      \"steps\": [\n        \"\u9996\u6b21\u65b0 profile \u7684\u7a7a\u914d\u7f6e\u9636\u6bb5\u8bfb\u53d6 empty-state\u3002\",\n        \"\u53e6\u5efa\u7a7a\u914d\u7f6e profile \u4e0d\u5c5e\u4e8e\u672c\u8f6e\u8981\u6c42\uff1b\u4f7f\u7528\u672c\u6b21\u9694\u79bb profile \u7684\u521d\u59cb\u72b6\u6001\u5373\u53ef\u3002\"\n      ],\n      \"waitFor\": \"\u9996\u6b21 describe \u540e\u5217\u8868\u4e3a\u7a7a\u4e14 empty-state \u53ef\u89c1\u3002\"\n    }\n  ],\n  \"screenshots\": [\n    {\n      \"file\": \"our-panel-light.png\",\n      \"phase\": \"default\",\n      \"theme\": \"light\",\n      \"clip\": \"[data-plugin-id=\\\"search-chain\\\"] \u5168\u9ad8\u8fb9\u754c\u6846\"\n    },\n    {\n      \"file\": \"official-models.png\",\n      \"phase\": \"default\",\n      \"theme\": \"light\",\n      \"clip\": \"\u6309\u533a\u6807\u9898\u6587\u672c\u5b9a\u4f4d\u7684\u5b98\u65b9\u300c\u6a21\u578b\u300dsection \u8fb9\u754c\u6846\"\n    },\n    {\n      \"file\": \"official-web-search.png\",\n      \"phase\": \"default\",\n      \"theme\": \"light\",\n      \"clip\": \"\u6309\u533a\u6807\u9898\u6587\u672c\u5b9a\u4f4d\u7684\u5b98\u65b9\u300c\u7f51\u9875\u641c\u7d22\u300dsection \u8fb9\u754c\u6846\"\n    },\n    {\n      \"file\": \"switch-focus.png\",\n      \"phase\": \"focusPass\",\n      \"theme\": \"light\",\n      \"clip\": \"\u5b98\u65b9\u5f00\u5173 label\u3001track\u3001focus ring \u7279\u5199\"\n    },\n    {\n      \"file\": \"switch-open-closed.png\",\n      \"phase\": \"default\",\n      \"theme\": \"light\",\n      \"clip\": \"\u5f00\u5173\u5f00\u542f\u4e0e\u5173\u95ed\u72b6\u6001\u5404\u4e00\u5904\u7279\u5199\"\n    },\n    {\n      \"file\": \"picker-open.png\",\n      \"phase\": \"pickerOpen\",\n      \"theme\": \"light\",\n      \"clip\": \"[data-plugin-id=\\\"search-chain\\\"] \u5185 picker \u5c55\u5f00\u533a\u57df\"\n    },\n    {\n      \"file\": \"editor-open.png\",\n      \"phase\": \"editorOpen\",\n      \"theme\": \"light\",\n      \"clip\": \"[data-role=\\\"editor\\\"] \u5c55\u5f00\u533a\u57df\"\n    },\n    {\n      \"file\": \"our-panel-dark.png\",\n      \"phase\": \"dark\",\n      \"theme\": \"dark\",\n      \"clip\": \"[data-plugin-id=\\\"search-chain\\\"] \u5168\u9ad8\u8fb9\u754c\u6846\"\n    }\n  ],\n  \"assertions\": {\n    \"A\": [\n      {\n        \"id\": \"A-001\",\n        \"spec\": \"SPC-001\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-panel\",\n        \"method\": \"computed\",\n        \"property\": \"box-sizing, display, flex-direction, gap, width, max-width\",\n        \"expected\": {\n          \"light\": \"border-box; flex; column; gap 12px; width 100%; max-width 720px\",\n          \"dark\": \"border-box; flex; column; gap 12px; width 100%; max-width 720px\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u7ec4\u4ef6\u6839\u5143\u7d20\u4ea6\u4e3a [data-plugin-id=\\\"search-chain\\\"]\uff1b\u5bbd\u89c6\u53e3\u53e6\u7531 A-002 \u6838 max-width\u3002\"\n      },\n      {\n        \"id\": \"A-002\",\n        \"spec\": \"SPC-001\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-panel\",\n        \"method\": \"geometry\",\n        \"property\": \"getBoundingClientRect().width at viewport wider than 720px plus margins\",\n        \"expected\": {\n          \"light\": \"panel column width <= 720px\",\n          \"dark\": \"panel column width <= 720px\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u4ec5\u6309 SPC-001 \u5bbd\u89c6\u53e3\u94b3\u5236\u9a8c\u6536\u3002\"\n      },\n      {\n        \"id\": \"A-003\",\n        \"spec\": \"SPC-002\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-title\",\n        \"method\": \"computed\",\n        \"property\": \"margin, font-size, line-height, font-weight\",\n        \"expected\": {\n          \"light\": \"margin 0; font-size 16px; line-height 24px; font-weight 500\",\n          \"dark\": \"margin 0; font-size 16px; line-height 24px; font-weight 500\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"SPC-002\u3002\"\n      },\n      {\n        \"id\": \"A-004\",\n        \"spec\": \"SPC-002\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-title\",\n        \"method\": \"token-probe\",\n        \"property\": \"color\",\n        \"expected\": {\n          \"light\": \"var(--dsw-alias-label-primary) = rgb(15,17,21)\",\n          \"dark\": \"var(--dsw-alias-label-primary) = rgb(249,250,251)\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u540c\u9875 probe \u89e3\u6790 token\uff0c\u76ee\u6807\u8ba1\u7b97\u8272\u548c probe \u8272\u76f8\u7b49\uff0c\u5e76\u6838 \u00a74 RGB\u3002\"\n      },\n      {\n        \"id\": \"A-005\",\n        \"spec\": \"SPC-003\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-description\",\n        \"method\": \"computed\",\n        \"property\": \"margin, font-size, line-height\",\n        \"expected\": {\n          \"light\": \"margin 0; font-size 14px; line-height 22px\",\n          \"dark\": \"margin 0; font-size 14px; line-height 22px\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u6807\u9898/\u8bf4\u660e\u5757\u5230\u9996\u5361 24px \u7531\u5bb9\u5668 gap \u4e0e list margin \u7ec4\u6210\uff0c\u4e0d\u72ec\u7acb\u589e\u52a0\u8ddd\u79bb\u9608\u503c\u3002\"\n      },\n      {\n        \"id\": \"A-006\",\n        \"spec\": \"SPC-003\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-description\",\n        \"method\": \"token-probe\",\n        \"property\": \"color\",\n        \"expected\": {\n          \"light\": \"var(--dsw-alias-label-tertiary) = rgb(129,133,140)\",\n          \"dark\": \"var(--dsw-alias-label-tertiary) = rgb(173,178,184)\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"token probe \u53cc\u91cd\u6838\u5bf9 \u00a74\u3002\"\n      },\n      {\n        \"id\": \"A-007\",\n        \"spec\": \"SPC-005\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-card-list\uff08\u7ea0\u504f\u540e\u5fc5\u9700\u9009\u62e9\u5668\uff09\",\n        \"method\": \"computed\",\n        \"property\": \"list-style, margin, padding, display, flex-direction, gap\",\n        \"expected\": {\n          \"light\": \"list-style none; margin 12px 0 0; padding 0; flex column; gap 8px\",\n          \"dark\": \"list-style none; margin 12px 0 0; padding 0; flex column; gap 8px\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u5f53\u524d DOM \u65e0 .sc-card-list\uff0cHEAD \u6821\u51c6\u9884\u671f FAIL\uff1b\u4e24\u5361\u65f6\u76f8\u90bb\u95f4\u9699\u5e94\u4e3a 8px\u3002\"\n      },\n      {\n        \"id\": \"A-008\",\n        \"spec\": \"SPC-006\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"]\",\n        \"method\": \"computed\",\n        \"property\": \"box-sizing, position, border-width/style, border-radius, padding, display, flex-direction, gap\",\n        \"expected\": {\n          \"light\": \"border-box; relative; 0.5px solid; radius var(--dsw-radius-xl); padding 12px 14px; flex column; gap 12px\",\n          \"dark\": \"border-box; relative; 0.5px solid; radius var(--dsw-radius-xl); padding 12px 14px; flex column; gap 12px\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"border-width \u7cbe\u786e 0.5px\uff1b\u5706\u89d2 token \u7531\u89c4\u5219\u5f15\u7528\u6838\u9a8c\uff0c\u00a74 xl=20px\u3002\"\n      },\n      {\n        \"id\": \"A-009\",\n        \"spec\": \"SPC-006\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"]\",\n        \"method\": \"token-probe\",\n        \"property\": \"background-color and border-color\",\n        \"expected\": {\n          \"light\": \"settings-card-fill = rgb(255,255,255); settings-card-stroke = rgba(0,0,0,.16)\",\n          \"dark\": \"settings-card-fill = rgb(44,44,46); settings-card-stroke = rgba(255,255,255,.2)\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u63a2\u6d4b --dsw-alias-settings-card-fill/stroke \u5e76\u4e0e\u5361\u7247\u5b9e\u9645\u8ba1\u7b97\u8272\u9010\u9879\u6bd4\u8f83\u3002\"\n      },\n      {\n        \"id\": \"A-010\",\n        \"spec\": \"SPC-007\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-card-row\",\n        \"method\": \"computed\",\n        \"property\": \"display, align-items, gap, min-width\",\n        \"expected\": {\n          \"light\": \"flex; center; gap 10px; min-width 0\",\n          \"dark\": \"flex; center; gap 10px; min-width 0\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"SPC-007\u3002\"\n      },\n      {\n        \"id\": \"A-011\",\n        \"spec\": \"SPC-007\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-card-info\",\n        \"method\": \"computed\",\n        \"property\": \"display, align-items, gap, min-width\",\n        \"expected\": {\n          \"light\": \"inline-flex; center; gap 6px; min-width 0\",\n          \"dark\": \"inline-flex; center; gap 6px; min-width 0\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u8eab\u4efd\u7ec4\u4e0d\u5e94\u6709 flex-wrap \u58f0\u660e\u3002\"\n      },\n      {\n        \"id\": \"A-012\",\n        \"spec\": \"SPC-007\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-card-actions\",\n        \"method\": \"computed\",\n        \"property\": \"display, align-items, gap, margin-left\",\n        \"expected\": {\n          \"light\": \"inline-flex; center; gap 4px; margin-left auto\",\n          \"dark\": \"inline-flex; center; gap 4px; margin-left auto\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"SPC-007\u3002\"\n      },\n      {\n        \"id\": \"A-013\",\n        \"spec\": \"SPC-008\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-card-name\",\n        \"method\": \"computed\",\n        \"property\": \"font-size, line-height, font-weight, overflow-wrap\",\n        \"expected\": {\n          \"light\": \"14px; 22px; 500; anywhere\",\n          \"dark\": \"14px; 22px; 500; anywhere\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"overflow-wrap \u867d\u5b98\u65b9\u672a\u83b7\u53d6\uff0c\u4f46 SPC-008 \u9489\u6b7b\u503c\u660e\u786e\u8981\u6c42 anywhere\u3002\"\n      },\n      {\n        \"id\": \"A-014\",\n        \"spec\": \"SPC-008\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-card-name\",\n        \"method\": \"token-probe\",\n        \"property\": \"color\",\n        \"expected\": {\n          \"light\": \"var(--dsw-alias-label-primary) = rgb(15,17,21)\",\n          \"dark\": \"var(--dsw-alias-label-primary) = rgb(249,250,251)\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"token probe \u53cc\u91cd\u6838\u5bf9 \u00a74\u3002\"\n      },\n      {\n        \"id\": \"A-015\",\n        \"spec\": \"SPC-009\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-type-badge\",\n        \"method\": \"computed\",\n        \"property\": \"flex, padding, border-width/style, border-radius, font-size, line-height, white-space\",\n        \"expected\": {\n          \"light\": \"flex none; padding 1px 6px; 0.5px solid; radius var(--dsw-radius-xs); 11px; 16px; nowrap\",\n          \"dark\": \"flex none; padding 1px 6px; 0.5px solid; radius var(--dsw-radius-xs); 11px; 16px; nowrap\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u00a74 radius-xs=4px\uff1bborder width \u7cbe\u786e 0.5px\u3002\"\n      },\n      {\n        \"id\": \"A-016\",\n        \"spec\": \"SPC-009\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-type-badge\",\n        \"method\": \"token-probe\",\n        \"property\": \"border-color and color\",\n        \"expected\": {\n          \"light\": \"border-l3 = rgba(0,0,0,.12); label-secondary = rgb(97,102,107)\",\n          \"dark\": \"border-l3 = rgba(255,255,255,.16); label-secondary = rgb(207,211,214)\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u00a74 token probe\u3002\"\n      },\n      {\n        \"id\": \"A-017\",\n        \"spec\": \"SPC-010\",\n        \"phase\": \"dataSetup\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"] .sc-status-dot\",\n        \"method\": \"computed\",\n        \"property\": \"box-sizing, display, flex, width, height, border-radius\",\n        \"expected\": {\n          \"light\": \"border-box; inline-block; flex none; 8px by 8px; 50%\",\n          \"dark\": \"border-box; inline-block; flex none; 8px by 8px; 50%\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"dataSetup \u51c6\u5907\u5df2\u5c31\u7eea\u3001\u7f3a\u5c11\u51ed\u636e\u5f15\u7528\u3001\u5df2\u5173\u95ed\u4e09\u6001\uff1bcorner-shape \u53e6\u7531 A-020 rule-text \u6838\u9a8c\u3002\"\n      },\n      {\n        \"id\": \"A-018\",\n        \"spec\": \"SPC-010\",\n        \"phase\": \"dataSetup\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"] .sc-status\",\n        \"method\": \"computed\",\n        \"property\": \"display, flex, align-items, gap, font-size, line-height, font-weight, white-space\",\n        \"expected\": {\n          \"light\": \"inline-flex; flex none; center; gap 6px; 13px; 20px; 400; nowrap\",\n          \"dark\": \"inline-flex; flex none; center; gap 6px; 13px; 20px; 400; nowrap\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u4e09\u6001\u5747\u9700\u6709\u72b6\u6001\u6587\u6848\u3002\"\n      },\n      {\n        \"id\": \"A-019\",\n        \"spec\": \"SPC-010\",\n        \"phase\": \"dataSetup\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"] .sc-status-dot[data-state]\",\n        \"method\": \"token-probe\",\n        \"property\": \"background-color by state\",\n        \"expected\": {\n          \"light\": \"ready state-success-primary rgb(34,197,94); missing credential state-error-primary rgb(236,19,19); disabled state-idle-primary rgb(212,212,212)\",\n          \"dark\": \"ready state-success-primary rgb(34,197,94); missing credential state-error-primary rgb(242,90,90); disabled state-idle-primary rgb(84,85,87)\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"SPC-010 \u7ea2\u70b9\u88c1\u5b9a\uff1b\u72b6\u6001\u4ee5\u4e09\u6761\u771f\u5b9e\u8bbe\u7f6e\u6761\u76ee\u8fbe\u6210\u3002\"\n      },\n      {\n        \"id\": \"A-020\",\n        \"spec\": \"SPC-010\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] <style data-sc-style=\\\"panel\\\">\",\n        \"method\": \"rule-text\",\n        \"property\": \"corner-shape on status dot border-radius:50%\",\n        \"expected\": {\n          \"light\": \"corner-shape: round\",\n          \"dark\": \"corner-shape: round\"\n        },\n        \"tolerance\": \"\u8bed\u4e49\u89c4\u5219\u5757\u5339\u914d\uff0c\u7a7a\u767d/\u58f0\u660e\u987a\u5e8f\u53ef\u53d8\",\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"Chromium computed \u4e0d\u53ef\u89c1\u65f6\u4ec5\u67e5\u89c4\u5219\u6587\u672c\u3002\"\n      },\n      {\n        \"id\": \"A-021\",\n        \"spec\": \"SPC-011\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-switch-track\",\n        \"method\": \"geometry\",\n        \"property\": \"track bounding box, padding, border\",\n        \"expected\": {\n          \"light\": \"36px \u00d7 20px; padding 2px; border 0\",\n          \"dark\": \"36px \u00d7 20px; padding 2px; border 0\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"SPC-011\u3002\"\n      },\n      {\n        \"id\": \"A-022\",\n        \"spec\": \"SPC-011\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-switch-track\",\n        \"method\": \"token-probe\",\n        \"property\": \"background-color for unchecked/checked states\",\n        \"expected\": {\n          \"light\": \"unchecked border-l3 rgba(0,0,0,.12); checked brand-primary rgb(15,17,21)\",\n          \"dark\": \"unchecked border-l3 rgba(255,255,255,.16); checked brand-primary rgb(249,250,251)\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u5206\u522b\u7ecf\u771f\u5b9e checked \u72b6\u6001\u89e6\u53d1\uff1b\u00a74 token probe \u53cc\u91cd\u6838\u5bf9\u3002\"\n      },\n      {\n        \"id\": \"A-023\",\n        \"spec\": \"SPC-011\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-switch-track::after\",\n        \"method\": \"computed\",\n        \"property\": \"width, height, border-radius, transition, transform\",\n        \"expected\": {\n          \"light\": \"16px \u00d7 16px; border-radius 50%; transition transform .12s ease; unchecked transform none; checked translate(16px)\",\n          \"dark\": \"16px \u00d7 16px; border-radius 50%; transition transform .12s ease; unchecked transform none; checked translate(16px)\"\n        },\n        \"tolerance\": \"transform matrix \u4e0e translate(16px) \u7b49\u4ef7\",\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u4f7f\u7528 Runtime.evaluate \u8bfb\u53d6 ::after\uff1bcorner-shape \u53e6\u67e5\u89c4\u5219\u6587\u672c\u3002\"\n      },\n      {\n        \"id\": \"A-024\",\n        \"spec\": \"SPC-011\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-switch-track::after\",\n        \"method\": \"token-probe\",\n        \"property\": \"thumb background-color\",\n        \"expected\": {\n          \"light\": \"unchecked switch-thumb rgb(255,255,255); checked label-primary-foreground rgb(255,255,255)\",\n          \"dark\": \"unchecked switch-thumb rgb(173,178,184); checked label-primary-foreground rgb(15,17,21)\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u5f00\u5173\u4e24\u79cd\u72b6\u6001\u5747\u4ee5 token probe \u6bd4\u8f83\u3002\"\n      },\n      {\n        \"id\": \"A-025\",\n        \"spec\": \"SPC-011\",\n        \"phase\": \"dataSetup\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-switch-input:disabled + .sc-switch-track\",\n        \"method\": \"computed\",\n        \"property\": \"opacity, cursor\",\n        \"expected\": {\n          \"light\": \"opacity .5; cursor default\",\n          \"dark\": \"opacity .5; cursor default\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u7528 pending \u4fdd\u5b58\u72b6\u6001\u8fbe\u6210 locked disabled\uff1b\u72b6\u6001\u4e0d\u53ef\u8fbe\u5219\u8bb0 gap\u3002\"\n      },\n      {\n        \"id\": \"A-026\",\n        \"spec\": \"SPC-012\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-switch\",\n        \"method\": \"computed\",\n        \"property\": \"display, align-items, gap, color, cursor, white-space\",\n        \"expected\": {\n          \"light\": \"inline-flex; center; gap 8px; label-secondary rgb(97,102,107); pointer; nowrap\",\n          \"dark\": \"inline-flex; center; gap 8px; label-secondary rgb(207,211,214); pointer; nowrap\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u540c\u65f6\u68c0\u67e5 label 14px/22px\u3001label-secondary\uff1bdisabled label opacity .5 \u4e0e cursor default\u3002\"\n      },\n      {\n        \"id\": \"A-027\",\n        \"spec\": \"SPC-013\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-official-row\",\n        \"method\": \"computed\",\n        \"property\": \"display, flex-direction, align-items, gap; descendants panel/card chrome absence\",\n        \"expected\": {\n          \"light\": \"flex; column; flex-start; gap 8px; no card background/border\",\n          \"dark\": \"flex; column; flex-start; gap 8px; no card background/border\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u6807\u7b7e\u4e3b\u8272 label-primary\uff1bhint margin 0\u300112px/18px\u3001label-tertiary\u3002\"\n      },\n      {\n        \"id\": \"A-028\",\n        \"spec\": \"SPC-014\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-button\",\n        \"method\": \"computed\",\n        \"property\": \"box-sizing, display, align-items, justify-content, gap, height, padding, border, border-radius, font-size, line-height\",\n        \"expected\": {\n          \"light\": \"border-box; inline-flex; center/center; gap 4px; height 36px; padding 0 14px; border 0; radius var(--dsw-radius-md); 14px/22px\",\n          \"dark\": \"border-box; inline-flex; center/center; gap 4px; height 36px; padding 0 14px; border 0; radius var(--dsw-radius-md); 14px/22px\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u4e09\u53d8\u4f53\u5206\u5f00\u68c0\u67e5\uff1bsecondary border 0.5px solid\uff1bdanger \u65e0\u8fb9\u6846\u900f\u660e\u3002\"\n      },\n      {\n        \"id\": \"A-029\",\n        \"spec\": \"SPC-014\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-button-primary\",\n        \"method\": \"token-probe\",\n        \"property\": \"background/color and hover background\",\n        \"expected\": {\n          \"light\": \"button-primary-fill rgb(15,17,21); label-primary-foreground rgb(255,255,255); hover button-primary-hover rgb(67,69,74)\",\n          \"dark\": \"button-primary-fill rgb(249,250,251); label-primary-foreground rgb(15,17,21); hover button-primary-hover rgb(235,238,242)\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"hover \u7531 CDP mouse dispatch \u5c1d\u8bd5\u89e6\u53d1\uff1b\u58f0\u660e\u8fd8\u7531 A-030 \u6838\u9a8c\u3002\"\n      },\n      {\n        \"id\": \"A-030\",\n        \"spec\": \"SPC-014\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] <style data-sc-style=\\\"panel\\\">\",\n        \"method\": \"rule-text\",\n        \"property\": \"all hover declarations are nested in @media (hover: hover)\",\n        \"expected\": {\n          \"light\": \"\u6bcf\u4e2a hover \u58f0\u660e\u4f4d\u4e8e @media (hover: hover) \u5185\",\n          \"dark\": \"\u6bcf\u4e2a hover \u58f0\u660e\u4f4d\u4e8e @media (hover: hover) \u5185\"\n        },\n        \"tolerance\": \"CSS \u8bed\u6cd5/\u7a7a\u767d\u53ef\u53d8\uff1b\u5a92\u4f53\u6761\u4ef6\u548c\u58f0\u660e\u8bed\u4e49\u987b\u4e00\u81f4\",\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u8986\u76d6\u6309\u94ae\u3001\u5371\u9669\u6001\u3001picker\u3001\u6dfb\u52a0\u94ae\u548c icon-button hover \u89c4\u5219\u3002\"\n      },\n      {\n        \"id\": \"A-031\",\n        \"spec\": \"SPC-015\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-card-actions .sc-button-secondary\",\n        \"method\": \"computed\",\n        \"property\": \"height, padding, border-radius, font-size, line-height\",\n        \"expected\": {\n          \"light\": \"28px; 0 10px; radius var(--dsw-radius-sm); 12px/18px\",\n          \"dark\": \"28px; 0 10px; radius var(--dsw-radius-sm); 12px/18px\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u884c\u5185\u7f16\u8f91\u6309\u94ae compact\uff1b\u7f16\u8f91\u5668\u5b8c\u6210\u6309\u94ae\u4e0d\u5f97 compact\u3002\"\n      },\n      {\n        \"id\": \"A-032\",\n        \"spec\": \"SPC-016\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"save\\\"]\",\n        \"method\": \"geometry\",\n        \"property\": \"right edge alignment and intrinsic width\",\n        \"expected\": {\n          \"light\": \"right edge equals panel content right edge; width follows label content\",\n          \"dark\": \"right edge equals panel content right edge; width follows label content\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u81ea\u9002\u5e94\u7528\u4e0d\u540c\u6587\u6848\u72b6\u6001\uff08\u4fdd\u5b58/\u4fdd\u5b58\u4e2d\u2026\uff09\u6bd4\u8f83\u5bbd\u5ea6\u968f\u5185\u5bb9\uff0c\u4e0d\u9489\u65b0\u5bbd\u5ea6\u6570\u503c\u3002\"\n      },\n      {\n        \"id\": \"A-033\",\n        \"spec\": \"SPC-016\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"save\\\"]\",\n        \"method\": \"computed\",\n        \"property\": \"align-self, height, padding, border-radius, font-size, line-height\",\n        \"expected\": {\n          \"light\": \"flex-end; 36px; 0 14px; radius var(--dsw-radius-md); 14px/22px\",\n          \"dark\": \"flex-end; 36px; 0 14px; radius var(--dsw-radius-md); 14px/22px\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u989c\u8272\u7528 button-primary-fill/label-primary-foreground token probe\u3002\"\n      },\n      {\n        \"id\": \"A-034\",\n        \"spec\": \"SPC-017\",\n        \"phase\": \"dataSetup\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] :disabled\",\n        \"method\": \"computed\",\n        \"property\": \"disabled opacity/cursor by element family\",\n        \"expected\": {\n          \"light\": \"button/action .4 default; input .6 default; switch track+label .5 default\",\n          \"dark\": \"button/action .4 default; input .6 default; switch track+label .5 default\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u9501\u5b9a pending \u72b6\u6001\u4ea7\u751f disabled\uff1b\u6309\u65cf\u6838\u9a8c\uff0c\u4e0d\u505a\u4e00\u5200\u5207\u3002\"\n      },\n      {\n        \"id\": \"A-035\",\n        \"spec\": \"SPC-018\",\n        \"phase\": \"focusPass\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] <style data-sc-style=\\\"panel\\\">\",\n        \"method\": \"rule-text\",\n        \"property\": \"focus ring variable mechanism, width, pointer modality suppression, input focus\",\n        \"expected\": {\n          \"light\": \"button focus-visible box-shadow 0 0 0 var(--dsw-focus-ring-width, 2px) var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); input :focus border-color state-business-primary; switch outline var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)), offset 2px; html[data-input-modality='pointer'] suppression\",\n          \"dark\": \"same rule set\"\n        },\n        \"tolerance\": \"\u89c4\u5219\u5757\u53ef\u7ec4\u5408/\u7a7a\u767d\u4e0d\u540c\uff1b\u53d8\u91cf\u30012px\u3001\u72b6\u6001\u53ca\u6307\u9488\u9009\u62e9\u5668\u8bed\u4e49\u987b\u5b8c\u6574\",\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u7981\u6b62 brand-primary \u7126\u70b9\u8272\uff1b\u63a2\u67e5\u7126\u70b9\u989c\u8272\u65f6\u8d70 token probe\u3002\"\n      },\n      {\n        \"id\": \"A-036\",\n        \"spec\": \"SPC-018\",\n        \"phase\": \"focusPass\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] :focus-visible\",\n        \"method\": \"computed\",\n        \"property\": \"outline/box-shadow while traversing with real Tab\",\n        \"expected\": {\n          \"light\": \"focus ring uses --dsw-focus-ring-width (2px) and business-primary token\",\n          \"dark\": \"focus ring uses --dsw-focus-ring-width (2px) and business-primary token\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u771f\u5b9e Tab \u904d\u5386\uff1bfocus-visible \u5b9e\u9645\u8272\u901a\u8fc7 probe \u89e3\u6790\u53d8\u91cf\u3002\"\n      },\n      {\n        \"id\": \"A-037\",\n        \"spec\": \"SPC-019\",\n        \"phase\": \"editorOpen\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"editor\\\"]\",\n        \"method\": \"computed\",\n        \"property\": \"box-sizing, display, flex-direction, gap, padding, border-radius, background-color\",\n        \"expected\": {\n          \"light\": \"border-box; flex column; gap 14px; padding 14px 16px; radius var(--dsw-radius-lg); bg-module-platform token\",\n          \"dark\": \"same geometry and token reference\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"nested in card variant separately requires background none; padding 0.\"\n      },\n      {\n        \"id\": \"A-038\",\n        \"spec\": \"SPC-020\",\n        \"phase\": \"editorOpen\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"editor\\\"] .sc-editor-title\",\n        \"method\": \"computed\",\n        \"property\": \"margin, font-size, line-height, font-weight\",\n        \"expected\": {\n          \"light\": \"margin 0; 14px/22px; 500\",\n          \"dark\": \"margin 0; 14px/22px; 500\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"field: flex column gap 6px margin-block 0; label 12px/18px/500; hint/error 12px/18px\u3002\"\n      },\n      {\n        \"id\": \"A-039\",\n        \"spec\": \"SPC-021\",\n        \"phase\": \"editorOpen\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"field\\\"]\",\n        \"method\": \"computed\",\n        \"property\": \"input width, height, padding, border-width, border-radius, font-size, line-height\",\n        \"expected\": {\n          \"light\": \"width 100%; height 32px; padding 0 10px; border .5px solid border-l4; radius var(--dsw-radius-md); 14px/22px\",\n          \"dark\": \"same geometry and token reference\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u9700\u8981 select.sc-input \u624d\u65ad\u8a00 SPC-021 select \u4e13\u5c5e max-width 240px \u548c chevron\uff1b\u5f53\u524d\u6ca1\u6709\u5219\u89c1 nonAssertable\u3002\"\n      },\n      {\n        \"id\": \"A-040\",\n        \"spec\": \"SPC-021\",\n        \"phase\": \"editorOpen\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-input::placeholder\",\n        \"method\": \"token-probe\",\n        \"property\": \"placeholder color\",\n        \"expected\": {\n          \"light\": \"var(--dsw-alias-label-dimmed) = rgb(225,229,238)\",\n          \"dark\": \"var(--dsw-alias-label-dimmed) = rgb(67,69,74)\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u4e0d\u56e0\u51ed\u636e\u5df2\u914d\u7f6e\u800c\u56de\u663e key\uff1bplaceholder \u4ecd\u7528 dimmed token\u3002\"\n      },\n      {\n        \"id\": \"A-041\",\n        \"spec\": \"SPC-024\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"add-tool\\\"]\",\n        \"method\": \"geometry\",\n        \"property\": \"height and width relative to card list\",\n        \"expected\": {\n          \"light\": \"height 44px; fills available row width\",\n          \"dark\": \"height 44px; fills available row width\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u5176\u4f59\u65ad\u8a00 min-width 180px; padding 0 14px; gap 6px; border 1px dashed; radius var(--dsw-radius-lg)\u3002\"\n      },\n      {\n        \"id\": \"A-042\",\n        \"spec\": \"SPC-024\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"add-tool\\\"]\",\n        \"method\": \"token-probe\",\n        \"property\": \"border-color and text color\",\n        \"expected\": {\n          \"light\": \"border-l3 rgba(0,0,0,.12); label-primary rgb(15,17,21)\",\n          \"dark\": \"border-l3 rgba(255,255,255,.16); label-primary rgb(249,250,251)\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u900f\u660e\u5e95\uff1bhover \u4e3a interactive-bg-hover token\u3002\"\n      },\n      {\n        \"id\": \"A-043\",\n        \"spec\": \"SPC-025\",\n        \"phase\": \"pickerOpen\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-picker\",\n        \"method\": \"computed\",\n        \"property\": \"gap, padding, radius, background\",\n        \"expected\": {\n          \"light\": \"gap 8px; module chrome padding 14px 16px; radius var(--dsw-radius-lg)\",\n          \"dark\": \"same geometry and token reference\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"picker \u5bb9\u5668\u5171\u7528 SPC-019 \u94ec\u5c42\u3002\"\n      },\n      {\n        \"id\": \"A-044\",\n        \"spec\": \"SPC-025\",\n        \"phase\": \"pickerOpen\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"add-type\\\"]\",\n        \"method\": \"computed\",\n        \"property\": \"width, flex-direction, align-items, gap, padding, border, radius\",\n        \"expected\": {\n          \"light\": \"width 100%; flex column; flex-start; gap 4px; padding 14px 16px; border 0; radius var(--dsw-radius-md)\",\n          \"dark\": \"same geometry and token reference\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u6807\u9898 14px/22px/600\uff1bbilling 12px/18px\u3002\"\n      },\n      {\n        \"id\": \"A-045\",\n        \"spec\": \"SPC-025\",\n        \"phase\": \"pickerOpen\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"add-type\\\"]\",\n        \"method\": \"token-probe\",\n        \"property\": \"item background, text, hover background, title and billing colors\",\n        \"expected\": {\n          \"light\": \"bg-layer-1 rgb(255,255,255); label-primary rgb(15,17,21); hover interactive-bg-hover-solid rgb(241,243,245); billing label-tertiary rgb(129,133,140)\",\n          \"dark\": \"bg-layer-1 rgb(35,35,36); label-primary rgb(249,250,251); hover interactive-bg-hover-solid rgb(53,54,56); billing label-tertiary rgb(173,178,184)\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u540c\u9875\u9010 token probe\uff1bhover \u72b6\u6001\u7ecf CDP \u5c1d\u8bd5\u89e6\u53d1\u3002\"\n      },\n      {\n        \"id\": \"A-046\",\n        \"spec\": \"SPC-023\",\n        \"phase\": \"confirmOpen\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"confirm-remove\\\"]\",\n        \"method\": \"token-probe\",\n        \"property\": \"color and hover background\",\n        \"expected\": {\n          \"light\": \"state-error-primary rgb(236,19,19); interactive-bg-hover-danger rgba(236,19,19,.05)\",\n          \"dark\": \"state-error-primary rgb(242,90,90); interactive-bg-hover-danger rgba(242,90,90,.15)\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u540c\u65f6\u6838\u79fb\u9664\u884c\u6309\u94ae\u4e3a\u7eaf\u7ea2\u6587\u5b57\u4e14\u900f\u660e\u57fa\u5e95\uff0c\u65e0\u5b9e\u5fc3 danger fill\u3002\"\n      },\n      {\n        \"id\": \"A-047\",\n        \"spec\": \"SPC-023\",\n        \"phase\": \"editorOpen\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] .sc-error\",\n        \"method\": \"token-probe\",\n        \"property\": \"color\",\n        \"expected\": {\n          \"light\": \"state-error-primary rgb(236,19,19)\",\n          \"dark\": \"state-error-primary rgb(242,90,90)\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u4ec5\u5728\u53ef\u901a\u8fc7\u771f\u5b9e UI \u751f\u6210\u9519\u8bef\u6587\u6848\u65f6\u91c7\u6837\uff1b\u5426\u5219 state-unreachable SKIP\u3002\"\n      },\n      {\n        \"id\": \"A-048\",\n        \"spec\": \"SPC-030\",\n        \"phase\": \"afterSave\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"save-status\\\"]\",\n        \"method\": \"computed\",\n        \"property\": \"margin, font-size, line-height\",\n        \"expected\": {\n          \"light\": \"margin 0; font-size 12px; line-height 18px\",\n          \"dark\": \"margin 0; font-size 12px; line-height 18px\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"saved \u72b6\u6001\u8272\u53e6\u4ee5 token probe \u6838 state-success-primary\u3002\"\n      },\n      {\n        \"id\": \"A-049\",\n        \"spec\": \"SPC-030\",\n        \"phase\": \"afterSave\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"save-status\\\"][data-state=\\\"saved\\\"]\",\n        \"method\": \"token-probe\",\n        \"property\": \"color\",\n        \"expected\": {\n          \"light\": \"state-success-primary rgb(34,197,94)\",\n          \"dark\": \"state-success-primary rgb(34,197,94)\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u4fdd\u5b58\u5b8c\u6210\u540e\u91c7\u6837\u3002\"\n      },\n      {\n        \"id\": \"A-050\",\n        \"spec\": \"SPC-029\",\n        \"phase\": \"reducedMotion\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] <style data-sc-style=\\\"panel\\\">\",\n        \"method\": \"rule-text\",\n        \"property\": \"@media prefers-reduced-motion switch transitions\",\n        \"expected\": {\n          \"light\": \"@media (prefers-reduced-motion: reduce) { .sc-switch-track, .sc-switch-track::after { transition: none; } }\",\n          \"dark\": \"same rule text\"\n        },\n        \"tolerance\": \"CSS \u7a7a\u767d\u4e0e\u89c4\u5219\u5757\u987a\u5e8f\u53ef\u53d8\uff0c\u5a92\u4f53\u6761\u4ef6/\u9009\u62e9\u5668/transition \u503c\u4e0d\u5f97\u53d8\",\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"Emulation.setEmulatedMedia \u8bbe\u7f6e reduce\uff1b\u5b9e\u9645\u4f2a\u5143\u7d20 transition computed \u4e3a none\u3002\"\n      },\n      {\n        \"id\": \"A-051\",\n        \"spec\": \"SPC-027\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"drag-handle\\\"]\",\n        \"method\": \"geometry\",\n        \"property\": \"button width and height\",\n        \"expected\": {\n          \"light\": \"28px \u00d7 28px\",\n          \"dark\": \"28px \u00d7 28px\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u53e6\u6838 border none\u3001radius var(--dsw-radius-sm)\u3001\u900f\u660e\u5e95\u3001label-tertiary\u300114px/1\u3002\"\n      },\n      {\n        \"id\": \"A-052\",\n        \"spec\": \"SPC-027\",\n        \"phase\": \"dragAttempt\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"][data-dragging]\",\n        \"method\": \"computed\",\n        \"property\": \"opacity\",\n        \"expected\": {\n          \"light\": \"0.5\",\n          \"dark\": \"0.5\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u539f\u751f drag \u4e0d\u53ef\u8fbe\u5141\u8bb8 SKIP\uff1b\u4e0d\u5f97\u5c06\u72b6\u6001\u6ce8\u5165\u4f2a\u88c5\u6210\u5b9e\u673a\u62d6\u52a8\u8bc1\u636e\u3002\"\n      },\n      {\n        \"id\": \"A-053\",\n        \"spec\": \"SPC-027\",\n        \"phase\": \"dragAttempt\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] <style data-sc-style=\\\"panel\\\">\",\n        \"method\": \"rule-text\",\n        \"property\": \"data-dragging opacity; data-drop-target z-index; gradient indicator three-part declarations\",\n        \"expected\": {\n          \"light\": \"data-dragging opacity .5; data-drop-target z-index 1; before/after pseudo rules height 4px; before top -4px; after bottom -4px; target before/after height 12px; exact 55deg and 125deg gradients plus 4px 5px / calc(100% - 4px) 2px line; target before top -10px; after bottom -10px\",\n          \"dark\": \"same rule declarations\"\n        },\n        \"tolerance\": \"\u5141\u8bb8 CSS \u7a7a\u767d\u3001\u5f15\u53f7\u548c\u89c4\u5219\u987a\u5e8f\u4e0d\u540c\uff1bgradient \u53c2\u6570\u3001token\u3001\u4f4d\u7f6e\u3001\u5c3a\u5bf8\u9700\u539f\u4e49\u7b49\u4ef7\uff1b\u4e0d\u5f97\u589e\u52a0 pointer-events:none\",\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u5fc5\u987b\u68c0\u51fa --dsw-alias-state-business-primary \u5f15\u7528\uff1b\u989c\u8272\u503c\u672c\u8eab\u901a\u8fc7 token probe\uff0c\u89c4\u5219\u6587\u672c\u4e5f\u53ef\u9a8c\u53d8\u91cf\u5f15\u7528\u3002\"\n      },\n      {\n        \"id\": \"A-054\",\n        \"spec\": \"SPC-016\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"save\\\"]\",\n        \"method\": \"token-probe\",\n        \"property\": \"background-color and color\",\n        \"expected\": {\n          \"light\": \"button-primary-fill = rgb(15,17,21); label-primary-foreground = rgb(255,255,255)\",\n          \"dark\": \"button-primary-fill = rgb(249,250,251); label-primary-foreground = rgb(15,17,21)\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u540c\u9875 probe --dsw-alias-button-primary-fill \u4e0e --dsw-alias-label-primary-foreground\uff1b\u5206\u522b\u6bd4\u8f83\u4fdd\u5b58\u6309\u94ae\u5b9e\u9645 background-color/color \u53ca \u00a74 RGB\u3002Luna call-2 \u51b3\u7b56 19 CORRECT \u5b9a\u7a3f\uff08SPC-016 \u5e9f\u6b62 #fff/brand \u88f8\u7528\uff09\u3002\"\n      }\n    ],\n    \"B\": [\n      {\n        \"id\": \"B-001\",\n        \"spec\": \"SET-001\",\n        \"phase\": \"dataSetup\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"empty-state\\\"]\",\n        \"method\": \"text-scan\",\n        \"property\": \"initial empty configuration state\",\n        \"expected\": {\n          \"light\": \"visible when entries array is empty\",\n          \"dark\": \"visible when entries array is empty\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u53d6\u672c\u8f6e\u9694\u79bb profile \u9996\u6b21 describe \u540e\u7684\u7a7a\u914d\u7f6e\u9636\u6bb5\u3002\"\n      },\n      {\n        \"id\": \"B-002\",\n        \"spec\": \"SET-002\",\n        \"phase\": \"pickerOpen\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"add-type\\\"][data-type=\\\"exa\\\"] and [data-type=\\\"bing\\\"]\",\n        \"method\": \"sequence-audit\",\n        \"property\": \"\u9009\u62e9 exa \u4e24\u6b21\uff0c\u518d\u9009\u62e9 bing \u4e00\u6b21\uff1b\u6bcf\u6b21\u65b0\u6761\u76ee\u8ffd\u52a0\u5230\u5217\u8868\u672b\u5c3e\u5e76 enabled\",\n        \"expected\": {\n          \"light\": \"order [exa-1, exa-2, bing]; all enabled\",\n          \"dark\": \"order [exa-1, exa-2, bing]; all enabled\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"UI \u64cd\u4f5c\uff1aadd-tool \u2192 add-type exa \u2192 \u914d\u7f6e\u7b2c\u4e00\u6761\uff1b\u91cd\u590d exa\uff1b\u518d bing\u3002exa \u4e3a\u9700\u51ed\u636e\u7c7b\u578b\uff0cbing \u514d key\u3002\"\n      },\n      {\n        \"id\": \"B-003\",\n        \"spec\": \"SET-004\",\n        \"phase\": \"afterSave\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"field\\\"][data-field=\\\"key\\\"]\",\n        \"method\": \"sequence-audit\",\n        \"property\": \"synthetic credentials redaction self-audit\",\n        \"expected\": {\n          \"light\": \"both exa keys use synthetic sk-TEST-oracle-* only; no plaintext appears in captured logs, RPC report, assertion table, or emitted artifacts\",\n          \"dark\": \"same\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u53ea\u8bb0\u5f55 redacted sentinel\u3001\u957f\u5ea6/\u6570\u91cf\u7b49\u4e0d\u542b\u660e\u6587\u7684\u5143\u6570\u636e\uff1b\u660e\u6587\u51fa\u73b0\u5219 FAIL\u3002\"\n      },\n      {\n        \"id\": \"B-004\",\n        \"spec\": \"SET-004\",\n        \"phase\": \"afterSave\",\n        \"target\": \"fetch instrumentation records for /api/credentials/set and /api/settings/mutate\",\n        \"method\": \"sequence-audit\",\n        \"property\": \"order of credentials/set < order of settings/mutate\",\n        \"expected\": {\n          \"light\": \"each credentials/set for exa precedes the settings/mutate that commits its credentialRef; bing causes no credentials/set\",\n          \"dark\": \"same\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u4fe1\u5c01\u517c\u5bb9 {result:{ok,...}} \u4e0e {ok,...}\uff1b\u53ea\u8bb0\u8131\u654f\u540e\u7684 RPC \u5143\u6570\u636e\u3002\"\n      },\n      {\n        \"id\": \"B-005\",\n        \"spec\": \"SET-004\",\n        \"phase\": \"afterSave\",\n        \"target\": \"all captured RPC fetch records\",\n        \"method\": \"sequence-audit\",\n        \"property\": \"every RPC application-level result is ok\",\n        \"expected\": {\n          \"light\": \"all /api/settings/describe, /api/settings/mutate, /api/credentials/set calls resolve application-level ok=true\",\n          \"dark\": \"same\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"HTTP 200 \u4e0d\u80fd\u66ff\u4ee3\u5e94\u7528\u7ea7 ok \u68c0\u67e5\u3002\"\n      },\n      {\n        \"id\": \"B-006\",\n        \"spec\": \"SET-004\",\n        \"phase\": \"afterSave\",\n        \"target\": \"fetch instrumentation records\",\n        \"method\": \"sequence-audit\",\n        \"property\": \"count of requests whose pathname does not start with /api/\",\n        \"expected\": {\n          \"light\": \"0\",\n          \"dark\": \"0\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u5047\u6a21\u578b provider \u4e3a\u6b7b\u7aef\u53e3\uff1b\u4e0d\u53d1\u9001\u771f\u5b9e\u4f9b\u5e94\u5546/\u6a21\u578b\u8bf7\u6c42\u3002\"\n      },\n      {\n        \"id\": \"B-007\",\n        \"spec\": \"SET-001\",\n        \"phase\": \"afterReload\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"]\",\n        \"method\": \"sequence-audit\",\n        \"property\": \"list order, names, enabled state, credential status badge after reload\",\n        \"expected\": {\n          \"light\": \"three entries in creation order exa-1, exa-2, bing; all enabled; both exa credential badges configured; bing badge follows ready state\",\n          \"dark\": \"same\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"credentialRef \u660e\u6587\u503c\u548c key value \u4e0d\u8bfb\u56de\uff1b\u53ea\u6bd4\u8f83\u72b6\u6001\u5fbd\u6807\u3002\"\n      },\n      {\n        \"id\": \"B-008\",\n        \"spec\": \"SET-004\",\n        \"phase\": \"afterReload\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"field\\\"][data-field=\\\"key\\\"]\",\n        \"method\": \"text-scan\",\n        \"property\": \"stored credential not echoed in input\",\n        \"expected\": {\n          \"light\": \"no plaintext stored key appears in any input value; credential is represented only by configured status badge\",\n          \"dark\": \"same\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u6253\u5f00 exa editor \u540e\u68c0\u67e5\uff1b\u65ad\u8a00\u62a5\u544a\u4e0d\u5305\u542b\u539f key\u3002\"\n      },\n      {\n        \"id\": \"B-009\",\n        \"spec\": \"SET-002\",\n        \"phase\": \"afterReload\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"][data-entry-id]\",\n        \"method\": \"sequence-audit\",\n        \"property\": \"edit first exa name, save and reload; unaffected entries retain name/credential status/enabled\",\n        \"expected\": {\n          \"light\": \"exa-1 has requested replacement name; exa-2 and bing each retain prior name, credential badge state, enabled=true\",\n          \"dark\": \"same\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u4fdd\u5b58\u5e76 reload \u540e\u6309\u7a33\u5b9a data-entry-id \u5bf9\u4e09\u6761\u9010\u4e00\u6bd4\u8f83\uff1b\u51ed\u636e\u53ea\u901a\u8fc7\u5fbd\u6807\u72b6\u6001\u6bd4\u8f83\u3002\"\n      },\n      {\n        \"id\": \"B-010\",\n        \"spec\": \"SET-002\",\n        \"phase\": \"afterReload\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"][data-entry-id]\",\n        \"method\": \"sequence-audit\",\n        \"property\": \"disable second entry, save and reload; preserve position and credential badge\",\n        \"expected\": {\n          \"light\": \"second exa remains at same list index; enabled=false; credential badge unchanged\",\n          \"dark\": \"same\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u5173\u95ed \u2192 \u4fdd\u5b58\u6210\u529f \u2192 reload \u2192 \u91cd\u65b0\u8fdb\u5165\u8bbe\u7f6e\u540e\u8bfb\u56de\u3002\"\n      },\n      {\n        \"id\": \"B-011\",\n        \"spec\": \"SET-002\",\n        \"phase\": \"afterReload\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"][data-entry-id]\",\n        \"method\": \"sequence-audit\",\n        \"property\": \"re-enable second entry, save and reload; original position participates\",\n        \"expected\": {\n          \"light\": \"second exa remains at original list index; enabled=true; credential badge unchanged\",\n          \"dark\": \"same\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u91cd\u65b0\u5f00\u542f \u2192 \u4fdd\u5b58\u6210\u529f \u2192 reload \u2192 \u91cd\u65b0\u8fdb\u5165\u8bbe\u7f6e\u540e\u8bfb\u56de\u3002\"\n      },\n      {\n        \"id\": \"B-012\",\n        \"spec\": \"SET-003\",\n        \"phase\": \"keyboardReorder\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"drag-handle\\\"]\",\n        \"method\": \"sequence-audit\",\n        \"property\": \"ArrowUp/ArrowDown keyboard reorder persists through save and reload\",\n        \"expected\": {\n          \"light\": \"visible list order after reload equals the order produced by keyboard movement before save\",\n          \"dark\": \"same\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u805a\u7126\u628a\u624b\u540e\u4f7f\u7528\u771f\u5b9e Input.dispatchKeyEvent\uff1b\u53d8\u66f4\u5fc5\u987b\u53ef\u5224\u522b\u4e14\u6309 SET-003 \u4fdd\u5b58\u8bfb\u56de\u3002\"\n      },\n      {\n        \"id\": \"B-013\",\n        \"spec\": \"SET-003\",\n        \"phase\": \"dragAttempt\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"][draggable]\",\n        \"method\": \"sequence-audit\",\n        \"property\": \"HTML5 drag attempt reaches reordered list state\",\n        \"expected\": {\n          \"light\": \"if Electron native drag reaches drop and order changes, report observed order; if unreachable, SKIP with gap 'native drag unreachable in Electron'; keyboard reorder B-012 remains required\",\n          \"dark\": \"same\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u5141\u8bb8\u5c1d\u8bd5\u540e\u4e0d\u53ef\u8fbe\uff1b\u4e0d\u53ef\u7528\u811a\u672c\u76f4\u63a5\u6539 draft \u6216 DOM \u6765\u5192\u5145\u539f\u751f\u62d6\u62fd\u3002\"\n      },\n      {\n        \"id\": \"B-014\",\n        \"spec\": \"SET-005\",\n        \"phase\": \"default\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"official-toggle\\\"]\",\n        \"method\": \"sequence-audit\",\n        \"property\": \"default checked state\",\n        \"expected\": {\n          \"light\": \"checked=true; aria-checked=true\",\n          \"dark\": \"same\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u5728\u9996\u6b21\u9ed8\u8ba4\u914d\u7f6e\u9636\u6bb5\u8bfb\u53d6\u3002\"\n      },\n      {\n        \"id\": \"B-015\",\n        \"spec\": \"SET-005\",\n        \"phase\": \"afterReload\",\n        \"target\": \"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"official-toggle\\\"]\",\n        \"method\": \"sequence-audit\",\n        \"property\": \"toggle official search, save and reload persistence\",\n        \"expected\": {\n          \"light\": \"checked and aria-checked after reload equal the value last selected before save\",\n          \"dark\": \"same\"\n        },\n        \"tolerance\": 0,\n        \"failPolicy\": \"missing-element=FAIL; state-unreachable=SKIP gap\",\n        \"notes\": \"\u5148\u8bfb\u9ed8\u8ba4\u5f00\u542f\uff1b\u5207\u6362\u4e3a\u5173\u95ed\u5e76\u4fdd\u5b58 reload \u6838\u5173\u95ed\uff0c\u518d\u5207\u56de\u5f00\u542f\u5e76\u4fdd\u5b58 reload \u6838\u5f00\u542f\u3002\"\n      }\n    ]\n  },\n  \"nonAssertable\": [\n    {\n      \"spec\": \"style-lock \u00a74\",\n      \"target\": \"runtime-injected elevation/shadow/backdrop/scrollbar tokens\",\n      \"property\": \"--dsw-elevation-prominent/-panel/-soft, --dsw-shadow-lv3, --dsw-menu-backdrop-filter, --dsw-scrollbar-bg-l2/hover-l2 resolved values\",\n      \"reason\": \"\u4e3b\u9898\u9759\u6001\u6587\u4ef6\u65e0\u6570\u503c\u5b9a\u4e49\uff1b\u7981\u6b62\u65ad\u8a00\u5177\u4f53\u89e3\u6790\u503c\u3002\u4ec5\u53ef rule-text \u9a8c\u8bc1\u53d8\u91cf\u5f15\u7528\u3002\"\n    },\n    {\n      \"spec\": \"style-lock \u00a74\",\n      \"target\": \"menu icon token\",\n      \"property\": \"light runtime value of --dsw-alias-menu-icon\",\n      \"reason\": \"\u4eae\u8272\u5b9a\u4e49\u672a\u5b9a\u4f4d\uff1b\u53ea\u53ef\u6838 var \u5f15\u7528\u5b58\u5728\u6216\u767b\u8bb0\u3002\"\n    },\n    {\n      \"spec\": \"style-lock \u00a76 item 1\",\n      \"target\": \"future floating menu\",\n      \"property\": \"outer border-radius\",\n      \"reason\": \"\u89c4\u683c\u6ca1\u6709\u83b7\u53d6\u7cbe\u786e\u5706\u89d2\uff0c\u4e14\u5f53\u524d\u9762\u677f\u4e0d\u4ea7\u6d6e\u5c42 DOM\u3002\"\n    },\n    {\n      \"spec\": \"style-lock \u00a76 item 3\",\n      \"target\": \".sc-card\",\n      \"property\": \"box-sizing as official-origin assertion\",\n      \"reason\": \"\u5b98\u65b9 rowCard \u539f\u59cb\u58f0\u660e\u672a\u83b7\u53d6\uff1b\u867d SPC-006 \u660e\u786e\u9489\u6211\u65b9 border-box\uff0c\u672c\u76ee\u5f55\u4e0d\u628a\u5b83\u8c0e\u79f0\u4e3a\u5df2\u83b7\u53d6\u7684\u5b98\u65b9\u503c\u3002\u5b9e\u65bd\u65ad\u8a00\u53ef\u4f9d SPC-006\u3002\"\n    },\n    {\n      \"spec\": \"style-lock \u00a76 item 3\",\n      \"target\": \".sc-card-name\",\n      \"property\": \"official overflow-wrap source value\",\n      \"reason\": \"\u5b98\u65b9\u662f\u5426\u58f0\u660e\u672a\u83b7\u53d6\uff1b\u6211\u65b9 SPC-008 \u4ecd\u660e\u786e\u9489\u4e3a anywhere\uff0c\u6545\u5b9e\u73b0\u65ad\u8a00\u6765\u6e90\u662f SPC-008\u3002\"\n    },\n    {\n      \"spec\": \"style-lock \u00a76 item 3\",\n      \"target\": \".sc-picker-title / .sc-picker-item\",\n      \"property\": \"official picker title/item font-weight\",\n      \"reason\": \"\u5b98\u65b9\u5bf9\u5e94\u5b57\u91cd\u672a\u83b7\u53d6\uff1bSPC-025 \u9489 picker title 600\uff0c\u6309 SPC-025 \u5b9e\u73b0\u65ad\u8a00\uff0c\u4e0d\u4f5c\u5b98\u65b9\u53d6\u8bc1\u5916\u63a8\u3002\"\n    },\n    {\n      \"spec\": \"style-lock \u00a76 item 3\",\n      \"target\": \".sc-add-button\",\n      \"property\": \"whether its override block declares an independent background\",\n      \"reason\": \"\u8be5\u5757\u72ec\u7acb\u58f0\u660e\u672a\u83b7\u53d6\uff1b\u4e0d\u65b0\u589e\u5bf9\u5176\u58f0\u660e\u6765\u6e90\u7684\u65ad\u8a00\u3002\"\n    },\n    {\n      \"spec\": \"style-lock \u00a76 item 3\",\n      \"target\": \".sc-input:focus\",\n      \"property\": \"official presence of outline:none\",\n      \"reason\": \"\u5b98\u65b9\u6b64\u9879\u672a\u83b7\u53d6\uff1bSPC-018 \u7684\u6211\u65b9\u9489\u6b7b\u89c4\u5219\u4ecd\u53ef\u76f4\u63a5\u9a8c\u3002\"\n    },\n    {\n      \"spec\": \"style-lock \u00a76 item 4\",\n      \"target\": \"success/saved notice\",\n      \"property\": \"official success/saved specialized layout\",\n      \"reason\": \"\u5b98\u65b9\u4e13\u5c5e\u6392\u7248\u672a\u83b7\u53d6\uff1b\u82e5\u6211\u65b9 status node \u5b58\u5728\uff0c\u6309 SPC-030 \u9a8c\u6211\u65b9\u9489\u6b7b\u503c\u3002\"\n    },\n    {\n      \"spec\": \"style-lock \u00a76 item 4\",\n      \"target\": \"official top switch / inline picker / idle credential dot\",\n      \"property\": \"official direct analogs\",\n      \"reason\": \"\u5b98\u65b9\u5148\u4f8b\u672a\u83b7\u53d6\uff1b\u53ea\u6309 SPC-010/013/025 \u7684\u660e\u786e\u88c1\u5b9a\u9a8c\u6211\u65b9\u5b9e\u73b0\u3002\"\n    },\n    {\n      \"spec\": \"style-lock \u00a76 item 5\",\n      \"target\": \"theme tokens\",\n      \"property\": \"light menu-icon value and label-primary-inverted chain\",\n      \"reason\": \"\u672a\u83b7\u53d6\uff1b\u4e0d\u4f5c\u6570\u503c\u65ad\u8a00\u3002\"\n    },\n    {\n      \"spec\": \"style-lock \u00a76 item 6\",\n      \"target\": \"host settings shell\",\n      \"property\": \"additional registration-layer styles\",\n      \"reason\": \"\u9501\u5b9a\u8868\u7ed3\u8bba\u4e3a\u65e0\u72ec\u7acb\u89c6\u89c9 CSS\uff1b\u4e0d\u63a8\u5bfc\u989d\u5916\u5bbf\u4e3b\u6570\u503c\u3002\"\n    },\n    {\n      \"spec\": \"style-lock \u00a76 \u672a\u88c1\u5b9a\u9879\",\n      \"target\": \".sc-card-name-placeholder, .sc-type-duplicate, @media (max-width: 720px), .sc-card-actions\",\n      \"property\": \"placeholder/duplicate semantics, mobile overrides, flex-wrap\",\n      \"reason\": \"\u4fdd\u6301\u73b0\u72b6\u5e76\u767b\u8bb0\uff1b\u672a\u88c1\u5b9a\u6570\u503c\u4e0d\u7eb3\u5165\u7cbe\u786e\u503c\u65ad\u8a00\u3002\"\n    },\n    {\n      \"spec\": \"style-lock \u00a76 \u672a\u9a8c\u8bc1\u9879\",\n      \"target\": \"corner-shape fallback\",\n      \"property\": \"browser visual fallback when corner-shape unsupported\",\n      \"reason\": \"\u4ec5\u9a8c\u6211\u65b9 style \u89c4\u5219\u6587\u672c\uff1bChromium \u7248\u672c\u672a\u77e5\uff0c\u672a\u9a8c\u8bc1\u4e0d\u652f\u6301\u65f6\u7684\u89c6\u89c9\u56de\u9000\u3002\"\n    },\n    {\n      \"spec\": \"style-lock \u00a76 \u672a\u9a8c\u8bc1\u9879\",\n      \"target\": \"official card comparison\",\n      \"property\": \"runtime official-vs-ours pixel-perfect equality\",\n      \"reason\": \"\u9501\u5b9a\u8868\u672a\u7ed9\u5b98\u65b9\u5bbf\u4e3b\u5bf9\u7167\u7684\u8fd0\u884c\u65f6\u5c3a\u5bf8\u6d4b\u91cf\uff1b\u6309\u9489\u6b7b\u8ba1\u7b97\u503c\u9a8c\uff0c\u4e0d\u4f5c\u65e0\u4f9d\u636e\u50cf\u7d20\u7b49\u540c\u65ad\u8a00\u3002\"\n    },\n    {\n      \"spec\": \"SET-004\",\n      \"target\": \"settings save failure / revision conflict\",\n      \"property\": \"error recovery behavior\",\n      \"reason\": \"\u672c\u5de5\u4f5c\u5305\u9a8c\u6536\u8bbe\u8ba1\u8981\u6c42\u4fdd\u5b58\u8bfb\u56de\u6210\u529f\u8def\u5f84\uff1b\u672a\u63d0\u4f9b\u9519\u8bef\u6ce8\u5165\u73af\u5883\uff0c\u4e0d\u80fd\u53d1\u660e\u6545\u969c\u6ce8\u5165\u6b65\u9aa4\u6216\u7ed3\u679c\u3002\"\n    }\n  ]\n}";
const CATALOG = JSON.parse(CATALOG_TEXT);
const lunaById = {};
for (const part of ["A", "B"]) for (const a of CATALOG.assertions[part]) lunaById[a.id] = a;

// ───────── 结果登记与脱敏 ─────────
const results = [];
const gaps = [];
const shots = [];
class SkipGap extends Error {}
function redact(s) {
  return String(s).replaceAll(KEY_A, "[synthetic-key-redacted]").replaceAll(KEY_B, "[synthetic-key-redacted]")
    .replaceAll(FAKE_ENV, "[redacted]");
}
function short(s, n = 170) { s = String(s); return s.length > n ? `${s.slice(0, n)}…` : s; }
function rec(id, theme, measured, result, extra = "") {
  const a = lunaById[id] || {};
  if (result === "SKIP") gaps.push(`${id}（${a.spec || "子检查"}，${theme}）：${redact(extra || "state-unreachable")}`);
  results.push({
    id, spec: a.spec || (id.match(/^A-0\d\d\.\w$/) ? "子检查" : "?"), theme, method: a.method || "sub",
    expected: redact(short((a.expected && a.expected[theme]) || (a.expected && a.expected.light) || id, 170)),
    measured: redact(short(measured, 170)), result, extra: redact(short(extra, 100)),
  });
}
async function exec(id, theme, fn) {
  try { const { measured } = await fn(); rec(id, theme, measured, "PASS"); }
  catch (err) {
    if (err instanceof SkipGap) rec(id, theme, `state-unreachable: ${err.message}`, "SKIP", err.message);
    else rec(id, theme, `${(err && err.message) || err}`, "FAIL");
  }
}

// ───────── 页面原语 ─────────
async function probe(vars) {
  return evaluate(`(() => { const out = {}; const span = document.createElement('span'); span.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;'; document.body.appendChild(span); const cs = getComputedStyle(span); for (const v of ${JSON.stringify(vars)}) { span.style.color = 'var(' + v + ')'; out[v] = cs.color; } span.remove(); return out; })()`, 30000);
}
async function probeRadius(vars) {
  return evaluate(`(() => { const out = {}; const span = document.createElement('span'); span.style.cssText = 'position:fixed;left:-9999px;top:0;display:block;width:20px;height:20px;'; document.body.appendChild(span); for (const v of ${JSON.stringify(vars)}) { span.style.borderRadius = 'var(' + v + ')'; out[v] = getComputedStyle(span).borderTopLeftRadius; } span.remove(); return out; })()`, 30000);
}
async function computed(target, props, pseudo) {
  return evaluate(`(() => { const el = document.querySelector(${JSON.stringify(target)}); if (!el) return null; const cs = getComputedStyle(el, ${JSON.stringify(pseudo || null)}); const o = {}; for (const p of ${JSON.stringify(props)}) o[p] = cs[p]; return o; })()`, 30000);
}
async function rects(selectors) {
  return evaluate(`(() => { const out = {}; for (const [k, sel] of Object.entries(${JSON.stringify(selectors)})) { const el = document.querySelector(sel); if (!el) { out[k] = null; continue; } const r = el.getBoundingClientRect(); out[k] = { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, padRight: parseFloat(getComputedStyle(el).paddingRight) || 0 }; } return out; })()`, 30000);
}
async function cssRules() {
  return evaluate(`(() => {
    const style = document.querySelector('${ROOT} style[data-sc-style="panel"]') || document.querySelector('style[data-sc-style="panel"]');
    if (!style) return { missing: true, rules: [] };
    const rules = [];
    const walk = (list, mediaText) => { for (const r of list) {
      if (r.type === CSSRule.STYLE_RULE) rules.push({ sel: r.selectorText, text: r.style.cssText, media: mediaText });
      else if (r.media) walk(r.cssRules, mediaText ? mediaText + " and " + r.media.mediaText : r.media.mediaText);
    } };
    try { walk(style.sheet.cssRules, null); } catch (e) { return { missing: false, rules: [], unreadable: String(e.message) }; }
    return { missing: false, rules };
  })()`, 30000);
}
function norm(s) { return String(s).replace(/\s+/g, "").toLowerCase(); }
function eqCss(a, b) { return norm(a) === norm(b); }
// 机械比较器：wantProbe=同页 token 解析值（also=Luna §4 表字面值）；wantFn=语义等值；want=直接字面。
async function checkProps(target, props, pseudo) {
  if (!(await evaluate(`() => !!document.querySelector(${JSON.stringify(target)})`, 30000))) throw new Error(`missing element: ${target}`);
  const got = await computed(target, props.map((p) => p.prop), pseudo);
  if (!got) throw new Error(`missing element: ${target}`);
  const mis = []; const measured = {};
  for (const p of props) {
    const actual = got[p.prop];
    measured[p.prop] = actual;
    if (p.noteOnly) continue;
    let ok;
    if (p.wantProbe) {
      const resolved = (await probe([p.wantProbe]))[p.wantProbe];
      ok = actual === resolved && (!p.also || norm(actual) === norm(p.also));
      if (!ok) mis.push(`${p.prop} got ${actual}（token ${p.wantProbe} 解析 ${resolved}，期望 ${p.also || "同 token"}）`);
    } else if (p.wantFn) {
      ok = p.wantFn(actual, measured);
      if (!ok) mis.push(`${p.prop} got ${actual}，期望 ${p.wantLabel}`);
    } else {
      ok = eqCss(actual, p.want);
      if (!ok) mis.push(`${p.prop} got ${actual} 期望 ${p.want}`);
    }
  }
  if (mis.length) throw new Error(mis.join(" | "));
  return JSON.stringify(measured);
}
const T = {
  card: (id) => `${ROOT} [data-role="card"][data-entry-id="${id}"]`,
  toggle: (id) => `${ROOT} [data-role="enabled-toggle"][data-entry-id="${id}"]`,
  track: (id) => `${T.toggle(id)} + .sc-switch-track`,
  switchLabel: (id) => `${ROOT} label:has([data-role="enabled-toggle"][data-entry-id="${id}"])`,
};
const OFFICIAL_TOGGLE = `${ROOT} [data-role="official-toggle"]`;
const OFFICIAL_TRACK = `${OFFICIAL_TOGGLE} + .sc-switch-track`;
const ui = {
  click: (sel) => evaluate(`() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; }`, 30000),
  state: () => evaluate(`() => {
    const root = document.querySelector('${ROOT}'); if (!root) return { absent: true };
    const cards = [...root.querySelectorAll('[data-role="card"]')];
    const vis = (el) => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
    return {
      ids: cards.map((c) => c.getAttribute('data-entry-id')),
      types: cards.map((c) => ((c.querySelector('[data-role="card-type"]')?.textContent || c.getAttribute('data-type') || c.querySelector('[data-role="card-name"]')?.textContent || '').trim())),
      names: cards.map((c) => (c.querySelector('[data-role="card-name"]')?.textContent || '').trim()),
      enabled: cards.map((c) => c.querySelector('[data-role="enabled-toggle"]')?.checked),
      dotStates: cards.map((c) => {
        const dot = c.querySelector('.sc-status-dot');
        const st = dot && dot.getAttribute('data-state');
        if (st) return st;
        // HEAD（纠偏前）徽标以状态文案表达（已就绪/缺少凭据引用/已关闭）；SET 层徽标语义按状态读，样式层 data-state 缺失由 A-019 判别。
        const t = (c.querySelector('.sc-status')?.textContent || '').trim();
        return t === '已就绪' ? 'ready' : t === '缺少凭据引用' ? 'missing' : t === '已关闭' ? 'disabled' : null;
      }),
      emptyVisible: vis(root.querySelector('[data-role="empty-state"]')),
      officialChecked: root.querySelector('[data-role="official-toggle"]')?.checked,
      officialAria: root.querySelector('[data-role="official-toggle"]')?.getAttribute('aria-checked'),
      saveText: (root.querySelector('[data-role="save"]')?.textContent || '').trim(),
      saveWidth: root.querySelector('[data-role="save"]')?.getBoundingClientRect().width,
    };
  }`, 30000),
};
async function calls() { return evaluate(`() => { try { return JSON.parse(sessionStorage.getItem('__oracle50Calls') || '[]'); } catch { return []; } }`, 30000); }
function appOk(r) { return !!r && (r.ok === true || (!!r.response && ((r.response.result && r.response.result.ok === true) || r.response.ok === true))); }
async function waitRpc(path, fromIndex, limit = 90) {
  for (let i = 0; i < limit; i++) { const c = await calls(); if (c.slice(fromIndex).some((x) => x.url === path)) return c; await wait(1000); }
  throw new Error(`超时未见 RPC：${path}`);
}
async function openSettings() {
  await pageWait(`() => !!document.body && !((document.body.innerText || '').includes('Loading plugins'))`, "app shell 就绪", 150);
  const hasPanel = async () => evaluate(`() => !!document.querySelector('${ROOT}')`, 30000);
  if (await hasPanel()) return;
  const clickDirect = () => evaluate(`() => {
    const cands = [...document.querySelectorAll('button,a,[role="button"],[role="menuitem"]')];
    const item = cands.find((n) => /^(设置|Settings)$/i.test((n.innerText || n.getAttribute('aria-label') || n.getAttribute('title') || '').trim()));
    if (item) item.click();
    return !!item;
  }`, 30000);
  const clickAcc = () => evaluate(`() => {
    const cands = [...document.querySelectorAll('button,[role="button"]')];
    const item = cands.find((n) => /^(账号菜单|账户菜单|Account.*)$/i.test((n.getAttribute('aria-label') || n.title || n.innerText || '').trim()));
    if (item) item.click();
    return !!item;
  }`, 30000);
  const clickSettingsItem = () => evaluate(`() => {
    const leaves = [...document.querySelectorAll('button,[role="menuitem"],[role="menuitem"] *')].filter((n) => n.children.length === 0);
    const row = leaves.find((n) => /^(设置|Settings)(\s*[⌘⌃⌥⇧].*)?$/i.test((n.innerText || '').trim()))
      || [...document.querySelectorAll('button,[role="menuitem"]')].find((n) => /^(设置|Settings)\s*[⌘⌃⌥⇧]/i.test((n.innerText || '').trim()));
    if (row) { (row.closest('button,[role="menuitem"]') || row).click(); return true; }
    return false;
  }`, 30000);
  for (let i = 0; i < 16 && !(await hasPanel()); i++) await wait(500); // 直挂宽容
  if (await hasPanel()) return;
  const direct = await clickDirect();
  if (!direct) {
    let acc = false;
    for (let i = 0; i < 40 && !acc; i++) { acc = await clickAcc(); if (!acc) await wait(500); }
    if (!acc) skipAll("页面既无「设置」入口也无「账号菜单」触发器，宿主设置面不可验证。");
    let st = false;
    for (let i = 0; i < 12 && !st; i++) { st = await clickSettingsItem(); if (!st) { await clickAcc(); await wait(700); } } // 菜单未开则重开
    if (!st) skipAll("账号菜单内无「设置」项，宿主设置面不可验证。");
  }
  for (let i = 0; i < 20 && !(await hasPanel()); i++) await wait(500);
  if (await hasPanel()) return;
  // 设置抽屉按节渲染：点「网页搜索链」导航行。
  if (!(await navClick("网页搜索链"))) { await wait(2000); if (!(await navClick("网页搜索链"))) skipAll("设置抽屉导航无「网页搜索链」分区，被测面板不可达。"); }
  await pageWait(`() => !!document.querySelector('${ROOT}')`, "search-chain 设置面板", 90);
}
async function reloadAndReopen() {
  const before = (await calls()).length;
  await cdp("Page.reload");
  await pageWait(`() => !!document.body`, "reload body", 90);
  await wait(2500);
  await openSettings();
  for (let i = 0; i < 60; i++) {
    const c = await calls();
    if (c.slice(before).some((x) => x.url === "/api/settings/describe" && appOk(x))) {
      // describe 回包 ≠ 面板重渲染完成：轮询卡片列表落定（本轮所有 reload 点持久条目均 ≥3），避免读到渲染前空态。
      for (let j = 0; j < 20; j++) { const s0 = await ui.state(); if (s0.ids && s0.ids.length) break; await wait(1000); }
      await wait(400);
      return;
    }
    await wait(1000);
  }
  skipAll("reload 后 describe 未应用级成功，保存读回面不可验证。");
}
async function addViaPicker(type) {
  if (!(await ui.click(`${ROOT} [data-role="add-tool"]`))) throw new Error("add-tool 缺失");
  await wait(400);
  if (!(await ui.click(`${ROOT} [data-role="add-type"][data-type="${type}"]`))) throw new Error(`add-type ${type} 缺失`);
  await wait(500);
}
async function openEditor(cardId) { if (!(await ui.click(`${T.card(cardId)} [data-role="card-edit"]`))) throw new Error("card-edit 缺失"); await wait(450); }
async function closeEditor() {
  await evaluate(`() => { const b = [...document.querySelectorAll('${ROOT} [data-role="editor"] button')].find((n) => (n.textContent || '').trim() === '完成'); if (b) b.click(); return !!b; }`, 30000);
  await wait(400);
}
async function setField(field, value) {
  return evaluate(`() => {
    const input = document.querySelector('${ROOT} [data-role="field"][data-field="${field}"]');
    if (!input) return null;
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  }`, 30000);
}
async function pressKey(key, code, keyCode) {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
}
async function focusSel(sel) {
  return evaluate(`() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.focus(); return document.activeElement === el; }`, 30000);
}
async function shot(name, clipSel) {
  try {
    let clip;
    if (clipSel) {
      const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(clipSel)}); if (!el) return null; el.scrollIntoView({ block: 'start' }); const r = el.getBoundingClientRect(); return { x: Math.max(0, r.x + scrollX - 8), y: Math.max(0, r.y + scrollY - 8), width: Math.min(r.width + 16, 1290), height: Math.min(r.height + 16, 6000), small: r.height < 500 }; })()`, 30000);
      if (!box) return false;
      clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: box.small ? 2 : 1 };
    }
    const img = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, ...(clip ? { clip } : {}) });
    writeFileSync(join(ART_DIR, name), Buffer.from(img.data, "base64"));
    shots.push(name);
    return true;
  } catch (e) { console.log(`[oracle-style-50] 截图失败 ${name}: ${redact(String(e.message))}`); return false; }
}
async function unionShot(name, selA, selB) {
  const box = await evaluate(`(() => { const bs = [${JSON.stringify(selA)}, ${JSON.stringify(selB)}].map((s) => document.querySelector(s)).filter(Boolean); if (!bs.length) return null; const rs = bs.map((el) => el.getBoundingClientRect()); const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y)); const right = Math.max(...rs.map((r) => r.right)), bottom = Math.max(...rs.map((r) => r.bottom)); return { x: Math.max(0, x + scrollX - 8), y: Math.max(0, y + scrollY - 8), width: Math.min(right - x + 16, 1290), height: Math.min(bottom - y + 16, 6000) }; })()`, 30000);
  if (!box) return false;
  const img = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...box, scale: 1 } });
  writeFileSync(join(ART_DIR, name), Buffer.from(img.data, "base64"));
  shots.push(name);
  return true;
}
async function sectionShotByText(texts, fileName) {
  const found = await evaluate(`(() => {
    for (const t of ${JSON.stringify(texts)}) {
      const hs = [...document.querySelectorAll('h1,h2,h3,[class*="title"]')].filter((n) => (n.textContent || '').trim() === t && n.getBoundingClientRect().width > 0);
      if (!hs.length) continue;
      const sec = hs[0].closest('section,[class*="section"]') || hs[0].parentElement;
      sec.scrollIntoView({ block: 'start' });
      const r = sec.getBoundingClientRect();
      return { x: Math.max(0, r.x + scrollX - 8), y: Math.max(0, r.y + scrollY - 8), width: Math.min(r.width + 16, 1290), height: Math.min(r.height + 16, 6000) };
    }
    return null;
  })()`, 30000);
  if (!found) return false;
  const img = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...found, scale: 1 } });
  writeFileSync(join(ART_DIR, fileName), Buffer.from(img.data, "base64"));
  shots.push(fileName);
  return true;
}
async function navClick(text) {
  // 抽屉导航行可能是 button/[role] 或自定义 li/div：innerText 全等只命中叶子行元素，点击冒泡到行。
  return evaluate(`() => { const items = [...document.querySelectorAll('button,a,[role="button"],[role="tab"],[role="menuitem"],li,[class*="navRow"],[class*="nav"] div')]; const it = items.find((n) => (n.innerText || n.getAttribute('aria-label') || '').trim() === ${JSON.stringify(text)}); if (it) { it.click(); return true; } return false; }`, 30000);
}
async function smallestContainerShot(needle, fileName) {
  const box = await evaluate(`(() => {
    let best = null;
    for (const el of document.querySelectorAll('section,article,li,[class*="card"],[class*="Card"],[class*="section"],div')) {
      const t = (el.innerText || '');
      if (!t.includes(${JSON.stringify(needle)})) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 24) continue;
      if (r.width * r.height > 900000) continue;
      if (t.length > 600) continue;
      if (!best || r.width * r.height < best.area) best = { area: r.width * r.height, x: r.x, y: r.y, w: r.width, h: r.height };
    }
    if (!best) return null;
    const el2 = [...document.querySelectorAll('section,article,li,[class*="card"],[class*="Card"],[class*="section"],div')].find((el) => { const r = el.getBoundingClientRect(); return (el.innerText || '').includes(${JSON.stringify(needle)}) && Math.abs(r.x - best.x) < 1 && Math.abs(r.y - best.y) < 1; });
    if (!el2) return null;
    el2.scrollIntoView({ block: 'center' });
    const r = el2.getBoundingClientRect();
    return { x: Math.max(0, r.x + scrollX - 8), y: Math.max(0, r.y + scrollY - 8), width: Math.min(r.width + 16, 1290), height: Math.min(r.height + 16, 6000) };
  })()`, 30000);
  if (!box) return false;
  const img = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...box, scale: 1 } });
  writeFileSync(join(ART_DIR, fileName), Buffer.from(img.data, "base64"));
  shots.push(fileName);
  return true;
}
const officialShotState = { models: false, web: false, note: "" };
async function officialSectionShots() {
  // 实机入口（probe10 取证）：设置抽屉导航行 模型 / 内置插件 / 网页搜索链（renderSlot only:active 逐节渲染）。
  const models = await navClick("模型");
  if (models) {
    await wait(1600);
    officialShotState.models = (await sectionShotByText(["模型"], "official-models.png")) || (await smallestContainerShot("模型", "official-models.png"));
  }
  if (!(await navClick("网页搜索链"))) await wait(800);
  await pageWait(`() => !!document.querySelector('${ROOT}')`, "返回我方分区", 30);
  // 本构建的官方「网页搜索」配置位于 内置插件 分区（「网页搜索与获取」卡片，probe 实证）。
  const builtin = await navClick("内置插件");
  if (builtin) {
    await wait(1600);
    officialShotState.web = (await sectionShotByText(["内置插件", "网页搜索与获取"], "official-web-search.png")) || (await smallestContainerShot("网页搜索与获取", "official-web-search.png"));
  }
  await navClick("网页搜索链");
  await pageWait(`() => !!document.querySelector('${ROOT}')`, "返回我方分区", 30);
  if (!officialShotState.models) officialShotState.note += "官方「模型」分区截图不可达；";
  if (!officialShotState.web) officialShotState.note += "官方「网页搜索与获取」配置截图不可达（取证缺口，不影响 A/B 断言）；";
  await wait(600);
}
async function darkAttr(on) { await evaluate(`() => { if (${on}) document.body.setAttribute('data-ds-dark-theme', ''); else document.body.removeAttribute('data-ds-dark-theme'); return true; }`, 30000); await wait(400); }
async function tryHover(sel) {
  const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`, 30000);
  if (!box) return false;
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x - 50, y: box.y - 50 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await wait(350);
  return evaluate(`() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && el.matches(':hover'); }`, 30000);
}
async function nativeDragAttempt(cardId) {
  const box = await evaluate(`(() => { const el = document.querySelector('${T.card(cardId)} [data-role="drag-handle"]'); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`, 30000);
  if (!box) throw new Error("missing element: drag-handle");
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  let dragging = null;
  for (let i = 1; i <= 14 && dragging === null; i++) {
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: Math.max(2, box.y - i * 7), button: "left" });
    dragging = await evaluate(`() => { const el = document.querySelector('${ROOT} [data-role="card"][data-dragging]'); return el ? getComputedStyle(el).opacity : null; }`, 30000);
    await wait(60);
  }
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: Math.max(2, box.y - 96), button: "left" });
  await wait(500);
  return dragging;
}
const saveSamples = []; // {theme, text, width}（A-032 「width follows label content」采样面）
async function captureSaveSample(theme, tag) {
  const s = await ui.state();
  if (s.absent) return;
  const e = { theme, tag, text: s.saveText, width: s.saveWidth };
  const prev = saveSamples[saveSamples.length - 1];
  if (!prev || prev.text !== e.text || prev.theme !== theme || prev.tag !== tag) saveSamples.push(e);
}
async function captureDisabledFamilies(theme = "light") {
  // 单次点击保存 + 轮询 locked 窗口（不重复点击，避免多轮 mutate 污染 B-004 序列审计）。
  await captureSaveSample(theme, "pre-save");
  const clicked = await evaluate(`() => { const el = document.querySelector('${ROOT} [data-role="save"]'); if (!el || el.disabled) return false; el.click(); return true; }`, 30000);
  if (!clicked) return null;
  for (let i = 0; i < 150; i++) {
    const fam = await evaluate(`(() => {
      const get = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return { opacity: cs.opacity, cursor: cs.cursor }; };
      return {
        button: get('${ROOT} [data-role="save"]'),
        action: get('${ROOT} [data-role="add-tool"]'),
        input: get('${ROOT} [data-role="field"][data-field="name"]'),
        track: get('${ROOT} .sc-switch-input:disabled + .sc-switch-track'),
        switchLabel: get('${ROOT} .sc-switch:has(.sc-switch-input:disabled)'),
      };
    })()`, 30000);
    if (fam.button && fam.button.cursor !== "pointer") { await captureSaveSample(theme, "pending"); return fam; }
    await wait(8);
  }
  const late = await evaluate(`() => { const el = document.querySelector('${ROOT} [data-role="save"]'); return !!el && el.disabled; }`, 30000);
  if (late) {
    const fam = await evaluate(`(() => {
      const get = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return { opacity: cs.opacity, cursor: cs.cursor }; };
      return { button: get('${ROOT} [data-role="save"]'), action: get('${ROOT} [data-role="add-tool"]'), input: get('${ROOT} [data-role="field"][data-field="name"]'), track: get('${ROOT} .sc-switch-input:disabled + .sc-switch-track'), switchLabel: get('${ROOT} .sc-switch:has(.sc-switch-input:disabled)') };
    })()`, 30000);
    if (fam.button) { await captureSaveSample(theme, "pending"); return fam; }
  }
  return null;
}

async function a034Phase(theme, famObj) {
  await exec("A-034", theme, async () => {
    if (!famObj) throw new SkipGap("locked 保存窗口未采到（state-unreachable；点击后 locked 同步置位窗口过短）");
    const mis = [];
    const chk = (label, v, opac, cursor = "default") => { if (!v) mis.push(`${label} 样本缺失`); else if (v.opacity !== opac || (cursor && v.cursor !== cursor)) mis.push(`${label} got ${JSON.stringify(v)} 期望 opacity ${opac} cursor ${cursor}`); };
    chk("button", famObj.button, "0.4");
    chk("action", famObj.action, "0.4");
    chk("input", famObj.input, "0.6");
    chk("track", famObj.track, "0.5");
    chk("switchLabel", famObj.switchLabel, "0.5");
    if (mis.length) throw new Error(`SPC-017 三档 ${JSON.stringify(famObj)}；${mis.join(" | ")}`);
    return { measured: "button/action .4 default；input .6 default；switch track+label .5 default" };
  });
}
async function a025Phase(theme, famObj) {
  await exec("A-025", theme, async () => {
    if (!famObj) throw new SkipGap("locked 保存窗口未采到（与 A-034 同窗口）");
    const t = famObj.track;
    if (!t) throw new Error('missing element: .sc-switch-input:disabled + .sc-switch-track（locked 时开关未禁用）');
    if (t.opacity !== "0.5" || t.cursor !== "default") throw new Error(`disabled 开关轨道 got ${JSON.stringify(t)} 期望 opacity .5 cursor default（废止 .55）`);
    return { measured: `disabled 轨道 ${JSON.stringify(t)}` };
  });
}

// ───────── A 执行器（逐条对应 Luna 目录条目） ─────────
let cardIds = [];
let fam = null; // locked 窗口三档采样
async function settleSaved() {
  // 「已保存」落定轮询；瞬态面板 unmount（宿主抽屉抖动，run-8 B-015 实证）→ 幂等重开导航续轮（≤2 次），saveText 缺失不崩溃。
  let reopens = 0;
  for (let i = 0; i < 60; i++) {
    const s = await ui.state();
    if (s.absent) {
      if (reopens >= 2) return false;
      reopens++;
      await openSettings();
      await wait(600);
      continue;
    }
    if (String(s.saveText || "").includes("已保存")) return true;
    await wait(1000);
  }
  return false;
}
async function saveAndSettle() {
  const before = (await calls()).length;
  if (!(await ui.click(`${ROOT} [data-role="save"]`))) { await openSettings(); await ui.click(`${ROOT} [data-role="save"]`); } // 抽屉瞬态 unmount 兜底
  await wait(700);
  await waitRpc("/api/settings/mutate", before, 60).catch(() => {});
  return settleSaved();
}

async function styleSweep(theme) {
  const c1 = cardIds[0], c2 = cardIds[1], c3 = cardIds[2];
  await exec("A-001", theme, async () => {
    const geo = await rects({ panel: `${ROOT} .sc-panel` });
    const parentW = await evaluate(`(() => { const el = document.querySelector('${ROOT} .sc-panel'); if (!el || !el.parentElement) return null; const cs = getComputedStyle(el.parentElement); const r = el.parentElement.getBoundingClientRect(); return r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); })()`, 30000);
    const measured = await checkProps(`${ROOT} .sc-panel`, [
      { prop: "boxSizing", want: "border-box" }, { prop: "display", want: "flex" }, { prop: "flexDirection", want: "column" },
      { prop: "gap", want: "12px" }, { prop: "maxWidth", want: "720px" },
    ]);
    if (!geo.panel) throw new Error("missing element: .sc-panel");
    if (parentW !== null && Math.abs(geo.panel.w - parentW) > 1) throw new Error(`width 100% 前提不成立 got ${geo.panel.w} 父列内容宽 ${parentW}`);
    return { measured: `${measured} width=${geo.panel.w}/父列${parentW}` };
  });
  await exec("A-002", theme, async () => {
    const geo = await rects({ panel: `${ROOT} .sc-panel` });
    if (!geo.panel) throw new Error("missing element: .sc-panel");
    if (geo.panel.w > 720.5) throw new Error(`视口 1300px 下 panel 宽 ${geo.panel.w}px > 720（max-width 未钳制列宽）`);
    return { measured: `视口 1300px → panel 宽 ${geo.panel.w}px ≤ 720` };
  });
  await exec("A-003", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-title`, [
    { prop: "marginTop", want: "0px" }, { prop: "marginRight", want: "0px" }, { prop: "marginBottom", want: "0px" }, { prop: "marginLeft", want: "0px" },
    { prop: "fontSize", want: "16px" }, { prop: "lineHeight", want: "24px" }, { prop: "fontWeight", want: "500" },
  ]) }));
  await exec("A-004", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-title`, [
    { prop: "color", wantProbe: "--dsw-alias-label-primary", also: theme === "light" ? "rgb(15, 17, 21)" : "rgb(249, 250, 251)" },
  ]) }));
  await exec("A-005", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-description`, [
    { prop: "marginTop", want: "0px" }, { prop: "marginRight", want: "0px" }, { prop: "marginBottom", want: "0px" }, { prop: "marginLeft", want: "0px" },
    { prop: "fontSize", want: "14px" }, { prop: "lineHeight", want: "22px" },
  ]) }));
  await exec("A-006", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-description`, [
    { prop: "color", wantProbe: "--dsw-alias-label-tertiary", also: theme === "light" ? "rgb(129, 133, 140)" : "rgb(173, 178, 184)" },
  ]) }));
  await exec("A-007", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-card-list`, [
    { prop: "listStyleType", want: "none" }, { prop: "marginTop", want: "12px" }, { prop: "marginRight", want: "0px" },
    { prop: "marginBottom", want: "0px" }, { prop: "marginLeft", want: "0px" }, { prop: "paddingTop", want: "0px" },
    { prop: "display", want: "flex" }, { prop: "flexDirection", want: "column" }, { prop: "gap", want: "8px" },
  ]) }));
  await exec("A-008", theme, async () => {
    const radius = (await probeRadius(["--dsw-radius-xl"]))["--dsw-radius-xl"];
    return { measured: await checkProps(`${ROOT} [data-role="card"]`, [
      { prop: "boxSizing", want: "border-box" }, { prop: "position", want: "relative" },
      { prop: "borderTopWidth", want: "0.5px" }, { prop: "borderTopStyle", want: "solid" },
      { prop: "borderTopLeftRadius", want: radius }, { prop: "paddingTop", want: "12px" }, { prop: "paddingLeft", want: "14px" },
      { prop: "display", want: "flex" }, { prop: "flexDirection", want: "column" }, { prop: "gap", want: "12px" },
    ]) };
  });
  await exec("A-009", theme, async () => ({ measured: await checkProps(`${ROOT} [data-role="card"]`, [
    { prop: "backgroundColor", wantProbe: "--dsw-alias-settings-card-fill", also: theme === "light" ? "rgb(255, 255, 255)" : "rgb(44, 44, 46)" },
    { prop: "borderTopColor", wantProbe: "--dsw-alias-settings-card-stroke", also: theme === "light" ? "rgba(0, 0, 0, 0.16)" : "rgba(255, 255, 255, 0.2)" },
  ]) }));
  await exec("A-010", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-card-row`, [
    { prop: "display", want: "flex" }, { prop: "alignItems", want: "center" }, { prop: "gap", want: "10px" }, { prop: "minWidth", want: "0px" },
  ]) }));
  await exec("A-011", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-card-info`, [
    { prop: "display", want: "inline-flex" }, { prop: "alignItems", want: "center" }, { prop: "gap", want: "6px" }, { prop: "minWidth", want: "0px" },
  ]) }));
  await exec("A-012", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-card-actions`, [
    { prop: "display", want: "inline-flex" }, { prop: "alignItems", want: "center" }, { prop: "gap", want: "4px" }, { prop: "marginLeft", want: "auto" },
  ]) }));
  await exec("A-013", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-card-name`, [
    { prop: "fontSize", want: "14px" }, { prop: "lineHeight", want: "22px" }, { prop: "fontWeight", want: "500" },
    { prop: "wordBreak", wantFn: (a, m) => eqCss(a, "anywhere") || eqCss(m.overflowWrap, "anywhere"), wantLabel: "anywhere（word-break 或 overflow-wrap）" },
    { prop: "overflowWrap", want: "anywhere", noteOnly: true },
  ]) }));
  await exec("A-014", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-card-name`, [
    { prop: "color", wantProbe: "--dsw-alias-label-primary", also: theme === "light" ? "rgb(15, 17, 21)" : "rgb(249, 250, 251)" },
  ]) }));
  await exec("A-015", theme, async () => {
    const radius = (await probeRadius(["--dsw-radius-xs"]))["--dsw-radius-xs"];
    return { measured: await checkProps(`${ROOT} .sc-type-badge`, [
      { prop: "flexGrow", want: "0" }, { prop: "flexShrink", want: "0" },
      { prop: "paddingTop", want: "1px" }, { prop: "paddingLeft", want: "6px" },
      { prop: "borderTopWidth", want: "0.5px" }, { prop: "borderTopStyle", want: "solid" },
      { prop: "borderTopLeftRadius", want: radius }, { prop: "fontSize", want: "11px" }, { prop: "lineHeight", want: "16px" },
      { prop: "whiteSpace", want: "nowrap" },
    ]) };
  });
  await exec("A-016", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-type-badge`, [
    { prop: "borderTopColor", wantProbe: "--dsw-alias-border-l3", also: theme === "light" ? "rgba(0, 0, 0, 0.12)" : "rgba(255, 255, 255, 0.16)" },
    { prop: "color", wantProbe: "--dsw-alias-label-secondary", also: theme === "light" ? "rgb(97, 102, 107)" : "rgb(207, 211, 214)" },
  ]) }));
  await exec("A-020", theme, async () => {
    const rules = await cssRules();
    if (rules.missing) throw new Error('missing element: style[data-sc-style="panel"]');
    const dots = (rules.rules || []).filter((r) => r.sel.includes(".sc-status-dot"));
    if (!dots.length) throw new Error("未检出 .sc-status-dot 规则");
    if (!dots.some((r) => /corner-shape/i.test(r.text) && norm(r.text).includes("round"))) throw new Error(`.sc-status-dot 规则缺 corner-shape: round；现有=${dots.map((r) => r.text.slice(0, 90)).join(" ;; ")}`);
    return { measured: "状态点规则含 corner-shape: round（与 50% 圆角成对）" };
  });
  // SPC-011 开关族：需要一个 checked=true（官方开关）与 checked=false 轨道样本（临时关 bing）。
  await evaluate(`(() => { const el = document.querySelector('${T.toggle(c3)}'); if (el && el.checked) el.click(); return true; })()`, 30000);
  await wait(300);
  await exec("A-021", theme, async () => {
    const geo = await rects({ track: `${ROOT} .sc-switch-track` });
    if (!geo.track) throw new Error("missing element: .sc-switch-track");
    const props = await computed(`${ROOT} .sc-switch-track`, ["boxSizing", "paddingTop", "borderTopWidth"]);
    const mis = [];
    if (Math.abs(geo.track.w - 36) > 0.01 || Math.abs(geo.track.h - 20) > 0.01) mis.push(`geometry got ${geo.track.w}×${geo.track.h} 期望 36×20`);
    if (props.paddingTop !== "2px") mis.push(`padding 期望 2px got ${props.paddingTop}`);
    if (props.borderTopWidth !== "0px") mis.push(`border 期望 0 got ${props.borderTopWidth}`);
    if (mis.length) throw new Error(mis.join(" | "));
    return { measured: `36×20 padding 2px border 0（boxSizing=${props.boxSizing}）` };
  });
  await exec("A-022", theme, async () => {
    const off = await checkProps(T.track(c3), [
      { prop: "backgroundColor", wantProbe: "--dsw-alias-border-l3", also: theme === "light" ? "rgba(0, 0, 0, 0.12)" : "rgba(255, 255, 255, 0.16)" },
    ]);
    const on = await checkProps(OFFICIAL_TRACK, [
      { prop: "backgroundColor", wantProbe: "--dsw-alias-brand-primary", also: theme === "light" ? "rgb(15, 17, 21)" : "rgb(249, 250, 251)" },
    ]);
    return { measured: `unchecked{${off}} checked{${on}}` };
  });
  await exec("A-023", theme, async () => {
    const off = await checkProps(T.track(c3), [
      { prop: "width", want: "16px" }, { prop: "height", want: "16px" }, { prop: "borderTopLeftRadius", want: "50%" },
      { prop: "transitionProperty", want: "transform" }, { prop: "transitionDuration", want: "0.12s" },
      { prop: "transitionTimingFunction", want: "ease" }, { prop: "transform", want: "none" },
    ], "::after");
    const on = await checkProps(OFFICIAL_TRACK, [
      { prop: "transform", wantFn: (a) => norm(a) === "matrix(1,0,0,1,16,0)", wantLabel: "translate(16px) ≡ matrix(1,0,0,1,16,0)" },
    ], "::after");
    return { measured: `unchecked{${off}} checked{${on}}` };
  });
  await exec("A-024", theme, async () => {
    const off = await checkProps(T.track(c3), [
      { prop: "backgroundColor", wantProbe: "--dsw-alias-switch-thumb", also: theme === "light" ? "rgb(255, 255, 255)" : "rgb(173, 178, 184)" },
    ], "::after");
    const on = await checkProps(OFFICIAL_TRACK, [
      { prop: "backgroundColor", wantProbe: "--dsw-alias-label-primary-foreground", also: theme === "light" ? "rgb(255, 255, 255)" : "rgb(15, 17, 21)" },
    ], "::after");
    return { measured: `unchecked{${off}} checked{${on}}` };
  });
  await exec("A-026", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-switch`, [
    { prop: "display", want: "inline-flex" }, { prop: "alignItems", want: "center" }, { prop: "gap", want: "8px" },
    { prop: "color", wantProbe: "--dsw-alias-label-secondary", also: theme === "light" ? "rgb(97, 102, 107)" : "rgb(207, 211, 214)" },
    { prop: "cursor", want: "pointer" }, { prop: "whiteSpace", want: "nowrap" },
  ]) }));
  await exec("A-027", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-official-row`, [
    { prop: "display", want: "flex" }, { prop: "flexDirection", want: "column" }, { prop: "alignItems", want: "flex-start" },
    { prop: "gap", want: "8px" }, { prop: "backgroundColor", want: "rgba(0, 0, 0, 0)" }, { prop: "borderTopWidth", want: "0px" },
  ]) }));
  await evaluate(`(() => { const el = document.querySelector('${T.toggle(c3)}'); if (el && !el.checked) el.click(); return true; })()`, 30000); // 恢复 bing enabled（未保存草稿动作）
  await wait(250);
  await exec("A-028", theme, async () => {
    const radius = (await probeRadius(["--dsw-radius-md"]))["--dsw-radius-md"];
    return { measured: await checkProps(`${ROOT} .sc-button`, [
      { prop: "boxSizing", want: "border-box" }, { prop: "display", want: "inline-flex" },
      { prop: "alignItems", want: "center" }, { prop: "justifyContent", want: "center" }, { prop: "gap", want: "4px" },
      { prop: "height", want: "36px" }, { prop: "paddingLeft", want: "14px" }, { prop: "borderTopWidth", want: "0px" },
      { prop: "borderTopLeftRadius", want: radius }, { prop: "fontSize", want: "14px" }, { prop: "lineHeight", want: "22px" },
    ]) };
  });
  await exec("A-029", theme, async () => {
    // Luna call-2 修正：hover 底色属于 A-029 同一断言，汇总判——hover 不可达整条 SKIP，不符合整条 FAIL，不再单列目录外行。
    const measured = await checkProps(`${ROOT} .sc-button-primary`, [
      { prop: "backgroundColor", wantProbe: "--dsw-alias-button-primary-fill", also: theme === "light" ? "rgb(15, 17, 21)" : "rgb(249, 250, 251)" },
      { prop: "color", wantProbe: "--dsw-alias-label-primary-foreground", also: theme === "light" ? "rgb(255, 255, 255)" : "rgb(15, 17, 21)" },
    ]);
    const pv = await probe(["--dsw-alias-button-primary-hover"]);
    const expected = theme === "light" ? "rgb(67, 69, 74)" : "rgb(235, 238, 242)";
    const hovered = await tryHover(`${ROOT} .sc-button-primary`);
    if (!hovered) throw new SkipGap(`底/字色实测 ${measured}；hover 底态不可达（CDP hover flaky，目录 failPolicy state-unreachable=SKIP；hover 并入 A-029 整条）`);
    const bg = (await computed(`${ROOT} .sc-button-primary`, ["backgroundColor"])).backgroundColor;
    if (norm(bg) !== norm(expected)) throw new Error(`hover 底 got ${bg} 期望 button-primary-hover ${expected}（解析 ${pv["--dsw-alias-button-primary-hover"]}）`);
    return { measured: `${measured} hover 底=${bg}` };
  });
  await exec("A-030", theme, async () => {
    const rules = await cssRules();
    if (rules.missing) throw new Error('missing element: style[data-sc-style="panel"]');
    const hovers = (rules.rules || []).filter((r) => r.sel.includes(":hover"));
    if (!hovers.length) throw new Error("面板无 hover 规则（应有按钮/picker hover 体系）");
    const bad = hovers.filter((r) => !/hover\s*:\s*hover/i.test(r.media || ""));
    if (bad.length) throw new Error(`${bad.length}/${hovers.length} 条 hover 声明不在 @media (hover: hover) 内：${bad.slice(0, 3).map((r) => r.sel).join(", ")}`);
    return { measured: `${hovers.length} 条 hover 声明全部位于 @media (hover: hover)` };
  });
  await exec("A-031", theme, async () => {
    const radius = (await probeRadius(["--dsw-radius-sm"]))["--dsw-radius-sm"];
    return { measured: await checkProps(`${ROOT} .sc-card-actions .sc-button-secondary`, [
      { prop: "height", want: "28px" }, { prop: "paddingLeft", want: "10px" },
      { prop: "borderTopLeftRadius", want: radius }, { prop: "fontSize", want: "12px" }, { prop: "lineHeight", want: "18px" },
    ]) };
  });
  if (theme === "dark") await exec("A-032", theme, async () => {
    const geo = await rects({ save: `${ROOT} [data-role="save"]`, panel: `${ROOT} .sc-panel` });
    if (!geo.save || !geo.panel) throw new Error("missing element: [data-role=save]/.sc-panel");
    const delta = Math.abs(geo.save.right - (geo.panel.right - geo.panel.padRight));
    if (delta > 1) throw new Error(`保存钮右缘 ${geo.save.right} 未对齐面板内容右缘（差 ${delta.toFixed(2)}px）`);
    return { measured: `右缘差 ${delta.toFixed(2)}px；width follows label content 采样与 light 共用（无暗态独立保存点）` };
  });
  await exec("A-033", theme, async () => {
    const radius = (await probeRadius(["--dsw-radius-md"]))["--dsw-radius-md"];
    return { measured: await checkProps(`${ROOT} [data-role="save"]`, [
      { prop: "alignSelf", want: "flex-end" }, { prop: "height", want: "36px" }, { prop: "paddingLeft", want: "14px" },
      { prop: "borderTopLeftRadius", want: radius }, { prop: "fontSize", want: "14px" }, { prop: "lineHeight", want: "22px" },
    ]) };
  });
  await exec("A-041", theme, async () => {
    const geo = await rects({ add: `${ROOT} [data-role="add-tool"]`, panel: `${ROOT} .sc-panel` });
    if (!geo.add || !geo.panel) throw new Error("missing element: [data-role=add-tool]/.sc-panel");
    const contentW = geo.panel.w - 2 * geo.panel.padRight;
    const mis = [];
    if (Math.abs(geo.add.h - 44) > 0.01) mis.push(`height got ${geo.add.h} 期望 44`);
    if (Math.abs(geo.add.w - contentW) > 1) mis.push(`宽度未填满可用行 got ${geo.add.w} 期望 ${contentW}`);
    if (mis.length) throw new Error(mis.join(" | "));
    return { measured: `height 44px；行宽 ${geo.add.w}px 填满可用行` };
  });
  await exec("A-042", theme, async () => ({ measured: await checkProps(`${ROOT} [data-role="add-tool"]`, [
    { prop: "borderTopColor", wantProbe: "--dsw-alias-border-l3", also: theme === "light" ? "rgba(0, 0, 0, 0.12)" : "rgba(255, 255, 255, 0.16)" },
    { prop: "color", wantProbe: "--dsw-alias-label-primary", also: theme === "light" ? "rgb(15, 17, 21)" : "rgb(249, 250, 251)" },
  ]) }));
  await exec("A-051", theme, async () => {
    const geo = await rects({ handle: `${ROOT} [data-role="drag-handle"]` });
    if (!geo.handle) throw new Error("missing element: [data-role=drag-handle]");
    if (Math.abs(geo.handle.w - 28) > 0.01 || Math.abs(geo.handle.h - 28) > 0.01) throw new Error(`geometry got ${geo.handle.w}×${geo.handle.h} 期望 28×28`);
    return { measured: "28px × 28px" };
  });
}

async function dotsPhase(theme, viaTavilyDraft) {
  // 三态以真实条目达成：ready（免 key 的 bing / 已配置 exa）+ missing（enabled 无 key）+ disabled（关闭态）。
  const s = await ui.state();
  const readyCard = cardIds.find((id, i) => s.dotStates[i] === "ready") ?? null;
  const missingCard = cardIds.find((id, i) => s.dotStates[i] === "missing") ?? null;
  let offCard = null; let tav = null;
  if (viaTavilyDraft) {
    await addViaPicker("tavily");
    const s2 = await ui.state();
    tav = s2.ids[s2.ids.length - 1];
  }
  const mSrc = missingCard ?? tav;
  if (mSrc) {
    await evaluate(`(() => { const el = document.querySelector('${T.toggle(mSrc)}'); if (el && el.checked) el.click(); return true; })()`, 30000);
    await wait(280);
    offCard = mSrc;
  }
  await exec("A-017", theme, async () => ({ measured: await checkProps(`${ROOT} [data-role="card"] .sc-status-dot`, [
    { prop: "boxSizing", want: "border-box" }, { prop: "display", want: "inline-block" },
    { prop: "flexGrow", want: "0" }, { prop: "flexShrink", want: "0" },
    { prop: "width", want: "8px" }, { prop: "height", want: "8px" }, { prop: "borderTopLeftRadius", want: "50%" },
  ]) }));
  await exec("A-018", theme, async () => ({ measured: await checkProps(`${ROOT} [data-role="card"] .sc-status`, [
    { prop: "display", want: "inline-flex" }, { prop: "flexGrow", want: "0" }, { prop: "flexShrink", want: "0" },
    { prop: "alignItems", want: "center" }, { prop: "gap", want: "6px" }, { prop: "fontSize", want: "13px" },
    { prop: "lineHeight", want: "20px" }, { prop: "fontWeight", want: "400" }, { prop: "whiteSpace", want: "nowrap" },
  ]) }));
  await exec("A-019", theme, async () => {
    const parts = []; const mis = [];
    if (readyCard) {
      try { parts.push(`ready{${await checkProps(`${T.card(readyCard)} .sc-status-dot[data-state="ready"]`, [{ prop: "backgroundColor", wantProbe: "--dsw-alias-state-success-primary", also: theme === "light" ? "rgb(34, 197, 94)" : "rgb(34, 197, 94)" }])}}`); }
      catch (e) { mis.push(`ready: ${e.message}`); }
    } else mis.push("ready 态条目不可达");
    if (mSrc) {
      try { parts.push(`missing{${await checkProps(`${T.card(mSrc)} .sc-status-dot[data-state="missing"]`, [{ prop: "backgroundColor", wantProbe: "--dsw-alias-state-error-primary", also: theme === "light" ? "rgb(236, 19, 19)" : "rgb(242, 90, 90)" }])}}`); }
      catch (e) { mis.push(`missing: ${e.message}`); }
    } else mis.push("missing 态条目不可达");
    if (offCard) {
      try { parts.push(`disabled{${await checkProps(`${T.card(offCard)} .sc-status-dot[data-state="disabled"]`, [{ prop: "backgroundColor", wantProbe: "--dsw-alias-state-idle-primary", also: theme === "light" ? "rgb(212, 212, 212)" : "rgb(84, 85, 87)" }])}}`); }
      catch (e) { mis.push(`disabled: ${e.message}`); }
    } else mis.push("disabled 态不可达");
    if (mis.length) throw new Error(mis.join(" | "));
    return { measured: parts.join(" ") };
  });
  // 复原：恢复开关并清理 tavily 草稿（本地移除，不落库）。
  if (offCard && offCard !== tav) {
    await evaluate(`(() => { const el = document.querySelector('${T.toggle(offCard)}'); if (el && !el.checked) el.click(); return true; })()`, 30000);
    await wait(250);
  }
  if (tav) {
    await ui.click(`${T.card(tav)} [data-role="card-remove"]`);
    await wait(350);
    if (!(await ui.click(`${ROOT} [data-role="confirm-remove"]`))) throw new Error("confirm-remove 缺失，tavily 草稿未清理");
    await wait(350);
  }
}

async function pickerPhase(theme, doShot) {
  await ui.click(`${ROOT} [data-role="add-tool"]`);
  await wait(450);
  await exec("A-043", theme, async () => {
    const radius = (await probeRadius(["--dsw-radius-lg"]))["--dsw-radius-lg"];
    // Luna call-2 修正：目录 property 含 background——补 SPC-019 铬层底 token 对偶（probe 同页解析值与实测一致；§4 该 token 非静态值不做 RGB 硬钉）。
    const bg = await checkProps(`${ROOT} .sc-picker`, [
      { prop: "backgroundColor", wantProbe: "--dsw-alias-bg-module-platform" },
    ]);
    return { measured: `${bg} ｜` + await checkProps(`${ROOT} .sc-picker`, [
      { prop: "gap", want: "8px" }, { prop: "paddingTop", want: "14px" }, { prop: "paddingLeft", want: "16px" },
      { prop: "borderTopLeftRadius", want: radius },
    ]) };
  });
  await exec("A-044", theme, async () => {
    const radius = (await probeRadius(["--dsw-radius-md"]))["--dsw-radius-md"];
    const w = await evaluate(`(() => { const it = document.querySelector('${ROOT} [data-role="add-type"]'); const pk = it && it.closest('.sc-picker'); if (!it || !pk) return null; return { iw: it.getBoundingClientRect().width, pw: pk.getBoundingClientRect().width, pPad: parseFloat(getComputedStyle(pk).paddingLeft) || 0 }; })()`, 30000);
    const measured = await checkProps(`${ROOT} [data-role="add-type"]`, [
      { prop: "display", want: "flex" }, { prop: "flexDirection", want: "column" }, { prop: "alignItems", want: "flex-start" },
      { prop: "gap", want: "4px" }, { prop: "paddingTop", want: "14px" }, { prop: "paddingLeft", want: "16px" },
      { prop: "borderTopWidth", want: "0px" }, { prop: "borderTopLeftRadius", want: radius },
    ]);
    if (!w) throw new Error("missing element: [data-role=add-type]/.sc-picker");
    if (Math.abs(w.iw - (w.pw - 2 * w.pPad)) > 1) throw new Error(`width 100% 前提不成立 got ${w.iw} 期望 ${w.pw - 2 * w.pPad}`);
    return { measured: `width=100%(${w.iw}) ${measured}` };
  });
  await exec("A-045", theme, async () => {
    const mis = []; const parts = [];
    try {
      parts.push(`itemBg{${await checkProps(`${ROOT} [data-role="add-type"]`, [
        { prop: "backgroundColor", wantProbe: "--dsw-alias-bg-layer-1", also: theme === "light" ? "rgb(255, 255, 255)" : "rgb(35, 35, 36)" },
        { prop: "color", wantProbe: "--dsw-alias-label-primary", also: theme === "light" ? "rgb(15, 17, 21)" : "rgb(249, 250, 251)" },
      ])}}`);
    } catch (e) { mis.push(e.message); }
    try {
      parts.push(`billing{${await checkProps(`${ROOT} .sc-picker-billing`, [
        { prop: "color", wantProbe: "--dsw-alias-label-tertiary", also: theme === "light" ? "rgb(129, 133, 140)" : "rgb(173, 178, 184)" },
      ])}}`);
    } catch (e) { mis.push(`billing: ${e.message}`); }
    if (mis.length) throw new Error(mis.join(" | "));
    const expected = theme === "light" ? "rgb(241, 243, 245)" : "rgb(53, 54, 56)";
    const hovered = await tryHover(`${ROOT} [data-role="add-type"]`);
    if (!hovered) throw new SkipGap(`hover 态不可达（bg/label/billing 已实证：${parts.join(" ").slice(0, 90)}…）`);
    const bg = (await computed(`${ROOT} [data-role="add-type"]`, ["backgroundColor"])).backgroundColor;
    if (norm(bg) !== norm(expected)) throw new Error(`hover 底 got ${bg} 期望 interactive-bg-hover-solid ${expected}`);
    return { measured: `${parts.join(" ")} hover{${bg}}` };
  });
  if (doShot) await shot("picker-open.png", `${ROOT} .sc-picker`);
  await ui.click(`${ROOT} [data-role="add-tool"]`);
  await wait(300);
}

async function editorPhase(theme, doShot) {
  await exec("A-037", theme, async () => {
    const radius = (await probeRadius(["--dsw-radius-lg"]))["--dsw-radius-lg"];
    return { measured: await checkProps(`${ROOT} [data-role="editor"]`, [
      { prop: "boxSizing", want: "border-box" }, { prop: "display", want: "flex" }, { prop: "flexDirection", want: "column" },
      { prop: "gap", want: "14px" }, { prop: "paddingTop", want: "14px" }, { prop: "paddingLeft", want: "16px" },
      { prop: "borderTopLeftRadius", want: radius },
      { prop: "backgroundColor", wantProbe: "--dsw-alias-module-platform" },
    ]) };
  });
  await exec("A-038", theme, async () => ({ measured: await checkProps(`${ROOT} [data-role="editor"] .sc-editor-title`, [
    { prop: "marginTop", want: "0px" }, { prop: "marginRight", want: "0px" }, { prop: "marginBottom", want: "0px" }, { prop: "marginLeft", want: "0px" },
    { prop: "fontSize", want: "14px" }, { prop: "lineHeight", want: "22px" }, { prop: "fontWeight", want: "500" },
  ]) }));
  await exec("A-039", theme, async () => {
    const radius = (await probeRadius(["--dsw-radius-md"]))["--dsw-radius-md"];
    const geo = await evaluate(`(() => { const f = document.querySelector('${ROOT} [data-role="field"]'); if (!f) return null; const i = f.querySelector('input, textarea') || f; return { fw: f.getBoundingClientRect().width, iw: i.getBoundingClientRect().width }; })()`, 30000);
    if (!geo) throw new Error('missing element: [data-role="field"]');
    const measured = await checkProps(`${ROOT} [data-role="field"] input, ${ROOT} [data-role="field"] textarea`, [
      { prop: "height", want: "32px" }, { prop: "paddingLeft", want: "10px" },
      { prop: "borderTopWidth", want: "0.5px" }, { prop: "borderTopStyle", want: "solid" },
      { prop: "borderTopColor", wantProbe: "--dsw-alias-border-l4" }, { prop: "borderTopLeftRadius", want: radius },
      { prop: "fontSize", want: "14px" }, { prop: "lineHeight", want: "22px" },
    ]);
    if (Math.abs(geo.iw - geo.fw) > 1) throw new Error(`width 100% 前提不成立 input ${geo.iw} ≠ field ${geo.fw}`);
    return { measured: `width=100%(${geo.iw}/${geo.fw}) ${measured}` };
  });
  await exec("A-040", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-input`, [
    { prop: "color", wantProbe: "--dsw-alias-label-dimmed", also: theme === "light" ? "rgb(225, 229, 238)" : "rgb(67, 69, 74)" },
  ], "::placeholder") }));
  if (doShot) await shot("editor-open.png", `${ROOT} [data-role="editor"]`);
}

async function a047(theme = "light") {
  // 真实校验路径达成错误态（editorOpen 相位内调用；编辑器须已开启）：
  // 名称置空白 → 保存被客户端拒绝（零 RPC）→ 错误文本上屏。Luna call-2：light/dark 双主题执行。
  if ((await setField("name", "   ")) === null) throw new Error("name 字段不可达");
  await ui.click(`${ROOT} [data-role="save"]`);
  await wait(600);
  await exec("A-047", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-error`, [
    { prop: "color", wantProbe: "--dsw-alias-state-error-primary", also: theme === "light" ? "rgb(236, 19, 19)" : "rgb(242, 90, 90)" },
  ]) }));
  if ((await setField("name", "Oracle Alpha")) !== "Oracle Alpha") throw new Error("名称恢复失败");
  await closeEditor();
}

async function a046confirmPhase(theme = "light") {
  // confirmOpen：点目标卡移除 → 采危险色 → 取消（避免误删测试数据，Luna phase 原文）。Luna call-2：双主题 + hover 不可达整条 SKIP。
  const target = cardIds[2];
  await ui.click(`${T.card(target)} [data-role="card-remove"]`);
  await wait(400);
  await exec("A-046", theme, async () => {
    const measured = await checkProps(`${ROOT} [data-role="confirm-remove"]`, [
      { prop: "color", wantProbe: "--dsw-alias-state-error-primary", also: theme === "light" ? "rgb(236, 19, 19)" : "rgb(242, 90, 90)" },
    ]);
    const wantHover = theme === "light" ? "rgba(236, 19, 19, 0.05)" : "rgba(242, 90, 90, 0.15)";
    const pv = await probe(["--dsw-alias-interactive-bg-hover-danger"]);
    const hovered = await tryHover(`${ROOT} [data-role="confirm-remove"]`);
    if (!hovered) throw new SkipGap(`危险前景已实证 ${measured}；hover interactive-bg-hover-danger(${wantHover}) 子检查不可达 → 整条 SKIP（目录 failPolicy state-unreachable）`);
    const bg = (await computed(`${ROOT} [data-role="confirm-remove"]`, ["backgroundColor"])).backgroundColor;
    if (norm(bg) !== norm(wantHover)) throw new Error(`hover 底 got ${bg} 期望 interactive-bg-hover-danger ${wantHover}（解析 ${pv["--dsw-alias-interactive-bg-hover-danger"]}）`);
    return { measured: `${measured} hover{${bg}}` };
  });
  const cancelled = await evaluate(`() => { const b = [...document.querySelectorAll('${ROOT} [data-role="editor"] button, ${ROOT} button')].filter((n) => n.offsetParent).find((n) => (n.textContent || '').trim() === '取消'); if (b) { b.click(); return true; } return false; }`, 30000);
  if (cancelled) await wait(300);
}

async function focusPassPhase() {
  await exec("A-035", "light", async () => {
    const rules = await cssRules();
    if (rules.missing) throw new Error('missing element: style[data-sc-style="panel"]');
    const rs = rules.rules || [];
    const miss = [];
    const bs = norm(JSON.stringify(rs.filter((r) => /focus-visible/i.test(r.sel)).map((r) => (r.media ? "@m" : "") + r.text)));
    if (!bs.includes(norm("box-shadow:0 0 0 var(--dsw-focus-ring-width, 2px) var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))"))) miss.push("按钮 :focus-visible box-shadow 焦点环变量机制（禁 brand-primary 写死）");
    if (!bs.includes(norm("outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))"))) miss.push("开关 :focus-visible outline 变量机制");
    if (!bs.includes(norm("outline-offset:2px"))) miss.push("outline-offset 2px");
    if (!rs.some((r) => /focus-visible/i.test(r.sel) && /data-input-modality/i.test(r.sel || "") + /data-input-modality/i.test(r.media || ""))) miss.push("html[data-input-modality='pointer'] 指针模态抑制规则（该条件通常在选择器文本内，Luna call-2 修正）");
    if (!rs.some((r) => /:focus(?!-visible)/i.test(r.sel) && /input|field|sc-input/i.test(r.sel) && norm(r.text).includes(norm("border-color:var(--dsw-alias-state-business-primary)")))) miss.push("输入框 :focus border-color state-business-primary");
    const brandFocus = rs.filter((r) => /focus/i.test(r.sel) && norm(r.text).includes("brand-primary"));
    if (brandFocus.length) miss.push(`焦点体系使用 brand-primary（SPC-018 禁止）：${brandFocus.slice(0, 2).map((r) => r.sel).join(", ")}`);
    if (miss.length) throw new Error(`SPC-018 规则缺失：${miss.join("；")}`);
    return { measured: "box-shadow/outline 双变量机制 + 2px + outline-offset 2px + 指针模态抑制 + 输入 :focus business 描边全检出" };
  });
  // 真实 Tab 遍历（Luna：不得用 el.focus() 作 focus-visible 证据）；picker 开启使 picker 项入焦点序。
  await ui.click(`${ROOT} [data-role="add-tool"]`);
  await wait(400);
  await evaluate(`() => { const el = document.querySelector('${ROOT}'); el && el.setAttribute('data-oracle-anchor', '1'); return true; }`, 30000);
  const samples = [];
  let switchFocusShotTaken = false;
  for (let i = 0; i < 60; i++) {
    await pressKey("Tab", "Tab", 9);
    await wait(50);
    const s = await evaluate(`(() => { const el = document.activeElement; if (!el || el === document.body) return null; const root = document.querySelector('${ROOT}'); const inPanel = !!(root && root.contains(el)); if (!inPanel) return null; const fv = el.matches(':focus-visible'); const cs = getComputedStyle(el); return { fv, tag: el.tagName, role: el.getAttribute('data-role'), cls: String(el.className).slice(0, 50), boxShadow: cs.boxShadow.slice(0, 110), outline: cs.outline.slice(0, 80), border: cs.borderColor }; })()`, 30000);
    if (s && s.fv) {
      samples.push(s);
      if (!switchFocusShotTaken && (s.role === "official-toggle" || s.role === "enabled-toggle" || /switch/i.test(s.cls))) {
        await shot("switch-focus.png", `${ROOT} label:has([data-role="official-toggle"])`);
        switchFocusShotTaken = true;
      }
    }
    if (samples.length >= 5 && i >= 30) break;
  }
  await ui.click(`${ROOT} [data-role="add-tool"]`); // 收起 picker
  await wait(300);
  await exec("A-036", "light", async () => {
    if (!samples.length) throw new SkipGap("真实 Tab 遍历未获得面板内 :focus-visible 焦点（键盘路径不可达）");
    const pv = await probe(["--dsw-alias-state-business-primary"]);
    const ring = norm(pv["--dsw-alias-state-business-primary"]);
    const bad = [];
    for (const s of samples) {
      const paint = norm(s.boxShadow + "|" + s.outline + "|" + s.border);
      const hasColor = paint.includes(ring);
      const has2px = /(^|[^0-9.])2px/.test(paint);
      if (!hasColor || !has2px) bad.push(`${s.role || s.cls}: 环=${s.boxShadow || s.outline || s.border}`);
    }
    if (bad.length) throw new Error(`${bad.length}/${samples.length} 个真实 :focus-visible 焦点环未达 2px + business-primary（解析 ${pv["--dsw-alias-state-business-primary"]}）——逐样本判定，任一不符即 FAIL（Luna call-2）：${bad[0]}`);
    return { measured: `${samples.length}/${samples.length} 个真实 :focus-visible 焦点环 = 2px + business-primary ${pv["--dsw-alias-state-business-primary"]}` };
  });
  if (!switchFocusShotTaken) await shot("switch-focus.png", `${ROOT} label:has([data-role="official-toggle"])`);
}

async function reducedMotionPhase(theme = "light") {
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await wait(350);
  await exec("A-050", theme, async () => {
    const rules = await cssRules();
    if (rules.missing) throw new Error('missing element: style[data-sc-style="panel"]');
    const rm = (rules.rules || []).filter((r) => /prefers-reduced-motion/i.test(r.media || ""));
    const bare = rm.find((r) => /\.sc-switch-track(?![\w:-])/.test(r.sel) && !/::after/.test(r.sel) && norm(r.text).includes("transition:none"));
    const after = rm.find((r) => /\.sc-switch-track::after/.test(r.sel) && norm(r.text).includes("transition:none"));
    if (!bare || !after) throw new Error(`@media (prefers-reduced-motion: reduce) 内缺 .sc-switch-track / ::after 的 transition:none（track=${!!bare} after=${!!after}）；reduce 规则=${JSON.stringify(rm.map((r) => r.sel + "{" + r.text + "}")).slice(0, 260)}`);
    const t = await computed(OFFICIAL_TRACK, ["transitionDuration", "transitionProperty"]);
    const a = await computed(OFFICIAL_TRACK, ["transitionDuration", "transitionProperty"], "::after");
    // Luna call-2：track 与 ::after 分别判定、任一不符即 FAIL。运行时判定基准=transitionDuration 必须 0s
    //（transition:none 的 computed 语义是 property=all/duration=0s，字面 property==="none" 在 Chromium 永不可满足；
    // 0s 时长即「无过渡」的运行时等价，与 Luna 决策 5 的 CONFIRM 文本一致；两值均入 measured 供复核）。
    if (t.transitionDuration !== "0s" || t.transitionProperty === "transform") throw new Error(`reduce 模拟下 track 运行时 transition=${JSON.stringify(t)}`);
    if (a.transitionDuration !== "0s" || a.transitionProperty === "transform") throw new Error(`reduce 模拟下 ::after 运行时 transition=${JSON.stringify(a)}`);
    return { measured: `reduce 媒体下 track+::after transition:none 规则检出；运行时 track{${t.transitionProperty} ${t.transitionDuration}} after{${a.transitionProperty} ${a.transitionDuration}}（duration 必须 0s，transform 残留即 FAIL）` };
  });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await wait(250);
}

async function a053RuleScan() {
  const rules = await cssRules();
  if (rules.missing) throw new Error('missing element: style[data-sc-style="panel"]');
  const text = (rules.rules || []).map((r) => `${r.media ? "@media " + r.media + "{" : ""}${r.sel}{${r.text}}`).join("\n");
  const need = [
    [/data-dragging[^}]*opacity:\s*\.5|data-dragging[^}]*opacity:\s*0\.5/i, "[data-dragging] opacity .5"],
    [/data-drop-target[^}]*z-index:\s*1($|;|")/i, "[data-drop-target] z-index 1"],
    [/::before[^}]*height:\s*4px/i, "before/after 指示线 height 4px"],
    [/::before[^}]*top:\s*-4px/i, "before top -4px"],
    [/::after[^}]*bottom:\s*-4px/i, "after bottom -4px"],
    [/data-drop-target[^\n]*height:\s*12px/i, "放置态 before/after height 12px"],
    [/55deg[^\n]*--dsw-alias-state-business-primary/i, "55deg 渐变 business-primary"],
    [/125deg[^\n]*--dsw-alias-state-business-primary/i, "125deg 渐变 business-primary"],
    [/4px 5px[^\n]*calc\(100% - 4px\) 2px|calc\(100% - 4px\) 2px/i, "4px 5px / calc(100% - 4px) 2px 线"],
    [/data-drop-target[^\n]*top:\s*-10px/i, "放置态 before top -10px"],
    [/data-drop-target[^\n]*bottom:\s*-10px/i, "放置态 after bottom -10px"],
  ];
  const miss = need.filter(([re]) => !re.test(text)).map(([, label]) => label);
  // Luna call-2：容差明文「不得增加 pointer-events:none」——指示线规则族若出现该声明按目录判 FAIL。
  const peBlocks = (rules.rules || []).filter((r) => /data-drop-target|data-dragging/.test(r.sel) && /pointer-events/i.test(r.text));
  if (peBlocks.length) miss.push(`指示线/拖动态规则含 pointer-events 声明（目录容差禁止）：${peBlocks.slice(0, 2).map((r) => r.sel).join(", ")}`);
  if (miss.length) throw new Error(`指示线/拖动态规则缺失或违例：${miss.join("；")}`);
  return "dragging .5 / drop-target z-index 1 / 4px→12px / ±4→±10 / 55°+125° business-primary 渐变 + calc(100%-4px) 2px 线全检出；pointer-events 违例 0";
}

// ───────── 主流程 ─────────
try {
  await pageWait(`() => !!document.body`, "document body", 90);
  await openSettings();
  await pageWait(`() => { const c = Array.isArray(window.__oracle50Calls) ? window.__oracle50Calls : (() => { try { return JSON.parse(sessionStorage.getItem('__oracle50Calls') || '[]'); } catch { return []; } })(); return c.some((x) => x.url === '/api/settings/describe'); }`, "首次 describe", 90);
  // 亮色基线卫生（与 Luna 暗态裁定同一 hook 对称）：宿主可能随系统外观在启动即挂 body[data-ds-dark-theme]；
  // 亮色主题扫描必须显式移除该属性，否则「light」相位实为暗色渲染（run-7 实证 A-004 light 读到暗 token）。
  const bootDark = await evaluate(`(() => { const had = document.body.hasAttribute('data-ds-dark-theme'); document.body.removeAttribute('data-ds-dark-theme'); return had; })()`, 30000);
  if (bootDark) console.log("[oracle-style-50] 亮色基线：宿主启动即暗色外观，已按 Luna 双主题裁定的同一 hook 移除 body[data-ds-dark-theme] 建立亮色基线；reload 后由宿主按用户设置自然恢复。");
  await wait(400);
  const chrome = await evaluate(`() => navigator.userAgent`, 15000);

  // dataSetup：空配置（B-001）+ 默认官方开关（B-014）
  await exec("B-001", "light", async () => {
    const s = await ui.state();
    if (s.absent) throw new Error("missing element: panel");
    if (!s.emptyVisible) throw new Error("entries=[] 时 [data-role=empty-state] 不可见");
    return { measured: "空配置下 empty-state 可见（引导添加文案上屏）" };
  });
  await exec("B-014", "light", async () => {
    const s = await ui.state();
    if (s.officialChecked !== true || s.officialAria !== "true") throw new Error(`默认态 checked=${s.officialChecked} aria=${s.officialAria}，期望 true/true`);
    return { measured: "official-toggle checked=true aria-checked=true（默认开启）" };
  });
  await exec("A-054", "light", async () => ({ measured: await checkProps(`${ROOT} [data-role="save"]`, [
    { prop: "backgroundColor", wantProbe: "--dsw-alias-button-primary-fill", also: "rgb(15, 17, 21)" },
    { prop: "color", wantProbe: "--dsw-alias-label-primary-foreground", also: "rgb(255, 255, 255)" },
  ]) }));

  // pickerOpen/afterSave 前置：exa、exa、bing 依创建顺序（B-002）
  await addViaPicker("exa"); await addViaPicker("exa"); await addViaPicker("bing");
  await exec("B-002", "light", async () => {
    const s = await ui.state();
    cardIds = s.ids;
    if (cardIds.length !== 3) throw new Error(`卡数 ${cardIds.length} ≠ 3`);
    const types = JSON.stringify(s.types.map((t) => t.toLowerCase()));
    if (types !== '["exa","exa","bing rss"]' && types !== '["exa","exa","bing"]') throw new Error(`类型序列 got ${types} 期望 [exa, exa, bing]`);
    if (!s.enabled.slice(0, 3).every((v) => v === true)) throw new Error(`启用态 got ${JSON.stringify(s.enabled)} 期望全 enabled`);
    return { measured: `order [exa-1=${cardIds[0]}, exa-2=${cardIds[1]}, bing=${cardIds[2]}] 全 enabled（credentialRef 以服务端分配为准）` };
  });

  // 三态圆点（dataSetup：此时 exa 无 key=missing、bing=ready、开关关=disabled）
  await dotsPhase("light", false);

  // 编辑器：改名 + 合成 key（两 exa 各一枚；bing 无 key）
  await openEditor(cardIds[0]);
  if ((await setField("name", "Oracle Alpha")) !== "Oracle Alpha") throw new Error("c1 改名输入失败");
  if ((await setField("key", KEY_A)) !== KEY_A) throw new Error("c1 key 输入失败");
  await closeEditor();
  await openEditor(cardIds[1]);
  if ((await setField("name", "Oracle Beta")) !== "Oracle Beta") throw new Error("c2 改名输入失败");
  if ((await setField("key", KEY_B)) !== KEY_B) throw new Error("c2 key 输入失败");
  await closeEditor();

  // 亮色主扫描（default 族；面板保持挂载，分区切换会 unmount，故官方区取证挪到保存之后）
  await shot("our-panel-light.png", ROOT);
  await styleSweep("light");
  // 开关开/闭双态特写：官方开关=on；临时关 bing=off → 合并边界框特写 → 复原。
  await evaluate(`(() => { const el = document.querySelector('${T.toggle(cardIds[2])}'); if (el && el.checked) el.click(); return true; })()`, 30000);
  await wait(300);
  await unionShot("switch-open-closed.png", `${ROOT} label:has([data-role="official-toggle"])`, T.switchLabel(cardIds[2]));
  await evaluate(`(() => { const el = document.querySelector('${T.toggle(cardIds[2])}'); if (el && !el.checked) el.click(); return true; })()`, 30000);
  await wait(250);

  await pickerPhase("light", true);
  await openEditor(cardIds[0]);
  await editorPhase("light", true);
  await a047(); // 错误态（editorOpen，客户端校验拒绝，零 RPC；内部 closeEditor）
  await a046confirmPhase(); // confirmOpen（采完即取消）

  // afterSave：保存（locked 三档采样）+ 序列审计 + 保存状态样式
  const saveStart = (await calls()).length;
  fam = await captureDisabledFamilies("light");
  await a034Phase("light", fam);
  await a025Phase("light", fam);
  // 等待本轮 RPC 完成
  await waitRpc("/api/settings/mutate", saveStart, 60).catch(() => {});
  await settleSaved();
  await captureSaveSample("light", "settled");
  await exec("A-032", "light", async () => {
    const geo = await rects({ save: `${ROOT} [data-role="save"]`, panel: `${ROOT} .sc-panel` });
    if (!geo.save || !geo.panel) throw new Error("missing element: [data-role=save]/.sc-panel");
    const delta = Math.abs(geo.save.right - (geo.panel.right - geo.panel.padRight));
    if (delta > 1) throw new Error(`保存钮右缘 ${geo.save.right} 未对齐面板内容右缘（差 ${delta.toFixed(2)}px）`);
    const mine = saveSamples.filter((x) => x.theme === "light");
    const distinct = new Map(mine.map((x) => [x.text, x.width]));
    if (distinct.size < 2) throw new SkipGap(`width follows label content 采样未达 2 种文案（observed=${[...distinct.keys()].join("/")}）；右缘对齐已实证差 ${delta.toFixed(2)}px`);
    const widths = [...distinct.values()];
    const varied = new Set(widths.map((w) => Math.round(w))).size > 1;
    if (!varied) throw new Error(`文案集 {${[...distinct.keys()].join("/")}} 而宽度不变 ${widths.join("/")} —— 非内容自适应`);
    return { measured: `右缘差 ${delta.toFixed(2)}px；文案 {${[...distinct.entries()].map(([t, w]) => `${t}=${Math.round(w)}px`).join("，")}} 宽度随内容变化` };
  });
  await exec("A-048", "light", async () => ({ measured: await checkProps(`${ROOT} [data-role="save-status"]`, [
    { prop: "marginTop", want: "0px" }, { prop: "marginRight", want: "0px" }, { prop: "marginBottom", want: "0px" }, { prop: "marginLeft", want: "0px" },
    { prop: "fontSize", want: "12px" }, { prop: "lineHeight", want: "18px" },
  ]) }));
  await exec("A-049", "light", async () => ({ measured: await checkProps(`${ROOT} [data-role="save-status"][data-state="saved"]`, [
    { prop: "color", wantProbe: "--dsw-alias-state-success-primary", also: "rgb(34, 197, 94)" },
  ]) }));
  const saveEnd = (await calls()).length;
  await exec("B-004", "light", async () => {
    // 插桩记录在响应 settle 后异步入账：先轮询全局集合到位（两枚 set 与后续 mutate 都已记录），再做全局下标审计。
    let all = await calls();
    for (let i = 0; i < 15; i++) {
      const s = all.filter((x) => x.url === "/api/credentials/set").length;
      const m = all.slice(saveStart).filter((x) => x.url === "/api/settings/mutate").length;
      if (s >= 2 && m >= 1) break;
      await wait(1000); all = await calls();
    }
    const sets = all.map((x, i) => [x, i]).filter(([x]) => x.url === "/api/credentials/set");
    const mutAfter = all.map((x, i) => [x, i]).filter(([x, i]) => x.url === "/api/settings/mutate" && i >= saveStart);
    const tally = Object.entries(all.reduce((a, x) => { a[x.url] = (a[x.url] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`).join("，");
    if (sets.length !== 2) throw new Error(`credentials/set 全局次数 ${sets.length} ≠ 2（两 exa；bing 不得触发）｜诊断 ${tally}`);
    if (mutAfter.length < 1) throw new Error(`本轮 settings/mutate 未发生｜诊断 ${tally}`);
    const maxSet = Math.max(...sets.map(([, i]) => i));
    const minMut = Math.min(...mutAfter.map(([, i]) => i));
    if (!(maxSet < minMut)) throw new Error(`顺序违规：credentials/set 最大下标 ${maxSet} ≥ 本轮 mutate 最小下标 ${minMut}`);
    return { measured: `两枚 credentials/set（仅 exa，全局总数=2，bing 零凭据写入）均先于本轮 settings/mutate；setIdx=${sets.map(([, i]) => i)} mutIdx=${mutAfter.map(([, i]) => i)}` };
  });

  // 官方参照区截图（此时草稿已全部落库；分区切换 unmount 我方面板不再造成数据损失）
  await officialSectionShots();

  // 暗态（Luna 裁定：直设 body[data-ds-dark-theme]，真实暗色 CSS 状态实证；非宿主主题 UI 切换实证）
  await darkAttr(true);
  await styleSweep("dark");
  await dotsPhase("dark", true);
  await pickerPhase("dark", false);
  await openEditor(cardIds[0]);
  await editorPhase("dark", false);
  await a047("dark"); // Luna call-2：A-047 补 dark（编辑器内非法名真实错误态，暗色错误色）
  await closeEditor();
  await a046confirmPhase("dark"); // Luna call-2：A-046 补 dark（危险前景 + hover，采完即取消）
  await reducedMotionPhase("dark"); // Luna call-2：A-050 补 dark（规则 + 运行时分别判定）
  // 分区往返后保存态复位：官方开关一次 关→保存→开→保存，制造 [data-state=saved] 采样面（持久化终值 true 不变）。
  await evaluate(`(() => { document.querySelector('${OFFICIAL_TOGGLE}').click(); return true; })()`, 30000);
  await wait(300);
  const famDark = await captureDisabledFamilies("dark"); // Luna call-2：A-034/A-025 补 dark（保存 locked 三档窗口）
  await a034Phase("dark", famDark);
  await a025Phase("dark", famDark);
  { const s0 = (await calls()).length; await waitRpc("/api/settings/mutate", s0, 60).catch(() => {}); await settleSaved(); } // 确保 [data-state=saved] 采样面到达
  await exec("A-048", "dark", async () => ({ measured: await checkProps(`${ROOT} [data-role="save-status"]`, [
    { prop: "marginTop", want: "0px" }, { prop: "marginRight", want: "0px" }, { prop: "marginBottom", want: "0px" }, { prop: "marginLeft", want: "0px" },
    { prop: "fontSize", want: "12px" }, { prop: "lineHeight", want: "18px" },
  ]) }));
  await exec("A-049", "dark", async () => ({ measured: await checkProps(`${ROOT} [data-role="save-status"][data-state="saved"]`, [
    { prop: "color", wantProbe: "--dsw-alias-state-success-primary", also: "rgb(34, 197, 94)" },
  ]) }));
  await evaluate(`(() => { document.querySelector('${OFFICIAL_TOGGLE}').click(); return true; })()`, 30000);
  await wait(300);
  await saveAndSettle();
  await exec("A-054", "dark", async () => ({ measured: await checkProps(`${ROOT} [data-role="save"]`, [
    { prop: "backgroundColor", wantProbe: "--dsw-alias-button-primary-fill", also: "rgb(249, 250, 251)" },
    { prop: "color", wantProbe: "--dsw-alias-label-primary-foreground", also: "rgb(15, 17, 21)" },
  ]) }));
  await shot("our-panel-dark.png", ROOT);
  await exec("A-052", "dark", async () => {
    const opacity = await nativeDragAttempt(cardIds[0]);
    if (opacity === null) throw new SkipGap("native drag unreachable in Electron（A-053 dark 规则文本面已必做执行）");
    if (opacity !== "0.5") throw new Error(`data-dragging 透明度 got ${opacity} 期望 0.5`);
    return { measured: "拖动中 data-dragging 卡 opacity=0.5（暗态实机可达）" };
  });
  await exec("A-053", "dark", async () => ({ measured: await a053RuleScan() }));
  await darkAttr(false);

  await reducedMotionPhase("light");
  await focusPassPhase();

  // afterReload #1：顺序/启用/徽标 + key 不回显（B-007/B-008）
  await reloadAndReopen();
  await exec("B-007", "light", async () => {
    const s = await ui.state();
    if (s.absent) throw new Error("missing element: panel");
    cardIds = s.ids;
    if (s.ids.length !== 3) {
      const snap = await evaluate(`() => ((document.querySelector('${ROOT}')?.innerText || 'ROOT-ABSENT').replace(/\\s+/g, ' ').slice(0, 180))`, 30000);
      throw new Error(`reload 后条目数 ${s.ids.length} ≠ 3（empty可见=${s.emptyVisible}；面板文本快照：“${snap}”）`);
    }
    if (JSON.stringify(s.names) !== '["Oracle Alpha","Oracle Beta","Bing RSS"]') throw new Error(`名称/顺序 got ${JSON.stringify(s.names)} 期望创建顺序 [exa-1, exa-2, bing]`);
    if (!s.enabled.every((v) => v === true)) throw new Error(`启用态 got ${JSON.stringify(s.enabled)}`);
    if (s.dotStates[0] !== "ready" || s.dotStates[1] !== "ready") throw new Error(`两 exa 凭据徽标未 configured got ${JSON.stringify(s.dotStates)}`);
    if (s.dotStates[2] !== "ready") throw new Error(`bing 徽标未随 ready 态 got ${s.dotStates[2]}`);
    return { measured: `顺序 ${JSON.stringify(s.names)} 全 enabled；徽标 ${JSON.stringify(s.dotStates)}（exa configured ×2，bing ready）` };
  });
  await openEditor(cardIds[0]);
  await exec("B-008", "light", async () => {
    const info = await evaluate(`(() => { const i = document.querySelector('${ROOT} [data-role="field"][data-field="key"]'); if (!i) return null; return { value: i.value, type: i.type }; })()`, 30000);
    if (!info) throw new Error('missing element: [data-role=field][data-field=key]');
    if (info.value !== "") throw new Error("key 输入框回显了存储值（期望空）");
    const s = await ui.state();
    if (s.dotStates[0] !== "ready") throw new Error("凭据未以 configured 徽标呈现");
    return { measured: `key 输入 value 空（type=${info.type}）；凭据仅以 configured 徽标呈现` };
  });
  await closeEditor();

  // B-009 编辑其一，其余不受影响
  await openEditor(cardIds[0]);
  if ((await setField("name", "Oracle Edited")) !== "Oracle Edited") throw new Error("B-009 改名失败");
  await closeEditor();
  await saveAndSettle();
  await reloadAndReopen();
  await exec("B-009", "light", async () => {
    const s = await ui.state();
    if (JSON.stringify(s.names) !== '["Oracle Edited","Oracle Beta","Bing RSS"]') throw new Error(`got ${JSON.stringify(s.names)} 期望 exa-1=Oracle Edited 且 exa-2/bing 保留原名`);
    if (!s.enabled.every((v) => v === true)) throw new Error(`其余启用态 got ${JSON.stringify(s.enabled)}`);
    if (JSON.stringify(s.dotStates) !== '["ready","ready","ready"]') throw new Error(`其余徽标 got ${JSON.stringify(s.dotStates)}`);
    return { measured: `exa-1 改名生效；exa-2/bing 名称/enabled/徽标不变 ${JSON.stringify(s.names)}` };
  });

  // B-010 关闭第二条 → 保存 → reload：原位 enabled=false 徽标关闭态
  await evaluate(`(() => { const el = document.querySelector('${T.toggle(cardIds[1])}'); el.click(); return true; })()`, 30000);
  await wait(350);
  await saveAndSettle();
  await reloadAndReopen();
  await exec("B-010", "light", async () => {
    const s = await ui.state();
    const idx = s.ids.indexOf(cardIds[1]);
    if (idx !== 1) throw new Error(`第二条索引漂移 got ${idx} 期望 1（关-开保位置）`);
    if (s.enabled[idx] !== false) throw new Error(`关闭未持久化 enabled=${s.enabled[idx]}`);
    if (s.dotStates[idx] === "ready") throw new Error("关-开保位置的语义：关闭态徽标应脱离 configured（不得仍显示已配置成功色而掩盖停用）");
    return { measured: `第二条 index=1 保持；enabled=false；徽标 ${s.dotStates[idx]}` };
  });
  // B-011 再开启 → 原位置恢复
  await evaluate(`(() => { const el = document.querySelector('${T.toggle(cardIds[1])}'); el.click(); return true; })()`, 30000);
  await wait(350);
  await saveAndSettle();
  await reloadAndReopen();
  await exec("B-011", "light", async () => {
    const s = await ui.state();
    const idx = s.ids.indexOf(cardIds[1]);
    if (idx !== 1 || s.enabled[idx] !== true) throw new Error(`重开态 index=${idx} enabled=${s.enabled[idx]} 期望 1/true`);
    if (s.dotStates[idx] !== "ready") throw new Error(`徽标未恢复 configured got ${s.dotStates[idx]}`);
    return { measured: "第二条原位置 index=1 enabled=true 徽标恢复 configured" };
  });

  // B-015 官方开关：关→保存→reload 持久 false；再开→保存→reload 持久 true
  await evaluate(`(() => { document.querySelector('${OFFICIAL_TOGGLE}').click(); return true; })()`, 30000);
  await wait(350);
  await saveAndSettle();
  await reloadAndReopen();
  const offState = await ui.state();
  await evaluate(`(() => { document.querySelector('${OFFICIAL_TOGGLE}').click(); return true; })()`, 30000);
  await wait(350);
  await saveAndSettle();
  await reloadAndReopen();
  await exec("B-015", "light", async () => {
    const on = await ui.state();
    if (offState.officialChecked !== false || offState.officialAria !== "false") throw new Error(`关闭保存后读回 ${offState.officialChecked}/${offState.officialAria} 期望 false/false`);
    if (on.officialChecked !== true || on.officialAria !== "true") throw new Error(`重开保存后读回 ${on.officialChecked}/${on.officialAria} 期望 true/true`);
    return { measured: "关→false/false 持久；开→true/true 持久（checked+aria-checked 与保存前最后选择一致）" };
  });

  // B-012 键盘排序：bing 上移两位 → 保存 → reload 读回
  if (!(await focusSel(`${T.card(cardIds[2])} [data-role="drag-handle"]`))) throw new Error("drag-handle 聚焦失败");
  await pressKey("ArrowUp", "ArrowUp", 38); await wait(250);
  await pressKey("ArrowUp", "ArrowUp", 38); await wait(250);
  const want12 = [...cardIds.slice(2), ...cardIds.slice(0, 2)];
  let preOrder = await ui.state();
  for (let i = 0; i < 8 && JSON.stringify(preOrder.ids) !== JSON.stringify(want12); i++) { await wait(500); preOrder = await ui.state(); } // 等 React 落定
  if (JSON.stringify(preOrder.ids) === JSON.stringify(want12)) {
    await saveAndSettle();
    await reloadAndReopen();
    const s = await ui.state();
    await exec("B-012", "light", async () => {
      if (JSON.stringify(s.ids) !== JSON.stringify(want12)) throw new Error(`reload 后顺序 ${JSON.stringify(s.ids)} ≠ 键盘移动后应有顺序 ${JSON.stringify(want12)}`);
      return { measured: `键盘 ArrowUp×2 后顺序 ${JSON.stringify(s.names)} 保存读回一致` };
    });
  } else {
    await exec("B-012", "light", async () => {
      throw new Error(`键盘排序未生效：聚焦 handle 后 ArrowUp×2，保存前顺序 ${JSON.stringify(preOrder.ids)} 未达 ${JSON.stringify(want12)}（SET-003 键盘路径必做）`);
    });
  }

  // dragAttempt：原生 HTML5 拖拽尝试（A-052 运行时 + B-013；不可达→SKIP 记 gap，不得伪装）
  await exec("A-052", "light", async () => {
    const opacity = await nativeDragAttempt(cardIds[0]);
    if (opacity === null) throw new SkipGap("native drag unreachable in Electron（规则文本面由 A-053 必测覆盖）");
    if (opacity !== "0.5") throw new Error(`data-dragging 透明度 got ${opacity} 期望 0.5`);
    return { measured: "拖动中 data-dragging 卡 opacity=0.5（原生拖拽实机可达）" };
  });
  await exec("A-053", "light", async () => ({ measured: await a053RuleScan() }));
  await exec("B-013", "light", async () => {
    const before = await ui.state();
    const opacity = await nativeDragAttempt(before.ids[0]);
    if (opacity === null) throw new SkipGap("native drag unreachable in Electron（键盘排序 B-012 已必测覆盖）");
    const after = await ui.state();
    if (JSON.stringify(after.ids) !== JSON.stringify(before.ids)) {
      await saveAndSettle();
      await reloadAndReopen();
      const fin = await ui.state();
      return { measured: `原生拖拽可达且顺序变化：观察序 ${JSON.stringify(fin.ids)} 保存读回一致` };
    }
    // Luna call-2：拖拽路径可达（data-dragging 实证）却未产生期望重排 → 行为断言 FAIL，不得判 PASS；仅不可达才 SKIP。
    throw new Error(`原生拖拽可达（data-dragging 实证）但释放后顺序未变：${JSON.stringify(after.names)}——SET-003 拖拽重排行为未达成（可达即判，不得 PASS）`);
  });

  // 全程审计：B-003 / B-005 / B-006
  const all = await calls();
  const flags = await evaluate(`() => window.__oracle50 || {}`, 30000);
  const storageLeak = await evaluate(`(() => { const s = sessionStorage.getItem('__oracle50Calls') || ''; return window.__oracle50Keys.filter((k) => s.includes(k)).length; })()`, 30000);
  await exec("B-003", "light", async () => {
    const setRecs = all.filter((x) => x.url === "/api/credentials/set");
    if (setRecs.length !== 2) throw new Error(`脱敏自证依据缺失：捕获的 credentials/set 记录 ${setRecs.length} 条 ≠ 2（空真值不得判 PASS）`);
    if (!flags.onlySynthetic) throw new Error("检测到非合成值写入 credentials/set");
    if ((flags.responseEchos || 0) > 0 || (flags.envEchoes || 0) > 0 || storageLeak > 0) throw new Error(`回显自证失败 responseEchos=${flags.responseEchos || 0} envEchoes=${flags.envEchoes || 0} storage=${storageLeak}`);
    const rawTable = results.map((r) => `${r.id}|${r.measured}|${r.expected}`).join("\n");
    if (rawTable.includes(KEY_A) || rawTable.includes(KEY_B)) throw new Error("断言表/rpc 报告出现合成 key 明文");
    return { measured: "两枚 exa key 恒为合成 sk-TEST-oracle-*；宿主回包/插桩存储/断言表/raw 证据零明文（打印面全脱敏）" };
  });
  await exec("B-005", "light", async () => {
    const rpc = all.filter((x) => /^\/api\/(settings|credentials)\//.test(x.url));
    const bad = rpc.filter((x) => !appOk(x));
    if (!rpc.length) throw new Error("未捕获任何 describe/mutate/credentials 记录");
    if (bad.length) throw new Error(`${bad.length}/${rpc.length} 条 RPC 非应用级 ok（含 ${bad.slice(0, 2).map((x) => `${x.url}@${x.status ?? x.error ?? "reject"}`).join("，")}）`);
    return { measured: `${rpc.length} 条 describe/mutate/credentials/set 全应用级 ok=true（双信封兼容）` };
  });
  await exec("B-006", "light", async () => {
    // Luna call-2 裁定：不设白名单——目录语义「0 条非 /api/」按总计判定；宿主壳自身流量若出现即如实 FAIL，诊断信息标注来源。
    const nonApi = all.filter((x) => !String(x.url).startsWith("/api/"));
    if (nonApi.length) {
      const tally = Object.entries(nonApi.reduce((a, x) => { a[x.url] = (a[x.url] || 0) + 1; return a; }, {})).map(([k, v]) => `${k}×${v}`).join("，");
      const shellOnly = nonApi.every((x) => x.url === "/open-in-app/apps");
      throw new Error(`非 /api/ 请求 ${nonApi.length} 条：${tally}${shellOnly ? "（全部来自宿主壳自身 in-app 注册表路由，与插件无关——目录裁定不设豁免，按语义 FAIL 并如实标注来源）" : ""}`);
    }
    return { measured: `全程插桩 ${all.length} 条 fetch/XHR，非 /api/ 计 0 条（零供应商请求）` };
  });

  // 报告
  const fails = results.filter((r) => r.result === "FAIL");
  const skips = results.filter((r) => r.result === "SKIP");
  const ids = new Set(results.map((r) => r.id));
  console.log("\n[oracle-style-50] ═══ 逐条断言表（id→spec→theme→result｜期望｜实测）═══");
  for (const r of results) {
    console.log(`${r.id.padEnd(8)} ${String(r.spec).padEnd(9)} ${r.theme.padEnd(5)} ${r.result.padEnd(4)} 期望: ${r.expected} ｜ 实测: ${r.measured}${r.extra ? ` ｜ ${r.extra}` : ""}`);
  }
  console.log("\n[oracle-style-50] 统计：", JSON.stringify({
    lunaA: CATALOG.assertions.A.length, lunaB: CATALOG.assertions.B.length,
    executedAUnique: new Set(results.filter((r) => /^A-\d+$/.test(r.id)).map((r) => r.id)).size,
    executedB: new Set(results.map((r) => r.id).filter((id) => /^B-/.test(id))).size,
    rows: results.length, PASS: results.filter((r) => r.result === "PASS").length, FAIL: fails.length, SKIP: skips.length,
  }));
  if (gaps.length) console.log("[oracle-style-50] SKIP gaps:\n" + gaps.map((g) => "  - " + g).join("\n"));
  console.log("[oracle-style-50] 截图：", shots.join(", ") || "(none)", `｜目录=${ART_DIR}`);
  console.log("[oracle-style-50] Chromium：", String(chrome).slice(0, 140));
  console.log("[oracle-style-50] 官方区取证：", JSON.stringify(officialShotState));
  console.log("[oracle-style-50] 合成凭据全程脱敏；未观察到供应商请求；key 明文未出现于输出。");
  if (fails.length) finish(1, "FAIL", `${fails.length} 条断言 FAIL（校准语义：HEAD 样式未纠偏面失败属预期判别结果；详见上表）。`);
  finish(0, "PASS", `零 FAIL；${skips.length} 条 SKIP 已如实登记为验证缺口。`);
} catch (error) {
  // 非环境类异常：仍打印已采集断言表（校准不得黑盒短路）。
  console.log("\n[oracle-style-50] ═══ 中断前已采集断言表 ═══");
  for (const r of results) console.log(`${r.id.padEnd(8)} ${String(r.spec).padEnd(9)} ${r.theme.padEnd(5)} ${r.result.padEnd(4)} 期望: ${r.expected} ｜ 实测: ${r.measured}${r.extra ? ` ｜ ${r.extra}` : ""}`);
  console.log(`[oracle-style-50] 已采集 ${results.length} 行；截图：${shots.join(", ") || "(none)"}`);
  finish(1, "FAIL", `Oracle 运行异常（非环境类）：${redact(String((error && error.stack) || error)).slice(0, 700)}`);
}
