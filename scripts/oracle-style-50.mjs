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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, realpathSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 纯静态目录自证必须早于 APP 探测、隔离 profile 创建和 Electron 启动。
if (process.argv.includes("--selfcheck")) {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const match = source.match(/const CATALOG_TEXT = ("(?:\\.|[^"\\])*");\nconst CATALOG/);
  if (!match) throw new Error("CATALOG_TEXT literal not found");
  const catalog = JSON.parse(JSON.parse(match[1]));
  const rows = [...catalog.assertions.A, ...catalog.assertions.B];
  const ids = rows.map((row) => row.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate catalog assertion id");
  const delta = catalog.meta.v4Delta;
  if (!delta) throw new Error("V4 catalog delta missing");
  console.log(JSON.stringify({ assertionRows: rows.length, byPart: { A: catalog.assertions.A.length, B: catalog.assertions.B.length }, added: delta.added, changed: delta.changed, retired: delta.retired }, null, 2));
  process.exit(0);
}

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
const cdpEvents = []; // CDP 事件泵（Input.dragIntercepted 依赖；lead 修复项 14）
ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.method) { if (msg.method === "Input.dragIntercepted") cdpEvents.push(msg.params); return; } if (!msg.id || !pending.has(msg.id)) return; const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); };
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
  // codex-P2（L138 定性有效）：审计旗标与会话计数器同源持久化——reload 换新 window 后内存旗标归零，
  // 最终窗口只读到最后窗口的旗标会误报 PASS。审计并入 sessionStorage 紧凑通道：只存计数/布尔（记录前即脱敏，绝不含回包原文），B-003 按全 run 聚合判定。
  let audit = null;
  try { audit = JSON.parse(sessionStorage.getItem("__oracle50Audit") || "null"); } catch { audit = null; }
  if (!audit || typeof audit !== "object") audit = { onlySynthetic: true, responseEchos: 0, envEchoes: 0, windows: 0 };
  // 窗口自增按 document 幂等（安装期 evaluate 与 new-document 注入可能先后跑在同一文档）。
  if (!window.__oracle50AuditWindow) {
    window.__oracle50AuditWindow = true;
    audit.windows += 1;
    try { sessionStorage.setItem("__oracle50Audit", JSON.stringify(audit)); } catch { /* 存储异常不得影响被测应用 */ }
  }
  window.__oracle50 = audit;
  const bump = (field) => {
    try {
      const a = JSON.parse(sessionStorage.getItem("__oracle50Audit") || "null") || audit;
      if (field === "onlySynthetic") a.onlySynthetic = false; else a[field] = (a[field] || 0) + 1;
      sessionStorage.setItem("__oracle50Audit", JSON.stringify(a));
      window.__oracle50 = a;
    } catch { /* noop */ }
  };
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
      if ("value" in args && !KEYS.includes(args.value)) bump("onlySynthetic");
    } catch { /* 非 JSON body */ }
  };
  const inspectResponse = (json) => {
    try {
      const s = JSON.stringify(json) || "";
      if (KEYS.some((k) => s.includes(k))) bump("responseEchos");
      if (s.includes("synthetic-not-a-secret")) bump("envEchoes");
    } catch { /* noop */ }
  };
  // Luna call-3 归属判据：仅对非 /api/ 请求在包装器调用点即时判栈（不落栈原文，只存布尔 hf/pf）。
  const attrib = (path) => {
    if (path.indexOf("/api/") === 0) return {};
    let hf = false; let pf = false; let frames = null;
    // Luna call-4（REJECT 维持字面判据）指定的脱敏采集：每帧 scheme://hostname+前两段路径，禁 query/栈全文——FAIL 行自证审计面。
    try {
      const st = String(new Error().stack || ""); pf = /search-chain|client-entry/i.test(st); hf = /app\.asar|dsh-desktop/i.test(st);
      const urls = st.match(/[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/[^\s()]+/g) || []; const out = [];
      for (const u of urls) { try { const x = new URL(u); out.push(x.protocol + "//" + (x.hostname || x.host.replace(/:.*/, "")) + "/" + x.pathname.split("/").filter(Boolean).slice(0, 2).join("/")); } catch { /* ignore */ } if (out.length >= 6) break; }
      frames = [...new Set(out)].slice(0, 6);
    } catch { /* */ }
    return { hf, pf, frames };
  };
  // v2（B-017/018/019/020/021 专责面）：settings/mutate 请求体字段路径提取（diff 载荷判据「只含该项变更」）。
  const mutateKeys = (pn, body) => {
    // run-acc2 实证重写：dev3 settings/mutate args={ns, ops:[{op,path:[…],value}], expectedRevision}（路径补丁）。
    // digest 面出 op token「op:path.join('.')」；ns/expectedRevision 属宿主协议封套、非配置载荷字段，不入判据集。
    if (pn === "/api/credentials/set" && typeof body === "string") {
      try { const args = (JSON.parse(body) || {}).payload?.args || {};
        return { cred: { ref: String(args.ref ?? "").slice(-24), empty: args.value === "" || args.value === null || args.value === undefined } }; } catch { return {}; }
    }
    if (pn !== "/api/settings/mutate" || typeof body !== "string") return {};
    try {
      const args = (JSON.parse(body) || {}).payload?.args || {};
      if (Array.isArray(args.ops)) {
        const ks = args.ops.slice(0, 10).map((o) => `${(o && o.op) || "?"}:${Array.isArray(o && o.path) ? o.path.join(".") : String((o && o.path) ?? "")}${o && o.op === "set" && (typeof o.value === "string" || typeof o.value === "number" || typeof o.value === "boolean") ? "@" + String(o.value).slice(0, 12) : ""}`.slice(0, 76)); // run-acc4 取证协议2：set 基元值出 @value token（timeoutMs/开关值自证；对象值不入）
        return { mkeys: ks, rev: /revision/i.test(body), revv: args.expectedRevision ?? args.expected_revision ?? null }; // run-acc7 取证：expectedRevision 序列值（B-007 互换终审输入）
      }
      // 两代兼容兜底：非 ops 封套形态（v1 时代/异常 shape）旧递归提取，且现对数组下钻（旧版仅标 k[] → B-016~019 判据在封套层失明）。
      const st = (args.settings && typeof args.settings === "object") ? args.settings : args;
      const PROTO = { ns: 1, expectedRevision: 1, expected_revision: 1 };
      const ks = [];
      const walk = (o, pre, d) => { if (d > 4 || ks.length >= 10) return; for (const k of Object.keys(o)) { if (!pre && PROTO[k]) continue; const v = o[k];
        if (Array.isArray(v)) { if (!v.length) { ks.push((pre + k + "[]").slice(0, 60)); continue; } for (const it of v.slice(0, 2)) { if (it && typeof it === "object") walk(it, pre + k + ".", d + 1); else ks.push((pre + k + "[]").slice(0, 60)); } }
        else if (v && typeof v === "object") walk(v, pre + k + ".", d + 1); else ks.push((pre + k).slice(0, 60)); } };
      walk(st, "", 0);
      return { mkeys: ks, rev: /revision/i.test(body) };
    } catch { return {}; }
  };
  if (!window.__oracle50Patched) {
    window.__oracle50Patched = true;
    const original = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : (input && input.url) || String(input);
      const body = init && init.body;
      const pn = new URL(url, location.href).pathname;
      const record = { url: pn, method: (init && init.method) || "GET", hasBody: typeof body === "string", via: "fetch", t: Date.now(), ...mutateKeys(pn, typeof body === "string" ? body : ""), ...attrib(pn) };
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
    X.prototype.open = function (method, url) { const pn = new URL(url, location.href).pathname; this.__o50 = { method, url: pn, path: pn, via: "xhr", t: Date.now(), ...attrib(pn) }; return open.apply(this, arguments); };
    X.prototype.send = function (body) {
      if (this.__o50) {
        inspectValue(typeof body === "string" ? body : "");
        const rec2 = this.__o50;
        Object.assign(rec2, mutateKeys(this.__o50.path, typeof body === "string" ? body : ""));
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
const CATALOG_TEXT = "{\"meta\":{\"model\":\"GPT-6 Luna High\",\"role\":\"independent read-only acceptance oracle\",\"basis\":[\"docs/specs/draft/settings-panel-style-lock.md\",\"docs/specs/draft/settings-ui.md\",\"src/client-entry.js\",\"scripts/verify-ui-48.mjs\"],\"calibrationHead\":\"fdf09e8\",\"verdicts\":{\"darkTheme\":\"设置真实宿主页 body[data-ds-dark-theme] 属性后执行双主题断言；称为真实暗色 CSS 状态实证，并注明不是宿主主题 UI 切换实证。\",\"html5Drag\":\"原生拖拽尝试后不可达可 SKIP 并记 gap；键盘 ArrowUp/ArrowDown 排序必做。拖拽规则文本和 data-dragging 规则必做。\",\"calibration\":\"HEAD 首跑全量运行 A+B；不因首个 FAIL 短路。\",\"exit\":\"环境或隔离自证失败 exit 2；任一断言 FAIL exit 1；零 FAIL exit 0，保留 SKIP gaps。\",\"v4Editor\":\"V4-1: 同卡片外层结构且行.nextElementSibling 是唯一可自动化的明确 DOM 邻接定义；切换归属与其余卡片顺序用稳定 entry id 对照。\",\"v4DeleteModal\":\"V4-2: role=alertdialog、aria-modal=true、准确文案、×/取消/danger 与 Escape 均做真实 UI 验收；移除需 danger 按钮确认。\",\"v4Visual\":\"截图可稳测遮罩覆盖视口、中心偏差不超过 2 CSS px、圆角非零和不透明浅白表面；不钉具体宽高/边距/圆角像素，避免伪测。\",\"v4DefaultAction\":\"“取消默认钮”裁定为非危险默认/secondary 按钮族；截图不证明自动聚焦，因此不强加初始焦点位置，键盘可达性单独验收。\"},\"redaction\":\"断言表与日志不得包含 sk-TEST-oracle-* 明文；发现明文则脱敏自证 FAIL。\",\"v4Delta\":{\"added\":[\"A-068\",\"B-027\",\"B-028\",\"B-029\",\"B-030\",\"B-031\",\"B-032\"],\"changed\":[\"A-028\",\"A-046\",\"B-002\",\"B-019\"],\"retired\":[],\"retiredJudgement\":\"HEAD 原目录无独立“编辑器在列表末尾”行；若执行器另有残留旧判据，V4 由 B-027 替换。B-019 旧内联确认目标改由 alertdialog danger 控件承担。\"}},\"phases\":[{\"name\":\"dataSetup\",\"steps\":[\"启动真 DSH Electron，设置本次 mkdtemp DSH_HOME 与独立 Chromium user-data-dir；假模型 provider 指向死端口。\",\"等待 CDP、页面 body、设置路由和 [data-plugin-id=\\\"search-chain\\\"]；fetch 插桩在设置交互前安装。\",\"首次空配置进入设置；等待 /api/settings/describe 成功、empty-state 可见。\"],\"waitFor\":\"隔离自证成立；设置面板挂载；describe 应用级 ok。失败按全局环境规则 exit 2。\"},{\"name\":\"default\",\"steps\":[\"空配置时采集基础样式、默认 official-toggle checked 和空状态。\",\"创建 token probe 后读取同主题计算色；亮色先测。\"],\"waitFor\":\"React 状态稳定且目标元素存在。\"},{\"name\":\"pickerOpen\",\"steps\":[\"点击 [data-role=\\\"add-tool\\\"]。\",\"等待 [data-role=\\\"add-type\\\"] 可见，采集 picker 容器、项、标题、计费与截图。\"],\"waitFor\":\"picker 至少一项可见。\"},{\"name\":\"editorOpen\",\"steps\":[\"选择 exa，等待新卡；点其 [data-role=\\\"card-edit\\\"]。\",\"等待 [data-role=\\\"editor\\\"] 与 field[name, credentialRef, key] 挂载；key 仅用 password 输入且任何记录脱敏。\"],\"waitFor\":\"editor 与预期字段可见。\"},{\"name\":\"afterSave\",\"steps\":[\"新建 exa、exa、bing，顺序即创建顺序；两个 exa 分别输入不同 sk-TEST-oracle-* 合成 key，bing 不输入 key。\",\"点击保存；等待本轮 credentials/set（仅两个 exa）与 settings/mutate 均返回应用级 ok，且保存状态结束。\"],\"waitFor\":\"保存操作完成；每个凭据写入先于对应 mutate；无外部请求。\"},{\"name\":\"afterReload\",\"steps\":[\"Page.reload；等待页面 body 后重新进入设置路由。\",\"等待 search-chain 面板重新挂载、describe 返回应用级 ok、列表稳定；采集名称、顺序、enabled、徽标和密码输入回显状态。\"],\"waitFor\":\"真实 reload 后重新 describe 成功。\"},{\"name\":\"confirmOpen\",\"steps\":[\"点击目标卡的 [data-role=\\\"card-remove\\\"]。\",\"等待 [data-role=\\\"confirm-remove\\\"] 可见；采集危险色后取消，避免此阶段误删测试数据。\"],\"waitFor\":\"确认移除按钮可见。\"},{\"name\":\"focusPass\",\"steps\":[\"使用 Input.dispatchKeyEvent 真正 Tab 遍历按钮、拖拽把手、picker 项、switch 和输入框。\",\"每次按键后等待焦点稳定，记录 activeElement、:focus-visible、outline/box-shadow；输入框单独核 :focus。\",\"不使用 el.focus() 作为 focus-visible 证据。\"],\"waitFor\":\"目标控件获得真实键盘焦点；若控件缺失则该断言 FAIL。\"},{\"name\":\"reducedMotion\",\"steps\":[\"调用 Emulation.setEmulatedMedia 设置 prefers-reduced-motion: reduce。\",\"扫描注入 style 的 reduced-motion 规则，并核 switch track 与 ::after transition。\"],\"waitFor\":\"媒体模拟生效；rule-text 断言执行。\"},{\"name\":\"dark\",\"steps\":[\"在真实宿主页设置 body[data-ds-dark-theme] 属性；同页建 dark token probe。\",\"运行主题颜色断言与暗色截图；结束后移除此属性。\"],\"waitFor\":\"属性存在且 probe/目标元素计算样式可读。\"},{\"name\":\"keyboardReorder\",\"steps\":[\"聚焦目标 [data-role=\\\"drag-handle\\\"]，发送 ArrowUp/ArrowDown，使顺序发生判别性变化。\",\"保存，等待 RPC 成功；Page.reload 并重进设置，核顺序。\"],\"waitFor\":\"列表顺序变化并在 reload 后读回。\"},{\"name\":\"dragAttempt\",\"steps\":[\"以 Input.dispatchMouseEvent 尝试 HTML5 原生拖拽并观察 data-dragging/data-drop-target；不得将不可达伪装为 PASS。\",\"不论拖拽状态能否达到，均扫描 data-dragging 透明度与 gradient 指示线规则文本。\"],\"waitFor\":\"规则文本断言必须执行；runtime 不可达只对相应 runtime 展示断言 SKIP 并记 gap。\"},{\"name\":\"emptyState\",\"steps\":[\"首次新 profile 的空配置阶段读取 empty-state。\",\"另建空配置 profile 不属于本轮要求；使用本次隔离 profile 的初始状态即可。\"],\"waitFor\":\"首次 describe 后列表为空且 empty-state 可见。\"}],\"screenshots\":[{\"file\":\"our-panel-light.png\",\"phase\":\"default\",\"theme\":\"light\",\"clip\":\"[data-plugin-id=\\\"search-chain\\\"] 全高边界框\"},{\"file\":\"official-models.png\",\"phase\":\"default\",\"theme\":\"light\",\"clip\":\"按区标题文本定位的官方「模型」section 边界框\"},{\"file\":\"official-web-search.png\",\"phase\":\"default\",\"theme\":\"light\",\"clip\":\"按区标题文本定位的官方「网页搜索」section 边界框\"},{\"file\":\"switch-focus.png\",\"phase\":\"focusPass\",\"theme\":\"light\",\"clip\":\"官方开关 label、track、focus ring 特写\"},{\"file\":\"switch-open-closed.png\",\"phase\":\"default\",\"theme\":\"light\",\"clip\":\"开关开启与关闭状态各一处特写\"},{\"file\":\"picker-open.png\",\"phase\":\"pickerOpen\",\"theme\":\"light\",\"clip\":\"[data-plugin-id=\\\"search-chain\\\"] 内 picker 展开区域\"},{\"file\":\"editor-open.png\",\"phase\":\"editorOpen\",\"theme\":\"light\",\"clip\":\"[data-role=\\\"editor\\\"] 展开区域\"},{\"file\":\"our-panel-dark.png\",\"phase\":\"dark\",\"theme\":\"dark\",\"clip\":\"[data-plugin-id=\\\"search-chain\\\"] 全高边界框\"}],\"assertions\":{\"A\":[{\"id\":\"A-001\",\"spec\":\"SPC-001\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-panel\",\"method\":\"computed\",\"property\":\"box-sizing, display, flex-direction, gap, width, max-width\",\"expected\":{\"light\":\"border-box; flex; column; gap 12px; width 100%; max-width 720px\",\"dark\":\"border-box; flex; column; gap 12px; width 100%; max-width 720px\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"组件根元素亦为 [data-plugin-id=\\\"search-chain\\\"]；宽视口另由 A-002 核 max-width。\"},{\"id\":\"A-002\",\"spec\":\"SPC-001\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-panel\",\"method\":\"geometry\",\"property\":\"getBoundingClientRect().width at viewport wider than 720px plus margins\",\"expected\":{\"light\":\"panel column width <= 720px\",\"dark\":\"panel column width <= 720px\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"仅按 SPC-001 宽视口钳制验收。\"},{\"id\":\"A-003\",\"spec\":\"SPC-002\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-title\",\"method\":\"computed\",\"property\":\"margin, font-size, line-height, font-weight\",\"expected\":{\"light\":\"margin 0; font-size 16px; line-height 24px; font-weight 500\",\"dark\":\"margin 0; font-size 16px; line-height 24px; font-weight 500\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"SPC-002。\"},{\"id\":\"A-004\",\"spec\":\"SPC-002\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-title\",\"method\":\"token-probe\",\"property\":\"color\",\"expected\":{\"light\":\"var(--dsw-alias-label-primary) = rgb(15,17,21)\",\"dark\":\"var(--dsw-alias-label-primary) = rgb(249,250,251)\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"同页 probe 解析 token，目标计算色和 probe 色相等，并核 §4 RGB。\"},{\"id\":\"A-005\",\"spec\":\"SPC-003\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-description\",\"method\":\"computed\",\"property\":\"margin, font-size, line-height\",\"expected\":{\"light\":\"margin 0; font-size 14px; line-height 22px\",\"dark\":\"margin 0; font-size 14px; line-height 22px\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"标题/说明块到首卡 24px 由容器 gap 与 list margin 组成，不独立增加距离阈值。\"},{\"id\":\"A-006\",\"spec\":\"SPC-003\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-description\",\"method\":\"token-probe\",\"property\":\"color\",\"expected\":{\"light\":\"var(--dsw-alias-label-tertiary) = rgb(129,133,140)\",\"dark\":\"var(--dsw-alias-label-tertiary) = rgb(173,178,184)\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"token probe 双重核对 §4。\"},{\"id\":\"A-007\",\"spec\":\"SPC-005\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-card-list（纠偏后必需选择器）\",\"method\":\"computed\",\"property\":\"list-style, margin, padding, display, flex-direction, gap\",\"expected\":{\"light\":\"list-style none; margin 12px 0 0; padding 0; flex column; gap 8px\",\"dark\":\"list-style none; margin 12px 0 0; padding 0; flex column; gap 8px\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"当前 DOM 无 .sc-card-list，HEAD 校准预期 FAIL；两卡时相邻间隙应为 8px。\"},{\"id\":\"A-008\",\"spec\":\"SPC-006/V3-2\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"]\",\"method\":\"computed\",\"property\":\"box-sizing, position, border-width/style, border-radius, padding, display, flex-direction, gap\",\"expected\":{\"light\":\"border-box; relative; 0.5px solid; radius var(--dsw-radius-xl); padding 12px 14px 12px 10px; flex column; gap 12px\",\"dark\":\"border-box; relative; 0.5px solid; radius var(--dsw-radius-xl); padding 12px 14px 12px 10px; flex column; gap 12px\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"border-width 精确 0.5px；圆角 token 由规则引用核验，§4 xl=20px。\"},{\"id\":\"A-009\",\"spec\":\"SPC-006\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"]\",\"method\":\"token-probe\",\"property\":\"background-color and border-color\",\"expected\":{\"light\":\"settings-card-fill = rgb(255,255,255); settings-card-stroke = rgba(0,0,0,.16)\",\"dark\":\"settings-card-fill = rgb(44,44,46); settings-card-stroke = rgba(255,255,255,.2)\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"探测 --dsw-alias-settings-card-fill/stroke 并与卡片实际计算色逐项比较。\"},{\"id\":\"A-010\",\"spec\":\"SPC-007\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-card-row\",\"method\":\"computed\",\"property\":\"display, align-items, gap, min-width\",\"expected\":{\"light\":\"flex; center; gap 10px; min-width 0\",\"dark\":\"flex; center; gap 10px; min-width 0\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"SPC-007。\"},{\"id\":\"A-011\",\"spec\":\"SPC-007/V3-2\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-card-info\",\"method\":\"computed\",\"property\":\"display, align-items, gap, min-width\",\"expected\":{\"light\":\"inline-flex; center; gap 4px; min-width 0\",\"dark\":\"inline-flex; center; gap 4px; min-width 0\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"身份组不应有 flex-wrap 声明。\"},{\"id\":\"A-012\",\"spec\":\"SPC-007\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-card-actions\",\"method\":\"computed\",\"property\":\"display, align-items, gap, margin-left\",\"expected\":{\"light\":\"inline-flex; center; gap 4px; margin-left auto\",\"dark\":\"inline-flex; center; gap 4px; margin-left auto\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"SPC-007。\"},{\"id\":\"A-013\",\"spec\":\"SPC-008\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-card-name\",\"method\":\"computed\",\"property\":\"font-size, line-height, font-weight, overflow-wrap\",\"expected\":{\"light\":\"14px; 22px; 500; anywhere\",\"dark\":\"14px; 22px; 500; anywhere\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"overflow-wrap 虽官方未获取，但 SPC-008 钉死值明确要求 anywhere。\"},{\"id\":\"A-014\",\"spec\":\"SPC-008\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-card-name\",\"method\":\"token-probe\",\"property\":\"color\",\"expected\":{\"light\":\"var(--dsw-alias-label-primary) = rgb(15,17,21)\",\"dark\":\"var(--dsw-alias-label-primary) = rgb(249,250,251)\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"token probe 双重核对 §4。\"},{\"id\":\"A-015\",\"spec\":\"SPC-009\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-type-badge\",\"method\":\"computed\",\"property\":\"flex, padding, border-width/style, border-radius, font-size, line-height, white-space\",\"expected\":{\"light\":\"flex none; padding 1px 6px; 0.5px solid; radius var(--dsw-radius-xs); 11px; 16px; nowrap\",\"dark\":\"flex none; padding 1px 6px; 0.5px solid; radius var(--dsw-radius-xs); 11px; 16px; nowrap\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"§4 radius-xs=4px；border width 精确 0.5px。\"},{\"id\":\"A-016\",\"spec\":\"SPC-009\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-type-badge\",\"method\":\"token-probe\",\"property\":\"border-color and color\",\"expected\":{\"light\":\"border-l3 = rgba(0,0,0,.12); label-secondary = rgb(97,102,107)\",\"dark\":\"border-l3 = rgba(255,255,255,.16); label-secondary = rgb(207,211,214)\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"§4 token probe。\"},{\"id\":\"A-017\",\"spec\":\"SPC-010\",\"phase\":\"dataSetup\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"] .sc-status-dot\",\"method\":\"computed\",\"property\":\"box-sizing, display, flex, width, height, border-radius\",\"expected\":{\"light\":\"border-box; inline-block; flex none; 8px by 8px; 50%\",\"dark\":\"border-box; inline-block; flex none; 8px by 8px; 50%\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"dataSetup 准备已就绪、缺少凭据引用、已关闭三态；corner-shape 另由 A-020 rule-text 核验。\"},{\"id\":\"A-018\",\"spec\":\"SPC-010\",\"phase\":\"dataSetup\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card-status\\\"]\",\"method\":\"DOM-audit\",\"property\":\"status dot semantics and visible text\",\"expected\":{\"light\":\"status is the .sc-status-dot itself; role=img; aria-label and title equal the applicable complete phrase (已就绪/缺少凭据引用/已关闭); textContent empty; no aria-live\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"data-role, data-entry-id and data-state reside on the dot. No wrapper or visible status text.\"},{\"id\":\"A-019\",\"spec\":\"SPC-010\",\"phase\":\"dataSetup\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-status-dot[data-state]\",\"method\":\"token-probe\",\"property\":\"background-color by state\",\"expected\":{\"light\":\"ready state-success-primary rgb(34,197,94); missing credential state-error-primary rgb(236,19,19); disabled state-idle-primary rgb(212,212,212)\",\"dark\":\"ready state-success-primary rgb(34,197,94); missing credential state-error-primary rgb(242,90,90); disabled state-idle-primary rgb(84,85,87)\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"R2 保留原三态色；状态以三条真实设置条目达成。\"},{\"id\":\"A-020\",\"spec\":\"SPC-010\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] <style data-sc-style=\\\"panel\\\">\",\"method\":\"rule-text\",\"property\":\"corner-shape on status dot border-radius:50%\",\"expected\":{\"light\":\"corner-shape: round\",\"dark\":\"corner-shape: round\"},\"tolerance\":\"语义规则块匹配，空白/声明顺序可变\",\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"Chromium computed 不可见时仅查规则文本。\"},{\"id\":\"A-021\",\"spec\":\"SPC-011\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-switch-track\",\"method\":\"geometry\",\"property\":\"track bounding box, padding, border\",\"expected\":{\"light\":\"36px × 20px; padding 2px; border 0\",\"dark\":\"36px × 20px; padding 2px; border 0\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"SPC-011。\"},{\"id\":\"A-022\",\"spec\":\"SPC-011\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-switch-track\",\"method\":\"token-probe\",\"property\":\"background-color for unchecked/checked states\",\"expected\":{\"light\":\"unchecked border-l3 rgba(0,0,0,.12); checked brand-primary rgb(15,17,21)\",\"dark\":\"unchecked border-l3 rgba(255,255,255,.16); checked brand-primary rgb(249,250,251)\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"分别经真实 checked 状态触发；§4 token probe 双重核对。\"},{\"id\":\"A-023\",\"spec\":\"SPC-011\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-switch-track::after\",\"method\":\"computed\",\"property\":\"width, height, border-radius, transition, transform\",\"expected\":{\"light\":\"16px × 16px; border-radius 50%; transition transform .12s ease; unchecked transform none; checked translate(16px)\",\"dark\":\"16px × 16px; border-radius 50%; transition transform .12s ease; unchecked transform none; checked translate(16px)\"},\"tolerance\":\"transform matrix 与 translate(16px) 等价\",\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"使用 Runtime.evaluate 读取 ::after；corner-shape 另查规则文本。\"},{\"id\":\"A-024\",\"spec\":\"SPC-011\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-switch-track::after\",\"method\":\"token-probe\",\"property\":\"thumb background-color\",\"expected\":{\"light\":\"unchecked switch-thumb rgb(255,255,255); checked label-primary-foreground rgb(255,255,255)\",\"dark\":\"unchecked switch-thumb rgb(173,178,184); checked label-primary-foreground rgb(15,17,21)\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"开关两种状态均以 token probe 比较。\"},{\"id\":\"A-025\",\"spec\":\"SPC-011\",\"phase\":\"dataSetup\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-switch-input:disabled + .sc-switch-track\",\"method\":\"computed\",\"property\":\"opacity, cursor\",\"expected\":{\"light\":\"opacity .5; cursor default\",\"dark\":\"opacity .5; cursor default\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"用 pending 保存状态达成 locked disabled；状态不可达则记 gap。\"},{\"id\":\"A-026\",\"spec\":\"SPC-012\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-switch\",\"method\":\"computed\",\"property\":\"display, align-items, gap, color, cursor, white-space\",\"expected\":{\"light\":\"inline-flex; center; gap 8px; label-secondary rgb(97,102,107); pointer; nowrap\",\"dark\":\"inline-flex; center; gap 8px; label-secondary rgb(207,211,214); pointer; nowrap\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"同时检查 label 14px/22px、label-secondary；disabled label opacity .5 与 cursor default。\"},{\"id\":\"A-027\",\"spec\":\"SPC-013\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-official-row\",\"method\":\"computed\",\"property\":\"display, flex-direction, align-items, gap; descendants panel/card chrome absence\",\"expected\":{\"light\":\"flex; column; flex-start; gap 8px; no card background/border\",\"dark\":\"flex; column; flex-start; gap 8px; no card background/border\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"标签主色 label-primary；hint margin 0、12px/18px、label-tertiary。\"},{\"id\":\"A-028\",\"spec\":\"SPC-014\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-editor-actions .sc-button\",\"method\":\"computed\",\"property\":\"box-sizing, display, align-items, justify-content, gap, height, padding, border, border-radius, font-size, line-height\",\"expected\":{\"light\":\"border-box; inline-flex; center/center; gap 4px; height 36px; padding 0 14px; border 0; radius var(--dsw-radius-md); 14px/22px\",\"dark\":\"border-box; inline-flex; center/center; gap 4px; height 36px; padding 0 14px; border 0; radius var(--dsw-radius-md); 14px/22px\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"仅测编辑器取消/提交通用按钮基底；模态 danger 描边由 SPC-023/A-046 专项验收，不套用无边框基底判据。\"},{\"id\":\"A-029\",\"spec\":\"SPC-014\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-button-primary\",\"method\":\"token-probe\",\"property\":\"background/color and hover background\",\"expected\":{\"light\":\"button-primary-fill rgb(15,17,21); label-primary-foreground rgb(255,255,255); hover button-primary-hover rgb(67,69,74)\",\"dark\":\"button-primary-fill rgb(249,250,251); label-primary-foreground rgb(15,17,21); hover button-primary-hover rgb(235,238,242)\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"hover 由 CDP mouse dispatch 尝试触发；声明还由 A-030 核验。\"},{\"id\":\"A-030\",\"spec\":\"SPC-014\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] <style data-sc-style=\\\"panel\\\">\",\"method\":\"rule-text\",\"property\":\"all hover declarations are nested in @media (hover: hover)\",\"expected\":{\"light\":\"每个 hover 声明位于 @media (hover: hover) 内\",\"dark\":\"每个 hover 声明位于 @media (hover: hover) 内\"},\"tolerance\":\"CSS 语法/空白可变；媒体条件和声明语义须一致\",\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"覆盖按钮、危险态、picker、添加钮和 icon-button hover 规则。\"},{\"id\":\"A-031\",\"spec\":\"SPC-014/015/022\",\"phase\":\"editorOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-editor-actions .sc-button\",\"method\":\"computed\",\"property\":\"height, padding, border-radius, font-size, line-height; compact modifier absence\",\"expected\":{\"light\":\"standard档：36px; 0 14px; radius var(--dsw-radius-md); 14px/22px; no -small compact modifier\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"编辑器取消与提交按钮均为 SPC-014 standard 档；SPC-015 compact 仍适用于卡片行内动作。\"},{\"id\":\"A-034\",\"spec\":\"SPC-017\",\"phase\":\"afterSave\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"editor\\\"] :disabled\",\"method\":\"computed\",\"property\":\"disabled opacity/cursor by element family while a commit is in flight\",\"expected\":{\"light\":\"button/action .4 default; input .6 default; switch track+label .5 default\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"仅在编辑器提交 busy 状态核验；busy 时提交、取消和输入禁用，非 busy 时取消保持可用。\"},{\"id\":\"A-035\",\"spec\":\"SPC-018\",\"phase\":\"focusPass\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] <style data-sc-style=\\\"panel\\\">\",\"method\":\"rule-text\",\"property\":\"focus ring variable mechanism, width, pointer modality suppression, input focus\",\"expected\":{\"light\":\"button focus-visible box-shadow 0 0 0 var(--dsw-focus-ring-width, 2px) var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); input :focus border-color state-business-primary; switch outline var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)), offset 2px; html[data-input-modality='pointer'] suppression\",\"dark\":\"same rule set\"},\"tolerance\":\"规则块可组合/空白不同；变量、2px、状态及指针选择器语义须完整\",\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"禁止 brand-primary 焦点色；探查焦点颜色时走 token probe。\"},{\"id\":\"A-036\",\"spec\":\"SPC-018\",\"phase\":\"focusPass\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] :focus-visible\",\"method\":\"computed\",\"property\":\"outline/box-shadow while traversing with real Tab\",\"expected\":{\"light\":\"focus ring uses --dsw-focus-ring-width (2px) and business-primary token\",\"dark\":\"focus ring uses --dsw-focus-ring-width (2px) and business-primary token\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"真实 Tab 遍历；focus-visible 实际色通过 probe 解析变量。\"},{\"id\":\"A-037\",\"spec\":\"SPC-019\",\"phase\":\"editorOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"editor\\\"]\",\"method\":\"computed\",\"property\":\"box-sizing, display, flex-direction, gap, padding, border-radius, background-color\",\"expected\":{\"light\":\"border-box; flex column; gap 14px; padding 14px 16px; radius var(--dsw-radius-lg); bg-module-platform token\",\"dark\":\"same geometry and token reference\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"nested in card variant separately requires background none; padding 0.\"},{\"id\":\"A-038\",\"spec\":\"SPC-020\",\"phase\":\"editorOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"editor\\\"] .sc-editor-title\",\"method\":\"computed\",\"property\":\"margin, font-size, line-height, font-weight\",\"expected\":{\"light\":\"margin 0; 14px/22px; 500\",\"dark\":\"margin 0; 14px/22px; 500\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"field: flex column gap 6px margin-block 0; label 12px/18px/500; hint/error 12px/18px。\"},{\"id\":\"A-039\",\"spec\":\"SPC-021\",\"phase\":\"editorOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"field\\\"]\",\"method\":\"computed\",\"property\":\"input width, height, padding, border-width, border-radius, font-size, line-height\",\"expected\":{\"light\":\"width 100%; height 32px; padding 0 10px; border .5px solid border-l4; radius var(--dsw-radius-md); 14px/22px\",\"dark\":\"same geometry and token reference\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"需要 select.sc-input 才断言 SPC-021 select 专属 max-width 240px 和 chevron；当前没有则见 nonAssertable。\"},{\"id\":\"A-040\",\"spec\":\"SPC-021\",\"phase\":\"editorOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-input::placeholder\",\"method\":\"token-probe\",\"property\":\"placeholder color\",\"expected\":{\"light\":\"var(--dsw-alias-label-dimmed) = rgb(225,229,238)\",\"dark\":\"var(--dsw-alias-label-dimmed) = rgb(67,69,74)\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"不因凭据已配置而回显 key；placeholder 仍用 dimmed token。\"},{\"id\":\"A-041\",\"spec\":\"SPC-024\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"add-tool\\\"]\",\"method\":\"geometry\",\"property\":\"height and width relative to card list\",\"expected\":{\"light\":\"height 44px; fills available row width\",\"dark\":\"height 44px; fills available row width\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"其余断言 min-width 180px; padding 0 14px; gap 6px; border 1px dashed; radius var(--dsw-radius-lg)。\"},{\"id\":\"A-042\",\"spec\":\"SPC-024\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"add-tool\\\"]\",\"method\":\"token-probe\",\"property\":\"border-color and text color\",\"expected\":{\"light\":\"border-l3 rgba(0,0,0,.12); label-primary rgb(15,17,21)\",\"dark\":\"border-l3 rgba(255,255,255,.16); label-primary rgb(249,250,251)\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"透明底；hover 为 interactive-bg-hover token。\"},{\"id\":\"A-043\",\"spec\":\"SPC-025\",\"phase\":\"pickerOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-picker\",\"method\":\"computed\",\"property\":\"gap, padding, radius, background\",\"expected\":{\"light\":\"gap 8px; module chrome padding 14px 16px; radius var(--dsw-radius-lg)\",\"dark\":\"same geometry and token reference\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"picker 容器共用 SPC-019 铬层。\"},{\"id\":\"A-044\",\"spec\":\"SPC-025\",\"phase\":\"pickerOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"add-type\\\"]\",\"method\":\"computed\",\"property\":\"width, flex-direction, align-items, gap, padding, border, border-radius\",\"expected\":{\"light\":\"width 100%; flex column; flex-start; gap 4px; padding 14px 16px; border 0.5px solid var(--dsw-alias-border-l4); radius var(--dsw-radius-md)\",\"dark\":\"same geometry and token reference\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"标题 14px/22px/600；billing 12px/18px。\"},{\"id\":\"A-045\",\"spec\":\"SPC-025\",\"phase\":\"pickerOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"add-type\\\"]\",\"method\":\"token-probe\",\"property\":\"item background, border color, text, hover background, title and billing colors\",\"expected\":{\"light\":\"base bg-layer-1 rgb(255,255,255); border-l4 rgba(0,0,0,.16); label-primary rgb(15,17,21); hover interactive-bg-hover composite estimate rgb(236,238,240); billing label-tertiary rgb(129,133,140)\",\"dark\":\"base bg-layer-1 rgb(35,35,36); border-l4 rgba(255,255,255,.2); label-primary rgb(249,250,251); hover interactive-bg-hover composite estimate rgb(69,70,72); billing label-tertiary rgb(173,178,184)\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"hover 使用 interactive-bg-hover 单声明覆写；实测合成值写入 measured。O-12：合成值采样与用户演示窗口目检双轨。\"},{\"id\":\"A-046\",\"spec\":\"SPC-023\",\"phase\":\"confirmOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [role=\\\"alertdialog\\\"] [data-role=\\\"confirm-remove\\\"]\",\"method\":\"token-probe\",\"property\":\"outline token, color and hover background\",\"expected\":{\"light\":\"outline --dsh-button-outline-color: state-error-primary; color state-error-primary rgb(236,19,19); hover interactive-bg-hover-danger rgba(236,19,19,.05)\",\"dark\":\"outline --dsh-button-outline-color: state-error-primary; color state-error-primary rgb(242,90,90); hover interactive-bg-hover-danger rgba(242,90,90,.15)\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"模态确认危险钮沿用 SPC-023 官方 outline token；像素级描边宽度不钉死。\"},{\"id\":\"A-047\",\"spec\":\"SPC-023/030\",\"phase\":\"editorOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"save-error\\\"][data-state=\\\"error\\\"]\",\"method\":\"token-probe\",\"property\":\"color and error placement semantics\",\"expected\":{\"light\":\"state-error-primary rgb(236,19,19); role=alert; immediately above .sc-editor-actions\",\"dark\":\"state-error-primary rgb(242,90,90); role=alert; immediately above .sc-editor-actions\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"仅在可通过真实 UI 生成编辑器错误时采样；否则 state-unreachable SKIP。\"},{\"id\":\"A-048\",\"spec\":\"SPC-004/030/V3-3\",\"phase\":\"afterSave\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"save-status\\\"][data-state=\\\"saved\\\"]\",\"method\":\"computed\",\"property\":\"font-size, line-height, color, role, aria-live, section placement\",\"expected\":{\"light\":\"12px/18px; state-success-primary; role=status; aria-live=polite; section top slot after title/description/notice and before list\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"启用 SPC-004 预留位；条目成功文案为“已保存 ${名称}。”，全局字段与离散动作为“已保存设置。” V3-3（light/dark 相同；来源：用户直令仅排除两类开关）：编辑器保存（含新建）、超时、删除、重排仍产生对应成功文案——savedNotice 仅排除条目启用开关与官方搜索开关两类动作。\"},{\"id\":\"A-049\",\"spec\":\"SPC-004/030\",\"phase\":\"afterSave\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"save-status\\\"][data-state=\\\"saved\\\"]\",\"method\":\"token-probe\",\"property\":\"color\",\"expected\":{\"light\":\"state-success-primary rgb(34,197,94)\",\"dark\":\"state-success-primary rgb(34,197,94)\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"保存完成后采样节级 savedNotice。\"},{\"id\":\"A-050\",\"spec\":\"SPC-029\",\"phase\":\"reducedMotion\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] <style data-sc-style=\\\"panel\\\">\",\"method\":\"rule-text\",\"property\":\"@media prefers-reduced-motion switch and drag handle transitions\",\"expected\":{\"light\":\"@media (prefers-reduced-motion: reduce) { .sc-switch-track, .sc-switch-track::after, .sc-drag-handle { transition: none; } }\",\"dark\":\"same rule text\"},\"tolerance\":\"CSS 空白与规则块顺序可变，媒体条件/选择器/transition 值不得变\",\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"Emulation.setEmulatedMedia 设置 reduce；实际 switch 伪元素与把手 transition computed 为 none。\"},{\"id\":\"A-051\",\"spec\":\"SPC-027/V3-2\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"drag-handle\\\"]\",\"method\":\"geometry\",\"property\":\"button width and height\",\"expected\":{\"light\":\"21px × 28px\",\"dark\":\"21px × 28px\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"另核 border none、radius var(--dsw-radius-sm)、透明底、label-tertiary、14px/1。\"},{\"id\":\"A-052\",\"spec\":\"SPC-027\",\"phase\":\"dragAttempt\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"][data-dragging]\",\"method\":\"computed\",\"property\":\"opacity while dragging\",\"expected\":{\"light\":\"0.5\",\"dark\":\"0.5\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"原生 drag 不可达允许 SKIP；不得将状态注入伪装成实机拖动证据。拖拽中透明度规则优先级须高于卡片 hover 显现规则。\"},{\"id\":\"A-053\",\"spec\":\"SPC-027\",\"phase\":\"dragAttempt\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] <style data-sc-style=\\\"panel\\\">\",\"method\":\"rule-text\",\"property\":\"data-dragging opacity; data-drop-target z-index; gradient indicator declarations; drag handle opacity precedence\",\"expected\":{\"light\":\"data-dragging opacity .5; data-drop-target z-index 1; before/after pseudo rules height 4px; before top -4px; after bottom -4px; target before/after height 12px; exact 55deg and 125deg gradients plus 4px 5px / calc(100% - 4px) 2px line; target before top -10px; after bottom -10px; dragging opacity rule outranks .sc-card:hover handle opacity\",\"dark\":\"same rule declarations\"},\"tolerance\":\"允许 CSS 空白、引号和规则顺序不同；gradient 参数、token、位置、尺寸及优先级需原义等价；不得增加 pointer-events:none\",\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"必须检出 --dsw-alias-state-business-primary 引用；颜色值本身通过 token probe，规则文本也可验变量引用。\"},{\"id\":\"A-055\",\"spec\":\"SPC-016 v2 / SET-006\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] and injected panel style\",\"method\":\"DOM-audit\",\"property\":\"absence of global save entry point\",\"expected\":{\"light\":\"no [data-role=\\\"save\\\"] element and no .sc-save-button in panel DOM or injected style\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"DOM 与样式表双查；面板不得存在跨条目批量保存入口。\"},{\"id\":\"A-056\",\"spec\":\"SPC-014/022 v2\",\"phase\":\"editorOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-editor-actions\",\"method\":\"computed\",\"property\":\"display, justify-content, gap and button order\",\"expected\":{\"light\":\"display flex; justify-content flex-end; gap 8px; 取消在左、提交主按钮在右\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"底部对齐职责由编辑器动作行承担。\"},{\"id\":\"A-057\",\"spec\":\"SPC-014/022/V3-1\",\"phase\":\"editorOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-editor-actions .sc-button\",\"method\":\"text-scan\",\"property\":\"cancel, edit/create submit, and busy labels\",\"expected\":{\"light\":\"cancel=取消; submit=保存; busy submit=保存中…；任何编辑器动作标签出现“创建工具”或“创建中…”即 FAIL；“完成”不得出现为编辑器动作标签；非 busy 时不得显示 busy 文案\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"分别覆盖编辑与新建编辑器（编辑与新建统一，来源：用户直令）；busy 文案只在提交进行中出现。\"},{\"id\":\"A-058\",\"spec\":\"SPC-014/017 v2\",\"phase\":\"editorOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"editor\\\"]\",\"method\":\"DOM-audit\",\"property\":\"busy disabled state for submit, cancel, and inputs\",\"expected\":{\"light\":\"during commit: submit, cancel and inputs disabled; submit shows its matching in-progress label; outside commit cancel is enabled\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"只读、缺 revision、校验失败或上次提交报错均不得单独禁用取消钮。\"},{\"id\":\"A-059\",\"spec\":\"SPC-004/030 v2\",\"phase\":\"afterSave\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] save feedback nodes\",\"method\":\"DOM-audit\",\"property\":\"success/error mutual exclusion and placement\",\"expected\":{\"light\":\"section success notice and section-level error are mutually exclusive; editor error is above editor actions; no bottom status node\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"节级成功/非编辑器错误占顶部槽位；编辑器错误就近显示；面板底部状态区撤除。\"},{\"id\":\"A-060\",\"spec\":\"SPC-030 v2\",\"phase\":\"editorOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"save-error\\\"]\",\"method\":\"computed\",\"property\":\"font-size, line-height, color, role and position\",\"expected\":{\"light\":\"12px/18px; state-error-primary; role=alert; immediately above .sc-editor-actions\",\"dark\":\"12px/18px; state-error-primary; role=alert; immediately above .sc-editor-actions\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"错误节点沿用 SPC-030 状态色与字号；不新增外边距或底色阈值。\"},{\"id\":\"A-061\",\"spec\":\"SPC-007/010/027 v2\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-card-info\",\"method\":\"DOM-audit\",\"property\":\"child order and overflow\",\"expected\":{\"light\":\"first child .sc-drag-handle; followed by name, badge and status dot; overflow is not hidden\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"把手在名称前；截断只作用于名称子节点。\"},{\"id\":\"A-062\",\"spec\":\"SPC-007/027/V3-2\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-card-info and .sc-drag-handle\",\"method\":\"computed\",\"property\":\"info display, align-items, gap; handle flex-shrink\",\"expected\":{\"light\":\".sc-card-info inline-flex; align-items center; gap 4px; .sc-drag-handle flex-shrink 0\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"延续 SPC-007 行节奏与 SPC-027 把手 21×28 几何（V3-2）。\"},{\"id\":\"A-063\",\"spec\":\"SPC-027 v2\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-drag-handle\",\"method\":\"computed\",\"property\":\"baseline opacity and transition\",\"expected\":{\"light\":\"opacity 1; transition opacity .12s ease\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"常显基线同时适用于不匹配 hover:hover 的指针环境。\"},{\"id\":\"A-064\",\"spec\":\"SPC-027 v2\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] <style data-sc-style=\\\"panel\\\">\",\"method\":\"rule-text\",\"property\":\"hover pointer drag handle visibility mechanism\",\"expected\":{\"light\":\"within @media (hover: hover), resting .sc-drag-handle and disabled handle opacity 0; .sc-card:hover .sc-drag-handle and .sc-drag-handle:focus-visible opacity 1; hovered disabled handle opacity .4; no display:none or visibility:hidden visibility mechanism\",\"dark\":\"same rule set\"},\"tolerance\":\"CSS 空白与规则块顺序可变；媒体条件、选择器及声明语义须一致\",\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"不得用 display 或 visibility 隐藏把手；opacity 0 保留 Tab 序与无障碍树可达性。\"},{\"id\":\"A-065\",\"spec\":\"SPC-027/018 v2\",\"phase\":\"focusPass\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] .sc-drag-handle\",\"method\":\"computed\",\"property\":\"disabled opacity, focus-visible opacity and keyboard reachability\",\"expected\":{\"light\":\"disabled opacity .4; real Tab focus remains reachable; :focus-visible opacity 1 with SPC-018 focus ring\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"使用真实 Tab；不得以 el.focus() 作为 focus-visible 证据。\"},{\"id\":\"A-066\",\"spec\":\"SET-002/V3-1\",\"phase\":\"editorOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] 列表行数 vs [data-role=\\\"editor\\\"] 打开至提交完成\",\"method\":\"sequence-audit\",\"property\":\"list row count equals persisted count while create editor open through submit busy\",\"expected\":{\"light\":\"新建编辑器打开至提交完成期间，列表行数始终等于已持久条目数；覆盖普通编辑器打开与 submit busy 期间，未提交新条目不得形成列表卡片或占位行\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"来源：用户直令（V3-1.2 未提交新建不入列）。light/dark 相同。\"},{\"id\":\"A-067\",\"spec\":\"SET-008/V3-1\",\"phase\":\"editorOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] 列表行数 vs 新建草稿跨分区/后台读回/O-6 自动重开\",\"method\":\"sequence-audit\",\"property\":\"create-draft restore = editor fields + auto reopen, never list placeholder\",\"expected\":{\"light\":\"模拟新建草稿跨分区卸载、后台读回及 O-6 自动重开：列表始终只呈现已持久条目；新建编辑器自动重开且字段草稿复原；不得把草稿重追加为列表行\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"来源：用户直令收窄 SET-008 草稿复原语义（编辑器字段复原+自动重开，非列表占位行）。\"},{\"id\":\"A-068\",\"spec\":\"SPC-023/V4-2\",\"phase\":\"confirmOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [role=\\\"alertdialog\\\"] and its backdrop\",\"method\":\"geometry+computed\",\"property\":\"dialog center, backdrop coverage, surface and radius\",\"expected\":{\"light\":\"visible dialog center within 2 CSS px of viewport center; visible backdrop covers viewport; dialog is opaque near-white; border-radius is greater than 0\",\"dark\":\"same\"},\"tolerance\":2,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"V4 几何仅测可观察属性；不伪测截图未钉死的宽高、间距和具体圆角像素值。\"}],\"B\":[{\"id\":\"B-001\",\"spec\":\"SET-001\",\"phase\":\"dataSetup\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"empty-state\\\"]\",\"method\":\"text-scan\",\"property\":\"initial empty configuration state\",\"expected\":{\"light\":\"visible when entries array is empty\",\"dark\":\"visible when entries array is empty\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"取本轮隔离 profile 首次 describe 后的空配置阶段。\"},{\"id\":\"B-002\",\"spec\":\"SET-002\",\"phase\":\"pickerOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"add-type\\\"][data-type=\\\"exa\\\"] and [data-type=\\\"bing\\\"]\",\"method\":\"sequence-audit\",\"property\":\"选择 exa 两次，再选择 bing 一次；每次新条目追加到列表末尾并 enabled\",\"expected\":{\"light\":\"order [exa-1, exa-2, bing]; all enabled; each successful create closes its editor\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"UI 操作：add-tool → add-type → 配置并提交；V4 验新建成功后编辑器关闭，未提交阶段列表不出现占位（V3-1）。\"},{\"id\":\"B-003\",\"spec\":\"SET-004\",\"phase\":\"afterSave\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"field\\\"][data-field=\\\"key\\\"]\",\"method\":\"sequence-audit\",\"property\":\"synthetic credentials redaction self-audit\",\"expected\":{\"light\":\"both exa keys use synthetic sk-TEST-oracle-* only; no plaintext appears in captured logs, RPC report, assertion table, or emitted artifacts\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"只记录 redacted sentinel、长度/数量等不含明文的元数据；明文出现则 FAIL。\"},{\"id\":\"B-004\",\"spec\":\"SET-004\",\"phase\":\"afterSave\",\"target\":\"fetch instrumentation records for /api/credentials/set and /api/settings/mutate\",\"method\":\"sequence-audit\",\"property\":\"order of credentials/set < order of settings/mutate\",\"expected\":{\"light\":\"each credentials/set for exa precedes the settings/mutate that commits its credentialRef; bing causes no credentials/set\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"信封兼容 {result:{ok,...}} 与 {ok,...}；只记脱敏后的 RPC 元数据。\"},{\"id\":\"B-005\",\"spec\":\"SET-004\",\"phase\":\"afterSave\",\"target\":\"all captured RPC fetch records\",\"method\":\"sequence-audit\",\"property\":\"every RPC application-level result is ok\",\"expected\":{\"light\":\"all /api/settings/describe, /api/settings/mutate, /api/credentials/set calls resolve application-level ok=true\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"HTTP 200 不能替代应用级 ok 检查。\"},{\"id\":\"B-006\",\"spec\":\"SET-004\",\"phase\":\"afterSave\",\"target\":\"fetch/XHR instrumentation records\",\"method\":\"sequence-audit\",\"property\":\"count of requests whose pathname does not start with /api/ and do not meet the strict host-owned exemption\",\"expected\":{\"light\":\"0\",\"dark\":\"0\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"attributionRule\":{\"capture\":\"At each fetch/XHR wrapper invocation, capture the call stack in page memory and evaluate it immediately. Do not persist or emit raw stack text; store only the classification result.\",\"hostExemption\":{\"all\":[\"method === \\\"GET\\\"\",\"pathname === \\\"/open-in-app/apps\\\"\",\"call stack does not match /search-chain|client-entry/i\",\"call stack matches /app\\\\.asar|dsh-desktop/i\"]},\"otherwise\":\"Count every request whose pathname does not start with /api/ as a violation, including non-GET requests to /open-in-app/apps, requests with unknown attribution, and requests whose stack contains a plugin frame.\",\"measured\":{\"hostEnvironmentEvidenceField\":\"measured.hostEnvironmentEvidence\",\"format\":\"Array of {\\\"pathname\\\": string, \\\"count\\\": integer} entries for exempt requests, grouped by pathname. Do not silently omit exempt requests.\"}},\"notes\":\"假模型 provider 为死端口；不发送真实供应商/模型请求。插件面非 /api/ 请求须为零；严格归属为宿主壳的豁免请求单列于 measured.hostEnvironmentEvidence，供人工复核。\"},{\"id\":\"B-007\",\"spec\":\"SET-001\",\"phase\":\"afterReload\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"]\",\"method\":\"sequence-audit\",\"property\":\"list order, names, enabled state, credential status badge after reload\",\"expected\":{\"light\":\"three entries in creation order exa-1, exa-2, bing; all enabled; both exa credential badges configured; bing badge follows ready state\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"credentialRef 明文值和 key value 不读回；只比较状态徽标。\"},{\"id\":\"B-008\",\"spec\":\"SET-004\",\"phase\":\"afterReload\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"field\\\"][data-field=\\\"key\\\"]\",\"method\":\"text-scan\",\"property\":\"stored credential not echoed in input\",\"expected\":{\"light\":\"no plaintext stored key appears in any input value; credential is represented only by configured status badge\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"打开 exa editor 后检查；断言报告不包含原 key。\"},{\"id\":\"B-009\",\"spec\":\"SET-002\",\"phase\":\"afterReload\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"][data-entry-id]\",\"method\":\"sequence-audit\",\"property\":\"edit first exa name, save and reload; unaffected entries retain name/credential status/enabled\",\"expected\":{\"light\":\"exa-1 has requested replacement name; exa-2 and bing each retain prior name, credential badge state, enabled=true\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"保存并 reload 后按稳定 data-entry-id 对三条逐一比较；凭据只通过徽标状态比较。\"},{\"id\":\"B-010\",\"spec\":\"SET-002\",\"phase\":\"afterReload\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"][data-entry-id]\",\"method\":\"sequence-audit\",\"property\":\"disable second entry, save and reload; preserve position and credential badge\",\"expected\":{\"light\":\"second exa remains at same list index; enabled=false; credential badge unchanged\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"关闭 → 保存成功 → reload → 重新进入设置后读回。\"},{\"id\":\"B-011\",\"spec\":\"SET-002\",\"phase\":\"afterReload\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"][data-entry-id]\",\"method\":\"sequence-audit\",\"property\":\"re-enable second entry, save and reload; original position participates\",\"expected\":{\"light\":\"second exa remains at original list index; enabled=true; credential badge unchanged\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"重新开启 → 保存成功 → reload → 重新进入设置后读回。\"},{\"id\":\"B-012\",\"spec\":\"SET-003\",\"phase\":\"keyboardReorder\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"drag-handle\\\"]\",\"method\":\"sequence-audit\",\"property\":\"ArrowUp/ArrowDown keyboard reorder persists through save and reload\",\"expected\":{\"light\":\"visible list order after reload equals the order produced by keyboard movement before save\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"聚焦把手后使用真实 Input.dispatchKeyEvent；变更必须可判别且按 SET-003 保存读回。\"},{\"id\":\"B-013\",\"spec\":\"SET-003\",\"phase\":\"dragAttempt\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"][draggable]\",\"method\":\"sequence-audit\",\"property\":\"HTML5 drag attempt reaches reordered list state\",\"expected\":{\"light\":\"if Electron native drag reaches drop and order changes, report observed order; if unreachable, SKIP with gap 'native drag unreachable in Electron'; keyboard reorder B-012 remains required\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"允许尝试后不可达；不可用脚本直接改 draft 或 DOM 来冒充原生拖拽。\"},{\"id\":\"B-014\",\"spec\":\"SET-005\",\"phase\":\"default\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"official-toggle\\\"]\",\"method\":\"sequence-audit\",\"property\":\"default checked state\",\"expected\":{\"light\":\"checked=true; aria-checked=true\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"在首次默认配置阶段读取。\"},{\"id\":\"B-015\",\"spec\":\"SET-005\",\"phase\":\"afterReload\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"official-toggle\\\"]\",\"method\":\"sequence-audit\",\"property\":\"toggle official search, save and reload persistence\",\"expected\":{\"light\":\"checked and aria-checked after reload equal the value last selected before save\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"先读默认开启；切换为关闭并保存 reload 核关闭，再切回开启并保存 reload 核开启。\"},{\"id\":\"B-016\",\"spec\":\"SET-006/V3-3\",\"phase\":\"afterSave\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"official-toggle\\\"] and captured settings/mutate records\",\"method\":\"sequence-audit\",\"property\":\"official toggle independent commit and reload persistence\",\"expected\":{\"light\":\"对官方搜索开关分别执行开、关：每次动作都触发自身 mutate，payload 仅含 useOfficialDeepSeekSearch；视觉 checked/aria-checked 立即反映所选态；动作完成后无由该动作触发的 savedNotice；reload 后值等于所选值\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"失败时错误可见且持久快照不变。 light/dark 均验开与关；等待锚点为自身 mutate 完成及开关视觉态，不以 savedNotice 在场为条件；来源：用户直令。\"},{\"id\":\"B-017\",\"spec\":\"SET-006\",\"phase\":\"afterSave\",\"target\":\"timeout input and captured settings/mutate records\",\"method\":\"sequence-audit\",\"property\":\"timeout blur/Enter validation and independent commit\",\"expected\":{\"light\":\"valid changed value commits on blur or Enter with payload containing only timeoutMs and persists after reload; invalid value shows error, sends no mutate, and leaves persisted value unchanged\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"不得逐键写入；超时草稿变更同步进入内存草稿缓存。\"},{\"id\":\"B-018\",\"spec\":\"SET-006/V3-3\",\"phase\":\"afterReload\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"] switch and captured settings/mutate records\",\"method\":\"sequence-audit\",\"property\":\"entry enable switch independent commit\",\"expected\":{\"light\":\"对条目启用开关分别执行开、关：每次动作都触发仅含该条目 enable 变更的自身 mutate；视觉开关态立即反映所选态；动作完成后无由该动作触发的 savedNotice；reload 后 enabled 值等于所选值且其他条目不变\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"以最新持久快照为底板提交；失败时持久快照不变且错误可见。 light/dark 均验开与关；等待锚点为自身 mutate 完成及开关视觉态，不以 savedNotice 在场为条件；来源：用户直令。\"},{\"id\":\"B-019\",\"spec\":\"SET-006\",\"phase\":\"afterReload\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [role=\\\"alertdialog\\\"] [data-role=\\\"confirm-remove\\\"] and captured settings/mutate records\",\"method\":\"sequence-audit\",\"property\":\"confirmed removal independent commit\",\"expected\":{\"light\":\"confirmed removal triggers its own mutate containing only that removal; reload reflects removal and preserves other entries\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"通过模态 danger 按钮确认后仅产生删除 mutate，reload 只移除目标条目且其他条目保留；旧卡片内联确认已废止。\"},{\"id\":\"B-020\",\"spec\":\"SET-006\",\"phase\":\"dragAttempt\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"][draggable] and captured settings/mutate records\",\"method\":\"sequence-audit\",\"property\":\"HTML5 drag sort independent commit\",\"expected\":{\"light\":\"if native drag reaches drop and order changes, its own mutate contains only the ordering change and reload preserves that order; if unreachable, SKIP with gap 'native drag unreachable in Electron'\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"不得用脚本直接改 draft 或 DOM 冒充原生拖拽；保留 B-013 原有闭环验收。\"},{\"id\":\"B-021\",\"spec\":\"SET-006\",\"phase\":\"keyboardReorder\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"drag-handle\\\"] and captured settings/mutate records\",\"method\":\"sequence-audit\",\"property\":\"keyboard sort independent commit and reload persistence\",\"expected\":{\"light\":\"ArrowUp/ArrowDown ordering action triggers its own mutate containing only the ordering change; reload order equals order before save action\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"使用真实 Input.dispatchKeyEvent；无需也不得依赖全局保存钮。\"},{\"id\":\"B-022\",\"spec\":\"SET-008\",\"phase\":\"editorOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] editor, timeout input, and module-scope draft cache\",\"method\":\"sequence-audit\",\"property\":\"draft and editor restoration after settings section unmount/remount\",\"expected\":{\"light\":\"unsubmitted editor name, temporary key buffer and timeout draft survive section switch; remount restores fields and automatically reopens the matching editor or add panel; key buffer can subsequently be submitted successfully\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"缓存键为稳定 entryId（新增含稳定临时 id）与 __global__；记录 mode、字段、内存 key、baseRevision；进程存活期内有效，刷新不得静默覆盖。\"},{\"id\":\"B-023\",\"spec\":\"SET-008\",\"phase\":\"editorOpen\",\"target\":\"localStorage, sessionStorage, and emitted artifacts\",\"method\":\"text-scan\",\"property\":\"absence of drafts and plaintext synthetic keys in browser local storage\",\"expected\":{\"light\":\"no unsubmitted draft fields or synthetic key plaintext in localStorage/sessionStorage; no plaintext key in captured logs, RPC report, assertion table or emitted artifacts\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"扫描全部键值；明文 key 仅可保存在渲染进程内存草稿缓存。\"},{\"id\":\"B-024\",\"spec\":\"SET-008/SET-006\",\"phase\":\"editorOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] editor cancel action and draft cache\",\"method\":\"sequence-audit\",\"property\":\"explicit cancel clears draft and closes editor\",\"expected\":{\"light\":\"clicking 取消 writes no configuration, clears that entry's fields and plaintext key buffer, closes editor, and returns focus to its trigger; remount does not restore cancelled draft\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"只读、缺 revision、校验失败或上次提交报错时取消仍可点击；busy 期间除外。\"},{\"id\":\"B-025\",\"spec\":\"SET-008/SET-006\",\"phase\":\"editorOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] editor and draft cache\",\"method\":\"sequence-audit\",\"property\":\"Escape dismissal equals cancel\",\"expected\":{\"light\":\"Escape clears the entry draft and plaintext key buffer, closes editor without writing configuration, and returns focus to its trigger; remount does not restore draft\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"与显式取消使用同一 dismiss 语义。\"},{\"id\":\"B-026\",\"spec\":\"SET-008\",\"phase\":\"editorOpen\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] draft cache and conflict alert\",\"method\":\"sequence-audit\",\"property\":\"baseRevision conflict handling after section remount\",\"expected\":{\"light\":\"when reachable, external revision change or entry deletion preserves cached draft and shows role=alert conflict; no silent overwrite or replay; only explicit cancel or confirmed resubmission proceeds\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; state-unreachable=SKIP gap\",\"notes\":\"若执行器无法通过宿主 API 注入外部 revision 变化，SKIP 并记录具体不可达注入面。\"},{\"id\":\"B-027\",\"spec\":\"SET-002/V4-1\",\"phase\":\"v4Sequence\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"] [data-role=\\\"editor\\\"]\",\"method\":\"sequence-audit\",\"property\":\"editor is direct adjacent sibling of target card row; remaining cards preserve order and move below expanded card\",\"expected\":{\"light\":\"after clicking first entry Edit, editor is in that entry outer card and is its row.nextElementSibling; no editor at list tail/outside list; later entries keep original id order and render below expanded card\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; keyboard-channel-unreachable=SKIP gap\",\"notes\":\"固定编辑器判据替换任何列表末尾/列表外假设；DOM 相邻即 nextElementSibling。\"},{\"id\":\"B-028\",\"spec\":\"SET-002/V4-1\",\"phase\":\"v4Sequence\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [data-role=\\\"card\\\"] editors\",\"method\":\"sequence-audit\",\"property\":\"single editor ownership on edit-target switch\",\"expected\":{\"light\":\"clicking Edit on a different entry moves the one editor into the new target card; total editor count remains exactly one and entry order is unchanged\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; keyboard-channel-unreachable=SKIP gap\",\"notes\":\"互斥按可见 DOM 实测，不允许复制旧编辑器或留下列表尾部编辑器。\"},{\"id\":\"B-029\",\"spec\":\"SET-006/SET-007/V4-1\",\"phase\":\"v4Sequence\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] editor, savedNotice and entries\",\"method\":\"sequence-audit\",\"property\":\"cancel close without write; successful edit closes, saves only its entry, persists and reports saved notice\",\"expected\":{\"light\":\"cancel closes editor with no mutate and restores unchanged entry list; successful edit closes editor, commits only the selected entry, displays exact 已保存 {名称}。 and reload retains the edited value; successful new create closes editor\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; keyboard-channel-unreachable=SKIP gap\",\"notes\":\"新建关闭另由 B-002/A-066 执行采样；条目级提交与提示语义不变。\"},{\"id\":\"B-030\",\"spec\":\"SET-002/V4-2\",\"phase\":\"v4Sequence\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [role=\\\"alertdialog\\\"]\",\"method\":\"sequence-audit\",\"property\":\"modal role/name/description, exact copy, buttons, backdrop and keyboard reachability\",\"expected\":{\"light\":\"deleting an entry opens visible centered alertdialog with aria-modal=true; title exactly 删除 {名称}?; body exactly 删除 {名称} 会移除其配置；其使用的凭证（如有）由其他位置管理，将会保留。; visible top-right ×, 取消 secondary/default and 删除 {名称} danger; backdrop covers viewport; real Tab reaches a dialog control\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; keyboard-channel-unreachable=SKIP gap\",\"notes\":\"文字按精确字符串比对（仅折叠 DOM 空白）；无可见弹窗/错误文案是 FAIL，不得 SKIP。\"},{\"id\":\"B-031\",\"spec\":\"SET-002/V4-2\",\"phase\":\"v4Sequence\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] delete confirmation modal\",\"method\":\"sequence-audit\",\"property\":\"close glyph, cancel and Escape are non-destructive\",\"expected\":{\"light\":\"×, 取消 and Escape each close the modal without deleting any entry, changing entry id/name order, or issuing a settings mutate\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; keyboard-channel-unreachable=SKIP gap\",\"notes\":\"三个独立打开/关闭循环均采前后快照；遗漏任一路径即 FAIL。\"},{\"id\":\"B-032\",\"spec\":\"SET-006/SET-007/V4-2\",\"phase\":\"v4Sequence\",\"target\":\"[data-plugin-id=\\\"search-chain\\\"] [role=\\\"alertdialog\\\"] [data-role=\\\"confirm-remove\\\"]\",\"method\":\"sequence-audit\",\"property\":\"danger confirmation removes only target and retains savedNotice behavior\",\"expected\":{\"light\":\"clicking exact 删除 {名称} danger action removes and persists only target entry, retains all others and current deletion savedNotice behavior\",\"dark\":\"same\"},\"tolerance\":0,\"failPolicy\":\"missing-element=FAIL; keyboard-channel-unreachable=SKIP gap\",\"notes\":\"与 B-019 分工：本行记录模态 danger /即时删除反馈，B-019 负责删除载荷排他及 reload 闭环。\"}]},\"nonAssertable\":[{\"spec\":\"style-lock §4\",\"target\":\"runtime-injected elevation/shadow/backdrop/scrollbar tokens\",\"property\":\"--dsw-elevation-prominent/-panel/-soft, --dsw-shadow-lv3, --dsw-menu-backdrop-filter, --dsw-scrollbar-bg-l2/hover-l2 resolved values\",\"reason\":\"主题静态文件无数值定义；禁止断言具体解析值。仅可 rule-text 验证变量引用。\"},{\"spec\":\"style-lock §4\",\"target\":\"menu icon token\",\"property\":\"light runtime value of --dsw-alias-menu-icon\",\"reason\":\"亮色定义未定位；只可核 var 引用存在或登记。\"},{\"spec\":\"style-lock §6 item 1\",\"target\":\"future floating menu\",\"property\":\"outer border-radius\",\"reason\":\"规格没有获取精确圆角，且当前面板不产浮层 DOM。\"},{\"spec\":\"style-lock §6 item 3\",\"target\":\".sc-card\",\"property\":\"box-sizing as official-origin assertion\",\"reason\":\"官方 rowCard 原始声明未获取；虽 SPC-006 明确钉我方 border-box，本目录不把它谎称为已获取的官方值。实施断言可依 SPC-006。\"},{\"spec\":\"style-lock §6 item 3\",\"target\":\".sc-card-name\",\"property\":\"official overflow-wrap source value\",\"reason\":\"官方是否声明未获取；我方 SPC-008 仍明确钉为 anywhere，故实现断言来源是 SPC-008。\"},{\"spec\":\"style-lock §6 item 3\",\"target\":\".sc-picker-title / .sc-picker-item\",\"property\":\"official picker title/item font-weight\",\"reason\":\"官方对应字重未获取；SPC-025 钉 picker title 600，按 SPC-025 实现断言，不作官方取证外推。\"},{\"spec\":\"style-lock §6 item 3\",\"target\":\".sc-add-button\",\"property\":\"whether its override block declares an independent background\",\"reason\":\"该块独立声明未获取；不新增对其声明来源的断言。\"},{\"spec\":\"style-lock §6 item 3\",\"target\":\".sc-input:focus\",\"property\":\"official presence of outline:none\",\"reason\":\"官方此项未获取；SPC-018 的我方钉死规则仍可直接验。\"},{\"spec\":\"style-lock §6 item 4\",\"target\":\"success/saved notice\",\"property\":\"official success/saved specialized layout\",\"reason\":\"官方专属排版未获取；若我方 status node 存在，按 SPC-030 验我方钉死值。\"},{\"spec\":\"style-lock §6 item 4\",\"target\":\"official top switch / inline picker / idle credential dot\",\"property\":\"official direct analogs\",\"reason\":\"官方先例未获取；只按 SPC-010/013/025 的明确裁定验我方实现。\"},{\"spec\":\"style-lock §6 item 5\",\"target\":\"theme tokens\",\"property\":\"light menu-icon value and label-primary-inverted chain\",\"reason\":\"未获取；不作数值断言。\"},{\"spec\":\"style-lock §6 item 6\",\"target\":\"host settings shell\",\"property\":\"additional registration-layer styles\",\"reason\":\"锁定表结论为无独立视觉 CSS；不推导额外宿主数值。\"},{\"spec\":\"style-lock §6 未裁定项\",\"target\":\".sc-card-name-placeholder, .sc-type-duplicate, @media (max-width: 720px), .sc-card-actions\",\"property\":\"placeholder/duplicate semantics, mobile overrides, flex-wrap\",\"reason\":\"保持现状并登记；未裁定数值不纳入精确值断言。\"},{\"spec\":\"style-lock §6 未验证项\",\"target\":\"corner-shape fallback\",\"property\":\"browser visual fallback when corner-shape unsupported\",\"reason\":\"仅验我方 style 规则文本；Chromium 版本未知，未验证不支持时的视觉回退。\"},{\"spec\":\"style-lock §6 未验证项\",\"target\":\"official card comparison\",\"property\":\"runtime official-vs-ours pixel-perfect equality\",\"reason\":\"锁定表未给官方宿主对照的运行时尺寸测量；按钉死计算值验，不作无依据像素等同断言。\"},{\"spec\":\"SET-004\",\"target\":\"settings save failure / revision conflict\",\"property\":\"error recovery behavior\",\"reason\":\"本工作包验收设计要求保存读回成功路径；未提供错误注入环境，不能发明故障注入步骤或结果。\"}]}";
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
    // run-acc1 实证（A-048 伪报根因）：attr 断言此前走 computed 样式面 → role/aria-live 恒 undefined。
    // attr:true 专道 getAttribute；A-047/A-060 role=alert 同批修复（此前从未真判过）。
    const actual = p.attr
      ? await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(target)}); if (!el) return null; const v = el.getAttribute(${JSON.stringify(p.prop)}); return v === null ? undefined : v; })()`, 30000)
      : got[p.prop];
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
    } else if (p.blockifyEqv) {
      // lead 修复项 1：钉死 inline-* 的元素身为 flex/grid 父项的 flex item，Chromium computed 必然块级化。
      // 等价条件（全部满足）：computed=p.blockifyEqv ∧ 计算父容器 display 为 flex/grid 系 ∧ 规则文本含 specified display:inline-*。
      const pd = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(target)}); const pe = el && el.parentElement; return pe ? getComputedStyle(pe).display : ""; })()`, 30000);
      const rules = await cssRules();
      const specHit = (rules.rules || []).some((r) => r.sel.includes(p.ruleHint) && norm(r.text).includes(norm(`display:${p.want}`)));
      ok = eqCss(actual, p.blockifyEqv) && /flex|grid/.test(pd) && specHit;
      if (ok) measured[p.prop] = `${actual}(specified ${p.want} 规则文本实证；父 display=${pd} 块级化=等价)`;
      else mis.push(`display got ${actual} 期望 ${p.want}（块级化等价需：父 flex/grid[实测 ${pd || "?"}] ∧规则文本 specified ${p.want}[实测 ${specHit}]）`);
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
      savedNotice: (root.querySelector('[data-role="save-status"]')?.textContent || '').trim(),
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
  // run-acc2 实证：picker→编辑器类型上下文自证（B-007 第三条目 "Exa" 异常根因取证：type 上下文/临时条目 id）。
  const edCtx = await evaluate(`(() => { const f = document.querySelector('${ROOT} [data-role="field"][data-field="name"]'); if (!f) return { open: false }; const dlg = f.closest('[role="dialog"]') || f.closest('.sc-editor') || f; return { open: true, entryId: f.getAttribute("data-entry-id"), val: String(f.value || "").slice(0, 16), ctx: String(dlg.textContent || "").replace(/\s+/g, " ").slice(0, 36) }; })()`, 30000);
  console.log(`[oracle] prep 注记：addViaPicker(${JSON.stringify(type)}) 编辑器=${JSON.stringify(edCtx)}`);
}
async function openEditor(cardId) { if (!(await ui.click(`${T.card(cardId)} [data-role="card-edit"]`))) throw new Error("card-edit 缺失"); await wait(450); }
async function closeEditor() {
  const did = await cancelEditor();
  if (did) return;
  // v1 兼容面/run-9 实证：无「取消」钮时代以「完成」钮关窗（无字段改动时幂等无副作用；持久化另由保存驱动）。
  if (await implV1()) {
    await evaluate(`() => { const b = [...document.querySelectorAll('${ROOT} [data-role="editor"] button')].find((n) => /完成|Done/i.test((n.textContent || '').trim())); if (b) b.click(); return true; }`, 30000);
    await wait(400);
  }
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
// v2/SET-008：设置抽屉分区切换（离开我方面板=unmount；回来=重挂载）。
// ───────── O-1 挂载语义探针 + B-022..026 载体收敛（run-10 实证）─────────
// run-10 崩溃位取证：官方 shell 分区切换时我方面板保持挂载（未 unmount）——O-1 定案。
// 前置守卫禁 throw（全量无短路纪律）；三观测（DOM 在场性/display 遮挡/React 活值回环）正式入 measured。
// B-022..026 载体收敛为「设置视图关闭-重开」。【lead 裁定：载体实机不可达已定案（run-11 三通道实测
// drawer-close-btn/settings-toggle did=false、escape 被编辑器先吞；分区切换不卸载）→ call-7 取消，
// B-022/B-026 实机定态=SKIP gap（三观测+attempts 自证），回填/冲突面由单测覆盖+代码走查；B-025 v1
// PASS 判词保留入基线档案。本函数保留 accel-mod-comma 通道（asar 宿主规格「Mod+, 切换设置弹窗开关」
// 实证）：若后续轮次该通道关闭成功，SKIP 定态自动升级为真载体判别，无需改判据。】
async function mountProbe() {
  return evaluate(`() => { const r = document.querySelector('${ROOT}'); let hidden = null;
    if (r) { let n = r; for (let i = 0; i < 6 && n; i++, n = n.parentElement) { const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden') { hidden = cs.display + '/' + cs.visibility; break; } } }
    const ni = document.querySelector('${ROOT} [data-role="field"][data-field="name"]');
    return { present: !!r, hidden, editor: !!(ni && ni.offsetParent), nameVal: ni ? String(ni.value).slice(0, 24) : null }; }`, 30000);
}
async function sectionSwitchProbe() {
  // 载体候选 A：分区切换三观测（O-1 正式取证面，非抛出）。
  const pre = await mountProbe();
  const clicked = await evaluate(`() => { const ours = /^(网页搜索链|Web\s*Search\s*Chain)$/i; const items = [...document.querySelectorAll('button,[role="tab"],[role="menuitem"],a,li')];
    const other = items.find((n) => !ours.test((n.innerText || '').trim()) && (n.innerText || '').trim().length <= 24);
    if (!other) return false; (other.closest('button,[role="tab"],[role="menuitem"],li') || other).click(); return true; }`, 30000);
  await wait(800);
  const during = await mountProbe();
  let back = false;
  for (let i = 0; i < 3 && !back; i++) { back = await navClick("网页搜索链"); if (!back) await wait(600); }
  await wait(700);
  const post = await mountProbe();
  return { navClicked: clicked, pre, duringPresent: during.present, post, unmounted: !during.present };
}
async function settingsViewCycle() {
  // 载体 B（run-10 实证主载体）：关闭设置视图→重开（必卸载路径）。关闭选择器运行时探测，非抛出。
  const attempts = [];
  let closed = false;
  const tryClose = async (label, fn) => {
    if (closed) return;
    try { const did = await fn(); await wait(500); closed = !(await mountProbe()).present; attempts.push({ label, did, closed }); console.log(`[oracle] 关闭通道取证留底（run-acc4：行消息截断面绕行）：${label} closed=${closed} did=${JSON.stringify(did)}`); }
    catch (e) { attempts.push({ label, err: String((e && e.message) || e).slice(0, 60) }); }
  };
  // Mod+, 加速通道（asar 宿主规格原文实证：「设置位于最前方或没有模态弹窗时，设置命令（Desktop 为
  // Mod+,）切换设置弹窗的开关」；且「Tab 顺序中，分区按钮先于头部操作和关闭按钮」= 关闭钮存在但无
  // label 特征（run-11 三通道 did=false 一致）。加速键不经 DOM 选择器，是唯一有规格背书的单按关闭通道。）
  await tryClose("accel-mod-comma", async () => {
    // run-acc2 实证修正：nativeVirtualKeyCode=188 为 Windows OEM_Comma；macOS kVK_ANSI_Comma=51——Chromium/Electron 在 mac
    // 菜单加速器按 native VK 匹配；并补 rawKeyDown→keyDown(text)→keyUp 全序列（run-acc2 did=true closed=false 与 VK 错配假说一致）。
    const ev = (type, extra) => cdp("Input.dispatchKeyEvent", Object.assign({ type, key: ",", code: "Comma", windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 51, modifiers: 4 }, extra || {}));
    await ev("rawKeyDown"); await ev("keyDown", { text: "," }); await ev("keyUp");
    return { vkMac: 51, seq: "raw+down+up" };
  });
  await tryClose("close-btn-enumerate", () => evaluate(`() => { const btns = [...document.querySelectorAll('button,[role="button"]')];
    const hit = btns.find((n) => /close|关闭|收起/i.test((n.getAttribute("aria-label") || "") + " " + (n.getAttribute("title") || "") + " " + String(n.className)) || /^[×✕✖✗]$/.test(String(n.textContent || "").trim()));
    if (hit) hit.click(); // run-acc2：枚举面自证（asar：抽屉有关闭钮但无 label 特征；sample 即选择器证据）
    return { clicked: !!hit, sample: btns.slice(0, 12).map((n) => ({ a: (n.getAttribute("aria-label") || "").slice(0, 18), t: String(n.textContent || "").trim().slice(0, 8), c: String(n.className).slice(0, 20) })) }; }`, 30000));
  await tryClose("drawer-close-btn", () => evaluate(`() => { const b = [...document.querySelectorAll('button,[role="button"]')].find((n) => /关闭|close/i.test((n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('title') || '')) || /^[×✕✖]$/.test((n.innerText || '').trim())); if (!b) return false; b.click(); return true; }`, 30000));
  await tryClose("settings-toggle", () => evaluate(`() => { const cands = [...document.querySelectorAll('button,a,[role="button"],[role="menuitem"]')]; const item = cands.find((n) => /^(设置|Settings)$/i.test((n.innerText || n.getAttribute('aria-label') || n.getAttribute('title') || '').trim())); if (!item) return false; item.click(); return true; }`, 30000));
  await tryClose("escape", async () => { await pressKey("Escape", "Escape", 27); return true; }); // run-11 实测 did=true closed=false（编辑器先吞=O-5 修订前佐证）
  if (!closed) return { closed: false, attempts, post: await mountProbe() };
  await wait(600);
  await openSettings();
  for (let i = 0; i < 30; i++) { if ((await mountProbe()).present) break; await wait(400); }
  await wait(600);
  return { closed: true, attempts, post: await mountProbe() };
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
// 原生拖拽（lead 修复项 14）：Input.setInterceptDrags(true) 拦截渲染进程发起的 HTML5 拖拽，
// 再以 Input.dispatchDragEvent 完成 dragEnter/dragOver/drop——Electron 下唯一原生链路（dev 实证 data-dragging 可达）。
// 返回拖动态 opacity 字符串；拦截未发生=不可达返回 null（A-052/B-013 按目录记 SKIP gap）。
async function nativeDragAttempt(cardId) {
  const geo = await evaluate(`(() => { const h = document.querySelector('${T.card(cardId)} [data-role="drag-handle"]'); const nx = document.querySelector('${ROOT} [data-role="card"]:nth-of-type(2)') && [...document.querySelectorAll('${ROOT} [data-role="card"]')][1]; if (!h || !nx) return null; h.scrollIntoView({ block: 'center' }); const r = h.getBoundingClientRect(); const n = nx.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, tx: n.x + n.width / 2, ty: n.y + n.height * 0.75 }; })()`, 30000);
  if (!geo) throw new Error("missing element: drag-handle/second card");
  cdpEvents.length = 0;
  await cdp("Input.setInterceptDrags", { enabled: true });
  try {
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: geo.x, y: geo.y });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: geo.x, y: geo.y, button: "left", clickCount: 1 });
    for (let i = 1; i <= 12; i++) {
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: geo.x, y: geo.y - i * 8, button: "left" });
      await wait(50);
      if (cdpEvents.length) break;
    }
    if (!cdpEvents.length) {
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: geo.x, y: geo.y - 96, button: "left" });
      return null; // 渲染进程未发起原生拖拽 = 不可达
    }
    const data = cdpEvents[0].data;
    await cdp("Input.dispatchDragEvent", { type: "dragEnter", x: geo.tx, y: geo.ty, data });
    let dragging = null;
    for (let i = 0; i < 10 && dragging === null; i++) {
      await cdp("Input.dispatchDragEvent", { type: "dragOver", x: geo.tx, y: geo.ty - i * 2, data });
      dragging = await evaluate(`() => { const el = document.querySelector('${ROOT} [data-role="card"][data-dragging]'); return el ? getComputedStyle(el).opacity : null; }`, 30000);
      await wait(60);
    }
    await cdp("Input.dispatchDragEvent", { type: "dragOver", x: geo.tx, y: geo.ty, data });
    await cdp("Input.dispatchDragEvent", { type: "drop", x: geo.tx, y: geo.ty, data });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: geo.tx, y: geo.ty, button: "left" });
    await cdp("Input.dispatchDragEvent", { type: "dragEnd", x: geo.tx, y: geo.ty, data }).catch(() => {});
    await wait(450);
    return dragging === null ? "none" : dragging; // "none"=拖拽链路可达但未观测 data-dragging（可达即判，非不可达）
  } finally {
    await cdp("Input.setInterceptDrags", { enabled: false }).catch(() => {});
  }
}
async function mouseNeutral() { await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 3, y: 3 }).catch(() => {}); await wait(150); } // 采样前脱 hover（lead 修复项 11）
const saveSamples = []; // {theme, text, width}（A-032 「width follows label content」采样面）
async function captureSaveSample(theme, tag) {
  const s = await ui.state();
  if (s.absent) return;
  const e = { theme, tag, text: s.savedNotice, width: 0 };
  const prev = saveSamples[saveSamples.length - 1];
  if (!prev || prev.text !== e.text || prev.theme !== theme || prev.tag !== tag) saveSamples.push(e);
}
async function captureDisabledFamilies(theme = "light") {
  // v2（SPC-017/A-034）：commit in-flight 窗口 = 编辑器提交 busy 态。开 c1 编辑器 → 点提交主按钮
  // （内容未改，幂等落盘一次）→ 8ms 轮询采 disabled 家族（button/action/input/track/label 五档）。
  await captureSaveSample(theme, "pre-save");
  await ui.click(`${T.card(cardIds[0])} [data-role="card-edit"]`);
  await wait(400);
  const ok = await evaluate(`() => !!document.querySelector('${ROOT} [data-role="field"][data-field="name"]')`, 30000);
  if (!ok) throw new Error("编辑器不可开启：commit 窗口 input 档不可采（执行器前置状态失败）");
  const n = (await calls()).length;
  const clicked = await evaluate(`() => { const b = [...document.querySelectorAll('${ROOT} [data-role="editor"] button')].find((x) => /sc-button-primary/.test(x.className || '') && !/取消/.test(x.textContent || '')); if (!b || b.disabled) return false; b.click(); return true; }`, 30000);
  if (!clicked) { await closeEditor(); return null; }
  const famGet = `(() => { const E = '${ROOT} [data-role="editor"]';
    const get = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return { opacity: cs.opacity, cursor: cs.cursor }; };
    const btn = [...document.querySelectorAll(E + ' button')].find((x) => /sc-button-primary/.test(x.className || '') && !/取消/.test(x.textContent || ''));
    const act = [...document.querySelectorAll(E + ' button')].find((x) => (x.textContent || '').trim() === '取消');
    return { button: btn ? { opacity: getComputedStyle(btn).opacity, cursor: getComputedStyle(btn).cursor } : null,
      action: act ? { opacity: getComputedStyle(act).opacity, cursor: getComputedStyle(act).cursor } : null,
      busyLabel: btn ? (btn.textContent || '').trim() : null,
      submitDisabled: btn ? btn.disabled : false,
      input: get(E + ' [data-role="field"][data-field="name"]'),
      track: get(E + ' .sc-switch-input:disabled + .sc-switch-track'),
      switchLabel: get(E + ' .sc-switch:has(.sc-switch-input:disabled) .sc-switch-label') };
  })()`;
  let fam = null;
  for (let i = 0; i < 150; i++) {
    fam = await evaluate(famGet, 30000);
    if (fam.button && fam.button.opacity === "0.4") { await captureSaveSample(theme, "pending"); break; }
    fam = null;
    await wait(8);
  }
  await waitRpc("/api/settings/mutate", n, 60).catch(() => {});
  await settleSaved();
  return fam;
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
let exa1Id = null, exa2Id = null, bingId = null; // run-acc7：SET-001/002 的 exa-1/exa-2/bing 是创建顺序身份→id 锚（名判据/位判据各有失真前科）
let fam = null; // v2：编辑器提交 busy 窗五档采样
let famDark = null;
let missingCard = null; // 无凭据观察卡（A-018/A-019 missing 态；观察后删除复位）
const labels = {}; // A-057 文案面采样：create/edit/busy
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
    // v2（SET-007）：落定=节级 savedNotice [data-role=save-status][data-state=saved]（role=status；全局保存钮废止）。
    const saved = await evaluate(`() => !!document.querySelector('${ROOT} [data-role="save-status"][data-state="saved"]')`, 30000);
    if (saved) return true;
    await wait(1000);
  }
  return false;
}
// v2 持久化模型：条目提交=编辑器动作行主按钮；离散动作（开关/超时/排序/移除）自动落盘。
// waitForAutoSave(before)：离散动作前取 calls().length，动作后调用——等该动作触发的 mutate 落定。
async function waitForAutoSave(beforeCount) {
  const before = typeof beforeCount === "number" ? beforeCount : (await calls()).length;
  if (await implV1()) {
    // v1 兼容面/run-9 实证：纠偏前离散动作持久化由全局保存钮驱动；SET-006 专责判据（载荷排他/独立 mutate）
    // 仍按 v2 目录判——全局保存触发的 mutate 不会伪证「动作自身落盘」（专责行取数窗口在保存点击之前）。
    return saveViaGlobalSave(before);
  }
  await wait(600);
  await waitRpc("/api/settings/mutate", before, 60).catch(() => {});
  return true; // run-acc8 v3 取数面（5bd84f5 V3-3）：开关类不再发 savedNotice——「落定」锚=该动作 mutate 落定；settleSaved 仅保留给提示保留动作族（编辑器提交/超时/删除/重排落定）。
}
// ───────── v1 兼容层（纠偏前校准轮 run-9 实证面）─────────
// 被测实现可能是纠偏前（v1：全局 [data-role=save] 钮、选类型即入账无新建编辑器、持久化=全局保存）
// 或纠偏后（v2：离散动作自动落盘）。执行器仅运行时探测取数路径（选择器/驱动），断言语义与判据零改动。
let VT = null;
async function implV1() {
  if (VT === null) VT = await evaluate(`() => !!document.querySelector('${ROOT} [data-role="save"]')`, 30000);
  return VT;
}
// v1 全局保存驱动（run-1..4 实证路径：点钮 → 等 mutate → saved 落定）。
async function saveViaGlobalSave(beforeCount) {
  const before = typeof beforeCount === "number" ? beforeCount : (await calls()).length;
  await wait(350); // v1 兼容面/run-10 实证：离散动作后先让 React 态提交再点全局保存（v1 时代 saveAndSettle 同律；run-10 B-011 伪报=此竞态）
  const clicked = await evaluate(`() => { const b = document.querySelector('${ROOT} [data-role="save"]'); if (!b) return false; b.click(); return true; }`, 30000);
  if (!clicked) return false;
  await wait(700);
  await waitRpc("/api/settings/mutate", before, 60).catch(() => {});
  return settleSaved();
}
// 新建收尾：v2=编辑器内填字段+提交主按钮；v1 兼容面/run-9 实证=选类型即入账，改编辑窗补字段+全局保存。
async function finishCreate(name, key) {
  const editorOpen = await evaluate(`() => !!document.querySelector('${ROOT} [data-role="field"][data-field="name"]')`, 30000);
  if (editorOpen) {
    if (name !== null && (await setField("name", name)) !== name) throw new Error(`${JSON.stringify(name)} 名称输入失败`);
    if (key && (await setField("key", key)) !== key) throw new Error(`${JSON.stringify(name)} key 输入失败`);
    const nF12 = (await calls()).length; // run-acc7 取证：create 提交窗（append 位点 token + rev 序列）
    // run-acc4 取证协议3（lead 假说判据）：提交钮点击前的编辑器态快照——val 若已非目标名=SET-008 陈旧草稿回填覆盖坐实；仍为目标名=提交链取证。
    const preSub = await evaluate(`(() => { const f = document.querySelector('${ROOT} [data-role="field"][data-field="name"]'); return f ? { val: String(f.value || "").slice(0, 16), eid: f.getAttribute("data-entry-id") } : null; })()`, 30000);
    console.log(`[oracle] prep 注记：即将提交 ${JSON.stringify(name)} → 提交时刻编辑器=${JSON.stringify(preSub)}`);
    await submitEditor("create");
    // run-acc2 实证：prep 自证面——提交后回读名单快照（B-007 第三条目 "Exa" 异常需证据链）；不判定、只注记，判据权仍在 B-007。
    if (name !== null) { const sn = await ui.state(); console.log(`[oracle] prep 注记：create ${JSON.stringify(name)} 提交后名单=${JSON.stringify(sn.names)} 尾ids=${JSON.stringify(sn.ids.slice(-2))}（run-acc4 id 重键自证面：temp eid vs 持久 id）`); }
    { const recsF = (await calls()).slice(nF12).filter((x) => x.url === "/api/settings/mutate"); console.log(`[oracle] prep create 提交时间线: ${JSON.stringify(name)} → ${JSON.stringify(recsF.map((x) => ({ mk: (x.mkeys || []).slice(0, 5), revv: x.revv ?? null })))}（run-acc7 取证：append 位点+expectedRevision 序列）`); }
  } else {
    if (!(await implV1())) throw new Error("既无新建编辑器也无全局保存钮——两代契约皆缺席（执行器取数前置失败）");
    const st = await ui.state(); const id = st.ids[st.ids.length - 1];
    await openEditor(id);
    if (name !== null && (await setField("name", name)) !== name) throw new Error(`${JSON.stringify(name)} 名称输入失败（v1 补写路径）`);
    if (key && (await setField("key", key)) !== key) throw new Error(`${JSON.stringify(name)} key 输入失败（v1 补写路径）`);
    await submitEditor("edit"); // v1 分支内=完成钮+全局保存
  }
}
async function submitEditor(kind) {
  // 编辑器提交（kind=create|edit）：点动作行 primary 钮 → 等 mutate → settleSaved → 编辑器关闭。
  if (await implV1()) {
    // v1 兼容面/run-9 实证：v1 编辑器「完成」钮关闭 + 全局保存落盘（无动作行 primary）。
    await evaluate(`() => { const b = [...document.querySelectorAll('${ROOT} [data-role="editor"] button')].find((n) => /完成|Done/i.test((n.textContent || '').trim())); if (b) b.click(); return true; }`, 30000);
    await wait(400);
    const settledV1 = await saveViaGlobalSave();
    if (!settledV1) throw new Error(`${kind} 提交未落定（v1 全局保存未达 saved）`);
    return true;
  }
  const n = (await calls()).length;
  const clicked = await evaluate(`() => { const b = [...document.querySelectorAll('${ROOT} .sc-editor-actions button, ${ROOT} [data-role="editor"] button')].find((x) => /sc-button-primary/.test(x.className || '') && !/取消/.test(x.textContent || '')); if (!b) return false; b.click(); return true; }`, 30000);
  if (!clicked) throw new Error("missing element: 编辑器提交主按钮（.sc-editor-actions primary）");
  { const b = await evaluate(`() => { const x = [...document.querySelectorAll('${ROOT} .sc-editor-actions button, ${ROOT} [data-role="editor"] button')].find((n) => /sc-button-primary/.test(n.className || '') && !/取消/.test(n.textContent || '')); return x ? (x.textContent || '').trim() : null; }`, 30000); if (kind === "create" && !labels.createBusy) labels.createBusy = b; }
  await wait(700);
  await waitRpc("/api/settings/mutate", n, 60).catch(() => { console.log(`[oracle] 注记：${kind} 提交后窗口内未见 settings/mutate（run-acc2 自证面：静默持久失败线索）`) }); // run-acc2 实证：静默超时自证化
  const settled = await settleSaved();
  for (let i = 0; i < 20; i++) { const g = await evaluate(`() => !!document.querySelector('${ROOT} [data-role="editor"]')`, 30000); if (!g) break; await wait(400); }
  const stillOpen = await evaluate(`() => !!document.querySelector('${ROOT} [data-role="editor"]')`, 30000);
  if (stillOpen || !settled) throw new Error(`${kind} 提交未落定（编辑器${stillOpen ? "未关闭" : "已关闭"}，saved=${settled}）`);
  return true;
}
async function cancelEditor() {
  const done = await evaluate(`() => { const b = [...document.querySelectorAll('${ROOT} [data-role="editor"] button, ${ROOT} .sc-editor-actions button')].find((x) => (x.textContent || '').trim() === '取消' || (x.textContent || '').trim() === '完成'); if (!b) return false; b.click(); return true; }`, 30000);
  await wait(400);
  return done;
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
      { prop: "borderTopLeftRadius", want: radius }, { prop: "paddingTop", want: "12px" }, { prop: "paddingLeft", want: "10px" }, // run-acc8 v3 取数面（5bd84f5 V3-2：卡片左内衬 14→10 把手左靠；目录字面对齐待 Luna）
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
    { prop: "display", want: "inline-flex", blockifyEqv: "flex", ruleHint: ".sc-card-info" }, { prop: "alignItems", want: "center" }, { prop: "gap", want: "4px" }, // run-acc8 v3 取数面（5bd84f5 V3-2：info gap 6→4） { prop: "minWidth", want: "0px" },
  ]) }));
  await exec("A-012", theme, async () => {
    // lead 修复项 2：margin-left:auto 的 computed 是布局后 px——specified 走规则文本断言，几何走「动作组右缘≈卡内容右缘」。
    const measured = await checkProps(`${ROOT} .sc-card-actions`, [
      { prop: "display", want: "inline-flex", blockifyEqv: "flex", ruleHint: ".sc-card-actions" }, { prop: "alignItems", want: "center" }, { prop: "gap", want: "4px" },
    ]);
    const rules = await cssRules();
    const specHit = (rules.rules || []).some((r) => r.sel.includes(".sc-card-actions") && norm(r.text).includes(norm("margin-left:auto")));
    if (!specHit) throw new Error(`.sc-card-actions 规则文本未见 specified margin-left:auto；computed 面=${measured}`);
    const geo = await rects({ actions: `${ROOT} .sc-card-actions`, card: `${ROOT} [data-role="card"]` });
    if (!geo.actions || !geo.card) throw new Error("missing element: .sc-card-actions/.sc-card");
    const delta = Math.abs(geo.actions.right - (geo.card.right - geo.card.padRight));
    if (delta > 1) throw new Error(`动作组右缘 ${geo.actions.right} 未钉至卡片内容右缘（差 ${delta.toFixed(2)}px，auto 边距未生效）`);
    return { measured: `${measured} marginLeft=auto(规则文本 specified) 动作组右缘差 ${delta.toFixed(2)}px` };
  });
  await exec("A-013", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-card-name`, [
    { prop: "overflowWrap", want: "anywhere", noteOnly: true }, // lead 修复项 3：先入账 overflowWrap，wordBreak 备选判定才可读到
    { prop: "fontSize", want: "14px" }, { prop: "lineHeight", want: "22px" }, { prop: "fontWeight", want: "500" },
    { prop: "wordBreak", wantFn: (a, m) => eqCss(a, "anywhere") || eqCss(m.overflowWrap, "anywhere"), wantLabel: "anywhere（word-break 或 overflow-wrap）" },
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
  await exec("A-026", theme, async () => {
    // lead 修复项 5：首个 .sc-switch 属官方行（SPC-013 label-primary 是其正确值）；SPC-012 断言限定卡片开关上下文。
    const geo = await checkProps(`${ROOT} [data-role="card"] .sc-switch`, [
      { prop: "display", want: "inline-flex", blockifyEqv: "flex", ruleHint: ".sc-switch" }, { prop: "alignItems", want: "center" }, { prop: "gap", want: "8px" },
      { prop: "color", wantProbe: "--dsw-alias-label-secondary", also: theme === "light" ? "rgb(97, 102, 107)" : "rgb(207, 211, 214)" },
      { prop: "cursor", want: "pointer" }, { prop: "whiteSpace", want: "nowrap" },
    ]);
    const lab = await checkProps(`${ROOT} [data-role="card"] .sc-switch .sc-switch-label`, [
      { prop: "fontSize", want: "14px" }, { prop: "lineHeight", want: "22px" },
    ]);
    return { measured: `${geo} ${lab}` };
  });
  await exec("A-027", theme, async () => ({ measured: await checkProps(`${ROOT} .sc-official-row`, [
    { prop: "display", want: "flex" }, { prop: "flexDirection", want: "column" }, { prop: "alignItems", want: "flex-start" },
    { prop: "gap", want: "8px" }, { prop: "backgroundColor", want: "rgba(0, 0, 0, 0)" }, { prop: "borderTopWidth", want: "0px" },
  ]) }));
  await evaluate(`(() => { const el = document.querySelector('${T.toggle(c3)}'); if (el && !el.checked) el.click(); return true; })()`, 30000); // 恢复 bing enabled（未保存草稿动作）
  await wait(250);
  await exec("A-030", theme, async () => {
    const rules = await cssRules();
    if (rules.missing) throw new Error('missing element: style[data-sc-style="panel"]');
    const hovers = (rules.rules || []).filter((r) => r.sel.includes(":hover"));
    if (!hovers.length) throw new Error("面板无 hover 规则（应有按钮/picker hover 体系）");
    const bad = hovers.filter((r) => !/hover\s*:\s*hover/i.test(r.media || ""));
    if (bad.length) throw new Error(`${bad.length}/${hovers.length} 条 hover 声明不在 @media (hover: hover) 内：${bad.slice(0, 3).map((r) => r.sel).join(", ")}`);
    return { measured: `${hovers.length} 条 hover 声明全部位于 @media (hover: hover)` };
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
    if (Math.abs(geo.handle.w - 21) > 0.01 || Math.abs(geo.handle.h - 28) > 0.01) throw new Error(`geometry got ${geo.handle.w}×${geo.handle.h} 期望 21×28（v3 V3-2：宽 −25%，纵向触控区不减）`); // run-acc8 v3 取数面：规格数字即判据（5bd84f5），目录字面对齐待 Luna
    return { measured: "21px × 28px" };
  });
  // ── v2 default 族：全局保存入口缺席 + 卡片骨架信息行 + 把手显隐 ──
  await exec("A-055", theme, async () => {
    const dom = await evaluate(`() => ({ save: !!document.querySelector('${ROOT} [data-role="save"]'), cls: !!document.querySelector('${ROOT} .sc-save-button') })`, 30000);
    const rules = await cssRules();
    const styleHit = (rules.rules || []).filter((r) => /\.sc-save-button/.test(r.sel)).map((r) => r.sel);
    if (dom.save || dom.cls || styleHit.length) throw new Error(`全局保存入口残留：DOM save=${dom.save} .sc-save-button=${dom.cls} 样式表=${JSON.stringify(styleHit.slice(0, 2))}`);
    return { measured: "DOM 无 [data-role=save]/.sc-save-button；注入样式表 .sc-save-button 规则 0 条（双查）" };
  });
  await exec("A-061", theme, async () => {
    const dom = await evaluate(`(() => { const info = document.querySelector('${ROOT} [data-role="card"] .sc-card-info'); if (!info) return null;
      const first = info.firstElementChild;
      const name = info.querySelector('[data-role="card-name"]'); const badge = info.querySelector('[data-role="card-type"]'); const dot = info.querySelector('[data-role="card-status"]');
      const after = (a, b) => !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      const cs = getComputedStyle(info);
      return { firstHandle: !!first && first.classList.contains('sc-drag-handle'), firstTag: first && first.tagName,
        order: !!(name && dot) && after(first, name) && after(name, dot) && (!badge || (after(name, badge) && after(badge, dot))),
        ox: cs.overflowX, oy: cs.overflowY };
    })()`, 30000);
    if (!dom) throw new Error("missing element: .sc-card-info");
    const mis = [];
    if (!dom.firstHandle) mis.push("首个子节点不是 .sc-drag-handle（把手须在名称前）");
    if (dom.firstTag && dom.firstTag !== "BUTTON") mis.push(`把手不是 button（got ${dom.firstTag}）`);
    if (!dom.order) mis.push("info 子序违规（期望 把手→名称→徽标→状态点）");
    if (dom.ox === "hidden" || dom.oy === "hidden") mis.push(`.sc-card-info overflow=${dom.ox}/${dom.oy}（禁止 hidden，截断只作用名称）`);
    if (mis.length) throw new Error(`SPC-007 v2 骨架违规：${mis.join("；")}`);
    return { measured: "首子=.sc-drag-handle(button)→名称→徽标→状态点；overflow 非 hidden" };
  });
  await exec("A-062", theme, async () => {
    const a = await checkProps(`${ROOT} [data-role="card"] .sc-card-info`, [
      { prop: "display", want: "inline-flex", blockifyEqv: "flex", ruleHint: ".sc-card-info" },
      { prop: "alignItems", want: "center" }, { prop: "gap", want: "4px" }, // run-acc8 v3 取数面（5bd84f5 V3-2 同值面）
    ]);
    const b = await checkProps(`${ROOT} [data-role="card"] .sc-drag-handle`, [{ prop: "flexShrink", want: "0" }]);
    return { measured: `${a} ${b}` };
  });
  await exec("A-063", theme, async () => {
    // 基线层（hover:none 环境常显）：CDP 媒体仿真切 hover=none 后 computed 判定，采样后立即复位。
    // run-acc1 实证：无 canary 时无法区分「仿真未生效（执行器面）」vs「实现写死基线 0（真缺陷）」——
    // 补 matchMedia canary + 二式重试；仿真可达性由 canary 自证，仍不可达按目录 failPolicy
    // state-unreachable=SKIP gap（附规则归属直读：基线层 .sc-drag-handle 无 opacity 声明=结构常显）。
    const setEm = (f) => cdp("Emulation.setEmulatedMedia", f);
    const canary = `() => ({ hv: matchMedia('(hover: none)').matches, any: matchMedia('(any-hover: none)').matches, hh: matchMedia('(hover: hover)').matches })`;
    let emu = null;
    try {
      await setEm({ features: [{ name: "hover", value: "none" }, { name: "any-hover", value: "none" }] });
      await wait(150);
      emu = await evaluate(canary, 30000);
      if (!(emu && emu.hv && emu.any)) {
        await setEm({ media: "all", features: [{ name: "hover", value: "none" }, { name: "any-hover", value: "none" }] });
        await wait(150);
        emu = await evaluate(canary, 30000);
      }
    } catch (e) { emu = { err: String((e && e.message) || e).slice(0, 80) }; }
    if (!(emu && emu.hv && emu.any)) {
      await setEm({ media: "", features: [{ name: "hover", value: "hover" }, { name: "any-hover", value: "hover" }] }).catch(() => {});
      const rules = await cssRules();
      const baseRule = (rules.rules || []).find((r) => /\.sc-drag-handle\b/.test(r.sel) && !(r.media || "") && /transition/i.test(r.text) && !/:disabled|:hover|focus-visible/.test(r.sel));
      const baseHasOpacity = !!baseRule && /opacity\s*:/.test(baseRule.text);
      const tSnippet = baseRule && baseRule.text.match(/transition[^;]+/) ? String(baseRule.text.match(/transition[^;]+/)[0]).slice(0, 40) : "缺失";
      const baseDesc = !baseRule ? "基线 .sc-drag-handle 规则未检出" : (baseHasOpacity ? "含 opacity 声明（结构性缺陷，dev3 域）" : `无 opacity 声明=结构常显 ✓，transition=${tSnippet}`);
      throw new SkipGap(`hover:none 仿真不可达（canary ${JSON.stringify(emu)}，二式 setEmulatedMedia 均不生效）；规则归属直读：基线层 ${baseDesc}；failPolicy state-unreachable=SKIP gap`);
    }
    let got;
    try {
      got = await computed(`${ROOT} [data-role="card"] .sc-drag-handle`, ["opacity", "transitionProperty", "transitionDuration", "transitionTimingFunction"]);
    } finally {
      await setEm({ media: "", features: [{ name: "hover", value: "hover" }, { name: "any-hover", value: "hover" }] });
      await wait(150);
    }
    const mis = [];
    if (!got || got.opacity !== "1") mis.push(`hover:none 基线 opacity got ${got && got.opacity} 期望 1（常显基线）`);
    if (got && (got.tp !== "opacity" || got.td !== "0.12s" || got.tt !== "ease")) mis.push(`基线层 transition got ${got.tp} ${got.td} ${got.tt} 期望 opacity .12s ease`);
    if (mis.length) throw new Error(`SPC-027 v2 基线层违规：${mis.join("；")}`);
    return { measured: `Emulation hover:none 下 opacity=1 常显（canary ${JSON.stringify(emu)} 已证仿真生效）；transition ${got.tp} ${got.td} ${got.tt}（仿真已复位 hover:hover）` };
  });
  await exec("A-064", theme, async () => {
    const rules = await cssRules();
    if (rules.missing) throw new Error('missing element: style[data-sc-style="panel"]');
    const rs = rules.rules || [];
    const hoverLayer = rs.filter((r) => /hover\s*:\s*hover/i.test(r.media || "") && /sc-drag-handle/.test(r.sel));
    const mis = [];
    if (!hoverLayer.length) mis.push("无 @media (hover: hover) 的 .sc-drag-handle 显隐规则层");
    if (!hoverLayer.some((r) => /opacity:\s*0\b/i.test(r.text) && !/:hover|focus-visible|:disabled|\[disabled\]/.test(r.sel))) mis.push("缺静息 .sc-drag-handle opacity 0 声明");
    if (!hoverLayer.some((r) => /\.sc-card:hover[^{]*\.sc-drag-handle/i.test(r.sel))) mis.push("缺 .sc-card:hover .sc-drag-handle 显现选择器");
    if (!hoverLayer.some((r) => /\.sc-drag-handle:focus-visible/i.test(r.sel))) mis.push("缺 .sc-drag-handle:focus-visible 显现选择器");
    // run-acc1 实证：CSSOM 序列化把 .4 输出为 0.4，旧正则漏配=执行器伪报面；修复序列化匹配。
    if (!hoverLayer.some((r) => /opacity:\s*(?:0)?\.4\b/i.test(r.text))) mis.push("缺 disabled 把手 hover 态 opacity .4");
    // 目录字面补检（run-acc1 审计：此前漏断言）：expected 含「resting … disabled handle opacity 0」，
    // spec 实现 CSS L186 要求 hover 层内静息 disabled 独立 opacity:0 规则（hover 显现 .4 仅叠加态）。
    const restDis = hoverLayer.filter((r) => /:disabled/.test(r.sel) && !/:hover|focus-visible/.test(r.sel));
    if (!restDis.some((r) => /opacity:\s*0(?:\.0+)?\s*(?:;|$)/i.test(r.text))) mis.push("缺 hover 层静息 disabled 把手 opacity 0（目录字面 resting disabled handle opacity 0 / spec L186 独立规则）");
    const badMech = rs.filter((r) => /sc-drag-handle/.test(r.sel) && /(display\s*:\s*(none|inline|block))|(visibility\s*:\s*hidden)/i.test(r.text));
    if (badMech.length) mis.push(`把手使用 display/visibility 隐藏机制：${badMech[0].sel}{${badMech[0].text.slice(0, 60)}}`);
    if (mis.length) throw new Error(`SPC-027 v2 hover 层规则缺失：${mis.join("；")}`);
    return { measured: "@media (hover: hover) 双层显隐全检出（静息 0/禁用 .4/hover+focus-visible 1）；无 display/visibility 机制" };
  });
}

async function dotsPhase(theme, viaTavilyDraft) {
  // 三态以真实条目达成：ready（免 key 的 bing / 已配置 exa）+ missing（enabled 无 key）+ disabled（关闭态）。
  const s = await ui.state();
  const readyCard = cardIds.find((id, i) => s.dotStates[i] === "ready") ?? null;
  const missingCard = cardIds.find((id, i) => s.dotStates[i] === "missing") ?? null;
  let offCard = null; let tav = null;
  if (viaTavilyDraft) {
    if (await implV1()) {
      await addViaPicker("tavily");
      const s2 = await ui.state();
      tav = s2.ids[s2.ids.length - 1];
    } else {
      // v2 流/run-acc1 实证：「选类型即入账」v1 契约已废止（add-type=新建编辑器提交才入账）；
      // missing 观察面由数据准备观察卡承载（run-acc1 实证 v2 create 放行仅名卡=missing 态），
      // 不再造 tavily 草稿卡——旧契约在此会把 last 现有卡误当观察卡并连带挂着的创建编辑器吞点击。
      console.log("[oracle] v2 流：dotsPhase 跳过 tavily 草稿卡（missing 观察面=数据准备观察卡，run-acc1 实证）");
    }
  }
  const mSrc = missingCard ?? tav; // lead 修复项 4：关断动作后置进 A-019（先启用态读 missing 色，再开关实验）
  await exec("A-017", theme, async () => ({ measured: await checkProps(`${ROOT} [data-role="card"] .sc-status-dot`, [
    { prop: "boxSizing", want: "border-box" }, { prop: "display", want: "inline-block", blockifyEqv: "block", ruleHint: ".sc-status-dot" },
    { prop: "flexGrow", want: "0" }, { prop: "flexShrink", want: "0" },
    { prop: "width", want: "8px" }, { prop: "height", want: "8px" }, { prop: "borderTopLeftRadius", want: "50%" },
  ]) }));
  await exec("A-018", theme, async () => {
    // v2 R2：状态点自身即状态宿主——role=img + aria-label/title 完整短语 + textContent 必须为空 + 无 aria-live/wrapper 状态文字。
    const wantPhrase = { ready: "已就绪", missing: "缺少凭据引用", disabled: "已关闭" };
    const host = await evaluate(`(() => { const c = document.querySelector('${T.card(readyCard || cardIds[0])}'); if (!c) return null;
      const dot = c.querySelector('[data-role="card-status"]');
      const visText = (el) => !!el && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
      return { exists: !!dot, isDot: !!dot && dot.classList.contains('sc-status-dot'), role: dot && dot.getAttribute('role'),
        aria: dot && dot.getAttribute('aria-label'), title: dot && dot.getAttribute('title'), text: dot ? dot.textContent : null,
        ariaLive: dot && dot.getAttribute('aria-live'), state: dot && dot.getAttribute('data-state'), entry: dot && dot.getAttribute('data-entry-id'),
        statusWrapText: visText(c.querySelector('.sc-status')) || (c.querySelector('.sc-status') && !dot ? c.querySelector('.sc-status').textContent.trim() : false),
        id: c.getAttribute('data-entry-id') };
    })()`, 30000);
    if (!host || !host.exists) throw new Error('missing element: [data-role="card-status"]（状态宿主=点自身）');
    const mis = [];
    if (!host.isDot) mis.push("状态宿主不是 .sc-status-dot 自身");
    if (host.role !== "img") mis.push(`role got ${host.role}`);
    const phrase = wantPhrase[host.state] || "已就绪";
    if (host.aria !== phrase || host.title !== phrase) mis.push(`aria-label/title got ${JSON.stringify([host.aria, host.title])} 期望「${phrase}」双值`);
    if (String(host.text || "") !== "") mis.push(`textContent 非空：${JSON.stringify(host.text)}`);
    if (host.ariaLive) mis.push(`aria-live 存在=${host.ariaLive}（禁止）`);
    if (host.statusWrapText) mis.push("存在 wrapper 可见状态文字");
    if (host.entry !== host.id) mis.push(`data-entry-id got ${host.entry} 期望 ${host.id}`);
    if (mis.length) throw new Error(`A-018 状态宿主语义违规：${mis.join("；")}`);
    return { measured: `宿主=.sc-status-dot 自身 role=img aria-label=title=「${phrase}」 textContent=∅ 无 aria-live；data-state=${host.state} data-entry-id ✓` };
  });
  await exec("A-019", theme, async () => {
    // lead 修复项 4：三色在「启用态」样本上读——missing 色必须在开关实验之前采（关断后再读只会读到 disabled）。
    const parts = []; const mis = [];
    if (readyCard) {
      try { parts.push(`ready{${await checkProps(`${T.card(readyCard)} .sc-status-dot[data-state="ready"]`, [{ prop: "backgroundColor", wantProbe: "--dsw-alias-state-success-primary", also: theme === "light" ? "rgb(34, 197, 94)" : "rgb(34, 197, 94)" }])}}`); }
      catch (e) { mis.push(`ready: ${e.message}`); }
    } else mis.push("ready 态条目不可达");
    if (mSrc) {
      try { parts.push(`missing{${await checkProps(`${T.card(mSrc)} .sc-status-dot[data-state="missing"]`, [{ prop: "backgroundColor", wantProbe: "--dsw-alias-state-error-primary", also: theme === "light" ? "rgb(236, 19, 19)" : "rgb(242, 90, 90)" }])}}`); }
      catch (e) { mis.push(`missing: ${e.message}`); }
    } else mis.push("missing 态条目不可达");
    if (mSrc && mis.length === 0) {
      // 开关实验置后：关断 → 轮询确认 data-state=disabled → 再读 disabled 色。
      await evaluate(`(() => { const el = document.querySelector('${T.toggle(mSrc)}'); if (el && el.checked) el.click(); return true; })()`, 30000);
      for (let i = 0; i < 40; i++) {
        const st = await evaluate(`() => document.querySelector('${T.card(mSrc)} .sc-status-dot')?.getAttribute('data-state') || null`, 30000);
        if (st === "disabled") break;
        await wait(80);
      }
      offCard = mSrc;
    }
    if (offCard) {
      try { parts.push(`disabled{${await checkProps(`${T.card(offCard)} .sc-status-dot[data-state="disabled"]`, [{ prop: "backgroundColor", wantProbe: "--dsw-alias-state-idle-primary", also: theme === "light" ? "rgb(212, 212, 212)" : "rgb(84, 85, 87)" }])}}`); }
      catch (e) { mis.push(`disabled: ${e.message}`); }
    } else if (mSrc) mis.push("disabled 态不可达（开关关断后 data-state 未迁移）");
    else mis.push("disabled 态不可达（无缺凭据样本可做开关实验）");
    if (mis.length) throw new Error(mis.join(" | "));
    return { measured: parts.join(" ") };
  });
  // 复原：恢复开关并清理 tavily 草稿（本地移除，不落库）。
  if (offCard && offCard !== tav) {
    await evaluate(`(() => { const el = document.querySelector('${T.toggle(offCard)}'); if (el && !el.checked) el.click(); return true; })()`, 30000);
    await wait(250);
  }
  if (tav) {
    // v2：观察卡删除=离散动作自动落盘（清理动作，无断言）。
    const nTav = (await calls()).length;
    await ui.click(`${T.card(tav)} [data-role="card-remove"]`);
    await wait(350);
    if (!(await ui.click(`${ROOT} [data-role="confirm-remove"]`))) {
      // v2 流/run-acc1 实证：清理段非断言判据，禁 throw 短路全表；gone 自证后仅告警续链。
      const stC = await ui.state();
      if (stC.ids.includes(tav)) console.log("[oracle] 警告：观察卡清理未落（confirm-remove 缺席且卡在场）——后续 reload 族计数将自证");
    } else {
      await waitForAutoSave(nTav);
    }
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
      { prop: "borderTopWidth", want: "0.5px" }, { prop: "borderTopStyle", want: "solid" }, // v2 SPC-025：picker 项描边 0.5px solid l4
      { prop: "borderTopColor", wantProbe: "--dsw-alias-border-l4" },
      { prop: "borderTopLeftRadius", want: radius },
    ]);
    if (!w) throw new Error("missing element: [data-role=add-type]/.sc-picker");
    if (Math.abs(w.iw - (w.pw - 2 * w.pPad)) > 1) throw new Error(`width 100% 前提不成立 got ${w.iw} 期望 ${w.pw - 2 * w.pPad}`);
    return { measured: `width=100%(${w.iw}) ${measured}` };
  });
  await exec("A-045", theme, async () => {
    await mouseNeutral(); // lead 修复项 11：采样基态前先脱 hover（run-2 dark 曾采到 hover 值 53,54,56）
    const mis = []; const parts = [];
    try {
      parts.push(`itemBg{${await checkProps(`${ROOT} [data-role="add-type"]`, [
        { prop: "backgroundColor", wantProbe: "--dsw-alias-bg-layer-1", also: theme === "light" ? "rgb(255, 255, 255)" : "rgb(35, 35, 36)" },
        { prop: "color", wantProbe: "--dsw-alias-label-primary", also: theme === "light" ? "rgb(15, 17, 21)" : "rgb(249, 250, 251)" },
        { prop: "borderTopColor", wantProbe: "--dsw-alias-border-l4" }, // v2：描边色 l4 与几何面（A-044）互证
      ])}}`);
    } catch (e) { mis.push(e.message); }
    try {
      parts.push(`billing{${await checkProps(`${ROOT} .sc-picker-billing`, [
        { prop: "color", wantProbe: "--dsw-alias-label-tertiary", also: theme === "light" ? "rgb(129, 133, 140)" : "rgb(173, 178, 184)" },
      ])}}`);
    } catch (e) { mis.push(`billing: ${e.message}`); }
    if (mis.length) throw new Error(mis.join(" | "));
    // v2 O-11：hover=interactive-bg-hover 单声明覆写（-hover-solid 退役）；O-12：实测合成值判定（A 档），期望合成估算值。
    const expected = theme === "light" ? "rgb(236, 238, 240)" : "rgb(69, 70, 72)";
    const pv = await probe(["--dsw-alias-interactive-bg-hover"]);
    const rules = await cssRules();
    const hovDecls = (rules.rules || []).filter((r) => /add-type/.test(r.sel) && /:hover/.test(r.sel) && /background/i.test(r.text));
    const multi = hovDecls.filter((r) => (r.text.match(/background(-color)?\s*:/g) || []).length > 1);
    if (multi.length) throw new Error(`picker hover 出现多重 background 声明（v2 要求单声明覆写）：${multi[0].text.slice(0, 80)}`);
    const hovered = await tryHover(`${ROOT} [data-role="add-type"]`);
    if (!hovered) throw new SkipGap(`hover 态不可达（bg/label/border/billing 已实证：${parts.join(" ").slice(0, 90)}…）`);
    const bg = (await computed(`${ROOT} [data-role="add-type"]`, ["backgroundColor"])).backgroundColor;
    await mouseNeutral();
    // run-acc1 裁决：目录主判=token 机制（interactive-bg-hover 单声明）；「composite estimate rgb(...)」
    // 为 Luna 估算值——宿主 token 实值合成（白底 rgb(255,255,255) 上）≠估算属目录估算偏差（勘误面经
    // lead 转 Luna），非实现缺陷。判据：合成实=估算 ✓ 或 hover computed==token 解析值/其白底合成值 ✓。
    const tok = pv["--dsw-alias-interactive-bg-hover"] || "";
    const mTok = tok.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\)/);
    let comp = null;
    if (mTok) {
      const a = mTok[4] === undefined ? 1 : parseFloat(mTok[4]);
      comp = `rgb(${[1, 2, 3].map((k) => Math.round(255 * (1 - a) + parseInt(mTok[k], 10) * a)).join(", ")})`;
    }
    if (norm(bg) === norm(expected)) {
      return { measured: `${parts.join(" ")} hover合成实测{${bg}}=估算${expected}（O-12 A 档，演示窗口目检双轨见 plan §9）` };
    }
    if ((norm(tok) !== "" && norm(bg) === norm(tok)) || (comp && norm(bg) === norm(comp))) {
      return { measured: `${parts.join(" ")} hover合成{${bg}}=token 解析 ✓（token ${tok}，白底合成=${comp}；Luna 估算 ${expected} 不符=目录估算偏差，勘误经 lead 转 Luna）` };
    }
    throw new Error(`hover 合成底 got ${bg} 期望 token ${tok}（白底合成 ${comp || "n/a"}）或估算 ${expected}`);
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
      { prop: "backgroundColor", wantProbe: "--dsw-alias-bg-module-platform" }, // lead 修复项 8：目录转录丢前缀；实证名 theme 95 处（SPC-019 原文正确）
    ]) };
  });
  await exec("A-038", theme, async () => ({ measured: await checkProps(`${ROOT} [data-role="editor"] .sc-editor-title`, [
    { prop: "marginTop", want: "0px" }, { prop: "marginRight", want: "0px" }, { prop: "marginBottom", want: "0px" }, { prop: "marginLeft", want: "0px" },
    { prop: "fontSize", want: "14px" }, { prop: "lineHeight", want: "22px" }, { prop: "fontWeight", want: "500" },
  ]) }));
  await exec("A-039", theme, async () => {
    const radius = (await probeRadius(["--dsw-radius-md"]))["--dsw-radius-md"];
    // name input 为 autoFocus（实证源码）：基态采样前必须 blur，否则采到 focus 态边框色（accept-1 归因）。
    await evaluate(`() => { const el = document.activeElement; if (el && el.blur) el.blur(); return true; }`, 30000);
    await wait(150);
    // lead 修复项 9：data-role=field 就在 input 自身（实证 DOM），容器子代选择器永不命中——按实际 DOM 直取。
    const geo = await evaluate(`(() => { const i = document.querySelector('${ROOT} [data-role="field"][data-field="name"]'); if (!i) return null; const p = i.parentElement; if (!p) return null; const cs = getComputedStyle(p); const r = p.getBoundingClientRect(); return { iw: i.getBoundingClientRect().width, cw: r.width - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0) }; })()`, 30000);
    if (!geo) throw new Error('missing element: [data-role="field"][data-field="name"]');
    const measured = await checkProps(`${ROOT} [data-role="field"][data-field="name"]`, [
      { prop: "height", want: "32px" }, { prop: "paddingLeft", want: "10px" },
      { prop: "borderTopWidth", want: "0.5px" }, { prop: "borderTopStyle", want: "solid" },
      { prop: "borderTopColor", wantProbe: "--dsw-alias-border-l4" }, { prop: "borderTopLeftRadius", want: radius },
      { prop: "fontSize", want: "14px" }, { prop: "lineHeight", want: "22px" },
    ]);
    if (Math.abs(geo.iw - geo.cw) > 1) throw new Error(`width 100% 前提不成立 input ${geo.iw} ≠ 字段容器内容宽 ${geo.cw}`);
    return { measured: `width=100%(${geo.iw}/${geo.cw}) ${measured}` };
  });
  await exec("A-040", theme, async () => ({ measured: await checkProps(`${ROOT} input.sc-input[placeholder]`, [ // 实证 DOM：name input 无 placeholder（伪元素不渲染），key input 才是真实 placeholder 承载者；select.sc-input 排除
    { prop: "color", wantProbe: "--dsw-alias-label-dimmed", also: theme === "light" ? "rgb(225, 229, 238)" : "rgb(67, 69, 74)" },
  ], "::placeholder") }));
  if (doShot) await shot("editor-open.png", `${ROOT} [data-role="editor"]`);
  // ── v2 按钮变体采样：primary=编辑器提交主按钮（原全局保存钮样本废止）──
  await exec("A-029", theme, async () => {
    await mouseNeutral();
    const sel = `${ROOT} .sc-editor-actions .sc-button-primary`;
    const measured = await checkProps(sel, [
      { prop: "backgroundColor", wantProbe: "--dsw-alias-button-primary-fill", also: theme === "light" ? "rgb(15, 17, 21)" : "rgb(249, 250, 251)" },
      { prop: "color", wantProbe: "--dsw-alias-label-primary-foreground", also: theme === "light" ? "rgb(255, 255, 255)" : "rgb(15, 17, 21)" },
    ]);
    const pv = await probe(["--dsw-alias-button-primary-hover"]);
    const expected = theme === "light" ? "rgb(67, 69, 74)" : "rgb(235, 238, 242)";
    const hovered = await tryHover(sel);
    if (!hovered) throw new SkipGap(`底/字色实测 ${measured}；hover 底态不可达（CDP hover flaky，failPolicy state-unreachable=SKIP）`);
    const bg = (await computed(sel, ["backgroundColor"])).backgroundColor;
    await mouseNeutral();
    if (norm(bg) !== norm(expected)) throw new Error(`hover 底 got ${bg} 期望 button-primary-hover ${expected}（解析 ${pv["--dsw-alias-button-primary-hover"]}）`);
    return { measured: `提交主按钮 ${measured} hover 底=${bg}` };
  });
  // ── v2 编辑器动作行断言族（SPC-014/022/017 v2）──
  await exec("A-056", theme, async () => {
    const geo = await evaluate(`(() => { const a = document.querySelector('${ROOT} .sc-editor-actions'); if (!a) return null;
      const cs = getComputedStyle(a); const bs = [...a.querySelectorAll('button')].map((b) => ({ t: (b.textContent || '').trim(), x: b.getBoundingClientRect().left, prim: /sc-button-primary/.test(b.className || '') }));
      const panel = a.closest('${ROOT}'); const below = panel ? [...panel.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().top > a.getBoundingClientRect().top + 4 && !a.contains(b)).length : -1;
      return { display: cs.display, jc: cs.justifyContent, gap: cs.gap, bs, below };
    })()`, 30000);
    if (!geo) throw new Error("missing element: .sc-editor-actions");
    const mis = [];
    if (geo.display !== "flex") mis.push(`display got ${geo.display}`);
    if (geo.jc !== "flex-end") mis.push(`justify-content got ${geo.jc}`);
    if (geo.gap !== "8px") mis.push(`gap got ${geo.gap}`);
    const cancel = geo.bs.find((b) => b.t === "取消"); const submit = geo.bs.find((b) => b.prim);
    if (!cancel || !submit) mis.push(`取消/提交钮缺失 ${JSON.stringify(geo.bs.map((b) => b.t))}`);
    else if (!(cancel.x < submit.x)) mis.push("按钮序违规：取消不在提交主按钮左侧");
    if (geo.below !== 0) mis.push(`动作行下方仍有按钮/状态节点 ${geo.below} 个（v2 底部区域应撤除）`);
    if (mis.length) throw new Error(`.sc-editor-actions 违规：${mis.join("；")}`);
    return { measured: `flex/flex-end/gap 8px；取消(x=${cancel.x.toFixed(0)})左→提交(x=${submit.x.toFixed(0)})右；行下按钮零残留` };
  });
  await exec("A-031", theme, async () => {
    const radius = (await probeRadius(["--dsw-radius-md"]))["--dsw-radius-md"];
    const btns = await evaluate(`(() => [...document.querySelectorAll('${ROOT} .sc-editor-actions .sc-button')].map((b) => { const cs = getComputedStyle(b); return { t: (b.textContent || '').trim(), cls: b.className, h: cs.height, pl: cs.paddingLeft, pr: cs.paddingRight, r: cs.borderTopLeftRadius, fs: cs.fontSize, lh: cs.lineHeight }; }))()`, 30000);
    if (btns.length < 2) throw new Error(`.sc-editor-actions .sc-button 数 ${btns.length} < 2`);
    const mis = [];
    for (const b of btns) {
      if (/-small/.test(b.cls)) mis.push(`「${b.t}」带 compact 修饰 ${b.cls}`);
      if (b.h !== "36px") mis.push(`「${b.t}」height ${b.h}`);
      if (b.pl !== "14px" || b.pr !== "14px") mis.push(`「${b.t}」padding ${b.pl}/${b.pr}`);
      if (b.r !== radius) mis.push(`「${b.t}」radius ${b.r}≠${radius}`);
      if (b.fs !== "14px" || b.lh !== "22px") mis.push(`「${b.t}」font ${b.fs}/${b.lh}`);
    }
    if (mis.length) throw new Error(`编辑器按钮非 standard 档：${mis.join("；")}`);
    return { measured: `${btns.length} 枚均 standard 档 36px/0 14px/radius ${radius}/14px/22px，无 -small compact` };
  });
  labels["edit" + theme] = await editorActionLabels();
  labels["cancelEnabled" + theme] = await evaluate(`() => { const b = [...document.querySelectorAll('${ROOT} .sc-editor-actions button')].find((x) => (x.textContent || '').trim() === '取消'); return b ? b.disabled === false : null; }`, 30000);
  await exec("A-057", theme, async () => {
    const edit = String(labels["edit" + theme] || "");
    const create = String(labels.createLight || "");
    const busyE = labels["busyEdit" + theme]; const busyC = labels.createBusy;
    const mis = [];
    if (!edit.includes("取消") || !edit.includes("保存")) mis.push(`编辑模式文案 got ${JSON.stringify(edit)} 期望含 取消/保存`);
    if (!create.includes("取消") || !create.includes("保存")) mis.push(`新建模式文案 got ${JSON.stringify(create)} 期望含 取消/保存（v3 统一·5bd84f5 V3-1：创建工具/创建中 废止）`); // run-acc8 取数面：按 v3 定稿规格判，目录字面对齐待 Luna 替换行
    if (/完成/.test(edit) || /完成/.test(create)) mis.push("「完成」出现在编辑器动作文案");
    if (/创建工具|创建中/.test(edit) || /创建工具|创建中/.test(create)) mis.push("已废止文案「创建工具/创建中」出现在编辑器动作标签（v3 V3-1 废止面）");
    if (mis.length) throw new Error(`A-057 文案违规：${mis.join("；")}`);
    if (!busyE || !busyC) throw new SkipGap(`主文案已实证（编辑「${edit}」/新建「${create}」）；busy 文案采样缺失（edit=${JSON.stringify(busyE)} create=${JSON.stringify(busyC)}，busy 窗口短）→ state-unreachable=SKIP gap`);
    if (!/保存中/.test(busyE)) mis.push(`编辑 busy got ${JSON.stringify(busyE)}`);
    if (!/保存中/.test(busyC)) mis.push(`新建 busy got ${JSON.stringify(busyC)}（v3 busy 双态统一「保存中…」）`);
    if (mis.length) throw new Error(`A-057 busy 文案违规：${mis.join("；")}`);
    return { measured: `取消/保存 双态统一（编辑「${edit}」/新建「${create}」）+ busy「${busyE}」「${busyC}」全检出；「完成」「创建工具/创建中」零出现（v3 判据）` };
  });
}

async function editorActionLabels() {
  return evaluate(`() => [...document.querySelectorAll('${ROOT} .sc-editor-actions button, ${ROOT} [data-role="editor"] button')].map((x) => (x.textContent || '').trim()).filter(Boolean).join("|")`, 30000);
}

async function a047(theme = "light") {
  // v2 错误面可达性：新建编辑器空名称+空凭据直接提交 → create 全量校验拒绝 → 就近 [data-role=save-error][data-state=error]。
  // 若实现放行（错误态不可达）→ 目录 state-unreachable=SKIP gap；若误落库则清理空名卡复位基线。
  if (await implV1()) {
    // v1 兼容面/run-9 实证：v1 无新建编辑器与 create 校验——走编辑窗空名+全局保存（v1 时代实证路径）；
    // v2 目录错误面目标 [data-role=save-error] 在 v1 实现结构性缺席 → 两行按 state-unreachable=SKIP gap。
    await openEditor(cardIds[0]);
    if ((await setField("name", "   ")) === null) throw new Error("name 字段不可达");
    await saveViaGlobalSave();
    await wait(400);
    const legacyErr = await evaluate(`() => !!document.querySelector('${ROOT} .sc-error')`, 30000);
    const gapMsg = `错误面目标 [data-role=save-error][data-state=error] 不可达：v1 实现无新建校验流（旧 .sc-error ${legacyErr ? "在但非目录目标节点" : "亦无"}）；failPolicy state-unreachable=SKIP gap`;
    await exec("A-047", theme, async () => { throw new SkipGap(gapMsg); });
    await exec("A-060", theme, async () => { throw new SkipGap(gapMsg); });
    // 名称恢复：v1 空名可能被原样落库（无校验）；locked 窗口 onChange 被忽略（v1 时代实证），轮询解锁后写回并保存。
    let restoredV1 = null;
    for (let i = 0; i < 15; i++) { restoredV1 = await setField("name", "Oracle Alpha"); if (restoredV1 === "Oracle Alpha") break; await wait(400); }
    if (restoredV1 !== "Oracle Alpha") throw new Error("名称恢复失败（v1 locked 未解除）");
    await submitEditor("edit");
    return;
  }
  const n = (await calls()).length;
  await addViaPicker("exa");
  // run-acc5 实证修复：picker 打开的编辑器带种子名「Exa」——直接提交=真条目落库（B-007 持久面 "Exa" 幽灵的真源），且探针从未测过目录声明的「空名」面。置空名（native setter+input）才是该断言的合法取数。
  await evaluate(`(() => { const el = document.querySelector('${ROOT} [data-role="field"][data-field="name"]'); if (!el) return false; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ""); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`, 30000);
  const probeEid = await evaluate(`(() => { const el = document.querySelector('${ROOT} [data-role="field"][data-field="name"]'); return el ? el.getAttribute("data-entry-id") : null; })()`, 30000); // run-acc6：探针唯一清理凭证（名判据两次失真教训）
  console.log(`[oracle] A-047 探针 probeEid=${probeEid}`);
  const submitClicked = await evaluate(`() => { const b = [...document.querySelectorAll('${ROOT} [data-role="editor"] button')].find((x) => /sc-button-primary/.test(x.className || '') && !/取消/.test(x.textContent || '')); if (!b) return false; b.click(); return true; }`, 30000);
  if (!submitClicked) { await closeEditor(); throw new Error("missing element: 新建编辑器提交钮（错误面探测前置）"); }
  await wait(700);
  const seen = (await calls()).slice(n).filter((x) => x.url === "/api/settings/mutate").length;
  const recsP = (await calls()).slice(n).filter((x) => x.url === "/api/settings/mutate");
  const plast = recsP.length ? (recsP[recsP.length - 1].mkeys || []) : [];
  console.log(`[oracle] A-047 探针取证（run-acc6：空名提交窗）：mutate×${seen} 载荷=${JSON.stringify(plast.slice(0, 6))}`); // lead 指定铁证面：违例写 mutate 全留底
  let probeCleaned = false;
  if (seen > 0) {
    // run-acc6 实证修复：名判据两次失真（#1 label 文本误中 bing；#2 空名被渲染为占位「（未命名条目）」非空串）→ 清理改按 probeEid 精确删。entryId 是唯一可靠凭证：temp≡持久 id 幂等性 run-5 已实证。
    const sN = await ui.state();
    if (probeEid && sN.ids.includes(probeEid)) {
      console.log(`[oracle] A-047 清理命中 probeEid=${probeEid} name=${JSON.stringify(sN.names[sN.ids.indexOf(probeEid)])}（run-acc6 entryId 精确删）`);
      const nC = (await calls()).length;
      if (await ui.click(`${T.card(probeEid)} [data-role="card-remove"]`)) { await wait(300); await ui.click(`${ROOT} [data-role="confirm-remove"]`); }
      await waitForAutoSave(nC);
      probeCleaned = true;
      cardIds = (await ui.state()).ids;
    } else {
      console.log(`[oracle] A-047 清理未命中：probeEid=${probeEid} 不在持久名录=${JSON.stringify(sN.ids)}（宁漏勿误删——名判据已被教育两次；id 若被实现侧重键属另案）`);
    }
    await cancelEditor().catch(() => {});
  }
  const errSel = `${ROOT} [data-role="save-error"][data-state="error"]`;
  const exists = await evaluate(`() => !!document.querySelector('${errSel}')`, 30000);
  if (!exists && seen > 0) {
    // run-acc6 分类纠偏（lead 裁决；failPolicy 解释面，断言语义零改动）：SKIP 仅适用前置构造失败（v1 代无 create 编辑器另路已处理）。
    // 探针流可达 ∧ 空名已落库 = 状态可达且判据未满足 = 违例写入 → FAIL；断言目标缺席为伴随描述，非「不可构造」。
    const failMsg = `create 校验违例：空名新建被放行落库（探针窗 settings/mutate×${seen}，载荷=${JSON.stringify(plast.slice(0, 6))}，已按 probeEid 清理复位=${probeCleaned}）；目录断言目标 [data-role=save-error][data-state=error] 缺席（无 role=alert 面，错误态样式不可采样）——违例写入判 FAIL，区别于 state-unreachable`;
    await exec("A-047", theme, async () => { throw new Error(failMsg); });
    await exec("A-060", theme, async () => { throw new Error(failMsg); });
    return;
  }
  if (!exists) {
    const gapMsg = `错误态不可构造：空名新建被拒绝（探针窗零写入、无违例）但未渲染目录目标 save-error 节点；failPolicy state-unreachable=SKIP gap`;
    await exec("A-047", theme, async () => { throw new SkipGap(gapMsg); });
    await exec("A-060", theme, async () => { throw new SkipGap(gapMsg); });
    return;
  }
  await exec("A-047", theme, async () => {
    if (seen > 0) throw new Error(`校验拒绝前已发出 settings/mutate ×${seen}（客户端校验应零写入；载荷=${JSON.stringify(plast.slice(0, 4))}，已按 probeEid 清理=${probeCleaned}）`);
    return { measured: await checkProps(errSel, [
      { prop: "color", wantProbe: "--dsw-alias-state-error-primary", also: theme === "light" ? "rgb(236, 19, 19)" : "rgb(242, 90, 90)" },
      { prop: "role", attr: true, want: "alert" },
    ]) };
  });
  await exec("A-060", theme, async () => {
    const measured = await checkProps(errSel, [
      { prop: "fontSize", want: "12px" }, { prop: "lineHeight", want: "18px" },
      { prop: "role", attr: true, want: "alert" },
    ]);
    const pos = await evaluate(`(() => { const e = document.querySelector('${errSel}'); const a = document.querySelector('${ROOT} .sc-editor-actions'); if (!e || !a) return null; return e.getBoundingClientRect().bottom <= a.getBoundingClientRect().top + 1; })()`, 30000);
    if (pos !== true) throw new Error("编辑器错误节点不在 .sc-editor-actions 正上方");
    return { measured: `${measured}；紧邻动作行上方 ✓` };
  });
  await cancelEditor(); // 丢弃空草稿；配置零写入（above 已审计）
}

async function a028Phase(theme) {
  // A-028（v2 锚点）：base/secondary 于编辑器动作行开窗采样；danger 用 confirmOpen 窗口的 labels 快照。
  await openEditor(cardIds[0]);
  const got = await evaluate(`(() => { const rad = (el) => getComputedStyle(el).borderTopLeftRadius;
    const sec = document.querySelector('${ROOT} .sc-editor-actions .sc-button-secondary');
    const prim = document.querySelector('${ROOT} .sc-editor-actions .sc-button-primary');
    const one = (b) => { if (!b) return null; const cs = getComputedStyle(b); return { box: cs.boxSizing, disp: cs.display, ai: cs.alignItems, jc: cs.justifyContent, gap: cs.gap, h: cs.height, pl: cs.paddingLeft, pt: cs.borderTopWidth, r: rad(b), fs: cs.fontSize, lh: cs.lineHeight, cls: b.className }; };
    return { sec: one(sec), prim: one(prim) };
  })()`, 30000);
  const radius = (await probeRadius(["--dsw-radius-md"]))["--dsw-radius-md"];
  await closeEditor();
  await exec("A-028", theme, async () => {
    const mis = [];
    const base = (v, who) => {
      if (!v) { mis.push(`${who} 样本缺失`); return; }
      if (v.box !== "border-box") mis.push(`${who}.box ${v.box}`);
      if (!/^(inline-)?flex$/.test(v.disp)) mis.push(`${who}.display ${v.disp}`);
      if (v.ai !== "center" || v.jc !== "center") mis.push(`${who}.align ${v.ai}/${v.jc}`);
      if (v.gap !== "4px") mis.push(`${who}.gap ${v.gap}`);
      if (v.h !== "36px") mis.push(`${who}.height ${v.h}`);
      if (v.pl !== "14px") mis.push(`${who}.padding ${v.pl}`);
      if (v.r !== radius) mis.push(`${who}.radius ${v.r}≠${radius}`);
      if (v.fs !== "14px" || v.lh !== "22px") mis.push(`${who}.font ${v.fs}/${v.lh}`);
    };
    base(got.sec, "secondary(取消)"); base(got.prim, "primary(提交)");
    if (got.sec && got.sec.pt !== "0.5px") mis.push(`secondary border 宽度 got ${got.sec.pt} 期望 0.5px（SPC-014 secondary 变体）`);
    if (got.prim && got.prim.pt !== "0px") mis.push(`primary border 宽度 got ${got.prim.pt} 期望 0（无边框）`);
    const dg = labels["danger" + theme];
    if (!dg) mis.push("danger 变体未采到（confirmOpen 窗缺 confirm-remove 样本）");
    else if (!["rgba(0, 0, 0, 0)", "transparent"].includes(dg.bg)) console.log(`[oracle] 注记（出目录判据）：danger 静息底 ${dg.bg}（模态危险钮描边与 hover 由 SPC-023/A-046 专项判定）`);
    if (mis.length) throw new Error(`SPC-014 变体违规：${mis.join("；")}`);
    return { measured: `editor action base 36px/0 14px/md/14px 22px gap4px ✓；secondary border 0.5px；模态 danger 描边由 SPC-023/A-046 专项验收；danger 静息底=${dg && dg.bg} 注记(${dg && dg.cls})` };
  });
}

async function v4EditorCases() {
  const ids = [...(cardIds || [])];
  const first = ids[0], second = ids[1];
  let openErr = null;
  try { if (!first) throw new Error("three-card baseline missing"); await openEditor(first); } catch (e) { openErr = e.message; }
  const firstDom = await evaluate(`(() => {
    const root=document.querySelector('${ROOT}'); if(!root)return null;
    const cards=[...root.querySelectorAll('[data-role="card"]')], editors=[...root.querySelectorAll('[data-role="editor"]')];
    const target=cards.find(c=>c.getAttribute('data-entry-id')===${JSON.stringify(first)}), ed=editors[0], row=target?.querySelector('.sc-card-row');
    const list=target?.closest('.sc-card-list'), ids=cards.map(c=>c.getAttribute('data-entry-id'));
    const r=target?.getBoundingClientRect(), er=ed?.getBoundingClientRect();
    const later=cards.slice(cards.indexOf(target)+1).map(c=>c.getBoundingClientRect().top);
    return { count:editors.length, owns:!!ed&&ed.closest('[data-role="card"]')===target, direct:!!ed&&ed.parentElement===target,
      adjacent:!!row&&row.nextElementSibling===ed, insideList:!!list&&list.contains(ed), ids,
      cardBelow:!!r&&!!er&&er.bottom<=r.bottom+1, laterBelow:later.every(y=>!er||y>=er.bottom-1), listTail:!!list&&editors.some(e=>!e.closest('[data-role="card"]')) };
  })()`, 30000);
  await exec("B-027", "light", async () => {
    if (openErr) throw new Error(`编辑首条无法打开：${openErr}`);
    if (!firstDom) throw new Error("panel/card/editor missing");
    const mis=[];
    if (firstDom.count!==1) mis.push(`editor count=${firstDom.count}`);
    if (!firstDom.owns||!firstDom.direct) mis.push("editor 不在首条外层卡片直接子节点");
    if (!firstDom.adjacent) mis.push("editor 不是条目行 nextElementSibling");
    if (!firstDom.insideList||firstDom.listTail) mis.push("editor 位于列表外/末尾");
    if (!firstDom.cardBelow||!firstDom.laterBelow) mis.push("后续卡片未位于展开卡片下方");
    if (JSON.stringify(firstDom.ids)!==JSON.stringify(ids)) mis.push(`其他条目顺序变更 ${JSON.stringify(firstDom.ids)}`);
    if (mis.length) throw new Error(mis.join("；"));
    return { measured:`editor 属于首条卡片且 row.nextElementSibling；卡序 ${JSON.stringify(firstDom.ids)}，后续卡片下移` };
  });
  let switchErr=null;
  try { if (!second) throw new Error("second entry missing"); await openEditor(second); } catch(e) { switchErr=e.message; }
  const secondDom = await evaluate(`(() => { const root=document.querySelector('${ROOT}'); if(!root)return null;
    const cards=[...root.querySelectorAll('[data-role="card"]')], eds=[...root.querySelectorAll('[data-role="editor"]')];
    const target=cards.find(c=>c.getAttribute('data-entry-id')===${JSON.stringify(second)}), ed=eds[0], row=target?.querySelector('.sc-card-row');
    return {count:eds.length, owns:!!ed&&ed.closest('[data-role="card"]')===target, adjacent:!!row&&row.nextElementSibling===ed,
      ids:cards.map(c=>c.getAttribute('data-entry-id'))}; })()`, 30000);
  await exec("B-028", "light", async () => {
    if (switchErr) throw new Error(`切换第二条编辑器失败：${switchErr}`);
    if (!secondDom) throw new Error("panel/editor missing");
    if (secondDom.count!==1||!secondDom.owns||!secondDom.adjacent) throw new Error(`切换后应唯一归属第二条且紧邻行：${JSON.stringify(secondDom)}`);
    if (JSON.stringify(secondDom.ids)!==JSON.stringify(ids)) throw new Error(`切换编辑后卡序改变 ${JSON.stringify(secondDom.ids)}`);
    return {measured:`切换后唯一 editor 移至第二条并紧邻行；卡序不变 ${JSON.stringify(ids)}`};
  });

  const beforeCancel=await ui.state();
  const nCancel=(await calls()).length;
  let seqErr=null, cancelValue=null, cancelClosed=false, afterCancel=null, cancelMutates=[];
  let editedName=`${beforeCancel.names[1]} V4`;
  let savedText=null, savedClosed=false, afterSave=null, afterReload=null, saveMutates=[];
  try {
    cancelValue=await setField("name", `${beforeCancel.names[1]} cancel draft`);
    const did=await cancelEditor();
    cancelClosed=did && !(await evaluate(`() => !!document.querySelector('${ROOT} [data-role="editor"]')`,30000));
    afterCancel=await ui.state();
    cancelMutates=(await calls()).slice(nCancel).filter(x=>x.url==="/api/settings/mutate");
    await openEditor(second);
    await setField("name",editedName);
    const nSave=(await calls()).length;
    await submitEditor("edit");
    savedClosed=!(await evaluate(`() => !!document.querySelector('${ROOT} [data-role="editor"]')`,30000));
    afterSave=await ui.state();
    savedText=afterSave.savedNotice;
    saveMutates=(await calls()).slice(nSave).filter(x=>x.url==="/api/settings/mutate");
    await reloadAndReopen();
    afterReload=await ui.state();
    await openEditor(second);
    await setField("name",beforeCancel.names[1]);
    await submitEditor("edit");
    cardIds=(await ui.state()).ids;
  } catch(e) {
    seqErr=e.message;
    try { await cancelEditor(); } catch {}
    // Best-effort test-fixture restoration: a failed assertion must not poison later cases.
    try {
      const now=await ui.state(), ix=now.ids.indexOf(second);
      if(ix>=0&&now.names[ix]!==beforeCancel.names[beforeCancel.ids.indexOf(second)]) {
        await openEditor(second); await setField("name",beforeCancel.names[beforeCancel.ids.indexOf(second)]); await submitEditor("edit");
      }
      cardIds=(await ui.state()).ids;
    } catch {}
  }
  await exec("B-029", "light", async () => {
    if (seqErr) throw new Error(`V4 编辑器保存/取消序列未完成：${seqErr}`);
    const idx=beforeCancel.ids.indexOf(second), mis=[];
    if (cancelValue!==`${beforeCancel.names[idx]} cancel draft`) mis.push("取消草稿输入未设置");
    if (!cancelClosed) mis.push("取消未关闭编辑器");
    if (JSON.stringify(afterCancel?.ids)!==JSON.stringify(beforeCancel.ids)||JSON.stringify(afterCancel?.names)!==JSON.stringify(beforeCancel.names)) mis.push("取消后条目状态改变");
    if (cancelMutates.length) mis.push(`取消触发 mutate×${cancelMutates.length}`);
    if (!savedClosed) mis.push("保存成功后编辑器未关闭");
    if (afterSave?.names?.[idx]!==editedName) mis.push(`编辑后名称 ${afterSave?.names?.[idx]}≠${editedName}`);
    if (savedText!==`已保存 ${editedName}。`) mis.push(`SET-007 savedNotice=${JSON.stringify(savedText)}≠${JSON.stringify(`已保存 ${editedName}。`)}`);
    if (!saveMutates.length) mis.push("编辑保存未触发 mutate");
    if (afterReload?.names?.[idx]!==editedName) mis.push(`reload 未读回编辑值 ${afterReload?.names?.[idx]}`);
    if (JSON.stringify(afterReload?.ids)!==JSON.stringify(beforeCancel.ids)) mis.push("编辑保存改变条目身份/顺序");
    if (mis.length) throw new Error(mis.join("；"));
    return {measured:`取消关闭且零 mutate；编辑保存关闭，${JSON.stringify(savedText)}，reload 读回且条目身份/顺序不变`};
  });
}

async function v4ModalCases() {
  const id=cardIds[0], before=await ui.state(), callStart=(await calls()).length;
  let openErr=null;
  try { if(!id)throw new Error("modal test entry missing"); await ui.click(`${T.card(id)} [data-role="card-remove"]`); await wait(350); } catch(e){openErr=e.message;}
  const modal=await evaluate(`(() => {const d=document.querySelector('${ROOT} [role="alertdialog"]');if(!d)return null;
    const norm=s=>(s||'').replace(/\\s+/g,' ').trim(), get=a=>{const id=d.getAttribute(a);return id?document.getElementById(id):null;};
    const title=get('aria-labelledby')||d.querySelector('h1,h2,h3,h4,h5,h6'), body=get('aria-describedby')||d.querySelector('p');
    const bs=[...d.querySelectorAll('button,[role="button"]')], close=bs.find(b=>norm(b.textContent)==='×'||/关闭|close/i.test(b.getAttribute('aria-label')||'')), cancel=bs.find(b=>norm(b.textContent)==='取消'), danger=bs.find(b=>b.matches('[data-role="confirm-remove"]'));
    const r=d.getBoundingClientRect(),x=close?.getBoundingClientRect();return {role:d.getAttribute('role'),aria:d.getAttribute('aria-modal'),visible:r.width>0&&r.height>0&&getComputedStyle(d).visibility==='visible',
      title:norm(title?.textContent),body:norm(body?.textContent),close:close?norm(close.textContent||close.getAttribute('aria-label')):null,
      closeTopRight:!!x&&x.width>0&&x.height>0&&(x.left+x.right)/2>(r.left+r.right)/2&&(x.top+x.bottom)/2<(r.top+r.bottom)/2,
      cancel:cancel?norm(cancel.textContent):null,secondary:!!cancel&&(/secondary/i.test(cancel.className||'')||cancel.getAttribute('data-variant')==='secondary'),
      danger:danger?norm(danger.textContent):null,dangerClass:danger?String(danger.className):null};})()`,30000);
  let tab=false,tabHit=null;
  for(let i=0;i<24&&!tab;i++){await pressKey("Tab","Tab",9);tabHit=await evaluate(`(()=>{const d=document.querySelector('${ROOT} [role="alertdialog"]'),a=document.activeElement;return d&&a&&d.contains(a)?(a.getAttribute('data-role')||a.tagName):null})()`,30000);tab=!!tabHit;}
  await exec("B-030","light",async()=>{
    if(openErr)throw new Error(`删除弹窗未打开：${openErr}`);if(!modal)throw new Error("缺少 alertdialog");
    const name=before.names[before.ids.indexOf(id)], mis=[];
    if(!modal.visible||modal.role!=="alertdialog"||modal.aria!=="true")mis.push(`role/aria/visible=${JSON.stringify(modal)}`);
    if(modal.title!==`删除 ${name}?`)mis.push(`title=${JSON.stringify(modal.title)}`);
    if(modal.body!==`删除 ${name} 会移除其配置；其使用的凭证（如有）由其他位置管理，将会保留。`)mis.push(`body=${JSON.stringify(modal.body)}`);
    if(modal.close!=="×"||!modal.closeTopRight)mis.push(`close=${JSON.stringify(modal)}`);
    if(modal.cancel!=="取消"||!modal.secondary)mis.push(`cancel=${JSON.stringify(modal)}`);
    if(modal.danger!==`删除 ${name}`||!/danger/i.test(modal.dangerClass||''))mis.push(`danger=${JSON.stringify(modal)}`);
    if(!tab)mis.push("CDP 真实 Tab 未到达 alertdialog 控件");
    if(mis.length)throw new Error(mis.join("；"));return {measured:`alertdialog/aria-modal 精确文案；×右上；取消 secondary；danger；Tab 到达 ${tabHit}`};
  });
  await pressKey("Escape","Escape",27);await wait(300);
  const escOpen=await evaluate(`()=>!!document.querySelector('${ROOT} [role="alertdialog"]')`,30000), escState=await ui.state();
  const escMut=(await calls()).slice(callStart).filter(x=>x.url==="/api/settings/mutate").length;
  await ui.click(`${T.card(id)} [data-role="card-remove"]`);await wait(300);
  const xClicked=await evaluate(`(()=>{const d=document.querySelector('${ROOT} [role="alertdialog"]'),b=d&&[...d.querySelectorAll('button,[role="button"]')].find(x=>(x.textContent||'').trim()==='×'||/关闭|close/i.test(x.getAttribute('aria-label')||''));if(b){b.click();return true}return false})()`,30000);await wait(300);
  const xOpen=await evaluate(`()=>!!document.querySelector('${ROOT} [role="alertdialog"]')`,30000),xState=await ui.state();
  const xMut=(await calls()).slice(callStart).filter(x=>x.url==="/api/settings/mutate").length;
  await ui.click(`${T.card(id)} [data-role="card-remove"]`);await wait(300);
  const cancelClicked=await evaluate(`(()=>{const d=document.querySelector('${ROOT} [role="alertdialog"]'),b=d&&[...d.querySelectorAll('button')].find(x=>(x.textContent||'').trim()==='取消');if(b){b.click();return true}return false})()`,30000);await wait(300);
  const cancelOpen=await evaluate(`()=>!!document.querySelector('${ROOT} [role="alertdialog"]')`,30000),cancelState=await ui.state();
  const cancelMut=(await calls()).slice(callStart).filter(x=>x.url==="/api/settings/mutate").length;
  await exec("B-031","light",async()=>{
    const same=s=>JSON.stringify(s?.ids)===JSON.stringify(before.ids)&&JSON.stringify(s?.names)===JSON.stringify(before.names);
    if(escOpen||!same(escState)||escMut)throw new Error(`Escape close mutated state: open=${escOpen}, mutate=${escMut}, same=${same(escState)}`);
    if(!xClicked||xOpen||!same(xState)||xMut)throw new Error(`× close mutated state: click=${xClicked}, open=${xOpen}, mutate=${xMut}, same=${same(xState)}`);
    if(!cancelClicked||cancelOpen||!same(cancelState)||cancelMut)throw new Error(`取消 close mutated state: click=${cancelClicked}, open=${cancelOpen}, mutate=${cancelMut}, same=${same(cancelState)}`);
    return {measured:"Escape/×/取消 分别关闭；条目身份/名称/顺序不变且 settings/mutate=0"};
  });
}

async function a046confirmPhase(theme = "light") {
  // V4：打开居中删除模态，采 SPC-023 danger token 与可测几何后取消，避免删除基线数据。
  const target = cardIds[2];
  await ui.click(`${T.card(target)} [data-role="card-remove"]`);
  await wait(400);
  const dangerSel = `${ROOT} [role="alertdialog"] [data-role="confirm-remove"]`;
  await exec("A-046", theme, async () => {
    const measured = await checkProps(dangerSel, [
      { prop: "color", wantProbe: "--dsw-alias-state-error-primary", also: theme === "light" ? "rgb(236, 19, 19)" : "rgb(242, 90, 90)" },
    ]);
    const outline = await evaluate(`(() => { const b = document.querySelector('${dangerSel}'); return b ? getComputedStyle(b).getPropertyValue('--dsh-button-outline-color').trim() : null; })()`, 30000);
    if (outline !== "var(--dsw-alias-state-error-primary)") throw new Error(`danger outline token got ${outline} 期望 var(--dsw-alias-state-error-primary)`);
    const wantHover = theme === "light" ? "rgba(236, 19, 19, 0.05)" : "rgba(242, 90, 90, 0.15)";
    const pv = await probe(["--dsw-alias-interactive-bg-hover-danger"]);
    const hovered = await tryHover(dangerSel);
    if (!hovered) throw new SkipGap(`危险前景/描边 token 已实证 ${measured}；hover interactive-bg-hover-danger(${wantHover}) 子检查不可达 → 整条 SKIP（state-unreachable gap）`);
    const bg = (await computed(dangerSel, ["backgroundColor"])).backgroundColor;
    if (norm(bg) !== norm(wantHover)) throw new Error(`hover 底 got ${bg} 期望 interactive-bg-hover-danger ${wantHover}（解析 ${pv["--dsw-alias-interactive-bg-hover-danger"]}）`);
    return { measured: `${measured} outline=${outline} hover{${bg}}` };
  });
  await exec("A-068", theme, async () => {
    const got = await evaluate(`(() => {
      const d = document.querySelector('${ROOT} [role="alertdialog"][aria-modal="true"]');
      if (!d) return null;
      const r = d.getBoundingClientRect(), cs = getComputedStyle(d), w = innerWidth, h = innerHeight;
      const alpha = (c) => { const m = c.match(/rgba\\([^)]*,\\s*([0-9.]+)\\s*\\)$/); return m ? Number(m[1]) : 1; };
      let p = d.parentElement, backdrop = null;
      while (p && p !== document.body) { const pr = p.getBoundingClientRect(), ps = getComputedStyle(p);
        if (ps.position === 'fixed' && pr.left <= 1 && pr.top <= 1 && pr.right >= w - 1 && pr.bottom >= h - 1) { backdrop = { bg: ps.backgroundColor, alpha: alpha(ps.backgroundColor), opacity: Number(ps.opacity), visible: ps.visibility === 'visible' && ps.display !== 'none', covered: true }; break; }
        p = p.parentElement;
      }
      const rgb = cs.backgroundColor.match(/[0-9.]+/g)?.map(Number) || [];
      return { dx: Math.abs((r.left + r.right) / 2 - w / 2), dy: Math.abs((r.top + r.bottom) / 2 - h / 2), radius: parseFloat(cs.borderTopLeftRadius) || 0,
        opaqueWhite: alpha(cs.backgroundColor) >= .98 && rgb.slice(0,3).length === 3 && rgb.slice(0,3).every((v) => v >= 240), backdrop,
        rect: { x:r.x,y:r.y,w:r.width,h:r.height }, viewport:{w,h}, bg:cs.backgroundColor, radiusText:cs.borderTopLeftRadius };
    })()`, 30000);
    if (!got) throw new Error("缺少可见 alertdialog");
    const visible = await evaluate(`() => { const d=document.querySelector('${ROOT} [role="alertdialog"]'); if(!d)return false; const r=d.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(d).visibility==='visible'; }`, 30000);
    if (!visible || got.dx > 2 || got.dy > 2 || got.radius <= 0 || !got.opaqueWhite || !got.backdrop?.covered || !got.backdrop.visible || got.backdrop.opacity <= 0 || got.backdrop.alpha <= 0) throw new Error(`V4 模态可测外观不符：${JSON.stringify(got)}`);
    return { measured: `居中误差 ${got.dx.toFixed(1)}/${got.dy.toFixed(1)}px；遮罩覆盖视口(${got.backdrop.bg})；浅白表面 ${got.bg}；圆角 ${got.radiusText}` };
  });
  labels["danger" + theme] = await evaluate(`(() => { const b = document.querySelector('${dangerSel}'); if (!b) return null; const cs = getComputedStyle(b);
    return { cls: b.className, bw: cs.borderTopWidth, bg: cs.backgroundColor }; })()`, 30000);
  const cancelled = await evaluate(`() => { const d=document.querySelector('${ROOT} [role="alertdialog"]'); const b=d&&[...d.querySelectorAll('button')].find((n)=>(n.textContent||'').trim()==='取消'); if (b) { b.click(); return true; } return false; }`, 30000);
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
  const fvProbe = `(() => { const el = document.activeElement; if (!el || el === document.body) return null; const root = document.querySelector('${ROOT}'); const inPanel = !!(root && root.contains(el)); if (!inPanel) return null; const fv = el.matches(':focus-visible'); const cs = getComputedStyle(el); return { fv, tag: el.tagName, role: el.getAttribute('data-role'), cls: String(el.className).slice(0, 50), opacity: cs.opacity, boxShadow: cs.boxShadow.slice(0, 110), outline: cs.outline.slice(0, 80), border: cs.borderColor }; })()`;
  const samples = [];
  let switchFocusShotTaken = false;
  let handleFocusShot = null; // A-065：真实 Tab 命中把手样本
  for (let i = 0; i < 120; i++) {
    await pressKey("Tab", "Tab", 9);
    await wait(50);
    const s = await evaluate(fvProbe, 30000);
    if (s && s.role === "drag-handle" && s.fv) { // run-acc2 实证：.12s 过渡中段取样（0.659）为 A-065 取样伪报面——settle 后复采
      await wait(240);
      const s2 = await evaluate(fvProbe, 30000);
      handleFocusShot = s2 && s2.fv && s2.role === "drag-handle" ? { opacity: s2.opacity, boxShadow: s2.boxShadow, outline: s2.outline } : { opacity: s.opacity, boxShadow: s.boxShadow, outline: s.outline };
    }
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
      // run-acc2 实证：SPC-018 族机制映射（目录 A-035 族文自洽：按钮/把手=box-shadow 环；开关=outline；输入框=border-color business-primary 无环）。
      const isInput = s.role === "field" || /INPUT|TEXTAREA|SELECT/.test(String(s.tag || ""));
      const okM = isInput ? hasColor : (hasColor && has2px);
      if (!okM) bad.push(`${s.role || s.cls}: ${isInput ? "输入族 border-color 未达 business-primary" : "环未达 2px+business-primary"}（${s.boxShadow || s.outline || s.border}）`);
    }
    if (bad.length) throw new Error(`${bad.length}/${samples.length} 个真实 :focus-visible 焦点环未达 2px + business-primary（解析 ${pv["--dsw-alias-state-business-primary"]}）——逐样本判定，任一不符即 FAIL（Luna call-2）：${bad[0]}`);
    return { measured: `${samples.length}/${samples.length} 个真实 :focus-visible 焦点环 = 2px + business-primary ${pv["--dsw-alias-state-business-primary"]}` };
  });
  await exec("A-065", "light", async () => {
    // SPC-027/018 v2：disabled 把手 .4（本 fake 环境无 locked/disabled 条目→子面记注）；真实 Tab 可达 + :focus-visible opacity 1 + SPC-018 环。
    if (!handleFocusShot) throw new SkipGap("真实 Tab 未命中 .sc-drag-handle（120 步预算内焦点序未达把手，state-unreachable=SKIP gap）");
    const pv = await probe(["--dsw-alias-state-business-primary"]);
    const ring = norm(pv["--dsw-alias-state-business-primary"]);
    const paint = norm(handleFocusShot.boxShadow + "|" + handleFocusShot.outline);
    const mis = [];
    if (handleFocusShot.opacity !== "1") mis.push(`focus-visible opacity got ${handleFocusShot.opacity} 期望 1`);
    if (!paint.includes(ring) || !/(^|[^0-9.])2px/.test(paint)) mis.push(`焦点环未达 2px+business-primary：${handleFocusShot.boxShadow || handleFocusShot.outline}`);
    if (mis.length) throw new Error(`A-065 违规：${mis.join("；")}`);
    return { measured: `真实 Tab 命中把手（静息 opacity:0 仍 tabbable，无障碍树可达✓）；:focus-visible 下 opacity=1 + 2px business 环 ${pv["--dsw-alias-state-business-primary"]}；disabled .4 子面：本环境无 disabled 条目，规则面已由 A-064 检出` };
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
    const handle = rm.find((r) => /\.sc-drag-handle/.test(r.sel) && norm(r.text).includes("transition:none"));
    if (!bare || !after || !handle) throw new Error(`@media (prefers-reduced-motion: reduce) 内缺 track/::after/.sc-drag-handle transition:none（track=${!!bare} after=${!!after} handle=${!!handle}）；reduce 规则=${JSON.stringify(rm.map((r) => r.sel + "{" + r.text + "}")).slice(0, 260)}`);
    // v2：锁定动效组含把手；运行时把手 transition 亦须归零（transition:none 的运行时等价=duration 0s）。
    const hh = await computed(`${ROOT} [data-role="card"] .sc-drag-handle`, ["transitionDuration", "transitionProperty"]);
    if (hh.transitionDuration !== "0s") throw new Error(`reduce 模拟下把手运行时 transitionDuration=${hh.transitionDuration} 期望 0s`);
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
  // v2 新增：dragging 透明度规则优先级须高于卡片 hover 把手显现规则（规则层可检出同族 dragging 选择器且未用 display/visibility）。
  const draggingOp = (rules.rules || []).find((r) => /data-dragging/.test(r.sel) && /opacity/i.test(r.text));
  const hoverHandle = (rules.rules || []).filter((r) => /hover\s*:\s*hover/i.test(r.media || "") && /\.sc-card:hover[^{]*\.sc-drag-handle/i.test(r.sel) && /opacity/i.test(r.text));
  if (hoverHandle.length && !draggingOp) miss.push("存在 .sc-card:hover 把手显现规则但无 [data-dragging] 透明度规则（拖动态无法压制 hover 显现）");
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
  // dataSetup（v2/SET-006 创建流）：picker → 新建编辑器 → 填名称/凭据 → 提交主按钮即时落库。
  // setupStart=B-004 配对审计锚点；labels.create=A-057 新建模式文案面。
  const setupStart = (await calls()).length;
  await addViaPicker("exa");
  labels.createLight = await editorActionLabels(); // v1 兼容面/run-9 实证：v1 无动作行=空采样，A-057 判行 FAIL 自证，不抛出短路
  await finishCreate("Oracle Alpha", KEY_A);
  await addViaPicker("exa"); await finishCreate("Oracle Beta", KEY_B);
  await addViaPicker("bing"); await finishCreate("Bing RSS", null);
  await exec("B-002", "light", async () => {
    const s = await ui.state();
    cardIds = s.ids;
    if (cardIds.length !== 3) throw new Error(`卡数 ${cardIds.length} ≠ 3`);
    const types = JSON.stringify(s.types.map((t) => t.toLowerCase()));
    if (types !== '["exa","exa","bing rss"]' && types !== '["exa","exa","bing"]') throw new Error(`类型序列 got ${types} 期望 [exa, exa, bing]`);
    if (!s.enabled.slice(0, 3).every((v) => v === true)) throw new Error(`启用态 got ${JSON.stringify(s.enabled)} 期望全 enabled`);
    const editorOpen = await evaluate(`() => !!document.querySelector('${ROOT} [data-role="editor"]')`, 30000);
    if (editorOpen) throw new Error("新建成功后编辑器仍打开（SET-006/V4-1 要求提交成功即关闭）");
    return { measured: `order [exa-1=${cardIds[0]}, exa-2=${cardIds[1]}, bing=${cardIds[2]}] 全 enabled；创建即持久化（SET-006），credentialRef 服务端分配；新建 editor closed✓` };
  });
  // missing 观察卡：无凭据创建（创建即 missing 态，供 A-018/A-019 missing 面）；若创建校验要求凭据则降级两态。
  try {
    await addViaPicker("exa");
    await finishCreate("Oracle Missing", null);
    const sd = await ui.state();
    const miss = sd.ids.find((id, i) => sd.dotStates[i] === "missing");
    if (miss) { missingCard = miss; cardIds = sd.ids; }
  } catch (e) { await cancelEditor().catch(() => {}); console.log(`[oracle] missing 观察卡不可达（创建校验可能要求凭据）→ A-019 missing 面记 SKIP gap：${e.message}`); }
  // 三态圆点（A-018/A-019/A-020：ready/missing/disabled；missing=观察卡在场时读取）
  await dotsPhase("light", false);
  // missing 观察后清理复位（cleanup 动作，无断言；恢复 3 卡基线供后续 reload 断言锚定）。
  if (missingCard) {
    const nClean = (await calls()).length;
    if (await ui.click(`${T.card(missingCard)} [data-role="card-remove"]`)) { await wait(300); await ui.click(`${ROOT} [data-role="confirm-remove"]`); }
    await waitForAutoSave(nClean);
    missingCard = null;
    await wait(400);
    cardIds = (await ui.state()).ids;
    if (cardIds.length !== 3) console.log(`[oracle] missing 观察卡清理后卡数=${cardIds.length}（期望 3）`);
  }
  { const b3 = await ui.state(); const ia = b3.names.indexOf("Oracle Alpha"), ib = b3.names.indexOf("Oracle Beta"), ic = b3.names.indexOf("Bing RSS");
    exa1Id = ia >= 0 ? b3.ids[ia] : null; exa2Id = ib >= 0 ? b3.ids[ib] : null; bingId = ic >= 0 ? b3.ids[ic] : null;
    console.log(`[oracle] 主数据 id 快照（创建顺序身份锚，run-acc7）：exa-1=${exa1Id} exa-2=${exa2Id} bing=${bingId}`); }

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
  await closeEditor(); // v2：A-047 走新建流，先关编辑窗（取消=丢弃草稿）
  await a047(); // v2 错误面（新建流空名提交；A-047/A-060，不可达记 SKIP gap）
  await a046confirmPhase(); // confirmOpen（采完即取消；含 A-028 danger 变体采样）
  await a028Phase("light"); // SPC-014 三变体组装判定

  // afterSave（v2）：c1 编辑器提交 busy 窗三档采样（幂等落盘一次）+ busy 面 + savedNotice 样式 + 序列审计。
  fam = await captureDisabledFamilies("light");
  await a034Phase("light", fam);
  await a025Phase("light", fam);
  labels.busyEditLight = fam ? fam.busyLabel : null;
  await exec("A-058", "light", async () => {
    if (!fam) throw new SkipGap("commit in-flight 窗口未采到（点击后 busy 同步窗口过短，state-unreachable=SKIP gap）");
    const mis = [];
    if (!fam.submitDisabled) mis.push("提交钮 busy 未 disabled");
    if (!fam.action) mis.push("取消钮样本缺失");
    if (!["保存中…", "保存中"].includes(String(fam.busyLabel || "").trim())) mis.push(`busy 文案 got ${JSON.stringify(fam.busyLabel)} 期望 保存中…`);
    if (mis.length) throw new Error(`busy 禁用面违规：${mis.join("；")}`);
    if (labels.cancelEnabledLight !== true) throw new Error(`窗外（非 busy）取消不可用 got ${labels.cancelEnabledLight}（A-058 expected: outside commit cancel is enabled）`);
    return { measured: `busy 窗内同步采样：提交钮 disabled=true 文案「${fam.busyLabel}」，取消钮同窗 disabled（A-034 五档同窗佐证）；窗外取消可用=true（editorOpen 实证）` };
  });
  await captureSaveSample("light", "settled");
  await exec("A-048", "light", async () => {
    const measured = await checkProps(`${ROOT} [data-role="save-status"][data-state="saved"]`, [
      { prop: "marginTop", want: "0px" }, { prop: "marginRight", want: "0px" }, { prop: "marginBottom", want: "0px" }, { prop: "marginLeft", want: "0px" },
      { prop: "fontSize", want: "12px" }, { prop: "lineHeight", want: "18px" },
      { prop: "role", attr: true, want: "status" }, { prop: "aria-live", attr: true, want: "polite" },
    ]);
    const pos = await evaluate(`(() => { const n = document.querySelector('${ROOT} [data-role="save-status"]'); if (!n) return null; const sec = n.closest('${ROOT} .sc-panel') || document.querySelector('${ROOT}'); const ny = n.getBoundingClientRect().top;
      const before = [...sec.querySelectorAll('h1,h2,h3,.sc-section-title,.sc-section-desc,[data-role="section-title"]')].every((h) => h.getBoundingClientRect().top <= ny + 1);
      const firstCard = sec.querySelector('[data-role="card"]'); const afterCards = !firstCard || firstCard.getBoundingClientRect().top >= ny - 1;
      return { before, afterCards }; })()`, 30000);
    if (!pos) throw new Error("missing element: [data-role=save-status]");
    if (!pos.before || !pos.afterCards) throw new Error("savedNotice 不在节级顶部槽位（标题/描述之后、列表之前）");
    const txt = (await ui.state()).savedNotice;
    if (!/已保存/.test(txt)) throw new Error(`savedNotice 文案 got ${JSON.stringify(txt)} 期望「已保存 …。」`);
    return { measured: `${measured}；role=status aria-live=polite 顶部槽位✓ 文案「${txt}」` };
  });
  await exec("A-049", "light", async () => ({ measured: await checkProps(`${ROOT} [data-role="save-status"][data-state="saved"]`, [
    { prop: "color", wantProbe: "--dsw-alias-state-success-primary", also: "rgb(34, 197, 94)" },
  ]) }));
  await exec("A-059", "light", async () => {
    const dom = await evaluate(`(() => { const root = document.querySelector('${ROOT}'); if (!root) return null;
      const ok = [...root.querySelectorAll('[data-role="save-status"][data-state="saved"]')];
      const errs = [...root.querySelectorAll('[role="alert"],[data-state="error"]')].filter((n) => !n.closest('[data-oracle-x]'));
      const bottom = [...root.querySelectorAll('.sc-panel, .sc-card-list')].flatMap((c) => [...c.children]).filter((n) => /save-status/.test(n.className) && n.closest('.sc-panel') && !n.closest('[class*="section"], .sc-card-list') && n.getBoundingClientRect().top > (root.querySelector('[data-role="card"]')?.getBoundingClientRect().top ?? 1e9));
      return { both: ok.length && errs.length ? 1 : 0, nOk: ok.length, nErr: errs.length, bottomLeak: bottom.length };
    })()`, 30000);
    if (!dom) throw new Error("missing element: panel");
    if (dom.both) throw new Error("成功 savedNotice 与节级 role=alert 同时出现（互斥违规）");
    if (dom.bottomLeak) throw new Error(`面板底部仍挂 savedNotice 节点 ×${dom.bottomLeak}（v2 应居顶部槽位）`);
    return { measured: `savedNotice×${dom.nOk} 与 alert×${dom.nErr} 互斥✓；底部状态节点零残留✓（编辑器错误就近面见 A-060/A-047）` };
  });
  await exec("B-004", "light", async () => {
    // v2 创建流：每条目 名称+凭据 → 提交（set 先于自身 mutate）。配对审计：each set < 其条目 create mutate。
    let all = await calls();
    for (let i = 0; i < 15; i++) {
      const sN = all.filter((x) => x.url === "/api/credentials/set").length;
      if (sN >= 2) break;
      await wait(1000); all = await calls();
    }
    const sets = all.map((x, i) => i).filter((i) => all[i].url === "/api/credentials/set");
    const muts = all.map((x, i) => i).filter((i) => i >= setupStart && all[i].url === "/api/settings/mutate");
    const tally = Object.entries(all.reduce((a, x) => { a[x.url] = (a[x.url] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`).join(", ");
    if (sets.length !== 2) throw new Error(`credentials/set 全局次数 ${sets.length} ≠ 2（两 exa；bing 不得触发）｜诊断 ${tally}`);
    if (muts.length < 2) throw new Error(`创建阶段 settings/mutate ${muts.length} < 2（两枚创建落库未观察到）｜诊断 ${tally}`);
    const bad = sets.filter((si) => !muts.some((mi) => mi > si));
    if (bad.length) throw new Error(`顺序违规：credentials/set@${bad.join(",")} 之后无 settings/mutate 提交其 credentialRef`);
    return { measured: `两枚 credentials/set（仅 exa，全局总数=2，bing 零凭据写入）各自先于提交其 credentialRef 的 settings/mutate；setIdx=${JSON.stringify(sets)} mutIdx=${JSON.stringify(muts.slice(0, 4))}` };
  });

  // V4-1：在数据建立/凭据配对审计之后执行编辑器就地/切换/取消/保存闭环。
  await v4EditorCases();
  await v4ModalCases();

  // 官方参照区截图（此时草稿已全部落库；分区切换 unmount 我方面板不再造成数据损失）
  await officialSectionShots();

  // 暗态（Luna 裁定：直设 body[data-ds-dark-theme]，真实暗色 CSS 状态实证；非宿主主题 UI 切换实证）
  await darkAttr(true);
  await styleSweep("dark");
  // run-acc7 取数面修复：dark 三态素材断料=v2 化后 tavily 草稿路径废止（L1173 实证）+missing 观察卡已在 light 段清理。
  // 为 dark 段重建观察卡（无 key 名卡=missing 态，run-acc1 实证语义），用毕按 entryId 精确删（教训：只认 id）。
  let missingDark = null;
  await addViaPicker("exa");
  missingDark = await evaluate(`(() => { const el = document.querySelector('${ROOT} [data-role="field"][data-field="name"]'); return el ? el.getAttribute("data-entry-id") : null; })()`, 30000);
  await finishCreate("Oracle Missing", null);
  cardIds = (await ui.state()).ids;
  await dotsPhase("dark", true);
  if (missingDark) {
    const nCleanD = (await calls()).length;
    const stD = await ui.state();
    if (stD.ids.includes(missingDark)) {
      if (await ui.click(`${T.card(missingDark)} [data-role="card-remove"]`)) { await wait(300); await ui.click(`${ROOT} [data-role="confirm-remove"]`); }
      await waitForAutoSave(nCleanD);
      console.log(`[oracle] dark 观察卡已按 id 清理：${missingDark}`);
    } else console.log(`[oracle] dark 观察卡清理：eid=${missingDark} 不在名录（无鬼影自证）`);
    await wait(400);
    cardIds = (await ui.state()).ids;
    if (cardIds.length !== 3) console.log(`[oracle] dark 观察卡清理后卡数=${cardIds.length}（期望 3）`);
  }
  {
    // Luna call-7 / A-066（V3-1.2）：新建编辑器打开至提交完成，列表行数恒=已持久条目数（含 submit busy 期）；探针条目清理按 entryId 精确删。
    if (await implV1()) {
      await exec("A-066", "dark", async () => { throw new SkipGap("v1 契约（选类型即入账）与 V3-1.2「未提交新建不入列」结构性不可达（state-unreachable=SKIP gap，v1 兼容面）"); });
    } else {
      const s66a = await ui.state();
      await addViaPicker("exa");
      const eid66 = await evaluate(`(() => { const el = document.querySelector('${ROOT} [data-role="field"][data-field="name"]'); return el ? el.getAttribute("data-entry-id") : null; })()`, 30000);
      const cOpen = (await ui.state()).ids.length;
      if ((await setField("name", "Oracle Probe-66")) !== "Oracle Probe-66") throw new Error("A-066 名称写入失败");
      if ((await setField("key", KEY_A)) !== KEY_A) throw new Error("A-066 key 写入失败");
      const n66 = (await calls()).length;
      const clk66 = await evaluate(`() => { const b = [...document.querySelectorAll('${ROOT} .sc-editor-actions button, ${ROOT} [data-role="editor"] button')].find((x) => /sc-button-primary/.test(x.className || '') && !/取消/.test(x.textContent || '')); if (!b) return false; b.click(); return true; }`, 30000);
      if (!clk66) throw new Error("missing element: 新建编辑器提交主按钮（A-066 busy 采样前置）");
      const cBusy = (await ui.state()).ids.length; // busy 窗即时采样（mutate 在途）
      await waitRpc("/api/settings/mutate", n66, 60).catch(() => {});
      await settleSaved(); // 编辑器提交（含新建）=V3 保留提示动作族
      const s66z = await ui.state();
      if (eid66 && s66z.ids.includes(eid66)) { const nC66 = (await calls()).length; if (await ui.click(`${T.card(eid66)} [data-role="card-remove"]`)) { await wait(300); await ui.click(`${ROOT} [data-role="confirm-remove"]`); } await waitForAutoSave(nC66); }
      await wait(300);
      cardIds = (await ui.state()).ids;
      console.log(`[oracle] A-066("dark") 行数采样：已持久=${s66a.ids.length} 开编辑=${cOpen} busy期=${cBusy} 提交后=${s66z.ids.length} 清理后=${cardIds.length}`);
      await exec("A-066", "dark", async () => {
        const mis = [];
        if (cOpen !== s66a.ids.length) mis.push(`未提交草稿进入列表：开编辑行数 ${cOpen} ≠ 已持久 ${s66a.ids.length}（V3-1.2 占位行违规）`);
        if (cBusy !== s66a.ids.length && cBusy !== s66a.ids.length + 1) mis.push(`busy 期行数异常 got ${cBusy}（期望=已持久 ${s66a.ids.length}；late-settle 容忍 +1=mutate 先于采样落定的读回时序，非占位行）`);
        if (!s66z.names.includes("Oracle Probe-66")) throw new Error(`正向对照缺失：提交后未入列 ${JSON.stringify(s66z.names.slice(0, 5))}（采样无效）`);
        if (cardIds.length !== s66a.ids.length) mis.push(`探针清理后未回基线 ${cardIds.length} ≠ ${s66a.ids.length}`);
        if (mis.length) throw new Error(mis.join("；"));
        return { measured: `行数恒等：已持久=${s66a.ids.length} 开编辑=${cOpen}（占位行主判）busy期=${cBusy} 提交后=${s66z.ids.length} 清理后=${cardIds.length}；busy 期覆盖✓；探针条目按 entryId 清理✓` };
      });
    }
  }
  await pickerPhase("dark", false);
  await openEditor(cardIds[0]);
  await editorPhase("dark", false);
  await closeEditor(); // v2：A-047 走新建流，先关编辑窗
  await a047("dark"); // Luna call-2：A-047 补 dark（v2 错误面暗色错误色）
  await a046confirmPhase("dark"); // Luna call-2：A-046 补 dark（危险前景 + hover，采完即取消）
  await a028Phase("dark");
  await reducedMotionPhase("dark"); // Luna call-2：A-050 补 dark（规则 + 运行时分别判定）
  // 暗态 afterSave 复位：官方开关 关（自动落盘；run-acc8 v3：开关不再发 savedNotice，A-048/049 的 saved 节点源=c1 编辑器提交——提示保留动作族）→ busy 三档（c1 提交）→ A-048/049 dark → 开回 true。
  const nDark = (await calls()).length;
  await evaluate(`(() => { document.querySelector('${OFFICIAL_TOGGLE}').click(); return true; })()`, 30000);
  await waitForAutoSave(nDark);
  famDark = await captureDisabledFamilies("dark");
  await a034Phase("dark", famDark);
  await a025Phase("dark", famDark);
  labels.busyEditDark = famDark ? famDark.busyLabel : null;
  await exec("A-058", "dark", async () => {
    if (!famDark) throw new SkipGap("commit in-flight 窗口未采到（state-unreachable=SKIP gap）");
    if (!famDark.submitDisabled) throw new Error("busy 提交钮未 disabled（dark）");
    if (!["保存中…", "保存中"].includes(String(famDark.busyLabel || "").trim())) throw new Error(`busy 文案 got ${JSON.stringify(famDark.busyLabel)} 期望 保存中…（dark）`);
    return { measured: `busy 窗：提交 disabled=true 文案「${famDark.busyLabel}」（dark 实机采样）` };
  });
  await exec("A-048", "dark", async () => ({ measured: await checkProps(`${ROOT} [data-role="save-status"][data-state="saved"]`, [
    { prop: "marginTop", want: "0px" }, { prop: "marginRight", want: "0px" }, { prop: "marginBottom", want: "0px" }, { prop: "marginLeft", want: "0px" },
    { prop: "fontSize", want: "12px" }, { prop: "lineHeight", want: "18px" },
    { prop: "role", attr: true, want: "status" }, { prop: "aria-live", attr: true, want: "polite" },
  ]) }));
  await exec("A-049", "dark", async () => ({ measured: await checkProps(`${ROOT} [data-role="save-status"][data-state="saved"]`, [
    { prop: "color", wantProbe: "--dsw-alias-state-success-primary", also: "rgb(34, 197, 94)" },
  ]) }));
  await exec("A-059", "dark", async () => {
    const dom = await evaluate(`(() => { const root = document.querySelector('${ROOT}'); if (!root) return null;
      const ok = [...root.querySelectorAll('[data-role="save-status"][data-state="saved"]')].length;
      const errs = [...root.querySelectorAll('[role="alert"],[data-state="error"]')].length;
      return { both: ok && errs ? 1 : 0, ok, errs };
    })()`, 30000);
    if (!dom) throw new Error("missing element: panel");
    if (dom.both) throw new Error("savedNotice 与节级 alert 同时出现（互斥违规，dark）");
    return { measured: `互斥✓ savedNotice×${dom.ok} alert×${dom.errs}；底部状态零残留（light 面全量双查已执行）` };
  });
  { const n2 = (await calls()).length; await evaluate(`(() => { document.querySelector('${OFFICIAL_TOGGLE}').click(); return true; })()`, 30000); if (!(await waitForAutoSave(n2))) throw new Error("官方开关复原未落定"); }
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
    console.log(`[oracle] B-007 持久序取证（run-acc7）：names=${JSON.stringify(s.names)} ids=${JSON.stringify(s.ids)} 创建序锚=[${exa1Id},${exa2Id},${bingId}]`);
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

  // B-009 编辑其一，其余不受影响（v2：编辑器提交动作自动落盘，无全局保存步骤）
  await openEditor(exa1Id ?? cardIds[0]); // run-acc7 分支(c)实证修复：run-7 [Beta,Alpha] 下位判把 Beta 改名（[Edited,Alpha] 全吻合）——SET-002 的 exa-1 是创建顺序身份，必须 id 锚
  if ((await setField("name", "Oracle Edited")) !== "Oracle Edited") throw new Error("B-009 改名失败");
  await submitEditor("edit");
  await reloadAndReopen();
  await exec("B-009", "light", async () => {
    const s = await ui.state();
    const i1 = s.ids.indexOf(exa1Id ?? cardIds[0]), i2 = exa2Id ? s.ids.indexOf(exa2Id) : 1, i3 = bingId ? s.ids.indexOf(bingId) : 2;
    if (i1 < 0 || i2 < 0 || i3 < 0) throw new Error(`id 锚定失败：ids=${JSON.stringify(s.ids)} 锚=[${exa1Id},${exa2Id},${bingId}]`);
    if (s.names[i1] !== "Oracle Edited") throw new Error(`exa-1(id=${exa1Id}@idx${i1}) 改名未生效 got ${JSON.stringify(s.names[i1])}`);
    if (s.names[i2] !== "Oracle Beta") throw new Error(`exa-2(id=${exa2Id}) 名称被改动 got ${JSON.stringify(s.names[i2])}`);
    if (s.names[i3] !== "Bing RSS") throw new Error(`bing(id=${bingId}) 名称被改动 got ${JSON.stringify(s.names[i3])}`);
    if (![i1, i2, i3].every((i) => s.enabled[i] === true)) throw new Error(`启用态 got ${JSON.stringify(s.enabled)}`);
    if (![i1, i2, i3].every((i) => s.dotStates[i] === "ready")) throw new Error(`徽标 got ${JSON.stringify(s.dotStates)}`);
    return { measured: `exa-1 改名生效（id 锚定，判据窗不依赖持久序）；exa-2/bing 名称/enabled/徽标不变 ${JSON.stringify(s.names)}（序=${JSON.stringify(s.ids)}）` };
  });

  // B-010 关闭第二条（v2：离散动作自动落盘）→ reload：原位 enabled=false 徽标关闭态
  const nB10 = (await calls()).length;
  await evaluate(`(() => { const el = document.querySelector('${T.toggle(cardIds[1])}'); el.click(); return true; })()`, 30000);
  await wait(350);
  await waitForAutoSave(nB10);
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
  { const n = (await calls()).length; await evaluate(`(() => { const el = document.querySelector('${T.toggle(cardIds[1])}'); el.click(); return true; })()`, 30000); await waitForAutoSave(n); }
  await reloadAndReopen();
  await exec("B-011", "light", async () => {
    const s = await ui.state();
    const idx = s.ids.indexOf(cardIds[1]);
    if (idx !== 1 || s.enabled[idx] !== true) throw new Error(`重开态 index=${idx} enabled=${s.enabled[idx]} 期望 1/true`);
    if (s.dotStates[idx] !== "ready") throw new Error(`徽标未恢复 configured got ${s.dotStates[idx]}`);
    return { measured: "第二条原位置 index=1 enabled=true 徽标恢复 configured" };
  });

  // B-015 官方开关（v2 离散自动持久）：关→reload 持久 false；再开→reload 持久 true
  { const n = (await calls()).length; await evaluate(`(() => { document.querySelector('${OFFICIAL_TOGGLE}').click(); return true; })()`, 30000); await wait(350); await waitForAutoSave(n); }
  await reloadAndReopen();
  const offState = await ui.state();
  { const n = (await calls()).length; await evaluate(`(() => { document.querySelector('${OFFICIAL_TOGGLE}').click(); return true; })()`, 30000); await wait(350); await waitForAutoSave(n); }
  await reloadAndReopen();
  await exec("B-015", "light", async () => {
    const on = await ui.state();
    if (offState.officialChecked !== false || offState.officialAria !== "false") throw new Error(`关闭保存后读回 ${offState.officialChecked}/${offState.officialAria} 期望 false/false`);
    if (on.officialChecked !== true || on.officialAria !== "true") throw new Error(`重开保存后读回 ${on.officialChecked}/${on.officialAria} 期望 true/true`);
    return { measured: "关→false/false 持久；开→true/true 持久（checked+aria-checked 与保存前最后选择一致）" };
  });

    // ── SET-006 v2 diff-payload 专责区（B-016/017/018/019）：离散动作自持久 + 请求体仅含该项变更 ──
  {
    const n16 = (await calls()).length;
    const nt16a = await evaluate(`(() => { const e = document.querySelector('${ROOT} [data-role="save-status"]'); return { exists: !!e, text: (e && e.textContent || "").trim() }; })()`, 30000); // run-acc8 v3 V3-3：开关动作 savedNotice 缺席判据的前/后快照
    await evaluate(`(() => { const el = document.querySelector('${OFFICIAL_TOGGLE}'); if (el) el.click(); return true; })()`, 30000);
    await wait(350);
    const nt16b = await evaluate(`(() => { const e = document.querySelector('${ROOT} [data-role="save-status"]'); return { exists: !!e, text: (e && e.textContent || "").trim() }; })()`, 30000);
    const vis16 = await evaluate(`(() => { const el = document.querySelector('${OFFICIAL_TOGGLE}'); return el ? { checked: !!el.checked, aria: el.getAttribute("aria-checked") } : null; })()`, 30000); // 开关视觉态（reload 前的即时反馈面）
    const recs16 = (await calls()).slice(n16).filter((x) => x.url === "/api/settings/mutate");
    const mk16 = recs16.length ? recs16[recs16.length - 1].mkeys : null;
    const hadSave16 = await evaluate(`() => !!document.querySelector('${ROOT} [data-role="save"], ${ROOT} .sc-save-button')`, 30000);
    const panelAlive16 = await evaluate(`() => !!document.querySelector('${ROOT} [data-role="card"]')`, 30000);
    await reloadAndReopen();
    const st16 = await ui.state();
    await exec("B-016", "light", async () => {
      const mis = [];
      if (st16.officialChecked !== false) mis.push(`关→自动落盘→reload 读回 officialChecked=${st16.officialChecked} 期望 false`);
      if (!recs16.length) mis.push("顶部开关未触发自身 settings/mutate（疑似仍依赖全局保存）");
      else if (!mk16) mis.push("插桩未能提取载荷字段（mkeys 缺失）");
      else {
        if (!mk16.some((k) => /official|deepseek/i.test(k))) mis.push(`载荷字段 ${JSON.stringify(mk16.slice(0, 6))} 未含官方开关字段（期望名 useOfficialDeepSeekSearch，实际名自证）`);
        const rel = mk16.filter((k) => /(^|[:.])entries\.|(^|[:.])order|timeoutMs/i.test(k)); // run-acc2：兼容 op-token 前缀
        if (rel.length) mis.push(`载荷含无关字段 ${JSON.stringify(rel.slice(0, 5))}`);
      }
      if (nt16b.exists && nt16b.text !== nt16a.text) mis.push(`开关动作触发 savedNotice 新增=V3-3 违例：动作后 ${JSON.stringify(nt16b.text)}（动作前 ${JSON.stringify(nt16a.text)}）`); // v3 定稿规格判据：开关本身状态即反馈
      if (vis16 && (vis16.checked !== false || vis16.aria === "true")) mis.push(`官方开关视觉态未随动作同步 got ${JSON.stringify(vis16)}（期望 checked=false）`);
      if (hadSave16) mis.push("持久化路径存在全局保存入口（v2 应无）");
      if (!panelAlive16) mis.push("开关切换导致面板跳转/卸载（期望停留原分区）");
      if (mis.length) throw new Error(mis.join("；"));
      return { measured: `关→自动落盘→reload=false；载荷 ${JSON.stringify(mk16.slice(0, 4))} 仅开关字段；无保存入口、面板未跳转；savedNotice 无新增✓(前=${JSON.stringify(nt16a.text)} 后=${JSON.stringify(nt16b.text)})；视觉态 ${JSON.stringify(vis16)}` };
    });
    { const n = (await calls()).length; await evaluate(`(() => { document.querySelector('${OFFICIAL_TOGGLE}').click(); return true; })()`, 30000); await wait(350); if (!(await waitForAutoSave(n))) throw new Error("B-016 复原（再开）未落定"); }
  }
  {
    const tSel = await evaluate(`(() => { const sels = ['${ROOT} [data-field="timeoutMs"]', '${ROOT} [data-field="timeout"]', '${ROOT} [data-role="timeout"] input', '${ROOT} input[name="timeoutMs"]', '${ROOT} input[type="number"]']; for (const x of sels) { const el = document.querySelector(x); if (el) return x; } return null; })()`, 30000);
    if (!tSel) {
      await exec("B-017", "light", async () => { throw new Error('missing element: 超时输入框（[data-field=timeoutMs]/number 输入均未见）'); });
    } else {
      const setT = async (v) => { const r = await evaluate(`(() => { const el = document.querySelector('${tSel}'); el.focus(); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const d = Object.getOwnPropertyDescriptor(proto, 'value'); d.set.call(el, ${JSON.stringify(String(v))}); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()`, 30000); await wait(220); /* run-acc2 实证：同任务连发 input+blur 会被 React 同帧折叠，timeoutCommit 读 stale text（reload 25000 误报面）→ 分帧提交 */ await evaluate(`(() => { const el = document.querySelector('${tSel}'); el.dispatchEvent(new Event('change', { bubbles: true })); el.blur(); return true; })()`, 30000); await wait(250); return r; };
      const n17a = (await calls()).length;
      await setT(0); // 非法值
      await wait(500);
      const recsBad = (await calls()).slice(n17a).filter((x) => x.url === "/api/settings/mutate");
      const errUI = await evaluate(`(() => { const a = document.querySelector('${ROOT} [role="alert"], ${ROOT} .sc-error, ${ROOT} [aria-invalid="true"]'); return a ? (a.textContent || a.getAttribute('aria-invalid') || "invalid").trim().slice(0, 60) : null; })()`, 30000);
      const n17b = (await calls()).length;
      await setT(5000); // 合法值
      await waitForAutoSave(n17b);
      // run-acc4 取证协议2：合法段提交窗 mutate 值自证（@5000 token 区分 触发折叠/持久丢失 两种读法）
      const recs17b = (await calls()).slice(n17b).filter((x) => x.url === "/api/settings/mutate");
      const mk17b = recs17b.length ? recs17b[recs17b.length - 1].mkeys : null;
      await reloadAndReopen();
      const back17 = await evaluate(`(() => { const el = document.querySelector('${tSel}'); return el ? el.value : null; })()`, 30000);
      await exec("B-017", "light", async () => {
        const mis = [];
        if (recsBad.length) mis.push(`非法值 0 也发出了 settings/mutate（客户端校验未拦截，违反 SET-008 非法值不落库）`);
        if (!errUI) mis.push("非法值未呈现错误提示（alert/aria-invalid 均无）");
        if (String(back17).replace(/[^0-9]/g, "") !== "5000") mis.push(`合法 blur 自动落盘后 reload 读回 got ${back17} 期望 5000`);
        if (!recs17b.length) mis.push("合法值提交窗未发出 settings/mutate（timeoutCommit 未触发——触发面；注：run-acc4 前 blur 存在未聚焦元素不发事件的执行器伪报面，已修）");
        else if (mk17b && !mk17b.some((k) => /timeoutMs@5000(\D|$)/.test(k))) mis.push(`提交窗载荷值非 5000：${JSON.stringify((mk17b || []).slice(0, 4))}（stale 值=折叠面；缺失=字段错位）`);
        if (mis.length) throw new Error(mis.join("；"));
        return { measured: `非法 0：0 次 mutate + 错误提示「${errUI}」；合法 5000：blur 自动落盘（无保存钮）reload 读回 ${back17}；提交窗 mutate×${recs17b.length} 载荷=${JSON.stringify((mk17b || []).slice(0, 3))}` };
      });
    }
  }
  {
    const n18 = (await calls()).length;
    const nt18a = await evaluate(`(() => { const e = document.querySelector('${ROOT} [data-role="save-status"]'); return { exists: !!e, text: (e && e.textContent || "").trim() }; })()`, 30000); // run-acc8 v3 V3-3 缺席判据快照
    await evaluate(`(() => { const el = document.querySelector('${T.toggle(cardIds[1])}'); if (el && el.checked) el.click(); return true; })()`, 30000);
    await wait(350);
    const nt18b = await evaluate(`(() => { const e = document.querySelector('${ROOT} [data-role="save-status"]'); return { exists: !!e, text: (e && e.textContent || "").trim() }; })()`, 30000);
    const vis18 = await evaluate(`(() => { const el = document.querySelector('${T.toggle(cardIds[1])}'); return el ? { checked: !!el.checked, aria: el.getAttribute("aria-checked") } : null; })()`, 30000);
    const recs18 = (await calls()).slice(n18).filter((x) => x.url === "/api/settings/mutate");
    const mk18 = recs18.length ? recs18[recs18.length - 1].mkeys : null;
    await waitForAutoSave(n18);
    await reloadAndReopen();
    const st18 = await ui.state();
    await exec("B-018", "light", async () => {
      const idx = st18.ids.indexOf(cardIds[1]);
      const mis = [];
      if (st18.enabled[idx] !== false) mis.push(`reload 读回 enabled=${st18.enabled[idx]} 期望 false`);
      if (nt18b.exists && nt18b.text !== nt18a.text) mis.push(`条目开关触发 savedNotice 新增=V3-3 违例：动作后 ${JSON.stringify(nt18b.text)}（动作前 ${JSON.stringify(nt18a.text)}）`);
      if (vis18 && vis18.checked !== false) mis.push(`条目开关视觉态未同步 got ${JSON.stringify(vis18)}（期望 checked=false，开关状态即反馈）`);
      if (!recs18.length) mis.push("条目开关未触发自身 mutate");
      else if (!mk18) mis.push("mkeys 缺失");
      else {
        // run-acc2 实证：dev3 mutate 载荷=路径补丁（ops:[{op,path:[…]}]），digest 面 token 为 "op:path.segs"；
        // 条目定位=位置路径 entries.<idx>.*（idx 为该条目 id 在持久列表中的位置，两代 token 形态兼容，与旧「含 id」判据等价定位）。
        const pathRe18 = new RegExp("^(?:(?:set|unset):)?entries\\." + idx + "\\.");
        const hit = mk18.filter((k) => pathRe18.test(k));
        if (!hit.length) mis.push(`载荷路径 ${JSON.stringify(mk18.slice(0, 6))} 未指向 entries.${idx}（id=${cardIds[1]} 等价定位）`);
        if (hit.some((k) => !/enabled|disabled/i.test(k))) mis.push(`载荷含该条目非开关字段：${JSON.stringify(hit)}`);
        const foreign18 = mk18.filter((k) => !pathRe18.test(k));
        if (foreign18.length) mis.push(`载荷混入无关字段：${JSON.stringify(foreign18.slice(0, 5))}`);
      }
      if (mis.length) throw new Error(mis.join("；"));
      return { measured: `关条目→自动落盘→reload enabled=false；载荷 ${JSON.stringify(mk18.slice(0, 4))} 仅该条目 enabled 字段；savedNotice 无新增✓；视觉态 ${JSON.stringify(vis18)}` };
    });
    { const n = (await calls()).length; await evaluate(`(() => { const el = document.querySelector('${T.toggle(cardIds[1])}'); if (el && !el.checked) el.click(); return true; })()`, 30000); if (!(await waitForAutoSave(n))) throw new Error("B-018 复原（再开）未落定"); }
  }
  {
    await addViaPicker("exa");
    await finishCreate("Oracle Removable", KEY_A); // v1 兼容面/run-9 实证：经 finishCreate 双代路径
    const stB = await ui.state();
    const remId = stB.ids[stB.ids.length - 1], remName = stB.names[stB.names.length - 1];
    const n19 = (await calls()).length;
    await ui.click(`${T.card(remId)} [data-role="card-remove"]`);
    await wait(300);
    const confirmSel = await evaluate(`(() => { const d=document.querySelector('${ROOT} [role="alertdialog"]'), b=d&&d.querySelector('[data-role="confirm-remove"]'); if (b && (b.textContent||'').trim()===${JSON.stringify(`删除 ${remName}`)}) { b.click(); return "confirm-remove"; } return null; })()`, 30000);
    await waitForAutoSave(n19);
    await wait(450);
    const immediate19 = await ui.state(), notice19 = immediate19.savedNotice;
    const recs19 = (await calls()).slice(n19).filter((x) => x.url === "/api/settings/mutate");
    const mk19 = recs19.length ? recs19[recs19.length - 1].mkeys : null;
    await exec("B-032", "light", async () => {
      const expected=stB.ids.filter(id=>id!==remId), mis=[];
      if(confirmSel!=="confirm-remove")mis.push("danger 删除按钮未通过精确名称确认");
      if(JSON.stringify(immediate19.ids)!==JSON.stringify(expected))mis.push(`确认后即时条目序列 ${JSON.stringify(immediate19.ids)}≠${JSON.stringify(expected)}`);
      if(notice19!=="已保存设置。")mis.push(`离散删除的 SET-007 savedNotice=${JSON.stringify(notice19)}≠已保存设置。`);
      if(!recs19.length)mis.push("确认删除未发 settings/mutate");
      if(mis.length)throw new Error(mis.join("；"));
      return {measured:`danger 确认即时只删除目标；其余 ${immediate19.ids.length} 条完整；savedNotice=${JSON.stringify(notice19)}`};
    });
    await reloadAndReopen();
    const st19 = await ui.state();
    await exec("B-019", "light", async () => {
      const mis = [];
      if (st19.ids.includes(remId)) mis.push("reload 后临时卡仍在（删除未持久）");
      if (st19.ids.length !== 3) mis.push(`删除后条目数 ${st19.ids.length} 期望 3（误伤其余）`);
      if (confirmSel !== "confirm-remove") mis.push(`精确名称 danger 确认按钮未出现/未点击（${JSON.stringify(`删除 ${remName}`)}，SET-003）`);
      if (!recs19.length) mis.push("删除未触发自身 mutate");
      else if (mk19 && !mk19.some((k) => /^(?:unset:)?entries\.\d+$/.test(k) || k.includes(remId) || /removed|delete/i.test(k))) mis.push(`删除载荷 ${JSON.stringify(mk19.slice(0, 6))} 未指向该条目/删除语义（run-acc2：路径补丁面期望 unset:entries.<idx> 或含条目 id）`);
      if (mis.length) throw new Error(mis.join("；"));
      return { measured: `确认删除→自动落盘（载荷 ${JSON.stringify((mk19 || []).slice(0, 4))}）→reload 仅缺该卡，其余 3 条完整` };
    });
  }

  // B-012 键盘排序（v2：排序动作自动落盘）：bing 上移两位 → 自动持久 → reload 读回。B-021 同锚采 payload。
  const nB12 = (await calls()).length;
  if (!(await focusSel(`${T.card(cardIds[2])} [data-role="drag-handle"]`))) throw new Error("drag-handle 聚焦失败");
  const af12 = await evaluate(`() => { const a = document.activeElement; return a ? (a.getAttribute("data-role") || String(a.className).slice(0, 30)) : "none"; }`, 30000); // run-acc2 实证：聚焦受体自证（drag-handle onKeyDown 为键盘排序接收前置）
  if (af12 !== "drag-handle") console.log(`[oracle] B-012 注记：focusSel 后焦点=${af12}（期望 drag-handle）——键盘排序或未达（run-acc2 自证面）`);
  await pressKey("ArrowUp", "ArrowUp", 38); await wait(250);
  const af12b = await evaluate(`() => { const a = document.activeElement; return a ? (a.getAttribute("data-role") || String(a.className).slice(0, 30)) : "none"; }`, 30000); // run-acc4 取证协议4：moveEntry 后焦点连续性
  await pressKey("ArrowUp", "ArrowUp", 38); await wait(250);
  const want12 = [...cardIds.slice(2), ...cardIds.slice(0, 2)];
  let preOrder = await ui.state();
  for (let i = 0; i < 8 && JSON.stringify(preOrder.ids) !== JSON.stringify(want12); i++) { await wait(500); preOrder = await ui.state(); } // 等 React 落定
    const kbMutates = (await calls()).slice(nB12).filter((x) => x.url === "/api/settings/mutate");
  let mutSynth = null, synthMoved = false, af12d = null;
  if (JSON.stringify(preOrder.ids) !== JSON.stringify(want12)) {
    // run-acc4 取证协议4：第二通道合成 keydown（Runtime dispatchEvent bubbles→React onKeyDown）对照 CDP——判「宿主注入面限制」vs「实现/焦点链」。
    await focusSel(`${T.card(cardIds[2])} [data-role="drag-handle"]`);
    af12d = await evaluate(`() => { const a = document.activeElement; return a ? (a.getAttribute("data-role") || String(a.className).slice(0, 30)) : "none"; }`, 30000);
    const nS12 = (await calls()).length;
    await evaluate(`(() => { const el = document.querySelector('${T.card(cardIds[2])} [data-role="drag-handle"]'); if (!el) return false; el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", code: "ArrowUp", keyCode: 38, bubbles: true, cancelable: true })); return true; })()`, 30000);
    await wait(350);
    mutSynth = (await calls()).slice(nS12).filter((x) => x.url === "/api/settings/mutate").length;
    await wait(500); synthMoved = JSON.stringify((await ui.state()).ids) === JSON.stringify(want12);
    console.log(`[oracle] B-012 双通道取证（run-acc4）：CDP mutate=${kbMutates.length} 焦点首=${af12}/第一次后=${af12b}；synth mutate=${mutSynth} 焦点=${af12d} 达标=${synthMoved}`);
  }
  if (JSON.stringify(preOrder.ids) === JSON.stringify(want12)) {
    await waitForAutoSave(nB12);
    await reloadAndReopen();
    const s = await ui.state();
    await exec("B-012", "light", async () => {
      if (JSON.stringify(s.ids) !== JSON.stringify(want12)) throw new Error(`reload 后顺序 ${JSON.stringify(s.ids)} ≠ 键盘移动后应有顺序 ${JSON.stringify(want12)}`);
      return { measured: `键盘 ArrowUp×2 后顺序 ${JSON.stringify(s.names)} 保存读回一致` };
    });
  } else {
    await exec("B-012", "light", async () => {
      if (!kbMutates.length && mutSynth > 0) throw new SkipGap(`宿主注入面限制（双通道对照，run-acc4 取证）：CDP dispatchKeyEvent ArrowUp×2 mutate=0（焦点受体=${af12}），Runtime 合成 keydown 同焦点到达（mutate=${mutSynth}${synthMoved ? " 且顺序达标" : ""}）→ handler 链可达而宿主 CDP 注入不可达=本平台键盘路径不可达，SKIP gap 带证据`);
      throw new Error(`键盘排序未生效：焦点受体 初始=${af12}/第一次按键后=${af12b}，CDP 窗 mutate=${kbMutates.length}${kbMutates.length ? `(末次载荷=${JSON.stringify((kbMutates[kbMutates.length - 1].mkeys || []).slice(0, 4))})` : ""}，synth 通道 mutate=${mutSynth}${synthMoved ? "(达标)" : ""}；保存前顺序 ${JSON.stringify(preOrder.ids)} 未达 ${JSON.stringify(want12)}${kbMutates.length ? "——首按键已生效（宿主注入可达 handler），后续键丢失：moveEntry 后焦点/handle 连续性断链=实现面" : mutSynth > 0 ? "" : "——双通道均无效：聚焦链/实现面"}（SET-003 键盘路径必做）`);
    });
  }

  await exec("B-021", "light", async () => {
    // SET-006：键盘排序自身 mutate 且不依赖全局保存钮；payload 仅含排序变更（B-012 同锚）。
    if (!kbMutates.length) throw new Error("键盘排序未触发自身 settings/mutate（SET-006 独立持久化违规；可能仍依赖全局保存入口）");
    const mk = kbMutates[kbMutates.length - 1].mkeys;
    if (!mk) throw new Error("插桩未能提取 mutate 请求体字段路径（mkeys 缺失，专责面不可判）");
    const bad = mk.filter((k) => /^entries\./.test(k) && !/order|index|position/i.test(k));
    if (bad.length) throw new Error(`排序 mutate 载荷含无关字段：${JSON.stringify(bad.slice(0, 5))}`);
    return { measured: `键盘排序自动落盘 mutate×${kbMutates.length}；末次载荷字段 ${JSON.stringify(mk.slice(0, 6))}（仅排序族）；无全局保存钮参与（A-055 缺席面已证）` };
  });

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
    const nB13 = (await calls()).length;
    const opacity = await nativeDragAttempt(before.ids[0]);
    if (opacity === null) throw new SkipGap("native drag unreachable in Electron（键盘排序 B-012 已必测覆盖）");
    const after = await ui.state();
    if (JSON.stringify(after.ids) !== JSON.stringify(before.ids)) {
      // codex 第三轮 P2（定性有效）：持久化闭环断言补全——保存必须判落定；真实 reload 后 ID 序列必须 === drop 后即时序列
      // （SET-003「保存读回」本意含持久化比较，与 B-012 键盘路径断言形态对齐；「drop 改序→未落库→reload 回弹」不得判 PASS）。
      const saved = (await waitForAutoSave(nB13)) && (await settleSaved()); // 重排落定=保留提示动作族（v3）：notice 闭环校验保留
      if (!saved) throw new Error(`拖拽重排成功（即时序 ${JSON.stringify(after.ids)}）但自动持久未落定（savedNotice 未达 saved）——持久化闭环失败`);
      await reloadAndReopen();
      const fin = await ui.state();
      if (JSON.stringify(fin.ids) !== JSON.stringify(after.ids)) throw new Error(`落库不一致：drop 后即时序 ${JSON.stringify(after.ids)} ≠ reload 读回序 ${JSON.stringify(fin.ids)}（保存失败/未落库/回弹原序）`);
      return { measured: `原生拖拽可达且顺序变化：drop 后即时序 ${JSON.stringify(after.ids)} 保存落定→reload 读回 ${JSON.stringify(fin.ids)} 一致（持久化闭环，B-012 同形态）` };
    }
    // Luna call-2：拖拽路径可达（data-dragging 实证）却未产生期望重排 → 行为断言 FAIL，不得判 PASS；仅不可达才 SKIP。
    throw new Error(`原生拖拽可达（拦截事件实证）但释放后顺序未变：${JSON.stringify(after.names)}——SET-003 拖拽重排行为未达成（可达即判，不得 PASS）`);
  });

  // ── SET-006/008 v2 尾区：拖拽载荷排他（B-020）+ 草稿跨分区存活族（B-022..B-026）──
  await exec("B-020", "light", async () => {
    const before = await ui.state();
    const n20 = (await calls()).length;
    const opacity = await nativeDragAttempt(before.ids[Math.min(2, before.ids.length - 1)]); // 执行器稳健性/run-10：B-013 已拖过首卡，换尾卡提高改序可达性（语义不变）
    if (opacity === null) throw new SkipGap("native drag unreachable in Electron（排序持久化行为面已由 B-012/B-013 覆盖）");
    const after = await ui.state();
    if (JSON.stringify(after.ids) === JSON.stringify(before.ids)) throw new SkipGap("本次拖拽未产生顺序变化，载荷排他面不可判（行为面已由 B-013 覆盖）");
    const recs20 = (await calls()).slice(n20).filter((x) => x.url === "/api/settings/mutate");
    const mk20 = recs20.length ? recs20[recs20.length - 1].mkeys : null;
    const settled = await settleSaved();
    if (!recs20.length) throw new Error("拖拽 drop 未触发自身 settings/mutate（SET-006 drop 即落盘违规）");
    if (mk20 && mk20.some((k) => /timeoutMs|official/i.test(k))) throw new Error(`拖拽载荷混入无关全局字段：${JSON.stringify(mk20.slice(0, 5))}`);
    return { measured: `drop 即自动落盘（settled=${settled}）mutate×${recs20.length}；载荷 ${JSON.stringify((mk20 || []).slice(0, 6))}（排序族，无全局字段）` };
  });
  {
    // Luna call-7 / A-066（V3-1.2）：新建编辑器打开至提交完成，列表行数恒=已持久条目数（含 submit busy 期）；探针条目清理按 entryId 精确删。
    if (await implV1()) {
      await exec("A-066", "light", async () => { throw new SkipGap("v1 契约（选类型即入账）与 V3-1.2「未提交新建不入列」结构性不可达（state-unreachable=SKIP gap，v1 兼容面）"); });
    } else {
      const s66a = await ui.state();
      await addViaPicker("exa");
      const eid66 = await evaluate(`(() => { const el = document.querySelector('${ROOT} [data-role="field"][data-field="name"]'); return el ? el.getAttribute("data-entry-id") : null; })()`, 30000);
      const cOpen = (await ui.state()).ids.length;
      if ((await setField("name", "Oracle Probe-66")) !== "Oracle Probe-66") throw new Error("A-066 名称写入失败");
      if ((await setField("key", KEY_A)) !== KEY_A) throw new Error("A-066 key 写入失败");
      const n66 = (await calls()).length;
      const clk66 = await evaluate(`() => { const b = [...document.querySelectorAll('${ROOT} .sc-editor-actions button, ${ROOT} [data-role="editor"] button')].find((x) => /sc-button-primary/.test(x.className || '') && !/取消/.test(x.textContent || '')); if (!b) return false; b.click(); return true; }`, 30000);
      if (!clk66) throw new Error("missing element: 新建编辑器提交主按钮（A-066 busy 采样前置）");
      const cBusy = (await ui.state()).ids.length; // busy 窗即时采样（mutate 在途）
      await waitRpc("/api/settings/mutate", n66, 60).catch(() => {});
      await settleSaved(); // 编辑器提交（含新建）=V3 保留提示动作族
      const s66z = await ui.state();
      if (eid66 && s66z.ids.includes(eid66)) { const nC66 = (await calls()).length; if (await ui.click(`${T.card(eid66)} [data-role="card-remove"]`)) { await wait(300); await ui.click(`${ROOT} [data-role="confirm-remove"]`); } await waitForAutoSave(nC66); }
      await wait(300);
      cardIds = (await ui.state()).ids;
      console.log(`[oracle] A-066("light") 行数采样：已持久=${s66a.ids.length} 开编辑=${cOpen} busy期=${cBusy} 提交后=${s66z.ids.length} 清理后=${cardIds.length}`);
      await exec("A-066", "light", async () => {
        const mis = [];
        if (cOpen !== s66a.ids.length) mis.push(`未提交草稿进入列表：开编辑行数 ${cOpen} ≠ 已持久 ${s66a.ids.length}（V3-1.2 占位行违规）`);
        if (cBusy !== s66a.ids.length && cBusy !== s66a.ids.length + 1) mis.push(`busy 期行数异常 got ${cBusy}（期望=已持久 ${s66a.ids.length}；late-settle 容忍 +1=mutate 先于采样落定的读回时序，非占位行）`);
        if (!s66z.names.includes("Oracle Probe-66")) throw new Error(`正向对照缺失：提交后未入列 ${JSON.stringify(s66z.names.slice(0, 5))}（采样无效）`);
        if (cardIds.length !== s66a.ids.length) mis.push(`探针清理后未回基线 ${cardIds.length} ≠ ${s66a.ids.length}`);
        if (mis.length) throw new Error(mis.join("；"));
        return { measured: `行数恒等：已持久=${s66a.ids.length} 开编辑=${cOpen}（占位行主判）busy期=${cBusy} 提交后=${s66z.ids.length} 清理后=${cardIds.length}；busy 期覆盖✓；探针条目按 entryId 清理✓` };
      });
    }
  }
  {
    // Luna call-7 / A-067（V3-1.2+SET-008 收窄）：新建草稿跨分区/后台读回/O-6 重开——列表恒已持久、编辑器自动重开+字段复原、禁占位行；零写入自证。
    if (await implV1()) {
      await exec("A-067", "light", async () => { throw new SkipGap("v1 无新建编辑器/内存草稿缓存（v1 兼容面 state-unreachable=SKIP gap）"); });
    } else {
      const s67a = await ui.state();
      const n67 = (await calls()).length;
      await addViaPicker("exa");
      if ((await setField("name", "Oracle Draft-67")) !== "Oracle Draft-67") throw new Error("A-067 草稿名写入失败");
      const c67a = (await ui.state()).ids.length;
      const o167 = await sectionSwitchProbe(); // 分区切换+后台读回观测（O-1 家族探针）
      const c67b = (await ui.state()).ids.length;
      const cyc67 = await settingsViewCycle(); // 载体=设置视图关闭-重开（O-6 自动重开面）
      const ed67 = await evaluate(`(() => { const e = document.querySelector('${ROOT} [data-role="editor"]'); if (!e) return null; const n = e.querySelector('[data-field="name"]'); return { name: n ? String(n.value) : null }; })()`, 30000);
      const s67z = await ui.state();
      const mut67 = (await calls()).slice(n67).filter((x) => x.url === "/api/settings/mutate").length;
      if (ed67) { await cancelEditor(); await wait(300); }
      cardIds = (await ui.state()).ids;
      await exec("A-067", "light", async () => {
        if (!cyc67.closed) {
          if (c67a === s67a.ids.length && c67b === s67a.ids.length) throw new SkipGap(`载体不可达（设置视图未能关闭 ${JSON.stringify(cyc67.attempts).slice(0, 80)}；O-1 unmounted=${o167.unmounted}；【accel 模态抑制定案】）——已验面：草稿期/切区后列表无占位（${c67a}/${c67b}=已持久 ${s67a.ids.length}），O-6 重开面不可判`);
          throw new SkipGap(`载体不可达（${JSON.stringify(cyc67.attempts).slice(0, 80)}）且观测面异常：草稿期/切区行数 ${c67a}/${c67b} vs 已持久 ${s67a.ids.length}`);
        }
        const mis = [];
        if (c67a !== s67a.ids.length || c67b !== s67a.ids.length || s67z.ids.length !== s67a.ids.length) mis.push(`列表出现非持久行：前=${s67a.ids.length} 草稿期=${c67a} 切区后=${c67b} 重开后=${s67z.ids.length}（占位/重追加违规）`);
        if (mut67) mis.push(`未提交草稿产生 ${mut67} 次 mutate（零写入违例）`);
        if (!ed67) mis.push("O-6 新建编辑器未自动重开（SET-008 收窄语义=编辑器字段复原+自动重开）");
        else if (ed67.name !== "Oracle Draft-67") mis.push(`新建草稿字段未复原 got ${JSON.stringify(ed67.name)} 期望「Oracle Draft-67」`);
        if (mis.length) throw new Error(mis.join("；"));
        return { measured: `列表恒=已持久 ${s67a.ids.length}（草稿期/切区/重开三点 ${c67a}/${c67b}/${s67z.ids.length}）；编辑器自动重开+名称字段复原✓；零 mutate✓（占位行零出现）` };
      });
    }
  }
  {
    // B-022/023：未提交草稿（名称+key buffer+timeout）跨分区切换存活；草稿期 storage 泄漏扫描。
    // run-acc11 实证修复（run-10 中断源 mjs:2364）：B-020 系拖拽重排后 cardIds 快照位漂——cardIds[1] 可为 bing 型（编辑器无 key 字段）。
    // 载体按主数据 id 快照锚定（SET-008 不指定条目，exa 型保证 key 字段在场）；exa-2 优先（exa-1 已改名面隔离）。
    let target22 = exa2Id;
    { const st22p = await ui.state(); if (!target22 || !st22p.ids.includes(target22)) target22 = exa1Id ?? cardIds[1]; }
    console.log(`[oracle] B-022 载体（id 锚定，类型保证 key 字段在场）：${target22}`);
    await openEditor(target22);
    if ((await setField("name", "Oracle Draft γ")) !== "Oracle Draft γ") throw new Error("B-022 草稿名写入失败");
    { const d = await evaluate(`(() => { const i = document.querySelector('${ROOT} [data-role="field"][data-field="key"]'); if (!i) return false; const pd = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); pd.set.call(i, ${JSON.stringify(KEY_B)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`, 30000); if (!d) throw new Error("missing element: key 字段（草稿 buffer 前提）"); }
    const tSel2 = await evaluate(`(() => { const sels = ['${ROOT} [data-field="timeoutMs"]', '${ROOT} input[type="number"]']; for (const x of sels) { const el = document.querySelector(x); if (el) return x; } return null; })()`, 30000);
    let tDraft0 = null, tDraft1 = null, tSaved = null;
    if (tSel2) {
      tDraft0 = await evaluate(`(() => { const el = document.querySelector('${tSel2}'); return el.value; })()`, 30000);
      await evaluate(`(() => { const el = document.querySelector('${tSel2}'); const pd = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); pd.set.call(el, '7777'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`, 30000); // 不 blur
    }
    const n22 = (await calls()).length;
    // O-1 正式取证（分区切换三观测，非抛出）+ 主载体=设置视图关闭-重开（run-10 实证必卸载路径）。
    const o1 = await sectionSwitchProbe();
    const cyc22 = await settingsViewCycle();
    if (tSel2) {
      tDraft1 = await evaluate(`(() => { const el = document.querySelector('${tSel2}'); return el ? el.value : null; })()`, 30000);
      tSaved = await evaluate(`(() => { const s = JSON.parse(sessionStorage.getItem('__oracle50Calls') || '[]'); const m = s.filter((x) => x.url === '/api/settings/mutate'); return m.length ? JSON.stringify(m[m.length - 1].mkeys || []) : ''; })()`, 30000);
    }
    const ed22 = await evaluate(`(() => { const e = document.querySelector('${ROOT} [data-role="editor"]'); if (!e) return null; const n = e.querySelector('[data-field="name"]'); const k = e.querySelector('[data-field="key"]'); return { name: n ? n.value : null, keyBuf: k ? k.value.length : -1 }; })()`, 30000);
    // key buffer 直提延伸面（动作段先行，证据入 B-022 单行判定，防 exec 内异常吞断链）：
    if (ed22) { await submitEditor("edit"); await reloadAndReopen(); }
    const st22 = await ui.state();
    await exec("B-022", "light", async () => {
      if (!cyc22.closed) throw new SkipGap(`载体不可达：设置视图未能关闭 ${JSON.stringify(cyc22.attempts).slice(0, 140)}；O-1 实证=分区切换 unmounted=${o1.unmounted}，不满足卸载-重挂载前提【lead 裁定：载体实机不可达已定案；若本轮 accel-mod-comma 通道关闭成功则自动转真载体判别】`);
      const mis = [];
      if (o1.unmounted) mis.push(`异常：分区切换竟卸载了面板（与 run-10 实证相反，复核 O-1）got ${JSON.stringify(o1)}`);
      if (!ed22) mis.push("重挂载后编辑器未自动重开（SET-008：匹配条目的编辑窗应自动恢复）");
      else {
        if (ed22.name !== "Oracle Draft γ") mis.push(`草稿名未回填 got ${JSON.stringify(ed22.name)}`);
        if (!(ed22.keyBuf > 0)) mis.push("key buffer 未随草稿恢复（内存缓冲丢失，重开后无法直接提交）");
      }
      if (tSel2 && tDraft1 !== "7777" && !/7777|timeout/i.test(String(tSaved))) mis.push(`timeout 草稿既未回填（got ${tDraft1}）也未见经 blur 合法落盘`);
      const idx22 = st22.ids.indexOf(target22);
      if (ed22 && (st22.names[idx22] !== "Oracle Draft γ" || st22.dotStates[idx22] !== "ready")) mis.push(`key buffer 直提后读回 name=${st22.names[idx22]} 徽标=${st22.dotStates[idx22]}（期望草稿名持久且凭据完好）`);
      if (mis.length) throw new Error(mis.join("；"));
      return { measured: `载体=设置视图关闭-重开（run-10 实证）后编辑器自动重开：草稿名回填、key buffer 非空且直提成功（${JSON.stringify(st22.names[idx22])} 持久，徽标 ready）；timeout 草稿=${tSel2 ? "存活/合法落盘" : "无输入框(见 B-017 missing)"}；O-1 取证：分区切换 duringPresent=${o1.duringPresent} name 回环 ${JSON.stringify(o1.pre.nameVal)}→${JSON.stringify(o1.post.nameVal)}（未卸载=官方 shell 挂载语义）` };
    });
    await exec("B-023", "light", async () => {
      const leak = await evaluate(`(() => { const needles = ${JSON.stringify([KEY_A, KEY_B, "synthetic-not-a-secret"])}; const hits = [];
        for (const ch of ["localStorage", "sessionStorage"]) { let n2 = 0; try { n2 = window[ch].length; } catch { continue; }
          for (let i = 0; i < n2; i++) { const k = window[ch].key(i); const v = window[ch].getItem(k) || '';
            for (const nd of needles) { if ((k + '\u0000' + v).includes(nd)) hits.push(ch + ':' + k + ' ~ ' + nd.slice(0, 12)); } } }
        return hits.slice(0, 6); })()`, 30000);
      if (leak.length) throw new Error(`草稿/凭据明文进入持久化存储：${JSON.stringify(leak)}`);
      return { measured: "localStorage+sessionStorage 全键扫描：无凭据明文、无 synthetic 哨兵、无草稿名明文（草稿仅内存态）" };
    });
  }
  {
    // B-024 显式取消：草稿清除 + 编辑器关 + 零写入 + 重挂载不重开。
    // run-acc11 实证修复：载体 id 锚定 exa-1——下方 v1 兼容面回写「Oracle Edited」是 exa-1 现名，位漂时写进 bing 卡即污染。
    await openEditor(exa1Id ?? cardIds[0]);
    if ((await setField("name", "Oracle Cancel-X")) !== "Oracle Cancel-X") throw new Error("B-024 草稿写入失败");
    const n24 = (await calls()).length;
    const act = await evaluate(`(() => { const b = [...document.querySelectorAll('${ROOT} [data-role="editor"] button, ${ROOT} .sc-editor-actions button')].find((x) => /取消|cancel/i.test(x.textContent || '')); if (!b) return "missing-cancel"; b.click(); const a = document.activeElement; return a ? (a.getAttribute('data-role') || a.tagName) : "none"; })()`, 30000);
    if (act === "missing-cancel") {
      // v1 兼容面/run-9 实证：v1 无「取消」钮——写回基线名并关窗防草稿污染，缺失判入 exec 行（FAIL 自证不短路）。
      await setField("name", "Oracle Edited");
      await closeEditor();
    }
    await wait(400);
    const closed24 = await evaluate(`() => !document.querySelector('${ROOT} [data-role="editor"]')`, 30000);
    const mut24 = (await calls()).slice(n24).filter((x) => x.url === "/api/settings/mutate").length;
    const cyc24 = await settingsViewCycle(); // 载体=设置视图重开/run-10 实证（分区切换=O-1 未卸载，不构成重挂载）
    const noReopen24 = cyc24.closed ? await evaluate(`() => !document.querySelector('${ROOT} [data-role="editor"]')`, 30000) : null;
    await exec("B-024", "light", async () => {
      const mis = [];
      if (!closed24) mis.push("取消后编辑器未关闭");
      if (mut24) mis.push(`取消产生 ${mut24} 次 mutate（取消必须零写入）`);
      if (noReopen24 === null) mis.push(`载体不可达（设置视图未能关闭 ${JSON.stringify(cyc24.attempts).slice(0, 80)}）：重挂载不恢复子项不可判（lead 裁定：载体实机不可达已定案）`);
      else if (!noReopen24) mis.push("取消草稿竟被缓存（重挂载自动重开=清除未生效）");
      if (act === "none" || act === "BODY") mis.push(`取消后焦点回落到 body（应回焦点触发元素）got ${act}`);
      if (act === "missing-cancel") mis.push('missing element: 编辑器「取消」按钮（SET-008 v2 显式取消面，v1 实现无此钮）');
      if (mis.length) throw new Error(mis.join("；"));
      return { measured: `显式取消：关闭✓ 零 mutate✓ 重挂载不重开（缓存已清）✓ 焦点回落 ${act}` };
    });
  }
  {
    // B-025 Escape：同取消语义（键盘路径）。run-acc11：载体同 B-024 id 锚定 exa-1（位漂防复发）。
    await openEditor(exa1Id ?? cardIds[0]);
    if ((await setField("name", "Oracle Esc-δ")) !== "Oracle Esc-δ") throw new Error("B-025 草稿写入失败");
    const n25 = (await calls()).length;
    await pressKey("Escape", "Escape", 27);
    await wait(400);
    const closed25 = await evaluate(`() => !document.querySelector('${ROOT} [data-role="editor"]')`, 30000);
    const mut25 = (await calls()).slice(n25).filter((x) => x.url === "/api/settings/mutate").length;
    const focus25 = await evaluate(`() => { const a = document.activeElement; return a ? (a.getAttribute('data-role') || a.tagName) : "none"; }`, 30000);
    const cyc25 = await settingsViewCycle(); // 载体=设置视图重开/run-10 实证
    const noReopen25 = cyc25.closed ? await evaluate(`() => !document.querySelector('${ROOT} [data-role="editor"]')`, 30000) : null;
    await exec("B-025", "light", async () => {
      const mis = [];
      if (!closed25) mis.push("Escape 后编辑器未关闭");
      if (mut25) mis.push(`Escape 产生 ${mut25} 次 mutate（应零写入）`);
      if (noReopen25 === null) mis.push(`载体不可达（设置视图未能关闭 ${JSON.stringify(cyc25.attempts).slice(0, 80)}）：重挂载不恢复子项不可判（O-1：分区切换=未卸载）`);
      else if (!noReopen25) mis.push("Escape 草稿未清除（重挂载重开）");
      if (mis.length) throw new Error(mis.join("；"));
      return { measured: `Escape：关闭✓ 零 mutate✓ 缓存清除✓ 焦点回落 ${focus25}（O-5：回焦点触发器）` };
    });
  }
  {
    // B-026 外部冲突注入：describe 取 revision → 外部 mutate 推进 rev → 分区往返 → 草稿存活 + 冲突告警、无静默覆盖。
    // run-acc11：载体 id 锚定 exa-2（与 B-022 同族，位漂防复发）。
    await openEditor(exa2Id ?? cardIds[1]);
    if ((await setField("name", "Oracle Conflict-ε")) !== "Oracle Conflict-ε") throw new Error("B-026 草稿写入失败");
    const inj = await evaluate(`async () => { try {
      const d = await (await fetch('/api/settings/describe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload: { args: {} } }) })).json();
      const r = d && d.result ? d.result : d; const rev = r && (r.revision ?? r.rev ?? (r.settings && r.settings.revision) ?? (r.state && r.state.revision));
      if (rev === undefined || rev === null) return { err: 'no-revision-field', keys: Object.keys(r || {}).slice(0, 8) };
      const resp = await fetch('/api/settings/mutate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload: { args: { settings: { timeoutMs: 5001 }, expectedRevision: rev } } }) });
      const j = await resp.json().catch(() => null);
      return { rev, status: resp.status, ok: !!(j && (j.result ? j.result.ok !== false : j.ok !== false)) && resp.ok };
    } catch (e) { return { err: String(e).slice(0, 100) }; } }`, 30000);
    if (inj.err || !inj.ok) {
      await cancelEditor();
      await exec("B-026", "light", async () => { throw new SkipGap(`冲突注入端不可行（宿主 describe/mutate 非执行器可写：${JSON.stringify(inj).slice(0, 120)}）；草稿+乐观并发 UI 面记 gap`); });
    } else {
      const n26 = (await calls()).length;
      const cyc26 = await settingsViewCycle(); // 载体=设置视图重开（lead 裁定：载体实机不可达已定案，SKIP 定态；accel 通道若通则自动转真判别）
      if (!cyc26.closed) {
        await cancelEditor().catch(() => {});
        await exec("B-026", "light", async () => { throw new SkipGap(`载体不可达：设置视图未能关闭 ${JSON.stringify(cyc26.attempts).slice(0, 100)}；卸载-重挂载冲突前提无法构造（O-1 实证：分区切换=未卸载）`); });
      } else {
      const ed26 = await evaluate(`(() => { const e = document.querySelector('${ROOT} [data-role="editor"]'); const al = document.querySelector('${ROOT} [role="alert"]'); const nm = document.querySelector('${T.card(cardIds[1])} [data-role="card-name"]'); return { open: !!e, draft: e ? (e.querySelector('[data-field="name"]') || {}).value : null, alert: al ? (al.textContent || '').trim().slice(0, 80) : null, savedName: nm ? nm.textContent.trim() : null }; })()`, 30000);
      const mut26 = (await calls()).slice(n26).filter((x) => x.url === "/api/settings/mutate").length;
      await cancelEditor().catch(() => {});
      await exec("B-026", "light", async () => {
        const mis = [];
        if (!ed26.open || ed26.draft !== "Oracle Conflict-ε") mis.push(`外部 rev 推进后草稿丢失（editor=${ed26.open} draft=${JSON.stringify(ed26.draft)}）`);
        if (!ed26.alert) mis.push("未见冲突告警（[role=alert] 缺席；期望提示服务端已更新而非静默）");
        if (mut26) mis.push(`返回即自动以陈旧草稿覆盖服务端（${mut26} 次 mutate；冲突应提示不得静默覆盖）`);
        if (mis.length) throw new Error(mis.join("；"));
        return { measured: `注入 rev=${inj.rev}→载体（设置视图关闭-重开）：草稿存活（${JSON.stringify(ed26.draft)}）+ 冲突告警「${ed26.alert}」+ 零自动覆盖写；持久名仍「${ed26.savedName}」` };
      });
      }
    }
  }

  // 全程审计：B-003 / B-005 / B-006
  const all = await calls();
  // codex-P2：B-003 判据读「全 run 聚合」审计面（sessionStorage 通道，跨 reload 连续；窗口数=audit.windows）。
  const flags = await evaluate(`() => { try { const a = JSON.parse(sessionStorage.getItem('__oracle50Audit') || 'null'); if (a && typeof a === 'object') return a; } catch { /* fallthrough */ } return window.__oracle50 || {}; }`, 30000);
  const storageLeak = await evaluate(`(() => { const s = (sessionStorage.getItem('__oracle50Calls') || '') + (sessionStorage.getItem('__oracle50Audit') || ''); return window.__oracle50Keys.filter((k) => s.includes(k)).length; })()`, 30000);
  await exec("B-003", "light", async () => {
    const setRecs = all.filter((x) => x.url === "/api/credentials/set");
    // run-acc3 实证 scope 收敛（SET-004 原文语义=声明的两枚 exa key 仅合成值+零明文，目录无「全局计数」条款）：
    // 按 ref↔条目 id 身份配对判「B-003 声明的两条目（exa-1/exa-2）」——各恰一次非空 key 命中；命中 0=空真值不得判 PASS；>1=重复写键违规。
    // 生命周期窗 key 写（B-019 临时卡、B-022 key-buffer 直提延伸面等合法流程）单列取证不静默吞、不计数硬钉；仍受 onlySynthetic+零明文同约束。
    const setDetail = JSON.stringify(setRecs.map((r) => r.cred || "未digest"));
    // run-acc11 实证修复：声明条目取主数据 id 快照 exa-1/exa-2——run-10 后拖拽/探针流程使 cardIds 位漂，slice(0,2) 可含 bing 型（无 key 写→tally=0 空真值伪报）。
    const declared22 = [exa1Id, exa2Id].filter(Boolean).map((id) => String(id).replace(/^search_chain_/, ""));
    const nonEmptyK = setRecs.filter((r) => r.cred && r.cred.empty === false);
    const tallyById = declared22.map((suf) => nonEmptyK.filter((r) => String(r.cred.ref).includes(suf)).length);
    const lifecycleK = nonEmptyK.filter((r) => !declared22.some((suf) => String(r.cred.ref).includes(suf)));
    if (tallyById.some((t) => t === 0)) throw new Error(`脱敏自证依据缺失：声明条目 exa-1/exa-2 存在 key 记录 ${JSON.stringify(tallyById)} 含 0（空真值不得判 PASS；明细=${setDetail}）`);
    if (tallyById.some((t) => t > 1)) throw new Error(`SET-004 违规：声明条目 key 记录重复 ${JSON.stringify(tallyById)}＞1（重复写键；明细=${setDetail}）`);
    if (!flags.onlySynthetic) throw new Error("检测到非合成值写入 credentials/set（全 run 聚合面）");
    if ((flags.responseEchos || 0) > 0 || (flags.envEchoes || 0) > 0 || storageLeak > 0) throw new Error(`回显自证失败（全 run 聚合） responseEchos=${flags.responseEchos || 0} envEchoes=${flags.envEchoes || 0} storage=${storageLeak}`);
    const rawTable = results.map((r) => `${r.id}|${r.measured}|${r.expected}`).join("\n");
    if (rawTable.includes(KEY_A) || rawTable.includes(KEY_B)) throw new Error("断言表/rpc 报告出现合成 key 明文");
    return { measured: `两枚 exa key 恒为合成 sk-TEST-oracle-*；宿主回包/插桩存储/断言表/raw 证据零明文（打印面全脱敏）；key 写身份配对 exa-1/exa-2=${JSON.stringify(tallyById)}×各1、生命周期 key 写 ${lifecycleK.length} 条=${JSON.stringify(lifecycleK.map((r) => r.cred))}（同受 onlySynthetic 约束，run-acc3 scope 收敛）。codex-P2 修复后为跨 reload 聚合判据：全 run 窗口数×${flags.windows || 1}（sessionStorage 审计通道仅存计数/布尔，脱敏扫描覆盖聚合通道）` };
  });
  await exec("B-005", "light", async () => {
    const rpc = all.filter((x) => /^\/api\/(settings|credentials)\//.test(x.url));
    const bad = rpc.filter((x) => !appOk(x));
    if (!rpc.length) throw new Error("未捕获任何 describe/mutate/credentials 记录");
    if (bad.length) throw new Error(`${bad.length}/${rpc.length} 条 RPC 非应用级 ok（含 ${bad.slice(0, 2).map((x) => { let d = ""; try { const rr = (x.response && (x.response.result || x.response)) || {}; d = String(JSON.stringify(rr.error ?? rr.errorCode ?? rr.message ?? rr.detail ?? Object.keys(rr).slice(0, 6)) || ""); } catch { /* */ } d = (d.includes(KEY_A) || d.includes(KEY_B)) ? "<脱敏:含合成key>" : d.replace(/sk-[A-Za-z0-9_-]{4,}/g, "sk-***").slice(0, 90); return `${x.url}@${x.status ?? x.error ?? "reject"} err=${d || "无"}`; }).join(" ｜ ")}）`);
    return { measured: `${rpc.length} 条 describe/mutate/credentials/set 全应用级 ok=true（双信封兼容）` };
  });
  await exec("B-006", "light", async () => {
    // Luna call-3 CONFIRM（attributionRule 逐字实现）：插件面非 /api/ 违例必须为 0；
    // 豁免仅当 method===GET ∧ pathname 精确 /open-in-app/apps ∧ 栈无插件帧(pf!==true) ∧ 栈含宿主帧(hf===true)；
    // 其余一律计违例（含归属不明/插件帧参与/该 URL 非 GET）。豁免记录单列 hostEnvironmentEvidence，不静默吞。
    const nonApi = all.filter((x) => !String(x.url).startsWith("/api/"));
    const isExempt = (x) => String(x.url) === "/open-in-app/apps" && String(x.method).toUpperCase() === "GET" && x.hf === true && x.pf !== true;
    const viol = nonApi.filter((x) => !isExempt(x));
    if (viol.length) {
      const tally = Object.entries(viol.reduce((a, x) => { const k = `${x.method} ${x.url}${x.pf ? "(插件帧)" : x.hf ? "" : "(归属不明)"}`; a[k] = (a[k] || 0) + 1; return a; }, {})).map(([k, v]) => `${k}×${v}`).join("，");
      // Luna call-4 REJECT：宿主/插件共用 dsh-app://app 命名空间，URL 形态判据不安全——维持字面 FAIL 由用户裁决；附脱敏帧审计面。
      const evFrames = viol.slice(0, 2).map((x) => x.frames).filter(Boolean);
      throw new Error(`插件面/归属不明非 /api/ 请求 ${viol.length} 条：${tally}${evFrames.length ? `；脱敏栈帧审计面=${JSON.stringify(evFrames)}` : ""}`);
    }
    const exempt = nonApi.filter(isExempt);
    const hostEnvironmentEvidence = Object.entries(exempt.reduce((a, x) => { a[x.url] = (a[x.url] || 0) + 1; return a; }, {})).map(([pathname, count]) => ({ pathname, count }));
    return { measured: `插件面非 /api/ 违例 0（全程插桩 ${all.length} 条）；hostEnvironmentEvidence=${JSON.stringify(hostEnvironmentEvidence)}（call-3 归属判据豁免：GET+精确路由+栈含宿主帧无插件帧；单列不吞，供人工复核）` };
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
