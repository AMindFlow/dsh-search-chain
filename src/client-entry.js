// WP13 客户端挂载线：Client 产物入口（SET-001 / DSH-001）。
//
// 装载链：package.json exports["./client"] → 本文件 → dsh.client（platform "web"、immediately）。
// 形状（test/settings-client-wire.test.js 钉死）：
//   export const inject = ["slots", "configEditor", "credentials"]   ctx 面声明
//   export function apply(ctx)                                        挂载；资源经 ctx.effect 登记 cleanup
//
// 约束：
//   - 模块顶层与 apply 之外零副作用（不触碰 document/window，不创建 DOM）；面板 DOM 由宿主设置区渲染。
//   - 无 React 依赖；面板数据与控件语义全部经 src/client.js（即 src/settings/panel.js）既有抽象。
//   - 面板只读配置端口：deps 不传 fetch/chain（SET-004：面板操作不出站、不搜索）。
//   - 幂等：同一 ctx.slots 重复 apply 复用同一面板，mountSettingsSection 不双注册。
//
// 宿主形状待实机核对（H-5）：test/settings-ui.test.js 与 src/client.js 头注记录的
// settings.section descriptor 形状与 ctx.slots 注册签名以 oracle 为准；真机若不同，只改本文件 apply。
import { createSettingsPanel, mountSettingsSection } from "./client.js";

/** ctx 依赖面（模板 inject 语义：声明后由宿主注入对应 ctx 属性）。 */
export const inject = ["slots", "configEditor", "credentials"];

/** 每个宿主 slots 对象对应的面板（幂等键）。 */
const panels = new WeakMap();

/**
 * 挂载「网页搜索链」设置区。
 * @param {{
 *   slots: { register(slot: string, descriptor: object): () => void },
 *   configEditor: { entry: object, current(): any, editor: { edit(target: any, change: Function): Promise<any> } },
 *   credentials: object,
 *   effect(fn: () => (() => void)): void,
 * }} ctx
 */
export function apply(ctx) {
  let panel = panels.get(ctx.slots);
  if (!panel) {
    panel = createSettingsPanel({ settings: ctx.configEditor, credentials: ctx.credentials });
    panels.set(ctx.slots, panel);
  }
  const cleanup = mountSettingsSection(ctx.slots, panel);
  // 卸载语义（DSH-001）：effect 回调返回 cleanup，宿主卸载时注销区域。
  ctx.effect(() => cleanup);
}
