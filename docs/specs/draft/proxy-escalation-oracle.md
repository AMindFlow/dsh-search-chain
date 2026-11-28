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

## PX-005 升级尝试的预算约束

| # | 可观察预期（判定标准） | 验证方法 | 自动化 |
| --- | --- | --- | --- |
| 1 | 受控时钟：条目预算 1000ms、直连失败耗时 400ms → 升级出站发起时点 ∈ [400, 1000] 内且升级硬限 = 条目预算未消耗时间（`≤600ms` 内完成或被中止）；整链收敛耗时 ≤ `timeoutMs`（O9：`executions()[0]` 的 `at`、viaGlobal 记录 `startedNow - at ≤ 600`）。 | clock 驱动：`stepFail({code:NETWORK, consumeMs:400})` + 升级桩 `responds(delayMs:500)`；判据：startedNow 差值 ≤600、成功返回、`clock.now()-start ≤ timeoutMs`。 | ✅ `px-oracle-budget.test.js` |
| 2 | 直连失败发生在预算到期瞬间（剩余 0）：升级零出站；`attempts[].reason` 含「直连失败；剩余预算不足，未执行全局代理升级」要素（O7/O8）。 | `timeoutMs` 使单条目 `budgetMs=1000`，`stepFail({code:NETWORK, consumeMs:1000})`（advance 至到期）；判据：viaGlobal===0、reason 关键词包含。 | ✅ 同上 |
| 3 | 升级在途时条目预算到期：升级请求被取消（该 viaGlobal 记录 `settled==="aborted"`、`signal.aborted===true`）；行为等同 FB-003 条目到期——迟到结果不改变搜索、剩余预算允许时继续下一条目。 | 升级桩 `hangs()` + clock 拨到条目预算到期；判据如上；（归因码见「上报 lead」#1）。 | ✅ 同上（码断言留 TBD 挂起位） |
| 4 | 升级不改变后续条目预算分配：与无升级基线（开关关同注入）逐毫秒一致（O9 `executions()[i].budgetMs` deepEqual）。 | 同 fixture 跑两态（escalation on/off），比较第二条目 `budgetMs`。 | ✅ 同上 |
| 5 | 总预算不因升级延长；FB-003 分配公式与取消语义不变（要求句回归）：既有 `search-budget.test.js`/`gemini-budget.test.js` 全绿 + 本文件用例 1/4 联合钉住。 | 既有测试纳入回归门。 | ✅ 既有套件 |

## PX-006 条目级钉死三态与对全局策略的优先

| # | 可观察预期（判定标准） | 验证方法 | 自动化 |
| --- | --- | --- | --- |
| 1 | `proxyPin="directOnly"`+开关开+全局代理可用：注入 DNS 失败——全局代理桩零请求（viaGlobal===0）；条目按直连失败落定（attempts 码 ENTRY_NETWORK，reason 无升级段，纯直连形态）。 | 链级 `keyedEntry(id, type, name, {proxyPin:"directOnly"})` + `stepFail({code:NETWORK})`。 | ✅ `px-oracle-pin.test.js` |
| 2 | `proxyPin="proxyOnly"`：请求实经全局代理（viaGlobal===1 且该条目零 `route.kind==="direct"` 出站）；断开全局代理桩（`fails`）——条目失败、`reason` 含「条目钉死仅代理：全局代理不可用/失败」与脱敏目标 `syn-proxy.invalid:8080`、直连零出站（O5 direct 计数 0）。 | 两态：桩 `responds` 成功形 + `fails` 失败形。 | ✅ 同上 |
| 3 | `proxyOnly` 且全局代理解析不可用（引用未配置/凭据缺失）：条目失败、**零出站**（direct 与 viaGlobal 均 0）、原因明示不可用；即使 `proxyEscalation=false` 亦绝不直连（开关与钉死正交，lead 裁决 a）。 | `extraConfig` 开关关 + `proxyPin:"proxyOnly"`、credentialRefs 无该引用；判据：出站总数 0、reason 要素。 | ✅ 同上 |
| 4 | 两闸同拒且定位 `entries[i].proxyPin`：① `proxyPin:"directOnly"` 且同条目带 `proxy`（字符串与 `{pac}` 两形）；② `proxyPin:"bounce"`（三态外任意值）；③ `proxyPin:null`；④非字符串（`0`/`{}`）。错误含条目下标与字段名。合法组合反证：`proxyPin:"inherit"`（显式）+自有 `proxy` 必须通过（不得过度收紧，CFG-W-001）。 | 两闸等价钉样本表（O1/O2 双向全等）+ 文本 `match(/entries\[\d+\]\.proxyPin/)`。 | ✅ `px-oracle-gates.test.js` |
| 5 | 行为基线：`directOnly` 条目与 `inherit`+开关 OFF 条目的网络行为与 v0.2.0 逐位一致——出站序列/状态行/错误文本与 golden 基线 deepEqual（复用 PX-003#4 基线机制）。 | golden 对比。 | ✅ `px-oracle-pin.test.js` + scope 基线 |

## PX-007 升级成功事件的可见性

| # | 可观察预期（判定标准） | 验证方法 | 自动化 |
| --- | --- | --- | --- |
| 1 | 直连注入 DNS 失败+全局代理桩返回有效来源：`content` 首行（O6）同时含实际条目名、「全局代理升级」要素与脱敏目标 `http://syn-proxy.invalid:8080`；`content` 全文、`logCapture` 全部行、任何错误面检索不到 `syn-pass`/`syn-user`/path/query 段（O8 `assertNoSecrets`）。 | 链级触发 fixture（PX-004#1 成功侧）；判据：首行关键词三要素 + 全对象 `collectStrings` 负检索。 | ✅ `px-oracle-visibility.test.js` |
| 2 | 未经升级的直连成功：首行无升级字样，与 v0.2.0 FB-002 呈现一致（无失败前序时甚至无标注行）。 | 同 fixture 开关关形态；判据：首行不含「升级」，结果 deepEqual 基线。 | ✅ 同上 |
| 3 | 升级成功时 `sources` 与同结果无升级基线逐字段一致（deepEqual，含顺序）；升级信息不进 `sources`（无新增字段）。 | 两态 sources deepEqual + 键集检查。 | ✅ 同上 |
| 4 | 调试日志记录升级事件：含条目 id 与脱敏目标（scheme://host:port），不含 userinfo（O8）。 | `logCapture.lines.some(含 entryId && 含 syn-proxy.invalid:8080)` + `assertNoCredentialUserinfo`。 | ✅ 同上 |

## PX-008 升级失败事件的可见性与终态归属

| # | 可观察预期（判定标准） | 验证方法 | 自动化 |
| --- | --- | --- | --- |
| 1 | 直连失败+升级路由连接被拒+链上仅一条目：终态 `WebError.details.attempts` 恰 1 条记录（不是两条），`code==="ENTRY_NETWORK"`（不压 `ENTRY_PROXY`，lead 裁决 c），`reason` 双段：含直连失败事实 + 「经全局代理升级仍失败」要素 + 脱敏目标；不含认证信息（O7/O8 `assertWebError` 强化断言）。 | 链级 fixture：`stepFail({code:NETWORK})` + 全局代理桩 `fails`；判据：`attempts.length===1`、码、reason 关键词双段、`assertNoSecrets`。 | ✅ `px-oracle-visibility.test.js` |
| 2 | 该条目为前序、后继条目成功：FB-002 接管提示对该条目的一字概括含「升级失败」要素（O6 首行接管标注素材来自 PX-008 概括而非纯「网络失败」）。 | 两条目链：E1 升级失败、E2 成功；判据：首行含 E1 名+「升级失败」。 | ✅ 同上 |
| 3 | 对比态（开关关同注入）：`attempts[0].reason` 无升级字样；两态 reason 可区分（字符串不等且升级态多升级段）——升级与否不产生静默。 | 两态对比断言。 | ✅ 同上 |

## PX-009 存量迁移与 v0.2.0 行为逐位一致

| # | 可观察预期（判定标准） | 验证方法 | 自动化 |
| --- | --- | --- | --- |
| 1 | v0.2.0 真实形态存量 fixture（直连/固定代理/PAC 三态 + 超时 + 官方开关，无三新键）跑 v0.3.0 读闸与整链：读闸输出等价「`proxyEscalation=false`、`globalProxy` 省略、全部条目 `proxyPin="inherit"`」（O1）；整链行为逐位一致——出站路径序列（URL+route.kind）、重试次数、`budgetMs` 分配、`content` 首行、错误文本与既有 golden/既有断言一致；零升级出站、无新状态行。 | fixture `px009-legacy-config.json`（自 `settings-panel-v02.fixtureEntries` 扩三网络态）；读闸 deepEqual；链级 golden 基线（PX-003#4 机制）；既有 v0.2.0 面测试（search-order/budget/terminal、network-contract）全绿作为逐位一致回归门。 | ✅ `px-oracle-legacy.test.js` |
| 2 | 存量快照「读出→保存」round-trip：`writeConfig` 后 override 层与读出快照 diff 仅允许新增显式默认键（`proxyEscalation:false` 和/或条目 `proxyPin:"inherit"`，若有），既有键值零变化（含他插件顶层键与条目未知标量键原样保留）。 | `createHostShapeFakeHost` 行层 before/after deep-diff 工具函数：违规路径列表必须 ⊆ 新增默认键集。 | ✅ 同上 |
| 3 | 降级回滚无错：以 v0.3.0 开启升级并保存后的 override 层（含 `proxyEscalation:true`、`globalProxy`、条目 `proxyPin`）喂 v0.2.0 读闸——前提实证已证（下节）：无 `CONFIG_INVALID`、行为回退 v0.2.0（顶层未知键不进输出→开关被忽略、零升级）。他插件顶层键经 v0.2.0 `writeConfig` 保存原样保留。仓库内自动化用近似面：现读闸（含新键后）对非本包顶层键的保留断言（OWN_CONFIG_KEYS 扩展不含他插件键）+ 本前提一次性实证脚本引用。 | 前提实证（一次性，已完成）+ 仓库内保留断言用例。 | ✅（近似）+ 实证记录 |

### PX-009 前提（lead 新增必验项）——实证结论：**成立**（非阻塞）

- 方法：`git show v0.2.0:src/config.js` 与 `src/constants.js` 提取至 `/tmp/px009-probe-88/`（仓库零残留），tag `v0.2.0` 解引用 `a603a5b8`（与规格所指一致），node 实跑 `normalizeConfig`/`writeConfig`（桩 settings 端口）。
- 输入：顶层 `proxyEscalation:true`、`globalProxy:"search_chain_global_proxy"`、`foreign_plugin_key:{nested:"keep me"}`；条目 `proxyPin:"directOnly"/"proxyOnly"`（字符串三态值）。
- 结果（实测记录）：
  1. **顶层未知键**：`normalizeConfig` 不报错；输出键集仍为 `entries,useOfficialDeepSeekSearch,timeoutMs`——未知顶层键被忽略、不进归一化输出 ⇒ v0.2.0 行为回退升级前语义（开关/引用被无视，零升级）。
  2. **条目未知标量键**：`proxyPin` 字符串值透传保留进归一化条目（`entry.proxyPin` 原值），v0.2.0 链不消费 ⇒ 无行为影响、无报错。
  3. **降级保存键保留**：v0.2.0 `writeConfig` 整体替换仅删 `OWN_CONFIG_KEYS=[entries,useOfficialDeepSeekSearch,timeoutMs]`；override 层 `proxyEscalation`、`globalProxy`、`foreign_plugin_key` 实跑后原样保留，零丢失。
  4. 边角：未知键值为**对象**时被 v0.2.0 条目标量透传循环静默丢弃（不报错）。三新键合法形态（布尔/字符串）不落此形，不碍降级；v0.3.0 闸本身拒绝对象形态 `proxyPin`，无脏数据通道。
- 结论：PX-009 所依赖「v0.2.0 读闸对未知顶层/条目键透传/忽略」前提成立，条款无需改写。

## PX-010 出网承诺文案

| # | 可观察预期（判定标准） | 验证方法 | 自动化 |
| --- | --- | --- | --- |
| 1 | 本仓库用户面文案：旧口径「配了代理永不静默回退直连」「绝不静默换路径」不再以孤立形态出现（出现处必须以「出网路径改变都可见」为上位表述）；README headline 或特性区存在新口径句且含三要素：默认关闭、可钉仅直连/仅代理、升级事件可见。 | grep 断言：旧句检索 → 命中行须同段含上位表述；新句关键词组合（`默认(关闭|OFF)`、`仅直连|钉`、`可见`）在 README 顶部/特性区命中。落为 `px-oracle-copy.test.js` 文本用例（实现前红）。 | ✅（关键词级）+ 人工审（孤立形态判定）⚠️ |
| 2 | 无夸大表述：改动句不得含「默认开启」「自动全条目」类与 PX-001/PX-003/PX-006 矛盾的措辞。 | grep 负例清单（`默认开启`、`自动.*全部?条目`）。 | ✅ |
| 3 | 改动面最小：diff 仅触及出网承诺直接相关句；#102 合入前 README 其余章节零改动。 | PR diff 审阅项。 | ❌ 人工（交付记录注明） |

## PX-011 设置 UI：全局升级区块

| # | 可观察预期（判定标准） | 验证方法 | 自动化 |
| --- | --- | --- | --- |
| 1 | 全新安装：区块显示开关 OFF、全局代理「未配置」（O10）；拨开关不配地址保存——区块内 `role="alert"`（`data-role="save-error"`）可读错误、草稿（开关态）保留、`fetchStub.mutates()===0 && credentialSets()===0`（PX-002 拒绝路径 + CFG-W-004 零凭据）、`outbound` 零、供应商/代理出站零。 | 面板 harness 全新 `makeSettingsState`（无升级键）；A-PX-2 锚点定位。 | ✅ |
| 2 | 保存带认证合成 URL 成功后：状态指示脱敏 `http://syn-proxy.invalid:8080`；重开面板输入框无回显（value 空，O10 `leaksIn` 负检索）；`mutates()` 请求体无明文（`collectStrings` 无 `syn-pass`/`://`）；`credentialSets()` 恰 1 且收到原值恰一次（O4）；次序 `credentials/set`.seq < `settings/mutate`.seq（凭据先写）。 | 面板保存流 + `calls[].seq` 次序断言。 | ✅ |
| 3 | 非 HTTP(S) 输入（`ftp://syn-proxy.invalid`、无 scheme `syn-proxy.invalid:8080`）：拒绝保存、错误定位「全局代理」字段、草稿保留、零 mutate（语法校验面，SET-004 零出站）。 | 输入注入 + 保存；判据：`saveError` 文本含「全局代理」、草稿值保留。 | ✅ |
| 4 | 写闸拒绝「开关开+无有效全局代理」错误在区块内呈现（PX-002 联动）：错误锚点存在且与成功提示互斥（无 `data-role="save-status"`）。 | 并入用例 1 断言。 | ✅ |
| 5 | 面板对代理零连通性探测：全程 `outbound` 中无任何对全局/条目代理地址的请求。 | `outbound` 检索 `syn-proxy` 为空。 | ✅ |

## PX-012 设置 UI：条目卡钉死控件

| # | 可观察预期（判定标准） | 验证方法 | 自动化 |
| --- | --- | --- | --- |
| 1 | 新建直连条目：钉死单选默认选中「继承」（O10 `pin-inherit` checked）；改「仅代理」保存后卡片出现徽标（`pin-badge` 文本「仅代理」）、宿主条目 `proxyPin:"proxyOnly"`；重开编辑器回读选中「仅代理」。 | 面板交互流 + `state.user.entries[i]` 断言 + 重挂载回读。 | ✅ |
| 2 | 已配固定代理 / 已配 PAC 的条目：钉死控件不可交互（禁用或隐藏），界面呈现「已配置自有代理，钉死不适用」；对其保存不产生 `proxyPin` 字段（落盘条目无该键）。 | 两态条目 fixture；`node.disabled===true || 不存在`；保存后键集断言。 | ✅ |
| 3 | 编辑他条目/拖动排序不改变已存钉死值（O3 ops 不含无关条目 `proxyPin` 变更）；面板全程供应商出站计数零（SET-004，`chainTrap.calls.length===0` + `outbound` 无供应商 URL）。 | 离散操作后 ops 检索 + 陷阱计数。 | ✅ |
| 4 | 直写注入矛盾组合（条目带 `proxy` + `proxyPin:"directOnly"`）：面板读取不崩溃（view 正常渲染、该条目钉死控件按 PX-011 状态呈现矛盾提示或按写闸同口径禁用）、任何保存路径被写闸拒绝且错误定位该条目（`entries[i].proxyPin`）。 | `state.user` 预置矛盾条目 → open 面板 → 触发任一保存；判据：不抛未捕获错、`saveError` 定位。 | ✅ |

## lead 显式用例对账

| 指定项 | 落点 | 状态 |
| --- | --- | --- |
| 未知兜底错误（无阶段无状态码）触发升级 | PX-004 #3（用例 A）+ `px-oracle-trigger.test.js` | 已列 |
| 已到响应相位的失败不升级（反例） | PX-004 #4（用例 B）+ 同上 | 已列 |
| PX-009 前提实证（v0.2.0 实跑） | 「PX-009 前提」节：结论**成立** | 已完成 |
| 升级至多一次不回退不二次 | PX-004 #5 | 已列 |
| 保留 ENTRY_NETWORK 归因（裁决 c） | PX-008 #1 显式断言不压 `ENTRY_PROXY` | 已列 |

## 上报 lead（规格歧义/裁决请求，Oracle 不擅自裁决）

1. **PX-005 #3 与 PX-008 交叠的归因码**：升级在途时条目预算到期——PX-008 要求升级失败维持 `ENTRY_NETWORK` 双段 reason，FB-003 条目到期面为 `ENTRY_TIMEOUT`。请裁决该形归 `ENTRY_NETWORK`（reason 注明预算到期）还是 `ENTRY_TIMEOUT`（PX-008 双段仅覆盖非预算类升级失败）。oracle 骨架在 `px-oracle-budget.test.js` 对应用例先钉不变式（升级请求被取消、零迟到采纳、预算不延长），码断言处注释 `PX-008/005 交叠待裁决`，不做断言。
2. **A-PX-1 观测形态**：升级出站以 `init.route.viaGlobal` 判别为 oracle 假设；若实现选其他可判别形态（如 route 带 `globalRef`），须按 contract.js 规则在实施 PR 同步 `contract.js`/本文件，oracle 用例随之机械替换。请确认该假设可入 contract.js A4 扩展。
3. **PX-010 #1「孤立形态」**属语义判定，grep 自动化只到关键词级，终态以人工审阅收口（交付记录注明），确认此验收分工即可。

## 骨架测试清单与自动化统计

| 文件 | 覆盖条款 | 用例数（test()） |
| --- | --- | --- |
| test/px-oracle-gates.test.js | PX-001#1/#4、PX-002#1（闸层）、PX-006#4 | 8 |
| test/px-oracle-misconfig.test.js | PX-002#2/#3 | 4 |
| test/px-oracle-scope.test.js | PX-003#1–#5 | 4 |
| test/px-oracle-trigger.test.js | PX-004#1–#5（含 lead A/B） | 15 |
| test/px-oracle-budget.test.js | PX-005#1–#4 | 4 |
| test/px-oracle-pin.test.js | PX-006#1–#3/#5 | 6 |
| test/px-oracle-visibility.test.js | PX-007#1–#4、PX-008#1–#3 | 7 |
| test/px-oracle-legacy.test.js | PX-009#1/#2/#3（近似面） | 4 |
| test/px-oracle-copy.test.js | PX-010#1/#2（文本 grep） | 2 |
| 面板层（PX-001#2/#3、PX-002#1、PX-011、PX-012） | 复用 settings-panel-v02 harness | 实施 PR 内随 SET-006/007 锚点补齐（本包不建 UI 桩件，避免与面板工作包碰撞；判定标准以本文矩阵为准） |

条款×用例计数（运行态，循环展开后）：PX-001:2、PX-002:3、PX-003:4、PX-004:15、PX-005:4、PX-006:5、PX-007:4、PX-008:3、PX-009:4、PX-010:2；运行态 test 共 53（22 条现状语义钉实现前即绿、31 条要求新行为实现前跑红；面板层另计）。可自动化 ✅=全条目除 PX-010#3（人工）与 PX-001#5 CONNECT 正证（集成层）。
