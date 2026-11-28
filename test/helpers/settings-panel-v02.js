// Issue #48 v0.2 设置面板 oracle 共享替身（仅测试用，不属于实现）。
//
// 零 DOM、零真实网络、零真实定时器：fetch、host.call 与 console 均为记录型替身；渲染用 fake hook-React
// （白名单 hook 惯例承自已退役的 bundle 配置测试）。本文件只钉可观察行为，不钉实现内部结构。
//
// ─── 测试侧约定（实现须满足；规格未定义 DOM 契约，见交付报告「规格缺口」）────────────────
//   C-1 渲染树 = React.createElement 产物 { type, props, children }。
//   C-2 控件以 props["data-role"] 寻址（见 ROLE）；条目相关控件另附 props["data-entry-id"]；
//       表单字段附 props["data-field"]（key 输入框 = "key"）；新增类型选项附 props["data-type"]。
//   C-3 交互以回调表达：props.onClick(event)、props.onChange(event)、props.onKeyDown(event)。
//       开关的当前值 = props.checked（boolean）。
//   C-4 宿主 host 半通道：闭包符号 host（runtime builtin：host.call(method, args?)）。
//       静态 ctx 无 host 服务（[C3]）；本替身以 globalThis.host 模拟并记录调用，面板操作零调用。
//   C-5 settings RPC（通道钉承自历史 bundle-config-ui [C8]，规格退役后由本 helper 与 settings-ui.md 继续承担）
//       { type:"client-request", method, rpcId, payload:{ args } }；
//       describe 的 args 恰为 {}；mutate 的 args 为 { ns:"search-chain", ops, expectedRevision }。
//       回包 { ok, result:{ namespaces:[{ ns, revision, base, user }] } } 或 { ok:false, error:{ code } }。
//   C-6 凭据 Remote 通道（D-2C，宿主全局 Remote：credentials/describe、credentials/set、credentials/unset）。
//       路径与 args 传形未实证：分类只看 method 字符串或 URL 路径中是否含端点名；同源 /api/ 前缀是唯一
//       URL 约束。credentials/describe 回包包装形状未实证，credentialsDescribeReply 仅为替身备好，
//       断言不强制其形状。

import assert from "node:assert/strict";

export const PACKAGE_ID = "dsh-fleetseek";
export const SECTION_SLOT = "settings.section";
export const SECTION_ID = "search-chain";
export const SECTION_ORDER = 30;
export const SECTION_TITLE = "网页搜索链";

/** 同源基准（GUI 地址）。仅用于判定同源，不出现在任何请求中。 */
export const TEST_ORIGIN = "http://127.0.0.1:50606";

/** 凭据引用前缀（与 src/settings/panel.js 数据层一致；ref 形态见 D-2C）。 */
export const CRED_PREFIX = "SEARCH_CHAIN_CREDENTIAL_";

/** 新生成凭据引用须匹配的语法（R-1；dsh-credentials src/index.ts L19 REF_PATTERN）。冒号形态作废。 */
export const REF_GRAMMAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** CAT-001 八个类型（镜像 src/constants.js TOOL_TYPES；顺序无关）。 */
export const ALL_TYPES = [
  "openai",
  "tavily",
  "exa",
  "brave",
  "bing",
  "gemini",
  "deepseek-search",
  "deepseek-agentic-search",
];

/** 同 src/config.js SECRET_FIELD：任何 ops 的 set 值（嵌套亦然）不得含这些键名（P0）。 */
export const SECRET_FIELD = /^(apikey|api_key|key|secret|token|password|auth|authorization)$/i;

/** 合成的 key（sk-TEST-<hex> 形式，不是真实凭据）。 */
export const SYNTH_KEY = "sk-TEST-5c1e9a07d3b24f68";

/** 区域内控件角色（C-2）。 */
export const ROLE = Object.freeze({
  officialToggle: "official-toggle",
  officialHint: "official-hint",
  add: "add-tool",
  addType: "add-type",
  empty: "empty-state",
  card: "card",
  cardName: "card-name",
  cardType: "card-type",
  cardStatus: "card-status",
  enabled: "enabled-toggle",
  edit: "card-edit",
  remove: "card-remove",
  dragHandle: "drag-handle",
  confirmRemove: "confirm-remove",
  editor: "editor",
  field: "field",
  // O-8（#51）：SET-006 起全局保存钮（save）废止，编辑器动作行 = 左「取消」右主提交。
  editorSubmit: "editor-submit",
  editorCancel: "editor-cancel",
  save: "save",
  saveStatus: "save-status",
  saveError: "save-error",
  timeout: "timeout",
});

export function clone(v) {
  return structuredClone(v);
}

/** 已保存快照的三条目夹具：A 已就绪（有凭据引用）、B 为 exa 无凭据、C 为 bing（免 key）。 */
export function fixtureEntries() {
  return [
    { id: "tavily-a", type: "tavily", name: "Tavily 主", enabled: true, credentialRef: "TAVILY_KEY_A" },
    { id: "exa-b", type: "exa", name: "Exa 备用", enabled: true },
    { id: "bing-c", type: "bing", name: "Bing 公开", enabled: true },
  ];
}

/**
 * 宿主 settings 状态：revision + 当前 user 层 + 凭据存根。
 * mutateMode 控制 mutate 回包；credentialMode 控制 credentials/set 回包（"ok" | "rejected" | "network"）。
 * credentials 为 ref → { configured, writable, masked }，仅记录存在性与掩码，不记录明文。
 */
export function makeSettingsState(overrides = {}) {
  return {
    revision: 3,
    user: {
      entries: fixtureEntries(),
      useOfficialDeepSeekSearch: true,
      timeoutMs: 25000,
    },
    omitRevision: false,
    // R-2：base 层（只读继承，回包 namespaces[].base）；默认空。
    base: {},
    // R-2：true 时 settings/mutate 挂起，直至测试调用 releaseMutate()（deferred 手动释放，不赌定时）。
    deferMutate: false,
    mutateMode: "ok", // "ok" | "conflict" | "save-failed"
    credentialMode: "ok", // "ok" | "rejected" | "network"
    credentials: {},
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────
// 装载与 live ctx
// ────────────────────────────────────────────────────────────────────────────────────────

let bustCounter = 0;

/** 动态 import src/client-entry.js 的 cache-bust 副本，返回 load 捕获的注册表。 */
export async function importSelfRegister(tag) {
  const registrations = [];
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  globalThis.window = { __ModuleLoader__: { load(reg) { registrations.push(reg); } } };
  try {
    await import(`../../src/client-entry.js?v=v02-${tag}-${++bustCounter}`);
  } finally {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else delete globalThis.window;
  }
  return registrations;
}

/** live 形状 client ctx：slots.inject/register + effect。ctx.host 读即抛（[C3]）。 */
export function makeLiveCtx() {
  const injects = [];
  const regs = [];
  let activeInject = null;
  const ctx = {
    slots: {
      inject(name, factory) {
        const rec = { name, factory };
        injects.push(rec);
        return () => {
          const i = injects.indexOf(rec);
          if (i >= 0) injects.splice(i, 1);
        };
      },
      register(registration, Component) {
        const rec = { registration, Component, via: activeInject };
        regs.push(rec);
        return () => {
          const i = regs.indexOf(rec);
          if (i >= 0) regs.splice(i, 1);
        };
      },
    },
    effect() {},
  };
  Object.defineProperty(ctx, "host", {
    configurable: true,
    enumerable: false,
    get() {
      throw new Error('cannot get property "host" without inject');
    },
  });
  return {
    ctx,
    injects,
    /** 模拟宿主挂载某槽的懒工厂，返回该次挂载登记的注册记录（无则 undefined）。 */
    mountSlot(name) {
      const rec = injects.find((x) => x.name === name);
      if (!rec) return undefined;
      activeInject = rec;
      try {
        rec.factory();
      } finally {
        activeInject = null;
      }
      return regs.find((r) => r.via === rec);
    },
  };
}

/** fake hook-React：白名单 hook，同一视图实例内 hook 槽跨渲染保持。 */
export function makeHookReact() {
  const st = { hooks: [], index: 0, dirty: false };
  const React = {
    Fragment: Symbol("Fragment"),
    createElement(type, props, ...children) {
      return { type, props: props ?? null, children };
    },
    useState(initial) {
      const i = st.index++;
      if (!(i in st.hooks)) st.hooks[i] = typeof initial === "function" ? initial() : initial;
      const set = (v) => {
        st.hooks[i] = typeof v === "function" ? v(st.hooks[i]) : v;
        st.dirty = true;
      };
      return [st.hooks[i], set];
    },
    useEffect(fn) {
      const i = st.index++;
      if (!(i in st.hooks)) {
        st.hooks[i] = true;
        fn();
      }
    },
    useCallback: (f) => f,
    useMemo: (f) => f(),
    useRef(init) {
      const i = st.index++;
      if (!(i in st.hooks)) st.hooks[i] = { current: init };
      return st.hooks[i];
    },
    useId() {
      const i = st.index++;
      if (!(i in st.hooks)) st.hooks[i] = `dsh-id-${i}`;
      return st.hooks[i];
    },
  };
  return {
    React,
    /** 单次渲染：重置游标，返回树并报告本轮是否有 setState（脏标）。 */
    render(Component, props) {
      st.index = 0;
      st.dirty = false;
      const tree = Component(props);
      return { tree, dirty: st.dirty };
    },
  };
}

/** 挂载「网页搜索链」区域（SET-001 registration + 组件），返回视图。 */
export async function loadSection(tag) {
  const regs = await importSelfRegister(tag);
  assert.equal(regs.length, 1, `自注册须恰 1 次（现 ${regs.length}）`);
  const hook = makeHookReact();
  const require = (spec) => (spec === "react" ? hook.React : undefined);
  const product = regs[0].factory(require);
  const h = makeLiveCtx();
  product.apply(h.ctx);
  const rec = h.mountSlot(SECTION_SLOT);
  assert.ok(rec, `apply 后须经 ctx.slots.inject("${SECTION_SLOT}") 登记区域（SET-001）`);
  return { h, hook, rec, Component: rec.Component, registration: rec.registration };
}

/** 渲染到稳：反复渲染并让出事件循环，使 useEffect 内的 describe 回包被吸收（不用真实定时器）。 */
export async function settle(view, rounds = 12) {
  let tree = null;
  for (let i = 0; i < rounds; i++) {
    const out = view.hook.render(view.Component, { close() {} });
    tree = out.tree;
    await new Promise((r) => setImmediate(r));
    if (!out.dirty && i > 2) break;
  }
  return view.hook.render(view.Component, { close() {} }).tree;
}

/** 交互 = 调用回调后重新沉降。 */
export async function act(view, fn) {
  fn();
  return settle(view);
}

// ────────────────────────────────────────────────────────────────────────────────────────
// 渲染树查询（只遍历 children；props 不展开）
// ────────────────────────────────────────────────────────────────────────────────────────

export function allNodes(tree) {
  const out = [];
  const visit = (n) => {
    if (n === null || n === undefined || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    out.push(n);
    visit(n.children);
  };
  visit(tree);
  return out;
}

/** 树内全部可见文本（children 文本 + aria-label/title/placeholder）。 */
export function textOf(tree) {
  const out = [];
  const visit = (n) => {
    if (n === null || n === undefined || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      out.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    if (typeof n === "object") {
      if (n.props) {
        for (const k of ["aria-label", "title", "placeholder"]) {
          if (typeof n.props[k] === "string") out.push(n.props[k]);
        }
      }
      visit(n.children);
    }
  };
  visit(tree);
  return out.join("\n");
}

/**
 * 明文泄漏扫描（D-2C P0）：在渲染文本与所有 props 字符串中查找 needle。
 * 唯一豁免：key 输入框（data-field="key"）的 value 属性，仅当 allowDraftInput=true（草稿输入期间，受控输入必然持有）。
 * 保存成功后应为零豁免，故调用方在成功路径上不传 allowDraftInput。
 */
export function leaksIn(tree, needle, { allowDraftInput = false } = {}) {
  const hits = [];
  if (textOf(tree).includes(needle)) hits.push("text");
  for (const n of allNodes(tree)) {
    const p = n.props ?? {};
    for (const [k, v] of Object.entries(p)) {
      if (typeof v !== "string" || !v.includes(needle)) continue;
      if (allowDraftInput && k === "value" && p["data-field"] === "key") continue;
      hits.push(`props.${k}@${p["data-role"] ?? String(n.type)}`);
    }
  }
  return hits;
}

/** 按 data-role（可选 entry id / type / field）查找节点。 */
export function byRole(tree, role, filter = {}) {
  return allNodes(tree).filter((n) => {
    const p = n.props;
    if (!p || p["data-role"] !== role) return false;
    if (filter.entryId !== undefined && p["data-entry-id"] !== filter.entryId) return false;
    if (filter.type !== undefined && p["data-type"] !== filter.type) return false;
    if (filter.field !== undefined && p["data-field"] !== filter.field) return false;
    return true;
  });
}

/** 恰好一个匹配节点，否则带可读描述失败。 */
export function one(tree, role, filter = {}) {
  const xs = byRole(tree, role, filter);
  assert.equal(xs.length, 1, `期望恰 1 个 data-role="${role}" ${JSON.stringify(filter)} 的控件，实得 ${xs.length} 个`);
  return xs[0];
}

export function fire(node, prop, event = {}) {
  assert.ok(node && node.props && typeof node.props[prop] === "function", `控件缺少回调 ${prop}`);
  return node.props[prop](event);
}

/** 卡片（按条目 id）的视觉顺序。 */
export function cardOrder(tree) {
  return byRole(tree, ROLE.card).map((n) => n.props["data-entry-id"]);
}

// ────────────────────────────────────────────────────────────────────────────────────────
// 请求分类与替身（C-5 settings、C-6 credentials、C-4 host）
// ────────────────────────────────────────────────────────────────────────────────────────

function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
}

/**
 * 请求分类：method 字符串与 URL 路径都参与匹配（端点名形态未实证，两者任一命中即可）。
 * 返回 "settings/describe" | "settings/mutate" | "credentials/describe" | "credentials/set" |
 * "credentials/unset" | "other"。
 */
export function classifyCall(method, path) {
  const name = `${typeof method === "string" ? method : ""} ${path}`;
  if (/settings\/describe(?![a-z])/.test(name)) return "settings/describe";
  if (/settings\/mutate(?![a-z])/.test(name)) return "settings/mutate";
  const m = /credentials\/(describe|set|unset)(?![a-z])/.exec(name);
  if (m) return `credentials/${m[1]}`;
  return "other";
}

/** 同源 /api/ 判定：相对 URL 或与 TEST_ORIGIN 同 origin 的绝对 URL，且路径以 /api/ 开头。 */
export function isSameOriginApi(url) {
  const u = new URL(String(url), TEST_ORIGIN);
  return u.origin === TEST_ORIGIN && u.pathname.startsWith("/api/");
}

/** 递归收集全部字符串叶子（用于读取请求体中的 ref / key，不依赖 args 的位置或命名传形）。 */
export function collectStrings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (v && typeof v === "object") {
    for (const x of Object.values(v)) collectStrings(x, out);
  }
  return out;
}

/** credentials/describe 回包（D-2C）：包装形状未实证，仅替身备好；断言不强制其形状。 */
export function credentialsDescribeReply(state, refs) {
  return {
    ok: true,
    result: {
      credentials: refs.map((ref) => {
        const c = state.credentials[ref];
        return c
          ? { ref, configured: true, source: "host", writable: true, masked: c.masked }
          : { ref, configured: false, writable: true };
      }),
    },
  };
}

function maskOf(key) {
  return key ? `sk-****${key.slice(-4)}` : "";
}

/**
 * 安装同源 settings + credentials 替身。白名单外（非同源 /api/、或分类为 other）一律记为出站并以 599 拒绝。
 * 请求按序记录（seq），便于断言「credentials/set 先于 settings/mutate」。
 */
export function installSettingsFetch(state) {
  const calls = [];
  const outbound = [];
  const held = []; // R-2：挂起中的 mutate 释放函数
  const saved = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const fake = async (url, init = {}) => {
    const path = new URL(String(url), TEST_ORIGIN).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : null;
    const kind = classifyCall(body?.method, path);
    calls.push({ seq: calls.length, url: String(url), path, method: init.method, kind, body });
    if (!isSameOriginApi(url) || kind === "other") {
      outbound.push(String(url));
      return { ok: false, status: 599, json: async () => ({ ok: false }), text: async () => "" };
    }
    const args = body?.payload?.args ?? {};
    if (kind === "settings/describe") {
      const ns = { ns: SECTION_ID, autoGenerate: false, base: clone(state.base ?? {}), user: clone(state.user) };
      if (!state.omitRevision) ns.revision = state.revision;
      return jsonResponse({ ok: true, result: { writable: true, hasDocument: true, namespaces: [ns] } });
    }
    if (kind === "settings/mutate") {
      if (state.deferMutate) {
        await new Promise((resolve) => held.push(resolve));
      }
      if (state.mutateMode === "save-failed") {
        return jsonResponse({ ok: false, error: { code: "CONFIG_SAVE_FAILED", message: "synthetic save failure" } });
      }
      if (state.mutateMode === "conflict") {
        return jsonResponse({ ok: false, error: { code: "CONFIG_CONFLICT", message: "revision mismatch" } });
      }
      if (args.expectedRevision !== state.revision) {
        return jsonResponse({ ok: false, error: { code: "CONFIG_CONFLICT", message: "revision mismatch" } });
      }
      state.user = applyOps(state.user, args.ops ?? []);
      state.revision += 1;
      return jsonResponse({ ok: true, result: { ok: true } });
    }
    if (kind === "credentials/describe") {
      return jsonResponse(credentialsDescribeReply(state, collectStrings(args)));
    }
    if (kind === "credentials/set") {
      if (state.credentialMode === "network") throw new TypeError("fetch failed (synthetic network error)");
      const strings = collectStrings(args);
      const ref = strings.find((s) => s.toLowerCase().startsWith(CRED_PREFIX.toLowerCase())) ?? strings[0];
      // R-1：宿主 set 必过 credentialRef 语法；冒号等非法形态一律拒绝（与真宿主同形，零写入）。
      if (!REF_GRAMMAR.test(String(ref))) {
        return jsonResponse({ ok: false, error: { code: "bad-request", message: "credential reference outside grammar" } });
      }
      if (state.credentialMode === "rejected") {
        return jsonResponse({
          ok: false,
          error: { code: "credential-rejected", message: "synthetic provider rejection: key not accepted", details: { ref } },
        });
      }
      const key = strings.find((s) => s !== ref) ?? "";
      state.credentials[ref] = { configured: true, writable: true, masked: maskOf(key) };
      return jsonResponse({ ok: true, result: null });
    }
    if (kind === "credentials/unset") {
      const ref = collectStrings(args)[0];
      delete state.credentials[ref];
      return jsonResponse({ ok: true, result: null });
    }
    outbound.push(String(url));
    return { ok: false, status: 599, json: async () => ({ ok: false }), text: async () => "" };
  };
  globalThis.fetch = fake;
  return {
    calls,
    outbound,
    mutates: () => calls.filter((c) => c.kind === "settings/mutate"),
    /** R-2：当前挂起中的 mutate 数。 */
    pendingMutates: () => held.length,
    /** R-2：释放全部挂起的 mutate（幂等）；返回释放的个数。 */
    releaseMutate() {
      const rs = held.splice(0);
      for (const r of rs) r();
      return rs.length;
    },
    describes: () => calls.filter((c) => c.kind === "settings/describe"),
    credentialSets: () => calls.filter((c) => c.kind === "credentials/set"),
    credentialCalls: () => calls.filter((c) => c.kind.startsWith("credentials/")),
    restore() {
      if (saved) Object.defineProperty(globalThis, "fetch", saved);
      else delete globalThis.fetch;
    },
  };
}

/** 安装 host 半通道替身（C-4）：记录任何 host.call，用于断言面板操作零调用。 */
export function installHostCall() {
  const calls = [];
  const saved = Object.getOwnPropertyDescriptor(globalThis, "host");
  globalThis.host = {
    call: async (method, args) => {
      calls.push({ method, args: clone(args) });
      return { ok: true };
    },
  };
  return {
    calls,
    restore() {
      if (saved) Object.defineProperty(globalThis, "host", saved);
      else delete globalThis.host;
    },
  };
}

/** 记录型 console 替身：捕获 log/info/warn/error/debug 的全部输出，用于断言明文不入日志。 */
export function installConsole() {
  const lines = [];
  const names = ["log", "info", "warn", "error", "debug"];
  const saved = Object.fromEntries(names.map((n) => [n, console[n]]));
  const show = (x) => {
    if (typeof x === "string") return x;
    try {
      return JSON.stringify(x);
    } catch {
      return String(x);
    }
  };
  for (const n of names) console[n] = (...xs) => lines.push(xs.map(show).join(" "));
  return {
    lines,
    text: () => lines.join("\n"),
    restore() {
      for (const n of names) console[n] = saved[n];
    },
  };
}

/** 在一组替身下运行用例；无论成败都还原全局。 */
export async function withEnv(state, fn) {
  const fetchStub = installSettingsFetch(state);
  const hostStub = installHostCall();
  const consoleStub = installConsole();
  try {
    return await fn({ fetchStub, hostStub, consoleStub, state });
  } finally {
    consoleStub.restore();
    fetchStub.restore();
    hostStub.restore();
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────
// 权威 reducer（测试内独立实现，与宿主 mutate 补丁语义同形：数值段 = 数组下标）
// ────────────────────────────────────────────────────────────────────────────────────────

function applyOne(root, op) {
  const segs = op.path.map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  let node = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (node[k] === undefined || node[k] === null) node[k] = typeof segs[i + 1] === "number" ? [] : {};
    node = node[k];
  }
  const last = segs[segs.length - 1];
  if (op.op === "set") node[last] = clone(op.value);
  else if (Array.isArray(node) && typeof last === "number") node.splice(last, 1);
  else delete node[last];
}

/** 对 user 层应用一组 ops，返回新层（不改原对象）。 */
export function applyOps(layer, ops) {
  const out = clone(layer ?? {});
  for (const op of ops) applyOne(out, op);
  return out;
}

/** 递归收集键名命中 SECRET_FIELD 的路径（P0 面）。 */
export function secretPathsIn(value, path = "$", hits = []) {
  if (value === null || typeof value !== "object") return hits;
  for (const [k, v] of Array.isArray(value) ? value.entries() : Object.entries(value)) {
    if (SECRET_FIELD.test(String(k))) hits.push(`${path}.${k}`);
    secretPathsIn(v, `${path}.${k}`, hits);
  }
  return hits;
}

/** 取出 mutate 调用携带的 ops 数组（args.ops）。 */
export function opsOf(call) {
  return call.body?.payload?.args?.ops ?? [];
}
