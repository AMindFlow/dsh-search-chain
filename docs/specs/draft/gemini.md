# Gemini Google Search grounding

## GMI-001 搜索请求与证据

- **要求** Gemini 条目使用支持 Google Search grounding 的 Gemini 模型。向 `https://generativelanguage.googleapis.com/v1beta/interactions` 发一次单查询 POST，使用 `x-goog-api-key`，启用 `google_search`，设置 `store: false`。保留本次返回的 Grounded Result、引用与关联 Search Suggestions 供 [GMI-002](#gmi-002-宿主展示与发布条件)处理。
- **要求** 只有实际完成服务端搜索且具有可展示的 grounded 结果，才算搜索成功。缺少该证据或收到上游错误时按[降级规格](fallback.md)处理。配置说明须标明模型与搜索产品的计费受所选模型和账户影响。
- **来源** [用户补充的 Gemini 要求 R11](../../project/requirements.md)。 [Google Search grounding](https://aistudio.google.com/docs/google-search) · [Interactions API](https://aistudio.google.com/docs/interactions-overview)
- **验收** 用替身核对鉴权、单查询、模型、`store: false` 和服务端工具形态。用有引用与建议、仅模型文本及上游失败样本验证结果或降级。

## GMI-002 宿主展示与发布条件

- **要求** Gemini 的发布路径须按 Google 对 Grounding with Google Search 的要求，将完整结果和关联搜索建议一起展示给该次查询的用户，保持引用可点击。由宿主客户端受支持的方式展示，避免把上游 HTML 放入模型文本或普通来源摘要。验明宿主的传递、呈现和留存符合接口使用条件后，才能将该适配器标为可用。
- **来源** [用户补充的 Gemini 首期要求 R11](../../project/requirements.md)。 [Google Grounding 使用限制](https://aistudio.google.com/docs/terms#grounding-with-google-search)
- **验收** 在测试 profile 运行真实 `web_search` 的展示原型，核对当前用户能同时看到完整反馈、引用和建议，并检查宿主记录及模型输出边界。通过后再用获准的账号和调用预算验证实际结果。

## 设计决定

- dsh `0.2.2-rc.5` 默认搜索结果只投影 `sources`、`content` 和 `truncated`。先验证有无支持单独呈现的插件接口；仅把 Gemini 引用抽出到普通来源列表不足以作为本条发布验收。
