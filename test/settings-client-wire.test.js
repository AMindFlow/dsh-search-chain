// WP13 客户端挂载线（oracle）v0.3 —— P1 修正：Client 产物唯一入口 = window.__ModuleLoader__.load()
// 自注册（app.asar 模板审阅实证，权威）；推翻 v0.2 的「裸 ESM export 由 harness 直接 import」装载面。
//
// 本文件不改实现，只钉「自注册 + factory 产物挂载形状 + v0.1 只读文案 + 内置页编辑桥声明」最小契约。
//
// ─── ModuleLoader 权威实证（lead 审阅，DSH 0.2.2-rc.5 app.asar 模板，2026-11-25）──────────
//   [M1] Client 产物唯一入口是自注册，模板所示逐字：
//          window.__ModuleLoader__.load({
//            id: '<包名>',
//            factory(require) {
//              const React = require('react'); ...
//              return {
//                inject: ['slots'],
//                apply(ctx) {
//                  ctx.slots.inject('settings.section', () =>
//                    ctx.slots.register({ name: 'settings.section', id, order, label }, Comp));
//                },
//              };
//            },
//          });
//   [M2] loader 真实面只有 mode / pendingQueue / load / create —— **无 require 属性**。
//        v0.2 实现经 window.__ModuleLoader__.require('react') 懒取 React 是对不存在 API 的调用；
//        相关「loader.require 懒取」钉全部删除。React 只经 factory 入参 require('react') 进入
//        组件作用域（[M1]）。
//   [M3] load 注册的 id 恒 = 包名（本包 = "dsh-search-chain"）。
//   [M4] package.json dsh.client.inject 是**装载包列表**（宿主按序装载依赖包），不是服务名表。
//        本包 factory 所需 React 由宿主模块表经 load factory 的 require 注入（[M1]），不是独立
//        装载包 → inject 现须恰为 []。把服务名（"slots"）填进装载列表 = 宿主去装载 phantom 包
//        "slots" → 模块整体不激活 = 红。注记：owner 包顺序项属 H-5 实机核对，可后补（届时补钉）。
//
// ─── live 实证沿用（v0.2 头注 [L1]–[L4]，lead cordis inspect，DSH 0.2.2-rc.5）─────────────
//   [L1] settings.section 注册形状：{ id: string 必, order?: number, label?: string|(()=>string) }。
//        panel 不是字段——ctx.slots.register 的第二参是 React 组件工厂；ownerProps 只给 { close }。
//        挂载写法与 [M1] 模板内 apply 一致：
//          ctx.slots.inject("settings.section", () =>
//            ctx.slots.register({ name: "settings.section", id, order, label }, Component))
//   [L2] 现存 occupants order：account -10 / general 0 / models 10 / plugins 15 / agent-presets 20
//        → 本区取 order 30（追加在既有区之后）。
//   [L3] Client 平台服务目录：layout / locale / sessions / slots / theme / timer / uiWorkspace /
//        workspaces —— 无 configEditor、无 credentials。factory 产物 inject 声明缺席服务 → 模块
//        整体不激活（references/practices.md）。故 inject 恰为 ["slots"]，多一个都红——真机定案
//        （#46）："host" 亦幻影（声明 → pending waiting for service: host；见 PHANTOM_SERVICES 注）。
//   [L4] host web 服务对 client 仅 @Remote listProviders —— v0.1 无「客户端编辑宿主配置」桥。
//
// ─── v0.1 范围裁决（docs/specs/draft/settings-ui.md 设计决定 / settings-ui.md:37）─────────
//   「必要时采用已验证的插件配置区作为宿主入口」：v0.1 的配置编辑走内置插件页
//   （bundle 行 config + 插件 Config schema，见第 6 组用例）；自定义 settings.section 区为
//   【只读指示器】——标题「网页搜索链」+ 指向内置插件页的指引文案（文案须含「插件」）。
//   createSettingsPanel 的编辑端口面继续由 settings-ui.test.js 在 src/client.js 逻辑端口层钉合，
//   不经 client-entry 进入 client ctx（幻影面 configEditor/credentials 撤除，维持 v0.2 裁决）。
//
// ─── v0.2（test df90b6a）→ v0.3 的钉迁移 ─────────────────────────────────────────────────
//   旧 T2「挂载形状」、旧 T3「幂等」为 live [L1][L2] 有效钉，原样迁移到 factory 产物
//   （factory(fakeRequire) 返回物的 apply）上；旧 T4「内置插件页编辑面」、旧 T5「纯增量守卫」
//   原样保留（本文件第 6、7、8 组）。旧 T1 的「entry 裸 ESM 导出 inject/apply」与
//   「React 经 loader.require 懒取」面全部删除（[M1][M2]），由第 1–3 组自注册/factory 面替代。
//
// ─── 缺陷钉（历史：对裸 ESM 实现 f0e0713 三面红；当前绿=已修复，回退即红）─────────────────
//   ① 自注册缺位：现实现为裸 ESM export（export const inject / export function apply），
//      load 捕获 0 次 → 第 1 组红，第 2（factory）3（挂载）4（幂等）组连带红；
//   ② React 通道错：现实现组件经 window.__ModuleLoader__.require('react') 取 React（[M2]
//      不存在的 API），factory 注入的 fake require 无从供 React → 第 2 组 spec 'react' 钉红、
//      第 3 组渲染树连带红；
//   ③ manifest：dsh.client.inject 现 ["slots"]，按 [M4] 须 [] → 第 5 组红。
//   红不得改 skip、不得删断言（helpers/impl.js 约定），只能经实现转绿。
//
// ─── 纯增量前提 ────────────────────────────────────────────────────────────────────────
//   src/index.js 的 web provider 面（inject/apply/Config）不得被本工作移动；装配测试全绿是合入
//   前提，本文件末尾保留 host 面守卫（第 8 组），与第 6 组 Config schema 面双向钉合。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";

const WP = "SET-001 client wire src/client-entry.js（ModuleLoader load() 自注册）";

// 字面量钉合（槽名/区域 id/标题/order/包名的改动必须在此显式过堂；值出处 [M3]/[L1][L2] 与 catalog.js）：
const SLOT = "settings.section";
const SECTION_ID = "search-chain";
const SECTION_TITLE = "网页搜索链";
const SECTION_ORDER = 30; // [L2]：agent-presets 20 之后
const PACKAGE_ID = "dsh-search-chain"; // [M3]：load 注册 id 恒 = 包名
// 区域标题 + 编辑指引要素（#46 rev 轮，P1-1 已证路径定案：真机 verify-ui-46 步骤 6a-6b 实证
// 可走路径 = 侧栏「插件」→ dsh-search-chain 卡片 → 详情页配置表单；「设置→…」路由仍未证
// （nav 无设置入口）→ 禁「设置→」前缀，设置页路由仍为规格 BCF-006 开放项。历史：六要素
// 钉过约束废 → 放宽为 设置+包名 → 本轮按已证路径重新收紧（git 历史可考））：
// Issue #48 migration：section 4 原断言 v0.1 只读指示器的指引文案（插件/详情/配置表单）已迁移为
// v0.2 面板 SET-001 的区域文案（网页搜索链 / 添加搜索工具）。迁移后本段对 v0.1 组件红属预期，
// 直至 v0.2 面板落地；「设置→」禁令保留（BCF-006 开放项未变）。
const COMPONENT_TEXT_MARKS = [SECTION_TITLE, "添加搜索工具"];
// live [L3]：client 平台真实服务目录（factory 产物 inject 的消息参照）。
const CLIENT_SERVICE_CATALOG = [
  "layout", "locale", "sessions", "slots", "theme", "timer", "uiWorkspace", "workspaces",
];
// v0.1 已知幻影面（[L3][L4]）：出现在 inject 里必须红，且红名可读。
const PHANTOM_SERVICES = ["configEditor", "credentials", "host"];
// ↑ "host"（#46 迁移轮，真机两轮探针定案，BCF-001 冲突史）：静态 client factory 声明
//   inject:["slots","host"] → 包不激活 `pending (waiting for service: host)`；未声明读
//   ctx.host → 抛 `cannot get property "host" without inject`。host.call → 宿主半通道作废，
//   表单读写走同源 settings RPC（bundle-config-ui.md [C3][C8]）。

// cache-bust：自注册模块的每次动态 import 用新 URL（?v=）绕开 ESM 模块缓存，
// 保证 [M1] 的 import 期 load 副作用每次重新执行。
let bustCounter = 0;

// ────────────────────────────────────────────────────────────────────────────────────────
// [M1] 宿主装载环境替身
// ────────────────────────────────────────────────────────────────────────────────────────

/**
 * 设 globalThis.window = { __ModuleLoader__: { load: capture } }，动态 import
 * src/client-entry.js 的 cache-bust 新副本，返回 load 捕获的注册表。
 * import 结束即恢复 window——factory 是纯闭包产物，后续调用不得再依赖全局 window
 * （React 只经 factory 入参 require 通道，[M1][M2]）。
 * @param {string} tag 用例标签（进 cache-bust URL）
 * @returns {Promise<Array<{ id: unknown, factory: unknown }>>}
 */
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

/**
 * factory 的 require 通道（[M1]）：记录每次取用的 spec；reactValue 为 'react' 的给值
 * （undefined = 模块表里没有 react）。宿主 loader 无 require 属性（[M2]），本文件任何
 * 替身都不提供 __ModuleLoader__.require，确保「经注入 require 取 React」是唯一绿路。
 */
function makeFakeRequire(reactValue) {
  const specs = [];
  const require = (spec) => {
    specs.push(spec);
    return spec === "react" ? reactValue : undefined;
  };
  return { require, specs };
}

/** 假 react.createElement：产出 { type, props, children } 节点树（真实 DOM 全程缺席）。 */
function makeFakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? null, children };
    },
  };
}

/** 收集节点树全部文本（兼容 children 展开、props.children、数组与嵌套）。 */
function collectText(node, out) {
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
// live 形状 ctx 替身与 DOM 陷阱（v0.2 原样保留：[L1] 挂载形状与零 DOM 钉不随装载面修正而变）
// ────────────────────────────────────────────────────────────────────────────────────────

/**
 * live 形状 client ctx 替身：slots.inject(name, factory) → cleanup；
 * slots.register(registration, Component) → unregister（形状按 [L1] 与 [M1] 模板内 apply）。
 * register 归属哪个 inject 回调由 mountInjected 执行期间的 activeInject 记账——
 * 「注册须经 inject 回调发生」与「inject 的 cleanup 撤销其名下注册」由此可观测。
 */
function makeLiveClientCtx() {
  const injects = []; // { name, factory }（宿主懒挂载前唯一观测面）
  const regs = []; // { registration, Component, via }
  const effects = [];
  let activeInject = null;
  const removeReg = (rec) => {
    const i = regs.indexOf(rec);
    if (i >= 0) regs.splice(i, 1);
  };
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
          for (const r of regs.filter((x) => x.via === rec)) removeReg(r);
        };
      },
      register(registration, Component) {
        const rec = { registration, Component, via: activeInject };
        regs.push(rec);
        let off = false;
        return () => {
          if (off) return;
          off = true;
          removeReg(rec);
        };
      },
    },
    effect(fn) {
      effects.push(fn);
    },
  };
  /** 模拟宿主挂载：执行第 index 个 inject 懒工厂（宿主调用工厂的时点替身）。 */
  function mountInjected(index = 0) {
    const rec = injects[index];
    if (!rec) throw new Error("无可执行的 inject 回调：挂载未走 ctx.slots.inject");
    activeInject = rec;
    try {
      return rec.factory();
    } finally {
      activeInject = null;
    }
  }
  return { ctx, injects, regs, effects, mountInjected };
}

/** 执行 apply 内经 ctx.effect 登记的全部资源，返回各自 cleanup。 */
function runEffects(effects) {
  return effects.map((fn) => fn());
}

/**
 * DOM 陷阱：以 getter 挂上 window/document（node 恒无二者；getter 触发本身不记点，
 * `typeof window` 类探测不误伤）。记点 = 对 DOM 对象的属性访问/赋值（document.createElement 等），
 * 以及 window 上 DOM 类属性。本替身的 window.__ModuleLoader__ 为 undefined 且不记点：
 * 自注册守卫须在无模块表时安全短路（loader 只有 mode/pendingQueue/load/create，[M2]）。
 */
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
      if (p === "document") return doc; // 裸引用不记点；对它的属性访问才记点
      if (DOM_WINDOW_PROPS.has(p)) touches.push(`window.${p}`);
      return undefined; // __ModuleLoader__ 等非 DOM 面：不记点
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
// 1. 自注册（[M1][M3]）：load 恰 1 次、id = 包名、factory 为函数
// ────────────────────────────────────────────────────────────────────────────────────────

test("自注册：window.__ModuleLoader__ 下 cache-bust import → load 恰 1 次；registration.id=包名；factory 为函数（[M1][M3]）", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  let registrations;
  try {
    registrations = await importSelfRegister("selfreg");
  } catch (e) {
    assert.fail(
      "load 环境下动态 import src/client-entry.js 不得抛——import 期须完成 " +
        `__ModuleLoader__.load({ id, factory }) 自报（[M1]）：${e && e.stack}`,
    );
  }
  assert.equal(
    registrations.length,
    1,
    `load 须恰被调用 1 次；现 ${registrations.length} 次——现实现为裸 ESM 导出、不向 ` +
      `__ModuleLoader__.load 自报（v0.2 假装载面，红属预期，[M1]）`,
  );
  const reg = registrations[0];
  assert.equal(reg.id, PACKAGE_ID, `load 注册 id 恒 = 包名 "${PACKAGE_ID}"（[M3]）`);
  assert.equal(reg.id, pkg.name, "load 注册 id 须与 package.json name 一致（[M3]）");
  assert.equal(typeof reg.factory, "function", "load 注册 factory 须为函数（inject/apply 产物与 React 通道都在 factory 面上，[M1]）");
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 2. node import 面保留：无 window 零抛、import 期零 DOM 接触
// ────────────────────────────────────────────────────────────────────────────────────────

test("node import 面保留：无 window（DOM 陷阱）下 import 零抛、import 期零 DOM 接触", async (t) => {
  const trap = installDomTrap();
  let res;
  try {
    res = await tryImportSrc("client-entry.js");
  } finally {
    trap.restore();
  }
  assert.deepEqual(trap.touches, [], `node 环境 import client-entry 不得接触 DOM：${JSON.stringify(trap.touches)}`);
  if (failIfUnimplemented(t, res, WP, "import 面")) return;
  // 无模块表（__ModuleLoader__ 缺席）即安全短路：不抛、不自注册、零副作用。
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 3. factory 面（[M1][M2]）：factory(fakeRequire) → { inject:["slots"], apply }
// ────────────────────────────────────────────────────────────────────────────────────────

test("factory 面：factory(fakeRequire) 返回 {inject:[\"slots\"],apply}；fakeRequire 记 spec 'react'；幻影服务=红（[M1][M2][L3]）", async () => {
  const registrations = await importSelfRegister("factory");
  if (registrations.length !== 1) {
    assert.fail(
      `factory 面以自注册成立为前提（load 恰 1 次，见第 1 组；现 ${registrations.length} 次），红属预期（[M1]）`,
    );
  }
  const { factory } = registrations[0];
  if (typeof factory !== "function") {
    assert.fail(`load 注册 factory 须为函数（现 ${typeof factory}），factory 面无从谈起（[M1]）`);
  }
  const { require, specs } = makeFakeRequire(makeFakeReact());
  let product;
  try {
    product = factory(require);
  } catch (e) {
    assert.fail(`factory(fakeRequire) 不得抛——React 经注入的 require('react') 通道获取（[M1]）：${e && e.message}`);
  }
  assert.ok(product && typeof product === "object", "factory 须返回模块产物对象（模板 { inject, apply } 形态）");
  assert.ok(Array.isArray(product.inject), "产物 inject 须为数组（模板 { inject, apply } 形态）");
  for (const phantom of PHANTOM_SERVICES) {
    assert.ok(!product.inject.includes(phantom), `inject 不得声明幻影服务 "${phantom}"（client 平台无此服务，[L3]）`);
  }
  assert.deepEqual(
    [...product.inject].sort(),
    ["slots"],
    `factory 产物 inject 须恰为 ["slots"]；live client 服务目录 = ${CLIENT_SERVICE_CATALOG.join("/")}`,
  );
  assert.equal(typeof product.apply, "function", "产物 apply 须为函数");
  assert.ok(
    specs.includes("react"),
    "factory 须经注入的 require('react') 取 React（模板逐字 const React=require('react')，[M1]）；" +
      `实取 spec：${JSON.stringify(specs)}——现实现经 window.__ModuleLoader__.require 懒取，` +
      "该属性在宿主 loader 上不存在（[M2]），红属预期",
  );
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 4. 挂载形状（v0.2 T2 有效钉迁移到 factory 产物）+ 只读渲染树 + 无 react 降级
// ────────────────────────────────────────────────────────────────────────────────────────

test("挂载形状（factory 产物）：apply→inject 回调恰 1 次 register 恰 {name,id,order,label}；假 react 渲染树含「网页搜索链」与「添加搜索工具」（SET-001 v0.2 区域文案，禁「设置→」，BCF-006 P1-1）；无 react 安全降级；effect cleanup（[L1][L2]）", async () => {
  const registrations = await importSelfRegister("mount");
  if (registrations.length !== 1 || typeof registrations[0].factory !== "function") {
    assert.fail(
      `挂载形状以自注册/factory 面成立为前提（[M1]，见第 1/3 组；现 load ${registrations.length} 次），红属预期`,
    );
  }
  const { require } = makeFakeRequire(makeFakeReact());
  const h = makeLiveClientCtx();
  const trap = installDomTrap();
  let failure = null;
  try {
    const product = registrations[0].factory(require);
    try {
      product.apply(h.ctx);
    } catch (e) {
      assert.fail(
        "apply(ctx) 在 live 形状 ctx（只有 slots/effect，[L3]）上直接抛错：" +
          `${e && e.message}`,
      );
    }
    // 恰 1 次 inject；注册懒挂载：apply 时点不得已 register（[M1] 模板：inject 懒回调）。
    // #46 BCF-001：apply 另含 plugins.bundle.config 槽（见 client-bundle-config.test.js 第 1 组），
    // 故钉 settings.section 的 inject 次数（不再钉 apply 的总 inject 数）。
    assert.equal(
      h.injects.filter((x) => x.name === SLOT).length,
      1,
      `settings.section 须恰调用 ctx.slots.inject 1 次；现 ${h.injects.filter((x) => x.name === SLOT).length} 次`,
    );
    assert.equal(h.injects[0].name, SLOT, `inject 槽名须为 "${SLOT}"`);
    assert.equal(typeof h.injects[0].factory, "function", "inject 第二参须为懒工厂函数");
    assert.equal(h.regs.length, 0, "注册须经 inject 回调发生（apply 时点不得已完成 register）");

    h.mountInjected(0); // 模拟宿主挂载该懒工厂
    assert.equal(h.regs.length, 1, "经 inject 回调的 register 须恰 1 次");
    const rec = h.regs[0];
    assert.ok(rec.via === h.injects[0], "register 须发生在 inject 回调执行期间");

    // registration 恰 {name,id,order,label}（[L1]）：title/panel 是 v0.1 假形状字段，live 不存在。
    const reg = rec.registration;
    assert.equal(typeof reg, "object", "register 第一参须为 registration 对象");
    assert.ok(!("title" in reg) && !("panel" in reg), "title/panel 为假形状键，不得出现在 live registration");
    assert.deepEqual(
      Object.keys(reg).sort(),
      ["id", "label", "name", "order"],
      "registration 恰 {name,id,order,label}（live [L1]：panel 不是字段，经第二参组件工厂传入）",
    );
    assert.equal(reg.name, SLOT);
    assert.equal(reg.id, SECTION_ID);
    assert.equal(reg.order, SECTION_ORDER, `order 须为 ${SECTION_ORDER}——live [L2]：account -10/general 0/models 10/plugins 15/agent-presets 20 之后`);
    if (typeof reg.label === "function") {
      const s = reg.label();
      assert.equal(typeof s, "string", "label 为函数时求值须为字符串（live label?: string|(()=>string)）");
      assert.equal(s, SECTION_TITLE, "SET-001：区域标题「网页搜索链」");
    } else {
      assert.equal(typeof reg.label, "string", "label 须为 string 或 (()=>string)");
      assert.equal(reg.label, SECTION_TITLE, "SET-001：区域标题「网页搜索链」");
    }

    // 第二参 = React 组件工厂；经 factory 注入的假 react createElement 产出指示器节点树
    // （v0.1 只读面：标题 + 指向内置插件页的指引，文案钉「网页搜索链」「插件」在场）。
    assert.equal(typeof rec.Component, "function", "register 第二参须为组件工厂函数（[L1]：panel 不是字段）");
    const tree = rec.Component({ close() {} });
    assert.ok(
      tree !== null && tree !== undefined,
      "假 react 在场（factory 注入 require('react')）时组件须产出指示器节点树，不得恒 null",
    );
    const text = collectText(tree, []).join("");
    for (const mark of COMPONENT_TEXT_MARKS) {
      assert.ok(
        text.includes(mark),
        `组件文案须含「${mark}」（SET-001 v0.2 区域文案，Issue #48 迁移）；实收文本：${JSON.stringify(text)}`,
      );
    }
    assert.ok(
      !text.includes("设置→"),
      `指引禁「设置→」前缀——设置页路由未证（[C6] nav 无设置入口，BCF-006 开放项）；实收文本：${JSON.stringify(text)}`,
    );
  } catch (e) {
    failure = e;
  } finally {
    trap.restore();
  }
  if (trap.touches.length > 0) {
    assert.fail(
      "node headless 全程零 DOM 接触（factory→apply→inject 回调→组件渲染）被违反：" +
        JSON.stringify(trap.touches) +
        (failure ? `（另有首错：${failure.message}）` : ""),
    );
  }
  if (failure) throw failure;

  // 零 DOM 全程成立后再钉 effect 纳管与注销（cleanup 自身不得触碰 DOM——再挂陷阱验证）。
  const trap2 = installDomTrap();
  let cleanups = [];
  failure = null;
  try {
    cleanups = runEffects(h.effects);
    assert.ok(cleanups.length >= 1, "apply 须把挂载资源经 ctx.effect 登记（模板副作用规则）");
    for (const c of cleanups) assert.equal(typeof c, "function", "ctx.effect 回调须返回 cleanup 函数");
    for (const c of cleanups) c();
    assert.equal(h.regs.length, 0, "cleanup 后注册须清零");
    assert.equal(h.injects.length, 0, "纳管 cleanup 须是 inject 返回的 cleanup（撤销懒工厂挂载本身）");
    for (const c of cleanups) c(); // 幂等：重复 cleanup 无副作用
    assert.equal(h.regs.length, 0);
  } catch (e) {
    failure = e;
  } finally {
    trap2.restore();
  }
  if (trap2.touches.length > 0) {
    assert.fail(`cleanup 路径零 DOM 接触被违反：${JSON.stringify(trap2.touches)}`);
  }
  if (failure) throw failure;

  // 无 react 安全降级：独立模块副本 + 模块表里没有 react 的 fakeRequire。
  // 钉：factory/apply/mount 全程不抛，组件调用返回 null/空（headless 测试与无表宿主安全）。
  const regs2 = await importSelfRegister("mount-noreact");
  if (regs2.length !== 1 || typeof regs2[0].factory !== "function") {
    assert.fail("降级面以自注册成立为前提（[M1]，见第 1 组）；本例钉组件调用不依赖 React 存在");
  }
  const { require: bareRequire } = makeFakeRequire(undefined); // 模块表里没有 react
  const h2 = makeLiveClientCtx();
  const trap3 = installDomTrap();
  let failure2 = null;
  try {
    const product2 = regs2[0].factory(bareRequire);
    assert.ok(product2 && typeof product2.apply === "function", "React 缺席时 factory 仍须产出 apply 面（factory 期不得抛）");
    product2.apply(h2.ctx);
    h2.mountInjected(0);
    assert.equal(h2.regs.length, 1, "React 缺席时注册形状面不变（渲染降级 ≠ 挂载缺席）");
    const out = h2.regs[0].Component({ close() {} });
    const emptyish =
      out === null || out === undefined || out === false || out === "" ||
      (Array.isArray(out) && out.length === 0);
    assert.ok(
      emptyish,
      `fakeRequire 无 react 时组件调用须安全降级为 null/空，不得抛、不得产出节点树；实返：${JSON.stringify(out)}`,
    );
  } catch (e) {
    failure2 = e;
  } finally {
    trap3.restore();
  }
  if (trap3.touches.length > 0) {
    assert.fail(`无 react 降级路径零 DOM 接触被违反：${JSON.stringify(trap3.touches)}`);
  }
  if (failure2) {
    assert.fail(`fakeRequire 无 react 时 factory→apply→挂载→组件调用全程不得抛（安全降级）：${failure2 && failure2.message}`);
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 5. 幂等（v0.2 T3 有效钉迁移到 factory 产物）
// ────────────────────────────────────────────────────────────────────────────────────────

test("幂等：factory 产物同一 ctx 重复 apply 不双 inject；挂载后恰 1 注册；cleanup 纳管后清零", async () => {
  const registrations = await importSelfRegister("idempotent");
  if (registrations.length !== 1 || typeof registrations[0].factory !== "function") {
    assert.fail("幂等面以自注册/factory 面成立为前提（[M1]，见第 1/3 组），红属预期");
  }
  const { require } = makeFakeRequire(makeFakeReact());
  const product = registrations[0].factory(require);
  const h = makeLiveClientCtx();
  try {
    product.apply(h.ctx);
    product.apply(h.ctx); // 第二次 apply：不得产生第二个 inject
  } catch (e) {
    assert.fail(`apply(ctx) 在 live 形状 ctx 上直接抛错（见第 4 组）：${e && e.message}`);
  }
  // #46 BCF-001：总 inject 数含 plugins.bundle.config 槽，钉 settings.section 的次数。
  assert.equal(h.injects.filter((x) => x.name === SLOT).length, 1, "重复 apply 不得双 inject（settings.section）");
  h.mountInjected(0);
  assert.equal(h.regs.length, 1, "重复 apply + 挂载后仍恰 1 个 settings.section 注册");
  const cleanups = runEffects(h.effects);
  for (const c of cleanups) assert.equal(typeof c, "function", "ctx.effect 回调须返回 cleanup 函数");
  for (const c of cleanups) c();
  assert.equal(h.regs.length, 0);
  assert.equal(h.injects.length, 0, "纳管 cleanup 经 inject 返回的 cleanup 撤销挂载");
  for (const c of cleanups) c(); // 幂等：重复 cleanup 无副作用
  assert.equal(h.regs.length, 0);
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 6. 装载线 manifest（[M4]）：dsh.client.inject 是装载包列表 —— 恰 []
// ────────────────────────────────────────────────────────────────────────────────────────

test("manifest：dsh.client platform=web、inject 恰 []（装载包列表非服务名表，[M4]；owner 包顺序项属 H-5 可后补）", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  // 既有宿主面不动：包名与 "." 导出保持。
  assert.equal(pkg.name, PACKAGE_ID);
  assert.equal(pkg.exports["."], "./src/index.js");
  // ./client 导出指向新入口（装载线落点）。
  assert.equal(pkg.exports["./client"], "./src/client-entry.js");
  // dsh.client 存在（模板字段：platform/inject 必备，immediately 出现则须为布尔）。
  const client = pkg.dsh?.client;
  assert.ok(client && typeof client === "object", "dsh.client 缺失：Client 产物不会被宿主装载（SET-001 缺口本体）");
  assert.equal(client.platform, "web", "dsh.client.platform 须为 \"web\"（模板 decoration/package.json）");
  assert.ok(Array.isArray(client.inject), "dsh.client.inject 须为数组（[M4]：装载包 id 列表）");
  assert.deepEqual(
    client.inject,
    [],
    "dsh.client.inject 是装载包列表而非服务名表（[M4]）：本包 factory 所需 React 由宿主模块表经 " +
      "load 注入的 require 提供（[M1]），不是独立装载包。现 [\"slots\"] 让宿主装载 phantom 包 → " +
      "模块整体不激活，红属预期。注记：owner 包顺序项属 H-5 实机核对，可后补（届时补钉，非本包职责）",
  );
  if ("immediately" in client) {
    assert.equal(typeof client.immediately, "boolean");
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 7. 内置插件页编辑面（v0.1 编辑桥所在）：cordis.patch.yml 行声明 + Config schema 类型注记
//    —— v0.2 第 4 组有效钉，原样保留
// ────────────────────────────────────────────────────────────────────────────────────────

/**
 * 最小 YAML 行抽取（loader patch 方言，references/composition-reference.md：insert 行 +
 * 字面 config；config 整体替换不深合并，故种子里有什么就是什么）。
 * 返回 [{ id, name, configSummary, entries: {present, isList} }]。
 */
function extractPatchRows(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  const flowEntries = (inline) => {
    const m = (inline || "").match(/(?:[,{]|^)\s*['"]?entries['"]?\s*:\s*(\[[^\]]*\]|[^,}]+)/);
    if (!m) return { present: false, isList: false };
    return { present: true, isList: /^\[.*\]$/.test(m[1].trim()) };
  };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s+id:\s*(\S.*?)\s*$/);
    if (!m) continue;
    const dashCol = m[1].length;
    const keyCol = dashCol + 2;
    const row = { id: m[2].replace(/^['"]|['"]$/g, ""), name: "", configSummary: "", entries: { present: false, isList: false } };
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "" || /^\s*#/.test(line)) continue;
      const indent = line.match(/^\s*/)[0].length;
      if (indent < keyCol) break; // 出栈（下一配置行或下一层结构）
      const fm = line.match(/^(\s*)([A-Za-z_$][\w$]*):\s*(.*?)\s*$/);
      if (fm && fm[1].length === keyCol) {
        const [, , key, inline] = fm;
        if (key === "name") row.name = inline.replace(/^['"]|['"]$/g, "");
        if (key === "config") {
          if (inline !== "") {
            row.configSummary = inline;
            row.entries = flowEntries(inline);
          } else {
            // 块式 config：子键列 = 首个更深行；entries 子键同行值或更深 "-" 列表。
            let childCol = null;
            const keys = [];
            for (let k = j + 1; k < lines.length; k++) {
              const cl = lines[k];
              if (cl.trim() === "" || /^\s*#/.test(cl)) continue;
              const ci = cl.match(/^\s*/)[0].length;
              if (ci <= keyCol) break;
              if (childCol === null) childCol = ci;
              if (ci !== childCol) continue;
              const ck = cl.match(/^(\s*)([A-Za-z_$][\w$]*):(.*)$/);
              if (!ck) continue;
              keys.push(ck[2]);
              if (ck[2] === "entries") {
                const v = ck[3].trim();
                if (/^\[.*\]$/.test(v)) row.entries = { present: true, isList: true };
                else if (v === "") {
                  // 同行无值：下一段更深缩进的 "-" 行为列表种子。
                  let isList = false;
                  for (let n = k + 1; n < lines.length; n++) {
                    const nl = lines[n];
                    if (nl.trim() === "" || /^\s*#/.test(nl)) continue;
                    isList = nl.match(/^\s*/)[0].length > childCol && /^\s*-\s/.test(nl);
                    break;
                  }
                  row.entries = { present: true, isList };
                } else row.entries = { present: true, isList: false };
              }
            }
            row.configSummary = keys.length ? "(块式: " + keys.join("/") + ")" : "(空)";
          }
        }
      }
    }
    rows.push(row);
    i = j - 1;
  }
  return rows;
}

test("内置插件页编辑面（v0.1）：cordis.patch.yml 行声明 entries 种子 + Config schema 类型注记（settings-ui.md:37）", async (t) => {
  // v0.1 裁决：client 无编辑桥（[L4]），编辑走内置插件页；行 config 必须显式声明 entries 字段
  // 作为可编辑种子。形状自查 references/host-plugin.md Config 面：行 config 由插件 Config 激活时
  // 校验、编辑前经 Config.listConfigs 投影读取——YAML 行无类型通道，故最小面 =
  // 字段存在（patch 种子）+ 类型注记（Config 面）。
  let text;
  try {
    text = await readFile(new URL("../src/cordis.patch.yml", import.meta.url), "utf8");
  } catch {
    assert.fail("src/cordis.patch.yml 缺失：内置插件页编辑面无从谈起（勿改 skip）");
    return;
  }
  const rows = extractPatchRows(text);
  assert.equal(rows.length, 1, `patch 须恰含 1 个 insert 配置行（现识别 ${rows.length} 个）`);
  const row = rows[0];
  assert.equal(row.id, SECTION_ID);
  assert.equal(row.name, "dsh-search-chain");
  assert.ok(
    row.entries.present,
    "行 config 必须声明 entries 字段（内置插件页可编辑种子，v0.1 唯一编辑入口）；" +
      `现 config: ${row.configSummary}——缺则此例红=dev 补（如 entries: []）`,
  );
  assert.ok(row.entries.isList, `entries 种子值须为列表（[] 或块式项）——非列表种子过不了自家 Config 校验，内置页写入恒红；现值判定非列表（config: ${row.configSummary}）`);

  // 类型注记面：src/index.js 的 Config——{entries: []} 装载合法；entries 非数组须出 issues。
  const host = await tryImportSrc("index.js");
  if (failIfUnimplemented(t, host, "WP6 src/index.js", "Config schema 面")) return;
  const std = host.module.Config?.["~standard"];
  assert.equal(typeof std?.validate, "function", "Config 须带 Standard Schema 面（宿主 resolveConfig 实机面，见 dsh-config-schema.test.js）");
  const okRes = std.validate({ entries: [] });
  assert.ok(!("then" in okRes) && !okRes.issues, `行种子同形 {entries: []} 必须通过自家 Config 校验：${JSON.stringify(okRes)}`);
  const badRes = std.validate({ entries: "not-a-list" });
  assert.ok(badRes.issues && badRes.issues.length > 0, "entries 类型注记缺失：非数组须出 issues（内置页写入的类型闸）");
  if (typeof host.module.Config.toJSON === "function") {
    // refs-only（#43 审阅轮收紧，回收此前的 OR 放宽）：{uid,refs} 序列化是唯一合法形态——
    // 宿主 plainSchema=new z(schema.toJSON()) 只消费 refs 重建面，JSON Schema 字面投影在宿主
    // 侧无从装载（旧形态必红）；entries 的类型注记 = 根节点（refs[uid]）dict.entries 指向的
    // refs 节点 type=array。
    const proj = host.module.Config.toJSON();
    assert.ok(
      proj !== null && typeof proj === "object" && "uid" in proj && "refs" in proj && typeof proj.refs === "object",
      "toJSON() 必须为 schemastery refs 序列化（{uid, refs}）；JSON Schema 投影形态不再合法。" +
        `实际顶层键：${JSON.stringify(Object.keys(proj ?? {}))}`,
    );
    const entriesNode = proj.refs?.[proj.refs?.[proj.uid]?.dict?.entries];
    assert.equal(entriesNode?.type, "array", "序列化投影的 entries 类型注记须为 array（Config.listConfigs 投影可读面，host-plugin.md Config 节）");
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 8. 纯增量守卫（v0.2 第 5 组有效钉，原样保留）
// ────────────────────────────────────────────────────────────────────────────────────────

test("纯增量守卫：src/index.js 的 web provider 装配面不动", async () => {
  const host = await import("../src/index.js");
  assert.equal(typeof host.apply, "function");
  // #43 迁移注记：schemastery Schema 节点是可调函数（Schema.prototype 链自 Function.prototype），
  // 「Config 行 schema 在场」的语义面对 object/function 两形态均成立；手写对象面同样通过。
  assert.ok(host.Config && (typeof host.Config === "object" || typeof host.Config === "function"));
  assert.deepEqual(host.inject, ["web", "configEditor", "credentials", "agents"]);
});
