# Exa Search API

## EXA-001 请求与来源

- **要求** Exa 条目被尝试时须向 `https://api.exa.ai/search` 发一次 POST，使用 `x-api-key` 鉴权。请求发送当前查询，采用 `type: "auto"` 和 highlights。宿主提供结果上限时在该类型支持范围内发送 `numResults`。按 `results` 顺序映射 `url`、`title` 和可用的高亮文本。
- **要求** 有效 `results: []` 为无结果。缺失、不合法或全部无效来源的结果为响应失败，认证、额度、限流和取消遵守[降级规格](fallback.md)。设置选项须注明费用随 Exa 搜索和内容用量计算。
- **来源** [用户补充的 Exa 要求 R11](../../project/requirements.md)。 [Exa Search API](https://exa.ai/docs/reference/search)
- **验收** 用替身核对单次请求的鉴权、查询、结果数和内容参数。用有序结果、空数组、报错和坏结构样本验证来源和降级。
