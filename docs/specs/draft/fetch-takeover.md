# fetch 接管

本规格定义插件对宿主 `web_fetch` 能力（`ctx.web` fetch 侧）的接管：注册与可用性、SSRF 边界、URL 外发的隐私面、官方 fetch 兜底开关联动、fetch 条目模型与凭据边界，以及首期提取商范围。共用契约引用对应条款：注册类比 [DSH-001/DSH-003](dsh-integration.md#dsh-001-注册和释放搜索-provider)，官方分支类比 [DSH-005](dsh-integration.md#dsh-005-deepseek-官方-api-路由) 与 [SET-005](settings-ui.md#set-005-deepseek-官方搜索开关)，凭据面挂钩 [CFG-002](config-network.md#cfg-002-密钥来源和优先级)/[CFG-003](config-network.md#cfg-003-凭据隔离和脱敏)/[CFG-W-003](config-write-gate.md#cfg-w-003-写路径明文-key-清零)，传输挂钩 [CFG-001](config-network.md#cfg-001-每条工具的代理与直连)/[CFG-005](config-network.md#cfg-005-pac-代理路由)，预算挂钩 [FB-003](fallback.md#fb-003-预算与取消)。

宿主接缝实证（`0.2.2-rc.5`，`@deepseek-ai/dsh-web` 与 `@deepseek-ai/dsh-web-fetch-http` 包内 `src/` 原文）：`WebRuntime.registerFetchProvider(provider)` 与 `registerSearchProvider` 同一注册面，`id` 在 fetch 能力内唯一，重复注册抛 `WEB_DUPLICATE_PROVIDER`，注销随 fiber 效应或返回的 disposer，注册变更广播 `web/providers-changed`。执行期选择：宿主 `web` 行 `fetchProvider`（或环境变量 `DSH_WEB_FETCH_PROVIDER`）钉死优先；未钉死时恰有一个 `available()` 为真的 provider 自动选中，多个为 `WEB_PROVIDER_AMBIGUOUS`，零个为 `WEB_PROVIDER_UNAVAILABLE`。官方 `http` provider 恒 `available() === true` 且明示「可访问内网和本机」；搜索侧的路由 preferred 机制不存在于 fetch 侧。`WebFetchRequest` 仅含 `url`；`WebFetchResult` 为 `{url, statusCode, body, truncated}`，`body` 是宿主封闭联合 `{kind:'html'|'text'}`；非 2xx 页面状态是结果而非异常。本规格全部条款以此契约为准。

## FT-001 fetch provider 注册和释放

- **要求** dsh 装载本 bundle 时，插件必须经 `ctx.web.registerFetchProvider` 注册恰一个 `WebFetchProvider`，`id` 永久为 `search-chain`（与搜索 provider 同 id，分属两个能力注册表，宿主按能力种类判重）；注册与释放必须与 [DSH-001](dsh-integration.md#dsh-001-注册和释放搜索-provider) 的搜索 provider 同一 `ctx.effect` 生命周期。卸载必须反注册并释放 fetch 侧连接与代理出站；重新装载后 fetch 注册表内 `search-chain` 恰一个。插件不得注册第二个 fetch provider id，不得遮蔽、改写或注销宿主 `http` provider，也不得写入或修改宿主 `web` 行。
- **来源** [Issue #87](https://github.com/AMindFlow/dsh-fleetseek/issues/87)。[DSH-001](dsh-integration.md#dsh-001-注册和释放搜索-provider) 类比口径。
- **验收** 前置：测试 profile 装载候选包。动作：查询 Remote `web/listProviders`。通过：`fetch` 列表按注册序列出宿主 `http` 与 `search-chain` 两项且各出现一次；`search` 侧注册与 v0.2.0 一致不受影响。卸载后 `fetch` 列表不含 `search-chain` 且本地监听无残留连接；重装与热重载不抛 `WEB_DUPLICATE_PROVIDER`，注册表仍恰一个。

## FT-002 可用性和调用边界

- **要求** `available()` 必须同步返回接管开关（[FT-003](#ft-003-接管开关默认关闭与存量迁移)）的当前值，不得发起网络请求，也不得读取凭据服务以外的远端。`fetch(request, signal)` 每次调用必须只处理一个 URL 并遵守 `signal` 取消；一次 fetch 的总预算沿用现有 `timeoutMs`（默认 `25000` 毫秒），预算分配、到期取消与取消后零新出站的语义同 [FB-003](fallback.md#fb-003-预算与取消)。多 URL 的分解由宿主工具层执行，插件不得在单次调用内并发取多页。
- **要求** 接管开关关闭时 `available()` 必须返回 `false`；开启且未读到非法配置时必须返回 `true`，配置非法与提取商失败在执行期以结构化错误报告（[FT-006](#ft-006-官方-fetch-兜底开关联动)），不得由 `available()` 静默吞掉。
- **来源** [Issue #87](https://github.com/AMindFlow/dsh-fleetseek/issues/87)。[DSH-002](dsh-integration.md#dsh-002-可用性和调用边界) 类比口径。
- **验收** 前置：开关关。动作：离线调用 `available()` 并监听出站。通过：同步返回 `false`，零网络。前置：开关开 + 替身提取商。动作：经宿主 `web_fetch` 触发成功、中途取消（fetch 前与响应体读取中）、总预算耗尽三类调用。通过：分别返回映射结果、`WEB_ABORTED` 终态、超时类码；取消与超时之后替身收到的后续请求数为零。

## FT-003 接管开关默认关闭与存量迁移

- **要求** 本包新增三个配置键，全部缺省不补值、默认归 `normalizeConfig`（与 [SET-005](settings-ui.md#set-005-deepseek-官方搜索开关)/[FB-003](fallback.md#fb-003-预算与取消) 分界一致）：`fetchTakeover` 布尔，默认 `false`；`fetchEntries` 数组，默认空；`fetchOfficialFallback` 布尔，默认 `true`。存量 profile 不得需要任何迁移改写：键缺失即默认值；用户未触碰 fetch 面时保存不得把这三个键写上磁盘（保存粒度同现行设置口径）。默认值下插件 `available()` 为 `false`，宿主自动选择 `http`，每一次 `web_fetch` 的结果、出站目标与错误码必须与未装载本插件的同 profile 逐位一致，存量用户零感知。
- **要求** 启用接管须两步显式：用户在插件设置打开 `fetchTakeover`，并按 [DSH-003](dsh-integration.md#dsh-003-显式启用和回退) 口径把宿主 `web` 行 `fetchProvider` 钉为 `search-chain`（设置面板提供方选择器或 profile patch；手工改 patch 前须备份，须保留原行其余键与 `!!js` 自定义标签）。插件不得代写 `web` 行。开关开而宿主未钉死时，自动选择路径必须得到宿主 `WEB_PROVIDER_AMBIGUOUS`（`http` 与 `search-chain` 同时可用），这是显性可见的未钉死状态；设置页与文档必须写明该依赖与钉死办法。
- **来源** [Issue #87](https://github.com/AMindFlow/dsh-fleetseek/issues/87) 红线「新能力默认值 = 不接管」。[DSH-003](dsh-integration.md#dsh-003-显式启用和回退) 类比口径。
- **验收** 分场景验证。① 存量 profile（含 `fetchProvider: http`、其他插件行与 `!!js` 标签）装载候选包不打开开关：`web_fetch` 三个示例 URL 的响应体、`statusCode`、错误码与未装载插件基线逐位一致，磁盘 profile 未被写入新键。② 开 `fetchTakeover` 且钉死 `web.fetchProvider: search-chain`：`web/listProviders` 选中生效，fetch 经提取商。③ 开开关不钉死：自动选择报 `WEB_PROVIDER_AMBIGUOUS`，提示文案可见。④ 撤销钉死：回落到 `http`，行为回到 ①。

## FT-004 URL 外发披露与按条目关闭

- **要求** 用户 URL 发给第三方提取商属重披露面。在用户显式启用（`fetchTakeover` 开且存在启用 fetch 条目）之前，插件不得向任何提取商端点发出任何用户 URL 或其派生请求。启用后，每一次这类出网都符合「每一次出网路径的改变都可见、可钉死」口径（HANDOFF 2026-11-28 定稿措辞）。
- **要求** 设置页 `fetchTakeover` 开关旁必须写明：外发给哪个提取商、随 URL 一并发出的内容（提取商鉴权头、所选代理路径，不发宿主凭据与 Cookie）、SSRF 边界（[FT-005](#ft-005-ssrf-边界与重定向逐-hop-过闸)）与兜底行为（[FT-006](#ft-006-官方-fetch-兜底开关联动)）。`fetchEntries[].enabled` 即按条目关闭：置 `false` 后该条目供应商的 URL 出站必须为零；全部 fetch 条目禁用等价于链未配置终态（[FT-006](#ft-006-官方-fetch-兜底开关联动)e）。README 与 docs/user 必须包含上述四项披露，交付 PR 必须同步更新两者，缺失即评审不过。
- **来源** [Issue #87](https://github.com/AMindFlow/dsh-fleetseek/issues/87) 红线「URL 外发必须文档化且可按条目关闭」；[HANDOFF 出网路径口径](../../project/HANDOFF-20261128.md)。
- **验收** ① 前置：开关关 + 本地监听冒充提取商端点。动作：经宿主 `web_fetch` 抓取任意公网 URL。通过：监听端点零请求。② 前置：开关开。动作：打开设置页。通过：开关旁披露四项齐备并有文档链接。③ 前置：两个启用条目 A/B。动作：仅禁用 A 后发起 fetch。通过：A 供应商出站为零、B 正常。④ 文档评审：README 与 docs/user 的外发小节含提取商名、随发内容、SSRF 边界、兜底语义四要素。

## FT-005 SSRF 边界与重定向逐 hop 过闸

- **要求** 提取商腿发出前，插件必须先过闸；命中闸口的 URL 及其任何部分不得离开本机。闸必须拒绝：
  1. 非 `http`/`https` scheme（`file://`、`gopher://`、`data:`、`javascript:` 及大小写、前后空白与等价变体）；
  2. 内嵌凭据的 URL（`user:pass@`）；
  3. 长度超过 `2048` 字符的 URL（对齐宿主 `WEB_FETCH_MAX_URL_LENGTH`）；
  4. host 为 `localhost`、`*.localhost` 或空 host；
  5. 环回、私网、链路本地、组播与保留地址段：IPv4 `127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`、`0.0.0.0/8`、`100.64.0.0/10`、`224.0.0.0/4` 及以上、广播段；IPv6 `::1`、未指定 `::`、`fc00::/7`、`fe80::/10`、IPv4 映射形态（`::ffff:`）与 IPv4 兼容形态；
  6. 等价绕过形态：判定必须基于 WHATWG URL 解析后的归一化 host，覆盖十进制（`2130706433`）、十六进制（`0x7f000001`）、八进制前导零（`0177.0.0.1`）、缩写（`127.1`）、IPv6 压缩与全展开（`0:0:0:0:0:0:0:1`）等等价写法；
  7. 域名的 DNS 解析结果含第 5 点任一段（尽力预解析：任一命中即拒；解析失败视为未定，可外发并交由提取商侧失败）。
- **要求** 重定向每一跳都必须过闸：闸覆盖插件知悉的全部 hop——请求 URL、提取商接口回报的重定向链（接口回报即逐 hop 过闸）、以及返回的最终 URL。任一 hop 命中必须整份结果作废、返回内容为零，并报告结构化错误（`WEB_BLOCKED_URL`）；不得先回传内容再警告。首期提取商接口必须至少回报最终 URL，回报不了最终 URL 的提取商不得进入首期范围。预解析属尽力而为：提取商侧解析与重定向不受本机逐 hop 控制，此残余风险必须在 docs/user 披露（见开放问题）。
- **要求** 拒绝必须以 `WEB_BLOCKED_URL` 码报告，原因必须可见且脱敏：写明命中的规则类别与 URL scheme；host 只以地址类别呈现（环回/私网/链路本地/保留段/内嵌凭据/超长/scheme）；不得包含 query、fragment、用户名、密码或完整路径。闸拒绝的路径必须零网络出站（第 7 点的尽力预解析除外，且其结果不得离开本机）。
- **来源** [Issue #87](https://github.com/AMindFlow/dsh-fleetseek/issues/87) 红线「SSRF 边界（localhost/私网/file:// 拒绝）；拒绝原因可见且脱敏；重定向每一跳都过闸」。宿主先例：`dsh-web-fetch-http` `policy.ts`（scheme/凭据/长度闸与 `WEB_BLOCKED_URL` 语义）。
- **验收** 逐规则独立验证，且每条规则至少覆盖字面写法、等价绕过写法与归一化后写法三种输入：`file://` 与 `gopher://`；`http://127.0.0.1/`、`http://2130706433/`、`http://0x7f000001/`、`http://0177.0.0.1/`、`http://127.1/`；`http://[::1]/`、`http://[0:0:0:0:0:0:0:1]/`、`http://[::ffff:127.0.0.1]/`；`http://[fe80::1]/`、私网四段各取样、`http://localhost/`、`http://api.localhost/`；内嵌凭据与 2049 字符 URL；本地 DNS 映射到 `127.0.0.1` 的域名。通过条件：全部以 `WEB_BLOCKED_URL` 拒绝，提取商监听零请求，拒绝文案无 query 与明文 host。重定向 fixture：公网→私网、公网→公网→环回两条链，通过条件：内容零回传、码正确。对照组：公网 URL 不得误拦，逐 hop 公网的正常链完整通过。

## FT-006 官方 fetch 兜底开关联动

- **要求** `fetchOfficialFallback`（默认 `true`）联动兜底腿。兜底腿必须复用宿主公开导出的官方匿名 provider（`dsh-web-fetch-http` 的 `HttpFetchProvider` 公开类，实证见其包导出）构造本地匿名抓取，不得自建第二套「官方语义」；其限制沿用宿主官方默认（响应 `5_000_000` 字节、解码 `100_000` 字符、重定向上限 `5`、同源限制与 UA 语义），超时取该次 fetch 当时的剩余 FB-003 预算。兜底腿只过宿主官方闸（仅 http/https、无内嵌凭据、2048 长度上限），不设 localhost/私网限制——与官方「可访问内网和本机」的产品语义一致。
- **要求** 行为矩阵必须逐项成立：
  a) 接管关：`web_fetch` 由宿主官方 `http` 直接服务，本开关无效果（[FT-003](#ft-003-接管开关默认关闭与存量迁移)）；
  b) 接管开且提取商链成功：返回提取商映射结果；
  c) 接管开且提取商链终态失败（全部启用条目失败、超时、预算耗尽），兜底开：改由兜底腿本地匿名抓取服务；兜底成功必须在宿主本机日志记录「fetch 经兜底腿服务」及链侧原因，不得伪造提取商标记、正文或元数据；
  d) 兜底关：向宿主返回链终态错误，码与原因可见；
  e) SSRF 命中（[FT-005](#ft-005-ssrf-边界与重定向逐-hop-过闸)）：提取商腿一律拒绝；目标为环回/私网时，兜底开则由兜底腿服务（本地出网、零向提取商披露，行为与官方一致），兜底关则以 `WEB_BLOCKED_URL` 上抛；`file://` 等非 http(s) 两腿都拒绝（兜底腿的宿主官方闸同样只放 http/https）。
- **要求** 兜底腿也失败时必须报告复合终态，同时给出提取商链侧与兜底腿两侧原因，不得隐藏任一侧。多条启用 fetch 条目时，链执行顺序与跳过条件类比 [FB-001](fallback.md#fb-001-自定义顺序与降级条件)（数组序为准，缺 key 按 [CFG-002](config-network.md#cfg-002-密钥来源和优先级) 跳过），预算按 [FB-003](fallback.md#fb-003-预算与取消) 分配。
- **来源** [Issue #87](https://github.com/AMindFlow/dsh-fleetseek/issues/87) 红线「官方 fetch 兜底开关联动」。[SET-005](settings-ui.md#set-005-deepseek-官方搜索开关)/[DSH-005](dsh-integration.md#dsh-005-deepseek-官方-api-路由) 的官方分支类比口径。
- **验收** 逐格验证：① a 格按 FT-003 场景① 逐位一致；② b 格替身提取商结果透传；③ c 格注入提取商全失败 + 本地 http 服务，通过：兜底内容正确、宿主日志含兜底标记与链侧原因；④ d 格同注入 + 兜底关，通过：结构化链终态上抛；⑤ e 格 `http://127.0.0.1:port/` 两态——兜底开：本地服务成功且提取商监听零请求；兜底关：`WEB_BLOCKED_URL`；`file:///etc/passwd` 两态都拒绝；⑥ 兜底腿与提取商双失败：错误同时含两侧原因；⑦ 两条目一条缺 key 一条失败：按 FB-001 口径跳过并进入 c/d 分支。

## FT-007 fetch 条目模型与凭据边界

- **要求** fetch 条目必须存放在独立数组 `fetchEntries`，与搜索 `entries` 分离；每项由稳定 `id`、`type`、`name`、`enabled`、`credentialRef` 与可选 `proxy` 组成。`type` 联合仅扩展在 fetch 侧常量（[FT-009](#ft-009-首期提取商范围与接口预留)），搜索目录 `TOOL_TYPES`/CAT-001 与 `scripts/oracle-style-50.mjs`（含 `CATALOG_TEXT`）不得触碰。
- **要求** 提取商 key 值只能经宿主凭据服务写入（write-only）：配置层与任何 `settings/mutate` 载荷不得出现 key 明文或 `SECRET_FIELD` 命中键名（同 [CFG-W-003](config-write-gate.md#cfg-w-003-写路径明文-key-清零) 对 fetch 面字段的等效力）；`credentialRef` 字段必须标 `role: credential-ref`；保存前预检沿用 [CFG-W-004](config-write-gate.md#设计决定) 先于凭据写入的模式——配置非法时零 `settings/mutate` 且零孤儿凭据写入；重开编辑器不得回读或回显旧值（[CFG-003](config-network.md#cfg-003-凭据隔离和脱敏)）。请求期解析顺序复用 [CFG-002](config-network.md#cfg-002-密钥来源和优先级)（条目引用 → 目录环境变量 → 托管引用）。key 只随该条目提取商的鉴权头发送，不得进入 PAC 下载、其他条目或其他出站。
- **要求** 带认证信息的代理 URL 与其他凭据同边界：只留在本机与宿主凭据服务，日志、错误与诊断产物不得携带其认证参数（[CFG-003](config-network.md#cfg-003-凭据隔离和脱敏)）。fetch 条目 `proxy` 的直连/固定代理/PAC 语义、失败不静默回退与报码复用 [CFG-001](config-network.md#cfg-001-每条工具的代理与直连)/[CFG-005](config-network.md#cfg-005-pac-代理路由)。
- **来源** [Issue #87](https://github.com/AMindFlow/dsh-fleetseek/issues/87) 红线「凭据边界复用凭据服务」。[CFG-002](config-network.md#cfg-002-密钥来源和优先级)/[CFG-003](config-network.md#cfg-003-凭据隔离和脱敏)/[CFG-W-003](config-write-gate.md#cfg-w-003-写路径明文-key-清零)。
- **验收** ① 保存合成 key：磁盘配置扫描无明文、面板列表与编辑器回包无明文；重开编辑器不回显。② 用两个不同 key 的 fetch 条目分别触发：鉴权头归属正确、PAC 下载与另一条目请求无泄漏。③ 在 fetch 面字段构造 `SECRET_FIELD` 残留：保存路径按 CFG-W-003 验收同构断言清零。④ 构造非法 fetchEntries 形状触发写前预检：零 settings 写、零孤儿凭据。⑤ 条目配本地代理：请求经代理捕获；断开代理：该条目报代理原因且直连请求为零。

## FT-008 传输、预算与结果映射

- **要求** 提取商出站必须复用插件既有传输栈（`createEntryTransport`：直连 `globalThis.fetch`、固定代理 `ProxyAgent`、PAC 路由，同 [CFG-001](config-network.md#cfg-001-每条工具的代理与直连)），响应体读取受 `MAX_RESPONSE_BYTES`（2 MiB）上限约束，超限早停并按提取商失败分类（FB-005 口径）。
- **要求** 提取商响应映射到 `WebFetchResult` 必须：`url` 取提取商回报的最终 URL 并先过 [FT-005](#ft-005-ssrf-边界与重定向逐-hop-过闸) 终闸；`statusCode` 取提取商回报的页面 HTTP 状态，提取商不回报时以其自身响应状态映射；`body` 只能进宿主封闭联合的 `{kind:'text'}` 分支（正文为 markdown/纯文本/未知文本一律 `text`，不得伪造 `html` 或自创 kind）；解码正文超过 `100_000` 字符（对齐宿主官方默认）必须截断并置 `truncated: true`。提取商回报非 2xx 页面状态且给出可用正文时，必须作为结果返回而非异常（宿主语义：状态是资源状态的一部分）；提取商自身认证、配额、限流、网络失败必须落成 FB-005 口径的带码分类并计入链决策。
- **来源** [Issue #87](https://github.com/AMindFlow/dsh-fleetseek/issues/87) 红线「传输与凭据复用既有栈」。[CFG-001](config-network.md#cfg-001-每条工具的代理与直连)/[FB-003](fallback.md#fb-003-预算与取消)。宿主先例：`dsh-web-fetch-http` 限额默认值与「非 2xx 是结果」语义。
- **验收** 替身提取商分别构造：正常正文、markdown、页面非 2xx 且带正文、无正文、超 100k 字符、超 2 MiB 字节、401、429。通过：逐 fixture 断言 `url/statusCode/body.kind/truncated` 映射、超限截断标志、以及 401/429 的 FB-005 归类；`body.kind` 恒为 `text`；无正文与超限场景不产出伪造正文。

## FT-009 首期提取商范围与接口预留

- **要求** 首期 v1 必须只交付一个提取类型 `tavily-extract`（Tavily Extract API）；其余提取商（Jina Reader、Firecrawl 等）不在首期。该类型必须有 key（经 [CFG-002](config-network.md#cfg-002-密钥来源和优先级) 链解析，缺 key 按 [FB-001](fallback.md#fb-001-自定义顺序与降级条件) 跳过），不得提供免 key 的提取条目形态。fetch 类型扩展点必须预留为：新增提取商 = 新增 fetch 侧类型常量 + 适配文件 + 文档行，不得要求改动 provider 注册、SSRF 闸、兜底腿或凭据面。首期提取商接口必须回报最终 URL，重定向 hop 链以可选字段预留（[FT-005](#ft-005-ssrf-边界与重定向逐-hop-过闸)）；`scripts/oracle-style-50.mjs`（含 `CATALOG_TEXT`）必须零改动且其测试持续通过。
- **来源** [Issue #87](https://github.com/AMindFlow/dsh-fleetseek/issues/87)「首期提取商范围：Issue 未点名，可定最小 v1（单提取商+接口预留）」。选型理由见设计决定 D-FT7。
- **验收** ① `tavily-extract` 经替身完成端到端（成功/失败/超限），真实付费调用仅在获批准预算内执行并留脱敏记录。② 以替身类型走一遍扩展点：仅新增常量+适配+文档即可注册第二个提取商，FT-001–FT-008 代码路径零 diff（以测试与 diff 审查断言）。③ `git diff` 断言 `scripts/oracle-style-50.mjs` 为空且 `npm test` 全绿。④ 免 key fetch 条目在写闸被拒并有可读原因。

## 非目标

- 不做 JS 渲染、浏览器自动化、截图或 PDF/图片/二进制提取（宿主 `text/html` 渲染归宿主工具层，提取商正文一律 `text`）。
- 不做 LLM 二次总结、改写或提取后提问（宿主 seam 明示呈现与 LLM 关注点在安全取回之外）。
- 不做与搜索链混用的条目数组、不改 CAT-001 八类型目录、不改 provider id / 配置行 id / 既有键名（红线 1）。
- 不写宿主 `web` 行、不代用户钉死 `fetchProvider`、不引入新 provider id 或新配置命名空间。
- 不扩展宿主 `WebFetchBody` 封闭联合（`markdown` kind 属宿主跨包协同变更）。
- 不做多提取商并行、结果仲裁或成本优化；不做提取商侧 DNS/解析的本机钉死（残余风险在 FT-005 披露）。
- 不改 `web_search` 路径与既有 FB/CFG/SET/DSH 条款语义。

## 设计决定

- **D-FT1 独立 fetch 条目模型（`fetchEntries` 与搜索 `entries` 分离）**：隔离面最小——搜索条目的 schema、设置面板、CAT 目录与 oracle 契约零改动，红线 1/4/5 的存量风险直接归零；fetch 语义（一次一个 URL、无查询词、无多源引用）与搜索条目差异大，混用会让逐字段校验、面板与降级语义双倍复杂；「按条目关闭外发」用 `enabled` 自然表达。代价是凭据/代理/预算复用走同一批底层模块而非同一数组，实现面清晰可测。
- **D-FT2 `available()` 只反映接管开关、不读取宿主钉死状态**：开关开而未钉死时选择宿主显性 `WEB_PROVIDER_AMBIGUOUS`，而不是插件私下让 `available()` 为假、由 `http` 无感续服务。前者是「改变可见」，后者制造静默窗口，违反红线 3。
- **D-FT3 兜底腿复用宿主公开导出 `HttpFetchProvider` 构造**（`@deepseek-ai/dsh-web-fetch-http` 实证公开导出该类与 `LOCAL_FETCH_PROVIDER_ID`）：官方闸（scheme/凭据/长度/同源重定向/限额）零漂移，宿主版本升级时兜底语义随依赖版本同步；插件以精确版本 dependency 安装同一发布线。
- **D-FT4 默认值全 OFF / 兜底默认 on**：URL 外发是比搜索词更重的披露面，默认不接管是第一道防线；兜底腿只在用户已显式开启接管的会话内生效，且默认开以保证「接管后 fetch 不因提取商故障而整体不可用」，与 SET-005「官方兜底默认开」的开关语义类比。
- **D-FT5 markdown → `text` 映射**：宿主封闭联合是跨包协同变更点，插件无权扩展；`text` 是当前联合内唯一如实表达提取正文的分支。
- **D-FT6 fetch 预算复用现有 `timeoutMs`（25s）而非官方 provider 的 30s 默认**：不新增数值配置面；25s 与官方 30s 的差异在 README 披露。兜底腿超时用当时剩余预算，限额沿用宿主官方默认常量。
- **D-FT7 首期选型 Tavily Extract**：与既有 Tavily 搜索后端同供应商同 key 族（`TAVILY_API_KEY`），凭据服务、传输栈、代理/PAC、写闸与 FB 语义全部复用；JSON 接口回报最终 URL 与逐 URL 状态，满足 FT-005 终闸与 FT-008 映射的接口前提。备选 Jina Reader（免 key 通道但正文与速率语义不同）与 Firecrawl 列开放问题。
- **D-FT8 预解析尽力而为、不做连接钉死**：宿主官方 provider 本身可访问内网，DNS 级方案在宿主侧无先例；插件闸以归一化形态判定为主、预解析为辅，提取商侧解析残余风险文档化（开放问题 4）。

## 开放问题

1. 首期提取商终确认：Tavily Extract 选型待用户拍板（Issue #87 未点名；来源链即本 Issue 与 D-FT7）。
2. 免 key 提取商（Jina Reader 路线）是否纳入后续版本：涉及免 key 条目的限额、失败语义与披露差异。
3. 设置面板是否提供「一键引导钉死 `web.fetchProvider`」：现口径为插件不写宿主 `web` 行（FT-003），便利性与边界的取舍待评审。
4. 提取商侧 DNS rebinding 与不可见 hop 的披露措辞是否需要更强缓解（如强制提取商回报 hop 链才启用重定向跟随）：随首期真实接口验证定稿。
5. `TAVILY_API_KEY` 与搜索条目共用一把 key 的成本披露口径（Extract 按次计费进 README 的具体文案）。
