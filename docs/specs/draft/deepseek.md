# DeepSeek 官方搜索适配

本规格定义自定义链中 DeepSeek 条目的两种模式。添加时默认选独立 Search API，也可改选 Agentic Search。两者按条目读取凭据。宿主官方 API 分支由 [DSH-005](dsh-integration.md#dsh-005-deepseek-官方-api-路由)单独定义。

## DSK-001 Agentic Search 请求与用量

- **要求** DeepSeek Agentic Search 条目被尝试时，必须向 `https://api.deepseek.com/anthropic/v1/messages` 发一次 POST，只提交当前查询。使用 `deepseek-flash`，关闭思考，设置 `max_tokens: 256`，只声明 `web_search_20250305`，工具名为 `web_search`，`max_uses: 1`。用固定指令要求模型执行本次查询。请求受 [FB-003](fallback.md#fb-003-预算与取消)约束。
- **要求** 用户配置说明须注明模型触发的服务端搜索工具不另收搜索次数费用，模型输入和输出仍按 token 计费，进入上下文的搜索结果计入模型用量。该通道的搜索调用只能经模型的服务端工具执行。
- **来源** [用户补充的 DeepSeek Agentic Search 要求，扩展 R6](../../project/requirements.md)。 [DeepSeek Messages API](https://api-docs.deepseek.com/zh-cn/api/create-message/) · [模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- **验收** 将 Agentic Search 条目置于首位，替身必须只捕获一次官方 Messages 请求，并核对鉴权、模型、工具及预算参数。按批准次数实机验证，记录模型 token 用量与实际搜索工具计数，确认有效来源来自服务端搜索。

## DSK-002 Agentic Search 结果与错误

- **要求** 从 `web_search_tool_result` 实际搜索结果块中提取 `web_search_result` 的 `url`、`title` 和可用的 `snippet`，并按首见顺序对相同的 URL 字符串去重。返回有效性、上限和降级提示遵循 [FB-002](fallback.md#fb-002-成功结果与提示)。生成的回答和裸链接不得构造成来源。
- **要求** 有搜索结果块明确返回空数组且没有工具错误时，报告正常无结果。只有模型回答而未触发工具、结果结构无效或工具返回错误时，报告该通道的失败。认证、额度、限流、内容拒绝和取消按[降级规格](fallback.md)处理。HTTP 200 中的 `web_search_tool_result_error` 也须识别，其中 `too_many_requests` 分类为限流。
- **来源** [用户补充的 DeepSeek Agentic Search 要求与原始需求 R5、R6](../../project/requirements.md)。 [DeepSeek 服务端搜索结果与用量](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api/#服务端工具用量)
- **验收** 用含结果块、重复 URL、无效 URL 和模型正文的样本核对来源及顺序。分别用显式空数组、无工具结果块、畸形结果块和工具错误样本，核对正常空结果和失败有不同状态，并按 [FB-001](fallback.md#fb-001-自定义顺序与降级条件)进入后继条目。分别模拟模型拒绝和宿主取消，确认终态按降级规格返回。

## DSK-003 Search API 请求与用量

- **要求** DeepSeek Search 条目被尝试时，必须使用 Bearer key 向 `https://api.deepseek.com/v1/tools/search` 发一次 POST，只发送原查询，并设置 `need_content: false`。宿主提供 `maxResults` 时，`count` 取其与 50 中较小值。未提供时采用服务默认值。若查询超过接口的 128 个 Unicode 字符上限，报告该条目的长度限制，下一条收到完整原查询。
- **要求** 用户配置说明须注明独立 Search API 对有结果的成功请求按次计费。该通道的查询只能调用上述独立搜索接口。
- **来源** [用户补充的 DeepSeek Search API 要求，扩展 R6](../../project/requirements.md)。 [DeepSeek Search 请求与计费](https://api-docs.deepseek.com/zh-cn/guides/search/)
- **验收** 将 Search 条目置于首位，替身捕获一次独立 Search 请求，核对 Bearer key、原查询和 `need_content`。分别测试 `maxResults` 为 3、60 及未指定，核对 `count` 为 3、50 或省略。用 129 个 Unicode 字符的合法宿主查询验证独立接口无请求，后一条收到完整查询。按批准次数复核账户用量。

## DSK-004 Search API 结果与错误

- **要求** 独立 Search API 成功响应必须含 `results` 数组。插件须按数组顺序把有效项的 `url`、`title`、`snippet`、`summary` 和 `date` 映射为 `WebSource` 的相应字段，其中 `date` 对应 `publishedAt`。空数组报告正常无结果。数组缺失、类型错误或非空数组没有有效 URL 时，报告响应失败。输出上限和错误分别按 [FB-002](fallback.md#fb-002-成功结果与提示)和 [FB-005](fallback.md#fb-005-失败分类与排查提示)处理。
- **来源** [用户补充的 DeepSeek Search API 要求与原始需求 R5、R6](../../project/requirements.md)。 [DeepSeek Search 响应](https://api-docs.deepseek.com/zh-cn/guides/search/#响应)
- **验收** 用有序结果、空数组、畸形数据、全部无效 URL 及 `401`、`402`、`429` 的样本验明来源和分类。有效来源结束查询，空结果及可降级错误进入后继条目。

## 设计决定

- 模型驱动的请求参考 dsh `0.2.2-rc.5` 的 Messages 服务端搜索，独立 Search API 参考 `deepseek-search-api`。自定义条目复用本插件的逐条网络与凭据合同。宿主 [官方分支](dsh-integration.md#dsh-005-deepseek-官方-api-路由)另行委派。
