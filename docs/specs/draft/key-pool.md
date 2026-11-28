# 多 key 池轮替

本规格定义搜索链条目的条目级凭据由单一引用扩展为引用数组（下称 key 池）及其失败驱动轮替行为。适用范围：`entries[i]` 的凭据形态与双闸校验（读闸口径 [CFG-004](config-network.md#cfg-004-配置快照与连接释放)，写闸等价性 [CFG-W-001](config-write-gate.md#cfg-w-001-写闸预检等价性)）；条目内轮替的触发、预算与归因（条目间顺序、总预算与失败分类归 [FB-001](fallback.md#fb-001-自定义顺序与降级条件)、[FB-003](fallback.md#fb-003-预算与取消)、[FB-005](fallback.md#fb-005-失败分类与排查提示)，本规格不重述共用行为，只写边界与修订注）；设置卡对 key 池的编辑与脱敏展示（[SET-002](settings-ui.md#set-002-增加编辑与停用)、[SET-004](settings-ui.md#set-004-保存与凭据状态)）。凭据边界沿用 [CFG-002](config-network.md#cfg-002-密钥来源和优先级) 与 [CFG-003](config-network.md#cfg-003-凭据隔离和脱敏)：池内全部凭据一律经宿主凭据服务、write-only、不回读回显。

**非目标（适用范围声明）**：本规格不引入轮询摊负载（不按查询或会话轮转起始偏移）、不做跨会话用量快照、不做 FNOSP 式预排除（凭据健康度的预判一律禁止）。轮替只能由当次搜索的实时失败反馈驱动；插件不得跨搜索记忆或预判 key 状态，每次搜索的起点仅由已保存配置与凭据层的实时解析结果决定。

## POOL-001 条目凭据数组形态

- **要求** 条目凭据必须新增字段 `credentialRefs`：0–8 个字符串的数组，每个元素为一个宿主凭据引用名（POSIX 标识符，R-1 语法口径）；去空白后数组元素顺序即池内选取与轮转顺序。读闸（`normalizeConfig`）与写闸（`Component.contract`）必须同时接受两种既有形态之一：非空 `credentialRef` 字符串（旧形态，等同 1 元池 `[credentialRef]`，见 POOL-002）或 `credentialRefs` 数组；两字段共存（`credentialRef` 非空且 `credentialRefs` 非空）时两闸必须拒绝，文案含 `entries[i]` 定位与互斥原因，不得静默择一或合并。`credentialRefs` 形态必须为数组：`null`、字符串及其他非数组一律拒绝；元素非字符串或纯空白必须拒绝（文案含元素定位 `entries[i].credentialRefs[j]`）；空数组等同省略该键。通过形态的快照归一化输出必须为 trim 后的原序数组，作为该条目的条目级凭据候选清单。
- **来源** [GitHub Issue #86](https://github.com/AMindFlow/dsh-fleetseek/issues/86)。
- **验收** 给定 `credentialRefs: ["REF_A","REF_B"]`、`["REF_A"," REF_A "]`（trim 后重复）、`["REF_A", null]`、`["  "]`（仅空白元素）、9 元素（越上限）、旧形态 `credentialRef: "REF_A"`、两字段共存、bing 条目带非空 `credentialRefs` 八种形态，分别输入 `normalizeConfig` 与 `Component.contract.validate`：两者通过/拒绝结论必须逐例双向一致；通过的形态快照候选清单 = trim 后原序数组；被拒形态的文案含定位（条目或元素级）与可操作原因（对齐 CFG-W-001 口径）。

## POOL-002 存量单引用 = 1 元池（零感知迁移）

- **要求** 新语义生效不得由插件主动改写任何存量已落盘配置（无磁盘迁移、无补字段、无键序改写）。存量 `credentialRef` 单引用条目在新语义下行为必须与 v0.2.0 逐位一致：等同 1 元池 `[credentialRef]`，key 解析仍按 [CFG-002](config-network.md#cfg-002-密钥来源和优先级) 层序（条目引用 → 白名单环境变量 → DSH 托管引用 → 旧版 YAML），失败归因文案与 `attempts` 记录必须与 v0.2.0 单 key 失败基准相同，不得出现池耗尽字样（见 POOL-006）。行 id、配置命名空间与 provider id 必须永久保持 `search-chain`（[DSH-001](dsh-integration.md#dsh-001-注册和释放搜索-provider) 口径），key 池数据全部存于该命名空间下。经设置卡对该条目做池编辑或任一编辑保存时，该条目凭据必须以 `credentialRefs` 数组形态落盘（惰性迁移），同一提交必须附带字段级 `unset` 移除该条目旧 `credentialRef` 键；未被编辑的条目在磁盘上保持旧形态原样。
- **来源** [GitHub Issue #86](https://github.com/AMindFlow/dsh-fleetseek/issues/86)、[HANDOFF-20261128 · v0.3.0 开工前补充 · 红线](../../project/HANDOFF-20261128.md)。
- **验收** ① 给定 v0.2.0 生成的含 `credentialRef` 单 key 与多条目混合的配置样本（合成 key），升级后不做任何配置操作：既有全量测试套件不改动必须全绿；插件启动并完成一次搜索后，宿主配置磁盘落盘内容必须与升级前逐字节一致。② 对单引用条目注入 401、429、网络失败三类结局：终态 `attempts`、reason 文案与出站次数必须与 v0.2.0 基准一致（无「全部 N 把」类池字样）。③ 在设置卡编辑该存量条目改名并保存：该条目以 `credentialRefs: ["原引用"]` 落盘且 `credentialRef` 被 unset，其余条目磁盘内容逐字节不变。

## POOL-003 池上限与池内去重

- **要求** `credentialRefs` 元素个数不得超过 8（上限为常量，取值理由见设计决定）。两闸对超限池必须拒绝，文案含实际数量与上限值。元素去空白后与池内其他元素重复时两闸必须拒绝，文案含定位与「池内引用重复」原因；不得静默去重放行。免 key 类型条目（bing）配置非空 `credentialRefs` 时两闸必须拒绝，文案含类型与免 key 说明（运行期失败语义即配置闸可见拒绝，见 POOL-010）。写闸拒绝时遵循 [CFG-W-004](config-write-gate.md#cfg-w-004-错误语义与零出站)：零 `settings/mutate`、零 `credentials/set`、零外部出站。
- **来源** [GitHub Issue #86](https://github.com/AMindFlow/dsh-fleetseek/issues/86)。
- **验收** 构造池内重复、9 元素（上限 +1）、bing + 非空数组三种形态：两闸必须双向一致拒绝且文案含定位与原因；构造 1 元素与 8 元素形态：两闸必须通过。在面板保存路径分别触发前三种被拒形态：按 CFG-W-004 口径核对 `mutates()`、`credentialSets()` 与 `outbound` 计数全部为零，草稿保留。

## POOL-004 失败驱动轮替（触发集与顺序）

- **要求** 当条目以池中某把 key 向供应商提交查询后，收到按 [FB-005](fallback.md#fb-005-失败分类与排查提示) 归类为 `ENTRY_CREDENTIALS`、`ENTRY_QUOTA` 或 `ENTRY_RATE_LIMITED` 的失败（这三类的输入信号含 HTTP `401`/`402`/`429` 及额度证据码，判定细则归 FB-005/FB-006，本规格不重述），链必须在同一条目内按池顺序用下一把已解析出 key 的引用重试同一查询，直至成功、明确无结果或池耗尽。除这三类外的其他 FB-005 分类（`ENTRY_NETWORK`、`ENTRY_PROXY`、`ENTRY_TIMEOUT`、`ENTRY_CHANNEL_LIMIT`、`ENTRY_BAD_RESPONSE`）不得换 key 重试；`ENTRY_CONTENT_POLICY` 前后均不得做条目内重试，其终止整链的语义保持 [FB-001](fallback.md#fb-001-自定义顺序与降级条件) 不变。轮替中每把 key 至多尝试一次：一次搜索内一个条目对同一供应商的查询提交数不得超过该条目池的候选 key 数，不得二次轮转。选取起始必须从池头开始（解析顺序 = 数组顺序），不得记忆上一次查询的轮转起点或偏移；单次搜索内的轮转状态不得跨查询、跨会话携带（呼应本规格非目标）。解析未命中（absent/空白）的引用不占轮转轮次、不得重试。
- **来源** [GitHub Issue #86](https://github.com/AMindFlow/dsh-fleetseek/issues/86)。
- **验收** 用 2–3 把 key 的池与替身上游，分组注入并分别核对：① 首 key `401`、次 key `200` 有效来源 → 该供应商出站恰 2 次，成功结果来自次 key；② 首 key `429`、次 key `200` → 同①；③ 首 key `402`、次 key `200` → 同①；④ 首 key 网络类失败 → 出站恰 1 次，条目按 FB-005 失败降级下一条，次 key 未被尝试；⑤ 首 key 明确空结果 → 不换 key，按 FB-001 继续下一条；⑥ 两把 key 全 `401` → 出站次数 = 池候选数、每把恰一次、无第三轮；⑦ 内容策略拒绝 → 零轮替、整链终止（FB-001 口径）。同进程连续两次查询：第二次必须仍从池头开始。

## POOL-005 轮替预算与 FB-001 边界（修订注）

- **要求** 池内任一把 key 的尝试与其后续轮替必须全部落在 [FB-003](fallback.md#fb-003-预算与取消) 已分配给该条目的预算之内；插件不得为轮替追加预算、不得重算条目预算公式的分母、不得改变 FB-003 的预算分配与 [FB-001](fallback.md#fb-001-自定义顺序与降级条件) 的条目间降级顺序。条目预算到期时轮替必须立即停止并取消在途请求，该条目按 `ENTRY_TIMEOUT` 归因，未尝试 key 数可见（POOL-006）。宿主取消仍按 FB-003 终止整链，轮替不得产生任何后续出站。本条对 FB-001「每个条目最多向其供应商提交一次查询」作修订注：改为「每个条目的每把凭据最多向其供应商提交一次查询」；条目间串行、首个有效来源即停与降级条件不得改动。本修订注随实施 PR 同步登记进 fallback.md（沿用 CFG-002 修订注先例），本草案先行登记生效口径。
- **来源** [GitHub Issue #86](https://github.com/AMindFlow/dsh-fleetseek/issues/86)。
- **验收** 受控时钟下设条目预算恰好容纳 3 把 key：① 首 key `401`、次 key 挂起 → 次 key 请求在条目预算到期时被取消，出站止步 2 次，归因 `ENTRY_TIMEOUT` 且未尝试数 = 1；随后降级下一条目按原 FB-003 口径继续（前后条目埋点核对下一条目的预算与顺序不受前条目轮替影响）。② 轮替途中宿主取消 → 在途请求取消、后续出站数为零、整链拒绝（FB-003 口径）。③ 回归：无池（单引用）条目全部既有 FB-001/FB-003 场景的出站次数与顺序必须与 v0.2.0 一致。

## POOL-006 池耗尽归因与轮替事件可见

- **要求** 池内全部候选 key 尝试完毕仍失败时，该条目必须记为一次失败：以最后一把尝试的 FB-005 分类码作为该条目的终态归因码，且该条目的 `attempts` 记录必须同时暴露逐 key 脱敏明细：每把已尝试 key 的池内序号（1 起）与其 FB-005 分类码，以及因预算到期等原因未尝试的 key 数。池耗尽的 reason 文案必须与单 key（含 1 元池）失败可区分：前者必须含「全部 N 把 key 失败」字样，后者不得含该字样。若条目经轮替后换 key 重试命中成功，结果必须按 [FB-002](fallback.md#fb-002-成功结果与提示) 接管提示同一渠道脱敏暴露该轮替：`content` 首行冠以「已使用第 N/M 把 key」的实际用量标注（纯来源适配器为免 key 类型，无池，不冲突）。每次换 key 必须记一条脱敏日志事件（条目 id、key 序号、分类码）。以上全部文案、日志与明细不得含 key 明文、代理认证或上游原始响应体（[CFG-003](config-network.md#cfg-003-凭据隔离和脱敏)）；引用名是否入明细属实现选择（引用名非秘密，见设计决定），但按序号归因必须成立。
- **来源** [GitHub Issue #86](https://github.com/AMindFlow/dsh-fleetseek/issues/86)。
- **验收** ① 3 元池全败（依次 `401`、`429`、`402`）→ `attempts` 中该条目恰一条记录，明细含三把 key 的序号 1/2/3 与对应分类码，reason 含「全部 3 把 key 失败」；对单 key 条目注入同结局 → reason 不含池字样，两种场景文案可区分。② 首 key `401`、次 key `200` 成功 → `content` 首行含换 key 标注，第三把 key 无出站。③ 捕获 `attempts`、`content` 与日志全文，合成 key 明文必须正则不可命中（CFG-003 检查面）；轮替日志事件数 = 实际换 key 次数。

## POOL-007 凭据解析分层与不轮替层

- **要求** key 池必须是唯一的轮替候选集，范围限于条目级 `credentialRefs`（含旧单引用形态映射的 1 元池）。[CFG-002](config-network.md#cfg-002-密钥来源和优先级) 的下层来源（白名单环境变量、DSH 托管引用、旧版 YAML）必须仍只参与选取期的降级解析：条目级候选全部解析未命中时，方可按 CFG-002 层序取其一作为兜底单 key；下层 key 失败后不得回头重试池内引用，池内 key 失败后也不得把下层来源纳入轮替或降级候选（下层每搜索至多被尝试一次）。池耗尽不得引发任何凭据层的重新读取或重新降级。免 key 类型保持零凭据读取（CFG-002）。
- **来源** [GitHub Issue #86](https://github.com/AMindFlow/dsh-fleetseek/issues/86)、[CFG-002](config-network.md#cfg-002-密钥来源和优先级)。
- **验收** ① 池内 refs 全部解析 absent、env/托管层有 key → 选取命中下层 key；注入 `401` → 条目失败，池内引用不被回头重试、下层不再降层再试。② 池首把解析出 key、上游 `401`，env 层另有 key → env key 不得成为轮替或降级候选（出站次数 = 池候选数）。③ bing 条目参与搜索 → 凭据服务 resolve 调用计数为零。④ 旧单引用条目逐层命中场景必须与 v0.2.0 解析链逐层一致（POOL-002 回归面）。

## POOL-008 写闸扩展（CFG-W-002 矩阵扩展与 CFG-W-003 数组深度清零）

- **要求** 写闸 null 形态矩阵（[CFG-W-002](config-write-gate.md#cfg-w-002-null-形态矩阵)）必须按本文件「修订注（CFG-W-002 矩阵扩展）」一节新增 `credentialRefs` 各行，判定与读闸 POOL-001/POOL-003 逐字段一致，双向等价钉（[CFG-W-001](config-write-gate.md#cfg-w-001-写闸预检等价性)）必须覆盖新增字段。写路径明文清零（[CFG-W-003](config-write-gate.md#cfg-w-003-写路径明文-key-清零)）必须扩展至数组深度：`stripSecrets` 递归须覆盖数组内任意深度对象的 `SECRET_FIELD` 键命中；`credentialRefs` 元素必须只允许凭据引用名，任何 `settings/mutate` 请求体不得携带明文 key 值——无论来自用户新输入还是持久残留；任一保存路径应用后，磁盘条目不得残留 `SECRET_FIELD` 命中字段，旧 `credentialRef` 与 `credentialRefs` 不得共存落盘（迁移保存附字段级 `unset`，POOL-002）。被拒文案必须含定位与原因，错误呈现与草稿保留沿用 [CFG-W-004](config-write-gate.md#cfg-w-004-错误语义与零出站) 与 SET-004 既有锚点，本条不重述。本节两条修订注随实施 PR 并入 config-write-gate.md（登记位置见文末修订注节）。
- **来源** [GitHub Issue #86](https://github.com/AMindFlow/dsh-fleetseek/issues/86)、[config-write-gate.md](config-write-gate.md)。
- **验收** ① 对「修订注（CFG-W-002 矩阵扩展）」各行形态，分别输入 `Component.contract.validate` 与 `normalizeConfig`：结论必须逐行双向全等。② 构造 `settings/describe` 回包含带 `credentialRefs` 数组且残留明文 `apiKey`/`key` 字段的条目，走面板各保存路径（编辑本条保存、未触碰本条的离散开关/重排/移除其他条目保存）：`settings/mutate` 请求体不含明文值与 `SECRET_FIELD` 键名载荷；经权威 reducer 应用后条目上 `SECRET_FIELD` 命中字段为零。③ 迁移保存必须含该条目 `credentialRef` 的字段级 `unset`。④ 写闸拒绝的池形态按 CFG-W-004 口径：`mutates()`、`credentialSets()`、`outbound` 计数全零。

## POOL-009 设置卡 key 池编辑与脱敏状态展示

- **要求** 条目编辑器必须提供 key 池管理：按槽位新增一把 key、移除槽位、编辑 key 仅通过「填入新值并保存」完成（write-only，重开编辑器不得回读或回显任何已存值，[CFG-003](config-network.md#cfg-003-凭据隔离和脱敏)）。每个新输入的 key 必须保存时先经宿主凭据服务写入生成新引用，再随配置落盘（保存即校验；先凭据后配置与写前预检顺序沿用 SET-004/[CFG-W-004](config-write-gate.md#cfg-w-004-错误语义与零出站) 既有口径）；移除槽位只从该条目数组中删引用，不得 unset 宿主凭据（[SET-002](settings-ui.md#set-002-增加编辑与停用)）。条目卡片与编辑器必须展示每个槽位的凭据脱敏状态（引用名存在性与「已保存（只写）」类状态，均由本地配置派生，不读凭据值、零出站）与池规模；池为空时带 key 类型显示缺凭据状态（SET-002/SET-004 口径）。池去重、上限校验失败必须经既有保存错误锚点可见呈现、可定位（SET-004/CFG-W-004），不得丢失草稿与未提交明文缓冲；保存成功须清空缓冲。面板任何状态与错误不得出现 key 明文。
- **来源** [GitHub Issue #86](https://github.com/AMindFlow/dsh-fleetseek/issues/86)、[SET-002](settings-ui.md#set-002-增加编辑与停用)、[SET-004](settings-ui.md#set-004-保存与凭据状态)。
- **验收** 操作矩阵逐项验证：① 新增两把 key 保存 → `credentials/set` 调用计数 = 2，磁盘条目 `credentialRefs` 两引用按添加顺序，卡片显示池规模 2 与两槽位状态；② 删除一个槽位保存 → 该条目数组少一引用，宿主凭据 unset 调用计数 = 0；③ 保存成功后重开编辑器 → 任何槽位无 key 值回显；④ 保存注入凭据服务写失败 → 编辑器动作行上方 `role="alert"` 错误可见，草稿与明文缓冲保留，配置零落盘；⑤ 重复添加同一引用 / 添加第 9 把 key → 错误可见、可定位，`settings/mutate` 与 `credentials/set` 零调用；⑥ 面板操作全程供应商出站计数为零（SET-004 陷阱面），渲染与错误全文合成 key 明文正则不可命中。

## POOL-010 免 key 条目池语义不适用

- **要求** 免 key 类型（bing，[CFG-002](config-network.md#cfg-002-密钥来源和优先级) 免 key 集）不得有池概念：选取与轮替必须对该类型零凭据读取，出站行为与 v0.2.0 一致。此类条目被配置非空 `credentialRefs` 属配置面误配：两闸必须拒绝（POOL-003），错误必须定位到条目、字段与类型；运行期不得静默忽略后照常出站，亦不得因残留引用产生任何凭据读取。空数组必须通过并归一化为省略（POOL-001 口径）。本条不新增任何配置闸以外的运行期失败路径。
- **来源** [GitHub Issue #86](https://github.com/AMindFlow/dsh-fleetseek/issues/86)、[CFG-002](config-network.md#cfg-002-密钥来源和优先级)。
- **验收** ① bing + `credentialRefs: ["REF_A"]` 输入两闸 → 双向一致拒绝，文案含类型与定位；② bing + `[]` → 两闸通过，快照中该键省略；③ bing 条目参与搜索 → 凭据服务 resolve 调用计数为零，RSS 出站行为与 v0.2.0 一致。

## 修订注（CFG-W-002 矩阵扩展，随实施 PR 并入 config-write-gate.md）

- 修订注（草案，登记日期 2026-11-28）：CFG-W-002 null 形态矩阵新增 `entries[i].credentialRefs` 行，判定与读闸 POOL-001/POOL-003 逐字段一致——`entries[i].credentialRefs === null`：拒绝（`entries[i].credentialRefs 必须是数组`）；`entries[i].credentialRefs === []`：接受（归一化为省略该键，与条目级未提供引用同义）；非数组（含字符串）：拒绝；元素为 `null`、非字符串或纯空白：拒绝（文案含元素定位 `entries[i].credentialRefs[j]`）；元素 trim 后与池内其他元素重复：拒绝（`entries[i].credentialRefs 中存在重复引用`）；元素个数超过 POOL-003 上限：拒绝（文案含实际数量与上限值）；与非空 `credentialRef` 共存：拒绝（`entries[i] 的两种凭据形态互斥`）；免 key 类型条目带非空 `credentialRefs`：拒绝。双向等价钉（CFG-W-001）必须覆盖以上各行。原条文保持原文可读，本节为该扩展的登记载体；并入前以本节为口径。

## 修订注（CFG-W-003 数组深度扩展，随实施 PR 并入 config-write-gate.md）

- 修订注（草案，登记日期 2026-11-28）：CFG-W-003 的明文清零范围显式扩展至数组深度——`stripSecrets` 的递归必须覆盖数组内任意深度对象的 `SECRET_FIELD` 键命中（现实现按 `Array.isArray` 递归天然覆盖，本注把该行为钉为条款要求防回归）；`credentialRefs` 元素必须只允许凭据引用名，任何 `settings/mutate` 请求体不得携带明文 key 值（新输入或持久残留均不得）；任一保存路径应用后磁盘条目上不得残留 `SECRET_FIELD` 命中字段。引用口径：POOL-008 以本两节为「矩阵行」与「数组深度」的规范文本载体。

## 设计决定

- **新增独立字段而非拓宽 `credentialRef` 为 union**：schemastery `Config` 的条目节点 `credentialRef` 是 `z.string().role("credential-ref")` 定型节点，宿主 `settings/describe` 投影已被契约测试钉死（`src/index.js` #43 实证注）。拓宽为 `string | string[]` union 会改变该 role 节点的投影形状，宿主对 role+union 的行为属实机未知数；新增独立 `credentialRefs`（字符串数组）让旧节点零改动，最大化「存量投影 = 零感知」（POOL-002）。数组节点是否加 `role("credential-ref")` 待实机核对。
- **共存与免 key 误配选择可见拒绝而非择一优先**：两形态共存时静默择一会悄悄改变实际生效的 key，违反「不得静默」红线（HANDOFF v0.3.0 红线）；fail-closed + 可定位文案是唯一可审计的口径。
- **池上限 8**：现实多账号池常见 2–4，8 留一个数量级余量；结合 FB-003 默认总预算 `25000ms`，条目最坏出站次数被硬界定在 8，防止误配大数组放大出站面。取值为草案常量（建议 `src/constants.js` 单一事实源，镜像同步义务同现行常量），Oracle 评审可调整；条款只钉行为边界不钉实现位置。
- **解析未命中的引用不占轮次、不回跳重试**：absent/空白是「未提供」而非「失败」，若按回跳逻辑会产生凭据多次读取与不确定归因；选取一次成型、失败只向前，与「不做 FNOSP 式预排除」的非目标一致。
- **无逐 key 独立预算**：轮替完全消耗在 FB-003 条目预算内，预算公式与分母不变——这也是 POOL-005「不改变 FB-003」的实现依据。认证/配额/限流类失败通常上游快速返回，轮替的现实时间开销小；预算到期的残量经 POOL-006「未尝试数」显性化。
- **`attempts` 结构扩展（实现建议，行为由 POOL-006 钉死）**：条目失败记录附带链自产脱敏字段，如 `pool = { size, tried, outcomes: [{ index, code }] }`（未尝试数 = size − tried − 解析未命中数，可由既有字段推出）；诊断文案优先用池内序号而非引用名——引用名是设置编辑器本就可见的 POSIX 标识符、非秘密，但含生成时间熵，无入日志必要。
- **轮替重试的传输句柄**：按 A6 接缝每次尝试 open→search→close（与 FB-001「每把凭据至多一次提交」的修订口径配套；句柄跨 key 复用留作后续优化单独评估），适配器 `ctx.key` 传入当次 key，七个适配器零改动。
- **孤儿引用容忍度沿用现状**：面板保存仍「每次带 key 生成新引用」且不回收（`src/settings/panel.js` 现行语义），扩展到槽位维度不改该策略；孤儿引用无害（不被配置引用即不被读取）。
- **修订注同步义务**：POOL-005 的 FB-001 修订注与本文件两条 CFG-W 修订注，须在实施 PR 同一提交分别登记进 fallback.md 与 config-write-gate.md，沿用 CFG-002 修订注先例（config-network.md 修订注格式）；并入前以本草案登记为准。
- **测试与镜像触点（供实施排程，非协议）**：两闸等价钉需扩展 `src/client-entry.js` 的 `Component.contract` 内联镜像与 `src/config.js`（「两闸等价钉」测试面）；池上限常量须同 PR 同步 `src/constants.js`、`src/settings/catalog.js`、`test/helpers/contract.js` 三个镜像面（现行常量同步义务）。

