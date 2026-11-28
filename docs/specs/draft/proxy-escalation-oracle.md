# proxy-escalation 测试 Oracle（工作包 #88）

> 独立 Oracle 编制：仅依据 [proxy-escalation.md](proxy-escalation.md)（fb32f9a）、PR #103 lead 审阅（gate 1）与既有测试基础设施，定义「可观察预期 + 验证方法」，不含实现承诺。实现者以本文为验收真值之一；标识符命名异议按 [helpers/contract.js](../../../test/helpers/contract.js) 头部规则在实施 PR 内协商同步。
>
> 骨架测试：`test/px-oracle-*.test.js`（实现前跑红属预期，勿改 skip——[helpers/impl.js](../../../test/helpers/impl.js) 约定）。

## 观测面速查

| 代号 | 观测面 | 既有载体（API 以代码为准） |
| --- | --- | --- |
| O1 | 读闸输出/拒绝 | `normalizeConfig` / `readConfig`（src/config.js），错误 `ConfigError.code=CONFIG_INVALID`、文本含字段定位 |
| O2 | 写闸输出/拒绝 | `Component.contract.validate` / `toOps`（src/client-entry.js），两闸等价钉（CFG-W-001） |
| O3 | `settings/mutate` 请求体与计数 | [settings-panel-v02.js](../../../test/helpers/settings-panel-v02.js) `installSettingsFetch(state)` → `fetchStub.mutates()`、`outbound`、`calls[].body`；请求体明文检索用 `collectStrings` |
| O4 | `credentials/set` 调用计数与值 | 同上 `fetchStub.credentialSets()`（`calls[].seq` 可断先后次序）；node 层凭据替身 `createFakeCredentials`（resolve 缺失/空值均 → `undefined`，`failRefReads` 模拟不可读） |
| O5 | 出站请求桩计数与路由 | [fake-fetch.js](../../../test/helpers/fake-fetch.js) `fetchFn.calls[]`（`{url, init, headers, settled, startedNow}`；`init.route` 为 transport 路由标记 A4）；`fetchFn.count/callsFor` |
| O6 | `content` 首行 | `result.content.split("\n")[0]`；[contract.js](../../../test/helpers/contract.js) `assertSearchResult`（FB-002 接管标注面） |
| O7 | `details.attempts` 结构 | `assertWebError`（A7：`{entryId, entryType, entryName, code, reason}` 按尝试顺序） |
| O8 | 错误/日志文本与脱敏 | `WebError.message`、`attempts[].reason`、`logCapture`（[redact.js](../../../test/helpers/redact.js) `assertNoSecrets/assertNoCredentialUserinfo`） |
| O9 | 预算与顺序 | `ctx.budgetMs`、`harness.executions()`、受控时钟 `clock.advance`（[clock.js](../../../test/helpers/clock.js)） |
| O10 | 面板视图/错误锚点 | `panel.view()`、`ROLE.saveError`（`data-role="save-error"` + `role="alert"`）、SET-006/007 锚点 |

合成素材基线（防真实出站）：全局代理合成 URL `http://syn-user:syn-pass@syn-proxy.invalid:8080`（脱敏目标 `http://syn-proxy.invalid:8080`）、引用名 `search_chain_global_proxy`、条目/来源同 `makeEntry/makeSources` 惯例。

## Oracle 假设清单（标识符/观测形态为 oracle 提议，实现须满足或协商）

- **A-PX-1（升级出站观测形态）**：升级请求与条目直连请求走同一注入 fetch 面，其 `init.route` 为 `{ kind: "proxy"|"https-proxy", proxyUrl: <全局代理解析 URL>, viaGlobal: true }`（A4 标记扩展；`viaGlobal` 供「经全局代理」与「条目自有代理」可判别）。桩计数断言一律以 `callsFor`/route 判别，不以 URL 猜测。
- **A-PX-2（面板新锚点）**：全局升级区块控件 `data-role` 取 `escalation-toggle` / `global-proxy-input` / `global-proxy-status`；条目卡钉死控件取 `pin-direct` / `pin-inherit` / `pin-proxy` 与卡片徽标 `pin-badge`。角色增补须同步 `settings-panel-v02.js` 的 `ROLE`（该文件属测试面，实施 PR 可加键，不改既有键）。
- **A-PX-3（归一化输出键形）**：读闸输出顶层恒含 `proxyEscalation`（布尔）、`globalProxy`（仅已配置引用名时出现）、条目恒含 `proxyPin`（`"inherit"|"directOnly"|"proxyOnly"`；输出 `"inherit"` 与省略同义，round-trip 允许显式写出）。

## PX-001 全局升级配置两字段与 secret 处置

| # | 可观察预期（判定标准） | 验证方法（fixture / 桩 / 判据） | 自动化 |
| --- | --- | --- | --- |
| 1 | 存量配置（无三新键）经读闸：输出 `proxyEscalation === false` 且 `"globalProxy" in out === false`（O1）。不新增其他顶层键（键集 = 旧三键 + 两新键，仅 `proxyEscalation` 显式输出）。 | fixture：v0.2.0 真实形态存量快照（`test/fixtures` 扩展 `px009-legacy-config.json`）；直接调 `normalizeConfig`；判据：键集与值 deepEqual。 | ✅ `px-oracle-gates.test.js` |
| 2 | 面板保存含认证合成 URL 后：宿主 `user` 层（O3 `state.user`）仅含 `globalProxy="search_chain_global_proxy"` 类引用名；`collectStrings(state.user)` 不含 `syn-pass`、`syn-user`、`:8080/path` 段与任何 `://` 明文 URL；`fetchStub.credentialSets()` 恰 1 且值恰为原 URL 一次（O4）；面板重开 `view()` 状态指示为 `http://syn-proxy.invalid:8080`（scheme://host:port），无输入值回显；`logCapture` 无明文（O8）。 | 面板 harness：`makeSettingsState` + `installSettingsFetch`；输入合成 URL → 保存 → 重开（重新 `openPanel`/重挂载）。判据：`leaksIn(tree, "syn-pass") === false`、`credentialSets().length === 1`、mutate 请求体 `collectStrings` 检索无明文、状态文本含脱敏目标。 | ✅ 面板测试（PX-011 组合覆盖） |
| 3 | `user` 层预置 `globalProxy`（或同义字段，如 `globalProxyUrl`）为明文 URL 时，任一保存路径后：落盘 override 无该明文字段值（清零或 unset）、全部 mutate 请求体不含明文值（O3）；沿用 CFG-W-003 SECRET_FIELD 清理闭集，全局代理明文字段名已并入。 | fixture：`state.user.globalProxy = "http://syn-user:syn-pass@syn-proxy.invalid:8080"`；走「切换启用开关」「改超时」等与本条无关的离散保存；判据：`applyOps` 后 `state.user` 无明文（含 unset op 或值被清）、`mutates()` 各 body 检索无 `syn-pass`。 | ✅ |
| 4 | 两闸双向同拒：`proxyEscalation` 取 `null`/`"true"`/`0`/`{}`；`globalProxy` 取含 `://` 明文 URL、含 userinfo 串、非 POSIX 名（`bad ref`、`bad:ref`、`""` 之外非标识符）——`normalizeConfig`（O1）与 `Component.contract.validate`（O2）均拒绝，错误文本含字段名 `proxyEscalation`/`globalProxy`；写闸拒绝路径零 `settings/mutate`、零 `credentials/set`（CFG-W-004）。 | 两闸等价钉样本表：同一样本喂 `normalizeConfig` 与 `contract.validate`，判据：抛/不抛双向全等 + 文本 `match(/proxyEscalation|globalProxy/)`。面板路径抽一例断言 `mutates().length === 0`。 | ✅ `px-oracle-gates.test.js` |
| 5 | 全局代理 URL（含 userinfo）只出现在 CONNECT 隧道的 `Proxy-Authorization`：任何其他出站请求头、`logCapture`、`WebError.message`、`attempts[].reason`、`content` 均检索不到 `syn-pass`（O5 headers / O8）；出站面出现的代理目标形态一律 `scheme://host:port`。 | 链级：直连失败 + 升级（PX-004 fixture），`fetchFn.calls[].headers` 全量 `collectStrings` 检索 `syn-pass` 必须为空；头部级 CONNECT 正证用本地 HTTP CONNECT 桩服务（node:http `connect` 事件）收 `proxy-authorization` 恰一次且为 Basic(syn-user:syn-pass)——成本较高，列为实机/集成层用例，node:test 层做负证（不得出现）+ 脱敏正形（含 `syn-proxy.invalid:8080` 不含 userinfo）。 | 负证 ✅；CONNECT 正证 ⚠️ 集成层（列入交付记录「实际验证」，或本地桩自动化，二选一） |

## PX-002 开关开启但全局代理未配置或不可解析的失败语义

| # | 可观察预期（判定标准） | 验证方法 | 自动化 |
| --- | --- | --- | --- |
| 1 | 终态 `proxyEscalation=true` 且 `globalProxy` 未配置：两闸均拒（O1/O2），错误文本定位 `proxyEscalation` 且提示先保存全局代理地址；写闸路径零 `settings/mutate`（O3）、零 `credentials/set`（O4，CFG-W-004 先于凭据写入预检）。 | 闸层：`normalizeConfig({proxyEscalation:true, globalProxy:undefined,...})` 与 `contract.validate` 同目标态，双向均抛、文本 `match(/proxyEscalation/)`。面板层：拨开关不填地址保存 → `view().saveError` 非空（O10 `role="alert"`）、`fetchStub.mutates().length===0 && credentialSets().length===0`。 | ✅ `px-oracle-gates.test.js`（闸）+ 面板用例（PX-011） |
| 2 | 开关开+引用存在、凭据服务对引用返回缺失或纯空白（`resolve→undefined` / 值 trim 后空）、直连注入网络层失败：升级零出站（O5：无 `route.viaGlobal` 请求，总出站数=直连尝试数）；条目仍直连尝试（有直连出站）；条目失败 `attempts[].reason` 含「全局升级已开启但全局代理凭据未配置或不可读，未执行升级」要素与可操作指引（设置中重新保存全局代理地址）（O7/O8）；终态仍按 FB-004/FB-005 呈现，不得静默按开关关闭处理。 | 链级 harness：`extraConfig:{proxyEscalation:true, globalProxy:"search_chain_global_proxy"}`，`credentialRefs` 不 seed 该引用（缺失形）与 seed `{value:"   "}`（空白形，经 fake-credentials 真形糖 `{" "}`→resolve 返回 hit.value=" "？注意 fake-credentials 只对空串跳过——空白值形以 `failRefReads` 或直连配置桩构造，两形分别断言）；后端 `stepFail({code:ENTRY_NETWORK})`。判据：`fetchFn.calls` 无 viaGlobal 路由；`runToError` 的 `attempts[0].reason` 关键词包含。 | ✅ `px-oracle-misconfig.test.js` |
| 3 | 同前置但直连成功：结果照常返回（O6 无升级文案、首行与 v0.2.0 FB-002 呈现一致）；零升级出站；`reason`/日志无「未配置/未执行升级」字样（升级需求未产生）。 | 同 harness，`stepSuccess`；判据：`assertSearchResult` + 全文检索无升级关键词。 | ✅ 同上 |

- 边角（要求句「凭据引用解析失败本身遵守 CFG-002 硬失败/未命中分界」）：`failRefReads` 注入解析抛错 → 不得被吞成「未配置」文案之外的静默；分界行为与既有条目 key 面一致，回归既有 CFG-002 断言，不新增静默面。验证：两形（undefined vs throw）reason 均含「未配置或不可读」但不改变 CFG-002 既有错误归类。✅ 并入用例 2。

## PX-003 作用域：仅直连态条目

| # | 可观察预期（判定标准） | 验证方法 | 自动化 |
| --- | --- | --- | --- |
| 1 | 开关开+全局代理桩可用，同链三条目（直连 E1 / 固定代理 E2 `proxy:"http://own-proxy.invalid:3128"` / PAC E3 脚本对目标返回 `DIRECT`）：向三者注入直连/自身路由故障并各自可升级失败：仅 E1 出现升级出站（O5 存在 `route.viaGlobal` 记录且 proxyUrl 为全局代理）；E2/E3 在全局代理上请求数为零（`callsFor(viaGlobal 且 entry 归属 E2/E3)===0`）。 | 链级 harness 三条目 + 逐条 `stepFail({code:ENTRY_NETWORK})` 后接成功条目兜底；路由归属经 `ctxFor(entryId).fetch` 句柄或 A-PX-1 route 上的条目上下文判别（桩按 backend 调用时的 ctx.fetch 闭包绑定记录实现）。判据：viaGlobal 计数 E1≥1、E2=0、E3=0。 | ✅ `px-oracle-scope.test.js` |
| 2 | E2/E3 自身代理/PAC 失败：错误文本不含升级文案（O8），码仍 `ENTRY_PROXY`/PAC 码并按 FB-001 降级下一条（O7 attempts 原码、链继续）。 | E2 用 `stepFail({code:ENTRY_PROXY})`、E3 用 PAC 码（FB-006 面）；判据：attempts 原码 + reason 无「全局代理升级」关键词 + 后续条目照常执行。 | ✅ 同上 |
| 3 | PAC 判定 `DIRECT` 的 E3 直连失败视同该 PAC 条目自治结果：不触发全局升级。 | 同用例 1 的 E3 注入 transport 网络失败；判据：E3 无 viaGlobal 出站。 | ✅ 同上 |
| 4 | 开关关重放同场景：三类条目出站路径与 v0.2.0 逐请求一致——零 viaGlobal 出站；调用序列（URL+method+route.kind）与 golden 基线一致。 | golden 法：以现 HEAD（无升级语义）先录 `calls.map(url+route.kind)` 序列存 fixture `px003-baseline-switch-off.json`（实现前后各跑一次 deepEqual；录制脚本作为测试内联注释说明，golden 文件入库）。 | ✅（golden 首录由实施在转绿前确认基线，oracle 提供序列形状） |
| 5 | 边界：升级全程不改宿主/OS 代理（要求 2）。 | 静态+行为：面板/链测试中 `globalThis` 代理环境钩子（`https_proxy` 等）计数零修改（node 层以 `process.env` 快照 deepEqual 断言）。 | ✅ 断言并入 scope 测试 |

## PX-004 「直连失败」触发定义与分类边界

| # | 可观察预期（判定标准） | 验证方法 | 自动化 |
| --- | --- | --- | --- |
| 1 | 三例触发：直连条目+开关开+全局代理可用，注入 DNS 解析失败 / TCP 连接被拒 / 连接超时（均 FB-005 `ENTRY_NETWORK` transport 面）：每例升级请求实收到——O5 存在 viaGlobal 记录且其后该条目可成功（`stepFail` 后接 `stepSuccess` 同条目不可用（每条目最多一次供应商提交），故升级成功由全局代理桩侧返回假供应商响应断言；链级简化：升级桩路由 `responds` 有效来源）。 | 链级：`stepFail({code:ENTRY_NETWORK, cause:合成 DNS/拒连/超时错误})` + `fetchFn.when(全局代理).responds(有效响应)`；判据：viaGlobal 计数 ===1、结果成功且含升级状态行（联 PX-007）。 | ✅ `px-oracle-trigger.test.js` |
| 2 | 九例不触发（各零 viaGlobal 出站、FB-005 分类与降级/终止行为不变）：`401/403`（CREDENTIALS）、`402`/额度证据码（QUOTA）、其他 `429`（RATE_LIMITED）、其他 `4xx`（CHANNEL_LIMIT）、`5xx`/非法响应体（BAD_RESPONSE）、条目预算到期（TIMEOUT）、内容策略拒绝（CONTENT_POLICY，终止不降级）、缺凭据（SKIPPED_NO_KEY 跳过）、宿主取消（AbortError 终止）。 | 逐例 `stepFail({code:对应码})` / `stepHang`（TIMEOUT）/ 缺 credentialRef / `AbortController.abort()`；判据：viaGlobal===0 + `assertWebError`/结果与既有 FB 行为一致。 | ✅ 同上 |
| 3 | **lead 显式用例 A（未知兜底触发）**：无阶段无状态码的未知失败——单元层 `classifyUpstreamFailure({})` 与 `classifyUpstreamFailure({error: new Error("unknown")})` 均返回 `ENTRY_NETWORK`（现状绿，钉住）；链层该归因（`stepFail({code:ENTRY_NETWORK, message:"无阶段无状态码合成失败"})`）必须触发升级（viaGlobal===1）——「未知兜底 NETWORK 触发面偏宽」按 lead 裁决显式钉死为规格语义。 | 单元断言 + 链级触发各一例。判据如上。 | ✅ 同上 |
| 4 | **lead 显式用例 B（响应相位反例）**：已到响应相位的失败不升级重发——单元层 `classifyUpstreamFailure({phase:"response"})===ENTRY_NETWORK` 恒不成立（返回 BAD_RESPONSE）；链层 `stepFail({code:ENTRY_BAD_RESPONSE})`、以及桩侧「响应已到达后失败」（`responds(500)` 与 `responds(200)+非法 JSON 体经适配器面模拟为 BAD_RESPONSE 码`）：viaGlobal===0。 | 单元 + 链级两例。判据：分类码非 NETWORK 一律零升级。 | ✅ 同上 |
| 5 | 至多升级一次、不回退：升级路由上再失败（升级桩 `fails`/`responds(401)` 等）：该条目总出站 ≤2（1 直连 + 1 升级，O5 计数）；无第三次出站（无回退直连、无二次升级）；条目以其最终失败落定（attempts 恰一条该条目记录，码 ENTRY_NETWORK，联 PX-008）。 | `fetchFn.when(全局代理).fails(...)`；判据：该条目相关出站计数 deepEqual 直连 1+升级 1、升级后无 direct 再出站（route.kind 序列 `["direct","proxy"]` 收尾）。 | ✅ 同上 |
