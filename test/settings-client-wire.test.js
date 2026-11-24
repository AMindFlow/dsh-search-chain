// WP13 客户端挂载线（oracle）— SET-001 交付缺口的契约级钉合：
//   mountSettingsSection 无调用方 + package.json 无 dsh.client → Client 产物从未被宿主装载。
//   本文件不改实现，只钉「装载线」最小契约：src/client-entry.js 与 package.json dsh.client/exports["./client"]。
//
// 宿主形状权威（app.asar 内 dsh-doc 模板，read 核对于 2026-11-25）：
//   templates/decoration/client.js   模块形态 = { inject: ['slots'], apply(ctx) }；
//     资源在 apply 内经 ctx.effect/ctx.on 登记并返回 cleanup（ui-plugin.md「Keep factories free of side effects」）。
//   templates/decoration/package.json  dsh.client = { platform: "web", immediately: bool, inject: [模块id…] }；
//     exports 增加 "./client" 指向浏览器产物；loader id 恒等于包名。
//
// ─── 宿主/浏览器核对清单（H-5 注记，沿用 WP12 惯例 settings-ui.test.js H-5）──────────────
//   H-5 settings.section 真机 descriptor 形状（字段名、注销时机）与 __ModuleLoader__.load 编译产物
//       格式待实机证认（Slots.listSubTree 本轮仍未在线核对）；本契约只钉最小面：
//       slot 名 "settings.section"、descriptor { id, title, panel }（src/client.js 头注既有最小自描述形状）、
//       inject/apply/effect 语义按模板。真机若要求不同字段，只改 client-entry 的 descriptor 组装处。
//
// 预期红：src/client-entry.js 缺失、package.json 无 dsh.client 与 ./client 导出——红属预期
//   （helpers/impl.js 约定：勿改 skip、勿删断言，只能通过实现转绿）。
// 纯增量前提：src/index.js 的 web provider 面（inject/apply/Config）不得被本工作移动；
//   既有装配测试（assembly-*.test.js）全绿是合入前提，本文件末尾另钉一道 inject 面守卫。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tryImportSrc, failIfUnimplemented } from "./helpers/impl.js";
import { createSlotRegistry } from "./helpers/settings-oracle.js";

const WP = "SET-001 client wire src/client-entry.js";

// 字面量钉合（不 import 常量镜像，槽名/标题/行 id 的改动必须在此显式过堂）：
// 值出处 src/settings/catalog.js（SECTION_SLOT/SECTION_TITLE/PROVIDER_ID）。
const SLOT = "settings.section";
const TITLE = "网页搜索链";
const SECTION_ID = "search-chain";

/** 假浏览器 ctx：slots.register 替身捕获（oracle createSlotRegistry）+ ctx.effect/on 记录。 */
function makeClientCtx() {
  const slots = createSlotRegistry();
  const effects = [];
  const listeners = [];
  let editorReads = 0;
  const ctx = {
    slots, // register(slot, descriptor) → unregister（形状同 settings-oracle 契约头注）
    effect(fn) {
      effects.push(fn);
    },
    on(event, handler) {
      listeners.push({ event, handler });
    },
    // configEditor 客户端 ctx 面：满足 createSettingsPanel 的 settings 端口最小门（editor.edit/entry/current）。
    configEditor: {
      entry: { id: SECTION_ID },
      current() {
        editorReads += 1;
        return {};
      },
      editor: {
        async edit() {
          return {};
        },
      },
    },
    // credentials 客户端 ctx 面（SET-004 流向已由 settings-ui.test.js 钉死，本文件只钉声明与挂接存在）。
    credentials: {
      async set() {},
      async resolve() {},
    },
  };
  return { ctx, slots, effects, listeners, reads: () => editorReads };
}

/** 运行 apply 内经 ctx.effect 登记的全部资源，返回各自 cleanup。 */
function runEffects(effects) {
  return effects.map((fn) => fn()).filter((c) => typeof c === "function");
}

test("装载线 manifest：dsh.client 合法且 ./client 指向 src/client-entry.js（SET-001）", async () => {
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
});

test("client-entry：apply(ctx) 经 ctx.effect 恰注册 1 个 settings.section，descriptor 含 id/title/panel 面（SET-001）", async (t) => {
  const res = await tryImportSrc("client-entry.js");
  if (failIfUnimplemented(t, res, WP, "SET-001")) return;
  const mod = res.module;
  // 模板模块形态：inject 声明 ctx 面 + apply(ctx)。inject 按模板 inject 语义声明 slots/configEditor/credentials。
  assert.ok(Array.isArray(mod.inject), "client-entry 须导出 inject 数组（模板 { inject, apply } 形态）");
  for (const aspect of ["slots", "configEditor", "credentials"]) {
    assert.ok(mod.inject.includes(aspect), `inject 须声明 "${aspect}" ctx 面（依赖注入的声明面，模板 inject 语义）`);
  }
  assert.equal(typeof mod.apply, "function");

  const h = makeClientCtx();
  mod.apply(h.ctx);
  // 资源登记走 ctx.effect（模板：cleanup 由 effect 回调返回）。
  assert.ok(h.effects.length >= 1, "apply 须把挂载资源经 ctx.effect 登记（模板副作用规则）");
  // 恰 1 个 settings.section；descriptor 最小面 { id, title, panel }（H-5 注记：真机字段待实机证认）。
  assert.equal(h.slots.regs.length, 1, "settings.section 注册数须恰为 1");
  const rec = h.slots.regs[0];
  assert.equal(rec.slot, SLOT);
  assert.equal(rec.id, SECTION_ID);
  assert.equal(rec.title, TITLE);
  assert.ok(rec.panel && typeof rec.panel === "object", "descriptor.panel 必填");

  // panel 工厂产出对象 = createSettingsPanel 挂接：命令面存在 + 读数走注入的 configEditor 面。
  for (const cmd of ["open", "view", "save"]) {
    assert.equal(typeof rec.panel[cmd], "function", `panel 须为 createSettingsPanel 返回值（缺 ${cmd}）`);
  }
  const before = h.reads();
  const v = await rec.panel.open();
  assert.ok(h.reads() > before, "panel.open() 必须从注入的 ctx.configEditor.current 读数（依赖注入挂接证明）");
  assert.equal(v.emptyState, true, "空快照须呈空态（SET-001 空态经装配仍成立）");
  assert.equal(typeof v.addAction?.label, "string");

  // cleanup 注销（模板：effect 返回 cleanup；DSH-001 卸载语义）。
  const cleanups = runEffects(h.effects);
  assert.ok(cleanups.length >= 1, "ctx.effect 回调须返回 cleanup 函数");
  for (const cleanup of cleanups) cleanup();
  assert.equal(h.slots.regs.length, 0, "cleanup 后注册须清零");
  for (const cleanup of cleanups) cleanup(); // 幂等：重复 cleanup 无副作用
  assert.equal(h.slots.regs.length, 0);
});

test("幂等：同一 ctx 重复 apply 不双注册（复用 mountSettingsSection 既有幂等面）", async (t) => {
  const res = await tryImportSrc("client-entry.js");
  if (failIfUnimplemented(t, res, WP, "SET-001")) return;
  const mod = res.module;
  const h = makeClientCtx();
  mod.apply(h.ctx);
  assert.equal(h.slots.regs.length, 1);
  mod.apply(h.ctx); // 第二次 apply：不得产生第二个区域
  assert.equal(h.slots.regs.length, 1, "重复 apply 不得双注册（mountSettingsSection 幂等面）");
  // 两轮 effect 的 cleanup 全部执行后须清零且可重放。
  const cleanups = runEffects(h.effects);
  for (const cleanup of cleanups) cleanup();
  assert.equal(h.slots.regs.length, 0);
  for (const cleanup of cleanups) cleanup();
  assert.equal(h.slots.regs.length, 0);
});

test("纯增量守卫：src/index.js 的 web provider 装配面不动", async () => {
  const host = await import("../src/index.js");
  assert.equal(typeof host.apply, "function");
  assert.equal(typeof host.Config, "object");
  assert.deepEqual(host.inject, ["web", "configEditor", "credentials", "agents"]);
});
