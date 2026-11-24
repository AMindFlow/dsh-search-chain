// WP13 客户端挂载线：Client 产物入口（SET-001 / DSH-001）。v0.1 只读指示器。
//
// 装载链（DSH 0.2.2-rc.5 app.asar 模板，权威）：
//   本文件顶层经 window.__ModuleLoader__.load({ id, factory }) 自注册；id 恒为包名。
//   宿主以 factory(require) 取得产物 { inject, apply }；React 只经 factory 入参
//   require("react") 进入组件作用域（loader 本身无 require 属性）。
//
// 约束：
//   - 模块顶层零副作用；无 window 或无模块表时整体短路（node import / 测试不抛、零 DOM 接触）。
//   - inject 恰 ["slots"]（live client 服务目录内声明，[L3]）；package.json dsh.client.inject 是
//     装载包列表，恰 []（[M4]）。
//   - registration 键集恰 {name,id,order,label}；组件经第二参传入（[L1]）；order 30（[L2]）。
//   - 幂等：同一 ctx.slots 重复 apply 只挂载一次；卸载 cleanup 经 ctx.effect 登记并清空幂等键。
//   - React 缺失（require 抛出或返回非 React 值）时组件安全降级为 null。
//   - 经典脚本、零 import、零构建：自包含，仅经 globalThis 探测宿主。下列常量为 src/settings/catalog.js
//     的本地镜像（PROVIDER_ID / SECTION_SLOT / SECTION_TITLE），变更须同步。
//
// 范围裁决（docs/specs/draft/settings-ui.md 设计决定）：
//   - 自定义区为【只读指示器】：标题 + 指向内置插件页配置区的文案。编辑走
//     「设置→插件→dsh-search-chain 配置区」（cordis.patch.yml 行 config + Config schema）。
//   - client 无编辑桥（[L4]），故本入口不引用 configEditor / credentials 等幻影面。
//
// P2 已知：幂等 early-return 场景（同一 slots 上双 ctx、先者卸载）v0.1 接受，随 H-5 实机复核。
const PROVIDER_ID = "search-chain";
const SECTION_SLOT = "settings.section";
const SECTION_TITLE = "网页搜索链";

/** 区域排序：live [L2] 既有 occupants 之后（account -10 / general 0 / models 10 / plugins 15 / agent-presets 20）。 */
const SECTION_ORDER = 30;

/** 区域标题的懒求值 thunk（live label?: string|(()=>string)）。 */
const sectionLabel = () => SECTION_TITLE;

/** 编辑指引文案（v0.1：编辑走内置插件页配置区）。 */
const EDIT_HINT = "编辑请使用 设置→插件→dsh-search-chain 配置区";

/** 已挂载的 ctx.slots 幂等键；卸载 cleanup 清除。 */
const mounted = new WeakMap();

globalThis.window?.__ModuleLoader__?.load({
  id: "dsh-search-chain",
  factory(require) {
    // React 经宿主模块表注入的 require 取得；缺失或异常时降级为 null（组件渲染 null）。
    let React = null;
    try {
      const candidate = require("react");
      React = candidate && typeof candidate.createElement === "function" ? candidate : null;
    } catch {
      React = null;
    }

    /**
     * 设置区组件（第二参）。ownerProps 只给 { close }（[L1]），本指示器不使用任何 props。
     * React 缺失时返回 null。
     */
    function SettingsIndicator(_props) {
      if (!React) return null;
      return React.createElement(
        "section",
        { "data-plugin-id": PROVIDER_ID, "data-slot": SECTION_SLOT },
        React.createElement("h3", null, SECTION_TITLE),
        React.createElement("p", null, EDIT_HINT),
      );
    }

    return {
      inject: ["slots"],
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
      apply(ctx) {
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
      },
    };
  },
});
