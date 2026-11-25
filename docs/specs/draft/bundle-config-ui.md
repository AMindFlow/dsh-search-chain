# bundle 页配置入口（v0.1 配置 UI）

本规格定义插件在 DSH 内置「设置 → 插件」bundle 详情页上的配置表单：注册面、表单范围、组件自管读写通道（**同源 settings RPC**：读 `settings/describe` 投影、写 `settings/mutate` ops）、组件内联 merge/validate/toOps 纯函数与合并写语义、凭据边界，以及实机 DOM 验收（`scripts/verify-ui-46.mjs`）。设置区指示器与数据面板行为仍归 [settings-ui.md](settings-ui.md)（SET 编号保留）；配置规范化与凭据解析仍归 [config-network.md](config-network.md)（CFG 编号保留），本规格只定义其上的 UI 契约。

> **通道迁移史（BCF-001 冲突史，2026-11-25 真机两轮探针定案）**：v0.1 初版裁决曾选 `host.call` → 本包宿主半 `config.get/config.put`（`src/config-bridge.js`）。真机证伪：静态 client factory 的 ctx **无 host 服务**——`inject: ["slots","host"]` 使包不激活（`pending (waiting for service: host)`），只声明 slots 时读 `ctx.host` 抛 `cannot get property "host" without inject`。用户实证同源 `POST /api/settings/describe` / `settings/mutate`（client-request envelope）读写 search-chain config 可行 → 通道终选同源 settings RPC，宿主半 `src/config-bridge.js` **退役**（不新建）；「对比钉」承担原宿主半的语义（BCF-003/004/005）。

## 契约（宿主实测事实，DSH 0.2.2-rc.5）

- **[C1] slot**：`plugins.bundle.config`，keyed，key = bundle **包名**（官方已占 key 全部是包名，如 `@deepseek-ai/dsh-cua-bundle`）；渲染在 bundle 页描述与其 rows 之间，`view: 'page'` 时渲染表单与保存控件。宿主页面证据（app.asar `ui-plugin-manager` 内联源码原文）：`configured ? <section data-plugin-config>{renderSlot('plugins.bundle.config', {view:'page'}, {entryKey: pkg.name})}</section> : null` —— **bundle 级渲染不传 `form`**；`form?: ConfigPageForm` 只在类型面存在（方法名面未实证，且 `configured` 以 slot 已占 key 为条件）。
- **[C2] 官方注册活样本**：`ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: '<包名>', locale: NS, inject: () => state }, Component))`。
- **[C3] client builtin（真机定案）**：`ctx` / React（无 JSX）/ `styles` / `console`。**无 `host` 服务**（两轮探针）：`inject: ["slots","host"]` → 包不激活 `pending (waiting for service: host)`；未声明读 `ctx.host` → 抛 `cannot get property "host" without inject`。任何「经 ctx 取 host 服务」的通道设计均已作废。
- **[C4] 真机实态（过闸后）**：隔离 profile 可过 welcome 闸（配方见 [C9]）；过闸后 shell ready、插件详情页可达、`plugins.bundle.config` slot 容器 DOM 在场；**组件渲染崩溃进 `data-slot-error` 错误边界**（[C10]）——注册与渲染必须做到零崩溃。
- **[C5] bundle 页 DOM 锚点**（宿主源码实证，验收脚本只依赖这些）：安装页包卡片 `li[data-plugin-package="<包名>"]`（卡内第一个 `button` 打开详情）；详情页 `div[data-plugin-detail="<包名>"]`（其第一个 `button` 为返回面包屑）；配置区容器 `section[data-plugin-config]`；槽错误边界 `data-slot-error`（[C10]）。
- **[C6] 导航**：插件页是 store 驱动的视图（`setView({kind:'package',name})`），**无 URL 路由**；从入口抵达 bundle 页须经 DOM 点击（侧栏面板按钮 → 卡片 → 详情）。侧栏面板按钮无稳定 data 属性（仅本地化 `aria-label`），脚本按「逐个点击直到 `[data-plugin-panel]` 在场」定位，locale 无关。**settings 面板从侧栏 nav 未达**（真机取证：nav 无「设置」入口，入口在他处）——文案类断言不得依赖「设置页可达」的路径措辞（BCF-006）。
- **[C7] 桌面线**：Desktop 主进程以 `--expose-internals <dsh-desktop-host/lib/index.js> <runtimeDir> <profileDir> …` 拉起子进程，`<profileDir>` = `$DSH_HOME/profiles/desktop`（本机运行实例 ps 原文实证）。`DSH_HOME` 指隔离目录后子进程 argv 含隔离 profile 路径，脚本以此自证「未触正式 profile」。
- **[C8] 同源 settings RPC**（app.asar zod schema 原文 + 用户实证可行）：页内 `fetch(location.origin + '/api/settings/<method>', {method:'POST', body: JSON.stringify({type:'client-request', rpcId, method:'settings/<method>', payload:{args}})})`。
  - `settings/describe` result：`{writable, hasDocument, namespaces: [{ns, autoGenerate, base, user, secrets, applies}]}`。本包读投影 = `namespaces` 中 `ns === 'search-chain'` 项的 `base`/`user` 层；**secrets 被宿主脱敏**（既有明文 apiKey 不经 describe 出宿主）。
  - `settings/mutate(ns: string, ops: Array<{op:'set', path: string[], value}|{op:'unset', path: string[]})` result = 写入后该 ns 的脱敏视图。ops 是**路径补丁**，不触及的路径（含 apiKey 行）宿主原样保留。
  - `args` 传形实证（dev 实测两轮）：`settings/describe` 的 zod 描述符**无参**——`args:{ns}` 被宿主拒 `unexpected "ns"`，`args:{}` 是唯一合法形状；`settings/mutate` 的 `args:{ns, ops, expectedRevision}` 实测被宿主接受——`expectedRevision` 取 **describe 回包 ns 视图的 `revision` 原样回传**（乐观并发；宿主判定冲突时回包非 ok，客户端必须进可读错误态，不得静默）。envelope 钉：describe 恰 `args:{}`，ns 校验位在**回包 `namespaces` 投影**（`ns:'search-chain'` 项在场）；mutate 钉 payload 含 ns、合法 ops 与 `expectedRevision`。
- **[C9] welcome 闸过闸配方（真机两轮探针）**：隔离 profile 注入假 provider（`apiKeyEnv` 指向假环境变量、`baseURL` 指死端口）+ `agent-default-model` 行 + `agent-preset-registry` 行 → 过闸后主 shell 可用；零真实外呼、零真实凭据。
- **[C10] slot 错误边界**：注册组件在宿主渲染中抛错时，槽容器呈 `data-slot-error`（真机实证：旧 host.call 版组件因读 `ctx.host` 崩溃 → 详情页出现 `data-slot-error`）。验收以「配置区无 `data-slot-error`」为反例钉。

## BCF-001 bundle 页配置注册

- **要求** client 产物（`src/client-entry.js` 的 `__ModuleLoader__.load` factory）在 `apply(ctx)` 时必须经 `ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(registration, Component))` 追加注册，registration 必须含 `name: 'plugins.bundle.config'` 与 `key: 'dsh-search-chain'`（**包名**，不是行 id `search-chain`），附加键仅限 `{id, order, label, locale, inject}`（keyed 槽无顺序语义），Component 为第二参组件工厂；既有 `settings.section` 注册不得受扰。幂等：同一 `ctx.slots` 重复 `apply` 每槽恰一次 inject，宿主挂载后每槽恰一次 register。**注入面恰集：factory 产物 `inject` 恰为 `["slots"]`**（[C3]：`host` 服务不存在，多一项皆不激活）；`apply` 与组件全程**不得读 `ctx.host`**（测试 ctx 的 `host` getter 按真机措辞抛错）。
- **来源** [Issue #46](https://github.com/AMindFlow/dsh-search-chain/issues/46)；[C1][C2][C3]。
- **验收** node 下 fake `__ModuleLoader__` 装载 → `factory(fakeRequire).apply(live 形状 ctx)`：`inject('plugins.bundle.config', …)` 恰 1 次；执行其懒工厂 → `slots.register` 收到 `{name,key}`，key 恰 `dsh-search-chain`，第二参为函数；重复 apply 计数不涨；`product.inject` deep-equal `["slots"]`。`test/client-bundle-config.test.js` 第 1 组。

## BCF-002 表单范围与 form 缺省安全

- **要求** 组件在 `view:'page'`（宿主唯一渲染的 view，[C1]）必须渲染三范围控件且 **不依赖 `form` prop**（不传、传 undefined、传任意宿主对象均必须正常渲染，读写走 BCF-003/004/005）：① entries 增删改——每行条目含类型选择（[CAT-001 八类型](providers.md#cat-001-首期类型)，含 Bing）、启用开关、名称文本、`credentialRef` 文本；id 只读或由表单生成（新条目生成后作为行标识）；数组顺序即优先级。② `useOfficialDeepSeekSearch` 开关。③ `timeoutMs` 数值。必须提供保存入口与可读的保存状态。**apiKey 输入不得出现**（任何 `apikey`/`api_key` 变体的输入或标签）。`view:'summary'` 必须渲染轻量指示（不得抛，不得含表单输入控件）。挂载时组件必须经同源 `fetch` 调 `settings/describe` 拉取本包投影填充草稿（BCF-003）；RPC 不可用/失败时渲染不得抛，进入可读错误态（BCF-005）。DOM 契约（验收与 [BCF-007](#bcf-007-实机-dom-验收) 脚本共同钉合）：根 `[data-bundle-config]`；字段 `[data-config-field="timeoutMs" | "useOfficialDeepSeekSearch" | "entry-name" | "entry-type" | "entry-credentialRef"]`；条目行 `[data-config-entry="<id>"]`；动作 `[data-config-action="add-entry" | "remove-entry" | "save"]`；保存状态 `[data-config-status="saved"|"error"]`，失败时 `[data-config-error]` 含可操作文案。
- **来源** [Issue #46](https://github.com/AMindFlow/dsh-search-chain/issues/46) 验收 1/4；[C1][C8]。
- **验收** fake hook-React（[C3] 的 react 通道）渲染：`{view:'page'}` 与 `{view:'page', form: undefined}` 均不抛且节点树含三范围 `data-config-field`/`data-config-action` 锚点与（空或 loaded）条目区；树内不出现 `/apikey|api_key/i`；`{view:'summary'}` 无输入控件；注入的 fake `fetch` 记录到 describe 调用（envelope 见 BCF-003），投影里的 timeoutMs/条目名出现在树中；headless 全程零 DOM 接触（`fetch` 是应用通道不属 DOM 面）。`test/client-bundle-config.test.js` 第 2 组。

## BCF-003 读取通道 = settings/describe 投影

- **要求** 组件挂载读取必须走同源 `POST settings/describe`（[C8]）：请求 envelope 恰含 `type:'client-request'`、`method:'settings/describe'`、字符串 `rpcId`，**`args` 恰空 `{}`**（宿主描述符无参，[C8]）；ns 校验位在回包投影 = ns 项的 `base`/`user` 层合成后经**内联 validate** 规范化；规范化缺省补全与写闸语义必须与 `src/config.js` 的 `normalizeConfig` 全等（防漂移钉 BCF-004）。describe 非 ok、无 search-chain 投影或网络异常时：渲染不得抛，必须显示 `[data-config-status="error"]`/`[data-config-error]` 可读错误，**不得静默展示缺省空表单**（会把空草稿误当生效配置诱导覆盖）。
- **来源** [Issue #46](https://github.com/AMindFlow/dsh-search-chain/issues/46)；[C8]（用户实测同源 RPC 可行）；#43 describe 面。
- **验收** fake fetch 返回 `{ok:true, result:{writable, hasDocument, namespaces:[{ns:'search-chain', base, user:{timeoutMs:9999, entries:[{id:'e1',…}]}}]}}` → 树含 `9999`/`e1` 名；envelope 钉如上。fake fetch 返回 `{ok:false}` 或抛网络错 → 不抛、error 锚点在场、无 `[data-config-status="saved"]`。`test/client-bundle-config.test.js` 第 2 组。

## BCF-004 内联 merge/toOps 与凭据边界（防双实现漂移 = 对比钉）

- **要求** 组件必须暴露**内联纯函数面** `Component.contract = { merge, validate, toOps }`（client 零 import 经典脚本，纯函数只能内联；不依赖 react/DOM/fetch，可被 node 直接调用）：
  - `merge(form, current) → raw'`：收表单产物（`{ entries?, useOfficialDeepSeekSearch?, timeoutMs? }`）与当前 raw（describe 投影合成或宿主读所得），执行**合并写**：仅覆盖表单管理字段——`entries` 整体列表权威（集合与数组顺序=优先级；行内管理子字段 `id/type/name/enabled/credentialRef`，表单未给的子字段保留该行既有值）、`useOfficialDeepSeekSearch`、`timeoutMs`（表单省略的管理键保持当前值，**不重置缺省**）。**未知顶层字段、每条目既有 `apiKey`（及 `api_key`/`key`/`secret`/`token`/`password`/`auth`/`authorization` 等明文 key 字段与未知自定义字段）原样透传保留**；**不得新增 apiKey**：表单产物中的任何明文字段必须被忽略；表单未出现的条目即被移除；`credentialRef` 空串=删除引用（删除键或写空串均可——validate/读路径与 `normalizeConfig` 同义）。
  - `validate(raw) → { ok:true, config } | { ok:false, code:'CONFIG_INVALID', issues:[{message, path?}] }`：判定与 `config` 输出必须与 `src/config.js normalizeConfig` **全等**（缺省补全、类型/值域、重复 id、明文 key 与对象型未知字段清洗）；`issues` 非空且可读。
  - `toOps(raw', current) → ops[]`：产物逐项符合 [C8] zod 形状（`{op:'set',path[],value}` / `{op:'unset',path[]}`）；**任何 set 的 `value` 递归不得携带 SECRET_FIELD 键**（`apikey|api_key|key|secret|token|password|auth|authorization` 大小写变体，与 `src/config.js` 同集——rev 实证泄形：`current=[A(apiKey),B]`+`form=[A,A']` 时整条 set `["entries","1"]` 值含 apiKey，禁止）；按测试权威 reducer（set 按 path 下钻、数组段按数值下标；unset 对象删键、数组数值段 splice）作用于 `current` 必须与 `raw'` **双侧脱敏后全等**（明文透传保证在 merged 面，ops 面另立剥离钉）；**不得有任何 op 触及 apiKey/明文 key 路径**（凭据边界 v0.1 不变，#45 缺口不扩大）。
  - **对比钉（防内联/宿主双实现漂移）**：对输入表逐行 `validate(merge(form,current))` 与 `runNormalize(merge(form,current))` 的结构化输出 `{ok, code?, config?}` 全等（message 措辞不参与对比，issues 可读性单独钉）。
- **来源** [Issue #46](https://github.com/AMindFlow/dsh-search-chain/issues/46) 通道终选「组件内联 merge+写闸纯函数」；凭据边界 [config-network.md](config-network.md)（CFG-003）；`normalizeConfig` 真身 = `src/config.js`（`src/index.js` 仅 re-export 引用，规格修正记录）。
- **验收** 输入表 ≥10 行，覆盖：apiKey/未知键透传、明文对象字段清洗、credentialRef 空串删、非法形状（entries 非数组/非对象行）、非法/越界 timeout、重复 id、boolean 类型错、缺省补全、省略管理键保留。合并语义样例：current 行 `{entries:[{id:'e1',type:'bing',apiKey:'S1',customParam:7,vendorExtra:{a:1},credentialRef:'old'}],someOtherKey:'keep',timeoutMs:30000}` + form 改 e1 名/enabled/credentialRef 并新增 e2 → raw' 中 e1 保留 `apiKey:'S1'`、`customParam:7`、`vendorExtra:{a:1}`，credentialRef 被替换；e2 无 apiKey/credentialRef 键；`someOtherKey` 保留；顺序=表单顺序；form 携 `apiKey:'x'` 时 `x` 不出现在 raw'/ops。`toOps` 结果经 reducer **双侧脱敏后**应用回 current ≡ raw'；set 值递归 SECRET_FIELD 剥离独立钉（含 rev 复现原形 `current=[A(apiKey),B]`+`form=[A,A']`）。`test/client-bundle-config.test.js` 第 3 组。

## BCF-005 写通道、写闸与可操作错误

- **要求** 保存必须：先过**本地写闸** `contract.validate`——拒绝时**不得发任何 fetch**，就地显示 `issues`（`[data-config-error]` 可操作、可读）。通过后经同源 `POST settings/mutate`（[C8]）写入：envelope 恰含 `type:'client-request'`、`method:'settings/mutate'`、字符串 `rpcId`；payload 含 ns `search-chain`、`contract.toOps` 产出的 ops（形状合法）与 **`expectedRevision`（= describe 回包 ns 视图 `revision` 原样回传，乐观并发）**。宿主拒绝（含 `expectedRevision` 冲突、`settings/mutate` 触发的 ns 校验即 #43 的 `resolveConfig`/Config zod 面保持不动）或网络异常：显示 `[data-config-status="error"]`/`[data-config-error]`，**不回显被拒负载或任何凭据**（沿用 `writeConfig` 不附 cause 裁决），已生效配置不变；**不得显示 saved、不得静默**。成功（response ok）：显示 `[data-config-status="saved"]`。
- **来源** [Issue #46](https://github.com/AMindFlow/dsh-search-chain/issues/46)；CFG-003；#43（宿主校验面）。
- **验收** 合法草稿点保存 → fake fetch 记录 `settings/mutate`，payload 含 ns、合法 ops 与 `expectedRevision`（恰等 describe 样本 `revision`），随后树含 `[data-config-status="saved"]`。rejection/冲突 response（`{ok:false}`/`result.ok:false` 形态按注入样本）→ error 锚点在场、无 saved、序列化输出不含样本秘密值。本地写闸拒绝路径由 `contract.validate` 直测钉（第 3 组）。`test/client-bundle-config.test.js` 第 2 组。

## BCF-006 设置区指引文案（两态：已证路径可断言 / 设置页路由开放）

- **要求** `settings.section` 只读指示器的编辑指引文案分两态——**已证态（可断言）**：真机 verify-ui-46 步骤 6a-6b 实证的可走路径「侧栏『插件』→ dsh-search-chain 卡片 → 详情页配置表单」，文案必须含「插件」「详情」「配置表单」与包名 `dsh-search-chain`；**开放态（禁止断言）**：「设置→…」前缀路径仍未证（[C6]：settings 面板从侧栏 nav 未达，入口在他处），文案**不得出现「设置→」前缀**，DOM 锚点取证后另立条款再迁移。不得再指向不存在的「插件配置区」JSON 编辑入口。既有对旧文案要素的测试断言随之迁移（`test/settings-client-wire.test.js` 的 `COMPONENT_TEXT_MARKS`）。用户文档中同一指引由实现 PR 同步。
- **来源** [Issue #46](https://github.com/AMindFlow/dsh-search-chain/issues/46) 验收 3；真机取证（lead rev 轮，verify 6a-6b）。
- **验收** fake react 渲染树文本含「插件」「详情」「配置表单」「dsh-search-chain」且不含「设置→」；`docs/user/getting-started.md` 等不再出现「编辑请使用 设置→插件→dsh-search-chain 配置区」旧句式（实现 PR 项）。

## BCF-007 实机 DOM 验收（verify:ui-46）

- **要求** `scripts/verify-ui-46.mjs`（`npm run verify:ui-46`，**不入 `npm test`**）必须复用 #43 的隔离 `DSH_HOME` + `profiles/desktop`（link 本 checkout、空 patch 层、pnpm install）基建，拉起真实 GUI 主程序（`--remote-debugging-port` + 隔离 `--user-data-dir` + `DSH_HOME` 环境变量），经 **原生 CDP（node 全局 WebSocket，零依赖，选型锁死）** 驱动真 DOM：以 ps 自证 desktop-host 子进程 argv 含隔离 profile 路径（不触正式 profile，否则 fail-closed）；按 [C5][C6] 锚点抵达 bundle 页；断言 `[data-bundle-config]` 表单在场**且配置区无 `[data-slot-error]`（[C10] 反例钉：组件崩溃进错误边界即 FAIL）**；改三字段（新增条目名、timeoutMs、官方开关）→ 点保存 → 返回重开后读回一致；最后页内 `fetch('/api/settings/describe')` 回归 ok。无 Desktop 二进制、CDP 不可达或隔离不可证时**醒目 SKIP、exit 2**；断言失败 exit 1；**禁静默绿**。
  - 注①（本机实证）：GUI 子进程环境必须剥除 `ELECTRON_RUN_AS_NODE`（桌面宿主环境常注入；继承则主程序按纯 Node CLI 解析 → `bad option: --remote-debugging-port` exit 9）。
  - 注②（本机实证）：隔离 profile 首启停在 **welcome 认证闸**（登录 / 添加 API Key）——脚本识别该态并 FAIL 出明确诊断（不混同为「表单不在场」）；过闸步骤按 [C9] 配方落地属 dev 转绿项。
- **来源** [Issue #46](https://github.com/AMindFlow/dsh-search-chain/issues/46) 验收 2；AGENTS「优先 fixture 和本地服务；实机用独立测试 profile」。
- **验收** oracle 提交时实测：CDP 连接与隔离自证 OK，停在 welcome 认证闸 → exit 1 带「welcome 认证闸」诊断与截图（≠「表单不在场」，消息不同）；dev 补过闸（[C9]）后同一脚本应 PASS。`npm test` 计数与用例集不受本脚本影响（guard 钉：`verify:ui-46` 存在且 `test` 脚本不含它）。

## 设计决定

- **通道终选与 config-bridge 退役**：读=页内 `fetch POST settings/describe` 的本包投影；写=`settings/mutate` ops；merge/validate/toOps 内联进 client（`Component.contract` 静态纯函数面，测试经注册产物取用；宿主只调 `Component(props)`，静态不影响渲染）。`src/config-bridge.js` 与 `host.call('config.get'/'config.put')` 命名作废（BCF-001 冲突史见文件头引言）。`args` 传形已两轮实证（[C8]：describe 无参恰 `args:{}`，mutate `args:{ns,ops}`）：envelope 钉 `type/method/rpcId`，describe 另钉 args 恰空（ns 位在回包投影），mutate 钉 payload 含 ns/ops/`expectedRevision`——「不赌未实证方法面」的教训固化为实证钉。
- **注入面恰集（真机定案）**：factory 产物 `inject` 恰 `["slots"]`；`dsh.client.inject` 恰 `[]`（[M4] 装载包列表语义不变）。`["slots","host"]` = 永不激活（[C3]）。测试 ctx 的 `host` getter 抛 `cannot get property "host" without inject` 同形措辞，读即红。
- **对比钉**：漂移面 = 内联 validate vs 宿主 `normalizeConfig`。测试内 `runNormalize(raw)`：`normalizeConfig` 正常返回 → `{ok:true, config}`；抛 `ConfigError(CONFIG_INVALID)` → `{ok:false, code:'CONFIG_INVALID'}`；与 `validate(raw)` 的结构化输出 deep-equal。非法判定与规范化输出任何分叉即红。宿主侧 `settings/mutate` 触发的 ns 校验（#43 Config zod + resolveConfig）保持不动，由 guard 钉（`src/index.js` provider 面）+ 既有 #43 测试面兜底。
- **toOps 权威 reducer（测试侧定义）**：`set` 沿 path 下钻（对象键或数组数值下标，中间缺位补建），`unset` 对象删键、数组数值段 splice；逐 op 依次作用于 `structuredClone(current)`。dev 若选别的 op 表达（如整 entries 数组单 set），只要**双侧脱敏后**应用结果 ≡ raw' 即绿——语义钉不绑实现形状；但 set 值必须递归剥离 SECRET_FIELD 明文键（P2-1，泄形即红）。
- **合并写实现**：merge 在 raw 层做（`{...current}` + 逐条目 `{...既有, ...管理字段}`），validate 只作写闸与草稿规范化（校验通过后**写 raw 层产物而非规范化产物**，否则既有 apiKey/对象型未知字段会被清洗，违反 BCF-004 透传）。
- **不赌 ConfigPageForm**：`form` prop 在 bundle 级宿主渲染中实证缺席（[C1]）→ undefined-safe，读写一律走 [C8] 通道；`form` 仅在类型面容许存在。
- **渲染冒烟用 fake hook-React**：软链 store 实证无 react/react-dom 包（探测 `MODULE_NOT_FOUND`）→ 测试经 factory 注入的 `require('react')` 通道喂 fake hook-React（createElement + `useState/useEffect/useCallback/useMemo/useRef/useId` 白名单 stub；组件用白名单外 hook 须先在本规格补 whitelist）。真实 react 渲染由 verify-ui-46 在宿主窗口内实证。
- **fetch 注入面**：测试以 `globalThis.fetch` 替身记录调用并回放 describe/mutate 样本（HTTP 恒 200，业务成败在 response JSON `ok`/`result.ok`；两种 rejection 形态都不得显示 saved）。
- **CDP 选型锁死**：原生 `WebSocket` CDP（`Runtime.evaluate`/`Page.captureScreenshot`），零 npm 依赖。否决 puppeteer-core：本 worktree 的 `node_modules` 是跨工作包共享软链，装包会污染共享 store；node ≥24 全局 WebSocket 已足够。
- **e2e 表单交互经 React 受控组件惯用法**：input/select 用原生 value setter + `input`/`change` 事件、checkbox 用 `click()`，不注入合成事件库。
