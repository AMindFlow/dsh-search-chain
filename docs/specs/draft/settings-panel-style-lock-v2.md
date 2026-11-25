# 设置面板风格锁定表 v2 修订草案（Issue #50 目检追加）

> **状态**：定稿 · lead 审阅通过（§7.1 lead 裁定表随文生效；O 项以其为准）。基线 = [settings-panel-style-lock.md](settings-panel-style-lock.md)（下称 v1，`SPC-001`–`SPC-030`，已随分支提交）。本文件只写修订面：未提及的 v1 条款一律原样生效。行为面修订（条目级保存）另立 [settings-ui-save-granularity-amendment.md](settings-ui-save-granularity-amendment.md)（SET-006–SET-008），本文件 R1 与其互引。
>
> **裁定方法**：4 个修订块各成一份自包含提示（用户诉求原文 + 官方源码逐字摘录 + token 实证值 + 我方现状逐字 + v1 钉死值），串行调用真实 agy CLI，模型 `gemini-4-hydrogen-high`（Gemini 4 Hydrogen (High)，`agy --list-models` 在档确认）。日志：`/tmp/agy-log-v2-1.txt` … `/tmp/agy-log-v2-4.txt`（各含完整【解读】【判定】【钉死值】输出）。本文件「裁定值」为其原样输出（类名沿用我方 `sc-*` 前缀；②的色值引用按其 alias 链规范为 `var(--dsw-alias-state-*)`，与 v1 token 表一致，未改数值）。
>
> **官方取证路径**：相对 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/`，同 v1 §1.1 表；本轮新读 `dsh-client-ui-settings-models/src/client/locales.ts`（文案键）与 `dsh-client-ui-settings-web-search/src/client/WebSearchCard.tsx`（同域保存粒度佐证）。token 实证自 `dsh-client-ui-theme/src/styles/design-platform.css` 逐行读取。

## 1. 修订块清单（编号映射）

| 修订块 | 用户诉求（#50 追加评论） | 修订的 v1 条款 | 废止面 | 判定主调 |
| --- | --- | --- | --- | --- |
| R1 保存粒度=条目级 | 删全局保存钮；编辑器内保存钮提交该条目（新增=创建、编辑=更新），对齐官方「模型」区；切分区不丢未保存信息 | SPC-016、SPC-014/015/022（映射）、SPC-004、SPC-030 | `.sc-save-button` 类与底部全局保存钮；「完成」文案；底部状态区 | 直接适用 + 类推延伸（草稿缓存、全局字段提交时机） |
| R2 状态徽标只留点 | 删点旁文案（已就绪/缺少凭据引用/已关闭），保可访问性 | SPC-010（仅文案面）、SPC-007（节奏确认） | 文案面 `13px/20px/400/label-secondary/nowrap` 与 gap 6 状态容器声明 | 直接适用（结构/文案组合）+ 类推（三态措辞、`data-role` 宿体迁移） |
| R3 拖拽把手左移+hover 显隐 | 把手移条目左侧、默认隐藏、行 hover 出现 | SPC-027（位置/显隐面）、SPC-007（DOM 骨架）、SPC-018（不变确认） | 「右端 `.sc-card-actions` 末位、全端常显」两条 | 类推延伸（官方把手=最左但常显，显隐机制无官方先例） |
| R4 picker 条目对比度+边框 | 暗色条目 vs 容器无对比；条目要"稍微有色差"+边框（l3/l4 档）；暗色 hover 更强 token，候选实值供拍板 | SPC-025（条目 chrome 与 hover） | `border: 0` 无边框条款；hover `interactive-bg-hover-solid` 单声明 | 类推延伸（官方 `0.5px l4` 描边规约）+ Lead 拍板制（hover 档位） |

**编号勘误**：lead 追加评论第③项写「v1 SPC-027/026 相关面」。经核对，v1 `SPC-026` 是下拉菜单浮层规范（预留不落地），与拖拽把手无关；把手相关的 v1 条款是 `SPC-027`（控件本体）与 `SPC-007`（行骨架/座位）。R3 按后者映射，`SPC-026` 不受本修订影响。

## 2. 修订块 R1 —— 保存粒度 = 条目级（agy 日志 `/tmp/agy-log-v2-1.txt`）

### 2.1 用户诉求原文

> 「保存粒度=条目级：删全局保存按钮；编辑器内保存钮提交该条目全部信息（新增即创建条目、编辑即更新），对齐官方『模型』区。」（追加：切分区不丢未保存信息。）

### 2.2 官方源码逐字（asar 实证）

`dsh-client-ui-settings-models/src/client/EditorFooter.tsx` 头注释：

> "The action row every provider card ends with: dismiss on the left, commit on the right. The two cards commit different things — one creates a route, one edits an existing profile — but the row itself carries no such knowledge. It renders what it is handed, so the cards keep sole ownership of when a commit is allowed and what the in-flight wording is. Cancel refuses input only while a commit is in flight, never because the card is disabled: a card the deployment cannot write to must still be dismissable."

`EditorFooter.tsx` JSX：`.editorActions` 内左 `secondaryButton`（`t(props.cancelLabelKey ?? 'cancel')`，`disabled={props.busy}`）、右 `primaryButton`（busy 时切 `submitBusyLabelKey`，`disabled={props.submitDisabled}`）。提交文案键：`CustomProviderCard` 传 `create`/`creating`；`ProviderEditor` 默认 `apply`。`locales.ts` zh 逐字：`apply: '保存'`、`applying: '保存中…'`、`create: '创建提供商'`、`creating: '创建中…'`、`cancel: '取消'`、`savedProvider: '已保存 {provider}。'`。模型区**不存在**任何面板级「保存全部」按钮。

**草稿生命周期实证（①核心结论）**：

1. 编辑器打开态与字段草稿全部是**组件局部 `useState`**：`ModelsSection.tsx` 的 `editing`/`addOpen`/`addMode`/`savedTarget`；`CustomProviderCard.tsx` 的 `route/displayName/baseURL/protocol/keyDraft/models` + `openedAt = revision` 快照；`ProviderEditor.tsx` 的 `draft`/`keyDraft` + `expectedRevision = namespace.revision`。
2. 持久 store（`ModelsSettingsStore`）只存**已保存**的 namespace 快照（`state.namespaces.get(…)` 取到的是最后已保存值）。注释逐字："A new or failed surface waits for a current snapshot; background refreshes preserve its drafts."
3. 官方对抗「区内丢草稿」只有两招：addMode 双面板保持挂载——`ModelsSection.tsx` 头注释 "A panel mounts the first time its mode is shown and stays mounted, hidden, while the card is open and its mode stays offered, so switching modes discards neither draft…"，`ModelsSection.module.css` "/* One panel per mode. Both stay mounted while the card is open; the hidden attribute must win over the panel's own display… */"；以及后台刷新保留草稿。
4. 编辑器 dismiss = `onClose` → 组件卸载 → 局部 state 销毁 = **未提交草稿丢弃**（`CustomProviderCard.tsx:335` `onCancel={() => { props.onClose(committed) }}`）。卡片编辑器为行内展开非 Modal，源码无 Escape 处理（本轮补证，覆盖裁定时的「未获取」标注）。
5. 推论：宿主 shell 切换设置分区若卸载 `ModelsSection`，官方草稿同样丢失。**shell 挂载策略本身：未获取**（见 §7 开放问题 O-1）。即：官方并无「切分区保草稿」承诺；用户该项诉求是超出官方基线的新增要求，允许最小类推机制。
6. 保存成功提示为节级：`ModelsSection.tsx` `{savedIdentity === undefined ? null : (<p className={styles['savedNotice']} role="status" aria-live="polite">{providerCopy(t('savedProvider'), savedIdentity)}</p>)}`，位置在 title/intro/notice 之后、列表之前。
7. 同域佐证：官方「网页搜索」区 `WebSearchCard.tsx` 用 `<SettingsForm … onSave={props.save} onDiscard={props.discard}>`（官方存在第二种「表单级」粒度；用户已拍板对齐模型区每卡粒度。`SettingsForm` 原语未随 asar 分发，其保存钮文案/视觉：未获取）。

### 2.3 裁定值（Hydrogen High，摘要转录；行为条款全文入 SET-006–SET-008）

- **R1-1a** 面板底部全局保存钮（`data-role="save"` / `.sc-save-button`）删除；面板不得再有跨条目批量保存入口。判定：直接适用。
- **R1-1b** 编辑器提交钮=该条目全量提交：新增=校验+凭据先写+带 `expectedRevision` 的 mutate，**成功后**才以 `enabled: true` 追加至持久列表末尾并关编辑器；编辑=按稳定 `entry.id` 合并该条目全部受管字段提交，载荷**不得夹带**其他条目或全局字段的未保存草稿；失败/冲突不关编辑器、不丢输入。busy 期间提交钮 `disabled`+进行中文案，输入与取消钮禁用。判定：直接适用+类推（锚 SET-004/CFG-004 修订链路）。
- **R1-1c** 废止「完成」，编辑器动作行=左「取消」（dismiss）右提交主按钮；取消**不得**写配置，须清该条目字段草稿与明文 key 缓冲、关编辑器、焦点归还触发控件；取消钮 `disabled` 当且仅当 `busy`（只读/缺 revision/报错时必须可点）。判定：直接适用。
- **R1-1d** 全局字段与离散操作独立即时提交：顶部开关 `onChange` 立即发仅含 `useOfficialDeepSeekSearch` 的独立 mutate；超时输入框失焦/Enter 且校验通过才发仅含 `timeoutMs` 的 mutate（不得逐键写入）；卡片启用开关、确认移除、拖拽/键盘排序各自触发后立即独立 mutate。判定：未获取（官方无同形先例、SettingsForm 未分发）+类推延伸（锚：模型区控件自治原则 + SET-004）。
- **R1-1e** 反馈位置：成功提示迁节级顶部槽位（h3/说明/`.sc-notice` 之后、列表之前，`role="status" aria-live="polite"`，文案 `已保存 ${name}。`；全局字段/离散动作用 `已保存设置。`）；面板底部状态区撤除；编辑器内错误就近渲染于 `.sc-editor-actions` 上方（`role="alert"`）；节级非编辑器错误占顶部槽位（`role="alert"`，与成功互斥）。判定：成功位=直接适用；错误位=未获取+类推。
- **R1-2** 切分区草稿保全：`SettingsPanel` 组件外模块级内存草稿缓存；键=`entryId`（未提交新增分配稳定临时 id）+`__global__`（超时必入；开关仅失败/pending 期驻留）；记录 `mode`、字段快照、内存态明文 key 缓冲、起草时 `baseRevision`；**不得**写持久配置或 localStorage/sessionStorage。写入=字段 onChange 同步；清除=仅提交成功或显式取消；分区卸载与后台刷新**不得**清除、不得用快照静默覆盖缓存。重挂载后逐条比对：`baseRevision` 一致→回填；冲突/原条目已被外部删除→不得静默丢弃或静默换版本重放，必须 `role="alert"` 冲突告警，仅允许显式「取消」放弃或确认后重提。判定：类推延伸（锚 "background refreshes preserve its drafts" + `expectedRevision` 语义，延伸至卸载-重挂载）。
- **R1-3 样式钉死**：
  - `.sc-save-button` 类名整体废止（样式表与 DOM 均不得残留）；主按钮视觉收归 v1 SPC-014，右对齐由 SPC-022 `.sc-editor-actions` 承担：`display: flex; justify-content: flex-end; gap: 8px;`。
  - 编辑器两钮均 **SPC-014 standard 档**（36px），必须移除 `-small`（SPC-015 compact）修饰。文案：取消=`取消`；编辑提交=`保存`/进行中 `保存中…`（逐字取官方 `apply`/`applying` zh）；新建提交=`创建工具`/进行中 `创建中…`（官方 `create:'创建提供商'` 的域适配，类推延伸，避免「提供商」术语割裂）。
  - 状态节点拆分：节级成功提示启用 v1 SPC-004 预留位 `.sc-saved-notice { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-success-primary); }`（`data-role="save-status" data-state="saved" role="status" aria-live="polite"`）；SPC-030 的 `.sc-status-node` 撤离底部，改用于编辑器内（`data-role="save-error" data-state="error" role="alert"`）与节级非成功态，`12px/18px` 与三态色沿用 v1 原值（`label-secondary`/`state-success-primary`/`state-error-primary`），间距继承父容器，不发明未获取的外边距/底色。

### 2.4 废止条款（v1 映射）

| v1 条款 | 处置 |
| --- | --- |
| SPC-016 保存/完成主按钮（全局 `.sc-save-button` + `align-self: flex-end`） | **全条废止**。主按钮基底样式由 SPC-014 承接；底部对齐职责由 SPC-022 承接 |
| SPC-015 行内 compact 档 | 不废止（卡片行内动作仍用）；但**禁止**用于编辑器动作行（R1-3 显式禁 `-small`） |
| SPC-022 `.sc-editor-actions` | 保留；语义升级为「左取消右提交」容器（对齐官方 EditorFooter） |
| SPC-004 提示与已保存文案（预留位） | **启用**：由预留转正式，承载节级保存成功提示（R1-3 值） |
| SPC-030 保存状态节点 | 修订：撤离面板底部，拆分为节级 `.sc-saved-notice`（成功）+ 节级/编辑器内 `.sc-status-node`（错误/进行中）；数值不变 |
| SPC-014 按钮三变体 | 不变；条目编辑器提交/取消钮归 standard 档 |

### 2.5 未获取 / 类推标注

- 未获取：宿主 shell 切分区是否卸载分区组件；官方卡内/节级错误横幅样式（外边距/底色）；`SettingsForm` 原语包源码及其保存钮视觉。（官方 Escape 行为原标注未获取，本轮已补证：卡片编辑器无 Escape 语义，见 §2.2-4。）
- 类推延伸：R1-1d 全部（全局字段/离散操作即时提交）；R1-2 草稿缓存全案；`创建工具`/`创建中…` 文案；R1-1e 错误位。

### 2.6 开放问题

见 §7 O-1 ~ O-6（O-1~O-4 即 R1 之开放问题；O-5 编辑器 Escape 语义对齐；O-6 「有未保存草稿」指示形态）。

## 3. 修订块 R2 —— 状态徽标只留点（agy 日志 `/tmp/agy-log-v2-2.txt`）

### 3.1 用户诉求原文

> 「状态徽标只留点：删点旁文案（已就绪/缺少凭据引用/已关闭），保留可访问性（我们 aria-label 保留，视觉零文案）。」

### 3.2 官方源码逐字（asar 实证）

`dsh-client-ui-settings-models/src/client/ModelsSection.tsx`（rowIdentity 内，点旁无可见文案）：

```tsx
<span className={`${styles['credentialDot']} ${styles['credentialDotConfigured']}`}
  role="img" aria-label={t('credentialConfigured')} title={t('credentialConfigured')} />
<span className={`${styles['credentialDot']} ${styles['credentialDotMissing']}`}
  role="img" aria-label={t('credentialMissing')} title={t('credentialMissing')} />
```

zh 文案逐字：`credentialConfigured: 'API 密钥已配置'`、`credentialMissing: 'API 密钥缺失'`。对照特例（点旁**有**文案时才装饰化）：`<span className={styles['accountStatus']}><span className={credentialDot+Configured} aria-hidden="true" />{t('accountSignedIn')}</span>`。官方行内状态点**无 `aria-live`**（全节 live region 仅 `savedNotice` 一处）。CSS 几何同 v1 SPC-010（8px、`corner-shape: round`、三态 token 色）。

### 3.3 裁定值

- **R2-1 结构钉死**（`data-role`/`data-entry-id`/`data-state` 收口到点元素本身，外层 `.sc-status` wrapper 与文案 `<span>` 移除）：

```js
const statusLabel = entryStatusText(entry); // "已就绪" | "缺少凭据引用" | "已关闭"
React.createElement("span", {
  className: "sc-status-dot",
  "data-role": "card-status",
  "data-entry-id": entry.id,
  "data-state": entryStatusState(entry),
  role: "img",
  "aria-label": statusLabel,
  title: statusLabel,
})
```

  三态文案沿用我方既有完整短语（不收缩为官方「API 密钥…」措辞——避免「凭据引用」概念失真，且官方无「已关闭」对应词）：`已就绪` / `缺少凭据引用` / `已关闭`。**移除 `aria-live="polite"`**：逐卡 live 会在批量渲染/排序/开关操作时读屏插播噪音（开关自身已播报 `aria-checked`），官方亦仅 savedNotice 一处 live——浏览时 `role="img"`+label 仍可完整读出状态。判定：直接适用（结构/属性组合）+ 类推（三态措辞、`data-role` 宿体迁移）。
- **R2-2 视觉**：`.sc-status` 选择器及全部声明废止（`inline-flex`/`gap:6px`/`13px/20px/400`/`label-secondary`/`nowrap`）；点几何与三态色保留 v1 原值（`flex: none` 移入 `.sc-status-dot` 自身持有）：

```css
.sc-status-dot {
  box-sizing: border-box;
  display: inline-block;
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  corner-shape: round;
}
.sc-status-dot[data-state="ready"]    { background-color: var(--dsw-alias-state-success-primary); }
.sc-status-dot[data-state="missing"]  { background-color: var(--dsw-alias-state-error-primary); }
.sc-status-dot[data-state="disabled"] { background-color: var(--dsw-alias-state-idle-primary); }
```

  （`data-state` 枚举以 `entryStatusState()` 现有返回值为准，不得改枚举名。）点/名称/徽章节奏**零新增声明**，完全交回 v1 SPC-007 `.sc-card-info { gap: 6px }`。残留风险（裁定载明）：`.sc-card-info` 必须保持 `align-items: center`（否则断点折行时 8px 点偏心）；`flex: none` 不得删（防压扁）；依赖 `card-status` 的 `textContent` 的测试须改查 `data-state`/`aria-label`，不得回退插隐藏文本。
- **R2-3 tooltip**：`title` 逐字=同 `aria-label` 返回值（官方 A1 同键双绑实证）；不写解释性长句、不引自定义 Tooltip 包裹层。官方 `title` 与 `Tooltip` 组件的分工细则：未获取。

### 3.4 废止条款（v1 映射）

| v1 条款 | 处置 |
| --- | --- |
| SPC-010 状态文案面（`13px/20px/font-weight 400`、`label-secondary`、状态容器 `gap 6px`、`nowrap`） | **废止** |
| SPC-010 点几何与三态色 | 保留原值；`flex: none` 由 wrapper 移至点自身 |
| SPC-007 rowIdentity 节奏 | 保留（点回归 info 组 flex 节奏） |

### 3.5 未获取 / 类推标注

- 未获取：官方原生 `title` 与 `Tooltip` 组件的设计系统分工细则、悬停延迟规范。
- 类推延伸：三态措辞沿用我方域内完整短语；`data-role="card-status"` 从 wrapper 迁移至点元素（视觉去文案授权范围内保住 DOM 定位契约）。

### 3.6 开放问题

见 §7 O-7（读屏静默变更播报缺失是否为验收明文项）、O-8（既有用例 `textContent` 断言的迁移清单归实施方）。

## 4. 修订块 R3 —— 拖拽把手：左侧 + hover 显隐（agy 日志 `/tmp/agy-log-v2-3.txt`）

### 4.1 用户诉求原文

> 「拖拽把手：移条目左侧、默认隐藏、行 hover 才出现。」

### 4.2 官方源码逐字（asar 实证）

`.modelEntry`：`container: model-row / inline-size; position: relative; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-lg); padding: 6px;`；`.modelRow { display: grid; grid-template-columns: auto minmax(0, 1.4fr) minmax(0, 1fr) auto auto; align-items: center; gap: 6px; }`（收窄档 `auto minmax(0, 1fr) auto auto`）。把手是 `.modelRow` 的**第一个子节点**（`Tooltip` 包裹的 `iconButton modelDragHandle`，`aria-label={`${t('reorderModel')} ${position}`}`、`aria-keyshortcuts="ArrowUp ArrowDown"`、`aria-description`、`draggable={!disabled}`，图标 14px），落首列 `auto`=视觉最左。显隐规则实证（负例）：全文件把手相关 CSS 仅 `.modelDragHandle:not(:disabled) { cursor: grab; }`——**官方把手常显，无行 hover 显隐先例**。官方全文件唯一过渡先例 `.thumb { transition: transform .12s ease; }`；降级组 `@media (prefers-reduced-motion: reduce) { .customizedSummary::before, .switchThumb { transition: none; } }`。

### 4.3 裁定值

- **R3-1 DOM 位置**：把手移为 `.sc-card-info` **第一个子节点**（名称前），行为契约属性原样保留并补 `type: "button"`；`gap` 由 `.sc-card-info { gap: 6px }` 既有值承担（与官方 `.modelRow gap 6px` 同值复用）；布局补丁：

```css
.sc-card-info { display: inline-flex; align-items: center; gap: 6px; }
.sc-drag-handle { flex-shrink: 0; } /* 对齐官方首列 auto，防长名挤压 28×28 */
```

  `.sc-card-info` 不得设 `overflow: hidden`（裁 2px 焦点环）；截断只作用于名称子节点。判定：类推延伸（Grid 首列 → Flex 首子节点映射）。
- **R3-2 显隐机制**（关键四项裁定）：
  1. 机制=纯 `opacity: 0 → 1`，**严禁** `visibility: hidden`/`display: none`（会把按钮移出 Tab 序与无障碍树，键盘 ArrowUp/ArrowDown 排序链路报废）；`opacity: 0` 保留 28×28 占位（hover 时零水平跳动）与完整可达性。
  2. 键盘：`.sc-drag-handle:focus-visible` 强制 `opacity: 1`，SPC-018 焦点环保留原值。
  3. 触摸/无 hover 指针：**常显**——「默认隐藏」严格包进 `@media (hover: hover)`，基线层常显（对未知指针环境安全降级为可见）。
  4. 过渡=`opacity .12s ease`（官方唯一 `.12s ease` 先例类推，不造 150/200ms 野值），并入 reduced-motion 组。
  5. 空 hit 区：**不加** `pointer-events: none` 防御——把手居独立 28×28 槽位无遮挡；二合一触屏（匹配 `hover:hover` 但直接触控）加 `none` 会击穿失效；把手无 `onClick`，瞬时命中仅聚焦显形，无破坏性副作用。

```css
/* 基线（含 @media (hover: none) 端）：常显，对齐官方常显基线 */
.sc-drag-handle { flex-shrink: 0; opacity: 1; transition: opacity .12s ease; }
.sc-drag-handle:disabled { opacity: 0.4; cursor: default; }

/* 仅真实 hover 指针启用「默认隐藏、行 hover 显现」 */
@media (hover: hover) {
  .sc-drag-handle,
  .sc-drag-handle:disabled { opacity: 0; }
  .sc-card:hover .sc-drag-handle,
  .sc-drag-handle:focus-visible { opacity: 1; }
  .sc-card:hover .sc-drag-handle:disabled { opacity: 0.4; }
}

/* 并入减弱动画降级组：裁定原文引用官方组（.customizedSummary::before, .switchThumb）；
   我方文件中并入 v1 SPC-029 已钉的同语义组并追加把手 */
@media (prefers-reduced-motion: reduce) {
  .sc-switch-track, .sc-switch-track::after, .sc-drag-handle { transition: none; }
}
```

  注：把手 `:hover` 底色/前景仍由 v1 `@media (hover: hover)` 既定规则承担；拖拽中（`data-dragging` 组）透明度规则的选择器优先级须高于上述 `.sc-card:hover` 规则，防拖拽中移出卡片致闪。
- **R3-3 v1 映射表**：

| v1 条款 | 保留 | 作废/替换 |
| --- | --- | --- |
| SPC-027 拖拽视觉全组 | 28×28、⠿14px、`grab`/`grabbing`、dragging 0.5、插入指示线 gradient、预览底色 | 位置（右端 actions 末位）与全端常显 → 左侧首位 + `hover:hover` 下静息隐藏（如上） |
| SPC-007 行骨架 | 三容器几何与 gap | `actions[开关,编辑,移除,把手]` 骨架 → `info[把手,名称,徽章,状态点] + actions[开关,编辑,移除]` |
| SPC-018 焦点表 | 把手 box-shadow 2px 焦点环组全值不变 | 无；补 `:focus-visible → opacity: 1` 保障 |

  行为契约不变确认：`draggable`、`onDragStart`、`onDragEnd`、`onKeyDown`、`data-role="drag-handle"`、`data-entry-id`、`disabled`、`aria-label`、`title` 及排序逻辑零变更。

### 4.4 废止条款（v1 映射）

见 R3-3 表。另：lead 评论中「SPC-026」为编号笔误（SPC-026=菜单浮层预留位），本修订不涉及 SPC-026。

### 4.5 未获取 / 类推标注

- 未获取：官方无行 hover 显隐先例（负例实证，非缺证）；「行 hover 显隐」类交互的官方设计系统规范文档。
- 类推延伸：显隐机制全案（锚：官方常显基线 + `.12s ease` 唯一过渡先例 + `iconButton` disabled 0.4 + SPC-018 焦点环）；`(hover: none)` 端常显保守降级。

### 4.6 开放问题

见 §7 O-9（触摸屏常显后 28×28 目标与点卡拖拽手势并存的实际可发现性，需实机验证）、O-10（`Tooltip` 组件缺失下 `title` 长文案是否需缩短）。

## 5. 修订块 R4 —— picker 条目对比度与边框（agy 日志 `/tmp/agy-log-v2-4.txt`）

### 5.1 用户诉求原文（暗色截图反馈）

> 「暗色下 bg-layer-1 rgb(35,35,36) 条目 vs module-platform 容器无对比（条目只见微弱更暗一档、无边界；hover 仍难分辨）。条目要"稍微有色差"+边框（候选 border-l3/l4 档）；暗色 hover 换更强对比 token（列候选实值供拍板，给推荐+理由）。」

**读数勘误（token 实证）**：截图把容器读作 rgb(44,44,46)（压缩失真）。`design-platform.css` 逐行：`--dsw-alias-bg-module-platform` 暗=`var(--dsw-static-neutral-bluish-800)`=**rgb(53,54,56)**、亮=bluish-60=rgb(249,250,251)；rgb(44,44,46) 是 bluish-850（bg-layer-2 暗值）。v1 token 表本就登记正确，本节以 token 为准展开：暗容器 53,54,56 vs 条目 35,35,36，Δ≈18 且 v1 条目 `border: 0` 无边界=截图所见；且 v1 hover 钉的 `interactive-bg-hover-solid` 暗值=bluish-800=**与容器同值**——暗色 hover 精确融入容器，这才是"hover 无对比"的根因。

### 5.2 官方源码逐字（asar 实证）

- 模块面之上行的描边规约：`.modelEntry { … border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-lg); padding: 6px; }`（底色不声明=transparent，分层交给描边）；`.rowCard`（注释 "Provider cards share the settings material…"）用 `settings-card-stroke`——`theme-base.css` 实证解析=`var(--dsw-alias-border-l4)`。**DSH 设置体系 0.5px 实线描边统一落 l4 档**；l3 仅见于 `.modelEmpty` 的 `1px dashed` 空态框。
- Menu 选项 hover（编译原语）：`.item:hover { background: var(--dsw-alias-interactive-bg-hover); }`。
- token 实值（暗/亮）：layer-1 35,35,36/白；layer-3 53,54,56/白（暗=与容器同值）；border-l3 rgba(255,255,255,.16)/rgba(0,0,0,.12)；border-l4 rgba(255,255,255,.2)/rgba(0,0,0,.16)；interactive-bg-hover .08/.06(38,49,72)；-active .14/.10；-hover-accent .24/.14；-hover-solid rgb(53,54,56)/rgb(241,243,245)。

### 5.3 裁定值

- **R4-1 条目 chrome**：维持 `bg-layer-1` 实底（叶节点小卡要「稍微有色差」，transparent 会使基态色差归零）+ 新增 `0.5px solid var(--dsw-alias-border-l4)` 描边（官方实线描边统一档）。双主题验算：暗=条目 35 沉于容器 53（Δ≈-19）+ 亮边 l4 拉出 Δ≈+40；亮=白浮于 249,250,251（Δ≈+5）+ 细框拉出 Δ≈-40。同一套声明双主题成立。判定：类推延伸。

```css
.sc-picker-item {
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  padding: 14px 16px;
  gap: 4px;
}
```

- **R4-2 hover（推荐 + 候选表，Lead 拍板制）**。破局机制：官方 `.item:hover` 是**单声明覆写**——半透明 token 直接落在 `bg-module-platform` 上合成，而非在 bg-layer-1 上叠加：

```css
/* ★ 推荐 A 档：单声明覆写，与官方 Menu 语义逐字同构 */
@media (hover: hover) {
  .sc-picker-item:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
```

  候选表（暗基态 35,35,36/容器 53,54,56；亮基态 白/容器 249,250,251；合成为估算实值）：

| 档 | 实现 | 暗色合成（Δ基态/Δ容器） | 亮色合成 | 裁定建议 |
| --- | --- | --- | --- | --- |
| A `-hover` 单声明覆写 | `background: …interactive-bg-hover` | rgb(69,70,72)（+35/+16，清晰浮起） | rgb(236,238,240)（-18/-12） | **★ 推荐**：语义纯、双主题均衡、无叠加 hack、`-active` 语义不被占用 |
| B `-active` 单声明覆写 | 同上换 `-active` | rgb(81,82,84)（+47/+28） | rgb(228,230,233)（-26/-20） | 可选：嫌 +16 不够强时 |
| C `-hover-accent` 单声明覆写 | 同上换 `-hover-accent` | rgb(101,102,104)（+67/+48，极强） | rgb(219,222,226)（-33/-28） | 过重，不建议常规 hover |
| D layer-1+`-hover` 叠加 | `linear-gradient` 双层 | rgb(53,53,54)（**与容器糊**） | rgb(242,243,244) | 淘汰 |
| E layer-1+`-active` 叠加 | 同上 `-active` | rgb(66,66,67)（+13） | rgb(233,234,237) | 次选（须保留基底时用，声明见日志） |
| F layer-1+`-hover-accent` 叠加 | 同上 `-hover-accent` | rgb(88,88,89)（+35） | rgb(225,226,229) | 次选（要求极高对比时） |
| G `-hover-solid`（v1 原值） | 单声明覆写 | rgb(53,54,56)（**精确同容器**） | rgb(241,243,245) | 作废（暗色失效根因） |
| H 纯描边提亮 | `border-color` 升档 | 无高于 l4 的 neutral token；`state-business-primary` 与焦点环冲突 | 同左 | 否决 |

  选 B/C 只换 token 名；选 E/F 用 `background-color: var(--dsw-alias-bg-layer-1); background-image: linear-gradient(<token>, <token>);` 双层声明（全文见日志）。reduced-motion 无涉（无过渡）。
- **R4-3 不变面确认**：`.sc-picker` 容器（radius-lg、bg-module-platform、14/16、gap 8）不变；`.sc-picker-item` 几何（radius-md、14/16、gap 4）不变；焦点环、disabled 面不变；因保留实底，v1「白卡→灰模块→白控件」三层叙述亮色成立，暗色对应「深卡→中灰模块(53,54,56)→微沉控件(35,35,36+0.5px l4 亮框)」。

### 5.4 废止条款（v1 映射）

| v1 条款（SPC-025 内） | 处置 |
| --- | --- |
| `.sc-picker-item { border: 0; background: var(--dsw-alias-bg-layer-1); }` | **废止** → `border: 0.5px solid var(--dsw-alias-border-l4)` + 底色保留 |
| `@media (hover: hover) { .sc-picker-item:hover { background: var(--dsw-alias-interactive-bg-hover-solid); } }` | **废止**（暗色与容器同值失效）→ R4-2 拍板档填入（推荐 A 档 `-hover` 单声明覆写） |
| SPC-025 其余（容器、几何、标题 14/22/600、billing 12/18 tertiary） | 不变 |

### 5.5 未获取 / 类推标注

- 未获取：高于 `border-l4` 的中性边框 token（H 档否决依据）；截图读数与 token 差异无第三方校验（以逐行 token 实证为准）。
- 类推延伸：描边档（锚 `.modelEntry`/`.rowCard` 统一 l4 规约）；hover 单声明覆写式（锚编译 Menu `.item:hover` 逐字）。
- **Lead 拍板点**：R4-2 hover 档位（默认推荐 A）。

### 5.6 开放问题

见 §7 O-11（hover 档位拍板）、O-12（`-hover` 覆写后条目文字对比度抽样复核——A 档暗色 69,70,72 上 label-primary 属常规组合，实机目检为准）。

## 6. 废止·替换·确认总表

| v1 条款 | v2 处置 | 出处 |
| --- | --- | --- |
| SPC-004 | **启用**（预留→正式节级保存提示位） | R1 |
| SPC-007 | 修订：骨架 `info[把手,名称,徽章,状态点]`；其余不变 | R2/R3 |
| SPC-010 | 文案面**废止**；点面保留（`flex:none` 归点自身）；a11y 组合钉死 role=img+aria-label+title，移除 aria-live | R2 |
| SPC-014 | 不变（编辑器双钮归 standard 档） | R1 |
| SPC-015 | 不变；禁用于编辑器动作行 | R1 |
| SPC-016 | **全条废止**（`.sc-save-button` 类与全局保存钮消亡） | R1 |
| SPC-018 | 不变（把手补 `:focus-visible → opacity:1` 保障） | R3 |
| SPC-022 | 保留，升级为左取消右提交容器 | R1 |
| SPC-025 | 条目 `border:0` 与 hover `-solid` 两行**废止替换**；其余不变 | R4 |
| SPC-026 | 不涉及（编号勘误见 §1） | — |
| SPC-027 | 几何/拖拽态/指示线/预览不变；位置+显隐面**替换** | R3 |
| SPC-029 | 保留；把手 `transition` 并入其降级组 | R3 |
| SPC-030 | 修订：撤离底部，拆分节级成功（SPC-004 值）+节级/编辑器内错误；数值不变 | R1 |
| SPC-001–003、005–006、008–009、011–013、017、019–021、023–024、028 | 不受本轮修订影响，原样生效 | — |

## 7. 开放问题表（供 lead 定夺）

| 编号 | 问题 | 背景出处 |
| --- | --- | --- |
| O-1 | 宿主设置 shell 切分区是否卸载分区组件（决定草稿缓存是否会被官方 shell 行为架空/多余） | R1-2；实证方向：`dsh-client-ui-settings-shell` 编译产物或实机插桩 |
| O-2 | 缓存寿命：离开整个设置视图再回来是否仍保留草稿，还是仅设置页内切分区期间保留 | R1-2 |
| O-3 | 进程/页面重启是否保留草稿（明文 key 恒不得落盘，仅非密字段可选持久化） | R1-2 |
| O-4 | 多设置窗口并存时的缓存作用域与跨窗失效通知 | R1-2 |
| O-5 | 我方编辑器 Escape 语义：现状 `Escape → closeEditor`；v2 取消钮=清草稿，Escape 应等价「取消」还是保持「静默关闭保草稿」 | R1-1c + 补证（官方卡片编辑器无 Escape 语义，Escape 保草稿反而无锚） |
| O-6 | 重挂载后的 UI 呈现：自动重开展开编辑器，还是收起编辑器 + 卡片上「有未保存草稿，点击继续编辑」指示 | R1-2 |
| O-7 | 读屏静默变更不再播（移除 card-status 的 aria-live）是否列为验收明文项 | R2-1 |
| O-8 | 依赖 `[data-role="card-status"]` textContent 的既有断言迁移清单（改查 data-state/aria-label） | R2-2 残留风险 |
| O-9 | 触摸端把手常显 + 整卡拖拽手势并存的可发现性/误触，需实机验证 | R3-2 |
| O-10 | 把手 `title` 长文案（"拖动排序；也可按方向键调整位置"）在无 Tooltip 组件下是否缩短 | R2-3/R3 官方对照 |
| O-11 | **picker hover 档位拍板**：A（推荐）/B/C/E/F（实值见 §5.3 候选表） | R4-2 |
| O-12 | hover 覆写后条目文字对比实机抽样 | R4-2 |
| O-13 | 官方错误横幅样式（节级/卡内）未获取：当前按 v1 已钉 token（12/18 + state 色）落地，官方原语分发后回补 | R1-1e |

### 7.1 Lead 裁定（2026-11-25，随本文件定稿生效）

| 编号 | 裁定 |
| --- | --- |
| O-1 | 维持 SET-008 缓存：shell 若保持挂载则缓存冗余无害；若卸载则缓存兜底。登记风险，不阻塞。 |
| O-2 | 缓存寿命=**进程存活期**。离开/重进设置视图不清除（与「切分区不丢」同一机制，零额外成本）。 |
| O-3 | **不跨进程/页面重载持久**。明文 key 永不落盘 ⇒ 一切字段一律内存，无部分持久化例外。 |
| O-4 | 每窗口渲染进程内存单例即天然作用域；跨窗并发由 `expectedRevision` 版本锁互斥（冲突必告警）。不新增机制。 |
| O-5 | **Escape 等价「取消」**（清该条目草稿+关编辑器+焦点归还）。dismiss 语义统一，消除「关编辑器」双路径草稿语义分叉；官方无 Escape 锚，本条随 SET-006 行为修订。 |
| O-6 | **自动回填并重新展开编辑器**（含新建草稿重开 add 面板）；版本冲突按 SET-008 告警、不自动重放。用户痛点=回来接着写，指示态多余一步。 |
| O-7 | 不作验收明文项；Oracle 记 gap 即可。 |
| O-8 | 实施方迁移：允许**仅限**本 v2/SET-006..008 有意变更的行为面（全局保存钮、状态文案、把手位置/显隐、Escape）更新 `test/` 断言；其余测试保持冻结，逐条列入交付报告。 |
| O-9 | 触摸可发现性=实机验证 gap，登记不阻塞（`hover:none` 端常显已兜底）。 |
| O-10 | 把手 title 保持现文案，不缩短（无 Tooltip 层，title 即唯一悬浮说明）。 |
| O-11 | **A 档**（`interactive-bg-hover` 单声明覆写；HH 推荐；与官方 Menu `.item:hover` 逐字同构；暗 +16/容器 叠 0.5px l4 边框基态已分界）。用户目检仍嫌弱再升 B，换 token 名即可。 |
| O-12 | Oracle A-045 族采样 hover 合成值入 measured + 用户演示窗口目检双轨。 |
| O-13 | 按 v1 token 落地（12/18 + state 色），官方 `SettingsForm`/错误横幅原语分发后回补修订。 |

## 8. 诚实声明

- 本修订块全部钉死值出自真实 Hydrogen High 调用：`AGY_PROMPT="$(cat /tmp/agy-prompt-v2-N.prompt)" zsh -lic 'agy --model gemini-4-hydrogen-high -p="$AGY_PROMPT"'`（N=1..4，串行，无并发超限），模型行在档：`gemini-4-hydrogen-high ⇥ Gemini 4 Hydrogen (High)`；完整原始输出在 `/tmp/agy-log-v2-1.txt`…`/tmp/agy-log-v2-4.txt`。
- 官方摘录均为 asar 逐字读取（`ELECTRON_RUN_AS_NODE=1` 通道），未转述；「未获取」共 8 处，均标注补证方向；类推均注明锚点。
- 本文件不落地代码；实施以本表 + SET-006–SET-008 为准。文件中无任何凭据、密钥或配置实值。
