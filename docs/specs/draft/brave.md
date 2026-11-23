# Brave Web Search API

## BRV-001 请求与来源

- **要求** Brave 条目被尝试时须对 `https://api.search.brave.com/res/v1/web/search` 发一次 GET，使用 `X-Subscription-Token` 鉴权。发送当前查询 `q`，设置 `result_filter=web` 和 `text_decorations=false`。若宿主提供结果数，`count` 取其与 20 中较小值。超过 Brave 的 600 字符或 75 词限制时须报告该条目的参数限制，后继条目收到完整查询。
- **要求** 按 `web.results` 顺序提取有效 `url`、`title`、`description`。可识别的空网页结果为无结果，畸形数据或上游失败按[降级规格](fallback.md)报告。设置选项须注明使用 Brave Search API 套餐。
- **来源** [用户补充的 Brave 要求 R11](../../project/requirements.md)。 [Brave Web Search API](https://api-dashboard.search.brave.com/api-reference/web/search/get)
- **验收** 用替身核对查询编码、鉴权头、结果过滤、单次请求和上限。用正常、空、无效结构和 429 验证分类。超出供应商查询长度时 Brave 无请求，后继查询未被截断。
