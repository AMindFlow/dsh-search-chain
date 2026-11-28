# fetch 接管 Oracle（web_fetch 接管 · 工作包 #87）

本文件是 [fetch-takeover.md](fetch-takeover.md) 的**独立测试 Oracle**：只依据规格草案 + PR #104 lead 审阅裁决编制「可观察预期 + 验证方法 + 档位」，不写实现、不改 `src/`。实现 PR 使红测试转绿；**当前全红属预期**，实现方不得删断言、改 skip 或用 skip 路径绕过（红/绿策略同 `test/helpers/impl.js`：模块缺失 → `failIfUnimplemented` 记红，不 skip）。

- 依据基线：`5e9665e`（规格草案，PR #104）。裁决输入：PR #104 lead 审阅（gate 1 通过；Tavily Extract 已由用户拍板为 v1 终稿；维持两步显式钉死，不提供一键引导写行；DNS rebinding 采「归一化判定为主 + 尽力预解析为辅 + docs/user 披露」；真实付费调用发布前另行申请次数）。
- 宿主契约实证来源：`@deepseek-ai/dsh-web@0.2.2-rc.5` 包内 `src/index.ts`/`src/types.ts`（`registerFetchProvider` 与 `WEB_DUPLICATE_PROVIDER`、选择语义：钉死优先 → 恰一可用自动选中 → 多可用 `WEB_PROVIDER_AMBIGUOUS` → 零可用 `WEB_PROVIDER_UNAVAILABLE`；`WebFetchResult = {url, statusCode, body:{kind:'html'|'text',content}, truncated}`；非 2xx 是结果；`listProviders` 按注册序列出、不受 `available()` 过滤）；`@deepseek-ai/dsh-web-fetch-http@0.0.1-rc.5` 包内 `lib/`（编译自其包内 src，语义一致）：公开导出 `HttpFetchProvider`、`LOCAL_FETCH_PROVIDER_ID="http"`；默认闸 `maxUrlLength=2048`、`maxResponseBytes=5e6`、`maxBodyChars=1e5`、`timeoutMs=3e4`、`maxRedirects=5`；`validateFetchUrl` 只查 scheme(http/https)/凭据/长度——内嵌凭据抛 `WEB_BLOCKED_URL`、超长抛 `WEB_INVALID_URL`（下文歧义 OQ-O2 相关）。
- WHATWG URL 归一化事实以 Node（engines ≥24）`new URL()` 实测为矩阵「归一化列」，全部已实机核对（见 §5 注脚列）。

## 0. 观测面与测试资产

统一观测面（Oracle 只看这些，不看实现内部）：

| 观测面 | 说明 |
| --- | --- |
| fetch 注册表 | 单元经 `test/helpers/fetch-oracle.js` 的 web seam 替身捕获 `registerFetchProvider` 注册项（含重复 id 抛 `WEB_DUPLICATE_PROVIDER`、反注册、选择语义）；实机经 Remote `web/listProviders` 的 `fetch` 列表。既有 `fake-host.js` 的 `registerFetchProvider` 是陷阱计数，fetch 侧捕获由新 helper 承担，既有文件不动。 |
| `available()` | 同步返回值 + 出站零（fake-fetch `calls.length`、本地监听命中数）。 |
| 提取商本地监听 | `fetch-oracle.js` 在 `127.0.0.1:0` 起 http 服务冒充提取商端点：`requests[]` 计数、`headersOf(i)` 头检查（鉴权头归属、无宿主 Cookie）。出站注入面用 `fake-fetch` 时以 `calls` 计数替代（两种模式各按用例注明）。 |
| `WEB_BLOCKED_URL` | `err.code === "WEB_BLOCKED_URL"`；文案要素：含命中规则类别 + scheme；host 仅以地址类别词呈现；断言不含 query 子串、fragment、`user:`、`pass:` 与完整路径（可辨识合成片段零命中）。 |
| `mutates()/credentialSets()` | `test/helpers/settings-panel-v02.js` 的 `fetchStub`：`mutates()`、`credentialSets()`、`outbound` 计数。 |
| `WebFetchResult` | `{url, statusCode, body.kind, body.content, truncated}` 字段映射逐项断言。 |
| 兜底腿本地服务 | 兜底腿目标 = 本地 http 服务（监听命中即「兜底成功且只打本地」）；`file://`/拒绝场景该监听命中必须为零。 |
| 日志 | `createLogCapture()`/`installConsole()`：兜底标记与链侧原因在场；秘密值（`SYNTHETIC_KEY`）零命中。 |
| 受控时钟 | `test/helpers/clock.js`：预算分配、到期、取消后零出站。 |

测试文件规划（骨架随本 Oracle 提交，运行全红属预期）：

| 文件 | 条款 |
| --- | --- |
| `test/ft-oracle-provider.test.js` | FT-001 / FT-002 / FT-003 |
| `test/ft-oracle-ssrf.test.js` | FT-005（全矩阵 + 重定向两链） |
| `test/ft-oracle-chain.test.js` | FT-004 / FT-006 |
| `test/ft-oracle-credentials.test.js` | FT-007 |
| `test/ft-oracle-mapping.test.js` | FT-008 / FT-009 |
| `test/ft-oracle-no-outbound.test.js` | CI 零真实出网断言（§6） |
| `test/helpers/fetch-oracle.js` | 上述文件共用 helper（本地监听、web seam 替身、配置装具） |

## 1. 逐条款 Oracle

档位：**A** = node:test 自动化；**B** = 宿主实机项；**C** = 文档/评审项。

### FT-001 fetch provider 注册和释放

| # | 可观察预期（观测面） | 验证方法 | 档 |
| --- | --- | --- | --- |
| 1 | `apply` 后经 `registerFetchProvider` 注册恰一项，`id === "search-chain"`；同次装载 `registerSearchProvider` 也恰一项（搜索侧不受影响）；注册表 fetch 列表 = 预置 `http` 之后 `search-chain`（注册序） | `tryImportSrc("index.js")` + `fetch-oracle` web seam 装具装载 → 断言 fetch/search 注册各 1、id、`listProviders` 形态 | A |
| 2 | 重复注册（同 id 再注册）抛 `WebError` 码 `WEB_DUPLICATE_PROVIDER`（宿主语义，seam 替身同构实现）；插件自身装载路径不在同一装载周期内注册两次 | seam 替身直接二次 `registerFetchProvider({id:"search-chain"})` 断言码；装载周期内 `registerFetchProvider` 调用计数 === 1 | A |
| 3 | 不得注册第二个 fetch id：断言 fetch 注册调用序列中本插件来源的 id 集合恒 `{"search-chain"}` | 装载 + 热重载模拟后统计 | A |
| 4 | 卸载（disposer / fiber 效应）后 fetch 注册表不含 `search-chain`；本地监听无残留连接（活跃 socket 计数 0） | seam 断言注册清空；本地提取商监听 `close` 前活跃连接断言 0 | A |
| 5 | 重装/热重载不抛 `WEB_DUPLICATE_PROVIDER`，注册表仍恰一个 | 装载→卸载→装载循环 ×2 | A |
| 6 | 不遮蔽/改写/注销宿主 `http` provider，不写宿主 `web` 行 | seam 中预置 `http` provider 对象引用装载前后同一实例、仍在列表；`editor` 写记录不含宿主 `web` 行键 | A |
| 7 | 真 profile：`web/listProviders` 的 `fetch` 列出宿主 `http` 与 `search-chain` 各恰一次；`search` 侧与 v0.2.0 一致 | 测试 profile `install_bundle` → Remote `web/listProviders`；卸载后 `fetch` 无 `search-chain`；热重载/重装核对 | B |

### FT-002 可用性和调用边界

| # | 可观察预期 | 验证方法 | 档 |
| --- | --- | --- | --- |
| 1 | 开关关：`available()` 同步返回 `false`；同步性 = 不需 `await` 即得布尔 | 断言返回值为 boolean `false`（非 Promise） | A |
| 2 | `available()` 零网络：离线（无监听、fake-fetch default never、无本地监听命中、无 DNS） | 装具下调用 N 次断言 `fetchFn.calls.length===0` 且监听计数 0 | A |
| 3 | 开关开 + 无非法配置：`available()` 为 `true`；「开而未钉死」不变——不为假（D-FT2），选路期才见 `WEB_PROVIDER_AMBIGUOUS` | `available()===true`；seam 未钉死选择断言 `WEB_PROVIDER_AMBIGUOUS` | A |
| 4 | 开 + 非法配置：`available()` 仍 `true`，非法在执行期以结构化错误报告（不被静默吞掉） | 注入非法 `fetchEntries` 形状 → `available()===true`；`fetch()` 拒且码可读（`CONFIG_INVALID` 类，见 OQ-O5） | A |
| 5 | 成功腿：经 seam `fetch({url})` 返回映射结果（`WebFetchResult` 四字段） | 替身提取商（本地监听或 fake-fetch 路由）成功应答 | A |
| 6 | 中途取消两时点：fetch 前 abort、响应体读取中 abort → 终态码 `WEB_ABORTED`；之后替身后续请求数增量为 0 | 受控时钟 + `AbortController` 两时点注入；abort 后清计数再等待一个宏任务断言零增量 | A |
| 7 | 总预算耗尽：受控时钟拨满 25000ms → 超时类码（OQ-O4 定码）；到期取消在途、取消后零新出站 | `clock.advance` 拨钟；断言码 ∈ 批准集合 + 出站计数冻结 | A |
| 8 | 单次调用只处理一个 URL：一次 `fetch()` 对提取商出站 ≤1 请求（不含重定向 hop 链） | 监听请求计数断言 ≤1 | A |

### FT-003 接管开关默认关闭与存量迁移

| # | 可观察预期 | 验证方法 | 档 |
| --- | --- | --- | --- |
| 1 | 三键默认值：`fetchTakeover=false`、`fetchEntries=[]`、`fetchOfficialFallback=true`；键缺失即默认，normalizeConfig 缺省不补显式写盘值 | 装载空 fetch 面配置 → `available()===false`；写盘内容扫描不含三键（磁盘/`settings` 快照扫描） | A |
| 2 | 默认下宿主自动选择 `http`（本插件 `available()` false，不参与多可用） | seam：`http`(true)+`search-chain`(false) → 自动选择命中 `http` | A |
| 3 | 存量 profile 不打开开关：三个示例 URL 的响应体、`statusCode`、错误码与未装载插件基线**逐位一致**；磁盘 profile 未被写入新键（含 `!!js` 标签与其他行原样） | 实机独立测试 profile 装载候选包，`web_fetch` 三 URL（公网、非 2xx、坏 URL）比对基线快照；前后 `diff` profile patch 文件 | B |
| 4 | 未触碰 fetch 面时保存不落新键：面板任意保存路径的 `mutates()` 载荷路径不含 `fetchTakeover`/`fetchEntries`/`fetchOfficialFallback` | `fetchStub`：面板切换无关开关/重排/保存条目后 `mutates()` 操作路径扫描 | A |
| 5 | 两步显式之②不代写：插件任何路径不写宿主 `web` 行 `fetchProvider` | seam/`editor` 写记录扫描无 `web.fetchProvider` 写 | A |
| 6 | 开关开而未钉死：自动选择路径得 `WEB_PROVIDER_AMBIGUOUS`，提示文案可见（钉死办法文案见 FT-004 文档项） | seam 选择断言码与消息含两 id | A |
| 7 | 撤销钉死（恢复 `fetchProvider: http` 或删除）→ 行为回落到 #3 的逐位一致 | 实机：改回 web 行后重放三 URL 比对 | B |

### FT-004 URL 外发披露与按条目关闭

| # | 可观察预期 | 验证方法 | 档 |
| --- | --- | --- | --- |
| 1 | 启用前零外发：开关关（无论条目是否已配好）经 seam `fetch()` → 提取商本地监听零请求、`fetchFn.calls` 零 | 监听计数 + fake-fetch 双观测 | A |
| 2 | 启用判定 = 「`fetchTakeover` 开 **且** 存在启用 fetch 条目」：开开关但条目全缺/全禁用 → 仍零外发 | 同上，两种子态 | A |
| 3 | 启用后每次外发头：提取商请求携带该条目鉴权头；**不携带**宿主 Cookie/其他凭据头（监听 `headersOf` 断言 `cookie` 零、鉴权头 = 该条目 key） | 本地监听头检查 | A |
| 4 | 按条目关闭：A/B 两启用条目，禁用 A 后发起 fetch → A 供应商监听零请求、B 正常命中 | 两监听端口分别计数 | A |
| 5 | 全部条目禁用 ≡ 链未配置终态 | `fetch()` 报未配置类终态（FB-004 `CHAIN_NOT_CONFIGURED` 口径，见 OQ-O5） | A |
| 6 | 设置页开关旁披露四要素（提取商名、随 URL 发出内容清单、SSRF 边界、兜底行为）+ 文档链接；README 与 docs/user 同四要素 | 设置页实机目检 + `grep` 文档四要素清单评审（PR diff 评审项） | B/C |

### FT-005 SSRF 边界与重定向逐 hop 过闸

| # | 可观察预期 | 验证方法 | 档 |
| --- | --- | --- | --- |
| 1 | §5 全矩阵每行：`fetch(url)` 抛 `err.code === "WEB_BLOCKED_URL"`（OQ-O1/O2 批准前按本行「预期码」列）；提取商监听与 `fetchFn.calls` 零出站；文案含规则类别词 + scheme，host 仅类别词，无 query/fragment/用户名/密码/完整路径片段 | 数据驱动循环逐行断言（`ft-oracle-ssrf.test.js`） | A |
| 2 | 重定向链 fixture R-1（公网→私网）：提取商脚本回报 hop 链含 `192.168.1.1`、最终 URL 私网、并**已带回正文**（正文含 `LEAK-MARKER`）→ 整份作废：结果不含 `LEAK-MARKER` 任何子串、`WEB_BLOCKED_URL` 上抛 | 提取商脚本 = 本地监听脚本应答 JSON（含 `failed_urls`/`final_url` 预留字段，形态见 OQ-O3） | A |
| 3 | 重定向链 fixture R-2（公网→公网→环回）：同上，最终 URL `http://127.0.0.1:port/x` → 零回传 + `WEB_BLOCKED_URL` | 同上 | A |
| 4 | 终闸：脚本回报最终 URL = `http://127.0.0.1:port/x` 但链字段缺省（只有最终 URL）→ 同样作废 | 同上 | A |
| 5 | 对照组：全 hop 公网（`.invalid` 域 + 合法公网 IP 字面）链完整通过，`url`/`statusCode`/正文透传不误拦 | 脚本应答公网链 | A |
| 6 | 第 7 点尽力预解析：`evil.test` 的 DNS 解析（注入 lookup 桩）= `127.0.0.1` → 拒绝；解析失败（桩抛 `ENOTFOUND`）→ 可外发（监听命中 1 次，交由提取商失败）；预解析出站仅 DNS 不出提取商监听 | `fetchDeps.dns` 注入桩（OQ-O6） | A |
| 7 | `*.localhost` 仅闸拒，兜底腿不受本闸影响（联动语义归 FT-006 #8/#9，此处只闸侧断言） | 已在矩阵行覆盖 | A |
| 8 | 残余风险披露：提取商侧解析不受本机控制、预解析尽力而为的措辞在 docs/user 在场 | 文档评审 | C |

### FT-006 官方 fetch 兜底开关联动

| # | 可观察预期 | 验证方法 | 档 |
| --- | --- | --- | --- |
| 1 | a 格：接管关 → 本开关无效果，宿主官方 `http` 服务（= FT-003 #3 逐位一致，本文件不重复） | 引用 FT-003 | B |
| 2 | b 格：接管开 + 替身提取商成功 → 返回提取商映射结果（透传字段，无兜底命中） | seam `fetch()` 断言 + 兜底目标监听零命中 | A |
| 3 | c 格：链终态失败（全启用条目失败/超时/预算耗尽三注入各一）+ 兜底开 → 改由兜底腿服务：目标 = 本地 http 服务，监听命中 1 次、结果 = 本地正文；宿主日志含「fetch 经兜底腿服务」标记与链侧原因；结果不含伪造提取商标记 | 提取商脚本 500/超时/拨钟三态；目标监听 + `createLogCapture()` 断言 | A |
| 4 | d 格：兜底关 + 链失败 → 向宿主返回结构化链终态错误，码与原因可见（`details.attempts` 含各条目码，FB-006 不压平） | 断言 `err.code`/`details.attempts` 原码 | A |
| 5 | 双失败复合：链失败 + 兜底目标也失败（本地服务返回 500/拒连）→ 复合终态**同时**含链侧与兜底腿两侧原因文本 | 断言 message/details 两侧标记都在 | A |
| 6 | 兜底腿 = 宿主官方 provider 构造：限额语义实证——兜底响应 `Content-Length` > 5e6 拒绝（`WEB_FETCH_TOO_LARGE` 类）、解码 > 1e5 字符截断 `truncated:true`、重定向 > 5 hop `WEB_REDIRECT_BLOCKED`、跨源重定向拒（同 hop 上限观察） | 本地目标服务构造超限/多跳/跨源 fixture；观察随 D-FT3 实现（构造点为替身注入面，见 OQ-O7） | A |
| 7 | 兜底腿超时 = 当时剩余预算（非官方 30s 默认）：拨钟到链剩余点，兜底在途请求被取消，总出站冻结 | 受控时钟；链先耗预算剩 R ms，兜底腿在 R 处被断 | A |
| 8 | e 格①：目标 `http://127.0.0.1:port/`（本地服务）、兜底开 → 提取商监听**零**请求、兜底腿本地服务成功、行为与官方一致 | 监听双计数断言 | A |
| 9 | e 格②：同目标、兜底关 → `WEB_BLOCKED_URL` 上抛；本地兜底目标服务零命中 | 同上反转 | A |
| 10 | e 格③：`file:///etc/passwd` 兜底两态都拒（提取商腿 `WEB_BLOCKED_URL`；兜底腿宿主闸同拒——只 http/https），零出站、无正文 | 两态各断言 | A |
| 11 | 链顺序/跳过：两条目一条缺 key 一条失败 → 缺 key 条目零出站跳过（`SKIPPED_NO_KEY`，CFG-002/FB-001），失败条目降级进 c/d 分支；数组序为准 | 顺序探针（监听命中序）+ attempts | A |
| 12 | 兜底成功不得伪造提取商字段：c 格结果的 `url` 等字段来自兜底腿真实观察值，日志区分腿别 | 断言结果 url = 本地目标 url | A |

### FT-007 fetch 条目模型与凭据边界

| # | 可观察预期 | 验证方法 | 档 |
| --- | --- | --- | --- |
| 1 | `fetchEntries` 与搜索 `entries` 分离：fetch 面键名扫描不影响 `entries`；`type` 联合仅 fetch 侧常量含 `tavily-extract`，`TOOL_TYPES` 八类型不变 | `import { TOOL_TYPES } from src/constants.js` 断言集合不扩；fetch 类型常量断言（OQ-O8 命名以实作为准） | A |
| 2 | 保存合成 key：写盘/配置快照无 `SYNTHETIC_KEY("fetch")` 明文；面板列表与回包无明文；`credentialRef` 字段只存引用 | `fetchStub` 保存流 + 写盘快照扫描 + describe 回包扫描 | A |
| 3 | `settings/mutate` 载荷零明文、零 `SECRET_FIELD` 命中键名（CFG-W-003 对 fetch 面字段等效力） | `mutates()` 请求体正则扫描（值 + 键名两面） | A |
| 4 | 重开编辑器不回显：二次 describe 回包与渲染输入 value 为空（write-only） | `fetchStub` 重放 describe + 面板渲染树 value 断言 | A/B |
| 5 | key 归属：两条目不同 key → 提取商监听 `Authorization`（或其鉴权头）= 各自 key；另一条目请求零携带；PAC 下载请求零携带；无跨请求粘头 | 三监听（提取商×2 或路由区分 + PAC）头断言 | A |
| 6 | 写前预检零孤儿（CFG-W-004）：非法 `fetchEntries` 形状 + 待写新 key 保存 → `mutates()`=0、`credentialSets()`=0、`outbound`=0，且 `data-role="save-error"` 可读错误在场 | 面板保存流断言 | A/B |
| 7 | key 解析顺序复用 CFG-002：条目引用 → 目录环境变量（`TAVILY_API_KEY`）→ 托管引用，逐层撤除核对实际送达 key | 逐层装配断言监听头值 | A |
| 8 | 带认证代理 URL 脱敏：条目 proxy 含 `user:pass@` → 错误、日志、诊断零认证参数（CFG-003） | 断连代理注入错误扫描 | A |
| 9 | 条目 `proxy` 经代理捕获/断开不静默直连：直连监听零命中且报代理原因（CFG-001 复用） | 本地代理监听 + 直连监听双计数 | A |

### FT-008 传输、预算与结果映射

| # | 可观察预期 | 验证方法 | 档 |
| --- | --- | --- | --- |
| 1 | 提取商出站复用 `createEntryTransport`：直连/固定代理/PAC 三形态路由可观察（注入 transport 桩时 `init.route` 形态断言，代理条目实际路由断言） | fake-transport 注入 + 本地代理监听 | A |
| 2 | `body.kind` 恒 `"text"`：正常正文、markdown、无正文等全 fixture 断言 kind=text、不自创 kind、不伪造 html | 逐 fixture | A |
| 3 | `url` = 提取商回报最终 URL 且过终闸；不回报最终 URL 时 = 请求 URL | 脚本两种回报形态 | A |
| 4 | `statusCode`：提取商回报页面状态优先；不回报时以提取商自身响应状态映射 | 脚本构造回报字段缺省 | A |
| 5 | 非 2xx 是结果：页面 404 + 可用正文 → resolve 为 `WebFetchResult{statusCode:404, body…}`，不抛异常 | 断言 resolve 非 reject | A |
| 6 | 解码正文 > `100_000` 字符：截断到上限并 `truncated==="true"`；≤ 上限 `truncated==="false"` | 100_001 与 100_000 两侧边界 | A |
| 7 | 提取商响应体 > 2 MiB（`MAX_RESPONSE_BYTES`）：早停（监听侧可观察 reader cancel/断流）、按提取商失败分类（FB-005 异常响应 `ENTRY_BAD_RESPONSE` 口径）、不产出伪造正文；随后进入兜底/降级分支按 FT-006 | 本地监听流式超 2 MiB；断言不返回半截正文 | A |
| 8 | 提取商自身 401 → FB-005「凭据或权限」`ENTRY_CREDENTIALS`；429 → 限流 `ENTRY_RATE_LIMITED`；计入链决策（降级到下一条目/兜底） | 脚本状态码 + attempts 码断言 | A |
| 9 | 无正文场景不产出伪造正文（空 body → 空串正文 + 正确 statusCode，不注入占位文本） | fixture | A |

### FT-009 首期提取商范围与接口预留

| # | 可观察预期 | 验证方法 | 档 |
| --- | --- | --- | --- |
| 1 | v1 仅 `tavily-extract` 一个 fetch 类型常量；其余提取商类型不存在 | 常量集合断言（OQ-O8） | A |
| 2 | 免 key fetch 条目形态被写闸拒绝且原因可读 | 保存流断言 `mutates()`=0 + 错误文案含「需要 key」类可操作原因 | A |
| 3 | 缺 key 的启用条目：FB-001 跳过零出站；全缺 → FB-004 缺 key 终态说明缺失项 | 监听零计数 + 终态码 | A |
| 4 | 端到端替身：成功/失败/超限三态（正文与限额断言并入 FT-008 对应行） | 脚本三态 | A |
| 5 | 扩展点：以替身类型 T2 走「仅新增 fetch 类型常量 + 适配文件 + 文档行」即可被链调度；provider 注册、SSRF 闸、兜底腿、凭据面**测试代码路径零修改**仍通过其用例（diff 审查 + 替身注入） | 替身适配注入 + `git diff` 审查 FT-001–008 相关文件为空 | A/C |
| 6 | `scripts/oracle-style-50.mjs`（含 `CATALOG_TEXT`）零改动且其测试持续通过 | 基线 sha256 钉死 `7f347309aa7b8c57d92c1b5dc44f2823ffa9ef71ab84b43ca2072716698b0d80` 比对（`ft-oracle-mapping.test.js` 静态断言）+ `npm test` | A |
| 7 | 真实付费调用：仅在获批准预算内执行并留脱敏记录；Oracle 编制轮**不执行** | 发布前向用户申请次数（lead 已确认发布前另批）；记录归档脱敏样本 | B |

## 2. 档位分布

- **A 单元自动化**：FT-001(1–6)、FT-002(1–8)、FT-003(1,2,4–6)、FT-004(1–5)、FT-005(1–7)、FT-006(2–12)、FT-007(1–3,5–9)、FT-008(1–9)、FT-009(1–6) —— 全部由 `test/ft-oracle-*.test.js` 骨架承载（当前红）。
- **B 宿主实机**：FT-001#7（真 profile `web/listProviders`、装卸与热重载实机、监听残留）、FT-003#3/#7（存量 profile 三 URL 逐位一致与撤销钉死回归）、FT-004#6（设置页披露目检）、FT-006#1（a 格逐位一致引用）、FT-007#4/#6 的实机面板复核、FT-009#7（真实付费调用——**留发布**，发布前申请预算，本 Oracle 不执行）。
- **C 文档评审**：FT-004#6（README/docs/user 四要素 + PR 同步更新）、FT-005#8（残余风险披露）、FT-009#5 的 diff 审查半边、OQ-O1/O2/O4 的定码回写文档。

## 3. 歧义上报（不擅自裁决）

- **OQ-O1 空 host/语法非法输入的码**：规格 FT-005 第 4 点拒「空 host」，第 3 点统称 `WEB_BLOCKED_URL`；但 WHATWG 实测 `http:///`、`data:`、`javascript:` 等直接 parse 失败或 host 为空，宿主先例对非法 URL 抛 `WEB_INVALID_URL`。矩阵中此类行（S-24、S-34、S-40 等）预期码暂记「拒绝即通过（`WEB_BLOCKED_URL` 或 `WEB_INVALID_URL`）+ 零出站 + 脱敏」，待裁决收窄为单码。
- **OQ-O2 超长 URL 的码**：FT-005 第 3 点把「超长」列入 `WEB_BLOCKED_URL` 类别清单；宿主 `validateFetchUrl` 先例超长抛 `WEB_INVALID_URL`。矩阵行 S-39 以规格文本 `WEB_BLOCKED_URL` 为预期，实宿主有漂移风险，请裁决（规格文 vs 宿主先例）。
- **OQ-O3 提取商接口回报字段形态**：FT-005 要求首期接口至少回报最终 URL、hop 链以可选字段预留；Tavily Extract 实际响应字段（`results[].url`/`response_code` 等）与 hop 链字段命名未实证。骨架以 `final_url` / `redirect_hops` 为**假定字段面**并全部经 OQ-O7 的注入面隔离；真实字段以实施 PR 实证回写，若更名则矩阵脚本改一处常量。
- **OQ-O4 超时终码**：FT-002 验收写「超时类码」。宿主先例 `WEB_FETCH_TIMEOUT`；插件链先例 `CHAIN_BUDGET_EXHAUSTED`/`ENTRY_TIMEOUT`。骨架接受集合 `{WEB_FETCH_TIMEOUT, ENTRY_TIMEOUT, CHAIN_BUDGET_EXHAUSTED}`（+`WEB_ABORTED` 不混入），请定唯一码。
- **OQ-O5 配置非法/链未配置的 fetch 面终码**：FT-002/FT-004 只写「结构化错误」。骨架按 FB-004/FB-006 既有码集合（`CHAIN_NOT_CONFIGURED`/`CHAIN_KEYS_MISSING`/`CONFIG_INVALID`）断言，若 fetch 面新增专用码请回写。
- **OQ-O6 预解析注入面**：FT-005 第 7 点尽力预解析需要 DNS 出站；CI 零真实出网要求 DNS 也必须可桩。骨架假定依赖注入 `fetchDeps.dns.lookup`；实现若走别的注入面（如复用 transport 依赖）请在实现 PR 同步该替身面。
- **OQ-O7 兜底腿构造注入面**：D-FT3 要求复用宿主公开导出 `HttpFetchProvider`。单元观察限额语义需要可注入其 limits（官方 `Config` 全有默认，可注入即合规）。骨架假定依赖注入 `fetchDeps.officialFetchProvider`（缺省由插件用官方默认构造）；「不得自建第二套官方语义」以实机 b/c 格限额行为 + diff 审查兜底。
- **OQ-O8 fetch 类型常量命名/位置**：FT-007/FT-009 要求 fetch 侧常量扩展，但命名（如 `FETCH_TOOL_TYPES`）与所在模块未定。骨架从 `src/constants.js` 取，缺失即红（正常）；实现落地后如更名请仅改 helper 单点。

## 4. 骨架约定

- 全部经 `tryImportSrc` + `failIfUnimplemented`（模块不存在 → 红 + `[oracle]` 诊断，禁止 skip）。
- 提取商/目标/PAC/代理监听一律 `127.0.0.1:0` 本地服务；`fake-fetch` 用 `default:"never"`（未声明出站即抛）；时间只走受控时钟；合成值只用 `SYNTHETIC_KEY`/`.invalid` 域。
- 断言写**预期**：跑红属正常，转绿由实现完成。

## 5. SSRF fixture 矩阵（FT-005 全枚举）

观测面统一：`fetch(url)` → 预期码 + 提取商监听/`fetchFn.calls` 零出站 + 文案脱敏（无 query `?q=SECRETQUERY`、fragment `#SECRETFRAG`、`user:`/`pass:` 明文、完整路径 `/secretpath`；host 只以类别词呈现）。归一化列为 Node `new URL()` 实测。可辨识 query/fragment/path 一律附在各行 URL 上（除超长与 parse-失败行）。

**R1 非 http/https scheme**（大小写与空白变体）

| # | 输入 | 归一化（实测） | 预期 |
| --- | --- | --- | --- |
| S-01 | `file:///etc/passwd` | `file:`，host 空，path=`/etc/passwd` | `WEB_BLOCKED_URL` |
| S-02 | `gopher://127.0.0.1:6379/secretpath` | `gopher:` | `WEB_BLOCKED_URL` |
| S-03 | `data:text/html,x` | `data:` host 空 | 拒绝（OQ-O1 双码） |
| S-04 | `javascript:alert(1)` | `javascript:` host 空 | 拒绝（OQ-O1） |
| S-05 | `FILE://etc/passwd`（大写） | `file:` | `WEB_BLOCKED_URL` |
| S-06 | ` file://etc/passwd`（前导空格，实测仍 parse 为 `file:`） | `file:` | `WEB_BLOCKED_URL` |
| S-07 | `file\t://etc/passwd`（内嵌 tab，WHATWG 剔除后仍 `file:`） | `file:` | `WEB_BLOCKED_URL` |
| S-08 | `https://ok.example/q`（对照：scheme 正例不误拦） | `https:` | 放行（进入后续规则） |

**R2 内嵌凭据**

| # | 输入 | 归一化 | 预期 |
| --- | --- | --- | --- |
| S-09 | `http://user:pass@pub.invalid/secretpath` | host=`pub.invalid` user=`user` | `WEB_BLOCKED_URL`（类别=内嵌凭据） |
| S-10 | `http://user@pub.invalid/secretpath`（仅用户名） | user=`user` | `WEB_BLOCKED_URL` |
| S-11 | `http://user:pass@127.0.0.1/secretpath`（凭据×环回叠加） | host=`127.0.0.1` | `WEB_BLOCKED_URL`，文案只呈现一类不泄凭据 |

**R3 超长**

| # | 输入 | 预期 |
| --- | --- | --- |
| S-12 | `http://pub.invalid/` + `a`×2029（总长 2049，对齐 `WEB_FETCH_MAX_URL_LENGTH`） | `WEB_BLOCKED_URL`（OQ-O2） |
| S-13 | 总长 2048 对照 | 不因长度拒 |

**R4 localhost/空 host**

| # | 输入 | 归一化 | 预期 |
| --- | --- | --- | --- |
| S-14 | `http://localhost/secretpath` | `localhost` | `WEB_BLOCKED_URL` |
| S-15 | `http://localhost./secretpath`（根点 FQDN） | `localhost.` | `WEB_BLOCKED_URL` |
| S-16 | `http://api.localhost/secretpath` | `api.localhost` | `WEB_BLOCKED_URL` |
| S-17 | `https://sub.deep.localhost:8443/secretpath` | 多级 + 端口 | `WEB_BLOCKED_URL` |
| S-18 | `http://LOCALHOST/secretpath`（大小写） | `localhost` | `WEB_BLOCKED_URL` |
| S-19 | `http:///secretpath`（空 host） | parse 失败（实测 ERR_INVALID_URL） | 拒绝（OQ-O1） |

**R5a IPv4 段（每段字面 + 等价绕过 + 归一化后写法）**

| # | 段 | 字面 | 等价绕过（实测归一化） | 预期 |
| --- | --- | --- | --- | --- |
| S-20 | `127.0.0.0/8` | `http://127.0.0.1/` | 十进制 `http://2130706433/`→`127.0.0.1`；十六进制 `http://0x7f000001/`→`127.0.0.1`；分段十六进制 `http://0x7f.0x0.0x0.0x1/`→`127.0.0.1`；八进制 `http://0177.0.0.1/`→`127.0.0.1`；八进制整型 `http://017700000001/`→`127.0.0.1`；缩写 `http://127.1/`→`127.0.0.1`；缩写二级 `http://127.0.1/`→`127.0.0.1`；边界 `http://127.255.255.255/`；根点 `http://127.0.0.1./` | 各 `WEB_BLOCKED_URL` |
| S-21 | `10.0.0.0/8` | `http://10.0.0.1/` | 十进制 `http://167772161/`→`10.0.0.1`；八进制 `http://012.0.0.1/`→`10.0.0.1`；缩写 `http://10/`→`0.0.0.10`（落 `0.0.0.0/8`，仍拒）；边界 `http://10.255.255.255/` | 各 `WEB_BLOCKED_URL` |
| S-22 | `172.16.0.0/12` | `http://172.16.0.1/` | 边界 `http://172.31.255.255/`；十六进制 `http://0xac100001/`→`172.16.0.1`；对照 `http://172.15.0.1/`、`http://172.32.0.1/` 不拦 | 各 `WEB_BLOCKED_URL` |
| S-23 | `192.168.0.0/16` | `http://192.168.1.1/` | 十进制 `http://3232235777/`→`192.168.1.1`；八进制 `http://0300.0250.0.1/`→`192.168.0.1`（0250=168）；缩写 `http://192.168.1/`→`192.168.0.1` | 各 `WEB_BLOCKED_URL` |
| S-24 | `169.254.0.0/16` | `http://169.254.169.254/` | 十进制 `http://2852039166/`→`169.254.169.254`；`http://169.254.1.1/` | 各 `WEB_BLOCKED_URL` |
| S-25 | `0.0.0.0/8` | `http://0.0.0.0/` | 十进制 `http://0/`→`0.0.0.0`；`http://0.255.255.255/` | 各 `WEB_BLOCKED_URL` |
| S-26 | `100.64.0.0/10` | `http://100.64.0.1/` | 边界 `http://100.127.255.255/`；对照 `http://100.128.0.1/` 不拦 | 各 `WEB_BLOCKED_URL` |
| S-27 | `224.0.0.0/4` | `http://224.0.0.1/` | `http://239.255.255.255/`；边界 `http://240.0.0.0/` 保留段同拒 | 各 `WEB_BLOCKED_URL` |
| S-28 | 广播 | `http://255.255.255.255/` | 十进制 `http://4294967295/` | `WEB_BLOCKED_URL` |
| S-29 | 十进制带端口 | `http://2130706433:8080/secretpath` | →`127.0.0.1:8080` | `WEB_BLOCKED_URL` |

**R5b IPv6 段**

| # | 形态 | 输入 | 归一化 | 预期 |
| --- | --- | --- | --- | --- |
| S-30 | 环回压缩 | `http://[::1]/` | `[::1]` | `WEB_BLOCKED_URL` |
| S-31 | 环回全展开 | `http://[0:0:0:0:0:0:0:1]/` | `[::1]` | `WEB_BLOCKED_URL` |
| S-32 | 环回混合压缩 | `http://[0::1]/` | `[::1]` | `WEB_BLOCKED_URL` |
| S-33 | IPv4 映射·点分 | `http://[::ffff:127.0.0.1]/` | `[::ffff:7f00:1]` | `WEB_BLOCKED_URL` |
| S-34 | IPv4 兼容·点分 | `http://[::127.0.0.1]/` | `[::7f00:1]`（**不在** ::1/fe80/fc00 字面段，须按「IPv4 兼容形态」解压判） | `WEB_BLOCKED_URL` |
| S-35 | IPv4 映射·压缩十六进制 | `http://[::ffff:7f00:1]/` | 同 S-33 | `WEB_BLOCKED_URL` |
| S-36 | 未指定 `::` | `http://[::]/` | `[::]` | `WEB_BLOCKED_URL`；`http://[::ffff:0:0]/`（映射 0.0.0.0）同拒 |
| S-37 | `fc00::/7` | `http://[fc00::1]/`、`http://[fd12:3456::1]/`（ULA 两侧） | 原样 | `WEB_BLOCKED_URL` |
| S-38 | `fe80::/10` | `http://[fe80::1]/`、`http://[fe80:1::2]/`、边界 `http://[febf::1]/` | 原样；对照 `http://[fec0::1]/` 不属段（历史站点本地，按规格不列→不拦，标注供裁决） | `WEB_BLOCKED_URL` |
| S-39 | IPv6 私网映射 | `http://[::ffff:192.168.1.1]/`、`http://[::ffff:a]`→映射 `10.0.0.0` | 解压后落私网 | `WEB_BLOCKED_URL` |

**R6 等价绕过（跨段汇总已由 S-20..S-39 覆盖形态维度）+ 域名预解析 R7**

| # | 输入 | 预期 |
| --- | --- | --- |
| S-40 | `evil.test`（注入 DNS 桩 → `127.0.0.1`）+ query/fragment | `WEB_BLOCKED_URL`（类别按命中段=环回）；DNS 查询发生、提取商监听零 |
| S-41 | `multi.test`（桩 → `[::1, 93.184.216.34]` 多 A/AAAA **任一**命中） | `WEB_BLOCKED_URL` |
| S-42 | `fail.test`（桩抛 `ENOTFOUND`） | **放行外发**（未定 ≠ 拒），提取商监听 1 次；提取商失败归类照常 |

**R7 重定向两链 fixture（内容零回传专项）**

| # | 链 | 脚本回报 | 断言 |
| --- | --- | --- | --- |
| R-1 | 公网→私网 | hops=`[http://pub-a.invalid/a, http://192.168.1.1/b]`，final=`192.168.1.1`，且已带回正文含 `LEAK-MARKER-SSRF` | 结果零回传（无任何 `LEAK-MARKER` 子串）、码 `WEB_BLOCKED_URL`（类别私网）、文案脱敏 |
| R-2 | 公网→公网→环回 | hops=`[pub-a.invalid, pub-b.invalid, http://127.0.0.1:PORT/x]`，final=环回，正文同上 | 同上（类别环回） |
| R-3 | 对照全公网 | hops 全 `.invalid`/公网 IP，final 公网 | 完整通过，正文透传、`truncated` 语义正常 |

矩阵规模：S-01…S-42 共 **42 行**（含 3 行对照放行），另 R-1–R-3 重定向 3 链；每拒绝行 × {码, 零出站, 脱敏文案} 三断言 ≈ **120+** 断言点，全由 `test/ft-oracle-ssrf.test.js` 数据驱动执行。

## 6. CI 零真实出网断言

`test/ft-oracle-no-outbound.test.js`（A 档，先于/独立于其余骨架可独立绿）：

1. `fetch-oracle.js` 的本地监听必须绑定 `127.0.0.1` 且 `address().family` 为 IPv4 环回（端口 0 自分配）。
2. 全局守护：`fake-fetch default:"never"` 装具下，声明路由表之外的一切出站直接抛错（既有 helper 语义复用）。
3. 域名纪律：本包全部 oracle 测试文件中出现的 host 只允许 `.invalid`/`.test`/`.example` 保留域、`localhost`、环回字面量、以及注入桩的假 DNS——静态扫描 `test/ft-oracle-*.test.js` 与 `fetch-oracle.js`，正则提取 URL host 后白名单校验，且禁止出现真实提取商端点域名字面（`api.tavily.com` 等）。
4. 兜底腿只打本地：FT-006 全部兜底用例目标 = 本地监听；断言测试进程不产生 `127.0.0.1` 之外 TCP 连接（活动句柄扫描兜底断言；实现若走外部 DNS 属 OQ-O6 注入桩）。
