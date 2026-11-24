# 排错指南

本页按错误码说明现象和用户可以做的处理。错误码与原因文本以 `main` 的实现为准（`src/constants.js`、`src/search.js`、`src/transport.js`、`src/index.js`、`src/official.js`、`src/settings/panel.js`）。

## 先读懂错误

失败的搜索会携带两部分信息：

- **错误码**：整次搜索的终态码（`CHAIN_*`、`CONFIG_*`、`WEB_PROVIDER_UNAVAILABLE`），或单个条目的码（`ENTRY_*`、`CONFIG_*` 含 `PAC_*`、`SKIPPED_NO_KEY`）。
- **`details.attempts`**：按尝试顺序排列的条目记录。每一项包含 `entryId`、`entryType`、`entryName`、`code` 和 `reason`。`reason` 是为用户写的说明，不含 key、带认证信息的代理地址或供应商返回的原始内容。

宿主界面如何展示这些信息，以实机为准。如果只看到错误码，可以在 DSH 的日志或错误详情中查找 `details.attempts`。

**怎么读 `CHAIN_UPSTREAM_FAILURES` 的 attempts**：

1. 列表顺序就是尝试顺序，也就是启用条目的列表顺序。
2. 每一项对应一个条目。从上往下看，哪一项的 `code` 是 `ENTRY_*` 或 `CONFIG_*`（含 `PAC_*`），说明该条目被尝试过并以该原因失败；按该码修复这一个条目即可。注意并非每种码都意味着真的向供应商发出了请求：`PAC_FETCH_FAILED`、`PAC_EVAL_FAILED`、`PAC_ROUTE_FAILED` 和 `ENTRY_PROXY`（v0.1，见下文）在出站前或出站未成功时就已失败。
3. `SKIPPED_NO_KEY` 不是上游故障，只表示该条目没有 key，没有发出请求。
4. 一个启用条目如果没有出现在 attempts 中，通常是因为总预算已经用完，没有时间再发出请求（这种情况不记录），或者链在它之前已经成功返回。
5. 修复一个条目后，后面的条目仍会按顺序尝试。

没有错误但结果为空，表示已尝试的条目都明确返回了"没有结果"，这是正常的成功结果（`sources` 为空），不是故障。

## 条目级错误（`ENTRY_*`）

这些错误只影响一个条目，链会继续尝试下一个。

**ENTRY_CREDENTIALS**：上游返回 401 或 403，或者该条目的凭据引用读取失败（reason 为"凭据引用读取失败"）。现象是该条目被跳过或失败，搜索可能转到下一个条目。可操作：确认 key 有效、未过期，并且与该供应商匹配（例如 Tavily 的 key 不能用于 Exa）。按 [快速开始](getting-started.md#42-四种来源与优先级) 更换或修正 key 来源：v0.1 在配置区改 `credentialRef` 指向新引用，或修正环境变量（v0.2 面板则直接重新保存该条目的 key 生成新引用）。

**ENTRY_QUOTA**：上游返回 402，或返回额度证据码。链侧证据码是**精确匹配**（`src/search.js` 的 `QUOTA_EVIDENCE_CODES`：`insufficient_quota`、`resource_exhausted`、`RESOURCE_EXHAUSTED`、`QUOTA_LIMITED`；`resource_exhausted` 的两种拼写是逐条枚举的，不是大小写不敏感匹配），命中即按额度判定、优先于状态码。现象是该条目因额度不足被跳过。可操作：到供应商后台核对余额和计费设置。在额度恢复前，这个条目会持续失败，建议把它移到后面或暂时停用。`QUOTA_LIMITED` 也在证据码中，但这一判定**待证认**：它来自第三方文档，尚未取得实机样本。个别适配器有本地额度口径：Gemini 在 429 下先把 `code`/`status` 转小写再比对，并有消息含 `quota` 的消息启发式——同样是待复核的临时口径；Tavily 的 432/433 归额度是适配器本地特例，待供应商文档证认。如果你遇到的额度判定与实际不符，请记录脱敏后的错误码和 reason。

**ENTRY_RATE_LIMITED**：上游返回 429，且没有额度证据。现象是该条目被限流。可操作：稍后再试，或降低搜索频率。链会继续尝试后面的条目。

**ENTRY_PROXY**：该条目本次要走的路由是经代理（固定 `proxy` URL，或 PAC 命中 `PROXY`/`HTTPS` 指令），而请求失败。要分清两种情况：

- **v0.1 生产装配没有接代理分发器**（`src/index.js` 的 `productionFetch`，零依赖）：所有命中代理的路由在提交前显式失败、**零出站**，并归入本码。attempts 的 `reason` 是固定文案「代理失败：请检查条目…（该条目不会自动改走直连）」；传输层细节（代理 host:port、`PROXY_UNSUPPORTED` 线索、是否经 PAC）只写进插件的 warn 日志，不进 attempts。
- 将来接入分发器后，本码才会另外覆盖"真实经代理请求在上游失败"的情形；无论哪种情况都**不会自动改走直连**（CFG-001 显式失败语义）。

可操作：v0.1 中如果直连可用，删除该条目的 `proxy` 或留空使其直连；如果必须经代理出站，当前版本无法完成，需要等待分发器接入。该行为有本地回环复测佐证：[复测 fixture](evidence/proxy-retest-v0.1.mjs) 与 [复测输出](evidence/proxy-retest-v0.1.log)；全貌见 [快速开始的已知限制](getting-started.md#7-已知限制当前版本)。

**ENTRY_NETWORK**：直连请求失败，没有 HTTP 状态码（例如无法连接、DNS 失败）。可操作：确认当前网络可以访问该供应商的地址。本插件不会因此改走代理。

**ENTRY_CHANNEL_LIMIT**：上游返回其他 4xx（不是 401、403、402、429）。现象是请求被上游拒绝，通常与请求参数有关。可操作：检查该条目的类型参数，例如模型名或模式设置，并对照供应商文档。个别供应商有专有状态码：Tavily 的 432 和 433 按用量超限归为 `ENTRY_QUOTA`，不属于本条。

**ENTRY_TIMEOUT**：条目没有在它的预算内返回，请求已被取消。现象是 reason 中写明了该条目的预算毫秒数。可操作：提高 `timeoutMs`，或减少启用条目，或把较快的条目排到前面（见 [快速开始](getting-started.md#6-搜索如何降级以及-timeoutms)）。

**ENTRY_BAD_RESPONSE**：上游返回 5xx，返回的内容无法按该条目的规格解析，或 2xx 响应体超过 2 MiB 上限（`src/constants.js` 的 `MAX_RESPONSE_BYTES`，超限立即停止读取，reason 含尺寸线索）。现象是该条目被跳过，原因通常是供应商的临时故障或异常巨大的响应。可操作：稍后重试。如果同一个条目持续失败，请保留错误时间、条目类型和 reason，不要粘贴含 key 或完整查询的原始日志。

**ENTRY_CONTENT_POLICY**：上游的内容策略明确拒绝了这次搜索。这是终止类错误，链不会继续尝试后面的条目，整次搜索以 `CHAIN_CONTENT_POLICY` 结束。可操作：修改查询内容后再试。

**SKIPPED_NO_KEY**：该条目没有找到 key，因此被跳过，没有发出请求。这不是故障，而是一个跳过记录。reason 会写明缺少的环境变量名，例如 `缺少凭据：TAVILY_API_KEY 未配置`。可操作：按 [快速开始](getting-started.md#4-凭据) 的四种来源补上 key。如果所有启用条目都是这种情况，整次搜索以 `CHAIN_KEYS_MISSING` 结束，并列出缺失的名称。

## 配置与凭据错误（`CONFIG_*`、`PAC_*`）

**CONFIG_INVALID**：配置未通过校验。有两种出现形式。一是整次搜索直接失败（例如 `id` 重复、`timeoutMs` 不是正整数、`proxy` 形状非法），此时没有 attempts。二是条目执行期的配置违约，记为该条目的失败，链会继续。可操作：按错误文本中指出的字段修改配置。例如 `entries 中 id 重复：xxx` 需要把重复的 `id` 改为唯一值。

**CONFIG_CREDENTIALS_UNREADABLE**：凭据配置无法读取。当前运行路径中，条目的凭据读取失败会被链记为 `ENTRY_CREDENTIALS`（reason 为"凭据引用读取失败"），因此 attempts 里通常看到的是那个码。可操作：同 ENTRY_CREDENTIALS——v0.1 在配置区修正 `credentialRef` 或环境变量；v0.2 面板重新保存该条目的 key。

**CONFIG_SAVE_FAILED**：保存失败，已生效的配置保持不变。这是设置面板保存链路的码（数据层已实现并有测试；带输入框的编辑界面 v0.2 才挂载）。面板保存失败会保留草稿，提示"宿主拒绝写入"或"凭据服务写入失败"。可操作：检查宿主的配置和凭据服务状态，然后重新保存。草稿不会丢失。v0.1 经插件配置区保存时由宿主执行写入，拒绝时以宿主的报错为准。

**CONFIG_CONFLICT**：设置面板保存时发现配置已被其他界面修改，因此没有覆盖（同为面板保存链路的码）。可操作：重新打开面板，核对差异后再保存。未保存的编辑会保留在草稿中。

**PAC_FETCH_FAILED**：PAC 文件下载失败。PAC 由条目首次出站前以**直连** GET 获取（不经代理），响应上限 2 MiB，超限会中止下载、原因文本带字节上限（本地复测见 [复测输出](evidence/proxy-retest-v0.1.log)）。该失败记为该条目的 attempts 记录（原码保留），链继续下一个条目。可操作：用浏览器或 `curl` 直接访问该 PAC 地址，确认返回 200、脚本文本且小于 2 MiB。

**PAC_EVAL_FAILED**：PAC 脚本无法解析、运行出错、缺少 `FindProxyForURL`，或求值超过 500 毫秒的 CPU 护栏（脚本顶层执行与每次 `FindProxyForURL` 调用各限 500 毫秒）。排查项：脚本是否使用了**未提供的助手**——沙箱只注入 `isPlainHostName`、`dnsDomainIs`、`shExpMatch` 三个助手（`src/transport.js` 的 `evaluatePac`），`isInNet`、`dnsResolve` 等其他常见助手是未定义的，用到即求值失败；再检查 `FindProxyForURL` 是否存在、是否依赖被禁用的代码生成（`eval` 和 `Function`）。

**PAC_ROUTE_FAILED**：PAC 的返回值不是字符串，或者其中没有受支持的指令（按顺序取第一个可用指令；当前支持 `DIRECT`、`PROXY host:port`、`HTTPS host:port`，`SOCKS` 等被跳过）。可操作：确保 PAC 对目标地址返回 `DIRECT`，或者受支持的代理指令。注意命中代理的结果在 v0.1 仍会以 `ENTRY_PROXY` 失败（见上文）。

**CONFIG_ROW_UNAVAILABLE**：搜索开始时插件在宿主中找不到自己的配置行，或者宿主配置端口不可用。这是整次搜索直接失败的终态，没有 attempts。通常是插件未启用、未挂载或已卸载。可操作：在插件设置中确认 dsh-search-chain 处于启用状态；如果仍然失败，重新安装该插件后在新会话中验证。

**WEB_PROVIDER_UNAVAILABLE**：DeepSeek 官方分支不可用，原因是宿主 `web-search-deepseek` 配置行未挂载，或宿主组件无法加载。这种情况不会回退到条目链。可操作：在宿主插件设置中启用 `web-search-deepseek` 行。如果暂时不需要官方分支，把 `useOfficialDeepSeekSearch` 设为 `false`，改用条目链。

**TRANSPORT_RELEASED**：该条目的传输句柄已释放，又有一次请求从该句柄迟到发出（`src/transport.js` 对已 `close` 句柄的 fetch 显式拒绝）。该码**原样上抛、不降级、不进 attempts**。注意 v0.1 实态：搜索链没有 release 接口、插件卸载不会中止在途搜索（`createSearchChain` 只导出 `search`；`src/index.js` 的 `release()` 转发因链无该方法而空转），所以它通常出现在"条目结束后（成功/失败/超时均已 `close` 句柄）适配器的迟到补发请求"，**不是**「停用或卸载把在途搜索中止」的意思。可操作：一般无需处理；若正常搜索中持续出现该码，请重试并记录时间与条目名反馈。

## 链级终态（`CHAIN_*`）

**CHAIN_NOT_CONFIGURED**：列表为空，或者所有条目都已停用。没有 attempts。可操作：添加搜索工具，或启用至少一个条目。

**CHAIN_KEYS_MISSING**：所有启用条目都因缺少 key 被跳过，没有任何条目真正尝试。reason 会列出缺失的环境变量名。可操作：为至少一个条目补上 key。

**CHAIN_UPSTREAM_FAILURES**：至少有一个条目真正失败，且没有任何条目返回有效来源。这是最常见的终态。可操作：按 attempts 中每一项的 `code` 处理（见"先读懂错误"）。

**CHAIN_BUDGET_EXHAUSTED**：总预算 `timeoutMs` 在获得有效来源前已用完。可操作：提高 `timeoutMs`，减少启用条目，或调整顺序。

**CHAIN_CONTENT_POLICY**：某个条目的内容策略明确拒绝了搜索，链已终止。可操作：修改查询内容后重试。

## 仍待证认的内容

以下判定在代码中存在，但缺少第一手实机样本，发布前需要复核。遇到与描述不符的情况，请保留脱敏样本和 reason 反馈：

- `QUOTA_LIMITED` 作为额度证据码（链级与 Brave 等适配器中使用）。
- Gemini 在 429 下，消息含 `quota` 即判为额度的做法（消息启发式，弱于码判据）。
- Gemini 本地把 `code`/`status` 转小写后再比对的口径（链级为精确匹配；小写归一与厂商实际载荷是否一致，待实机样本证认）。

代理与代理命中 PAC 的行为已用本地回环 fixture 复测并写入本页（见上文 ENTRY_PROXY 与 [复测输出](evidence/proxy-retest-v0.1.log)）；仍待实机的是：接入代理分发器的版本表现、真实供应商响应形态，以及宿主设置页对「网页搜索链」只读区域的实际呈现。

## 仍需要你提供的信息

报告问题时，请提供：

- 发生的时间、条目类型和 `name`，以及对应的错误码与 reason；
- 你使用的 DSH 版本和本插件版本；
- 是否使用了代理或 PAC，以及 DeepSeek 官方分支是否开启。

请不要提供 key、带认证信息的代理地址、完整查询或未脱敏的原始日志。
