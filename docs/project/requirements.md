# 需求映射

R1–R8 沿用《DSH 插件需求与方案：dsh-web-search-openai》的编号。新版采用 DSH 设置面板中的有序工具列表。用户提供的模型设置截图用于布局参考。R9–R11 记录新增设置交互、官方 DeepSeek 开关和首期工具范围。

| 编号 | 首期范围 | 规格与验收入口 |
| --- | --- | --- |
| R1 | 注册单个 `search-chain` provider，给出本地可用性 | [DSH-001、DSH-002](../specs/draft/dsh-integration.md#dsh-001-注册和释放搜索-provider) |
| R2 | OpenAI 模型配置、Responses API 网页搜索和引用 | [OpenAI](../specs/draft/openai.md) |
| R3 | 每个条目的直连、固定代理、PAC、超时与取消 | [配置与网络](../specs/draft/config-network.md)、[FB-003](../specs/draft/fallback.md#fb-003-预算与取消) |
| R4 | 用户填写 key、宿主管理凭据、兼容原有凭据来源 | [CFG-002、CFG-003](../specs/draft/config-network.md#cfg-002-密钥来源和优先级) |
| R5 | 可定位错误、脱敏与空结果判定 | [FB-004、FB-005](../specs/draft/fallback.md#fb-004-正常无结果和终态错误) |
| R6 | 按用户保存的启用条目顺序降级 | [FB-001](../specs/draft/fallback.md#fb-001-自定义顺序与降级条件) |
| R7 | 安装、显式启用、配置生效和回退 | [DSH-003、DSH-004](../specs/draft/dsh-integration.md#dsh-003-显式启用和回退) |
| R8 | 后续评估用量提示与可验证阈值 | 排期时补用量规格 |
| R9 | 设置卡片、添加、编辑、启停和拖动排序 | [设置 UI](../specs/draft/settings-ui.md) |
| R10 | 在 DeepSeek 官方 API 会话中选择宿主官方搜索或自定义链 | [SET-005](../specs/draft/settings-ui.md#set-005-deepseek-官方搜索开关)、[DSH-005](../specs/draft/dsh-integration.md#dsh-005-deepseek-官方-api-路由) |
| R11 | OpenAI、Tavily、Exa、Brave、Bing RSS、Gemini、DeepSeek 七种工具 | [首期目录](../specs/draft/providers.md#cat-001-首期类型) |

原文 §2 记录已有 PAC，§5 提到自动解析，R3 将其纳入条目配置。首期按单查询做编排，dsh 负责多查询和 `web_fetch`。
