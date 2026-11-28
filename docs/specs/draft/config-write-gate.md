# 配置写闸对齐读闸

本规格定义设置面板在浏览器侧（`src/client-entry.js`）构造 `settings/mutate` 补丁前的写闸预检、空值形态矩阵、写路径明文密钥清理及写闸拒绝错误语义，确保通过设置面板保存成功的配置必然可通过启动与搜索期的读闸校验（[CFG-004](config-network.md#cfg-004-配置快照与连接释放)）。

## CFG-W-001 写闸预检等价性

- **要求** 设置面板在构造 `settings/mutate` 操作集合之前及离散落盘提交之前，必须以等价于服务端读闸 `normalizeConfig`（`src/config.js`）的纯函数规则校验合并后的目标配置（含 `entries` 条目逐项类型与字段、`entries[].id` 去空白后唯一性、`useOfficialDeepSeekSearch` 与 `timeoutMs`、以及条目 `proxy` 三形态）。凡读闸必拒的形态（如重复 `id`、非法类型、非法 `proxy`、非正整数 `timeoutMs`、越界 `null` 等），写闸必须先拒绝，不得放行至 `settings/mutate`；写闸亦不得额外收紧读闸本就允许的合法形态（除面板编辑器既有的可见名称门与 `credentialRef` POSIX 语法输入校验外，纯写闸归一化判定必须与读闸双向一致）。写闸拒绝时的错误文案必须包含可定位到具体条目或字段的位置（如 `entries[0].name`、`entries 中 id 重复：<id>`）及可操作原因。
- **来源** [GitHub Issue #45](https://github.com/AMindFlow/dsh-fleetseek/issues/45)、[CFG-004](config-network.md#cfg-004-配置快照与连接释放)。
- **验收**
  1. 对同一组恶意与边角配置样本（涵盖重复 `id`、去空白后碰撞的重复 `id`、各字段 `null` 形态、非法 `credentialRef`、非法 `proxy`、非正整数或超安全整数上界 `timeoutMs`、非布尔 `useOfficialDeepSeekSearch`）同时调用 `Component.contract.validate` 与 `src/config.js` 的 `normalizeConfig`，断言两者通过/拒绝结果双向全等；同时断言 `Component.contract.toOps` 对非法目标形态直接抛出 `CONFIG_INVALID`。
  2. 在面板真实交互路径（编辑器保存、官方开关切换、超时提交、启用开关切换、条目重排、移除后仍有其他损坏条目）中注入含重复 `id` 或非法字段的投影或目标状态，验证均被写闸拦截且错误文本包含条目定位与原因。

## CFG-W-002 null 形态矩阵

- **要求** 写闸纯函数归一化（`Component.contract.validate` 与 `Component.contract.toOps` 预检）对配置各字段出现 `null` 时的判定必须与读闸 `normalizeConfig` 逐字段一致：
  - 顶层 `raw === null`：视同空对象 `{}` 接受；
  - `entries === null`：拒绝（`entries 必须是数组`）；
  - `entries[i] === null`：拒绝（`entries[i] 必须是对象`）；
  - `entries[i].id === null`：拒绝（`entries[i].id 必须是非空字符串`）；
  - `entries[i].type === null`：拒绝（`entries[i].type 不是已知工具类型`）；
  - `entries[i].name === null`：拒绝（`entries[i].name 必须是字符串`）；
  - `entries[i].enabled === null`：拒绝（`entries[i].enabled 必须是布尔值`）；
  - `entries[i].credentialRef === null`：接受（与 `undefined`、`""` 同义，归一化输出中省略该键）；
  - `entries[i].proxy === null`：接受（与 `undefined`、空白串同义，归一化为直连并省略该键）；`entries[i].proxy = { pac: null }` 拒绝（`entries[i].proxy 形态非法`）；
  - `useOfficialDeepSeekSearch === null`：拒绝（`useOfficialDeepSeekSearch 必须是布尔值`）；
  - `timeoutMs === null`：拒绝（`timeoutMs 必须是正整数毫秒`）。
- **来源** [GitHub Issue #45](https://github.com/AMindFlow/dsh-fleetseek/issues/45)、[CFG-001](config-network.md#cfg-001-每条工具的代理与直连)、[CFG-004](config-network.md#cfg-004-配置快照与连接释放)。
- **验收** 逐项构造上述矩阵中的每个 `null` 形态，分别输入 `Component.contract.validate` 与 `src/config.js` `normalizeConfig`，验证允许与拒绝结论逐项双向一致；并在设置面板保存路径上验证读闸必拒的 `null` 形态均被写闸在 `settings/mutate` 前拦下。

## CFG-W-003 写路径明文 key 清零

- **要求** 当宿主 `settings/describe` 返回的 `user` 层条目上残留任意命中 `SECRET_FIELD`（大小写不敏感匹配 `apikey`、`api_key`、`key`、`secret`、`token`、`password`、`auth`、`authorization`）的明文字段时，无论用户通过设置面板的哪条保存路径完成保存（编辑条目、新建条目、切换启用开关、调整顺序、移除其他条目、切换 DeepSeek 官方开关、修改超时），发出的 `settings/mutate` 操作集合在应用到持久化 `user` 层后，磁盘条目上不得再存在任何 `SECRET_FIELD` 命中字段，且所有请求体不得携带秘密明文值或以 `SECRET_FIELD` 作为对象键名的值载荷。
- **来源** [GitHub Issue #45](https://github.com/AMindFlow/dsh-fleetseek/issues/45)、[CFG-003](config-network.md#cfg-003-凭据隔离和脱敏)。
- **验收** 构造 `user` 层条目含 `apiKey`（及其他 `SECRET_FIELD` 变体）明文字段的 `settings/describe` 回包，分别走面板编辑保存（含未触碰该条目而保存其他条目、打开该条目直接点保存、重排、启用切换、官方开关/超时保存等路径），断言发出的 `settings/mutate` 请求体不含原明文值与秘密键名载荷，且将 `ops` 经权威 reducer 应用到 `user` 层后，全部条目上不再存在 `SECRET_FIELD` 命中字段。

## CFG-W-004 错误语义与零出站

- **要求** 当写闸在任意保存路径拒绝请求时，设置面板必须向用户呈现可读、可操作的错误提示（沿用 `SET-004` / `SET-007` 既有的 `data-role="save-error"` 与 `role="alert"` 错误锚点：编辑器内提交优先呈现于编辑器动作行上方，离散动作呈现于节级顶部错误槽，并与成功提示互斥），保留用户未提交草稿与编辑器状态；同时必须做到零 `settings/mutate`、零 `credentials/set` 与零供应商/外部网络出站请求。
- **来源** [GitHub Issue #45](https://github.com/AMindFlow/dsh-fleetseek/issues/45)、[SET-004](settings-ui.md#set-004-保存与凭据状态)。
- **验收** 在面板触发写闸拒绝（包括存在待写新 key 时因配置校验失败被写闸拦截，以及离散开关/重排/超时保存命中既有损坏条目或重复 `id`），检查渲染树存在 `data-role="save-error"` 且 `role="alert"` 的可读错误文本、无 `data-role="save-status"` 成功提示、草稿输入保留；同时核对 `fetchStub.mutates()`、`fetchStub.credentialSets()` 与 `fetchStub.outbound` 计数均为零。

## 设计决定

- **CFG-W-001 / CFG-W-002（浏览器端内联等价规则）**：`src/client-entry.js` 运行于 DSH 浏览器沙箱，零外部 `import`、零 Node 依赖，因此不得直接 `import src/config.js`。写闸在 `src/client-entry.js` 的 `Component.contract` 中内联维护与 `src/config.js` `normalizeConfig` 完全同构的纯函数归一化实现，并由测试套件中的「两闸等价钉」锁定双方行为不得漂移。
- **CFG-W-003（面板写路径显式清理与 `toOps` 粒度保持）**：`contract.merge` / `contract.toOps` 的直接单测契约维持 D-1 字段级 diff 与「仅直接传入 stripped 目标时才产出 `unset`」语义，避免破坏已有单测锁定的纯函数接口；面板各保存路径在构建目标条目列表时对条目递归剥离 `SECRET_FIELD`（由 `toOps` 为位置不变的条目自动产出字段级 `unset`，对移动或新建条目随整条 `set` 自然剔除），离散顶层写路径与单行移除路径亦附带针对 `user.entries[*]` 残留 `SECRET_FIELD` 键的显式 `unset` 补丁。
- **CFG-W-004（先于凭据写入预检）**：编辑器提交流程在调用 `/api/credentials/set` 之前先用占位合法引用对目标有效配置执行 `singleEntryDiff` 与写闸 `validate` 预检，确保配置本身不合法时不仅零 `settings/mutate`，也不产生孤儿凭据写入。

## PX 修订注（Issue #88，事后附录）

- **两闸等价预检按字段族分岔（CFG-W-001 细化）**：`proxyEscalation` / `globalProxy` / `entries[i].proxyPin` 新字段族引入（见 [proxy-escalation.md](proxy-escalation.md) PX-001/003/006/012）后，写闸预检（`Component.contract.validate` 前置 `assertPxWriteGate`）按字段族分岔：**新字段族违规抛错、legacy 族维持返回形态**（`{ ok: false, code: "CONFIG_INVALID", issues: [...] }` 形态逐字不变），Refs #88。抛错文案与读闸字段定位文案同文，双向等价不变：读闸归一化必拒则写闸预检必拒（抛错或返回形任一），读闸接受则写闸接受；`settings-write-gate` 的 legacy 矩阵（无守卫直调 validate）保持全绿即为该分岔的回归钉。
- **全局代理明文字段族并入清理闭集（CFG-W-003 扩展）**：全局代理地址（含认证）只进宿主凭据服务（默认引用名 `search_chain_global_proxy`，只写不读回）；字段族 `globalProxy`（大小写不敏感匹配）取值为含 `://` 或 `@` 的字符串时判为明文，并入 CFG-W-003 清理闭集：任何有变更的保存路径（编辑/新建条目、启用切换、重排、移除其他条目、官方开关、超时）发出的 ops 须对 `user` 层顶层与条目级残留明文字段附带 `unset`，且请求体不得携带明文（无 `://`、无 userinfo）。读闸 `normalizeGlobalProxyRef` 对明文形态维持拒绝（返回形）。Refs #88。
- **读路径与拒绝呈现对抛错形态的转形**：面板读路径（describe 读回、渲染期实时校验）与离散/升级区块的拒绝呈现，将新字段族违规的抛错形态转为返回形呈现（错误锚点沿用 `data-role="save-error"` + `role="alert"`，与成功提示互斥、草稿保留、零 mutate、零 credentials/set）；写路径契约面（`validate` 预检对新字段族抛错）不受该转形影响。Refs #88。

- **来源** [GitHub Issue #88](https://github.com/AMindFlow/dsh-fleetseek/issues/88)、[CFG-W-001](#cfg-w-001-写闸与读闸双向等价)、[CFG-W-003](#cfg-w-003-写路径明文-key-清零)、[CFG-W-004](#cfg-w-004-错误语义与零出站)。
- **验收** `test/settings-write-gate.test.js`（legacy 矩阵全绿）、`test/px-oracle-gates.test.js`（新字段族两闸双向等价与定位文案）、`test/px-panel.test.js`（PX-001#3 明文清零并入、PX-002#1 拒绝路径零凭据、PX-012#4 读路径不崩溃）；`npm test` 全量离线绿。
