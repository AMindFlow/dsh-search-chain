# 快速开始

本文描述 `main` 当前实现的安装、启用和配置方式。插件把一次搜索按你保存的顺序逐个交给搜索工具，前一个失败或无结果时才降级到下一个。

## 1. 安装

前提：

- 宿主为 DeepSeek Harness（DSH），版本须在 `package.json` 的 `engines.dsh` 范围内（`>=0.2.2-rc.5 <0.3.0-0`，宿主依赖 `0.2.2-rc.5` 组）。该兼容范围已在 0.2.2-rc.5 上实装验证（见 `docs/project/releases/v0.1.0.md`）。
- 包不提交锁文件（`.gitignore` 忽略 `pnpm-lock.yaml`），依赖解析由 DSH 的安装流程完成。

安装方式（选一）：

- **从 GitHub 安装（发布渠道）**：按根目录 [INSTALL.md](../../INSTALL.md) 用发布 tag 解引用后的 40 位完整 commit 安装（`git+https://github.com/AMindFlow/dsh-fleetseek.git#<SHA>`），支持后续「更新」能力。
- **从 npm 安装**：`dsh plugin --profile <profile> add dsh-fleetseek`（或在宿主插件页输入包名 `dsh-fleetseek`）。
- **从 Discover 索引源安装**：在插件市场添加自建索引源 `https://raw.githubusercontent.com/AMindFlow/dsh-plugin-index/main/market-index.json`，选择「FleetSeek 网页搜索链」。

> **身份说明**：三个渠道现在是同一个包名 `dsh-fleetseek`，宿主识别为同一个插件，不会重复出现两张卡片。历史遗留的 `@amindflow/dsh-search-chain`（0.1.4 及以前）与旧 Git 渠道身份 `dsh-search-chain` 是另一个 bundle：从 0.1.x 升级请按 [upgrade.md](upgrade.md) 的迁移小节先卸载旧身份。旧 npm 包已 deprecate 并固定不再更新。

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
4. **旧版 YAML 顶层项**（仅 `openai`、`tavily`、`deepseek`）：链侧保留了这一层的代码（`src/search.js` 的 `resolveKey`），但生产装配没有传入旧版 YAML 数据源，**v0.1 不自动导入旧 YAML**。旧 YAML 里的 key 请在配置表单手动重建：写入条目引用、环境变量或托管引用。TODO（发布验收）：[Issue #13](https://github.com/AMindFlow/dsh-fleetseek/issues/13)（外链以 Issue 当前内容为准）。

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
- **v0.1 不自动导入旧版 YAML 凭据**（见第 4.2 节；TODO 见 [Issue #13](https://github.com/AMindFlow/dsh-fleetseek/issues/13)）。
- **额度判定中的 `QUOTA_LIMITED` 待证认**。它在代码中作为额度证据码出现，但来源是第三方文档，尚未取得实机样本。Gemini 在 429 下按消息含 `quota` 判为额度的做法也是待复核的临时口径。详见 [排错指南](troubleshooting.md)。
- 本页不包含真实供应商的实网验收结果。

## 下一步

- 搜索失败或结果异常：看 [排错指南](troubleshooting.md)。
- 从旧版本升级：看 [升级指南](upgrade.md)。
