# 快速开始

本文描述 `main` 当前实现的安装、启用和配置方式。插件把一次搜索按你保存的顺序逐个交给搜索工具，前一个失败或无结果时才降级到下一个。

## 1. 安装

前提：

- 宿主为 DeepSeek Harness（DSH），本包的宿主依赖按 `package.json` 声明为 `0.2.2-rc.5`：`@deepseek-ai/dsh-web-search-deepseek`、`@deepseek-ai/dsh-llm-deepseek`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-launch-environment`。宿主版本与这组依赖的兼容范围尚未发布验证，发布时以实际安装测试为准。
- 包不提交锁文件（`.gitignore` 忽略 `pnpm-lock.yaml`），依赖解析由 DSH 的安装流程完成。

安装方式（二选一）：

- 在 DSH 中打开 **Plugins** > **Add plugin**，选择本包所在的本地目录。
- 由管理员通过插件管理工具安装：`install_bundle`，`target` 填写包目录的绝对路径。

安装只注册搜索 provider `search-chain`，不会改写你现有的搜索或抓取选择。升级已安装的版本，见 [升级指南](upgrade.md)。

## 2. 启用

1. 在插件设置中启用 dsh-search-chain。启用后「设置」页预期出现「网页搜索链」区域（v0.1 待实机确认；只读指示器，见第 3.1 节）。
2. 若要让搜索使用本插件，把 `web.searchProvider` 设为 `search-chain`（依据 `docs/specs/draft/dsh-integration.md` 的 DSH-003；本包代码不修改 `web` 行）。
3. 新开一个会话，发起一次搜索验证。

回退：把 `web.searchProvider` 改回原值即可，已安装的其他搜索插件和配置不受影响。手工编辑 profile 配置前请先备份。

## 3. 配置条目

### 3.1 编辑入口（v0.1 实态）

启用本插件后，DSH 的「设置」页**预期**出现「网页搜索链」区域（v0.1 待实机确认实际呈现），且它只是**只读指示器**：只显示标题和一句指引（"编辑请使用 设置→插件→dsh-search-chain 配置区"）。该区域由插件的 client 产物（`src/client-entry.js`）经宿主模块装载器自注册，不经宿主配置写入面。

**所有条目编辑都在「设置 → 插件 → dsh-search-chain」的配置区进行**（本页所有宿主界面路径措辞以你所用 DSH 当前版式为准），直接编辑下面描述的 JSON 对象（`entries` 数组等）。带列表、开关、拖拽排序和 API key 输入框的「网页搜索链」设置面板是 v0.2 的内容：它的数据层已实现并有测试（`src/client.js`、`src/settings/panel.js`），但 v0.1 的入口没有挂载这个编辑界面。

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
| `credentialRef` | 否 | 凭据引用名（字符串），首尾空白会被去掉。空串视为未设置。见第 4 节。 |
| `proxy` | 否 | 省略或空白表示直连；`"http://..."` 或 `"https://..."` 表示 HTTP(S) 代理 URL；`{ "pac": "http(s)://..." }` 表示 PAC 文件地址（查询参数会原样保留）。其他形状为 `CONFIG_INVALID`（`src/config.js` 的 `normalizeProxy`、`src/transport.js` 的 `classifyProxy`）。**代理与 PAC 在当前版本实际能走到哪一步，见第 7 节。** |
| 其他标量参数 | 否 | 字符串、数字、布尔值按原样保留，供对应适配器读取。对象和数组会被丢弃。 |

键名为 `apiKey`、`api_key`、`key`、`secret`、`token`、`password`、`auth`、`authorization`（大小写不敏感）的字段在读取时被丢弃，**既不会被使用，也不会迁移到凭据服务，也不会从已保存的配置中自动清除**。因此如果旧配置里有这类明文字段，需要在配置区重建时自行删掉这些字段，并按第 4 节另行补 key（见 [升级指南](upgrade.md)）。

配置形状示意（不是 profile 文件的原文）：

```json
{
  "entries": [
    { "id": "tavily-main", "type": "tavily", "name": "Tavily 主用", "enabled": true,
      "credentialRef": "search-chain-credential:tavily-main:<生成值>" },
    { "id": "bing-rss", "type": "bing", "enabled": true },
    { "id": "exa-backup", "type": "exa", "enabled": false }
  ],
  "useOfficialDeepSeekSearch": true,
  "timeoutMs": 25000
}
```

v0.1 没有列表界面，条目是否配置完整请按 `entries` 数组自查（v0.2 面板将用同样的三态展示，见 `src/settings/catalog.js` 的 `entryStatus`）：

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
4. **旧版 YAML 顶层项**（仅 `openai`、`tavily`、`deepseek`）：链侧保留了这一层的代码（`src/search.js` 的 `resolveKey`），但生产装配没有传入旧版 YAML 数据源，**v0.1 不自动导入旧 YAML**。旧 YAML 里的 key 请在配置区手动重建：写入条目引用、环境变量或托管引用。TODO（发布验收）：[Issue #13](https://github.com/AMindFlow/dsh-search-chain/issues/13)（外链以 Issue 当前内容为准）。

纯空白的值视为未提供。宿主凭据服务返回 `undefined` 时同样视为未提供。以上三层都没有 key 的条目会记为 `SKIPPED_NO_KEY` 并跳过，不发出请求。

注意：条目引用的优先级高于环境变量。如果引用指向的是旧 key，即使环境变量是正确的，也不会被使用。解决办法是在配置区把 `credentialRef` 改指向含新 key 的引用（v0.2 面板则直接重新保存该条目的 key）。

### 4.3 v0.1 如何提供 key

v0.1 的编辑面是插件配置区（第 3.1 节），**没有 API key 输入框**。可用方式：

- **进程环境变量**（第 4.2 节第 2 层）：让 DSH 进程环境带有表中对应的变量，例如 `TAVILY_API_KEY`。
- **条目引用 / 托管引用**（第 1、3 层）：在配置区把条目的 `credentialRef` 写成宿主凭据服务中已存在的引用名；或以环境变量名作为引用名在宿主凭据服务中保存 key。本仓库没有提供写凭据的界面，宿主中的具体入口需要实机确认。

带 API key 输入框的面板编辑是 v0.2 的内容。其数据层已冻结的语义（供了解）：输入框只写不读，保存时 key 经宿主凭据服务落为新引用、配置中只保留引用；每次带 key 保存生成新 `credentialRef`，旧引用不删除；移除条目也不会删除宿主凭据服务中的 key，因为同一个 key 可能被其他条目或插件复用。

## 5. DeepSeek 官方分支

当 DSH 会话使用 DeepSeek 官方 API 的路由（`deepseek-official`）且 `useOfficialDeepSeekSearch` 未被设为 `false` 时，搜索交给宿主的 DeepSeek 官方搜索，不经过本插件的条目链。其余情况都走条目链，包括：

- 账号模式会话（`deepseek-account`）；
- `useOfficialDeepSeekSearch` 设为 `false` 的情况。

官方分支会**读取**宿主 `web-search-deepseek` 配置行的活配置（key、`baseURL`、`model` 等，每次搜索现读一次，行内改动从下一次搜索起生效），并把这些值直接交给宿主的官方搜索组件使用；但本插件**不写回宿主配置行，也不写宿主凭据记录**——对该行只读不写。如果该行未挂载或宿主组件无法加载，搜索返回 `WEB_PROVIDER_UNAVAILABLE`，**不会回退到条目链**。这种情况下可在宿主插件设置中启用该行，或把 `useOfficialDeepSeekSearch` 设为 `false` 改用条目链。

v0.2 面板将在开关旁显示如下文案（数据层已定稿）：官方搜索仅对 DeepSeek 官方 API 会话生效、关闭后相关会话改用工具链；官方搜索不另按次收费，模型用量仍按 token 计费。

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
- **设置页的「网页搜索链」区域**：由 client 产物自注册，预期出现、v0.1 待实机确认实际呈现；它是只读指示器，编辑一律走「设置 → 插件 → dsh-search-chain」配置区，面板编辑 UI 是 v0.2（见第 3.1 节）。
- **v0.1 不自动导入旧版 YAML 凭据**（见第 4.2 节；TODO 见 [Issue #13](https://github.com/AMindFlow/dsh-search-chain/issues/13)）。
- **额度判定中的 `QUOTA_LIMITED` 待证认**。它在代码中作为额度证据码出现，但来源是第三方文档，尚未取得实机样本。Gemini 在 429 下按消息含 `quota` 判为额度的做法也是待复核的临时口径。详见 [排错指南](troubleshooting.md)。
- 本页不包含真实供应商的实网验收结果。

## 下一步

- 搜索失败或结果异常：看 [排错指南](troubleshooting.md)。
- 从旧版本升级：看 [升级指南](upgrade.md)。
