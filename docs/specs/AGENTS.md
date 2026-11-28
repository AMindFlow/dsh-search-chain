# 规格维护规则

## 条款写法

- 按[规格模板](../templates/spec.md)写。同一维度在各目录各保留一份规格，沿用同一文件名。每条行为以稳定编号标识，如 `CFG-001`。编号随条款从草案进入生效规格，删除后的编号保留在 Git 历史中，供追溯。
- 每条必须有**要求、来源、验收**。要求用自然语言明确主体、触发条件和可观察结果。适用时写明失败行为、默认值、顺序、时间或数量边界，使用「必须」「不得」约束。共用行为链接到归属条款。
- 验收写出前置状态或输入、执行动作和可观察的通过条件。条款有多种结果时分别验证；验收结论引用编号并记录实测范围。
- 来源链接到 GitHub Issue 或确认口径的评论。尚未登记时链接[需求索引](../project/requirements.md)并写出原文编号。协议以外的实现选择放在规格的「设计决定」，作为条款的实现依据。

## 生效方式

实质改动先在 `draft/` 确定行为和验收条件。已确认的条款与实现随同一个 PR 验收，合入后由 `official/` 定义现行行为。移除已落地的草案条款时同步更新相关引用。旧版本通过 Git 历史查阅。

## 草案索引

| 维度 | 规格草案 |
| --- | --- |
| dsh 注册、安装与回退 | [dsh-integration.md](draft/dsh-integration.md) |
| 搜索配置区域与交互 | [settings-ui.md](draft/settings-ui.md) |
| 配置、凭据、代理与直连 | [config-network.md](draft/config-network.md) |
| 配置写闸对齐读闸 | [config-write-gate.md](draft/config-write-gate.md) |
| 首期工具目录 | [providers.md](draft/providers.md) |
| OpenAI 搜索适配 | [openai.md](draft/openai.md) |
| Tavily 搜索适配 | [tavily.md](draft/tavily.md) |
| Exa 搜索适配 | [exa.md](draft/exa.md) |
| Brave 搜索适配 | [brave.md](draft/brave.md) |
| Bing RSS 搜索适配 | [bing.md](draft/bing.md) |
| Gemini 搜索适配 | [gemini.md](draft/gemini.md) |
| DeepSeek Search API 与 Agentic Search | [deepseek.md](draft/deepseek.md) |
| 顺序、预算与错误 | [fallback.md](draft/fallback.md) |
| PAC worker OS 级最小权限沙箱 | [pac-worker-os-sandbox.md](draft/pac-worker-os-sandbox.md) |
| 全局 proxy 升级与条目钉死 | [proxy-escalation.md](draft/proxy-escalation.md) |
