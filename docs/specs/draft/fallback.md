# 搜索顺序、预算与错误

本规格适用于自定义搜索链。是否进入自定义链由 [DSH-005](dsh-integration.md#dsh-005-deepseek-官方-api-路由)决定。

## FB-001 自定义顺序与降级条件

- **要求** 每次搜索以当前已保存列表为准，从上到下串行尝试。已停用及缺少所需 key 的条目须跳过，出站请求数为零。每个条目最多向其供应商提交一次查询。列表中同型条目以各自 ID 区分。
- **要求** 第一个返回有效来源的条目结束搜索。当前条目确认无结果、通道超时或出现 [FB-005](#fb-005-失败分类与排查提示)的可降级失败时，在总预算内继续下一条。宿主取消、总预算耗尽或明确的上游内容策略拒绝须分别终止。宿主判定查询无效时无出站请求。
- **来源** [原始需求 R5、R6及新版可排序和停用需求 R9](../../project/requirements.md)。
- **验收** 配置三个不同结果的条目，置换任意供应商的顺序并关闭中间项。核对实际请求与已保存列表一致，首个有效结果停止后续调用。另用同型条目、缺 key、网络失败和拒绝响应验证分支。

## FB-002 成功结果与提示

- **要求** 有效来源必须有可解析的绝对 HTTP(S) URL，标题和摘要按适配规格提供。适配器返回全量映射来源，不得按 `maxResults` 本地切片；截断与 `truncated` 置位由插件边界（搜索链）对成功条目的结果统一执行。链须按成功条目的结果顺序返回 `sources`。若超过 `request.maxResults`，保留前若干条并置 `truncated: true`，其余情况为 `false`。宿主提供整数 `maxResults ≤ 0` 时，链层钳为 1；非整数或未提供视为不限。
- **要求** 当此前有启用条目被跳过或失败时，`content` 首行须标明实际使用的条目。对于提供纯来源的适配器，供应商生成的正文不得作为通用 `content`。有单独呈现条件的适配器遵循对应规格。
- **来源** [原始需求 R2、R6及新版自定义链要求 R9](../../project/requirements.md)。
- **验收** 设 `maxResults` 为 3，令替身返回 2、3、4 条，核对分别返回 2、3、3 条，只有第三次标为截断。让首个条目成功及后续条目接管，分别核对来源只来自成功条目，并核对接管时的提示。

## FB-003 预算与取消

- **要求** 插件总预算 `timeoutMs` 为正整数毫秒，默认 `25000`。预算从单次搜索开始计算，涵盖凭据、代理、请求和解析。自定义链在每个条目开始时，按当时剩余时间除以该条目及其之后的启用条目数分配本次预算，含尚未检查凭据的启用条目，向下取整。跳过或提前结束带来的余量分配给后续条目。无可用时间时不得发出请求。官方分支使用整体预算，受同一宿主取消信号约束。
- **要求** 条目到期须取消当前请求，剩余总预算允许时可继续，迟到结果不得改变本次搜索。宿主取消或总超时须取消在途操作且不得再请求。
- **来源** [原始需求 R3、R5、R6及新版任意长度链要求 R9](../../project/requirements.md)。
- **验收** 用受控时钟覆盖单项和多项、禁用项、缺 key、前项提前出结果、条目超时和总超时。核对分配不超总预算、状态转换有依据、取消后出站请求数不再增加。

## FB-004 正常无结果和终态错误

- **要求** 空列表或全停用时须报告未配置可用工具。所有启用条目均因缺必要凭据跳过时，须说明缺失项。已尝试的条目中至少一条明确无结果且没有失败时，返回 `sources: []` 和 `truncated: false`。若存在失败且全链未获有效来源，须抛出 `WebError`，按尝试顺序附条目与脱敏原因。
- **来源** [原始需求 R5、R6及新版可停用要求 R9](../../project/requirements.md)。
- **验收** 分别令列表为空、全停用、全缺 key、一个明确空结果和混合上游失败与空结果，验证各终态。前项失败、最后一项正常空时仍须返回包含失败原因的错误。

## FB-005 失败分类与排查提示

- **要求** 必须区分凭据或权限、额度、限流、代理、直连网络、通道参数限制、单项超时和异常响应。HTTP `401`/`403` 属凭据或权限。额度问题为 HTTP `402`，或上游码 `insufficient_quota`、`QUOTA_LIMITED`（后者来自第三方文档，实机样本待证认），无论有无状态码均按额度优先判定。其他 `429` 属限流。其他 HTTP `4xx`（含 `400`、`432`、`433` 等厂商码）由链统一归类为通道参数限制；具体接口的厂商码可由适配器按适配规格在本地重分类（Tavily 用量超限码 `432`/`433` 属适配器本地额度特例，见 [TAV-002](tavily.md#tav-002-结果映射与正常空结果)），链按适配器抛出的码消费。针对具体接口的错误细分由适配规格定义。错误须指出对应条目和可核查的配置，遵守 [CFG-003](config-network.md#cfg-003-凭据隔离和脱敏)。内部程序违约（不带条目分类码的错误）原样向调用方暴露，不包装、不再发起新的上游请求。本句「不带条目分类码」不含条目执行期的 `ENTRY_*` 与 `CONFIG_*`（含 `PAC_*`）带码错误：这些按 [FB-006](#fb-006-条目执行期带码错误的降级与裸上抛)降级，不属本句裸上抛面。`TRANSPORT_RELEASED` 与全局 `CONFIG_*` 两类带码错误的裸上抛去向同经此面，措辞见 FB-006，本条不重述。
- **来源** [原始需求 R5、R6](../../project/requirements.md)。
- **验收** 对不同上游注入鉴权、额度、限流、代理、异常格式及程序错误。核对正常降级条件、终态原因与脱敏信息，程序错误后不得发起新的上游请求。

## FB-006 条目执行期带码错误的降级与裸上抛

- **要求** 条目执行期适配器上抛携带 `ENTRY_*` 或 `CONFIG_*`（含 `PAC_*`，见 [CFG-005](config-network.md#cfg-005-pac-代理路由)）码的错误时，链必须按条目级失败处理：以原码记入 `attempts`（沿用 FB-004 的尝试顺序），该条目计为失败并在总预算内继续下一条目；不得整链终止，也不得把原码压平为 `ENTRY_*` 归因码。`transport.open` 与代理建立期的 `CONFIG_*` 同属条目执行期，同样降级适用（[lead 裁决27](https://github.com/AMindFlow/dsh-fleetseek/issues/13#issuecomment-7141533377)）。全链未获有效来源进入终态时，`WebError` 的 `details.attempts` 必须按尝试顺序携各条目的原码，不改写、不压平。
- **要求** 两类带码错误不受本条降级，必须裸上抛——原错误对象原样暴露，不包装、不改码，且不产生条目级 `attempts` 记录、无出站请求：全局 `CONFIG_*`（链级配置快照读取自身失败，发生在条目循环之前，无条目上下文）；`TRANSPORT_RELEASED`（停机释放后拒发，属 FB-005 程序违约暴露面，不是条目分类）。
- **来源** [lead 裁决27（Issue #13 评论）](https://github.com/AMindFlow/dsh-fleetseek/issues/13#issuecomment-7141533377)。
- **验收** 用条目替身分别抛 `ENTRY_PROXY`、`CONFIG_INVALID`、`PAC_ROUTE_FAILED`，核对降级到下一条目、成功结果照常返回、成功路径的尝试记录保留原码。构造两条目全败（一条目执行期 `CONFIG_INVALID` 加一条目网络失败），核对终态 `WebError.details.attempts` 按尝试顺序分别携两条原码。令链级配置读取自身抛 `CONFIG_INVALID`，核对原错误对象原样上抛、零条目执行、无 `attempts`。注入 `TRANSPORT_RELEASED`，核对同样裸上抛、不降级。令 `transport.open` 抛 `CONFIG_INVALID`（代理无效），核对降级到下一条目且成功路径的 `attempts` 保留原码。

## 设计决定

- （draft，裁决日期 2026-11-25；本节汇总 WP0–WP12 交付期间已落地的链与适配器横向契约，裁决记录见各适配器交付记录及源码 TODO-P/TODO-BRV/TODO-EXA 条目；WP7 发布验收通过后随条款一并生效）
- **适配器形状（A5）** `Backend = { type, search(ctx) }`，`ctx = { entry, query, maxResults, key, fetch, budgetMs, signal, clock, log }`。链经 `transport.open(entry)` 取得 `ctx.fetch` 后再调用适配器（A6），适配器不得自行建立连接。
- **maxResults 下限守则** 宿主提供整数 `maxResults ≤ 0` 时，链钳为 1；非整数或未提供按不限处理（适配器收到的是 ≥ 1 的整数或无有效整数）。适配器不做钳制；向供应商发送请求参数（Tavily `max_results` 封顶 20、DeepSeek Search `count` 封顶 50、Brave `count` 封顶 20、Exa `numResults` 原值）按各适配规格执行。
- **结果契约** 成功 `resolve { sources, content? }`，`sources` 为按供应商顺序的全量有效来源，适配器不本地切片；截断与 `truncated` 由链的 `buildSuccessResult` 统一执行（FB-002）。空数组表示明确无结果（FB-004）。
- **错误契约** 可降级失败 `throw` 携带 `.code ∈ ENTRY_CODES` 的错误；条目执行期 `CONFIG_*`（含 `PAC_*`）带码错误同属可降级条目级失败（FB-006），故 `attempts` 码 ∈ `ENTRY_CODES ∪ CONFIG_CODES`；`TRANSPORT_RELEASED` 与全局 `CONFIG_*` 为裸上抛面（FB-006），不记 `attempts`；宿主取消 `throw` `name = "AbortError"` 且不带 `.code` 的错误（不属条目分类），链据此终止整链并拒绝，不降级（FB-001/FB-003）；预算到期 `throw` 携带 `.code = "ENTRY_TIMEOUT"` 的错误（FB-003 条目到期，可继续后续条目）；内部程序违约 `throw` 无码错误，原样暴露（FB-005）。
- **预算与取消接线** `ctx.budgetMs` 为条目预算（正整数毫秒，FB-003 剩余时间除以剩余启用条目数向下取整）；适配器须经 `ctx.clock` 调度预算并在 `ctx.signal` 与预算到期合并的中止下完成请求与读体，响应读取同样在预算之内；宿主取消与预算到期两种原因必须按错误契约区分，迟到结果不得改变已收敛的搜索（FB-003）。
- **FB-006 裁决与生效**（draft，裁决日期 2026-11-25；lead 裁决27，源于 PR#35 审阅 P2-b）。本条待 WP7（#13）发布验收通过后随条款生效。
- **FB-006 测试与代码路径** 条目执行期降级 oracle：`test/chain-coded-failure-policy.test.js` P2-b①–④；全局 `CONFIG_*` 裸上抛 oracle：同文件 P2-b⑤；`TRANSPORT_RELEASED` 裸上抛既有绿见 `test/transport-passthrough.test.js` P1-1 `raw` 行（该行现仅覆盖 `TRANSPORT_RELEASED`）。条目执行期可降级码集：`src/search.js` 的 `isEntryPhaseCode`（`ENTRY_PHASE_CODE_VALUES` = `ENTRY_CODES ∪ CONFIG_CODES`）。
- **FB-006 open 期现状** `src/transport.js:125-134` 的 `classifyProxy` 分支抛 `CONFIG_INVALID`；`src/search.js:360` 的 `transport.open(entry)` 位于条目 `try` 之外，当前实现尚未按本条降级。修复在 `feat/open-degrade` 并行落地，本规格先行。CFG-005 只规定报阶段，条目执行期弹性归 FB 家族，本条为该补位。
