# Tavily 搜索适配

本规格定义 Tavily 条目的单查询请求、计费说明、结果映射和状态。尝试顺序见 [FB-001](fallback.md#fb-001-自定义顺序与降级条件)。

## TAV-001 单查询与服务上限

- **要求** Tavily 通道被尝试时，必须向 `https://api.tavily.com/search` 发一次 POST，使用条目的 Tavily key 做 Bearer 鉴权。请求正文必须发送单个原查询，设置 `search_depth: "basic"`、`auto_parameters: false`、`include_answer: false` 和 `include_raw_content: false`。若宿主提供 `maxResults`，`max_results` 取其与 20 中的较小值。若未提供，使用 Tavily 默认值。
- **要求** 用户配置说明须写明 Basic 查询消耗一个 Tavily credit，免费用量按账户套餐。超过套餐用量或账户设置的按量上限时，必须分类为额度失败，按 [FB-001](fallback.md#fb-001-自定义顺序与降级条件)进入下一条。
- **来源** [原始需求 R6及 Tavily 首期支持要求 R11](../../project/requirements.md)。 [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search) · [Tavily 计费与额度](https://help.tavily.com/articles/8298987937-billing-credits-usage-limits)
- **验收** 用本地替身捕获配置了代理及直连的 Tavily 请求，各有一次请求，核对路由、请求体和鉴权。分别以 `maxResults` 为 3、30 和未指定发起查询，实际服务参数分别为 3、20 和省略 `max_results`。

## TAV-002 结果映射与正常空结果

- **要求** 成功响应必须提供 `results` 数组。插件须按数组顺序把有效项的 `url`、可用的 `title` 和 `content` 映射为 `WebSource` 的链接、标题和 `snippet`。空数组必须报告正常无结果。数组缺失或类型错误，或非空数组中没有有效来源时，必须报告响应失败。后续尝试及其他上游错误按[降级规格](fallback.md)处理。
- **来源** [原始需求 R5、R6](../../project/requirements.md)。
- **验收** 分别用正常有序结果、空数组、缺失或类型错误的 `results`、全为无效 URL 的结果样本调用适配器，分别观察有序来源、正常无结果及响应失败。用 401、429、取消及用量超限的 432、433 验证分类，额度超限后尝试下一启用工具。

## 设计决定

- TAV-001、TAV-002 可参考已安装的 `h-k-c/bing-web-search`。复用源码时随分发包保留上游 MIT 许可及版权声明，并记录来源。
