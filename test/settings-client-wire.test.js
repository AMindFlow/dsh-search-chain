// WP13 客户端挂载线（oracle）v0.2 —— settings.section 注册契约按 live 重钉（推翻重写 PR#40 假形状面）。
//
// 本文件不改实现，只钉「装载线 + 挂载形状 + v0.1 编辑面声明」最小契约：
// package.json dsh.client / exports["./client"]、src/client-entry.js 的 inject/apply/registration/
// 组件工厂懒加载，与内置插件页可编辑所需的 cordis.patch.yml + Config schema 注记。
//
// ─── live 实证（lead cordis inspect，DSH 0.2.2-rc.5，2026-11-25，写入本头注为权威基准）──────
//   [L1] settings.section 注册形状：{ id: string 必, order?: number, label?: string|(()=>string) }。
//        panel 不是字段——ctx.slots.register 的第二参是 React 组件工厂；ownerProps 只给 { close }。
//        挂载写法（templates/decoration/client.js 同形）：
//          ctx.slots.inject("settings.section", () =>
//            ctx.slots.register({ name: "settings.section", id, order, label }, Component))
//   [L2] 现存 occupants order：account -10 / general 0 / models 10 / plugins 15 / agent-presets 20
//        → 本区取 order 30（追加在既有区之后）。
//   [L3] Client 平台服务目录：layout / locale / sessions / slots / theme / timer / uiWorkspace /
//        workspaces —— 无 configEditor、无 credentials。inject 声明缺席服务 → 模块整体不激活
//        （references/practices.md）。故 entry inject 恰为 ["slots"]，多一个都红。
//   [L4] host web 服务对 client 仅 @Remote listProviders —— v0.1 无「客户端编辑宿主配置」桥。
//   复核注记（本机，同版）：client Slots.listSubTree 查询超时（Harness 页面未连接），host
//   Config.listConfigs 目录无 dsh-search-chain 活行（本 profile 未装载该 bundle）——形状基准
//   以 lead 0.2.2-rc.5 实证 [L1]–[L4] 为准，未在线复核项不得反向放宽。
//
// ─── v0.1 范围裁决（docs/specs/draft/settings-ui.md 设计决定 / settings-ui.md:37）─────────
//   「必要时采用已验证的插件配置区作为宿主入口」：v0.1 的配置编辑走内置插件页
//   （bundle 行 config + 插件 Config schema，见第 4 组用例）；自定义 settings.section 区为
//   【只读指示器】。createSettingsPanel 的编辑端口面继续由 settings-ui.test.js 在 src/client.js
//   逻辑端口层钉合，不再经 client-entry 进入 client ctx（幻影面 configEditor/credentials 撤除）。
//
// ─── 对 PR#40（test 6cedc2a + src e1cc5de）假形状面的推翻注记 ────────────────────────────
//   旧契约按臆测钉 slots.register(slot, { id, title, panel }) 直调形状，并在 inject 声明 live
//   不存在的 configEditor/credentials。live 形状 [L1][L3] 下该实现恒不激活且注册字段全错——
//   本文件按 live 全部重钉。预期红：
//     ① entry inject ≠ ["slots"]（幻影声明）；② 挂载未走 ctx.slots.inject（假形状直调 register）；
//     ③ 重复 apply 面同②连带红；④ patch 行 config 无 entries 种子（dev 补）。
//   红不得改 skip、不得删断言（helpers/impl.js 约定），只能经实现转绿。
//
// ─── 纯增量前提 ────────────────────────────────────────────────────────────────────────
//   src/index.js 的 web provider 面（inject/apply/Config）不得被本工作移动；装配测试全绿是合入
//   前提，本文件末尾保留 host 面守卫（第 5 组），与第 4 组 Config schema 面双向钉合。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";

const WP = "SET-001 client wire src/client-entry.js（live 形状）";

// 字面量钉合（槽名/区域 id/标题/order 的改动必须在此显式过堂；值出处 live [L1][L2] 与 catalog.js）：
const SLOT = "settings.section";
const SECTION_ID = "search-chain";
const SECTION_TITLE = "网页搜索链";
const SECTION_ORDER = 30; // [L2]：agent-presets 20 之后
// live [L3]：client 平台真实服务目录；entry inject 声明此表之外名字的后果 = 模块整体不激活。
const CLIENT_SERVICE_CATALOG = [
  "layout", "locale", "sessions", "slots", "theme", "timer", "uiWorkspace", "workspaces",
];
// v0.1 已知幻影面（[L3][L4]）：出现在 inject 里必须红，且红名可读。
const PHANTOM_SERVICES = ["configEditor", "credentials"];

// ────────────────────────────────────────────────────────────────────────────────────────
// live 形状 ctx 替身与 DOM 陷阱
// ────────────────────────────────────────────────────────────────────────────────────────

/**
 * live 形状 client ctx 替身：slots.inject(name, factory) → cleanup；
 * slots.register(registration, Component) → unregister（形状按 [L1] 与模板 decoration/client.js）。
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
 * 以及 window 上 DOM 类属性；window.__ModuleLoader__（浏览器模块表，React 懒加载通道 [L1]/模板）
 * 不记点。
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
// 1. 装载线 manifest 与入口声明面
// ────────────────────────────────────────────────────────────────────────────────────────

test("装载线：dsh.client manifest + exports[\"./client\"] 保留面；entry inject 恰 [\"slots\"]（幻影服务=红）", async (t) => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  // 既有宿主面不动：包名与 "." 导出保持。
  assert.equal(pkg.name, "dsh-search-chain");
  assert.equal(pkg.exports["."], "./src/index.js");
  // dsh.client 存在（模板字段：platform/inject 必备，immediately 出现则须为布尔）。
  const client = pkg.dsh?.client;
  assert.ok(client && typeof client === "object", "dsh.client 缺失：Client 产物不会被宿主装载（SET-001 缺口本体）");
  assert.equal(client.platform, "web", "dsh.client.platform 须为 \"web\"（模板 decoration/package.json）");
  assert.ok(Array.isArray(client.inject), "dsh.client.inject 须为数组（模板：依赖的 Client 模块 id 列表）");
  for (const dep of client.inject) {
    assert.equal(typeof dep, "string");
    assert.ok(dep.length > 0, "dsh.client.inject 元素须为非空模块 id 字符串");
  }
  if ("immediately" in client) {
    assert.equal(typeof client.immediately, "boolean");
  }
  // ./client 导出指向新入口（装载线落点）。
  assert.equal(pkg.exports["./client"], "./src/client-entry.js");

  // 入口声明面：模块必须可在 node 直接 import（零抛），import 期零 DOM 接触。
  // 模板形态在工厂里 require('react')（浏览器模块表）；若照搬为模块顶层 React import，
  // node 装载即炸——懒加载 React 是装载线的一部分，此断言即闸。
  const trap = installDomTrap();
  let res;
  try {
    res = await tryImportSrc("client-entry.js");
  } finally {
    trap.restore();
  }
  assert.deepEqual(trap.touches, [], `node 环境 import client-entry 不得接触 DOM：${JSON.stringify(trap.touches)}`);
  if (failIfUnimplemented(t, res, WP, "装载面/inject")) return;
  const mod = res.module;
  // live [L3]：inject 恰 ["slots"]——configEditor/credentials 在 client 目录不存在，
  // 声明缺席服务的后果是模块整体不激活（practices.md），不是「拿不到该属性」。
  assert.ok(Array.isArray(mod.inject), "client-entry 须导出 inject 数组（模板 { inject, apply } 形态）");
  for (const phantom of PHANTOM_SERVICES) {
    assert.ok(!mod.inject.includes(phantom), `inject 不得声明幻影服务 "${phantom}"（client 平台无此服务，[L3]）`);
  }
  assert.deepEqual(
    [...mod.inject].sort(),
    ["slots"],
    `entry inject 须恰为 ["slots"]；live client 服务目录 = ${CLIENT_SERVICE_CATALOG.join("/")}，` +
      "现实现按 PR#40 假形状声明幻影面，红属预期",
  );
  assert.equal(typeof mod.apply, "function");
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 2. 挂载形状（live [L1]）：inject 懒回调 → register(registration, Component)
// ────────────────────────────────────────────────────────────────────────────────────────

test("挂载形状：经 inject 回调恰 1 次 register；registration 恰 {name,id,order,label} 无 title/panel；第二参组件工厂 headless 安全（live [L1][L2]）", async (t) => {
  const res = await tryImportSrc("client-entry.js");
  if (failIfUnimplemented(t, res, WP, "SET-001 挂载形状")) return;
  const mod = res.module;

  const h = makeLiveClientCtx();
  const trap = installDomTrap();
  let failure = null;
  try {
    try {
      mod.apply(h.ctx);
    } catch (e) {
      assert.fail(
        "apply(ctx) 在 live 形状 ctx（只有 slots/effect，[L3]）上直接抛错——现实现依赖 v0.1 幻影面 " +
          `configEditor/credentials 建面板，红属预期（裁决：编辑走内置插件页，自定义区只读）：${e && e.message}`,
      );
    }
    // 恰 1 次 inject；注册懒挂载：apply 时点不得已 register（模板：lazy factory）。
    assert.equal(
      h.injects.length,
      1,
      `须恰调用 ctx.slots.inject 1 次；现 ${h.injects.length} 次——现实现按 PR#40 假形状直调 slots.register（并在幻影 ctx 面上建面板），红属预期`,
    );
    assert.equal(h.injects[0].name, SLOT, `inject 槽名须为 "${SLOT}"`);
    assert.equal(typeof h.injects[0].factory, "function", "inject 第二参须为懒工厂函数");
    assert.equal(h.regs.length, 0, "注册须经 inject 回调发生（apply 时点不得已完成 register）");

    h.mountInjected(0); // 模拟宿主挂载该懒工厂
    assert.equal(h.regs.length, 1, "经 inject 回调的 register 须恰 1 次");
    const rec = h.regs[0];
    assert.ok(rec.via === h.injects[0], "register 须发生在 inject 回调执行期间");

    // registration 恰 {name,id,order,label}（[L1]）：title/panel 是 PR#40 假形状字段，live 不存在。
    const reg = rec.registration;
    assert.equal(typeof reg, "object", "register 第一参须为 registration 对象（假形状传 (slot字符串, descriptor)，红属预期）");
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

    // 第二参 = React 组件工厂；headless 调用（ownerProps 只给 { close }，[L1]）不得抛。
    // React 须经浏览器模块表在组件内懒加载；node 无 React 时须安全短路返回（顶层 import 则 import 即炸，第 1 组已红）。
    assert.equal(typeof rec.Component, "function", "register 第二参须为组件工厂函数（[L1]：panel 不是字段）");
    rec.Component({ close() {} });
  } catch (e) {
    failure = e;
  } finally {
    trap.restore();
  }
  if (trap.touches.length > 0) {
    assert.fail(
      "node headless 全程零 DOM 接触（apply→inject 回调→组件调用）被违反：" +
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
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 3. 幂等
// ────────────────────────────────────────────────────────────────────────────────────────

test("幂等：同一 ctx 重复 apply 不双 inject；挂载后恰 1 注册；inject cleanup 纳管后清零且可重放", async (t) => {
  const res = await tryImportSrc("client-entry.js");
  if (failIfUnimplemented(t, res, WP, "SET-001 幂等")) return;
  const mod = res.module;
  const h = makeLiveClientCtx();
  try {
    mod.apply(h.ctx);
    mod.apply(h.ctx); // 第二次 apply：不得产生第二个 inject
  } catch (e) {
    assert.fail(`apply(ctx) 在 live 形状 ctx 上直接抛错（幻影面连带，见第 2 组），红属预期：${e && e.message}`);
  }
  assert.equal(h.injects.length, 1, "重复 apply 不得双 inject（现实现无 inject 面，红属预期）");
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
// 4. 内置插件页编辑面（v0.1 编辑桥所在）：cordis.patch.yml 行声明 + Config schema 类型注记
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
    const proj = host.module.Config.toJSON();
    assert.equal(proj?.properties?.entries?.type, "array", "JSON Schema 投影的 entries 类型注记须为 array（Config.listConfigs 投影可读面，host-plugin.md Config 节）");
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────
// 5. 纯增量守卫
// ────────────────────────────────────────────────────────────────────────────────────────

test("纯增量守卫：src/index.js 的 web provider 装配面不动", async () => {
  const host = await import("../src/index.js");
  assert.equal(typeof host.apply, "function");
  assert.equal(typeof host.Config, "object");
  assert.deepEqual(host.inject, ["web", "configEditor", "credentials", "agents"]);
});
