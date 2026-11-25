// Issue #46 v0.1 配置 UI 契约（oracle，通道迁移轮）——bundle 页配置入口（docs/specs/draft/bundle-config-ui.md）。
//
// 通道终选（真机两轮探针定案，见规格引言「BCF-001 冲突史」）：静态 client factory 的 ctx 无 host
// 服务（inject 声明 host → 包不激活 pending (waiting for service: host)；读 ctx.host 抛
// cannot get property "host" without inject）。表单读 = 同源 settings/describe 本包投影；
// 写 = settings/mutate ops；merge/validate/toOps 为组件内联纯函数（Component.contract）。
// src/config-bridge.js / host.call('config.get'|'config.put') 命名作废退役。
//
// 本文件四面红：
//   第 1 组 BCF-001 注册线：plugins.bundle.config keyed 注册（key=包名）+ 注入面恰集 ["slots"]
//           + ctx.host 读即红（getter 按真机措辞抛）；
//   第 2 组 BCF-002/003/005 渲染与通道：describe 读取/回填/失败态、三范围控件、form
//           undefined-safe、summary 轻量、保存走 mutate ops、saved/error 态、零 DOM（fetch 属
//           应用通道不属 DOM 面）、无 apiKey；
//   第 3 组 BCF-004 contract：对比钉（validate∘merge ≡ normalizeConfig 结构化输出，输入表
//           13 行）、merge 合并语义与凭据边界、toOps 形状 + 权威 reducer 回应用 ≡ raw'；
//   第 4 组 纯增量守卫：宿主 provider 面（含 #43 的 Config/resolveConfig 校验面所依赖的形状）
//           不动；verify:ui-46 独立于 npm test。
//
// ─── 宿主实测契约（bundle-config-ui.md [C1]–[C10]，0.2.2-rc.5）────────────────────────────
//   [C1] bundle 级渲染 renderSlot('plugins.bundle.config', {view:'page'}, {entryKey: 包名})——
//        不传 form；[C3] ctx 无 host 服务（两探针原文见上）；[C8] describe result =
//        {writable, hasDocument, namespaces:[{ns, base, user, secrets(脱敏), applies}]}，
//        mutate(ns:string, ops:[{op:'set',path:string[],value}|{op:'unset',path:string[]}])，
//        args 传形未实证 → envelope 只钉 type/method/rpcId + payload 含 ns/ops，不赌传形；
//   [C10] 组件渲染崩溃进 data-slot-error ——本文件以「渲染零抛」承担同义。
//
// ─── react 通道实况（规格「设计决定」）────────────────────────────────────────────────────
//   软链 store 无 react/react-dom（MODULE_NOT_FOUND 探测）→ fake hook-React 经 factory 的
//   require('react') 通道喂入（createElement + useState/useEffect/useCallback/useMemo/useRef/
//   useId 白名单 stub）。真实 react 渲染由 verify-ui-46 在宿主窗口内实证（BCF-007）。
//
// ─── 红/绿约定（helpers/impl.js）─────────────────────────────────────────────────────────
//   红不得改 skip、不得删断言，只能经实现转绿。现 client-entry 尚无 bundle 注册 → 第 1/2/3 组
//   于 requireBundleReg 处红（#46 症状）。settings-client-wire.test.js 的文案断言已按 BCF-006
//   放宽（真机 settings 面板 nav 未达，开放项），迁移轮后不再承担红。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeConfig, ConfigError } from "../src/config.js";

const SLOT = "plugins.bundle.config";
const SECTION_SLOT = "settings.section";
const SECTION_ID = "search-chain"; // 行 id / provider id（settings ns）
const PACKAGE_ID = "dsh-search-chain"; // 包名 = 注册 key（[C1] keyed by 包名，非行 id）
const PACKAGE_JSON = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

// ════════════════════════════════════════════════════════════════════════════════════════
// 装载线替身（与 settings-client-wire.test.js 同型）
// ════════════════════════════════════════════════════════════════════════════════════════

let bustCounter = 0;

async function importSelfRegister(tag) {
  const registrations = [];
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  globalThis.window = { __ModuleLoader__: { load(reg) { registrations.push(reg); } } };
  try {
    await import(`../src/client-entry.js?v=${tag}-${++bustCounter}`);
  } finally {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else delete globalThis.window;
  }
  return registrations;
}

async function loadProduct(tag, reactValue) {
  const registrations = await importSelfRegister(tag);
  if (registrations.length !== 1 || typeof registrations[0].factory !== "function") {
    assert.fail(
      "本组以 __ModuleLoader__.load 自注册 + factory 产物为前置（现 load " + registrations.length + " 次）；" +
        "见 settings-client-wire.test.js 第 1/3 组（[M1]）",
    );
  }
  const require = (spec) => (spec === "react" ? reactValue : undefined);
  return registrations[0].factory(require);
}

/**
 * live 形状 client ctx：slots.inject/slots.register/effect。
 * host 按真机措辞立 getter（[C3]）：读即抛——apply/渲染任何时刻读 ctx.host 都红。
 */
function makeCtx() {
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
    regs,
    effects,
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

/** DOM 陷阱（wire test 同型）。fetch 是应用通道（[C8]），不属 DOM 面，不入陷阱名单。 */
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
// fake hook-React（whitelist 见规格「设计决定」）
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
          /* effect 内异步失败经状态面反映；同步异常不掩红于渲染面 */
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
  async function renderStable(Component, props, maxPasses = 12) {
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

/** 动作锚点自身或其子树里第一个带 onClick 的节点（Button 包装组件兼容）。 */
function findActionClick(tree, action) {
  for (const holder of findByAttr(tree, "data-config-action", action)) {
    let hit = null;
    walk(holder, (n) => {
      if (!hit && n.props && typeof n.props.onClick === "function") hit = n;
    });
    if (hit) return hit.props.onClick;
  }
  return null;
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

// ────────────────────────────────────────────────────────────────────────────────────────
// fetch 注入面（规格「设计决定·fetch 注入面」）：记录 envelope，回放 describe/mutate 样本
// ────────────────────────────────────────────────────────────────────────────────────────

function describeEnvelope(user, extra = {}) {
  return {
    ok: true,
    result: {
      writable: true,
      hasDocument: true,
      namespaces: [
        { ns: SECTION_ID, autoGenerate: false, base: {}, user: user ?? {}, ...extra },
      ],
    },
  };
}

/**
 * 安装 fake fetch。handler(url, body) → 回放 JSON（HTTP 恒 200，业务成败在 JSON 面，[C8]）。
 * 返回 { calls: [{url, body}], restore() }。
 */
function installFetch(handler) {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    let body;
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
    calls.push({ url: String(url), body });
    const payload = handler(String(url), body);
    return { ok: true, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  return {
    calls,
    restore() {
      if (saved === undefined) delete globalThis.fetch;
      else globalThis.fetch = saved;
    },
  };
}

/**
 * envelope 公共钉（BCF-003/005）。describe：宿主 zod 描述符**无参**（dev 实测 `args:{ns}` 被拒
 * `unexpected "ns"`，`args:{}` 唯一合法，[C8]）→ ns 校验位在回包投影面（namespaces/search-chain）。
 * mutate：`args:{ns,ops}` 实测被宿主接受 → payload 序列化面须含 ns。
 */
function pinEnvelope(call, method) {
  const b = call.body;
  assert.ok(b && typeof b === "object", `${method}：POST body 须为 client-request envelope JSON`);
  assert.equal(b.type, "client-request", `${method}：envelope.type 钉 client-request（[C8] 用户实证形状）`);
  assert.equal(b.method, method, `${method}：envelope.method 钉 ${method}`);
  assert.equal(typeof b.rpcId, "string", `${method}：rpcId 须为字符串`);
  assert.ok(b.payload !== undefined, `${method}：payload 面须在`);
  if (method === "settings/describe") {
    assert.deepEqual(
      b.payload.args ?? b.payload,
      {},
      `settings/describe：宿主描述符无参——args 恰空 {}（实测 args:{ns} 被拒 unexpected "ns"，[C8] 实证）`,
    );
  } else {
    assert.ok(JSON.stringify(b.payload).includes(SECTION_ID), `${method}：payload 必须指向 ${SECTION_ID} 命名空间`);
  }
}

function deepFindOps(payload) {
  let found = null;
  const visit = (v) => {
    if (found || v === null || typeof v !== "object") return;
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((op) => op && typeof op === "object" && (op.op === "set" || op.op === "unset") && Array.isArray(op.path))
    ) {
      found = v;
      return;
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) visit(x);
  };
  visit(payload);
  return found;
}

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

/** 挂载 bundle 组件：装 fetch 回放 + 渲染到稳（BCF-003 读取线走完）。 */
async function mountBundle(tag, handler) {
  const { React, renderStable } = makeHookReact();
  const product = await loadProduct(tag, React);
  const h = makeCtx();
  product.apply(h.ctx);
  const rec = requireBundleReg(h);
  const fetchStub = installFetch(handler);
  return { rec, h, renderStable, fetchStub };
}

const LOADED_USER = {
  entries: [{ id: "e1", type: "bing", name: "keep-me", enabled: true, credentialRef: "r" }],
  useOfficialDeepSeekSearch: false,
  timeoutMs: 9999,
};

// ════════════════════════════════════════════════════════════════════════════════════════
// 1. 注册线 + 注入面恰集（BCF-001）
// ════════════════════════════════════════════════════════════════════════════════════════

test("#46 注册线：双槽各恰一次 inject；register 收 {name,key=包名} 与组件工厂；注入面恰集 inject=[\"slots\"]（host 服务不存在，[C3] BCF-001）", async () => {
  const { React } = makeHookReact();
  const product = await loadProduct("reg-wire", React);
  assert.deepEqual(
    product.inject,
    ["slots"],
    `factory 产物 inject 恰 ["slots"]（[C3] 真机定案：声明 host → pending (waiting for service: host) 包不激活；` +
      `BCF-001 冲突史：host.call 通道已作废）；实收：${JSON.stringify(product.inject)}`,
  );
  const h = makeCtx();
  product.apply(h.ctx); // apply 期读 ctx.host → getter 抛 → 此步即红（旧 host.call 版死于此）
  const names = h.injects.map((x) => x.name);
  assert.ok(names.includes(SECTION_SLOT), `settings.section 注册不得被移动或挤掉；现 injects=${JSON.stringify(names)}`);
  assert.equal(names.filter((n) => n === SLOT).length, 1, `须恰调用 ctx.slots.inject("${SLOT}", …) 1 次；现 ${names.filter((n) => n === SLOT).length} 次（无 bundle 配置注册 = #46 缺口）`);
  const rec = requireBundleReg(h);
  assert.ok(rec.registration && typeof rec.registration === "object", "register 第一参须为 registration 对象");
  assert.equal(rec.registration.name, SLOT, "registration.name 须为槽名（[C2] 活样本同形）");
  assert.equal(typeof rec.Component, "function", "register 第二参须为组件工厂函数（[C1] renderSlot 渲染目标）");
});

test("#46 注册幂等：重复 apply 每槽恰一次 inject；挂载后每槽恰一次 register（BCF-001）", async () => {
  const { React } = makeHookReact();
  const product = await loadProduct("reg-idem", React);
  const h = makeCtx();
  product.apply(h.ctx);
  product.apply(h.ctx);
  for (const slot of [SECTION_SLOT, SLOT]) {
    assert.equal(h.injects.filter((x) => x.name === slot).length, 1, `重复 apply 后槽 "${slot}" 仍须恰 1 次 inject；现 ${h.injects.filter((x) => x.name === slot).length} 次`);
  }
  assert.ok(h.mountSlot(SECTION_SLOT), "settings.section 挂载须产出注册");
  requireBundleReg(h);
  assert.equal(h.regs.filter((r) => r.registration?.name === SLOT).length, 1, "plugins.bundle.config 挂载后恰 1 个注册（重复 apply 不得双注册）");
});

test("#46 注册 key 恰为包名 dsh-search-chain（非行 id search-chain）；附加键仅限 {id,order,label,locale,inject}（keyed 槽，BCF-001）", async () => {
  const { React } = makeHookReact();
  const product = await loadProduct("reg-key", React);
  const h = makeCtx();
  product.apply(h.ctx);
  const reg = requireBundleReg(h).registration;
  assert.ok("key" in reg, `keyed 槽注册必须带 key（[C1] key=bundle 包名）；现键：${JSON.stringify(Object.keys(reg))}`);
  assert.equal(reg.key, PACKAGE_ID, `注册 key 恒 = 包名 "${PACKAGE_ID}"（[C1] entryKey 按包名 dispatch）；行 id "${SECTION_ID}" 是错误键`);
  assert.equal(reg.key, PACKAGE_JSON.name, "注册 key 须与 package.json name 一致");
  const ALLOWED = new Set(["id", "order", "label", "locale", "inject"]);
  for (const k of Object.keys(reg).filter((k) => k !== "name" && k !== "key")) {
    assert.ok(ALLOWED.has(k), `registration 附加键 "${k}" 不在允许集 {name,key,id,order,label,locale,inject}（[C2] 活样本键域）`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 2. 渲染与通道（BCF-002/003/005）
// ════════════════════════════════════════════════════════════════════════════════════════

test("#46 读取通道与渲染（form=undefined-safe）：describe envelope 含 search-chain；投影回填三范围控件；无 apiKey；零 DOM（BCF-002/003）", async () => {
  const { rec, renderStable, fetchStub } = await mountBundle("render-page", (url) =>
    /settings\/describe/.test(url) ? describeEnvelope(LOADED_USER) : { ok: false },
  );
  const trap = installDomTrap();
  let tree, failure = null;
  try {
    tree = await renderStable(rec.Component, { view: "page" }); // 宿主实证不传 form（[C1]）
    await new Promise((r) => setImmediate(r));
    tree = await renderStable(rec.Component, { view: "page" });
  } catch (e) {
    failure = e;
  } finally {
    trap.restore();
  }
  assert.equal(trap.touches.length, 0, `headless 渲染零 DOM 接触被违反：${JSON.stringify(trap.touches)}`);
  if (failure) {
    assert.fail(`Component({view:'page'})（无 form prop）不得抛——form 必须 undefined-safe 且无 ctx.host 依赖（[C1][C3]）：${failure.message}`);
  }
  assert.ok(tree !== null && tree !== undefined, "假 react 在场时页面视图须产出节点树（v0.1 表单入口）");
  const described = fetchStub.calls.filter((c) => /settings\/describe/.test(c.url));
  assert.ok(described.length >= 1, `挂载必须经同源 fetch 调 settings/describe（[C8] 读通道终选）；实收 fetch：${JSON.stringify(fetchStub.calls.map((c) => c.url))}`);
  pinEnvelope(described[0], "settings/describe"); // args 恰空：ns 位在回包投影面
  const view = describeEnvelope(LOADED_USER).result.namespaces.find((n) => n.ns === SECTION_ID);
  assert.ok(view && view.user.timeoutMs === 9999, "回包投影前提：namespaces 含 ns=search-chain 项（ns 校验位点=回包面，非请求 envelope）");
  const marks = {
    "timeoutMs 数值输入": findByAttr(tree, "data-config-field", "timeoutMs"),
    "官方搜索开关": findByAttr(tree, "data-config-field", "useOfficialDeepSeekSearch"),
    "添加条目入口": findByAttr(tree, "data-config-action", "add-entry"),
    "保存入口": findByAttr(tree, "data-config-action", "save"),
  };
  for (const [label, hits] of Object.entries(marks)) {
    assert.ok(hits.length >= 1, `三范围控件缺「${label}」（[data-config-*] 锚点见 BCF-002，DOM 契约与 verify-ui-46 共用）`);
  }
  const flat = JSON.stringify(tree);
  assert.ok(flat.includes("9999"), "describe 投影的 timeoutMs=9999 必须回填到渲染树");
  assert.ok(flat.includes("keep-me"), "describe 投影的条目标签必须回填到渲染树");
  const all = collectText(tree, []).join("") + flat;
  assert.ok(!/apikey/i.test(all) && !/api_key/i.test(all), "apiKey 输入/标签不得出现在表单任何位置（凭据边界 v0.1 不变，BCF-002）");
  fetchStub.restore();
});

test("#46 form prop 安全、summary 轻量与读取失败态：form 给法不敏感；summary 无输入；describe 非 ok/网络炸 → error 锚点、不静默空表单、不抛（BCF-002/003/005）", async () => {
  const { rec, renderStable, fetchStub } = await mountBundle("form-safe", () => ({ ok: false, error: { message: "describe 拒绝（样本）" } }));
  const fakeForm = { view: "page", someHostHandle: {} }; // 未实证宿主对象冒充 ConfigPageForm：不得赌其方法面
  for (const props of [{ view: "page" }, { view: "page", form: undefined }, { view: "page", form: fakeForm }]) {
    let tree;
    try {
      tree = await renderStable(rec.Component, props);
    } catch (e) {
      fetchStub.restore();
      assert.fail(`props=${JSON.stringify(Object.keys(props))} 渲染不得抛（form 传不传、传什么都必须渲染，BCF-002）：${e.message}`);
    }
    assert.ok(findByAttr(tree, "data-config-field", "timeoutMs").length >= 1, "三种 form 给法下三范围控件必须在场（读取失败仍渲染表单骨架 + 错误态，不得空白）");
    const err = findByAttr(tree, "data-config-status", "error").concat(findByAttr(tree, "data-config-error"));
    assert.ok(err.length >= 1, "describe 失败必须显示可读错误态（BCF-003：禁静默缺省空表单诱导覆盖）");
    assert.equal(findByAttr(tree, "data-config-status", "saved").length, 0, "读取失败不得出现 saved 态");
  }
  fetchStub.restore();

  // 网络炸（fetch reject）同义：渲染全程不抛
  const boom = await mountBundle("fetch-boom", () => {
    throw new Error("network down（样本）");
  });
  const treeB = await boom.renderStable(boom.rec.Component, { view: "page" });
  assert.ok(findByAttr(treeB, "data-config-status", "error").concat(findByAttr(treeB, "data-config-error")).length >= 1, "fetch reject 同样必须进 error 态");
  boom.fetchStub.restore();

  // summary 轻量（成功数据下再看）
  const ok = await mountBundle("summary-lite", (url) => (/settings\/describe/.test(url) ? describeEnvelope(LOADED_USER) : { ok: false }));
  const summary = await ok.renderStable(ok.rec.Component, { view: "summary" });
  const inputs = [];
  walk(summary, (n) => {
    if (n.type === "input" || n.type === "textarea" || n.type === "select") inputs.push(n.type);
  });
  assert.deepEqual(inputs, [], `view:'summary' 必须轻量（不得含表单输入控件）；现含：${JSON.stringify(inputs)}`);
  ok.fetchStub.restore();
});

test("#46 保存通道：合法草稿点保存 → settings/mutate envelope（ns=search-chain + 合法 ops，apiKey 路径零 op）→ saved；宿主拒绝 → error 且零秘密回显、无 saved（BCF-005）", async () => {
  const CURRENT = {
    entries: [{ id: "e1", type: "bing", name: "旧名", enabled: true, apiKey: "S1-SAMPLE-SECRET", credentialRef: "old" }],
    timeoutMs: 30000,
    useOfficialDeepSeekSearch: true,
  };
  const handler = (url, body) => {
    if (/settings\/describe/.test(url)) return describeEnvelope(CURRENT);
    if (/settings\/mutate/.test(url)) {
      const ops = deepFindOps(body.payload) ?? [];
      const leaked = JSON.stringify(ops).includes("S1-SAMPLE-SECRET");
      return leaked
        ? { ok: false, error: { message: "ops 不得携带明文 key（样本拒绝）" } }
        : { ok: true, result: { ns: SECTION_ID, writable: true } };
    }
    return { ok: false };
  };
  const { rec, renderStable, fetchStub } = await mountBundle("save-ok", handler);
  let tree = await renderStable(rec.Component, { view: "page" });
  await new Promise((r) => setImmediate(r));
  tree = await renderStable(rec.Component, { view: "page" });
  const save = findActionClick(tree, "save");
  assert.ok(save, "[data-config-action=\"save\"] 动作须有可调用 onClick（e2e 与 fake react 同路）");
  save();
  tree = await renderStable(rec.Component, { view: "page" });
  const mutated = fetchStub.calls.filter((c) => /settings\/mutate/.test(c.url));
  assert.ok(mutated.length >= 1, `点保存必须经同源 fetch 调 settings/mutate（[C8] 写通道终选）；实收 fetch：${JSON.stringify(fetchStub.calls.map((c) => c.url))}`);
  pinEnvelope(mutated[0], "settings/mutate");
  const ops = deepFindOps(mutated[0].body.payload);
  assert.ok(Array.isArray(ops) && ops.length >= 0, "mutate payload 必须携带 ops 数组（[C8] zod 形状）");
  for (const op of ops) {
    assert.ok(Array.isArray(op.path) && op.path.every((s) => typeof s === "string"), `op.path 须为 string[]（[C8] zod）；实收 ${JSON.stringify(op.path)}`);
    if (op.op === "set") assert.ok("value" in op, `set op 须带 value（[C8] zod）`);
    else assert.ok(!("value" in op), `unset op 不得带 value（[C8] zod strict）`);
    assert.ok(!JSON.stringify(op).includes("S1-SAMPLE-SECRET"), "ops 不得触及/携带明文 apiKey 值（凭据边界，BCF-004）");
  }
  assert.ok(JSON.stringify(tree).includes("saved") && findByAttr(tree, "data-config-status", "saved").length >= 1, "mutate 成功后必须显示 [data-config-status=\"saved\"]");
  fetchStub.restore();

  // 宿主拒绝形态（resolveConfig/#43 校验面语义同形）：error 锚点、无 saved、零秘密回显
  const deny = await mountBundle("save-deny", (url, body) =>
    /settings\/describe/.test(url) ? describeEnvelope(CURRENT) : { ok: false, result: { ok: false }, error: { message: "ns 校验拒绝（样本）" } },
  );
  let t2 = await deny.renderStable(deny.rec.Component, { view: "page" });
  await new Promise((r) => setImmediate(r));
  t2 = await deny.renderStable(deny.rec.Component, { view: "page" });
  const save2 = findActionClick(t2, "save");
  if (save2) save2();
  t2 = await deny.renderStable(deny.rec.Component, { view: "page" });
  const flat2 = JSON.stringify(t2);
  assert.ok(flat2.includes("error") || flat2.includes("失败"), "宿主拒绝必须进 error 态");
  assert.equal(findByAttr(t2, "data-config-status", "saved").length, 0, "宿主拒绝不得显示 saved");
  assert.ok(!flat2.includes("S1-SAMPLE-SECRET"), "错误面不得回显 describe 里出现过的样本值/凭据（BCF-005 零秘密回显）");
  deny.fetchStub.restore();
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 3. Component.contract：对比钉 + 内联语义（BCF-004）
// ════════════════════════════════════════════════════════════════════════════════════════

async function loadContract(tag) {
  const { rec } = await mountBundle(tag, () => describeEnvelope({}));
  const contract = rec.Component.contract;
  if (!contract || typeof contract.merge !== "function" || typeof contract.validate !== "function" || typeof contract.toOps !== "function") {
    assert.fail(
      `注册组件必须挂内联纯函数面 Component.contract = { merge, validate, toOps }（BCF-004 设计决定：` +
        `client 零 import 经典脚本，纯函数只能内联；宿主只调 Component(props)，静态不影响渲染）。实收：` +
        `${JSON.stringify(Object.keys(contract ?? {}))}`,
    );
  }
  return { contract, close: () => {} };
}

/** 宿主侧同一裁决的结构化形态（消息措辞不参与对比；ConfigError 其他码属实现 bug，直抛）。 */
function runNormalize(raw) {
  try {
    return { ok: true, config: normalizeConfig(structuredClone(raw)) };
  } catch (e) {
    if (e instanceof ConfigError && e.code === "CONFIG_INVALID") return { ok: false, code: "CONFIG_INVALID" };
    throw e;
  }
}

function shape(result) {
  return result.ok ? { ok: true, config: result.config } : { ok: false, code: result.code };
}

// 对比钉输入表（BCF-004 验收：≥10 行；oracle 定 13 行）——每行 (label, current, form)
const DRIFT_TABLE = [
  ["缺省双空", {}, {}],
  ["apiKey 条目级透传", { entries: [{ id: "a", type: "bing", name: "a", enabled: true, apiKey: "S1" }] }, { entries: [{ id: "a", type: "bing", name: "a2", enabled: true }] }],
  ["未知标量透传", { entries: [{ id: "a", type: "bing", name: "a", enabled: true, customParam: 7 }] }, { entries: [{ id: "a", type: "bing", name: "a", enabled: false }] }],
  ["明文对象字段清洗等价", { entries: [{ id: "a", type: "bing", name: "a", enabled: true, vendorExtra: { a: 1 }, key: "OBJ" }] }, {}],
  ["顶层未知标量保留", { someOtherKey: "keep", entries: [] }, { entries: [] }],
  ["credentialRef 空串删除", { entries: [{ id: "a", type: "bing", name: "a", enabled: true, credentialRef: "old" }] }, { entries: [{ id: "a", type: "bing", name: "a", enabled: true, credentialRef: "" }] }],
  ["表单 apiKey 被忽略", {}, { entries: [{ id: "a", type: "bing", name: "a", enabled: true, apiKey: "EVIL" }] }],
  ["entries 非数组（非法形状）", {}, { entries: "not-an-array" }],
  ["重复 id", {}, { entries: [{ id: "d", type: "bing", name: "x", enabled: true }, { id: "d", type: "brave", name: "y", enabled: true }] }],
  ["timeoutMs 越界 0", {}, { timeoutMs: 0 }],
  ["timeoutMs 非整数", {}, { timeoutMs: 2.5 }],
  ["official 类型错", {}, { useOfficialDeepSeekSearch: "yes" }],
  ["省略管理键保留当前", { entries: [{ id: "a", type: "bing", name: "a", enabled: true }], timeoutMs: 30000, useOfficialDeepSeekSearch: true }, { useOfficialDeepSeekSearch: false }],
];

test("#46 对比钉（防双实现漂移）：validate(merge(form,current)) 与 normalizeConfig 同一输入的结构化输出全等（输入表 13 行：apiKey/未知键透传、credentialRef 空串删、非法形状、越界 timeout、重复 id…）（BCF-004）", async () => {
  const { contract } = await loadContract("drift-pin");
  assert.ok(DRIFT_TABLE.length >= 10, "输入表行数由 oracle 维护，≥10");
  for (const [label, current, form] of DRIFT_TABLE) {
    const merged = contract.merge(structuredClone(form), structuredClone(current));
    const a = shape(contract.validate(merged));
    const b = shape(runNormalize(merged));
    assert.deepEqual(a, b, `对比钉行「${label}」漂移：内联 validate ≠ src/config.js normalizeConfig（输入表见本文件 DRIFT_TABLE）`);
  }
});

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

/** toOps 权威 reducer（规格「设计决定」）：set 沿 path 下钻（数值段=数组下标），unset 删键/splice。 */
function applyOps(raw, ops) {
  const out = structuredClone(raw);
  for (const op of ops) {
    const segs = op.path.map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    if (segs.length === 0) throw new Error("op.path 不得为空");
    let node = out;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i];
      if (node[k] === undefined || node[k] === null) node[k] = typeof segs[i + 1] === "number" ? [] : {};
      node = node[k];
    }
    const last = segs[segs.length - 1];
    if (op.op === "set") node[last] = structuredClone(op.value);
    else if (Array.isArray(node) && typeof last === "number") node.splice(last, 1);
    else delete node[last];
  }
  return out;
}

test("#46 contract.merge 合并语义与凭据边界：管理字段覆盖；apiKey/未知字段透传钉；不新增 apiKey；省略=保留当前；顺序=权威；toOps 经权威 reducer 应用回 current ≡ raw'（BCF-004）", async () => {
  const { contract } = await loadContract("merge-pin");
  const raw2 = contract.merge(
    {
      entries: [
        { id: "e1", type: "bing", name: "新名", enabled: false, credentialRef: "new-ref", apiKey: "EVIL-FORM-KEY" },
        { id: "e2", type: "tavily", name: "t1", enabled: true },
      ],
      useOfficialDeepSeekSearch: false,
      timeoutMs: 41000,
    },
    structuredClone(LEGACY_RAW),
  );
  assert.equal(raw2.someOtherKey, "keep", "顶层未知键原样保留");
  assert.equal(raw2.useOfficialDeepSeekSearch, false, "开关被表单产物覆盖");
  assert.equal(raw2.timeoutMs, 41000, "timeoutMs 被表单产物覆盖");
  assert.deepEqual(raw2.entries.map((e) => e.id), ["e1", "e2"], "条目集合与顺序 = 表单权威（未列出条目移除）");
  const e1 = raw2.entries.find((e) => e.id === "e1");
  assert.equal(e1.name, "新名", "管理子字段 name 覆盖");
  assert.equal(e1.enabled, false, "管理子字段 enabled 覆盖");
  assert.ok(e1.credentialRef === "new-ref", "credentialRef 被表单值替换");
  assert.equal(e1.apiKey, "S1-LEGACY-SECRET", "既有 apiKey 原样透传（凭据边界 v0.1 不变：不读不删不新增，#45 缺口不扩大）");
  assert.equal(e1.customParam, 7, "既有未知标量保留");
  assert.deepEqual(e1.vendorExtra, { a: 1 }, "既有未知对象保留（raw 层合并，非规范化产物）");
  const e2 = raw2.entries.find((e) => e.id === "e2");
  assert.ok(!("apiKey" in e2), "新条目不得新增 apiKey 键");
  assert.ok(!("credentialRef" in e2), "未给 credentialRef 的新条目不得凭空出现该键");
  assert.ok(!JSON.stringify(raw2).includes("EVIL-FORM-KEY"), "表单产物 apiKey 必须被忽略、不落盘");

  const omitted = contract.merge({ useOfficialDeepSeekSearch: false }, structuredClone(LEGACY_RAW));
  assert.equal(omitted.timeoutMs, 30000, "省略 timeoutMs：保持当前值，不重置缺省 25000");
  assert.deepEqual(omitted.entries, structuredClone(LEGACY_RAW.entries), "省略 entries：整列表保持当前值（列表权威仅在给出时生效）");

  const empty = contract.merge({ entries: [{ id: "x", type: "bing", name: "x", enabled: true, credentialRef: "" }] }, structuredClone(LEGACY_RAW));
  const ex = empty.entries.find((e) => e.id === "x");
  assert.ok(!("credentialRef" in ex) || ex.credentialRef === "", "credentialRef 空串=删除引用（删键或空串均可，validate 读路径同义）");

  const ops = contract.toOps(structuredClone(raw2), structuredClone(LEGACY_RAW));
  for (const op of ops) {
    assert.ok(op.op === "set" || op.op === "unset", `op.op ∈ {set,unset}（[C8] zod）；实收 ${op.op}`);
    assert.ok(Array.isArray(op.path) && op.path.every((s) => typeof s === "string"), `op.path 须为 string[]；实收 ${JSON.stringify(op.path)}`);
    if (op.op === "unset") assert.ok(!("value" in op), "unset 不得带 value（[C8] zod strict）");
    assert.ok(!JSON.stringify(op).includes("S1-LEGACY-SECRET"), "任何 op 不得携带既有明文 key 值（apiKey 路径零 op）");
  }
  assert.deepEqual(applyOps(structuredClone(LEGACY_RAW), ops), raw2, "toOps 产物经测试权威 reducer 作用于 current 必须 ≡ merge 输出（规格「设计决定·toOps 权威 reducer」）");
});

test("#46 contract.validate 写闸：合法补全缺省；非法 → {ok:false, code:CONFIG_INVALID} + 非空可读 issues（判定与 normalizeConfig 全等由对比钉承担）（BCF-004/005）", async () => {
  const { contract } = await loadContract("gate-pin");
  const okRes = contract.validate({});
  assert.equal(okRes.ok, true, `合法空配置须 ok:true；实收 ${JSON.stringify(okRes)}`);
  assert.deepEqual(okRes.config, { entries: [], useOfficialDeepSeekSearch: true, timeoutMs: 25000 }, "缺省补全 entries=[]/official=true/timeoutMs=25000（SET-005/FB-003 分界）");
  for (const [label, bad] of [
    ["重复 id", { entries: [{ id: "d", type: "bing", name: "x", enabled: true }, { id: "d", type: "brave", name: "y", enabled: true }] }],
    ["timeout 越界", { timeoutMs: 0 }],
    ["entries 非数组", { entries: "x" }],
    ["official 非布尔", { useOfficialDeepSeekSearch: 1 }],
  ]) {
    const res = contract.validate(bad);
    assert.equal(res.ok, false, `${label}：写闸必须拒绝`);
    assert.equal(res.code, "CONFIG_INVALID", `${label}：code 钉 CONFIG_INVALID；实收 ${res.code}`);
    assert.ok(Array.isArray(res.issues) && res.issues.length >= 1, `${label}：必须回传非空 issues；实收 ${JSON.stringify(res.issues)}`);
    assert.ok(res.issues.every((i) => i && typeof i.message === "string" && i.message.length > 0), `${label}：issues[].message 须为可读非空字符串`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════
// 4. 纯增量守卫（BCF-007 + 既有宿主面）
// ════════════════════════════════════════════════════════════════════════════════════════

test("#46 纯增量守卫：宿主 provider 面与 Config 形状不动（#43 resolveConfig 校验面所依）；scripts.verify:ui-46 在场且 npm test 不含它", async () => {
  const host = await import("../src/index.js");
  assert.equal(typeof host.apply, "function");
  assert.ok(
    host.Config && (typeof host.Config === "object" || typeof host.Config === "function"),
    "宿主侧 ns Config 须在场（mutate 触发的校验面，#43 语义不变——形状细节由 #43 既有套件钉，本处只防整体退役）",
  );
  assert.deepEqual(host.inject, ["web", "configEditor", "credentials", "agents"]);
  assert.equal(typeof normalizeConfig, "function", "对比钉参照物 src/config.js normalizeConfig 不得移位/退役");
  assert.equal(PACKAGE_JSON.scripts["verify:ui-46"], "node scripts/verify-ui-46.mjs", "实机 DOM 验收脚本以 npm run verify:ui-46 暴露（BCF-007）");
  assert.ok(!PACKAGE_JSON.scripts.test.includes("verify:ui-46"), "verify:ui-46 不入 npm test");
});
