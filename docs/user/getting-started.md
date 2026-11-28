# 快速开始

本文描述 `main` 当前实现的安装、启用和配置方式。插件把一次搜索按你保存的顺序逐个交给搜索工具，前一个失败或无结果时才降级到下一个。

## 1. 安装

前提：

- 宿主为 DeepSeek Harness（DSH），版本须在 `package.json` 的 `engines.dsh` 范围内（`>=0.2.2-rc.5 <0.3.0-0`，宿主依赖 `0.2.2-rc.5` 组）。该兼容范围已在 0.2.2-rc.5 上实装验证（见 `docs/project/releases/v0.1.0.md`）。
- 包不提交锁文件（`.gitignore` 忽略 `pnpm-lock.yaml`），依赖解析由 DSH 的安装流程完成。

安装方式（选一）：

- **从 GitHub 安装（发布渠道）**：按根目录 [INSTALL.md](../../INSTALL.md) 用发布 tag 解引用后的 40 位完整 commit 安装（`git+https://github.com/AMindFlow/dsh-search-chain.git#<SHA>`），支持后续「更新」能力。
- **从 npm 安装**：包名 `@amindflow/dsh-search-chain`（`dsh plugin add @amindflow/dsh-search-chain` 或在宿主插件页输入该包名）。
- **从 Discover 索引源安装**：在插件市场添加自建索引源 `https://raw.githubusercontent.com/AMindFlow/dsh-plugin-index/main/market-index.json`，选择「网页搜索链」。
- 在 DSH 中打开 **Plugins** > **Add plugin**，选择本包所在的本地目录（开发自用）。
- 由管理员通过插件管理工具安装：`install_bundle`，`target` 填写包目录的绝对路径。

> **一个 profile 只装一个渠道。** DSH 以 npm 包名识别插件：Git 渠道的包名是 `dsh-search-chain`，npm 包是 `@amindflow/dsh-search-chain`——两者内容同源，但对宿主是两个不同的 bundle 身份。同一 profile 同时安装会出现两张卡片并争用同一配置行，请只保留其一；更换渠道时先卸载另一个。

安装只注册搜索 provider `search-chain`，不会改写你现有的搜索或抓取选择。升级已安装的版本，见 [升级指南](upgrade.md)。

## 2. 启用

1. 在插件设置中启用 dsh-search-chain。启用后「设置」页出现「网页搜索链」设置面板（其在目标 DSH 版本中的具体外观仍需实机确认，见第 3.1 节）。
2. 若要让搜索使用本插件，把 `web.searchProvider` 设为 `search-chain`（依据 `docs/specs/draft/dsh-integration.md` 的 DSH-003；本包代码不修改 `web` 行）。
3. 新开一个会话，发起一次搜索验证。

回退：把 `web.searchProvider` 改回原值即可，已安装的其他搜索插件和配置不受影响。手工编辑 profile 配置前请先备份。

## 3. 配置条目

### 3.1 设置面板

启用本插件后，DSH「设置」页的「网页搜索链」区域提供配置面板：可新增、编辑、停用、移除和排序工具条目，并配置 DeepSeek 官方搜索开关。设置页负责编辑和显示本地配置状态；打开、修改、排序和保存都不会向搜索供应商发请求。**保存即校验**：保存成功的配置必能通过启动读取（写入前运行与启动读取等价的校验，发现重复 `id`、非法字段或越界 `null` 会直接报错拦截并保留草稿）。保存前先写入新 key 的宿主凭据引用（仅当写闸校验通过后才写入），成功后再提交配置；失败时草稿保留且已生效配置不变。凭据只写不读，输入框不会回显旧 key。

「网页搜索链」面板是唯一配置入口（详情页不再重复提供表单），读写走 `search-chain` 设置命名空间。面板通过宿主同源 settings/credentials Remote API 保存，并携带配置 revision 防止覆盖并发修改。当前安装未能连接真实 GUI 时，本轮未完成隔离 profile 的实机 DOM 验收；具体 DSH 版本的外观和宿主 Remote 回包形状仍以本地验证结果为准。

### 3.2 配置形状

插件的配置对象由三个顶层键组成：

| 顶层键 | 类型 | 缺省 | 含义 |
| --- | --- | --- | --- |
| `entries` | 数组 | `[]` | 有序的搜索条目。列表顺序即执行顺序。 |
| `useOfficialDeepSeekSearch` | 布尔 | `true` | DeepSeek 官方分支开关，见第 5 节。 |
| `timeoutMs` | 正整数（毫秒） | `25000` | 一次搜索的总预算，见第 6 节。 |

每个条目的字段：

| 字段 | 必填 | 含义与校验 |
| --- | --- | --- |
| `id` | 是 | 非空字符串，首尾空白会被去掉。同一列表内不得重复，否则整次搜索以 `CONFIG_INVALID` 失败。 |
| `type` | 是 | 取值为 `openai`、`tavily`、`exa`、`brave`、`bing`、`gemini`、`deepseek-search`、`deepseek-agentic-search` 之一。其中两个 DeepSeek 类型对应 DeepSeek 的两种模式，共用同一个 key。 |
| `name` | 否 | 显示名，字符串。缺省时等于 `type`。 |
| `enabled` | 否 | 布尔。缺省 `true`。为 `false` 时该条目不解析凭据、不出站，但保留在列表中的位置。 |
| `credentialRef` | 否 | 凭据引用名（字符串），首尾空白会被去掉。非空值必须符合 POSIX 标识符语法 `^[A-Za-z_][A-Za-z0-9_]*$`；空串视为未设置，旧冒号形式视为无效引用并继续查找后续凭据来源。见第 4 节。 |
| `proxy` | 否 | 省略或空白表示直连；`"http://..."` 或 `"https://..."` 表示 HTTP(S) 代理 URL；`{ "pac": "http(s)://..." }` 表示 PAC 文件地址（查询参数会原样保留）。其他形状为 `CONFIG_INVALID`（`src/config.js` 的 `normalizeProxy`、`src/transport.js` 的 `classifyProxy`）。**代理与 PAC 在当前版本实际能走到哪一步，见第 7 节。** |
| 其他标量参数 | 否 | 字符串、数字、布尔值按原样保留，供对应适配器读取。对象和数组会被丢弃。 |

键名为 `apiKey`、`api_key`、`key`、`secret`、`token`、`password`、`auth`、`authorization`（大小写不敏感）的字段在读取时被丢弃，**既不会被使用，也不会迁移到凭据服务**；若历史或手改配置中仍残留这些字段，**通过设置面板完成任意一次保存后会自动从持久条目中清除**，仍需按第 4 节另行提供 key（见 [升级指南](upgrade.md)）。

配置形状示意（不是 profile 文件的原文）：

```json
{
  "entries": [
    { "id": "tavily-main", "type": "tavily", "name": "Tavily 主用", "enabled": true,
      "credentialRef": "SEARCH_CHAIN_CREDENTIAL_tavily_main_<唯一后缀>" },
    { "id": "bing-rss", "type": "bing", "enabled": true },
    { "id": "exa-backup", "type": "exa", "enabled": false }
  ],
  "useOfficialDeepSeekSearch": true,
  "timeoutMs": 25000
}
```

面板用三态区分条目状态（见 `src/settings/catalog.js` 的 `entryStatus`）：

- **已关闭**：`enabled` 为 `false`。
- **缺凭据引用**：启用的条目需要 key，但没有 `credentialRef`。Bing RSS 免 key，不算缺。
- **就绪**：启用且配置完整。Key 是否有效要在一次真实搜索中验证；这三态都只反映本地配置，不验证 key 有效性。

## 4. 凭据

### 4.1 每个类型使用的环境变量名

| 类型 | 环境变量名 |
| --- | --- |
| `openai` | `OPENAI_API_KEY` |
| `tavily` | `TAVILY_API_KEY` |
| `exa` | `EXA_API_KEY` |
| `brave` | `BRAVE_API_KEY` |
| `gemini` | `GEMINI_API_KEY` |
| `deepseek-search`、`deepseek-agentic-search` | `DEEPSEEK_API_KEY` |
| `bing` | 无（免 key） |

### 4.2 四种来源与优先级

请求期对每个**实际准备尝试**的启用条目，按下列顺序解析 key，命中即停止（实现：`src/search.js` 的 `resolveKey`）：

1. **条目引用**：条目的 `credentialRef`，通过宿主凭据服务 `resolve(ref)` 读取，取返回对象的 `value`。
2. **进程环境变量**：上表中对应的环境变量。
3. **DSH 托管引用**：以该环境变量名作为引用名，执行宿主凭据服务的 `resolve(环境变量名)`。
4. **旧版 YAML 顶层项**（仅 `openai`、`tavily`、`deepseek`）：链侧保留了这一层的代码（`src/search.js` 的 `resolveKey`），但生产装配没有传入旧版 YAML 数据源，**v0.1 不自动导入旧 YAML**。旧 YAML 里的 key 请在配置表单手动重建：写入条目引用、环境变量或托管引用。TODO（发布验收）：[Issue #13](https://github.com/AMindFlow/dsh-search-chain/issues/13)（外链以 Issue 当前内容为准）。

纯空白的值视为未提供。宿主凭据服务返回 `undefined` 时同样视为未提供。以上三层都没有 key 的条目会记为 `SKIPPED_NO_KEY` 并跳过，不发出请求。

注意：条目引用的优先级高于环境变量。如果合法引用指向的是旧 key，即使环境变量是正确的，也不会被使用。解决办法是在设置面板重新保存该条目的 key 生成新引用，或改填其他合法引用。

### 4.3 面板中提供 key

在条目编辑器中输入新 key 并保存。面板将明文只发送到同源 `/api/credentials/set` 请求，使用生成的 `SEARCH_CHAIN_CREDENTIAL_<条目 ID>_<唯一后缀>` 引用；只有 credentials/set 成功后才提交带 `credentialRef` 的配置。`credentialRef` 必须符合 `^[A-Za-z_][A-Za-z0-9_]*$`，旧式含冒号引用无效。留空 key 表示保留当前引用，不会清空凭据。

凭据引用是写入时新建的，替换 key 不会删除旧引用；移除条目也不会删除宿主凭据，因为同一凭据可能被其他条目或插件复用。若不在面板输入 key，也可继续使用环境变量或已有合法托管引用（见第 4.2 节）。

## 5. DeepSeek 官方分支

当 DSH 会话使用 DeepSeek 官方 API 的路由（`deepseek-official`）且 `useOfficialDeepSeekSearch` 未被设为 `false` 时，搜索交给宿主的 DeepSeek 官方搜索，不经过本插件的条目链。其余情况都走条目链，包括：

- 账号模式会话（`deepseek-account`）；
- `useOfficialDeepSeekSearch` 设为 `false` 的情况。

官方分支会**读取**宿主 `web-search-deepseek` 配置行的活配置（key、`baseURL`、`model` 等，每次搜索现读一次，行内改动从下一次搜索起生效），并把这些值直接交给宿主的官方搜索组件使用；但本插件**不写回宿主配置行，也不写宿主凭据记录**——对该行只读不写。如果该行未挂载或宿主组件无法加载，搜索返回 `WEB_PROVIDER_UNAVAILABLE`，**不会回退到条目链**。这种情况下可在宿主插件设置中启用该行，或把 `useOfficialDeepSeekSearch` 设为 `false` 改用条目链。

面板开关旁说明：官方搜索仅对 DeepSeek 官方 API 会话生效；关闭后相关会话改用工具链；官方搜索不另按次收费，模型用量仍按 token 计费。

## 6. 搜索如何降级，以及 `timeoutMs`

- 只尝试启用的条目，按列表顺序逐个执行，串行、每个条目最多提交一次。
- 第一个返回有效来源的条目结束搜索。返回空结果（明确没有结果）时继续下一个条目。
- 条目失败、超时或缺 key 时记录原因并继续下一个条目。
- 如果前面有条目被跳过或失败，成功结果的 `content` 第一行会写明实际使用的条目，例如 `已由「Exa」返回结果（此前「Tavily」…）`。Bing RSS 只返回来源，不返回供应商生成的正文。

**总预算**：`timeoutMs` 是一次搜索的总预算。每个条目的预算等于"剩余总预算 ÷ 当前及之后启用条目的数量"（向下取整）。因此启用的条目越多，每个条目可用时间越短。需要更多时间时，提高 `timeoutMs`，或减少启用条目、把常用条目排在前面。

**maxResults**：来自 DSH 的请求参数。

- 请求给出整数 `maxResults` 时，来源超过该数量会被截断，结果的 `truncated` 为 `true`。小于 1 的值按 1 处理。
- 请求未给出 `maxResults`（或不是整数）时**不截断**，返回全部有效来源，`truncated` 为 `false`。

## 7. 已知限制（当前版本）

以下每条都对照 `main` 提交 `05c97ac` 的实现核对过：

- **代理配置可填、PAC 链路真实执行，但"经代理出站"本身在 v0.1 不可用**。拆开说：
  - 配置与解析全部生效：`proxy` 三形态校验（`src/config.js` 的 `normalizeProxy`）、代理分类（`src/transport.js` 的 `classifyProxy`，`http:`/`https:` 为固定代理）已合并。
  - PAC 会真实执行：首次出站前以**直连** GET 下载 PAC（查询参数原样保留，响应上限 2 MiB），在隔离 `vm` 中求值 `FindProxyForURL`，按顺序选第一个受支持指令（`DIRECT`、`PROXY host:port`、`HTTPS host:port`；`SOCKS` 等被跳过）。注意助手子集：vm 只注入 `isPlainHostName`、`dnsDomainIs`、`shExpMatch` 三个助手（`src/transport.js` 的 `evaluatePac`），脚本只能使用它们和标准 `url`/`host` 参数；引用 `isInNet`、`dnsResolve` 等其他常见助手会因未定义而求值失败，记 `PAC_EVAL_FAILED`。失败按条目级降级，原码进 `attempts`（`PAC_FETCH_FAILED` / `PAC_EVAL_FAILED` / `PAC_ROUTE_FAILED`）。
  - 但生产装配（`src/index.js` 的 `productionFetch`）零依赖、未接代理分发器：**凡最终需要经代理出站的路由（固定代理 URL，或 PAC 命中 `PROXY`/`HTTPS` 指令）都显式失败、零出站、绝不静默改走直连**；条目记 `ENTRY_PROXY` 并降级到下一条目。只有直连条目、以及 PAC 返回 `DIRECT` 的请求能正常出站。
  - 本节结论有本地 headless 复测支撑（只连回环地址，无真实供应商）：fixture [evidence/proxy-retest-v0.1.mjs](evidence/proxy-retest-v0.1.mjs)，输出 [evidence/proxy-retest-v0.1.log](evidence/proxy-retest-v0.1.log)。复测与上述描述一致，未发现额外缺陷；代理分发器接入前的版本，代理条目请停用或改直连。
- **响应体上限 2 MiB**（`src/constants.js` 的 `MAX_RESPONSE_BYTES`，PAC 与七家供应商正文共用；bing 适配器的 `MAX_BODY_BYTES` 是该常量的别名，同值）：超限立即停止读取。供应商 2xx 正文超限按异常响应记 `ENTRY_BAD_RESPONSE`（原因含尺寸线索），PAC 超限记 `PAC_FETCH_FAILED`。
- **设置页的「网页搜索链」区域**：由 client 产物自注册完整设置面板；操作只读/写入本插件配置和宿主凭据 Remote，不发起供应商请求。目标 DSH 版本的面板外观和 Remote 回包仍待隔离 profile 实机确认（见第 3.1 节）。
- **v0.1 不自动导入旧版 YAML 凭据**（见第 4.2 节；TODO 见 [Issue #13](https://github.com/AMindFlow/dsh-search-chain/issues/13)）。
- **额度判定中的 `QUOTA_LIMITED` 待证认**。它在代码中作为额度证据码出现，但来源是第三方文档，尚未取得实机样本。Gemini 在 429 下按消息含 `quota` 判为额度的做法也是待复核的临时口径。详见 [排错指南](troubleshooting.md)。
- 本页不包含真实供应商的实网验收结果。

## 下一步

- 搜索失败或结果异常：看 [排错指南](troubleshooting.md)。
- 从旧版本升级：看 [升级指南](upgrade.md)。
