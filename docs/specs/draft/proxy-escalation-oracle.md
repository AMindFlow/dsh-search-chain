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
