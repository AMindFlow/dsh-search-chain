# bundle 页配置入口（v0.1 配置 UI）

本规格定义插件在 DSH 内置「设置 → 插件」bundle 详情页上的配置表单：注册面、表单范围、组件自管读写通道（`host.call` → 本包宿主半 `config.get` / `config.put`）、合并写语义与凭据边界，以及实机 DOM 验收（`scripts/verify-ui-46.mjs`）。设置区指示器与数据面板行为仍归 [settings-ui.md](settings-ui.md)（SET 编号保留）；配置规范化、写入通道与凭据解析仍归 [config-network.md](config-network.md)（CFG 编号保留），本规格只定义其上的 UI 契约。

## 契约（宿主实测事实，DSH 0.2.2-rc.5，2026-11-25 本会话取信）

- **[C1] slot**：`plugins.bundle.config`，keyed，key = bundle **包名**（官方已占 key 全部是包名，如 `@deepseek-ai/dsh-cua-bundle`）；渲染在 bundle 页描述与其 rows 之间，`view: 'page'` 时渲染表单与保存控件。宿主页面证据（app.asar `ui-plugin-manager` 内联源码原文）：`configured ? <section data-plugin-config>{renderSlot('plugins.bundle.config', {view:'page'}, {entryKey: pkg.name})}</section> : null` —— **bundle 级渲染不传 `form`**；`form?: ConfigPageForm` 只在类型面存在（宿主拥有的配置值与写操作句柄，**方法名面未实证**，且 `configured` 以 slot 已占 key 为条件）。
- **[C2] 官方注册活样本**：`ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: '<包名>', locale: NS, inject: () => state }, Component))`。
- **[C3] client builtin**：`ctx` / React（无 JSX）/ `host.call`（包私有 → 本包宿主半 RPC）/ `styles` / `console`。
- **[C4] 用户实测**：bundle 页当前只有启用开关（我们未注册任何 config key）；`settings.describe` / `settings.mutate` 宿主 RPC 面无恙（#43 修复后）。
- **[C5] bundle 页 DOM 锚点**（宿主源码实证，验收脚本只依赖这些）：安装页包卡片 `li[data-plugin-package="<包名>"]`（卡内第一个 `button` 打开详情）；详情页 `div[data-plugin-detail="<包名>"]`（其第一个 `button` 为返回面包屑）；配置区容器 `section[data-plugin-config]`。
- **[C6] 导航**：插件页是 store 驱动的视图（`setView({kind:'package',name})`），**无 URL 路由**（app.asar 全文未见面板级 pushState/hash 路由）；从入口抵达 bundle 页须经 DOM 点击（侧栏面板按钮 → 卡片 → 详情）。侧栏面板按钮无稳定 data 属性（仅本地化 `aria-label`），脚本按「逐个点击直到 `[data-plugin-panel]` 在场」定位，locale 无关。
- **[C7] 桌面线**：Desktop 主进程以 `--expose-internals <dsh-desktop-host/lib/index.js> <runtimeDir> <profileDir> …` 拉起子进程，`<profileDir>` = `$DSH_HOME/profiles/desktop`（本机运行实例 ps 原文实证）。`DSH_HOME` 指隔离目录后子进程 argv 含隔离 profile 路径，脚本以此自证「未触正式 profile」。

## BCF-001 bundle 页配置注册

- **要求** client 产物（`src/client-entry.js` 的 `__ModuleLoader__.load` factory）在 `apply(ctx)` 时必须经 `ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(registration, Component))` 追加注册，registration 必须含 `name: 'plugins.bundle.config'` 与 `key: 'dsh-search-chain'`（**包名**，不是行 id `search-chain`），附加键仅限 `{id, order, label, locale, inject}`（keyed 槽无顺序语义），Component 为第二参组件工厂；既有 `settings.section` 注册不得受扰。幂等：同一 `ctx.slots` 重复 `apply` 每槽恰一次 inject，宿主挂载后每槽恰一次 register。`inject` 产物仍恰为 `["slots"]`（`host` 按 [C3] 为 client builtin、经 `ctx.host` 取用；若实机证伪须声明，见设计决定「注入面」）。
- **来源** [Issue #46](https://github.com/AMindFlow/dsh-search-chain/issues/46)；[C1][C2]。
- **验收** node 下 fake `__ModuleLoader__` 装载 → `factory(fakeRequire).apply(live 形状 ctx)`：`inject('plugins.bundle.config', …)` 恰 1 次；执行其懒工厂 → `slots.register` 收到 `{name,key}`，key 恰 `dsh-search-chain`，第二参为函数；重复 apply 计数不涨。`test/client-bundle-config.test.js` 第 1 组。

## BCF-002 表单范围与 form 缺省安全

- **要求** 组件在 `view:'page'`（宿主唯一渲染的 view，[C1]）必须渲染三范围控件且 **不依赖 `form` prop**（不传、传 undefined、传任意宿主对象均必须正常渲染，读写走 BCF-003/004）：① entries 增删改——每行条目含类型选择（[CAT-001 八类型](providers.md#cat-001-首期类型)，含 Bing）、启用开关、名称文本、`credentialRef` 文本；id 只读或由表单生成（新条目生成后作为行标识）；数组顺序即优先级。② `useOfficialDeepSeekSearch` 开关。③ `timeoutMs` 数值。必须提供保存入口与可读的保存状态。**apiKey 输入不得出现**（任何 `apikey` 大小写变体的输入或标签）。`view:'summary'` 必须渲染轻量指示（不得抛，不得含表单输入控件）。组件必须挂载时经 `host.call` 调 `config.get` 填充草稿；`ctx.host` 缺席时挂载与渲染不得抛（降级为可提示不可用）。DOM 契约（验收与 [BCF-007](#bcf-007-实机-dom-验收) 脚本共同钉合）：根 `[data-bundle-config]`；字段 `[data-config-field="timeoutMs" | "useOfficialDeepSeekSearch" | "entry-name" | "entry-type" | "entry-credentialRef"]`；条目行 `[data-config-entry="<id>"]`；动作 `[data-config-action="add-entry" | "remove-entry" | "save"]`；保存状态 `[data-config-status="saved"|"error"]`，失败时 `[data-config-error]` 含可操作文案。
- **来源** [Issue #46](https://github.com/AMindFlow/dsh-search-chain/issues/46) 验收 1/4；[C1]。
- **验收** fake hook-React（[C3] 的 react 通道）渲染：`{view:'page'}` 与 `{view:'page', form: undefined}` 均不抛且节点树含三范围 `data-config-field`/`data-config-action` 锚点与（空或 loaded）条目区；树内不出现 `/apikey/i`；`{view:'summary'}` 无输入控件；fake host 记录到 `config.get` 调用，get 返回的 timeoutMs 出现在树中；headless 全程零 DOM 接触。`test/client-bundle-config.test.js` 第 2 组。

## BCF-003 宿主半 config.get（读取面）

- **要求** 宿主半（`src/config-bridge.js` 的 `createConfigBridge(settings)`，settings 与 [CFG-004](config-network.md#cfg-004-配置快照与连接释放) 的 `{editor, entry, current()}` 同形）必须暴露方法 `config.get`：返回**当前生效配置**，复用 `readConfig` 语义（`normalizeConfig` 缺省补全、深冻结）；成功结果 `{ ok: true, config }`。行不可用等读取故障必须回传 `{ ok: false, code, message }`（`CONFIG_ROW_UNAVAILABLE` 语义沿用 B1′），不得静默回退装载快照。
- **来源** [Issue #46](https://github.com/AMindFlow/dsh-search-chain/issues/46)；裁决「组件自管读写走 host.call」。
- **验收** `current()` 给 `{}` → `config.get` 的 config 为 `{entries: [], useOfficialDeepSeekSearch: true, timeoutMs: 25000}`；给带 entries 的行 → 规范化输出同形（含 credentialRef 透传）。`current()` 抛行不可用 → `ok:false` 且 message 非空。`test/client-bundle-config.test.js` 第 3 组。

## BCF-004 config.put 合并语义与凭据边界

- **要求** 宿主半必须暴露 `config.put(form)`，收表单产物（`{ entries?, useOfficialDeepSeekSearch?, timeoutMs? }`），执行**合并写**：仅覆盖表单管理字段——`entries` 整体列表权威（集合与数组顺序=优先级；行内管理子字段 `id/type/name/enabled/credentialRef`，表单未给的子字段保留该行既有值）、`useOfficialDeepSeekSearch`、`timeoutMs`（表单省略的管理键保持当前值，**不重置缺省**）。该行的**未知顶层字段、每条目既有 `apiKey`（及 `api_key`/`key`/`secret`/`token`/`password`/`auth`/`authorization` 等明文 key 字段与未知自定义字段）必须原样透传保留**；**不得新增 apiKey**：表单产物中的任何明文字段必须被忽略、不落盘；表单未出现的条目即被移除。`credentialRef` 空串=删除引用（与 `normalizeConfig` 读路径同义）。写入必须复用既有宿主写入通道（`editor.edit(entry, mutate)` 整体替换 override 层自有键）。
- **来源** [Issue #46](https://github.com/AMindFlow/dsh-search-chain/issues/46) 裁决 1；凭据边界 [config-network.md](config-network.md)（CFG-003）、#45 缺口不扩大。
- **验收** 行含 `{entries:[{id:'e1',type:'bing',apiKey:'S1',customParam:7,vendorExtra:{a:1},credentialRef:'old'}], someOtherKey:'keep'}`：put 改 e1 名/enabled/credentialRef 并新增 e2 → 落盘 e1 保留 `apiKey:'S1'`、`customParam`、`vendorExtra` 原值，credentialRef 被表单值替换；e2 无 apiKey/credentialRef 键；`someOtherKey` 保留；顺序=表单顺序；表单产物携 `apiKey:'x'` 时 `x` 不落盘。省略 `timeoutMs` 的产物不改 timeoutMs。`test/client-bundle-config.test.js` 第 3 组。

## BCF-005 写闸与可操作错误

- **要求** `config.put` 写入前必须过 `normalizeConfig` 写闸（[CFG-004](config-network.md#cfg-004-配置快照与连接释放)；重复 id、非法类型、越界值等）：拒绝时**不得调用宿主写入**，必须回传 `{ ok: false, code: 'CONFIG_INVALID', issues: [{message, path?}], message }`，`issues` 非空且可读。宿主写入失败必须回传 `{ ok: false, code: 'CONFIG_SAVE_FAILED', message }`，message 可操作、**不回显被拒负载或任何凭据**（沿用 `writeConfig` 不附 cause 的裁决）；已生效配置不变。成功必须回传 `{ ok: true, config }`，其中 config 为写入后 `readConfig` 读回快照。
- **来源** [Issue #46](https://github.com/AMindFlow/dsh-search-chain/issues/46) 裁决 1「写失败回传可操作错误」；CFG-003。
- **验收** 类型不在 CAT-001 或重复 id 的产物 → `ok:false`、`code:CONFIG_INVALID`、`issues.length≥1`、edit 未被调用。edit 拒绝 → `CONFIG_SAVE_FAILED`，结果序列化不含行内 apiKey 秘密值。成功 → `readConfig` 读回管理字段与表单一致。`test/client-bundle-config.test.js` 第 3 组。

## BCF-006 设置区指引文案迁移

- **要求** `settings.section` 只读指示器的编辑指引文案必须改为实际可走路径：**设置 → 插件 → 已安装 → dsh-search-chain → 配置表单**（文案必须同时含「设置」「插件」「已安装」「dsh-search-chain」「配置表单」要素），不得再指向不存在的「插件配置区」JSON 编辑入口。既有对旧文案要素的测试断言随之迁移（`test/settings-client-wire.test.js` 的 `COMPONENT_TEXT_MARKS`）。用户文档（快速开始/升级指南）中同一指引由实现 PR 同步。
- **来源** [Issue #46](https://github.com/AMindFlow/dsh-search-chain/issues/46) 验收 3。
- **验收** fake react 渲染树文本含上述要素；`docs/user/getting-started.md` 等不再出现「编辑请使用 设置→插件→dsh-search-chain 配置区」旧句式。

## BCF-007 实机 DOM 验收（verify:ui-46）

- **要求** `scripts/verify-ui-46.mjs`（`npm run verify:ui-46`，**不入 `npm test`**）必须复用 #43 的隔离 `DSH_HOME` + `profiles/desktop`（link 本 checkout、空 patch 层、pnpm install）基建，拉起真实 GUI 主程序（`--remote-debugging-port` + 隔离 `--user-data-dir` + `DSH_HOME` 环境变量），经 **原生 CDP（node 全局 WebSocket，零依赖，选型锁死）** 驱动真 DOM：以 ps 自证 desktop-host 子进程 argv 含隔离 profile 路径（不触正式 profile，否则 fail-closed）；按 [C5][C6] 锚点抵达 bundle 页；断言 `[data-bundle-config]` 表单在场；改三字段（新增条目名、timeoutMs、官方开关）→ 点保存 → 返回重开后读回一致；最后页内 `fetch('/api/settings/describe')` 回归 ok。无 Desktop 二进制、CDP 不可达或隔离不可证时**醒目 SKIP、exit 2**；断言失败 exit 1；**禁静默绿**。
  - 注①（本机实证）：GUI 子进程环境必须剥除 `ELECTRON_RUN_AS_NODE`（桌面宿主环境常注入；继承则主程序按纯 Node CLI 解析 → `bad option: --remote-debugging-port` exit 9）。
  - 注②（本机实证）：隔离 profile 首启停在 **welcome 认证闸**（登录 / 添加 API Key），不达主 shell——脚本须识别该态并 FAIL 出明确诊断（不得混同为「表单不在场」）；转绿所需的过闸步骤（隔离内登录或经「添加 API Key」存测试 key 后等待侧栏）属 dev 实机项。
- **来源** [Issue #46](https://github.com/AMindFlow/dsh-search-chain/issues/46) 验收 2；AGENTS「优先 fixture 和本地服务；实机用独立测试 profile」。
- **验收** 本工作包提交时对现实现跑一次：实测 CDP 连接与隔离自证 OK，停在 welcome 认证闸 → exit 1 带「welcome 认证闸」诊断与截图（≠ 表单不在场，二者消息不同）；dev 实现后同一脚本应 PASS。`npm test` 计数与用例集不受本脚本影响（新增 guard 钉：`verify:ui-46` 存在且 `test` 脚本不含它）。

## 设计决定

- **不赌 ConfigPageForm**：`form` prop 在 bundle 级宿主渲染中实证缺席（[C1]），其方法面未实证 → 组件读写一律经 `host.call('config.get'|'config.put', input)` 走本包宿主半；`form` 仅在类型面容许存在（undefined-safe）。宿主半方法与宿主 RPC 装载接线（`host.call` 的实参传形——位置参或 `{method,input}`）以本规格命名为准：`config.get` / `config.put`；实现须兼容测试的记录面（首参字符串或含 `method`/`name` 的对象）。
- **注入面**：`inject` 保持 `["slots"]`、`dsh.client.inject` 保持 `[]`（[M4] 装载包列表语义不变）；`host` 按 [C3] 是 client builtin 经 ctx 直取。若实机证明 `host` 须经 inject 声明才注入，须同 PR 迁移本规格、`settings-client-wire.test.js` 的 inject 恰集钉与 `client-bundle-config` 钉（先改规格后改钉）。
- **宿主半模块落点**：`src/config-bridge.js` 导出 `createConfigBridge(settings)` → `{ "config.get": fn, "config.put": fn }`；`src/index.js` 的 `apply` 内用 `createSettingsPort(ctx)` 产物实例化并挂到宿主可被 `host.call` 分发的面（分发接线属宿主装载实证，由 verify-ui-46 端到端验证；单测只钉 bridge 语义）。`src/index.js` 既有 web provider 面（`inject`/`apply`/`Config`）为纯增量前提，不动。
- **合并写实现**：put 在 raw 层合并（`{...current raw}` + 逐条目 `{...savedEntry, ...管理字段}`），`normalizeConfig` 只作写闸（校验通过后**写合并 raw 而非规范化产物**，否则既有 apiKey/对象型未知字段会被 normalize 清洗，违反 BCF-004 透传）。
- **渲染冒烟用 fake hook-React**：软链 store 实证无 react/react-dom 包（2026-11-25 探测 `MODULE_NOT_FOUND`），「软链 store 的 react」在 node 侧不可得 → 测试经 factory 注入的 `require('react')` 通道喂 fake hook-React（createElement + `useState/useEffect/useCallback/useMemo/useRef/useId` 白名单 stub；组件用白名单外 hook 须先在本规格补 whitelist）。真实 react 渲染由 verify-ui-46 在宿主窗口内实证。
- **CDP 选型锁死**：原生 `WebSocket` CDP（`Runtime.evaluate`/`Page.captureScreenshot`），零 npm 依赖。否决 puppeteer-core：本 worktree 的 `node_modules` 是跨工作包共享软链，`npm i --no-save` 会污染共享 store；且 node ≥24 全局 WebSocket 已足够。
- **e2e 表单交互经 React 受控组件惯用法**：input/select 用原生 value setter + `input`/`change` 事件、checkbox 用 `click()`，不注入合成事件库。
