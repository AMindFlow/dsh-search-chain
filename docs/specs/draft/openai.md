# OpenAI 搜索适配

本规格定义 OpenAI Responses API 的搜索请求以及引用如何成为 dsh 来源。

## OAI-001 查询与模型

- **要求** OpenAI 通道被尝试时，必须向 `https://api.openai.com/v1/responses` 发出一次 `POST`。请求中与任务有关的内容仅为当前查询和固定搜索指令，要求用查询的语言列出本次搜索的引用及摘要。省略 `model` 时使用 `gpt-5.6-luna`。显式设置的 `model` 必须为非空白字符串，无效时须在发出 OpenAI 请求前报告该通道的配置错误。
- **要求** 请求必须只声明 `web_search` 工具，设置 `tool_choice: "required"`、`max_tool_calls: 1` 和 `store: false`。传输与鉴权使用[配置规格](config-network.md)，取消按 [FB-003](fallback.md#fb-003-预算与取消)处理。
- **来源** [原始需求 R2](../../project/requirements.md)。 [OpenAI Web search](https://developers.openai.com/api/docs/guides/tools-web-search) · [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create) · [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- **验收** 拦截默认模型和自定义模型的请求。两个查询分别只有一次 `POST`，参数与要求一致，任务文本只有测试查询和固定指令。将 `model` 配为空字符串，核对 OpenAI 请求为零且该通道配置错误可被识别。实际账号的权限、来源数和计费按 [DSH-004](dsh-integration.md#dsh-004-热重载与发布验收)核对。

## OAI-002 引用提取与顺序

- **要求** OpenAI 返回完成的响应时，插件必须按 `output`、消息的 `content` 和注释在各数组中的顺序，从 `output_text` 的 `url_citation` 提取来源。每条来源采用注释的 `url` 和可用的 `title`。同一文本块的首个非空段落用作 `snippet`，若无该文本则省略 `snippet`。
- **要求** 来源须满足 [FB-002](fallback.md#fb-002-成功结果与提示)的有效性、上限和 `content` 约束。同一 URL 字符串只保留第一次出现的来源。缺少引用的模型正文不得构造为来源。
- **来源** [原始需求 R2](../../project/requirements.md)。 [OpenAI 引用响应](https://developers.openai.com/api/docs/guides/tools-web-search#output-and-citations)
- **验收** 提供混有工具项、多个消息、重复 URL、非 HTTP(S) URL 和正文裸链接的响应。核对只保留有效引用且首次出现的标题和首段随对应来源返回，设置较小的 `maxResults` 后结果仍保序，模型整段回答没有出现在 `content` 中。

## OAI-003 无引用与响应失败

- **要求** 响应未完成、JSON 或响应结构无法解析，或完成响应中没有有效引用时，OpenAI 通道必须报告响应失败，按 [FB-001](fallback.md#fb-001-自定义顺序与降级条件)推进。上游明确返回拒绝时，插件必须报告拒绝终态。带 HTTP 错误的响应按 [FB-005](fallback.md#fb-005-失败分类与排查提示)分类。
- **来源** [原始需求 R2、R5、R6](../../project/requirements.md)。
- **验收** 分别输入只有模型正文、畸形 JSON、未完成状态和显式拒绝的响应。前三种进入后继启用条目，显式拒绝时后继条目无请求。后续尝试均未得到来源时，无引用应出现在 [FB-004](fallback.md#fb-004-正常无结果和终态错误)的错误详情中。
