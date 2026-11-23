# 首期搜索工具目录

本规格定义设置页能添加的类型，以及各适配规格的入口。每个条目运行一次当前查询，调度与统一结果合同见[降级规格](fallback.md)。

## CAT-001 首期类型

- **要求** 首期须提供以下七种工具类型。DeepSeek 条目可在其编辑页选择 Search API 或 Agentic Search。选择不同类型时，应显示对应的凭据、模型或模式字段及简明计费说明。实际费用按所选服务和账号结算。
- **来源** [用户补充的首期供应商要求 R11](../../project/requirements.md)。
- **验收** 七种类型都可在「添加搜索工具」选择。用替身为每种类型各保存一条并置于首位，从 DSH `web_search` 发起查询，核对对应适配器及其结果。再关闭它并发起查询，核对进入后续启用条目。DeepSeek 两种模式分别复验。

| 类型 | 凭据 | 请求与验收 |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | [Responses Web Search](openai.md) |
| Tavily | `TAVILY_API_KEY` | [Tavily Basic](tavily.md) |
| Exa | `EXA_API_KEY` | [Exa Search API](exa.md) |
| Brave | `BRAVE_API_KEY` | [Brave Web Search API](brave.md) |
| Bing RSS | 免 key | [Bing RSS](bing.md) |
| Gemini | `GEMINI_API_KEY` | [Google Search grounding](gemini.md) |
| DeepSeek | `DEEPSEEK_API_KEY` | [Search API 与 Agentic Search](deepseek.md) |
