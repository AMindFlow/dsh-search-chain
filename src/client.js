// WP12 设置面板 — 模块入口（test/settings-ui.test.js 与 oracle 的 import 目标）。
//
// 导出面（oracle 头注 test/helpers/settings-oracle.js 固化，改名须同 PR 同步 oracle 并给理由）：
//   createSettingsPanel(deps) → panel        同步；deps = { settings, credentials, fetch, chain, now? }
//   mountSettingsSection(slots, panel) → cleanup
//     slots.register(slot, descriptor) → unregister（真实 settings.section 注册形状待宿主
//     核对，见 settings-ui.test.js 宿主清单 H-5；本层只固化 slot 名与区域 id）。
//
// 呈现层边界：本模块只产出面板数据与插槽挂载描述；DOM/主题/控件由宿主设置区渲染。
// 面板-宿主投影依赖（宿主是否接受插件自定义 Config 的 describe()/volatileForm/schema.toJSON()
// 投影链）属实机核对项，见交付报告「面板-宿主投影依赖假设」；数据层不臆造呈现。
//
// 零 npm 依赖；运行时零 import test/（常量本地镜像见 src/settings/catalog.js 头注同步义务）。

import { createSettingsPanel as createPanel } from "./settings/panel.js";
import { PROVIDER_ID, SECTION_SLOT, SECTION_TITLE } from "./settings/catalog.js";

/**
 * 创建设置面板（逻辑端口面）。
 * @param {{
 *   settings: { editor: { edit(target, change): Promise<any> }, entry: object, current(): any },
 *   credentials: { set(ref, value): Promise<any> },
 *   fetch?: Function,  // SET-004 陷阱面：面板操作不得出站（实现绝不使用）
 *   chain?: object,    // SET-004 陷阱面：面板操作不得发起搜索（实现绝不使用）
 *   now?: () => number,
 * }} deps
 */
export function createSettingsPanel(deps) {
  return createPanel(deps);
}

/**
 * 把面板挂载为宿主设置区的「网页搜索链」区域（SET-001/DSH-001）。
 * 幂等：同一 panel 重复挂载不会双注册；返回的 cleanup 注销区域（卸载语义 DSH-001）。
 *
 * descriptor 为最小自描述形状：{ id, title, panel }。真实宿主 settings.section 的
 * descriptor 字段与注销时机以实机为准（H-5）；WP6 装配时若宿主要求不同字段，
 * 只改本函数的 descriptor 组装处，面板数据层不动。
 */
export function mountSettingsSection(slots, panel) {
  if (!slots || typeof slots.register !== "function") {
    throw new Error("mountSettingsSection：slots.register 必须是函数（见 oracle createSlotRegistry）");
  }
  if (!panel || typeof panel.view !== "function") {
    throw new Error("mountSettingsSection：panel 必须是 createSettingsPanel 的返回值");
  }
  const handle = panel._state;
  if (handle && handle.unregister) return handle.unregister; // 已挂载：不双注册

  const unregister = slots.register(SECTION_SLOT, {
    id: PROVIDER_ID,
    title: SECTION_TITLE,
    panel,
  });
  const cleanup = () => {
    if (!handle || handle.unregister !== unregister) return; // 只注销本句柄，重复 cleanup 无副作用
    handle.unregister = null;
    unregister();
  };
  if (handle) handle.unregister = unregister;
  return cleanup;
}
