// Issue #46 v0.1 配置 UI 契约（oracle）——bundle 页配置入口（docs/specs/draft/bundle-config-ui.md）。
//
// 本文件不改实现，只钉三面红：
//   第 1 组 BCF-001 注册线：client factory 追加 plugins.bundle.config 注册（keyed，key=包名）；
//   第 2 组 BCF-002 组件渲染冒烟：view:'page' 三范围控件、form prop undefined-safe、无 apiKey 输入、
//           挂载经 host.call('config.get')；零 DOM headless；
//   第 3 组 BCF-003/004/005 宿主半 src/config-bridge.js 的 config.get / config.put：
//           readConfig 语义、合并语义（apiKey/未知字段透传钉、不新增 apiKey）、写闸 issues、
//           SAVE_FAILED 可操作且零秘密回显、成功经 readConfig 读回；
//   第 4 组 纯增量守卫：src/index.js web provider 面不动；verify:ui-46 独立于 npm test。
//
// ─── 宿主实测契约（bundle-config-ui.md 契约节 [C1]–[C7]，0.2.2-rc.5，2026-11-25 取信）──────
//   [C1] plugins.bundle.config：keyed，key=bundle 包名；bundle 页在描述与 rows 间渲染
//        renderSlot('plugins.bundle.config', {view:'page'}, {entryKey: pkg.name})——**不传 form**。
//        form?:ConfigPageForm 仅类型面存在，方法面未实证 → 裁决：组件自管读写走 host.call，
//        form prop 必须 undefined-safe（宿主传不传都渲染）。
//   [C2] 注册活样本：ctx.slots.inject('plugins.bundle.config', () =>
//          ctx.slots.register({ name:'plugins.bundle.config', key:'<包名>', locale, inject }, Component))
//   [C3] client builtin：ctx / React（无 JSX）/ host.call（包私有 → 本包宿主半）/ styles / console。
//        本文件 ctx 替身在 slots/effect 之外提供 host.call 记录面；ctx.host 缺席亦不得炸。
//   [C6] 无 URL 路由；DOM 锚点与 CDP 面属 scripts/verify-ui-46.mjs（BCF-007），不在本文件。
//
// ─── react 通道实况（bundle-config-ui.md 设计决定）───────────────────────────────────────
//   「React 用软链 store 的 react」在 node 侧实证不可得：node_modules（软链）下 react/react-dom
//   MODULE_NOT_FOUND（2026-11-25 探测）。故渲染冒烟经 factory 注入的 require('react') 通道喂
//   fake hook-React（createElement + useState/useEffect/useCallback/useMemo/useRef/useId 白名单
//   stub）；组件用白名单外 hook 须先迁移规格 whitelist。真实 react 渲染由 verify-ui-46 在宿主
//   窗口内实证（BCF-007）。
//
// ─── 红/绿约定（helpers/impl.js）─────────────────────────────────────────────────────────
//   红不得改 skip、不得删断言，只能经实现转绿。预计红：第 1/2 组（现 client-entry 只注册
//   settings.section，无 bundle config 注册）、第 3 组（src/config-bridge.js 缺失）；
//   settings-client-wire.test.js 另有 1 例因 BCF-006 指引文案迁移而红（同 PR 语境）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";

const WP = "#46 bundle config entry（plugins.bundle.config + config-bridge）";
const SLOT = "plugins.bundle.config";
const SECTION_SLOT = "settings.section";
const SECTION_ID = "search-chain"; // 行 id / provider id
const PACKAGE_ID = "dsh-search-chain"; // 包名 = 注册 key（[C1] keyed by 包名，非行 id）
const PACKAGE_JSON = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

// ════════════════════════════════════════════════════════════════════════════════════════
// 装载线替身（与 settings-client-wire.test.js 同型：cache-bust import 捕获自注册；
// ctx 另带 host.call 记录面 [C3]）
// ════════════════════════════════════════════════════════════════════════════════════════

let bustCounter = 0;

async function importSelfRegister(tag) {
  const registrations = [];
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  globalThis.window = {
    __ModuleLoader__: {
      load(reg) {
        registrations.push(reg);
      },
    },
  };
  try {
    await import(`../src/client-entry.js?v=${tag}-${++bustCounter}`);
  } finally {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else delete globalThis.window;
  }
  return registrations;
}

/** 装载 + factory(fakeRequire) 产物；自注册/factory 面不成立时以可读红止步（前置依赖钉）。 */
async function loadProduct(tag, reactValue) {
  const registrations = await importSelfRegister(tag);
  if (registrations.length !== 1 || typeof registrations[0].factory !== "function") {
    assert.fail(
      `本组以 __ModuleLoader__.load 自注册 + factory 产物为前置（现 load ${registrations.length} 次）；` +
        `见 settings-client-wire.test.js 第 1/3 组（[M1]，红属预期则先修装载线）`,
    );
  }
  const specs = [];
  const require = (spec) => {
    specs.push(spec);
    return spec === "react" ? reactValue : undefined;
  };
  return { product: registrations[0].factory(require), specs };
}

/**
 * live 形状 client ctx（[C3]）：slots.inject/slots.register/effect + host.call。
 * host=null 时不挂 host 属性（ctx.host 缺席面钉）。
 */
function makeCtx({ host = null } = {}) {
  const injects = [];
  const regs = [];
  const effects = [];
  let activeInject = null;
  const ctx = {
    slots: {
      inject(name, factory) {
        const rec = { name, factory };
        injects.push(rec);
        let off = false;
        return () => {
          if (off) return;
          off = true;
          const i = injects.indexOf(rec);
          if (i >= 0) injects.splice(i, 1);
        };
      },
      register(registration, Component) {
        const rec = { registration, Component, via: activeInject };
        regs.push(rec);
        let off = false;
        return () => {
          if (off) return;
          off = true;
          const i = regs.indexOf(rec);
          if (i >= 0) regs.splice(i, 1);
        };
      },
    },
    effect(fn) {
      effects.push(fn);
    },
  };
  if (host) ctx.host = host;
  return {
    ctx,
    injects,
    regs,
    effects,
    /** 执行指定槽名的 inject 懒工厂（宿主挂载时点替身），返回注册记录或 undefined。 */
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

/** host.call 记录面：兼容 host.call(name, input) 与 host.call({method|name, input}) 两种传形。 */
function makeFakeHost(resultByMethod) {
  const calls = [];
  return {
    calls,
    call: (...args) => {
      const first = args[0];
      const method =
        typeof first === "string" ? first : (first && (first.method ?? first.name)) ?? String(first);
      const input = typeof first === "string" ? args[1] : first && first.input;
      calls.push({ method, input });
      const responder = resultByMethod?.[method];
      return Promise.resolve(typeof responder === "function" ? responder(input) : responder);
    },
  };
}

/** DOM 陷阱（wire test 同型）：记点=对 DOM 对象的属性访问/赋值。 */
function installDomTrap() {
  const touches = [];
  const DOM_WINDOW_PROPS = new Set([
    "addEventListener", "removeEventListener", "requestAnimationFrame", "cancelAnimationFrame",
    "matchMedia", "getComputedStyle", "location", "history", "localStorage", "sessionStorage",
    "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "ResizeObserver",
  ]);
  const doc = new Proxy(Object.create(null), {
    get(_t, prop) {
      if (typeof prop === "symbol") return undefined;
      touches.push(`document.${String(prop)}`);
      return undefined;
    },
    set(_t, prop) {
      touches.push(`document.${String(prop)}=<set>`);
      return true;
    },
  });
  const win = new Proxy(Object.create(null), {
    get(_t, prop) {
      if (typeof prop === "symbol") return undefined;
      const p = String(prop);
      if (p === "document") return doc;
      if (DOM_WINDOW_PROPS.has(p)) touches.push(`window.${p}`);
      return undefined;
    },
    set(_t, prop) {
      const p = String(prop);
      if (DOM_WINDOW_PROPS.has(p)) touches.push(`window.${p}=<set>`);
      return true;
    },
  });
  const saved = new Map();
  for (const [name, val] of [["window", win], ["document", doc]]) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, get: () => val });
  }
  return {
    touches,
    restore() {
      for (const [name, d] of saved) {
        if (d) Object.defineProperty(globalThis, name, d);
        else delete globalThis[name];
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────
// fake hook-React（设计决定：whitelist = createElement + useState/useEffect/useCallback/
// useMemo/useRef/useId/Fragment；白名单外 hook 属规格迁移项）
// ────────────────────────────────────────────────────────────────────────────────────────

function makeHookReact() {
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
        try {
          fn();
        } catch {
          /* effect 内异常不算渲染异常；状态变化由 dirty/flush 反映 */
        }
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
      if (!(i in st.hooks)) st.hooks[i] = "dsh-id-" + i;
      return st.hooks[i];
    },
  };
  /** 渲染到稳定（setImmediate 逐轮 flush microtask；effect 的异步 get 回调据此落到下一轮树）。 */
  async function renderStable(Component, props, maxPasses = 10) {
    let tree = null;
    for (let pass = 0; pass < maxPasses; pass++) {
      st.index = 0;
      st.dirty = false;
      tree = Component(props);
      if (!st.dirty) break;
      await new Promise((r) => setImmediate(r));
    }
    return tree;
  }
  return { React, renderStable };
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (typeof node === "object" && "props" in node && "children" in node) {
    visit(node);
    walk(node.children, visit);
    if (node.props && "children" in node.props) walk(node.props.children, visit);
  }
}

function findByAttr(tree, attr, value) {
  const hits = [];
  walk(tree, (n) => {
    const p = n.props;
    if (p && attr in p && (value === undefined || String(p[attr]) === String(value))) hits.push(n);
  });
  return hits;
}

function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, out);
    return out;
  }
  if (typeof node === "object") {
    if ("children" in node) collectText(node.children, out);
    if (node.props && "children" in node.props) collectText(node.props.children, out);
  }
  return out;
}

/** 注册记录解构：注册存在性/键面不成立时给可定位红（[C1][C2] BCF-001）。 */
function requireBundleReg(h) {
  const rec = h.mountSlot(SLOT);
  if (!rec) {
    assert.fail(
      `apply 后须经 ctx.slots.inject("${SLOT}", 懒工厂) 注册 bundle 配置区且挂载产出 register（[C1][C2] ` +
        `BCF-001）；现 injects=${JSON.stringify(h.injects.map((x) => x.name))}——` +
        `现实现只注册 settings.section，bundle 页只有启用开关（#46 症状本体），红属预期`,
    );
  }
  return rec;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 1. 注册线（BCF-001）
// ════════════════════════════════════════════════════════════════════════════════════════

test("#46 注册线：apply 后 settings.section 与 plugins.bundle.config 各恰一次 inject；挂载后 register 收 {name,key} 与组件工厂（[C1][C2] BCF-001）", async () => {
  const { React } = makeHookReact();
  const { product } = await loadProduct("reg-wire", React);
  const h = makeCtx({ host: makeFakeHost({}) });
  product.apply(h.ctx);
  const names = h.injects.map((x) => x.name);
  assert.ok(
    names.includes(SECTION_SLOT),
    `settings.section 注册不得被移动或挤掉；现 injects=${JSON.stringify(names)}`,
  );
  assert.equal(
    names.filter((n) => n === SLOT).length,
    1,
    `须恰调用 ctx.slots.inject("${SLOT}", …) 1 次；现 ${names.filter((n) => n === SLOT).length} 次 ` +
      `（现实现无 bundle 配置注册 = #46 缺口，红属预期）`,
  );
  const rec = requireBundleReg(h);
  const reg = rec.registration;
  assert.ok(reg && typeof reg === "object", "register 第一参须为 registration 对象");
  assert.equal(reg.name, SLOT, "registration.name 须为槽名（[C2] 活样本同形）");
  assert.equal(typeof rec.Component, "function", "register 第二参须为组件工厂函数（[C1] renderSlot 渲染目标）");
});

test("#46 注册幂等：同一 ctx.slots 重复 apply 每槽恰一次 inject；挂载后每槽恰一次 register（BCF-001）", async () => {
  const { React } = makeHookReact();
  const { product } = await loadProduct("reg-idem", React);
  const h = makeCtx({ host: makeFakeHost({}) });
  product.apply(h.ctx);
  product.apply(h.ctx); // 第二次 apply：不得产生第二个 inject（任一槽）
  for (const slot of [SECTION_SLOT, SLOT]) {
    assert.equal(
      h.injects.filter((x) => x.name === slot).length,
      1,
      `重复 apply 后槽 "${slot}" 仍须恰 1 次 inject；现 ${h.injects.filter((x) => x.name === slot).length} 次`,
    );
  }
  assert.ok(h.mountSlot(SECTION_SLOT), "settings.section 挂载须产出注册");
  const rec = requireBundleReg(h);
  assert.equal(
    h.regs.filter((r) => r.registration?.name === SLOT).length,
    1,
    `plugins.bundle.config 挂载后恰 1 个注册（重复 apply + 挂载不得双注册）；现 ${h.regs.filter((r) => r.registration?.name === SLOT).length} 个`,
  );
  void rec;
});

test("#46 注册 key 恰为包名 dsh-search-chain（非行 id search-chain）；附加键仅限 {id,order,label,locale,inject}（keyed 槽，BCF-001）", async () => {
  const { React } = makeHookReact();
  const { product } = await loadProduct("reg-key", React);
  const h = makeCtx({ host: makeFakeHost({}) });
  product.apply(h.ctx);
  const reg = requireBundleReg(h).registration;
  assert.ok("key" in reg, `keyed 槽注册必须带 key（[C1] key=bundle 包名）；现键：${JSON.stringify(Object.keys(reg))}`);
  assert.equal(reg.key, PACKAGE_ID, `注册 key 恒 = 包名 "${PACKAGE_ID}"（宿主以包名 dispatch entryKey，[C1]）；行 id "${SECTION_ID}" 是错误键`);
  assert.equal(reg.key, PACKAGE_JSON.name, "注册 key 须与 package.json name 一致");
  const extra = Object.keys(reg).filter((k) => k !== "name" && k !== "key");
  const ALLOWED = new Set(["id", "order", "label", "locale", "inject"]);
  for (const k of extra) {
    assert.ok(ALLOWED.has(k), `registration 附加键 "${k}" 不在允许集 {name,key,id,order,label,locale,inject}（[C2] 活样本键域）`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 2. 组件渲染冒烟（BCF-002）
// ════════════════════════════════════════════════════════════════════════════════════════

/** 挂载 bundle 配置组件并返回 { rec, h }。 */
async function mountBundleComponent(tag, hostResult) {
  const { React, renderStable } = makeHookReact();
  const host = makeFakeHost(hostResult ?? {});
  const { product } = await loadProduct(tag, React);
  const h = makeCtx({ host });
  product.apply(h.ctx);
  const rec = requireBundleReg(h);
  return { React, renderStable, host, rec, h };
}

test("#46 渲染冒烟（form=undefined-safe）：view:'page' 渲染三范围控件（条目增删改/官方开关/timeoutMs）；无 apiKey 输入；零 DOM（BCF-002 [C1]）", async () => {
  const { renderStable, host, rec } = await mountBundleComponent("render-page", {
    "config.get": () => ({ ok: true, config: { entries: [], useOfficialDeepSeekSearch: true, timeoutMs: 25000 } }),
  });
  const trap = installDomTrap();
  let tree, failure = null;
  try {
    // 宿主 bundle 级渲染实证只传 {view:'page'}（[C1] renderSlot 原文不含 form）：
    tree = await renderStable(rec.Component, { view: "page" });
  } catch (e) {
    failure = e;
  } finally {
    trap.restore();
  }
  assert.equal(trap.touches.length, 0, `headless 渲染零 DOM 接触被违反：${JSON.stringify(trap.touches)}`);
  if (failure) {
    assert.fail(`Component({view:'page'})（无 form prop，[C1] 实证宿主不传）不得抛——form 必须 undefined-safe：${failure.message}`);
  }
  assert.ok(tree !== null && tree !== undefined, "假 react 在场时页面视图须产出节点树（v0.1 表单入口）");
  const marks = {
    "timeoutMs 数值输入": findByAttr(tree, "data-config-field", "timeoutMs"),
    "官方搜索开关": findByAttr(tree, "data-config-field", "useOfficialDeepSeekSearch"),
    "添加条目入口": findByAttr(tree, "data-config-action", "add-entry"),
    "保存入口": findByAttr(tree, "data-config-action", "save"),
  };
  for (const [label, hits] of Object.entries(marks)) {
    assert.ok(hits.length >= 1, `三范围控件缺「${label}」（[data-config-*] 锚点见 bundle-config-ui.md BCF-002，DOM 契约与 verify-ui-46 共用）；未命中`);
  }
  const flat = collectText(tree, []).join("") + JSON.stringify(tree);
  assert.ok(!/apikey/i.test(flat) && !/api_key/i.test(flat), "apiKey 输入/标签不得出现在表单任何位置（凭据边界 v0.1 不变，BCF-002）");
  void host;
});

test("#46 form prop 安全与 summary 视图：form=undefined / 任意宿主对象均正常渲染；summary 无输入控件（BCF-002 [C1]）", async () => {
  const { renderStable, rec } = await mountBundleComponent("render-form-safe", {
    "config.get": () => ({ ok: true, config: { entries: [], useOfficialDeepSeekSearch: true, timeoutMs: 25000 } }),
  });
  // 未实证宿主对象冒充 ConfigPageForm：组件不得赌其方法面（方法名未实证 = 不可调用）。
  const fakeForm = { view: "page", someHostHandle: {} };
  for (const props of [{ view: "page" }, { view: "page", form: undefined }, { view: "page", form: fakeForm }]) {
    let tree;
    try {
      tree = await renderStable(rec.Component, props);
    } catch (e) {
      assert.fail(`props=${JSON.stringify(Object.keys(props))} 渲染不得抛（form 传不传、传什么都必须渲染，#46 裁决 1）：${e.message}`);
    }
    assert.ok(findByAttr(tree, "data-config-field", "timeoutMs").length >= 1, "三种 form 给法下三范围控件必须在场");
  }
  const summary = await renderStable(rec.Component, { view: "summary" });
  const inputs = [];
  walk(summary, (n) => {
    if (n.type === "input" || n.type === "textarea" || n.type === "select") inputs.push(n.type);
  });
  assert.deepEqual(inputs, [], `view:'summary' 必须轻量（不得含表单输入控件）；现含：${JSON.stringify(inputs)}`);
});

test("#46 挂载读取线：组件经 host.call('config.get') 拉当前配置，返回值回填控件；ctx.host 缺席时挂载/渲染不抛（BCF-002/003 [C3]）", async () => {
  const { renderStable, host, rec } = await mountBundleComponent("render-get", {
    "config.get": () => ({
      ok: true,
      config: { entries: [{ id: "e1", type: "bing", name: "keep-me", enabled: true }], useOfficialDeepSeekSearch: false, timeoutMs: 9999 },
    }),
  });
  const tree = await renderStable(rec.Component, { view: "page" });
  const getCall = host.calls.find((c) => c.method === "config.get");
  assert.ok(getCall, `挂载必须经 host.call("config.get") 读取生效配置（宿主半方法名钉，#46 裁决 1）；实收调用：${JSON.stringify(host.calls.map((c) => c.method))}`);
  const flat = JSON.stringify(tree);
  assert.ok(flat.includes("9999"), "config.get 返回的 timeoutMs 必须回填到渲染树（9999）");
  assert.ok(flat.includes("keep-me"), "config.get 返回的条目标签必须回填到渲染树（keep-me）");

  // ctx.host 缺席：apply 与渲染全程不得抛（宿主半不可用时的安全降级）。
  const bare = await mountBundleComponentBare("render-nohost");
  assert.ok(true, "无 host 的 apply/挂载/渲染全程未抛");
  void bare;
});

async function mountBundleComponentBare(tag) {
  const { React, renderStable } = makeHookReact();
  const { product } = await loadProduct(tag, React);
  const h = makeCtx({ host: null }); // 无 host builtin 的 ctx（降级面）
  product.apply(h.ctx);
  const rec = requireBundleReg(h);
  return renderStable(rec.Component, { view: "page" });
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 3. 宿主半 config.get / config.put（src/config-bridge.js；BCF-003/004/005）
// ════════════════════════════════════════════════════════════════════════════════════════

/** writeConfig 同线 settings 替身：{editor.edit(entry, mutate), entry, current()}，raw 层可观测。 */
function makeBridgeSettings(initialRaw, opts = {}) {
  const state = { raw: structuredClone(initialRaw ?? {}) };
  const calls = { edit: 0 };
  const settings = {
    editor: {
      async edit(_entry, mutate) {
        calls.edit++;
        if (opts.failEdit) throw new Error("宿主拒绝写入（模拟）");
        const next = mutate(structuredClone(state.raw), {});
        if (next === null || typeof next !== "object" || Array.isArray(next)) {
          throw new Error("mutate 须返回新 raw 整体对象（writeConfig 同通道约定）");
        }
        state.raw = next;
      },
    },
    entry: { id: "host-entry-1" },
    current: () => {
      if (opts.rowUnreachable) {
        throw new Error("本插件配置行不在宿主活行中（B1′ 行不可用）");
      }
      return structuredClone(state.raw);
    },
  };
  return { settings, state, calls };
}

async function loadBridge(t) {
  const res = await tryImportSrc("config-bridge.js");
  if (!res.ok) {
    failIfUnimplemented(t, res, "WP#46 src/config-bridge.js（宿主半 config.get/config.put）", "BCF-003/004/005");
  }
  assert.equal(typeof res.module.createConfigBridge, "function", "src/config-bridge.js 须导出 createConfigBridge(settings)（规格设计决定：宿主半模块落点）");
  const bridge = res.module.createConfigBridge;
  return { createConfigBridge: bridge };
}

const LEGACY_RAW = {
  entries: [
    {
      id: "e1", type: "bing", name: "旧名", enabled: true,
      apiKey: "S1-LEGACY-SECRET", customParam: 7, vendorExtra: { a: 1 }, credentialRef: "old-ref",
    },
    { id: "e0", type: "tavily", name: "将被移除", enabled: true },
  ],
  someOtherKey: "keep",
  timeoutMs: 30000,
  useOfficialDeepSeekSearch: true,
};

test("#46 config.get：{} 行 → normalizeConfig 缺省补全的生效快照（深冻结）；行不可读回传 ok:false，禁静默快照（BCF-003）", async (t) => {
  const { createConfigBridge } = await loadBridge(t);
  const { settings } = makeBridgeSettings({});
  const bridge = createConfigBridge(settings);
  assert.equal(typeof bridge["config.get"], "function", "bridge 须暴露方法 'config.get'（宿主半命名钉，规格设计决定）");
  const res = await bridge["config.get"]();
  assert.equal(res.ok, true, `get 成功须 {ok:true}；实收：${JSON.stringify(res)}`);
  assert.deepEqual(
    res.config,
    { entries: [], useOfficialDeepSeekSearch: true, timeoutMs: 25000 },
    "config.get 复用 readConfig 语义：缺省补全 entries=[]/official=true/timeoutMs=25000",
  );
  assert.ok(Object.isFrozen(res.config), "readConfig 语义含深冻结快照");

  const bad = makeBridgeSettings({}, { rowUnreachable: true });
  const badRes = await createConfigBridge(bad.settings)["config.get"]();
  assert.equal(badRes.ok, false, "行不可用必须回传 ok:false（B1′ 禁静默回退装载快照）");
  assert.ok(typeof badRes.message === "string" && badRes.message.length > 0, "读取故障必须带可操作 message");
  assert.ok(typeof badRes.code === "string" && badRes.code.length > 0, "读取故障必须带 code（CONFIG_ROW_UNAVAILABLE 语义沿用）");
});

test("#46 config.put 合并语义：管理字段覆盖；apiKey/未知字段原样透传；条目集合与顺序=表单权威；顶层未知键保留（BCF-004）", async (t) => {
  const { createConfigBridge } = await loadBridge(t);
  const { settings, state, calls } = makeBridgeSettings(LEGACY_RAW);
  const res = await createConfigBridge(settings)["config.put"]({
    entries: [
      { id: "e1", type: "bing", name: "新名", enabled: false, credentialRef: "new-ref" },
      { id: "e2", type: "tavily", name: "t1", enabled: true },
    ],
    useOfficialDeepSeekSearch: false,
    timeoutMs: 41000,
  });
  assert.equal(res.ok, true, `put 合法产物须成功；实收：${JSON.stringify(res)}`);
  assert.equal(calls.edit, 1, "成功路径恰一次宿主写入");
  const raw = state.raw;
  assert.equal(raw.someOtherKey, "keep", "顶层未知键必须原样保留（只覆盖自有管理键，writeConfig 同通道约定）");
  assert.equal(raw.useOfficialDeepSeekSearch, false, "开关被表单产物覆盖");
  assert.equal(raw.timeoutMs, 41000, "timeoutMs 被表单产物覆盖");
  const e1 = raw.entries.find((e) => e.id === "e1");
  const ids = raw.entries.map((e) => e.id);
  assert.deepEqual(ids, ["e1", "e2"], "条目集合与顺序 = 表单权威（数组顺序即优先级；未列出条目移除）");
  assert.equal(e1.name, "新名", "管理子字段 name 被覆盖");
  assert.equal(e1.enabled, false, "管理子字段 enabled 被覆盖");
  assert.equal(e1.credentialRef, "new-ref", "credentialRef 为表单管理字段：表单值替换既有值");
  assert.equal(e1.apiKey, "S1-LEGACY-SECRET", "该行既有 apiKey 必须原样透传保留（凭据边界 v0.1 不变：不读不删不新增，#45 缺口不扩大）");
  assert.equal(e1.customParam, 7, "既有未知标量字段原样保留");
  assert.deepEqual(e1.vendorExtra, { a: 1 }, "既有未知对象字段原样保留（写合并 raw 而非 normalize 产物）");
  const e2 = raw.entries.find((e) => e.id === "e2");
  assert.ok(!("apiKey" in e2), "新条目不得新增 apiKey 键");
  assert.ok(!("credentialRef" in e2), "表单未给 credentialRef 的新条目不得凭空出现该键");
});

test("#46 config.put 凭据边界：表单产物 apiKey 永不落盘；credentialRef 空串=删除引用（读路径同义）（BCF-004）", async (t) => {
  const { createConfigBridge } = await loadBridge(t);
  const { settings, state } = makeBridgeSettings(LEGACY_RAW);
  const res = await createConfigBridge(settings)["config.put"]({
    entries: [{ id: "e1", type: "bing", name: "n", enabled: true, credentialRef: "", apiKey: "EVIL-FORM-KEY" }],
    useOfficialDeepSeekSearch: true,
    timeoutMs: 30000,
  });
  assert.equal(res.ok, true, `合法产物（含被忽略的 apiKey 字段）仍须成功；实收：${JSON.stringify(res)}`);
  const flat = JSON.stringify(state.raw);
  assert.ok(!flat.includes("EVIL-FORM-KEY"), "表单产物中的明文 apiKey 必须被忽略、绝不落盘（v0.1 无 key 输入，BCF-002/004）");
  const e1 = state.raw.entries.find((e) => e.id === "e1");
  assert.equal(e1.apiKey, "S1-LEGACY-SECRET", "既有 apiKey 仍原样透传，不因合并路径被覆写");
  const { readConfig } = await import("../src/config.js");
  const snap = readConfig({ current: () => state.raw });
  const e1snap = snap.entries.find((e) => e.id === "e1");
  assert.ok(!("credentialRef" in e1snap), "credentialRef 空串 = 删除引用（normalizeConfig 读路径同义）");
});

test("#46 config.put 部分产物：省略的管理键保持当前值，不重置缺省（BCF-004）", async (t) => {
  const { createConfigBridge } = await loadBridge(t);
  const { settings, state } = makeBridgeSettings(LEGACY_RAW);
  const res = await createConfigBridge(settings)["config.put"]({ useOfficialDeepSeekSearch: false });
  assert.equal(res.ok, true, `仅含开关的产物须成功；实收：${JSON.stringify(res)}`);
  assert.equal(state.raw.timeoutMs, 30000, "表单省略 timeoutMs：保持行当前值（30000），不得重置 25000");
  assert.equal(state.raw.useOfficialDeepSeekSearch, false, "给出的管理键正常覆盖");
  assert.deepEqual(
    state.raw.entries.map((e) => e.id),
    ["e1", "e0"],
    "表单省略 entries：整列表保持当前值（列表权威仅在表单给出 entries 时生效）",
  );
  assert.equal(state.raw.entries.find((e) => e.id === "e1").apiKey, "S1-LEGACY-SECRET");
});

test("#46 config.put 写闸拒绝：非法类型/重复 id → CONFIG_INVALID + 非空 issues，宿主写入零调用（normalizeConfig 写闸，BCF-005）", async (t) => {
  const { createConfigBridge } = await loadBridge(t);
  const cases = [
    { label: "类型不在 CAT-001 枚举", entries: [{ id: "x", type: "not-a-type", name: "x", enabled: true }] },
    { label: "entries 重复 id", entries: [{ id: "dup", type: "bing", name: "a", enabled: true }, { id: "dup", type: "brave", name: "b", enabled: true }] },
    { label: "timeoutMs 越界", entries: [], timeoutMs: 0 },
  ];
  for (const c of cases) {
    const { settings, calls } = makeBridgeSettings(LEGACY_RAW);
    const form = { entries: c.entries ?? [], useOfficialDeepSeekSearch: true, timeoutMs: c.timeoutMs ?? 30000 };
    const res = await createConfigBridge(settings)["config.put"](form);
    assert.equal(res.ok, false, `${c.label}：写闸必须拒绝（ok:false）`);
    assert.equal(res.code, "CONFIG_INVALID", `${c.label}：code 钉 CONFIG_INVALID；实收 ${res.code}`);
    assert.ok(Array.isArray(res.issues) && res.issues.length >= 1, `${c.label}：必须回传非空 issues（可操作原因）；实收 ${JSON.stringify(res.issues)}`);
    assert.ok(res.issues.every((i) => i && typeof i.message === "string" && i.message.length > 0), `${c.label}：issues[].message 须为可读字符串`);
    assert.equal(calls.edit, 0, `${c.label}：写闸拒绝时不得调用宿主写入`);
  }
});

test("#46 config.put 宿主写入失败：CONFIG_SAVE_FAILED + 可操作 message + 零秘密回显；已生效快照不变（BCF-005，CFG-003）", async (t) => {
  const { createConfigBridge } = await loadBridge(t);
  const { settings, state, calls } = makeBridgeSettings(LEGACY_RAW, { failEdit: true });
  const before = structuredClone(state.raw);
  const res = await createConfigBridge(settings)["config.put"]({
    entries: [{ id: "e1", type: "bing", name: "n", enabled: true }],
    useOfficialDeepSeekSearch: true,
    timeoutMs: 30000,
  });
  assert.equal(calls.edit, 1, "失败路径确实尝试过一次写入");
  assert.equal(res.ok, false, "写失败必须回传 ok:false");
  assert.equal(res.code, "CONFIG_SAVE_FAILED", "写失败 code 钉 CONFIG_SAVE_FAILED（config.js 既有码单源）");
  assert.ok(typeof res.message === "string" && res.message.length > 0, "写失败必须带可操作 message（SET-004）");
  assert.ok(!JSON.stringify(res).includes("S1-LEGACY-SECRET"), "失败结果不得回显被拒负载/凭据（writeConfig 不附 cause 的同一裁决，CFG-003）");
  assert.deepEqual(state.raw, before, "写失败后已生效配置保持不变");
});

test("#46 config.put 成功：返回 config = 写入后 readConfig 读回快照（BCF-005）", async (t) => {
  const { createConfigBridge } = await loadBridge(t);
  const { settings, state } = makeBridgeSettings(LEGACY_RAW);
  const res = await createConfigBridge(settings)["config.put"]({
    entries: [{ id: "e1", type: "bing", name: "读回名", enabled: true }],
    useOfficialDeepSeekSearch: false,
    timeoutMs: 12345,
  });
  assert.equal(res.ok, true, `成功须 ok:true；实收：${JSON.stringify(res)}`);
  const { readConfig } = await import("../src/config.js");
  assert.deepEqual(res.config, readConfig({ current: () => state.raw }), "返回值必须是写入后的 readConfig 读回（保存成功才确认生效，SET-004 同义）");
  assert.equal(res.config.entries.find((e) => e.id === "e1").name, "读回名");
  assert.equal(res.config.timeoutMs, 12345);
  assert.equal(res.config.useOfficialDeepSeekSearch, false);
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 4. 纯增量守卫（BCF-007 + 既有宿主面）
// ════════════════════════════════════════════════════════════════════════════════════════

test("#46 纯增量守卫：src/index.js web provider 面不动；scripts.verify:ui-46 在场且 npm test 不含它", async () => {
  const host = await import("../src/index.js");
  assert.equal(typeof host.apply, "function");
  assert.ok(host.Config && (typeof host.Config === "object" || typeof host.Config === "function"));
  assert.deepEqual(host.inject, ["web", "configEditor", "credentials", "agents"]);
  assert.equal(PACKAGE_JSON.scripts["verify:ui-46"], "node scripts/verify-ui-46.mjs", "实机 DOM 验收脚本以 npm run verify:ui-46 暴露（BCF-007）");
  assert.ok(!PACKAGE_JSON.scripts.test.includes("verify:ui-46"), "verify:ui-46 不入 npm test（npm test 恒 node --test test/）");
});
