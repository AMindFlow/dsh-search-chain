// WP13 客户端挂载线：Client 产物入口（SET-001 / DSH-001）。v0.1 只读指示器。
//
// 装载链：package.json exports["./client"] → 本文件 → dsh.client（platform "web"、immediately）。
// live 形状（test/settings-client-wire.test.js 头注 [L1]–[L4] 为权威）：
//   export const inject = ["slots"]                          client 服务目录内声明（缺席服务=整体不激活）
//   export function apply(ctx)                               ctx.slots.inject("settings.section", 懒回调)
//                                                            懒回调内 ctx.slots.register(
//                                                              { name, id, order, label }, 组件工厂)
//   注册键集恰 {name,id,order,label}；panel 不是字段，经第二参组件工厂传入。
//
// 范围裁决（docs/specs/draft/settings-ui.md 设计决定）：
//   - 自定义区为【只读指示器】：标题 + 指向内置插件页配置区的文案。编辑走
//     「设置→插件→dsh-search-chain 配置区」（cordis.patch.yml 行 config + Config schema）。
//   - client 无编辑桥（[L4]），故本入口不引用 configEditor / credentials 等幻影面。
//
// 约束：
//   - 模块顶层零副作用；import 期与 headless 调用均不触碰 DOM（node 下 window 未定义即安全短路）。
//   - React 不在模块顶层导入：组件内经浏览器模块表 window.__ModuleLoader__.require("react") 懒取，
//     无模块表（node / 测试）返回 null，组件渲染为 null。
//   - 幂等：同一 ctx.slots 重复 apply 只挂载一次；卸载 cleanup 经 ctx.effect 登记，清空幂等键。
//
// 仅 entry 不再直调 src/client.js 的 mountSettingsSection；src/client.js 与 src/settings/
// 保留（panel 库 v0.2 使用，其逻辑端口面由 test/settings-ui.test.js 钉合）。
import { PROVIDER_ID, SECTION_SLOT, SECTION_TITLE } from "./settings/catalog.js";

/** ctx 依赖面：live client 服务目录内的最小声明（test 钉 deepEqual ["slots"]）。 */
export const inject = ["slots"];

/** 区域排序：live [L2] 既有 occupants 之后（account -10 / general 0 / models 10 / plugins 15 / agent-presets 20）。 */
const SECTION_ORDER = 30;

/** 区域标题的懒求值 thunk（live label?: string|(()=>string)）。 */
const sectionLabel = () => SECTION_TITLE;

/** 编辑指引文案（v0.1：编辑走内置插件页配置区）。 */
const EDIT_HINT = "编辑请使用 设置→插件→dsh-search-chain 配置区";

/** 浏览器模块表中的 React；node / 测试环境无 window 或无模块表时返回 null。 */
function loadReact() {
  const loader = typeof window !== "undefined" ? window.__ModuleLoader__ : undefined;
  if (!loader || typeof loader.require !== "function") return null;
  try {
    const React = loader.require("react");
    return React && typeof React.createElement === "function" ? React : null;
  } catch {
    return null;
  }
}

/**
 * 设置区组件工厂（第二参）。ownerProps 只给 { close }（[L1]），本指示器不使用任何 props。
 * headless 调用安全：无 React 时返回 null。
 */
function SettingsIndicator(_props) {
  const React = loadReact();
  if (!React) return null;
  const h = React.createElement;
  return h(
    "section",
    { "data-plugin-id": PROVIDER_ID, "data-slot": SECTION_SLOT },
    h("h3", null, SECTION_TITLE),
    h("p", null, EDIT_HINT),
  );
}

/** 已挂载的 ctx.slots 幂等键；卸载 cleanup 清除。 */
const mounted = new WeakMap();

/**
 * 挂载「网页搜索链」只读设置区（SET-001 / DSH-001）。
 * @param {{
 *   slots: {
 *     inject(slot: string, factory: () => (() => void)): () => void,
 *     register(registration: { name: string, id: string, order?: number, label?: string | (() => string) }, Component: (props: object) => unknown): () => void,
 *   },
 *   effect(fn: () => (() => void)): void,
 * }} ctx
 */
export function apply(ctx) {
  const key = ctx.slots;
  if (mounted.has(key)) return; // 幂等：重复 apply 不双 inject
  mounted.set(key, true);

  const offInject = ctx.slots.inject(SECTION_SLOT, () =>
    ctx.slots.register(
      { name: SECTION_SLOT, id: PROVIDER_ID, order: SECTION_ORDER, label: sectionLabel },
      SettingsIndicator,
    ),
  );

  // 卸载语义（DSH-001）：effect 回调返回 cleanup，撤销懒挂载并清除幂等键；重复调用无副作用。
  ctx.effect(() => () => {
    offInject();
    mounted.delete(key);
  });
}
