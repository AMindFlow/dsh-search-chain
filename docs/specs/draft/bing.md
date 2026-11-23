# Bing RSS 搜索适配

本规格定义 Bing RSS 条目的请求、来源和失败边界。条目何时运行由 [FB-001](fallback.md#fb-001-自定义顺序与降级条件)决定。

## BING-001 RSS 请求与来源

- **要求** Bing RSS 被选中时，对 `https://www.bing.com/search` 发送一次 GET，提交原查询 `q` 和 `format=rss`。该条目免 key，网络走条目自己的配置。解析 RSS `channel/item`，按顺序映射 `link`、`title`、`description` 和可解析的 `pubDate`。描述以可显示的文本处理，按 [FB-002](fallback.md#fb-002-成功结果与提示)裁剪。
- **来源** [用户补充的 Bing RSS 要求 R11](../../project/requirements.md)。 [公开查询样本](https://www.bing.com/search?format=rss&q=OpenAI+API+documentation)
- **验收** 用替身确认参数正确编码且无供应商鉴权头。用 RSS 样本检查来源、摘要、发布日、结果上限和顺序。切换启用和条目代理后从 dsh 工具复验请求路径。

## BING-002 空 Feed 与失败

- **要求** 可解析的 RSS feed 没有 `item` 时报告无结果。403、拦截页或验证码属于访问受限；非 RSS、XML 结构异常及所有条目无有效链接属于响应失败。只解析本响应中的 XML，不展开外部实体。
- **来源** [原始需求 R5及 Bing RSS 要求 R11](../../project/requirements.md)。
- **验收** 用空 feed、非 RSS HTML、403 和畸形 XML 验证分类，检查无额外出站。实网用公开查询核对至少一条来源。当前本机公开样本返回 HTTP 200、RSS XML 和 10 个 `item`，发布验收复查候选环境。

## 设计决定

- 这是已观察到的 Bing 面向搜索页的 RSS 返回格式。可用性以实网验证记录为准。
