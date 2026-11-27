# 设置面板风格锁定表（网页搜索链插件面板）

> **状态：定稿 · lead 审阅通过（2026-11-25，引文对 asar 官方源码抽查逐字一致；Hydrogen High 为本表风格基准，Issue #50 与官方源码冲突处以本表为准并已在 SPC-010 显著标注）**。Refs Issue #50（面板观感对齐「模型」区）；关联 Issue #52（风格锁定表立项）。
>
> 本表把 DSH Desktop 官方设置页（「模型」「网页搜索」区及配套原语）的美学语义钉成**可验证数值**。实施代理只允许从本表「钉死值」抄写，不得自行发挥。
> 所有语义解读、取舍与迁移判断由 **Hydrogen High**（agy CLI，模型 `gemini-4-hydrogen-high`）依据逐字官方源码摘录裁定；本文作者只做了取证（asar 反汇编提取官方 CSS/TSX/主题 token）、喂材料与誊录，未自行裁定任何风格数值。调用记录见[附录 A](#附录-ahydrogen-high-调用记录)。

## 0. 使用规则（对实施代理的硬约束）

- **只抄不改**：视觉调整必须逐字使用第 2 节各 SPC 条款的「钉死值」；钉死值未覆盖的属性维持现状并在第 6 节登记，不得即兴补数值。
- **行为契约冻结**：`data-role`、`checked`、`onChange`、`onKeyDown`、`disabled`、`draggable`、`aria-*` 等语义**不得因本表发生任何变化**。本表只改样式声明与纯视觉包裹结构。官方 `Switch` 是 `button[role=switch]`，我方契约是隐藏 `input[type=checkbox]` + `role=switch aria-checked` + 相邻 `span` 轨道——**保留我方 DOM 语义**，按其状态选择器映射（SPC-011）套用官方数值。
- **类名说明**：官方组件为 CSS Modules，产物类名带哈希（如 `._switch_1ik0f_5`、`._item_70kcw_173`），**不可复用**；本表一律给出官方源码类名（如 `.switch`、`.item`）与选择器语境，我方只复刻结构与数值。
- **颜色红线**：一切颜色必须经 `var(--dsw-alias-*)`（或 `--dsw-focus-ring-color` 变量机制）解析，不得硬编码色值、不得给 token 引用追加 `, inherit` 之外的字面色兜底。唯一例外是 `.sc-select-input` 的 chevron data-URI（官方注释逐字：`Data-URI SVGs cannot resolve CSS variables; #81858C is the caption gray shared by both themes.`）。
- **hover 红线**：所有 hover 声明必须包在 `@media (hover: hover)` 内（官方全文如此）。
- **圆角红线**：凡 `50%`、`999px` 等「等效无上限」圆角必须成对声明 `corner-shape: round`（`corner-shape.css` 全局 `superellipse(1.5)` 生效时需要）；普通 token 档圆角不加。
- **焦点红线**：焦点环颜色与宽度只能写 `var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))` / `var(--dsw-focus-ring-width, 2px)`，禁止 `brand-primary` 或写死色（SPC-018）。

## 1. 证据链与方法

### 1.1 官方源码取证（逐字提取，非转述）

| 材料 | 路径（相对 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/`） | 用途 |
| --- | --- | --- |
| 模型区样式 | `dsh-client-ui-settings-models/src/client/ModelsSection.module.css`（1003 行全文） | 主基准：section/卡片/徽章/状态点/按钮/编辑器/添加块/拖拽 |
| 模型区结构 | 同目录 `ModelsSection.tsx`、`ModelRow.tsx`、`CustomProviderCard.tsx`、`ProviderEditor.tsx`、`EditorFooter.tsx`、`ApiKeyInput.tsx` | DOM 骨架、控件族归属 |
| 同域参照 | `dsh-client-ui-settings-web-search/src/client/WebSearchCard.module.css`、`WebSearchCard.tsx` | 官方「网页搜索」区（面板灰底、字段分隔节奏、selector 下拉触发） |
| 下拉与菜单 | `dsh-client-ui-model-selection/src/client/ModelSelect.module.css`；`dsh-web-frontend/dist/assets/index-CSAdOBx6.css` 中 Menu 原语（哈希段 `70kcw`）、Switch 原语（`1ik0f`）、SegmentedControl（`1lga9`/`1ocp1`）、浮层材质（`1w4el`） | 弹层材质、选项交互、开关、分段控件 |
| 主题 token | `dsh-client-ui-theme/src/styles/design-platform.css`（`body{}` 亮 / `body[data-ds-dark-theme]{}` 暗）、`theme-base.css`、`focus.css`、`corner-shape.css` | 第 4 节 token 实证表 |
| 设置外壳 | `dsh-client-ui-settings` / `dsh-client-ui-settings-shell` | 确认宿主 shell 无独立 section 视觉 CSS（各区自持 `.section` 规格） |

`dsh-client-ui-primitives` 包未随 asar 分发，其样式仅存在于编译产物（哈希类名）；Switch/Menu/SegmentedControl 数值均取自编译 CSS 反解，已在各条款标注。

### 1.2 裁定方法

把上述逐字摘录 + 我方 `PANEL_CSS` 现状 + token 实证值分成 5 个主题喂给 Hydrogen High（表面层级与文字阶 / 按钮·输入·footer·危险色 / 弹层与下拉菜单 / 开关·分段·添加块·同域取舍 / 拖拽·焦点·减弱动画·容器与危险色收口），要求逐条输出【解读】【判定：直接适用 | 模型页特有不适用 | 类推延伸 | 未获取】【钉死值】。第 2 节的「裁定」栏为其结论摘要，「钉死值」为其原样输出（类名替换为我方 `sc-*` 前缀，未改数值）。

## 2. 逐要素规则条款

官方逐字原文统一来自 1.1 表文件；条款中摘录含官方注释（注释是语义依据的一部分）。

## SPC-001 面板根容器

- **要求** `.sc-panel` 必须为 `box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 720px; color: var(--dsw-alias-label-primary, inherit); font-family: inherit;`。现状 `display: grid` 必须改为 flex 列；改 flex 后原 grid 子项的 `justify-self: end` 失效，`.sc-button-primary-small`、`.sc-save-button` 同步改 `align-self: flex-end`（见 SPC-016）。
- **钉死值**

  ```css
  .sc-panel {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 100%;
    max-width: 720px;
    color: var(--dsw-alias-label-primary, inherit);
    font-family: inherit;
  }
  ```
- **官方原文** `ModelsSection.module.css`：`.section { display: flex; flex-direction: column; gap: 12px; max-width: 720px; color: var(--dsw-alias-label-primary); }`
- **来源** Issue #50。Issue #52。`ModelsSection.module.css` `.section`。
- **裁定（Hydrogen High）** 直接适用。grid→flex 三理由：与 `.section` 逐字一致；单列 grid 轨道 `minmax(auto,1fr)` 遇长文本宽度行为不同；与列表容器统一纵向流。`max-width: 720px` 采纳：宿主 shell 不限宽，须自限以免宽视口横跨整屏，且与我方现有 `@media (max-width: 720px)` 断点合拢。
- **验收** 宽视口（>720px+边距）下面板列宽钳制在 720px；卡片间垂直节奏 12px；「保存」按钮仍贴列右缘。

## SPC-002 区标题

- **要求** `.sc-title` 必须 `margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary);`。现状 24px/700 字阶越级（Issue #50「标题字号对齐模型页」）。DOM 保留 `<h3>` 标签以维持既有标题大纲，只锁视觉。
- **钉死值**

  ```css
  .sc-title {
    margin: 0;
    font-size: 16px;
    line-height: 24px;
    font-weight: 500;
    color: var(--dsw-alias-label-primary);
  }
  ```
- **官方原文** `.title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }`
- **来源** Issue #50。`ModelsSection.module.css` `.title`（`<h2.title>`）。
- **裁定（Hydrogen High）** 直接适用。语义差裁定：`.title` 16/24/500 是**一等设置分区主标题**（与插件插槽同列同级）；`WebSearchCard .sectionTitle` 14/20/500 是大区内部**二级子节标题**（如 Search/Fetch 分节），「不适用」于我方——本面板是一等插件区。宿主插槽外层是否有更高层页面标题：**未获取**。
- **验收** 与官方「模型」区标题并排对比同尺寸同字重；与引擎名（14px）、说明段（14px）形成 16>14 主阶。

## SPC-003 说明段

- **要求** `.sc-description` 必须 `margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary);`。现状 15px（不在官方 12/13/14/16 字阶）与 `label-secondary`（过重）均废止；自带 `margin-bottom` 清零，间距交还容器 gap 与列表容器的 `margin: 12px 0 0` 叠加。
- **钉死值**

  ```css
  .sc-description {
    margin: 0;
    font-size: 14px;
    line-height: 22px;
    color: var(--dsw-alias-label-tertiary);
  }
  ```
- **官方原文** `.intro { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }`
- **来源** Issue #50。`ModelsSection.module.css` `.intro`。
- **裁定（Hydrogen High）** 直接适用。「标题/说明块与首张卡片共 24px 呼吸感」由 `.rows` 的 `margin: 12px 0 0` 叠加容器 gap 12px 实现（官方注释：`Extra air between the title/intro block and the first provider card.`），说明段自身不得再挂 margin。
- **验收** 说明段到首卡距离 24px；亮/暗下说明文字均为三级灰。

## SPC-004 提示与已保存文案（预留位）

- **要求** 如渲染告警提示，必须 `margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-label);`；如渲染「已保存」确认文案，必须同档字号、`color: var(--dsw-alias-state-success-primary);`（与 SPC-030 状态节点同档）。
- **钉死值**

  ```css
  .sc-notice { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-label); }
  .sc-saved-notice { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-success-primary); }
  ```
- **官方原文** `.notice { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-label); }`；`.savedNotice { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-success-primary); }`
- **来源** Issue #50。`ModelsSection.module.css` `.notice`、`.savedNotice`。
- **裁定（Hydrogen High）** 直接适用（逐字原文；Hydrogen High 在 SPC-010 裁定中引用 12/18 档为最接近的官方辅助文案先例）。
- **验收** 告警文案为琥珀 label 色、成功文案为绿，二者均 12/18。

## SPC-005 卡片列表容器

- **要求** 全部引擎卡片必须包在列表容器（现网 DOM 类名 `.sc-card-list`；对应 Hydrogen High 摘录中的 `.sc-list`，实施按现网命名）内：`list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px;`。卡片自身 `margin-block: 6px` 必须删除，间距统一由本容器 gap 承担（这也是 SPC-027 插入指示线成立的前提）。
- **钉死值**

  ```css
  .sc-card-list {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  ```
- **官方原文** `.rows { list-style: none; /* Extra air between the title/intro block and the first provider card. */ margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }`
- **来源** Issue #50。`ModelsSection.module.css` `.rows`；`ModelsSection.tsx` `<ul.rows>`。
- **裁定（Hydrogen High）** 直接适用。
- **验收** 相邻卡片间隙恒 8px；标题块到首卡 24px（SPC-003）；grid margin 折叠类缺陷不复现。

## SPC-006 引擎卡片

- **要求** `.sc-card` 必须 `box-sizing: border-box; position: relative; border: 0.5px solid var(--dsw-alias-settings-card-stroke); background: var(--dsw-alias-settings-card-fill); border-radius: var(--dsw-radius-xl); padding: 12px 14px; display: flex; flex-direction: column; gap: 12px;`。废止：`min-height: 90px`、`border: 0`、`border-radius: 14px`（野值）、`background: bg-layer-1`、`padding: 20px 24px`、`margin-block: 6px`、`align-items: center`。`position: relative` 为 SPC-027 指示线定位承接。
- **钉死值**

  ```css
  .sc-card {
    box-sizing: border-box;
    position: relative;
    border: 0.5px solid var(--dsw-alias-settings-card-stroke);
    background: var(--dsw-alias-settings-card-fill);
    border-radius: var(--dsw-radius-xl);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  ```
- **官方原文** `/* Provider cards share the settings material; editors use the inset module fill. */ .rowCard { border: 0.5px solid var(--dsw-alias-settings-card-stroke); background: var(--dsw-alias-settings-card-fill); border-radius: var(--dsw-radius-xl); padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }`
- **来源** Issue #50（去描边大圆角卡片之实际官方解）。`ModelsSection.module.css` `.rowCard`；`theme-base.css` `--dsw-alias-settings-card-fill/stroke`。
- **裁定（Hydrogen High）** 直接适用。**近白表面层级语义**：亮色下 `bg-layer-1/2/3` 同为纯白，卡片可读性完全靠 `settings-card-stroke`（= `border-l4`，亮 `rgba(0,0,0,.16)`）的 0.5px 描边分层；暗色下 fill 升到 `rgb(44,44,46)` 与 `bg-base rgb(21,21,23)`/`bg-layer-1 rgb(35,35,36)` 拉开三档。去 `min-height` 让高度由内容撑开；列向 flex + gap 12px 为卡内折叠编辑区（官方 `<div.editor?>` 位）预留节奏。官方 `.rowCard` 的 `box-sizing` 声明：**未获取**，`border-box` 为防御性保留。
- **验收** 亮色下卡片以 0.5px 描边可见且无脏边框；暗色下卡片比页面背景亮一档；圆角 20px（superellipse 生效时手感与模型页一致）。

## SPC-007 行头 / 身份组 / 动作组

- **要求** `.sc-card-row` 必须 `display: flex; align-items: center; gap: 10px; min-width: 0;`（废止 `justify-content: space-between`）；`.sc-card-info` 必须 `display: inline-flex; align-items: center; gap: 6px; min-width: 0;`（不设 `flex-wrap`，名称以 `overflow-wrap: anywhere` 折行，注记紧跟名称）；`.sc-card-actions` 必须 `display: inline-flex; align-items: center; gap: 4px; margin-left: auto;`。
- **钉死值**

  ```css
  .sc-card-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .sc-card-info { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
  .sc-card-actions { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }
  ```
- **官方原文** `.rowHead { display: flex; align-items: center; gap: 10px; }`；`.rowIdentity { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }`；`.rowActions { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }`
- **来源** Issue #50。`ModelsSection.module.css` `.rowHead/.rowIdentity/.rowActions`；`ModelRow.tsx` 结构。
- **裁定（Hydrogen High）** 直接适用（10/6/4、margin-left:auto）。`margin-left: auto` 取代 space-between：动作区为空时身份块仍按常规流左对齐。`.sc-card-info` 保留 `flex-wrap: wrap` 属**类推延伸**（极窄容器防挤压），优先按官方移除。现状 `.sc-card-actions` 的 `flex-wrap/justify-content` 官方无对应：**未覆盖**（第 6 节），移除后若窄屏溢出再按类推登记。
- **验收** 名称超长时徽章/状态点紧跟名称折行而非漂向动作区；动作区恒贴右缘。

## SPC-008 引擎名称

- **要求** `.sc-card-name` 必须 `font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere;`。现状 20px/600（大于区标题，字阶倒挂）废止。
- **钉死值**

  ```css
  .sc-card-name {
    font-size: 14px;
    line-height: 22px;
    font-weight: 500;
    color: var(--dsw-alias-label-primary);
    overflow-wrap: anywhere;
  }
  ```
- **官方原文** `.rowName { font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary); }`
- **来源** Issue #50（两行结构紧凑卡）。`ModelsSection.module.css` `.rowName`。
- **裁定（Hydrogen High）** 直接适用；`overflow-wrap: anywhere` 为防长自定义名称溢出的防御声明，官方未声明：**未获取**，保留。字阶秩序：16 区标题 > 14 引擎名 > 13 状态 > 11 注记。
- **验收** 名称不大于区标题；空名称占位类（`.sc-card-name-placeholder`，`label-secondary` 颜色覆盖，非本表裁定项）继续生效。

## SPC-009 类型徽章

- **要求** `.sc-type-badge` 必须 `flex: none; padding: 1px 6px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-xs); font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); white-space: nowrap;`。废止 `background: bg-layer-2`（卡片改用 settings-card-fill=bg-layer-2 后徽章将与卡面同色隐形）、`padding: 3px 8px`、`border-radius: 6px`（野值）、12px 字号。
- **钉死值**

  ```css
  .sc-type-badge {
    flex: none;
    padding: 1px 6px;
    border: 0.5px solid var(--dsw-alias-border-l3);
    border-radius: var(--dsw-radius-xs);
    font-size: 11px;
    line-height: 16px;
    color: var(--dsw-alias-label-secondary);
    white-space: nowrap;
  }
  ```
- **官方原文** `/* Reads as an annotation on the name, not as a second name: caption size and the secondary label tone, so it never competes with the row's own title. It sits inside `rowIdentity` with the credential dot, which is what keeps it beside the name rather than drifting toward the actions. */ .rowTag { flex: none; padding: 1px 6px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-xs); font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }`
- **来源** Issue #50。`ModelsSection.module.css` `.rowTag`。
- **裁定（Hydrogen High）** 直接适用：我方「类型注记」与 `.rowTag` 注释意图（名称的轻量注记、caption 字号、secondary 色、留在 rowIdentity 内）100% 契合。`white-space: nowrap` 官方未声明（靠 `flex: none`）：**未获取**，为防含空格类型名内部断行保留。
- **验收** 徽章为透底描边胶囊感小标签；在卡片上不出现「色块同色隐形」；小于状态文案（13px）。

## SPC-010 状态圆点（三态）与状态文案

- **要求** `.sc-status-dot` 必须 `box-sizing: border-box; display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; corner-shape: round;`。三态色：已就绪 `var(--dsw-alias-state-success-primary)`；缺少凭据 `var(--dsw-alias-state-error-primary)`（与官方缺凭据点同 token；仅当产品明确定性为「非阻断告警」时可改用 `var(--dsw-alias-state-warn-primary)` 并登记）；已关闭 `var(--dsw-alias-state-idle-primary)`。状态文案容器 `.sc-status` 必须 `display: inline-flex; flex: none; align-items: center; gap: 6px; font-size: 13px; line-height: 20px; font-weight: 400; color: var(--dsw-alias-label-secondary); white-space: nowrap;`（gap 现状 7px、字号现状 14px 废止）。
- **钉死值**

  ```css
  .sc-status {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    line-height: 20px;
    font-weight: 400;
    color: var(--dsw-alias-label-secondary);
    white-space: nowrap;
  }
  .sc-status-dot {
    box-sizing: border-box;
    display: inline-block;
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    corner-shape: round;
  }
  /* 三态色（内联或修饰类绑定）：
     已就绪:       background: var(--dsw-alias-state-success-primary);
     缺少凭据引用: background: var(--dsw-alias-state-error-primary);（产品定性非阻断告警时可改 state-warn-primary）
     已关闭:       background: var(--dsw-alias-state-idle-primary); */
  ```
- **官方原文** `.credentialDot { box-sizing: border-box; display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; corner-shape: round; }`；`.credentialDotConfigured { background: var(--dsw-alias-state-success-primary); }`；`.credentialDotMissing { background: var(--dsw-alias-state-error-primary); }`；`.accountStatus { display: inline-flex; flex: none; align-items: center; gap: 6px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-state-success-primary); }`
- **来源** Issue #50（状态圆点：绿=就绪/橙=缺凭据/灰=关闭 + label-secondary 文案——Issue 原始三态口径与官方两态先例的取舍在本题裁定）。`ModelsSection.module.css` `.credentialDot*`、`.accountStatus`。
- **裁定（Hydrogen High）** 点几何与就绪态直接适用。**缺凭据色裁定**：官方全区无黄点先例，「同页认知零成本」优先，钉 `state-error-primary`；`state-warn-primary` 仅作产品明确降级为非阻断告警时的类推备选（登记）。「已关闭」官方无先例：**未获取**，用 `state-idle-primary` 属**类推延伸**（依据：主题 token 已定义）。状态文案：官方点旁无文案，**类推延伸**锚 `.accountStatus` 几何（gap 6 / 13 / 20）+ `.rowTag` 降噪色（label-secondary，由圆点独担三态色相），避免与 14px 引擎名撞号。摘录中未附 `.advancedHint`，该轮引证以本表 SPC-020 原文为准。
- **验收** 三态点在亮/暗下均可辨且不与文本色混同；状态文案 13px 不压过名称；点旁文案 DOM 保留（契约）。

## SPC-011 开关：轨道与滑块

- **要求** `.sc-switch-track` 与 `::after` 必须按官方 `Switch` 原语数值钉死：轨道 36×20、`padding: 2px`、`border: 0`、`border-radius: 999px; corner-shape: round`、关态底 `var(--dsw-alias-border-l3)`、开态底 `var(--dsw-alias-brand-primary)`（**废止绿色 state-success-primary 与 l1 描边**）；滑块 16px、`border-radius: 50%; corner-shape: round`、关态 `var(--dsw-alias-switch-thumb)`（亮白/暗灰，**废止 #fff 硬编码**）、开态 `var(--dsw-alias-label-primary-foreground)`、`transition: transform .12s ease`（轨道自身不做背景过渡——官方原文无）；选中位移 `transform: translate(16px)`；`:disabled` `cursor: default; opacity: .5`（废止 .55）。**DOM 语义不变**，按下表映射套用（隐藏 checkbox + 相邻兄弟选择器，不改 button[role=switch]）：

  | 官方（button 语义） | 我方（checkbox 语义） |
  | --- | --- |
  | `.switch` | `.sc-switch-track` |
  | `.switch[aria-checked=true]` | `.sc-switch-input:checked + .sc-switch-track` |
  | `.switch[aria-checked=false] .thumb` | `.sc-switch-track::after`（基准态） |
  | `.switch[aria-checked=true] .thumb` | `.sc-switch-input:checked + .sc-switch-track::after` |
  | `.switch:focus-visible` | `.sc-switch-input:focus-visible + .sc-switch-track`（另见 SPC-018） |
  | `.switch:disabled` | `.sc-switch-input:disabled + .sc-switch-track` |
- **钉死值**

  ```css
  .sc-switch-track {
    box-sizing: border-box;
    position: relative;
    display: block;
    flex: 0 0 auto;
    width: 36px;
    height: 20px;
    padding: 2px;
    border: 0;
    border-radius: 999px;
    corner-shape: round;
    background: var(--dsw-alias-border-l3);
    cursor: pointer;
  }
  .sc-switch-track::after {
    content: "";
    display: block;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    corner-shape: round;
    background: var(--dsw-alias-switch-thumb);
    transition: transform .12s ease;
  }
  .sc-switch-input:checked + .sc-switch-track { background: var(--dsw-alias-brand-primary); }
  .sc-switch-input:checked + .sc-switch-track::after {
    background: var(--dsw-alias-label-primary-foreground);
    transform: translate(16px);
  }
  .sc-switch-input:disabled + .sc-switch-track { cursor: default; opacity: .5; }
  ```
- **官方原文**（primitives 编译 CSS 反解，`dsh-web-frontend/dist/assets/index-CSAdOBx6.css`，哈希类 `._switch_1ik0f_5` 族）：`.switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; corner-shape: round; background: var(--dsw-alias-border-l3); cursor: pointer; }`；`.switch[aria-checked=true] { background: var(--dsw-alias-brand-primary); }`；`.switch:disabled { cursor: default; opacity: .5; }`；`.switch:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }`；`.thumb { display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-primary-foreground); transition: transform .12s ease; }`；`.switch[aria-checked=false] .thumb { background: var(--dsw-alias-switch-thumb); }`；`.switch[aria-checked=true] .thumb { transform: translate(16px); }`
- **来源** Issue #50（药丸开关保 props.checked+onChange）。官方 Switch 编译 CSS（1.1 表）；token：`switch-thumb` 亮 `rgb(255,255,255)` / 暗 `rgb(173,178,184)`，`label-primary-foreground` 亮 `rgb(255,255,255)` / 暗 `rgb(15,17,21)`，`brand-primary` 亮 `rgb(15,17,21)` / 暗 `rgb(249,250,251)`（第 4 节）。
- **裁定（Hydrogen High）** 直接适用（视觉规格 100%；实现为契约零改动的兄弟选择器映射）。特别裁定：**开启色绿错误**——官方开关从不绿，`state-success-primary` 只用于状态文案，开着绿色的开关与同页割裂；**#fff 双态失效**——暗色开态轨道为近白 `rgb(249,250,251)`，白滑块与轨道融为一体，必须走 token。我方 38×22 + 描边为野值体系，全数收口 36×20。
- **验收** 开关与官方组件并排截图逐像素同尺寸；暗色下开态滑块为深色（可见）；关态轨道为 12% 黑描边灰（亮）/16% 白（暗）；`props.checked/onChange/disabled` 行为回归测试全绿。

## SPC-012 开关容器、文字标签与视觉隐藏输入

- **要求** `.sc-switch` 必须 `position: relative; display: inline-flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap;`，且 `:has(.sc-switch-input:disabled)` 时 `cursor: default`。`.sc-switch-label` 必须 `font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-secondary);`，禁用联动 `opacity: .5`（废止 .55）。视觉隐藏输入必须与官方 `.hiddenLabel` 同构（`.sc-hidden-label` 工具类一并保留备用）。
- **钉死值**

  ```css
  .sc-switch {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--dsw-alias-label-secondary);
    cursor: pointer;
    white-space: nowrap;
  }
  .sc-switch:has(.sc-switch-input:disabled) { cursor: default; }
  .sc-switch-label { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-secondary); }
  .sc-switch-input:disabled ~ .sc-switch-label { opacity: .5; }
  .sc-hidden-label,
  .sc-switch-input {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  ```
- **官方原文** `.hiddenLabel { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }`（注释：`Icon-button label seat: named for assistive tech …`）；开关本体见 SPC-011。
- **来源** Issue #50。`ModelsSection.module.css` `.hiddenLabel`；编译 Switch CSS（disabled .5）。
- **裁定（Hydrogen High）** 类推延伸：官方开关无内联文字先例（**未获取**）；14/22 取常规控件文字档（与 20px 轨道垂直居中对齐），禁用 .5 类推编译 `.switch:disabled`；色 `label-secondary` 维持「卡内辅助操作低于条目名」的主次。现有 `aria-label` 足够，不强制新增隐藏节点；`.sc-switch-input` 隐藏声明与 `.hiddenLabel` 同构即可（现状 `clip-path: inset(50%)` 兼容保留不影响）。
- **验收** 「启用」文字 14px 次级灰、不压过名称；禁用开关整组（含文字）呈 .5 透明度且指针为 default。

## SPC-013 面板顶部总开关行

- **要求** 「DeepSeek 官方 API 使用官方搜索」行必须为**无卡裸行**置于标题块之下、列表之上：行容器 `display: flex; flex-direction: column; align-items: flex-start; gap: 8px;`；行内 `.sc-switch`/`.sc-switch-label` 覆盖为 `color/font 主文本档`（`var(--dsw-alias-label-primary)`）；副说明 `.sc-official-hint` 必须 `margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary);`。**禁止**做大于 36×20 的「大开关」；**禁止**套用条目 `.sc-card`（避免被误读为列表条目）。
- **钉死值**

  ```css
  .sc-official-row { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  .sc-official-row .sc-switch { color: var(--dsw-alias-label-primary); }
  .sc-official-row .sc-switch-label { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
  .sc-official-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
  ```
- **官方原文** 无面板级开关先例（**未获取**）；`gap: 8px` 锚 `.addModes`（`.addModes { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }`），hint 锚 `.advancedHint`（见 SPC-020 原文）。
- **来源** Issue #50、SET-005。`ModelsSection.module.css` `.addModes`、`.advancedHint`。
- **裁定（Hydrogen High）** 类推延伸（无官方同形先例；标签档类推 14/22、hint 直接适用 `.advancedHint`、间距类推 `.addModes`）。备选界限：若实机评审要求更强分区，可改放 `WebSearchCard .panel` 灰面板（`background: var(--dsw-alias-bg-module-platform); border-radius: var(--dsw-radius-md); padding: 0 16px;`——`.panel` 垂直内距**未获取**，届时按 `.addCard` 14/16 补），仍不得套条目卡。
- **验收** 顶部行与条目卡在结构上不可混淆（无卡描边/卡底）；开关仍 36×20；hint 12/18 三级灰。

## SPC-014 按钮基底与三变体

- **要求** 所有文字按钮共享基底：`box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 36px; padding: 0 14px; border: none; border-radius: var(--dsw-radius-md); font: inherit; font-size: 14px; line-height: 22px; cursor: pointer;`（standard 档；行内 compact 档见 SPC-015）。三变体：primary 底 `var(--dsw-alias-button-primary-fill)` + 字 `var(--dsw-alias-label-primary-foreground)`，hover `var(--dsw-alias-button-primary-hover)`；secondary `border: 0.5px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-primary);`，hover `var(--dsw-alias-interactive-bg-hover-solid)`；danger `border: none; background: transparent; color: var(--dsw-alias-state-error-primary);`，hover `var(--dsw-alias-interactive-bg-hover-danger)`。**废止**：1px l1 实描边、8px 野圆角、`padding: 8px 14px/8px 6px`、danger 下划线 hover、secondary 的 `bg-layer-1` hover（亮色白上无反馈）。
- **钉死值**

  ```css
  .sc-button,
  .sc-button-primary,
  .sc-button-secondary {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: 36px;
    padding: 0 14px;
    border: none;
    border-radius: var(--dsw-radius-md);
    font: inherit;
    font-size: 14px;
    line-height: 22px;
    cursor: pointer;
  }
  .sc-button-primary {
    background: var(--dsw-alias-button-primary-fill);
    color: var(--dsw-alias-label-primary-foreground);
  }
  @media (hover: hover) {
    .sc-button-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
  }
  .sc-button-secondary {
    border: 0.5px solid var(--dsw-alias-border-l3);
    background: transparent;
    color: var(--dsw-alias-label-primary);
  }
  @media (hover: hover) {
    .sc-button-secondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
  }
  .sc-button-danger {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 36px;
    padding: 0 14px;
    border: none;
    border-radius: var(--dsw-radius-md);
    background: transparent;
    color: var(--dsw-alias-state-error-primary);
    font: inherit;
    font-size: 14px;
    line-height: 22px;
    cursor: pointer;
  }
  @media (hover: hover) {
    .sc-button-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
  }
  ```
- **官方原文** `/* `box-sizing` on every control here: the app has no global border-box reset, so without it the outlined variants stand 2px taller than the filled ones they sit beside (Cancel next to Apply, Edit next to Delete). */ .primaryButton, .secondaryButton, .addButton { …基底如钉死值… }`；`.primaryButton { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }`；`.secondaryButton, .addButton { border: 0.5px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-primary); }`；`@media (hover: hover) { .secondaryButton:hover:not(:disabled), .addButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); } .secondaryButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); } }`；`.dangerButton { …base…, border: none; background: transparent; color: var(--dsw-alias-state-error-primary); }`；`@media (hover: hover) { .dangerButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); } }`
- **来源** Issue #50（edit=secondary 圆角描边；remove=纯红字）。`ModelsSection.module.css` `.primaryButton/.secondaryButton/.dangerButton`。
- **裁定（Hydrogen High）** 直接适用。语义：`box-sizing` 因应用无全局 border-box；secondary hover 先铺半透明再被 `-solid` 二次覆盖——标准次级按钮悬停呈现**不透明浅灰底**防透色（`.addButton` 则保留半透明底）；danger 是「无边框透明 + 浅红底浮现」而非高饱和实心，官方无下划线语言。官方 `.dangerButton` 基底未含 `gap: 4px`，按原文不补。
- **验收** 同一行 primary 与 secondary 并排等高（无 2px 漂移）；暗色下 primary 为白底黑字；danger hover 为极浅红底无下划线。

## SPC-015 行内 compact 档与标准档

- **要求** 卡片行内 `.sc-card-actions` 中的「编辑/移除」必须套 compact 档：`height: 28px; padding: 0 10px; border-radius: var(--dsw-radius-sm); font-size: 12px; line-height: 18px;`（其余沿用 SPC-014 变体声明）。编辑器 footer、全局保存、确认框按钮一律 standard 档（36px），**不得**因类名 `-small` 而套 compact。
- **钉死值**

  ```css
  /* 行内「编辑」（secondary compact） */
  .sc-card-actions .sc-button.sc-button-secondary {
    box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
    gap: 4px; height: 28px; padding: 0 10px;
    border: 0.5px solid var(--dsw-alias-border-l3);
    border-radius: var(--dsw-radius-sm);
    background: transparent; color: var(--dsw-alias-label-primary);
    font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
  }
  @media (hover: hover) {
    .sc-card-actions .sc-button.sc-button-secondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
  }
  /* 行内「移除」（danger compact） */
  .sc-card-actions .sc-button-danger {
    box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
    height: 28px; padding: 0 10px;
    border: none; border-radius: var(--dsw-radius-sm);
    background: transparent; color: var(--dsw-alias-state-error-primary);
    font: inherit; font-size: 12px; line-height: 18px; text-decoration: none; cursor: pointer;
  }
  @media (hover: hover) {
    .sc-card-actions .sc-button-danger:hover:not(:disabled) {
      background: var(--dsw-alias-interactive-bg-hover-danger);
      text-decoration: none;
    }
  }
  ```
- **官方原文** `/* Provider-row controls use the compact Button size. */ .rowActions .secondaryButton, .rowActions .dangerButton { height: 28px; padding: 0 10px; border-radius: var(--dsw-radius-sm); font-size: 12px; line-height: 18px; }`；EditorFooter 注释逐字：`The action row every provider card ends with: dismiss on the left, commit on the right. … Cancel refuses input only while a commit is in flight, never because the card is disabled.`（footer 按钮不在 `.rowActions` 内 → 非 compact）
- **来源** Issue #50（两行结构 → 行内操作紧凑档）。`ModelsSection.module.css` `.rowActions` 覆写；`EditorFooter.tsx`。
- **裁定（Hydrogen High）** 直接适用；`.sc-button-primary-small` 语义位置=EditorFooter commit，升格 standard 档（类名不改，视觉升格）。
- **验收** 行内按钮 28px 与开关轨道同排不撑卡；footer「完成」与「保存」同 36px 同圆角。

## SPC-016 保存 / 完成主按钮

- **要求** `.sc-save-button`、`.sc-button-primary-small` 必须完整复用 primaryButton standard 档：`box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; align-self: flex-end; height: 36px; padding: 0 14px; border: none; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); font: inherit; font-size: 14px; line-height: 22px; cursor: pointer;` + hover `var(--dsw-alias-button-primary-hover)`。**废止** `color: #fff`（暗色=白底白字不可读）、`font-weight: 600`、`border-radius: 10px/8px` 野值、`padding: 10px 28px / 9px 18px`、`background: brand-primary` 裸用（应经 `button-primary-fill` 别名）、`justify-self: end`（flex 下改 `align-self: flex-end`，宽度自适应由按钮自身承担）。
- **钉死值**

  ```css
  .sc-button-primary-small,
  .sc-save-button {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    align-self: flex-end;
    height: 36px;
    padding: 0 14px;
    border: none;
    border-radius: var(--dsw-radius-md);
    background: var(--dsw-alias-button-primary-fill);
    color: var(--dsw-alias-label-primary-foreground);
    font: inherit;
    font-size: 14px;
    line-height: 22px;
    cursor: pointer;
  }
  @media (hover: hover) {
    .sc-button-primary-small:hover:not(:disabled),
    .sc-save-button:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
  }
  ```
- **官方原文** `.primaryButton { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }` + `@media (hover: hover) { .primaryButton:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); } }`（基底见 SPC-014）
- **来源** Issue #50（保存=右对齐自适应宽度品牌色）。`ModelsSection.module.css` `.primaryButton`；token `button-primary-fill/hover`（第 4 节）。
- **裁定（Hydrogen High）** 直接适用。Issue 口径「右对齐」由 `align-self: flex-end`（原 grid justify-self 的 flex 等价）+ 内容自适应宽度实现，不需固定 padding 撑宽。
- **验收** 暗色下保存按钮为近白底 + 深色字可读；按钮宽度随文案「保存中…」自适应；右缘与列对齐。

## SPC-017 disabled 分层

- **要求** 禁用态按元素族分档：动作按钮类（`.sc-button*`、`.sc-save-button`、`.sc-add-button` 未来动作钮）`opacity: 0.4; cursor: default;`；输入类（`.sc-input`）`opacity: 0.6; cursor: default;`；开关（track 及 label 联动）`opacity: .5; cursor: default;`。全站**废止** `cursor: not-allowed` 与一刀切 `.55`。
- **钉死值**

  ```css
  .sc-button:disabled,
  .sc-button-primary:disabled,
  .sc-button-primary-small:disabled,
  .sc-button-secondary:disabled,
  .sc-button-danger:disabled,
  .sc-save-button:disabled,
  .sc-add-button:disabled { opacity: 0.4; cursor: default; }
  .sc-input:disabled { opacity: 0.6; cursor: default; }
  /* 开关：track .5 / label .5，见 SPC-011/SPC-012 */
  ```
- **官方原文** `.primaryButton:disabled, .secondaryButton:disabled, .dangerButton:disabled, .addButton:disabled, .linkButton:disabled, .addModelButton:disabled { opacity: 0.4; cursor: default; }`；`.input:disabled { opacity: 0.6; cursor: default; }`；`.keyToggle:disabled { opacity: 0.6; cursor: default; }`；编译 `.switch:disabled { cursor: default; opacity: .5; }`
- **来源** Issue #50。`ModelsSection.module.css` disabled 组；编译 Switch CSS。
- **裁定（Hydrogen High）** 直接适用（按钮 .4 / 输入 .6，官方注释语义：禁用输入保文字可读）；开关 .5 取编译原语实证（ModelsSection 源内 switch 样式属 primitives 编译 CSS——对源码文本论「未获取」，对编译产物已实证）；`.sc-drag-handle/.sc-picker-item` 并入按钮/操作项档 .4（把手实证见 SPC-027；picker 项见 SPC-025；现状 `.55/not-allowed` 废止）。
- **验收** 只读态下无任何 `not-allowed` 指针；三档透明度各自正确。

## SPC-018 焦点态规范表（红线）

- **要求** 焦点态必须按下表钉死；`--dsw-focus-ring-color` 变量机制不得绕过。

  | 控件类别 | 我方选择器 | 钉死声明 | 依据 |
  | --- | --- | --- | --- |
  | 按钮 / 图标 / 把手 / 添加钮 / picker 项 | `.sc-button*`、`.sc-save-button`、`.sc-drag-handle`、`.sc-icon-button`、`.sc-add-button`、`.sc-picker-item` | `:focus-visible { outline: none; box-shadow: 0 0 0 var(--dsw-focus-ring-width, 2px) var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }` | 官方按钮焦点组 + `.trigger/.cell/.item` 同款 box-shadow 环 |
  | 文本/密码输入 | `.sc-input` | `:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }`（`:focus` 而非 `:focus-visible`——输入属 `:read-write` 不受指针模态抑制） | `.input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }`（outline:none 为防双框类推建议，官方此项**未获取**） |
  | 开关 | `.sc-switch-input:focus-visible + .sc-switch-track` | `outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px;`（offset 2px 编译原语实证）**并必须补**：`html[data-input-modality='pointer'] .sc-switch-input:focus-visible + .sc-switch-track { outline-color: transparent; }` | 编译 `.switch:focus-visible` 原文；`theme-focus.css` 指针模态抑制——`:focus-visible` 上的变量设在隐藏 input 上，**不会**传给 `+` 兄弟节点，须显式补 |
  | 内嵌图标钮（如未来 keyToggle） | `.sc-key-toggle` | `outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px;` | `.keyToggle:focus-visible` 原文 |
- **官方原文**（机制）`:root { --dsw-focus-ring-width: 2px; }`；`:focus-visible { outline-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-width: var(--dsw-focus-ring-width); }`；`html[data-input-modality='pointer'] body :focus-visible:not(:read-write) { --dsw-focus-ring-color: transparent; outline-color: transparent; }`（`theme-focus.css`）；（按钮组）`.primaryButton:focus-visible, … , .iconButton:focus-visible, .customizedSummary:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }`
- **来源** Issue #50。`dsh-client-ui-theme/src/styles/focus.css`；`ModelsSection.module.css` 焦点组；`ModelSelect.module.css` `.trigger:focus-visible`；编译 `.item:focus-visible`。
- **裁定（Hydrogen High）** 直接适用 + 强制红线：**焦点色禁止 brand-primary**（我方现状开关环黑色即此错）；指针模态下环必须可被抑制——兄弟节点变量不继承的陷阱必须用显式 pointer 规则弥补。
- **验收** Tab 遍历全控件均现 2px 蓝环（贴合 superellipse 圆角）；纯鼠标点击后按钮/开关无残留环；文本框点击即有蓝色描边焦点。

## SPC-019 编辑器 / 内嵌面板容器（模块铬层）

- **要求** 卡片内展开编辑器 `.sc-editor`、添加/编辑内嵌块 `.sc-picker`、内嵌编辑弹块 `.sc-dialog` 一律使用**模块铬层**：`box-sizing: border-box; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); padding: 14px 16px; display: flex; flex-direction: column; gap: 14px;`（`.sc-picker` 的子项间距例外见 SPC-025）。**废止** `.sc-dialog` 现状 `bg-layer-2`（亮=纯白，白底上无边界）、`border-radius: 14px` 野值、`padding: 24px` 过宽、`position: relative; z-index: 1` 中的悬浮层语义（无遮罩弹窗遗留）。嵌套变体：当编辑器渲染在已带铬层父卡内时，必须 `background: none; padding: 0;`（官方 `.addCard .editor` 原文）。
- **钉死值**

  ```css
  .sc-editor,
  .sc-picker,
  .sc-dialog {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px 16px;
    border-radius: var(--dsw-radius-lg);
    background: var(--dsw-alias-bg-module-platform);
    color: var(--dsw-alias-label-primary);
  }
  .sc-editor { gap: 14px; }
  /* 嵌套变体（官方 .addCard .editor 原文语义） */
  .sc-card .sc-editor,
  .sc-card .sc-dialog { background: none; padding: 0; }
  ```
- **官方原文** `/* Editing surface: a filled module on the panel, matching the settings selector fill rather than adding another outline inside the row. */ .editor { border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }`；`.addCard, .setupCard { border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; list-style: none; }`；`/* Nested in a card that already carries the module chrome. */ .addCard .editor, .setupCard .editor { background: none; padding: 0; }`
- **来源** Issue #50（编辑=圆角内嵌区）。`ModelsSection.module.css` `.editor/.addCard/.setupCard`。
- **裁定（Hydrogen High）** 直接适用（模块铬层三参数一致：填充、圆角、内距；「避免框中框再加线」为官方注释语义）。官方独立 `.editor` 顶层声明与模块铬层同形由 `.addCard .editor` 注释佐证，其单独原文**未获取**。`.sc-dialog` 非模态（面板内嵌流内块）定性由此而来。
- **验收** 编辑器为浅灰模块（亮 `rgb(249,250,251)`~`rgb(245,246,247)` 档，见第 4 节 cascade 注记），与白卡形成「白卡→灰模块→白控件」三层；卡内嵌套时不出现双层底色。

## SPC-020 字段、标签、提示与编辑器标题

- **要求** `.sc-field` 必须 `display: flex; flex-direction: column; gap: 6px; margin-block: 0;`（field 间节奏交还容器 gap 14）；字段标签 `.sc-field-label` 必须 `display: inline-flex; align-items: center; gap: 10px; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary);`；提示 `.sc-advanced-hint` 与错误 `.sc-error` 同档 12/18（色分别 `label-tertiary` / `state-error-primary`）；编辑器头 `.sc-editor-header` `display: flex; align-items: baseline; gap: 8px;`；编辑器标题 `.sc-editor-title` 必须 `margin: 0; font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary);`（现状仅 `margin: 0 0 4px`，字号随宿主继承须钉死）；路由摘要 `.sc-editor-route` `12px/18px/label-tertiary`。
- **钉死值**

  ```css
  .sc-editor-header { display: flex; align-items: baseline; gap: 8px; }
  .sc-editor-title { margin: 0; font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary); }
  .sc-editor-route { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
  .sc-field { display: flex; flex-direction: column; gap: 6px; margin-block: 0; }
  .sc-field-label {
    display: inline-flex; align-items: center; gap: 10px;
    font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary);
  }
  .sc-advanced-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
  .sc-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
  ```
- **官方原文** `.editorHeader { display: flex; align-items: baseline; gap: 8px; }`；`.editorTitle { font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary); }`；`.editorRoute { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }`；`.field { display: flex; flex-direction: column; gap: 6px; }`；`.fieldLabel { display: inline-flex; align-items: center; gap: 10px; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }`；`.advancedHint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }`；`.error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }`
- **来源** Issue #50。`ModelsSection.module.css` 同名选择器；`CustomProviderCard.tsx`（`div.editor > div.field > span.fieldLabel + input.input` + `p.error | p.advancedHint` 模式）。
- **裁定（Hydrogen High）** 直接适用。
- **验收** 标签比控件文字小一档且次级灰；错误红/提示灰同档不同色；编辑器标题不再随宿主 h 标签浮动。

## SPC-021 输入框与下拉型 select

- **要求** `.sc-input` 必须 `box-sizing: border-box; width: 100%; height: 32px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); font: inherit; font-size: 14px; line-height: 22px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);`；placeholder `var(--dsw-alias-label-dimmed)`；`:focus` 见 SPC-018；`:disabled` 见 SPC-017。`select.sc-input` 必须 `max-width: 240px; cursor: pointer;`；自绘 chevron 类 `.sc-select-input` 必须 `appearance: none; padding-right: 32px; background-image: url("<官方 data-uri 逐字，见下>"); background-repeat: no-repeat; background-position: right 12px center; background-size: 12px 12px;`。**不适用**（模型页/官方密钥控件特有，我方契约无对应 DOM，强行引入即改行为）：`.keyToggle`、`.keyInputFilled`（padding-right 40px）、`.savedKeyInput` placeholder 提亮（我方从不回显已存 key，提亮会误导「框内已有值」，必须保持 `label-dimmed`）。
- **钉死值**

  ```css
  .sc-input {
    box-sizing: border-box;
    width: 100%;
    height: 32px;
    padding: 0 10px;
    border: 0.5px solid var(--dsw-alias-border-l4);
    border-radius: var(--dsw-radius-md);
    font: inherit;
    font-size: 14px;
    line-height: 22px;
    background: var(--dsw-alias-bg-layer-1);
    color: var(--dsw-alias-label-primary);
  }
  .sc-input::placeholder { color: var(--dsw-alias-label-dimmed); }
  select.sc-input { max-width: 240px; cursor: pointer; }
  .sc-select-input {
    appearance: none;
    padding-right: 32px;
    /* Data-URI SVGs cannot resolve CSS variables; #81858C is the caption gray
       shared by both themes. */
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 12px center;
    background-size: 12px 12px;
  }
  ```
- **官方原文** `.input { …如钉死值… }`；`/* Enum pickers hold a handful of short options; a field-width dropdown reads as a text field the user is expected to fill. */ select.input { max-width: 240px; cursor: pointer; }`；`/* Select variant of .input: … */ .selectInput { …如钉死值（含原文注释）… }`；`.input::placeholder { color: var(--dsw-alias-label-dimmed); }`。data-uri 已按裁定要求从 `ModelsSection.module.css` 890-899 行逐字补全（Hydrogen High 摘录时为省略写法）。
- **来源** Issue #50。`ModelsSection.module.css` `.input/select.input/.selectInput`；`ApiKeyInput.tsx`（我方 API key password 输入框套用 `.input` 基础全组）。
- **裁定（Hydrogen High）** `.input`/`.selectInput` 直接适用；`keyToggle/keyInputFilled/savedKeyInput` **不适用**（行为契约冻结、从不回显 key 的策略）。
- **验收** 输入框 32px 高、hover 无跳变、focus 描边变蓝无外环；select 右缘留 32px chevron 位、箭头不贴边；已保存 key 的 placeholder 仍为 dimmed 灰。

## SPC-022 操作行（编辑器 footer 与确认框按钮行）

- **要求** 编辑器操作行 `.sc-editor-actions`（新）与确认框操作行 `.sc-confirm-actions` 必须 `display: flex; justify-content: flex-end; gap: 8px;`；内部按钮一律 standard 档（36px）；「取消 secondary 在左、提交 primary 在右」为官方秩序——调整 DOM 顺序涉及焦点流时**允许保留现状顺序**，仅钉视觉。确认框若为独立对话框容器才可参考 `width: min(480px, 100%)`（官方 `.deleteDialog` 仅此一条实证，其余弹窗壳层**未获取**）；我方确认区为面板内嵌，弹窗壳层**不适用**。
- **钉死值**

  ```css
  .sc-editor-actions,
  .sc-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
  ```
- **官方原文** `.editorActions { display: flex; justify-content: flex-end; gap: 8px; }`；`<Modal … className={styles['deleteDialog']}>` footer=`<Button variant="outline" data-modal-autofocus …>cancel</Button> + <Button variant="outline" className={styles['deleteConfirm']} …>`（`ModelsSection.tsx`）
- **来源** Issue #50（保存=右对齐）。`ModelsSection.module.css` `.editorActions/.deleteDialog`；`EditorFooter.tsx`。
- **裁定（Hydrogen High）** `.editorActions` 骨架直接适用；`.deleteDialog` 弹窗壳层不适用（内嵌契约），仅留宽度参考值；顺序若受契约约束则保持原 DOM 顺序仅对齐视觉。
- **验收** footer 两钮右对齐 gap 8px；确认框按钮 36px 标准档。

## SPC-023 危险文案色总表（收口）

- **要求** 危险/错误语义全部收口两枚 token：前景 `var(--dsw-alias-state-error-primary)`（亮 `rgb(236,19,19)`/暗 `rgb(242,90,90)`）、hover 底 `var(--dsw-alias-interactive-bg-hover-danger)`（`rgba(236,19,19,.05)`/`rgba(242,90,90,.15)`）。落点：移除/danger 文字按钮（SPC-014/015）；图标危险钮 `.sc-icon-button-danger:hover`（SPC-027）；error 文案 12/18（SPC-020）；删除确认 `.sc-delete-confirm:not(:disabled)` 必须 `--dsh-button-outline-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary);` + hover danger 底（官方 `.deleteConfirm` 逐字）；确认按钮如需键盘红环，只允许 `--dsw-focus-ring-color: var(--dsw-alias-state-error-primary)` 变量覆写（保持指针模态抑制）；菜单 danger 项规范预留于 SPC-026（当前无菜单 DOM，不生成冗余样式）。
- **钉死值**

  ```css
  .sc-delete-confirm:not(:disabled) {
    --dsh-button-outline-color: var(--dsw-alias-state-error-primary);
    color: var(--dsw-alias-state-error-primary);
  }
  @media (hover: hover) {
    .sc-delete-confirm:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
  }
  ```
- **官方原文** `.deleteConfirm:not(:disabled) { --dsh-button-outline-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }`；`@media (hover: hover) { .deleteConfirm:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); } }`；`/* The delete glyph keeps the danger tint the rest of the section uses. */ @media (hover: hover) { .iconButtonDanger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); } }`
- **来源** Issue #50（remove=纯红字 state-error-primary）。`ModelsSection.module.css` `.deleteConfirm/.iconButtonDanger`；`WebSearchCard.module.css` `.notice`（同 token）。
- **裁定（Hydrogen High）** 直接适用（token 层收口；菜单 danger 的完整官方逐字声明该轮未附材料，规范以 SPC-026 编译反解为准）。
- **验收** 亮/暗下危险文字均可辨；无任何「红底白字实心删除钮」出现。

## SPC-024 添加块（整宽虚线按钮）

- **要求** 添加区容器 `.sc-add-block` `display: flex; flex-direction: column; gap: 12px;`；按钮行 `.sc-add-actions` `display: flex;`；`.sc-add-button` 必须 `box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; flex: 1 1 0; min-width: 180px; height: 44px; padding: 0 14px; gap: 6px; border: 1px dashed var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; cursor: pointer;` + hover `var(--dsw-alias-interactive-bg-hover)`。**废止**：`min-height: 70px`、`padding: 18px`、`1.5px dashed border-l2`（过粗过浅）、`border-radius: 14px` 野值、`label-secondary` 文字、`bg-layer-1` hover（白上无反馈）、`text-align: center`（flex 居中已足）、`margin-block: 8px`。图标与文字两元素由 `gap: 6px` 排布（对应官方 `<IconPlusOutlineRegular size={14}/> + t('add')`）。
- **钉死值**

  ```css
  .sc-add-block { display: flex; flex-direction: column; gap: 12px; }
  .sc-add-actions { display: flex; }
  .sc-add-button {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 1 1 0;
    min-width: 180px;
    height: 44px;
    padding: 0 14px;
    gap: 6px;
    border: 1px dashed var(--dsw-alias-border-l3);
    border-radius: var(--dsw-radius-lg);
    background: transparent;
    color: var(--dsw-alias-label-primary);
    font: inherit;
    font-size: 14px;
    line-height: 22px;
    cursor: pointer;
  }
  @media (hover: hover) {
    .sc-add-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
  }
  ```
- **官方原文** `/* The one entry to the add card, spanning the same width as the rows above. */ .addActions { display: flex; }`；`/* Overrides the shared button base above: this is not a pill sitting in a footer but the last slot of the provider list, so it fills the row and repeats the row cards' corner. Dashed, like every other "nothing here yet" affordance on this page, to read as a place rather than a command. */ .addButton { flex: 1 1 0; min-width: 180px; gap: 6px; height: 44px; border: 1px dashed var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg); }`；`.addBlock { display: flex; flex-direction: column; gap: 12px; }`；空态同款（`.modelEmpty` 在源文件中为两个规则块，逐字）：`.modelCatalogMeta, .modelEmpty { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }` + `.modelEmpty { padding: 12px; border: 1px dashed var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg); text-align: center; }`
- **来源** Issue #50（添加=整宽虚线大按钮 + 图标）。`ModelsSection.module.css` `.addBlock/.addActions/.addButton/.modelEmpty`；`ModelsSection.tsx` 添加按钮 DOM。
- **裁定（Hydrogen High）** 直接适用（容器布局、尺寸、虚线、圆角、字档、文字色、hover）；focus/disabled 按 SPC-018/017 全局类推补齐（非 hover 背景已实证：覆写块不声明 background，继承 166 行组规则 `.secondaryButton, .addButton { background: transparent }`）。空列表引导态可复用 `.sc-add-button`；如需纯文案空态则类推 `.modelEmpty`（直接适用其逐字值）。
- **验收** 按钮整宽 44px、与卡片同圆角档（16px）、与列表同宽；hover 呈极浅半透明灰；虚线读作「位置」而非「指令」（官方注释语义）。

## SPC-025 添加展开类型列表（内嵌 picker）

- **要求** 形态定性：**内嵌操作列表**，不是下拉浮层——保留内嵌展开，不改 portal。容器 `.sc-picker` 吃模块铬层（SPC-019）但子项间距钉 `gap: 8px`（8 项竖排取紧凑档，类推 `.addModes`；与 `.addCard` 节块 14px 的偏离在此登记）。类型项 `.sc-picker-item` 保留双行卡行：`display: flex; width: 100%; flex-direction: column; align-items: flex-start; gap: 4px; padding: 14px 16px; border: 0; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; text-align: start; cursor: pointer;`；hover 必须 `var(--dsw-alias-interactive-bg-hover-solid)`（**废止 bg-layer-2**——亮色白上无反馈；白底上铺半透明 `interactive-bg-hover` 会透灰变脏，实底 token 零叠加副作用为裁定钉死）〔勘误·lead 2026-11-25：本条钉死值原文 token 名笔误 `interactive-bg-solid`，实证更正为 `interactive-bg-hover-solid`——`design-platform.css` 仅此后者（2 处定义，前者 0 处）；HH 裁定语义（实底 hover、废止 bg-layer-2）不变，§4 token 表与 A-045 即此名〕；focus 环按 SPC-018；title `.sc-picker-title` 必须 `font-size: 14px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-primary);`；billing `.sc-picker-billing` 必须 `font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary);`（**废止 14px label-secondary**——与标题同大倒挂）。
- **钉死值**

  ```css
  .sc-picker { gap: 8px; } /* 其余声明并入 SPC-019 的 .sc-picker 铬层组 */
  .sc-picker-item {
    display: flex;
    width: 100%;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 14px 16px;
    border: 0;
    border-radius: var(--dsw-radius-md);
    background: var(--dsw-alias-bg-layer-1);
    color: var(--dsw-alias-label-primary);
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  @media (hover: hover) {
    .sc-picker-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
  }
  .sc-picker-title { font-size: 14px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-primary); }
  .sc-picker-billing { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
  ```
- **官方原文** 容器锚 `.addCard`（SPC-019 原文）；间距类推 `.addModes { … gap: 8px; }`；副文字档锚 `.advancedHint`（SPC-020 原文）；圆角嵌套律出处 `.tabs { border-radius: var(--dsw-radius-lg); }` 内 `.indicator { border-radius: var(--dsw-radius-md); }`（「外 lg 内 md」）。
- **来源** Issue #50。`ModelsSection.module.css` `.addCard/.addModes/.advancedHint`；`Menu` 编译 CSS（交互态参照）；`WebSearchCard.module.css`（同域下拉形态对照，裁定不采）。
- **裁定（Hydrogen High）** 容器直接适用（`.addCard` 铬层）；项为**类推延伸**（官方无内嵌双行 picker 先例，Menu 34px 单行项不适用——双行计费文案放不下；title 14/22/600 中 600 沿用我方现状，官方行标题字重**未获取**；billing 字档直接锚 `.advancedHint`）。`border-radius: 10px` 野值收口 radius-md；`text-align: left` 写作 `start`（官方 `.item` 用 left，此处保留我方 RTL 友好写法，登记无碍）。
- **验收** 「添加搜索工具」展开为灰模块 + 8 张白双行卡行；hover 白行变实底浅灰可辨；billing 恒小于 title；键盘可达出焦点环。

## SPC-026 下拉菜单浮层规范（预留，当前不落地）

- **要求** 本面板当前**无浮层 DOM**，本节为预留规范（未来引入下拉/右键菜单时必须按此执行）：浮层材质 `box-sizing: border-box; padding: 4px; border: 0; --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent);`（描边由 elevation 变量的 stroke 色承担）；材质层 `.material`：`position: absolute; inset: 0; z-index: -1; border-radius: inherit; background: var(--dsw-menu-surface-fill); backdrop-filter: var(--dsw-menu-backdrop-filter); pointer-events: none;`；定位（非 portal 档）`position: absolute; top: calc(100% + 4px); left: 0; z-index: 100; min-width: min(144px, calc(100vw - 24px)); max-width: min(360px, calc(100vw - 24px));`（portal 档 ModelSelect：`position: fixed; z-index: 1100; min-width: min(240px,…); max-width: min(420px,…); max-height: min(360px, calc(100dvh - 96px)); overflow: hidden;`）。标准项 `.item`：`display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px; padding: 6px 8px; border: none; border-radius: var(--dsw-radius-md); background: transparent; cursor: pointer; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); text-align: left;`，hover/focus-visible `background: var(--dsw-alias-interactive-bg-hover)`（focus 去 outline），disabled `opacity: .4`；选中态 `background: transparent` + 尾部勾 `.check`（`flex: none; color: var(--dsw-alias-label-primary);`，A 变体 `display: grid; place-items: center; flex: 0 0 14px;`）；danger 项=SPC-023 色组；分组标签 `padding: 6px 8px; font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary);`；分隔线 `height: .5px; margin: 3px 8px; background: var(--dsw-alias-border-l2);`。紧凑触发器 `.trigger`（28px/13-20/label-secondary/box-shadow 环）与二级行 `.cell`（34px + `cellValue` 右对齐 tertiary + `cellChevron` 12px `menu-icon`）数值保留作对照。**浮层外层 border-radius、`--dsw-elevation-prominent`、`--dsw-menu-backdrop-filter` 具体值：未获取**（几何参考：内项 12px + padding 4px = 16px；不得按猜测钉死）。
- **钉死值** 见本节要求（预留条款，不产出现网样式）。
- **官方原文** `.list, .submenu { box-sizing: border-box; padding: 4px; display: flex; flex-direction: column; gap: 0; border: 0; --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent); … }`；`.material { … }`、`.item { … }`、`.label`、`.separator`（编译反解，`70kcw`/`1w4el` 段）；`ModelSelect.module.css` `.menu/.trigger/.option/.cell/.cellValue/.cellChevron`（注释逐字：`Surface tokens match the Menu primitive card (ui-primitives Menu.module.css) so every dropdown reads as the same material.`）
- **来源** Issue #52（lead 补充③：下拉取证超出 context-menu 范围）。`ModelSelect.module.css`；编译 Menu 原语。
- **裁定（Hydrogen High）** 对浮层组件直接适用；对我方**内嵌 picker 不适用**（内嵌块不叠毛玻璃/浮层阴影/4px 紧凑内距，走 SPC-025）；`.trigger/.cell` 对我方整宽添加钮**不适用**（形态定位不同，强行套用破坏主入口可发现性），焦点环模式类推可复用。`.cellValue` 亮 disabled 变体（`color: label-dimmed`）为 ModelSelect 特有，与 B 主干（`opacity: .4`）并列标注不得混写。
- **验收** 本条为预留规范：现网若出现任何浮层样式即违规；未来实现时以本表值与官方同材质截图对比验收。

## SPC-027 拖拽视觉（把手、拖拽态、插入指示线、预览）

- **要求** 图标/把手按钮 `.sc-drag-handle`（与未来 `.sc-icon-button`）必须 `box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-tertiary); font-family: inherit; font-size: 14px; line-height: 1; cursor: pointer;`；hover `interactive-bg-hover` + 文字转 `label-primary`；disabled `cursor: default; opacity: 0.4`；焦点按 SPC-018（box-shadow 环）。把手字符「⠿」以 `14px/line-height:1` 等效官方 `IconDragHandleOutlineRegular size=14`（类推延伸，墨迹边界受回退字体度量限制已在裁定中登记）。指针态：`:not(:disabled)` `cursor: grab`；`:active:not(:disabled)` `cursor: grabbing`（官方未声明 grabbing，类推延伸，必须带 `:not(:disabled)`）。拖拽态：`.sc-card[data-dragging] { opacity: 0.5; }`；`.sc-card[data-drop-target] { z-index: 1; }`；插入指示线**完整照搬**官方 gradient 三连伪元素（前提：SPC-005 容器 `gap: 8px` + SPC-006 `position: relative`；**不得**给伪元素加 `pointer-events: none`，否则破坏官方「so native drops reach the insertion line」命中区设计）：

  ```css
  .sc-card::before, .sc-card::after { content: ''; position: absolute; z-index: 1; left: 0; right: 0; height: 4px; }
  .sc-card::before { top: -4px; }
  .sc-card::after { bottom: -4px; }
  .sc-card[data-drop-target='before']::before,
  .sc-card[data-drop-target='after']::after {
    height: 12px;
    background:
      linear-gradient(55deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat,
      linear-gradient(125deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat,
      linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat;
  }
  .sc-card[data-drop-target='before']::before { top: -10px; }
  .sc-card[data-drop-target='after']::after { bottom: -10px; }
  .sc-card-drag-preview { background: var(--dsw-alias-bg-module-platform); }
  ```
- **官方原文** `.iconButton { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }` + hover/disabled/focus 组（SPC-014/018 引及）；`/* Square, label-free affordances: the row's own inputs carry the meaning, so the actions stay glyphs and announce themselves through aria-label. */`；`.modelDragHandle:not(:disabled) { cursor: grab; }`；`.modelEntry[data-dragging] { opacity: 0.5; }`；`.modelEntry[data-drop-target] { z-index: 1; }`；`.modelDragPreview { background: var(--dsw-alias-bg-module-platform); }`；`/* Each row owns half of the 8px gap so native drops reach the insertion line. */` + 上述 gradient 原文（选择器 `.modelEntry`）
- **来源** Issue #50（可拖动把手换位）。`ModelsSection.module.css` `.iconButton/.modelDragHandle/.modelEntry*`；`ModelRow.tsx` 把手 DOM（`button.iconButton.modelDragHandle`，`aria-label`、`aria-keyshortcuts="ArrowUp ArrowDown"`、`draggable`）。
- **裁定（Hydrogen High）** iconButton 全组直接适用；「⠿」字号为类推延伸；`grabbing` 为类推（官方**未获取**）；指示线**直接适用（完整照搬）**，附 SPC-005/006 两条布局前提；`data-dragging` 属性名沿用我方现网契约（官方同名实证，行为不变更名）。
- **验收** 拖动中途被拖卡呈 50% 透明；目标缝出现蓝「横线+左折角箭头」指示线且能命中 drop；把手 28×28 内 ⠿ 居中；`aria-keyshortcuts` 键盘路径不受样式改动影响。

## SPC-028 分段控件（当前不适用）

- **要求** 本面板无互斥添加模式/tablist 场景，**不引入** SegmentedControl。若未来引入，必须按官方两档钉死：容器 `--segmented-tabs-inset: 4px; position: relative; display: grid; padding: var(--segmented-tabs-inset); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform);`，主变体滑块 `inset: var(--segmented-tabs-inset) auto var(--segmented-tabs-inset) var(--segmented-tabs-inset); border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); transition: transform .18s ease; pointer-events: none;`；sm 档 `--segmented-tabs-inset: 2px; border-radius: calc(var(--dsw-radius-md) + var(--segmented-tabs-inset));`，其 tab `height: 30px`、选中 `[aria-selected=true] { font-weight: 500; }`（编译实证）；浮起变体滑块 `border: 0; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-soft); transform: translate(calc(var(--dsh-segment-index) * (100% + 2px))); transition: transform .16s ease;`（宽 `calc((100% - 8px - 2px * (var(--dsh-segment-count) - 1)) / var(--dsh-segment-count))`、`height: calc(100% - 8px)`、`top: 4px; left: 4px`）。主档 tab 按钮字号/内距/高度、`--dsw-elevation-soft` 实值：**未获取**。隐藏面板 `tabpanel[hidden] { display: none; }`。
- **钉死值** 预留条款，不产出现网样式。
- **官方原文** 编译 CSS 反解（`1lga9`/`1ocp1` 段，见 1.1）；官方用法：`ModelsSection.tsx` 添加区 catalog/custom 二模式切换。
- **来源** Issue #52（lead 补充③排查项）。
- **裁定（Hydrogen High）** **不适用**：模型页「添加区」特有控件；我方面板 8 类线性挑选点选即添加，无互斥模式，强行引入属无依据扩张。
- **验收** 现网无分段控件即符合本条。

## SPC-029 减弱动画

- **要求** 必须存在 `@media (prefers-reduced-motion: reduce) { .sc-switch-track, .sc-switch-track::after { transition: none; } }`（轨道颜色过渡已按 SPC-011 取消，本条覆盖滑块位移过渡；现状 120ms 全组件过渡废止——官方仅 `.thumb` 有 transform 过渡，其余控件无过渡声明，不保留多余 transition）。未来 chevron/折叠类 transform 过渡须并入本组。
- **钉死值**

  ```css
  @media (prefers-reduced-motion: reduce) {
    .sc-switch-track,
    .sc-switch-track::after { transition: none; }
  }
  ```
- **官方原文** `@media (prefers-reduced-motion: reduce) { .customizedSummary::before, .switchThumb { transition: none; } }`
- **来源** Issue #50（无障碍对齐）。`ModelsSection.module.css` reduced-motion 块。
- **裁定（Hydrogen High）** 直接适用（选择器映射到我方开关）。
- **验收** 系统开启「减弱动态效果」后开关滑块瞬移。

## SPC-030 保存状态节点文案

- **要求** `.sc-status-node` 必须 `margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);`；`[data-state="saved"]` 必须 `color: var(--dsw-alias-state-success-primary);`；`[data-state="error"]` 必须 `color: var(--dsw-alias-state-error-primary);`（字号现状未钉、随宿主继承——本条钉死 12/18 类推档）。
- **钉死值**

  ```css
  .sc-status-node { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
  .sc-status-node[data-state="saved"] { color: var(--dsw-alias-state-success-primary); }
  .sc-status-node[data-state="error"] { color: var(--dsw-alias-state-error-primary); }
  ```
- **官方原文** `.error`/`.savedNotice`（SPC-004/020 原文，12/18 档先例）；我方状态文案专属选择器官方**未获取**。
- **来源** Issue #50（状态文案色语义）。`ModelsSection.module.css` 12/18 辅助文案组。
- **裁定（Hydrogen High）** 颜色直接适用（已实证 token）；12/18 **类推延伸**（依据：官方模块内校验错误、辅助说明、fieldLabel、editorRoute 统一 12/18 档；`.savedNotice/success` 专属选择器**未获取**）。
- **验收** 保存三态文案同字号不同色；错误文案可读。

## 3. DOM 结构骨架

只复刻结构与数值；官方 CSS Modules 哈希类名不可复用。行为契约属性（`data-role/draggable/checked/onChange/onKeyDown/disabled/aria-*`）在现网 DOM 原位保留，以下骨架省略标注。

### 3.1 面板与卡片行（映射 `ModelsSection.tsx` 标题块 + `.rows`）

```html
<!-- 官方: div.section -->
<div class="sc-panel">
  <!-- 官方: h2.title（我方保留 h3 维持大纲，SPC-002） -->
  <h3 class="sc-title">网页搜索链</h3>
  <!-- 官方: p.intro -->
  <p class="sc-description">…</p>
  <!-- 官方预留位: p.notice / p.savedNotice（SPC-004，可选） -->

  <!-- 官方面板级开关先例无（SPC-013 类推：无卡裸行） -->
  <div class="sc-official-row">
    <label class="sc-switch">
      <input class="sc-switch-input" type="checkbox" role="switch" aria-checked="true" />
      <span class="sc-switch-track" aria-hidden="true"></span>
      <span class="sc-switch-label">DeepSeek 官方 API 使用官方搜索</span>
    </label>
    <p class="sc-official-hint">…</p>
  </div>

  <!-- 官方: ul.rows（SPC-005） -->
  <ul class="sc-card-list">
    <!-- 官方: li.rowCard（draggable/data-role 原位保留；SPC-006/027） -->
    <li class="sc-card">
      <!-- 官方: div.rowHead -->
      <div class="sc-card-row">
        <!-- 官方: span.rowIdentity（含 .credentialDot） -->
        <span class="sc-card-info">
          <button class="sc-drag-handle" aria-label="…">⠿</button>
          <!-- 官方: span.rowName -->
          <span class="sc-card-name">引擎名称</span>
          <!-- 官方: span.rowTag（可选） -->
          <span class="sc-type-badge">类型注记</span>
          <!-- 我方三态延伸：官方卡内无状态文案，文案 span 为契约保留（SPC-010） -->
          <span class="sc-status"><span class="sc-status-dot"></span><span>已就绪</span></span>
        </span>
        <!-- 官方: span.rowActions（开关/编辑/移除等控件内部属性原样保留） -->
        <span class="sc-card-actions">
          <label class="sc-switch">…（36×20 开关 + 「启用」文字）</label>
          <button class="sc-button sc-button-secondary">编辑</button>
          <button class="sc-button-danger">移除</button>
        </span>
      </div>
      <!-- 官方可选第二子节点: div.editor（受 .sc-card gap:12 约束，SPC-019 嵌套变体） -->
    </li>
  </ul>

  <!-- 官方: div.addBlock > div.addActions > button.addButton（SPC-024） -->
  <div class="sc-add-block">
    <div class="sc-add-actions"><button class="sc-add-button"><span aria-hidden="true">＋</span>添加搜索工具</button></div>
    <!-- 我方内嵌 picker（SPC-025；非官方浮层体系，不映射 .menu/.list/.material） -->
    <div class="sc-picker">
      <button class="sc-picker-item">
        <span class="sc-picker-title">类型名</span>
        <span class="sc-picker-billing">计费说明</span>
      </button>
    </div>
  </div>

  <!-- 官方: div > p.savedNotice[role=status]（如实现即插此位，SPC-004） -->
</div>
```

### 3.2 编辑器与操作行（映射 `div.editor` + `EditorFooter.tsx`）

```html
<!-- 官方: div.editor > div.field > span.fieldLabel + input.input (+ p.error | p.advancedHint) -->
<div class="sc-editor">
  <div class="sc-editor-header">
    <span class="sc-editor-title">编辑 …</span>
    <span class="sc-editor-route">…</span>
  </div>
  <div class="sc-field">
    <span class="sc-field-label">名称</span>
    <input class="sc-input" />
    <p class="sc-advanced-hint">…</p>
  </div>
  <div class="sc-field">
    <span class="sc-field-label">协议（示例）</span>
    <select class="sc-input sc-select-input">…</select>
  </div>
  <p class="sc-error">…</p>
  <!-- 官方: div.editorActions > secondaryButton(Cancel, 左) + primaryButton(Commit, 右) -->
  <div class="sc-editor-actions sc-confirm-actions">
    <button class="sc-button sc-button-secondary">取消</button>
    <button class="sc-button-primary-small">完成</button>
  </div>
</div>
<!-- 确认框（内嵌流内，非模态）：
     div.sc-dialog > … + div.sc-confirm-actions >
     button.sc-button-danger.sc-delete-confirm（确认移除） + button.sc-button.sc-button-secondary（取消）
     （官方 deleteDialog 为 Modal 壳层——我方不适用，SPC-022） -->
```

### 3.3 官方浮层树（对照 SPC-026 预留；我方当前不产此 DOM）

```text
div.root (relative; inline-flex)
├── button.trigger                    28px 紧凑触发器（SPC-026 对照）
└── div.list|div.menu                 padding 4、border 0、elevation-prominent、stroke=l1
    ├── div.material                  半透明填充 + backdrop-filter
    ├── div.label (可选)              11/15 label-tertiary
    ├── button.item|.option           34px、radius-md、13/20、hover/focus interactive-bg-hover、
    │   │                             选中=尾部勾不填充（A .check 14px 占位）
    │   ├── span.itemIcon (可选)      14×14 menu-icon
    │   ├── span.itemLabel            flex:1 ellipsis
    │   └── span.check (可选)         尾部选中勾
    ├── button.item.danger (可选)     state-error-primary + -danger 底
    ├── div.separator (可选)          .5px l2
    └── button.cell (可选, A)         二级入口行 + cellValue(右 tertiary) + cellChevron(12px)
```

## 4. Token 实证核对表

来源：`dsh-client-ui-theme/src/styles/design-platform.css`（`body{}`=亮、`body[data-ds-dark-theme]{}`=暗）、`theme-base.css`。凡标「运行时注入未实证」者**不得展开为字面量使用**，只能引用变量名。

| Token | 亮色 | 暗色 | 状态 |
| --- | --- | --- | --- |
| `--dsw-radius-xs/sm/md/lg/xl/panel` | 4/8/12/16/20/28px | 同左 | 实证（theme-base.css `:root`） |
| `--dsw-alias-settings-card-fill` | `bg-layer-2`=rgb(255,255,255) | rgb(44,44,46) | 实证（theme-base.css `body{}` 别名链） |
| `--dsw-alias-settings-card-stroke` | `border-l4`=rgba(0,0,0,.16) | rgba(255,255,255,.2) | 实证 |
| `--dsw-alias-bg-layer-1/2/3` | rgb(255,255,255) ×3 | rgb(35,35,36)/rgb(44,44,46)/rgb(53,54,56) | 实证 |
| `--dsw-alias-bg-module-platform` | `bluish-60` | `bluish-800`=rgb(53,54,56) | 实证（**cascade 注记**：`bluish-60` 在文件内出现两个定义块 rgb(245,246,247)（68 行）与 rgb(249,250,251)（154 行），后者按层叠生效；引用 token 即可，勿硬编码） |
| `--dsw-alias-border-l1/l2/l3/l4` | rgba(0,0,0,.04/.1/.12/.16) | rgba(255,255,255,.06/.12/.16/.2) | 实证 |
| `--dsw-alias-label-primary` | rgb(15,17,21) | rgb(249,250,251) | 实证 |
| `--dsw-alias-label-secondary` | rgb(97,102,107) | rgb(207,211,214) | 实证 |
| `--dsw-alias-label-tertiary` | rgb(129,133,140) | rgb(173,178,184) | 实证 |
| `--dsw-alias-label-caption` | rgb(173,178,184) | rgb(129,133,140) | 实证 |
| `--dsw-alias-label-dimmed` | rgb(225,229,238) | rgb(67,69,74) | 实证 |
| `--dsw-alias-label-primary-foreground` | `bluish-00`=rgb(255,255,255) | `bluish-1000`=rgb(15,17,21) | 实证（257/409 行） |
| `--dsw-alias-brand-primary` | `bluish-1000`=rgb(15,17,21) | `bluish-50`=rgb(249,250,251) | 实证 |
| `--dsw-alias-button-primary-fill` | =brand-primary | =brand-primary | 实证（215/367 行） |
| `--dsw-alias-button-primary-hover` | `bluish-750`=rgb(67,69,74) | `bluish-100`=rgb(235,238,242) | 实证 |
| `--dsw-alias-state-success-primary` | green-500=rgb(34,197,94) | 同左 | 实证 |
| `--dsw-alias-state-error-primary` | red-600=rgb(236,19,19) | red-400=rgb(242,90,90) | 实证 |
| `--dsw-alias-state-warn-primary` | amber-500=rgb(245,158,11) | 同左 | 实证 |
| `--dsw-alias-state-warn-label` | amber-600=rgb(221,134,41) | 同左 | 实证 |
| `--dsw-alias-state-idle-primary` | neutral-300=rgb(212,212,212) | neutral-600=rgb(84,85,87) | 实证 |
| `--dsw-alias-state-business-primary` | deepseek-500=rgb(65,118,230) | deepseek-400=rgb(122,170,255) | 实证 |
| `--dsw-alias-interactive-bg-hover` | rgba(38,49,72,.06) | rgba(255,255,255,.08) | 实证 |
| `--dsw-alias-interactive-bg-hover-solid` | `bluish-75`=rgb(241,243,245) | `bluish-800`=rgb(53,54,56) | 实证（241/393 行） |
| `--dsw-alias-interactive-bg-hover-danger` | rgba(236,19,19,.05) | rgba(242,90,90,.15) | 实证 |
| `--dsw-alias-switch-thumb` | `bluish-00`=rgb(255,255,255) | `bluish-400`=rgb(173,178,184) | 实证（298/450 行） |
| `--dsw-focus-ring-width` | 2px（:root） | 同左 | 实证（focus.css） |
| `--dsw-focus-ring-color` 默认回退 | state-business-primary | 同左 | 实证（focus.css + 各组件回退写法） |
| `--dsw-menu-surface-fill` | rgba(252,253,254,.7) | rgba(48,49,54,.64) | 实证 |
| `--dsw-specific-menu`（darwin） | rgba(248,249,250,.94) | rgba(48,49,54,.94) | 实证 |
| `--dsw-alias-link` | deepseek-500 | deepseek-400 | 实证 |
| `--dsw-elevation-prominent / -panel / -soft`、`--dsw-shadow-lv3`、`--dsw-menu-backdrop-filter`、`--dsw-scrollbar-bg-l2/hover-l2` | — | — | **运行时注入未实证**：主题静态文件无数值定义，只可引用变量名 |
| `--dsw-alias-menu-icon`（亮色定义处） | 暗色块 415 行=`label-primary-dimmed` | 亮色未定位 | 半实证（引用变量名安全；亮色具体值未获取） |
| `state-*-bg-base / -bg-overlay` | — | — | **不存在于主题源**（仅 -primary/-secondary/-tertiary/-label 存在；实施中不得引用） |

## 5. 迁移表（PANEL_CSS 现状 → 钉死值）

「判定」列为 Hydrogen High 结论：**直接适用**（照官方搬）｜**类推延伸**（附依据）｜**模型页特有/不适用**｜**未覆盖**（第 6 节）。

| 现状（行号见 379-431） | 钉死 | 判定（Hydrogen High 理由摘要） | 条款 |
| --- | --- | --- | --- |
| `.sc-panel` grid | flex column + max-width 720 | 直接适用（同 .section 逐字；grid 轨道宽度差异） | SPC-001 |
| `.sc-title` 24px/700, margin-top 4 | 16/24/500, margin 0 | 直接适用（Issue #50 目测版做大了；WebSearchCard 14 档=二级节，不适用） | SPC-002 |
| `.sc-description` 15px secondary | 14/22 tertiary, margin 0 | 直接适用（15 不在字阶；secondary 主次倒置） | SPC-003 |
| `.sc-card` 14px 圆角/无描边/bg-layer-1/20-24 内距/min-height 90/margin-block 6 | settings-card 描边填充、radius-xl、12/14、无 min-height、position relative | 直接适用（近白表面层级靠 stroke 分层；野值 14px 收口 token） | SPC-005/006 |
| `.sc-card-row` space-between gap16 / `.sc-card-info` wrap gap10 / `.sc-card-actions` gap8 justify-end | 10 / 6 / 4 + margin-left:auto | 直接适用；wrap 保留=类推延伸（可选） | SPC-007 |
| `.sc-card-name` 20px/600 | 14/22/500 | 直接适用（字阶倒挂修正） | SPC-008 |
| `.sc-type-badge` bg-layer-2 填充/6px 圆角/12px | 描边 chip：0.5px l3、radius-xs、1px 6、11/16 | 直接适用（bg-layer-2 与新卡面同色会隐形；rowTag 注释意图 100% 契合） | SPC-009 |
| `.sc-status` gap7 14px / 点旁文案 | gap6 13/20、点 token 三态 | 类推延伸（官方点旁无文案；accountStatus 几何+rowTag 降噪色） | SPC-010 |
| 缺凭据点色（Issue 原口径橙=warn） | state-error-primary（warn 为登记备选） | 直接适用（官方无黄点先例，同页绿/红对齐零认知成本；Issue 口径偏离已在裁定记录——**需要 lead/产品确认**，见第 7 节） | SPC-010 |
| `.sc-status-dot` 8px 50% | +corner-shape:round、+box-sizing、三态色 | 直接适用（几何原本已同） | SPC-010 |
| `.sc-button` 1px l1 描边/8px 圆角/padding 8-14 | 基底+三变体（l3 描边、radius-md、36 高、inset hover-solid） | 直接适用 | SPC-014 |
| `.sc-button-danger:hover` underline | danger 浅红底浮现 | 直接适用（官方无下划线语言） | SPC-014/023 |
| 行内编辑/移除（标准档混入） | compact 28/10/sm/12-18 | 直接适用 | SPC-015 |
| `.sc-button-primary-small`/`.sc-save-button` #fff/600/10px/28px padding | primaryButton standard+`align-self: flex-end` | 直接适用（#fff 暗色白底白字致命；600 字重无据） | SPC-016 |
| `.sc-drag-handle` padding8 撑大 | iconButton 28×28/padding0/14px 字符档 | 直接适用+字符字号类推延伸 | SPC-027 |
| `.sc-drag-handle:active grabbing` | 保留并加 `:not(:disabled)` | 类推延伸（官方未声明 grabbing） | SPC-027 |
| 拖拽中/放置指示线（现状无） | opacity .5、z-index、gradient 指示线、预览底色 | 直接适用（完整照搬，前提 gap8+relative） | SPC-027 |
| `.sc-switch-track` 38×22 描边 bg-layer-2 | 36×20 无边 padding2 关 l3 开 brand-primary | 直接适用（编译原语数值；绿/描边/38 野值废止） | SPC-011 |
| 开关开态 success 绿 | brand-primary | 直接适用（官方开关从不绿，绿留给状态文案） | SPC-011 |
| `.sc-switch-track::after` #fff | switch-thumb / label-primary-foreground + translate(16px) | 直接适用（#fff 暗色双态失效） | SPC-011 |
| `.sc-switch` focus brand 环 | business 环 + pointer 模态补规则 | 直接适用（焦点红线） | SPC-018 |
| `.sc-switch*-disabled` .55 | .5 | 直接适用（编译原语实证） | SPC-011/012 |
| `.sc-add-button` 70px/1.5px l2/14px 圆角/secondary 字/bg-layer-1 hover | 44px/1px dashed l3/radius-lg/primary 字/interactive-bg-hover | 直接适用（5 处漂移全收口） | SPC-024 |
| `.sc-picker/.sc-dialog` bg-layer-2 白底/14px/24px | 模块铬层（module-platform、lg、14/16、gap14；picker gap8） | 直接适用（容器）+类推延伸（picker 项） | SPC-019/025 |
| `.sc-picker-item` radius10 / hover bg-layer-2（白上无反馈） | radius-md / hover interactive-bg-hover-solid | 类推延伸（外 lg 内 md 嵌套律；白卡上实底 hover） | SPC-025 |
| `.sc-picker-title` 无字号 / billing 14px 硬编码 | 14/22/600 / 12/18 tertiary | 类推延伸（billing 锚 advancedHint；title 600 沿用我方，官方字重未获取） | SPC-025 |
| `.sc-field` grid gap8 margin8 | flex column gap6 margin0 | 直接适用 | SPC-020 |
| `.sc-editor-title` 仅 margin | 14/22/500 primary | 直接适用 | SPC-020 |
| `.sc-input` 1px l1/8px/无固定高 | 0.5px l4/radius-md/32 高/dimmed placeholder | 直接适用 | SPC-021 |
| `.sc-confirm-actions`（保持） | flex end gap8 + 标准档钮 | 直接适用 | SPC-022 |
| `.sc-status-node` 无字号 | 12/18 + 三态 token 色 | 类推延伸（12/18 统一档） | SPC-030 |
| 统一 disabled .55 not-allowed | .4/.6/.5 + default | 直接适用（分档语义） | SPC-017 |
| `@media (max-width: 720px)` 卡内 padding18/16 等 | 未裁定 | **未覆盖**：窄屏细化规则本轮未喂裁定，迁移时保留现状声明，登记第 6 节 | — |
| `transition 120ms`（track/after/其余） | 仅 after 保 .12s transform；reduced-motion 关 | 直接适用 | SPC-011/029 |

## 6. 未获取 / 未实证 / 未裁定清单

**未获取（官方源码本轮未提供，禁止臆造）**

1. 浮层外层 `border-radius` 原值（`radius-panel` vs `radius-lg`，由未节选组合容器类决定；几何参考 12+4=16）。
2. `--dsw-elevation-prominent/-panel/-soft`、`--dsw-shadow-lv3`、`--dsw-menu-backdrop-filter`、滚动条 l2 token 的具体值（运行时注入未实证）。
3. `.rowCard` 的 `box-sizing`、`.rowName` 是否声明 `overflow-wrap`、行标题字重、`.item` 的 `font-weight`、`.addButton` 覆写块内是否另有背景声明（基底继承链已实证透明）、官方输入框 `:focus` 是否含 `outline: none`。（编译 Switch 的 `outline-offset` 已在收尾复核中实证为 2px，移出本清单。）
4. `savedNotice/success` 专属排版选择器、面板级开关行、内嵌双行 picker 项、三态点之 idle 态的官方先例。
5. `--dsw-alias-menu-icon` 亮色定义处；`label-primary-inverted` 全链。
6. 宿主设置页整体 section 注册层的额外容器样式（settings-shell 无独立视觉 CSS，已实证「无」即为结论）。

**不存在（引用即违规）**：`--dsw-alias-state-*-bg-base/-overlay`（主题源仅 -primary/-secondary/-tertiary/-label）。

**未裁定（本轮 5 个主题未覆盖，实施代理保持现状并登记）**：`.sc-card-name-placeholder`、`.sc-type-duplicate`（显隐逻辑）、`@media (max-width: 720px)` 内部覆写值、`.sc-card-actions` 的 `flex-wrap` 去留、暗色 `bluish-60` cascade 生效顺序的运行时复测。

**未验证项**：运行时计算样式对照（实施后须实机截图与官方「模型」区并排验收，本表未做运行时测量）；`corner-shape` 在不支持浏览器上的回退仅依赖 `@supports` 全局规则，未单测。

## 7. 诚实声明

- **实证**：第 2 节所有「官方原文」为 asar 源码逐字提取（路径见 1.1）；第 4 节 token 值为 `body{}`/`body[data-ds-dark-theme]{}`/`:root` 静态声明逐行读取；编译原语（Switch/Menu/Segmented）数值来自 `index-CSAdOBx6.css` 哈希段反解。
- **推断**：标注「类推延伸」的数值是 Hydrogen High 依所给证据作出的最近锚定，每条已写明依据；本表无一处由本文作者自行推断。
- **未获取**：第 6 节清单，实施中不得以猜测值填充；需要这些值时补取证或补裁定。
- **模型裁定边界**：Hydrogen High 只见到本文提交的摘录；凡摘录遗漏导致其标注「未获取」者（如 selectInput data-uri，后已按官方 890-899 行逐字补全入表），不代表官方无值，仅代表当时证据缺失。
- **行为契约**：本表通篇未提议更改任何 `data-role/checked/onChange/onKeyDown/disabled/draggable/aria-*` 语义；SPC-011 的映射表即为「契约零改动套官方数值」的裁定。
- **一处需 lead/产品确认的语义偏离**：Issue #50 口径「橙=缺凭据」，Hydrogen High 裁定优先对齐官方 credentialDot 绿/红语言（`state-error-primary`），`state-warn-primary` 保留为登记备选（SPC-010）。此为裁定与 Issue 字面口径的已知分歧，请 lead 定夺；本表默认按裁定值钉死。

## 附录 A：Hydrogen High 调用记录

模型确认（`agy models` 输出行，`/tmp/agy-models.txt`）：

```
gemini-4-hydrogen-high	Gemini 4 Hydrogen (High)
```

调用方式（登录壳提供 GEMINI_API_KEY，prompt 经环境变量传入；提示词文件 `/tmp/agy-prompt-1..5.prompt`）：

```sh
AGY_PROMPT="$(cat /tmp/agy-prompt-N.prompt)" zsh -lic 'agy --model gemini-4-hydrogen-high -p="$AGY_PROMPT"' 2>&1 | tee /tmp/agy-log-N.txt
```

| # | 主题 | 提示词 | 日志 | 结果 |
| --- | --- | --- | --- | --- |
| 0 | 调用链预热（短 prompt） | （内联） | `/tmp/agy-log-0-warmup.txt` | OK |
| 1 | 表面层级/文字阶/卡片/徽章/状态点 + 标题语义差 | `/tmp/agy-prompt-1.prompt` | `/tmp/agy-log-1.txt` | 9 条裁定全量返回 |
| 2 | 按钮三变体/compact/footer/输入框/focus 模式/危险文案 | `/tmp/agy-prompt-2.prompt` | `/tmp/agy-log-2.txt` | 10 条全量返回 |
| 3 | 弹层与下拉菜单（ModelSelect+Menu 原语+焦点态+内嵌定性） | `/tmp/agy-prompt-3.prompt` | `/tmp/agy-log-3.txt` | 前置定性 + 7 条全量返回 |
| 4 | 开关/分段控件/添加块/picker/大开关行/同域取舍 | `/tmp/agy-prompt-4.prompt` | `/tmp/agy-log-4.txt` | 7 条全量返回。首次与 #1-#3 并发时输出为空（疑似并发会话上限，非模型错误），按规程诊断后**重试一次**成功；该文件现为成功一次的内容。 |
| 5 | 图标钮/把手/拖拽视觉/焦点总则/隐藏文本/reduced-motion/容器/危险色收口 | `/tmp/agy-prompt-5.prompt` | `/tmp/agy-log-5.txt` | 8 条全量返回（首跑迟回，未重试） |

合计 agy 调用 7 次（1 预热 + 5 主题 + 1 次 call-4 空输出重试）。所有日志文件无凭据、无真实供应商请求。
