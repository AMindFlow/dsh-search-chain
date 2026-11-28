# 多 key 池轮替 · 测试 Oracle（工作包 #86）

> 性质：**测试 Oracle**——只从规格推导「可观察期望 + 验证方法」，不含实现。
> 来源规格：`key-pool.md`（POOL-001…010 及修订注）、`config-write-gate.md`（CFG-W-001…004 +
> POOL 修订矩阵）、`config-network.md`（CFG-002/004 + WP7 层序裁决）、`fallback.md`
> （FB-001…006 + FB-001 修订注）、`settings-ui.md`（SET-002/004/005/006/008）。
> 采纳记录：lead 对 gate-1 审阅（PR #105）批准——池上限 8、共存/带池无 key 均 fail-closed、
> 惰性迁移、POOL-006 规范文案「全部 N 把 key 失败」「已使用第 N/M 把 key」；
> schemastery 数组节点 role 缺省 → 面板数组投影列为发布阶段宿主实机项。
> 运行：`node --test --test-timeout=30000 test/`（pool 骨架实现前跑红属预期，见 §7）。

## 0. 观测面与方法论

| 观测面 | 载体 | 用于 |
| --- | --- | --- |
| 读闸结论/归一化输出 | `normalizeConfig`（src/config.js）返回或抛出 | POOL-001/003/010 双闸等价 |
| 写闸结论/ops 与落盘字节 | `Component.contract.validate/toOps` + 面板 state.user 回放 | 同上 + POOL-002/008/009 |
| 出站计数与鉴权头 | `fake-fetch.calls[i].headers.authorization` | POOL-004/005/006/007/010（哪把 key、几次） |
| attempts / reason | `WebError.details.attempts[]`（含池扩展 `pool` 明细，假设 A1） | POOL-006 归因与文案 |
| content 首行 | 成功结果 `content` 第一行 | FB-002 接管提示 + 「已使用第 N/M 把 key」标注 |
| 面板数据面 | `fetchStub.mutates()/credentialSets()/credentialCalls()/outbound` | POOL-002③/008/009（写序、计数、零出站） |
| 凭据读取留痕 | `fake-credentials.resolveCalls/totalReads` | POOL-007 层序与不重读 |
| 日志面 | `createLogCapture().text()` + 合成 key 正则 | 脱敏（POOL-006③、全局安全面） |
| 受控时钟 | `chain-harness` 注入 `createControlledClock` | POOL-005 预算窗口，零真实等待 |

层级图例：**[U]** unit 可自动化（本仓 node:test）；**[H]** 宿主实机项（本仓不可达，发布阶段验证）；
**[R]** review 项（代码/文案走查，不写断言）。

安全基线（全条款通用）：所有池场景的合成 key 明文（`sk-synthetic-*`、`sk-TEST-*`）对
「渲染树 props+文本、mutate/credential 请求体 value 载荷、日志、attempts/content」正则不可命中
（面板草稿输入值是唯一豁免，保存成功后豁免收回——SET-008）。

## 1. POOL-001 配置形态（credentialRefs 数组）

| # | 可观察期望 | 验证方法 | 层级 |
| --- | --- | --- | --- |
| 1.1 | `credentialRefs: ["A","B"]` 两闸都接受；归一化保留数组、trim 后原顺序 | 两闸等价矩阵行 A-2/A-3 + 归一化输出 deepEqual | [U] |
| 1.2 | 与 `credentialRef` 共存 → 两闸都拒绝，文案含「互斥」（规范要素） | 矩阵行 R-10；两闸结论相等 + /互斥/ | [U] |
| 1.3 | 空数组 `[]` = 省略该键（形态归一） | 矩阵行 A-6 + 归一化 deepEqual 与省略形态一致 | [U] |
| 1.4 | 单元素数组 = 合法（1 元池） | 矩阵行 A-2 | [U] |
| 1.5 | 非数组（null/字符串/数字）→ 拒「必须是数组」；元素非非空字符串 → 拒并定位 `entries[i].credentialRefs[j]` | 矩阵行 R-4…R-9 | [U] |
| 1.6 | 双闸等价（CFG-W-001）：任意同一形态，两闸 接受/拒绝 结论必须相等 | `GATE_MATRIX` 19 行 × 双向断言 `okRead === okWrite` | [U] |
| 1.7 | 面板对数组字段的 schemastery 投影（增删行控件渲染） | 宿主实机（role 缺省下的数组编辑器可达性/可操作性） | [H]（gate-1 批准：发布阶段） |

## 2. POOL-002 存量单引用 = 1 元池（零感知迁移）

| # | 可观察期望 | 验证方法 | 层级 |
| --- | --- | --- | --- |
| 2.1 | 升级后读闸不补写 `credentialRefs` 键、不动 `credentialRef` | v0.2.0 fixture 过 normalizeConfig：`"credentialRefs" in entry === false`、输出序列化不含池键 | [U] |
| 2.2 | 启动+一次搜索磁盘**逐字节一致**：键序与内容均不变 | tmp 快照 stringify 前后对比 + `Object.keys` deepEqual（无写路径介入） | [U] |
| 2.3 | 面板仅打开/渲染/卸载：`settings/mutate` 调用数 0，state.user stringify 不变 | installSettingsFetch 留痕 + 字节对比 | [U] |
| 2.4 | 401/429/网络失败注入：attempts 分类码/reason 正则/出站数 = v0.2.0 基准（/key 是否有效/、/限流/、/直连网络失败/）；reason 不含「全部 N 把」 | issuing 后端逐形态注入 + 基准正则 + doesNotMatch 池字样 | [U] |
| 2.5 | 单 key 失败文案与池耗尽文案**可区分**（后者必含「全部 N 把 key 失败」） | 两条 reason 各自正则互斥断言 | [U] |
| 2.6 | 惰性迁移：编辑存量条目（不带新 key）保存 → 该条目落盘 `credentialRefs: ["TAVILY_KEY_A"]` + **同提交附带字段级 unset** `credentialRef`；`credentials/set` 数 0；其余条目 stringify 逐字节不变 | 面板改名→提交：ops 中 set(credentialRefs)+unset(credentialRef)、state.user 断言、beforeOthers 对比 | [U] |
| 2.7 | 迁移不新增 `credentials/set`、不读真实 key（引用原样迁入数组） | 2.6 同一断言面 | [U] |
| 2.8 | 既有全套零修改全绿（零感知硬界） | `node --test test/` 基线 879/879（Oracle 编写时点） | [U] |

## 3. POOL-003 池规模上限与去重

| # | 可观察期望 | 验证方法 | 层级 |
| --- | --- | --- | --- |
| 3.1 | 8 元数组两闸接受（上限内） | 矩阵行 A-5 | [U] |
| 3.2 | 9 元两闸拒绝，文案同时含**实际数量 9** 与**上限 8**（/9/ ∧ /8/）+ 定位 | 矩阵行 R-3：`/9/`、`/8|上限/` 双正则 | [U] |
| 3.3 | trim 后重复（相邻/非相邻）两闸拒绝，文案含「重复」 | 矩阵行 R-1/R-2 | [U] |
| 3.4 | 写闸 `toOps` 对非法池抛 CONFIG_INVALID 类错误（不落半态） | 直调 contract.toOps 抛错正则 | [U] |
| 3.5 | 面板重复引用提交 → 可见定位报错（role=alert）+ `credentialSets` 0 + `settings/mutate` 0（CFG-W-004 先校验后凭据） | panel dup 用例（键值派生重复面）+ gates 面板矩阵（磁盘注入 3 形态） | [U] |
| 3.6 | 第 9 把槽位不可达：8 槽可用；第 9 次「新增」不产生第 9 输入框且（禁用按钮或可见提示） | panel cap 用例（按钮 disabled / 槽数封顶 / 错误可见三态兼容） | [U] |
| 3.7 | stripSecrets 深度覆盖数组内元素（CFG-W-003 修订） | gates POOL-008② 用例：ops value 载荷 `secretPathsIn` 深查零 apiKey | [U] |
| 3.8 | 「上限 8」为常量：变更须同步规格（治理） | 代码走查：上限常量单点定义 | [R] |

## 4. POOL-004 轮替触发集与顺序

| # | 可观察期望 | 验证方法 | 层级 |
| --- | --- | --- | --- |
| 4.1 | 401/429/402（或等价 quota/rate 证据码归一后）→ 换下一把重试；成功结果来自该把 key | rotation ①②③：出站恰 2 次 + 第 2 次鉴权头 = 池序第 2 把 + sources 计数 | [U] |
| 4.2 | 网络/代理/超时/渠道过载/坏响应（ENTRY_NETWORK/PROXY/TIMEOUT/CHANNEL_LIMIT/BAD_RESPONSE）→ **不换 key**，按 FB-005 归类降级 | rotation ④（network）：出站恰 1、次 key 零尝试、attempts code = NETWORK | [U] |
| 4.3 | ENTRY_CONTENT_POLICY → 零轮替且整链终止（FB-001 终止类） | rotation ⑦：出站 1、`CHAIN_CONTENT_POLICY`、后续条目零调用 | [U] |
| 4.4 | 明确无结果 → 不换 key，继续下一条目（非池耗尽） | rotation ⑤/空结果停止轮次：出站止步于空结果那次、C 零尝试、结果由下一条目接管 | [U] |
| 4.5 | 每次搜索起始恒为池头（无跨查询偏移记忆） | rotation 起始恒为池头：同链两次搜索，第 2 次首出站鉴权头 = key A | [U] |
| 4.6 | 每把已解析 key 至多提交一次（FB-001 修订注）；全 401 无第三轮 | rotation ⑥：出站 = 候选数、每 key 恰一次、条目终态一条记录 | [U] |
| 4.7 | 池内引用解析未命中（absent/空白）不占轮次、不产生「空 key 提交」 | rotation absent 用例：首出站即命中把，无空 Authorization 出站 | [U] |
| 4.8 | 已解析出 key 后首次查询命中，本次搜索不再查询其他层（CFG-002 选中即定层） | layers ②：池命中后 resolveCalls 不含 env 名、总读取 = 池候选数 | [U] |
| 4.9 | 轮替全程日志无 key 明文 | rotation 安全面：logCapture 正则不可命中 | [U] |
| 4.10 | 每 key 一次 `open→search→close` 的 transport 句柄生命周期 | 代码走查（句柄复用属未来优化，不作断言） | [R] |

## 5. POOL-005 轮替预算（FB-003 边界）

| # | 可观察期望 | 验证方法 | 层级 |
| --- | --- | --- | --- |
| 5.1 | 条目预算 = 原 FB-003 公式（分母 = 启用条目数），**不因池 >1 把改变**；3 把全落在同一预算窗口 | budget ①a：首把 `ctx.budgetMs === timeoutMs/条目数`；池条目窗口恰 = 预算值 | [U] |
| 5.2 | 预算到期：在途请求取消、出站止步、不追加轮换重试 | budget ①a：第 3 把零出站、在途 call `aborted === true` | [U] |
| 5.3 | 到期归因 ENTRY_TIMEOUT（非池字样）；未尝试 key 数可见 | budget ①b：attempts.code=TIMEOUT + `pool={size,tried,...}` 明细（假设 A1）| [U] |
| 5.4 | 降级下一条目：预算与顺序按原 FB-003 口径，不受前条目轮替影响 | budget ①a：bing `budgetMs` 与 `at` 时刻断言 + FB-002 接管提示正则 | [U] |
| 5.5 | 轮替途中宿主取消：在途取消、**后续出站 0**、整链 AbortError 拒绝 | budget ②：手动 abort 出站数冻结 + `err.name === "AbortError"` | [U] |
| 5.6 | 回归：单引用条目出站次数/顺序 = v0.2.0（FB-001「每条目一次」原文仍适用） | budget ③ executions 序列 | [U] |
| 5.7 | 真实计时器下的预算表现（宿主 abort 时序） | 宿主实机（受控时钟已覆盖逻辑边界） | [H] |

## 6. POOL-006 池耗尽归因与轮替事件可见

| # | 可观察期望 | 验证方法 | 层级 |
| --- | --- | --- | --- |
| 6.1 | 耗尽时该条目 attempts **恰一条**终态记录；reason 含「全部 N 把 key 失败」（N=已尝试候选数） | exhaust ①：长度 + /全部\s*3\s*把\s*key\s*失败/ | [U] |
| 6.2 | 逐 key 明细：池内序号（1 起）+ FB-005 分类码，随 attempts 暴露且脱敏 | exhaust ①：`pool.outcomes` deepEqual `[[1,CREDENTIALS],[2,RATE_LIMITED],[3,QUOTA]]`（假设 A1） | [U] |
| 6.3 | 单 key 失败与池耗尽文案可区分：单 key = v0.2.0 基准正则，无池字样；1 元池亦无 | exhaust 单 key/1 元池两用例：doesNotMatch /全部\s*\d+\s*把/ | [U] |
| 6.4 | 换 key 成功后 content 首行冠「已使用第 N/M 把 key」（FB-002 同渠道） | exhaust ②：首行 /已使用第\s*2\/3\s*把\s*key/；成功后第三把零出站 | [U] |
| 6.5 | 每次 key 切换产生恰一条脱敏链日志事件（事件数 = 切换次数、含条目定位） | exhaust ③：logCapture 过滤「轮替」计数 1/2 + entryId 定位（假设 A7） | [U] |
| 6.6 | 明文对 attempts/content/日志正则不可命中 | exhaust ③：全表面 JSON 序列化扫描 | [U] |
| 6.7 | 文案在宿主 UI 的实际渲染可读性 | 宿主实机（schemastery/卡片渲染） | [H] |

## 7. POOL-007 凭据分层与不轮替层

| # | 可观察期望 | 验证方法 | 层级 |
| --- | --- | --- | --- |
| 7.1 | 池内全 absent → 下层（env→托管→旧版 YAML）按 CFG-002 层序兜底**单 key**；401 后不回头重试池引用、不降层再试 | layers ①：出站 1 + 鉴权头 = env key + resolveCalls 每池引用恰 1 次 | [U] |
| 7.2 | 池命中后 env/托管另有 key → 下层零参与：resolve 不读 env 名、出站 = 池候选数 | layers ②：resolveCalls 不含 `OPENAI_API_KEY` + `totalReads() = 2` | [U] |
| 7.3 | 池耗尽不得引发凭据层重新读取/重新降级（每层每搜索至多一次） | layers ②/②b 计数断言 | [U] |
| 7.4 | bing 等免 key 条目：`credentials.resolve` 调用计数 0 | layers ③：resolveCalls.length 0 | [U] |
| 7.5 | 回归：旧单引用逐层解析与 v0.2.0 一致（absent ref→env 命中即停，托管零读取） | layers ④：resolveCalls deepEqual + 鉴权头 | [U] |
| 7.6 | 旧版 YAML 兜底层在宿主环境的真实命中 | 宿主实机（本仓以 fake-credentials 引用空间近似） | [H] |

## 8. POOL-008 写闸与面板安全

| # | 可观察期望 | 验证方法 | 层级 |
| --- | --- | --- | --- |
| 8.1 | 写闸（contract.validate）池规则 = 读闸（§1/§3 矩阵，双向等价） | gates 矩阵 | [U] |
| 8.2 | 面板对磁盘 3 种坏池形态（refs 非数组/共存/bing 带池）逐条目离散保存：save-error role=alert + `mutates` 0 + `credentialSets` 0 + 出站 0 | gates 面板拒绝形态用例（CFG-W-004） | [U] |
| 8.3 | 合法池形态保存：ops value 载荷深层零 secret 键（stripSecrets 数组覆盖）、credentialRefs 完整落盘、不复活 credentialRef | gates POOL-008② | [U] |
| 8.4 | 池编辑器 write-only：任何时刻明文只存在于当前草稿输入框 value；关闭即零驻留 | panel leak/rejected（leaksIn 豁免面） | [U] |
| 8.5 | `toOps` 拒绝形态抛错不落半态 | gates toOps 用例 | [U] |
| 8.6 | 宿主对 settings/mutate 坏 ops 的原子性（服务端零半写） | 宿主实机 | [H] |

## 9. POOL-009 设置面板池编辑

| # | 可观察期望 | 验证方法 | 层级 |
| --- | --- | --- | --- |
| 9.1 | 新增填 2 把保存：`credentials/set` 恰 2 次、落盘 `credentialRefs` 顺序 = 录入顺序、`settings/mutate` 恰 1 次（SET-005 修订：1 配置写 + N 凭据写） | panel add 用例（set body 含对应引用、数组顺序 deepEqual） | [U] |
| 9.2 | 移除槽位保存：`credentialRefs` = 剩余顺序数组；`credentials/unset` 计数 0（孤儿引用不回收） | panel remove 用例 | [U] |
| 9.3 | 每引用一槽、write-only（值空、引用名不回显） | panel reopen 用例 | [U] |
| 9.4 | 凭据写入被拒：save-error role=alert 恰 1、编辑器保持打开、草稿驻留、`mutates` 0 | panel rejected 用例 | [U] |
| 9.5 | 卡片凭据状态显示池规模（「N 把」）；重复/第 9 把可见定位报错（§3.5/3.6） | panel add/cap/dup 用例 | [U] |
| 9.6 | 面板全程零供应商/外部出站（SET-004） | outbound.length 0 | [U] |
| 9.7 | DOM 锚点命名（key-add/key-remove/每槽一输入）与可访问性（alert、focus、键盘） | 假设 A3 + 宿主实机可访问性抽查 | [H] |
| 9.8 | 视觉样式符合 style-lock v2（Oracle 只钉数据面） | 设计走查 | [R] |

## 10. POOL-010 免 key 形态与池共存

| # | 可观察期望 | 验证方法 | 层级 |
| --- | --- | --- | --- |
| 10.1 | bing + 非空池两闸拒绝（文案含 bing/免 key 要素）；bing + `[]` 接受 = 等同 v0.2.0 | 矩阵行 R-11/A-7 | [U] |
| 10.2 | bing 搜索全程 `credentials.resolve` 0 次 | layers ③ | [U] |
| 10.3 | bing 编辑器无 key/credentialRef 输入、无 key 槽位动作 | panel bing 用例 | [U] |
| 10.4 | bing 真实免 key 通道零 Authorization | bing-* 既有适配测试面（本 Oracle 引用不重写） | [U] |

## 11. 统计与骨架清单

- 骨架文件（node:test，实现前跑红属预期）：

| 文件 | 用例数 | 现状（实现前） |
| --- | --- | --- |
| test/pool-oracle-gates.test.js | 5 | 1 绿（POOL-008③ 回归）/ 4 红 |
| test/pool-oracle-migration.test.js | 5 | 4 绿（零感知基线即现状）/ 1 红 |
| test/pool-oracle-rotation.test.js | 10 | 0 绿 / 10 红 |
| test/pool-oracle-budget.test.js | 4 | 1 绿（FB-003 回归）/ 3 红 |
| test/pool-oracle-exhaust.test.js | 5 | 1 绿（单 key 基准）/ 4 红 |
| test/pool-oracle-layers.test.js | 5 | 3 绿（②b/③/④ 回归钉）/ 2 红 |
| test/pool-oracle-panel.test.js | 8 | 2 绿（③/10.3 现状一致）/ 6 红 |
| 共享套件 test/helpers/pool-oracle-kit.js | — | 会真实出站的薄适配器 + 脚本路由 + 脱敏断言 |

- 合计 42 用例：**30 红（POOL 新行为）+ 12 绿（回归钉/现状基线）**；既有全套 879/879 绿，零修改。
- 两闸矩阵规模：**19 行 × 双向结论相等 + 归一化/文案要素断言**（接受 7 + 拒绝 12）。
- 条款覆盖：POOL-001…010 验收子项映射 **71 项**（§1–§10 表行）。
- 三档分布：**[U] 62 / [H] 6 / [R] 3**。

## 12. 歧义上报（提交 lead 裁决，Oracle 不擅自定案）

| # | 歧义 | Oracle 临时取定 |
| --- | --- | --- |
| A1 | attempts 池明细字段名/形状未钉规格 | 暂按设计决定「实现建议」`pool={size,tried,outcomes:[{index,code}]}` 断言；改名须同步 budget/exhaust 骨架 |
| A2 | 「全部 N 把」N = 池总数还是已尝试数（absent 项占比时） | 取**已尝试候选数**（POOL-006①「N=实际尝试过的候选数」原文） |
| A3 | 面板槽位 DOM 锚点命名未钉 | 暂用 key-add/key-remove/每槽 data-field="key"；实装命名不同则同步 panel 骨架 |
| A4 | FB-002 接管提示与「已使用第 N/M 把」同行叠加时的首行格式 | 只断言两个子串各自存在于首行，不钉拼接顺序 |
| A5 | 「已使用第 N/M」M = 池规模还是可解析数（含 absent） | 取池数组长度 M（对用户可核对） |
| A6 | 池化后 `credentialRef` 在 MANAGED_ENTRY_KEYS/toOps 白名单的去留 | 按惰性迁移口径：unset 合法、不接受共存（矩阵 R-10 已钉） |
| A7 | 轮替日志事件的可识别标记未钉 | 暂以日志 message 含「轮替」+ details 含 entryId 计数；实现换标记词则同步 exhaust ③ |

## 13. 运行与红线

- 单文件：`node --test --test-timeout=30000 test/pool-oracle-<name>.test.js`；全套 `npm test`。
- 零真实网络/零真实等待：一切出站经 fake-fetch、一切时间经受控时钟；合成 key 面 `sk-synthetic-*`/`sk-TEST-*`。
- 实现 PR 不得修改本 Oracle 骨架的断言语义；规格文案/字段更名须同一 PR 内同步骨架并留痕。
