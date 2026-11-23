# DSH 集成

本规格定义插件的设置与搜索入口、安装选择和官方 DeepSeek 路由。

## DSH-001 注册和释放搜索 provider

- **要求** dsh 装载名为 `dsh-search-chain` 的 bundle 时，插件须提供配置行 `id: search-chain`，并注册一个同名 `WebSearchProvider`。卸载须移除设置区域和搜索注册并释放连接资源。重新装载后各只有一个注册项。插件只注册搜索 provider。
- **来源** [原始需求 R1、R7及新版设置要求 R9](../../project/requirements.md)。
- **验收** 在测试 profile 用 `plugin_manager install_bundle` 装载候选包。检查注册表新增一个 `search-chain`，设置出现对应配置区域。卸载及重装后核对两处注册、连接清理和已有抓取 provider。

## DSH-002 可用性和调用边界

- **要求** `available()` 必须同步判断插件是否可接收搜索，且不得发起网络请求。已初始化的插件应允许宿主进入 `search(request, signal)`，在那里按 [DSH-005](#dsh-005-deepseek-官方-api-路由)选路，并报告 [FB-004](fallback.md#fb-004-正常无结果和终态错误)的空配置或其他终态。每次调用处理一个查询，多查询分解由 dsh 工具层执行。
- **来源** [原始需求 R1、R5、R6及新版搜索路由要求 R10](../../project/requirements.md)。
- **验收** 离线调用 `available()`，验证同步返回且无网络流量。随后从 dsh `web_search` 分别触发已配置链、空链和官方分支，核对各自的实际结果或结构化错误。

## DSH-003 显式启用和回退

- **要求** 安装只注册 provider，选用时由用户将 `web.searchProvider` 设为 `search-chain`。启用和回退须保留原 `fetchProvider`、已装的原搜索插件及其他配置，包含 `!!js` 自定义标签的行也须保留。手工修改 profile patch 前须备份。
- **来源** [原始需求 R7](../../project/requirements.md)。
- **验收** 在含 `tavily-bing`、`fetchProvider: http` 和 `!!js` 标签的测试 profile 安装。启用插件后从设置添加条目并发起搜索，再用 `web_fetch` 验证原抓取路径。恢复原搜索选择后进行回归，核对其他行和原插件均保留。

## DSH-004 热重载与发布验收

- **要求** 首期须以候选 bundle 验证真实宿主设置、配置热重载、拖动与停用、官方路由开关、七种搜索工具和回退。实网试验遵守获准的调用预算，记录提交、安装产物、dsh 版本、测试路径和未验证项。
- **来源** [原始需求 R2、R3、R6、R7及新版 R9–R11](../../project/requirements.md)。
- **验收** 用候选包按[设置规格](settings-ui.md)和[首期目录](providers.md)逐项复验。用替身跑完路由矩阵、出站请求次序、停止和错误语义。按批准预算用实际 `web_search` 验证 OpenAI 的固定代理、PAC 和可达条件下的直连，以及各供应商的账号支持与实际用量。Bing 用公开查询验证 RSS，Gemini 按 [GMI-002](gemini.md#gmi-002-宿主展示与发布条件)验收。最后恢复原搜索选择和抓取路径。

## DSH-005 DeepSeek 官方 API 路由

- **要求** 当 [SET-005](settings-ui.md#set-005-deepseek-官方搜索开关)开启且请求的实际模型路由是 dsh 的 DeepSeek 官方 API 时，插件须走宿主对应的服务端搜索路径，沿用官方路由的凭据。关闭开关或当前路由为其他模型时，必须走自定义链。DeepSeek 账号模式、同名自定义模型及第三方兼容端点均走自定义链。
- **要求** 官方分支的结果或错误直接返回。即使官方搜索失败，也须保持此次选择。该分支的请求不消耗自定义条目或其凭据，空自定义链不影响该分支。
- **来源** [用户补充的官方 API 搜索开关 R10](../../project/requirements.md)。 [DeepSeek 服务端搜索计费](https://api-docs.deepseek.com/zh-cn/guides/search/#计费)
- **验收** 用官方 API、DeepSeek 账号、第三方 DeepSeek 兼容路由和普通会话的宿主替身验证开关开、关。只有满足官方路由且开关开启的一组使用宿主官方搜索。在该组注入缺 key 或上游失败，核对工具返回原因，自定义调用数为零。

## 设计决定

- dsh `0.2.2-rc.5` 的 `WebRuntime` 支持 `registerSearchProvider`、`search(request, signal)` 和显式 provider 选择。显式选择后，复用宿主导出的 `DeepSeekSearchProvider` 和官方凭据/路由配置；不要从插件再调用会选回自身的 `ctx.web.search`。
- 使用 bundle 的 `dsh.bundle.patch` 注册插件。手工修改 `web` 行时按宿主整行替换语义重述原 `fetchProvider`。WP0 实证设置扩展点和实际官方端点的识别方式，发布支持版本以安装验收为准。
