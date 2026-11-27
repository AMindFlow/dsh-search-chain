# GitHub 协作

## 分支与 PR

远程地址为 `https://github.com/AMindFlow/dsh-search-chain.git`，默认分支为 `main`。空远程建立初始 `main` 后，所有变更从最新 `main` 切短分支，如 `feat/123-openai`，通过 PR 回到 `main`。在仓库中保护 `main`，启用 PR 审阅及已落地的相关检查，限制直接推送和强推。 [GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow)

每个工作包对应一个 Issue、一个分支、一个 PR。打开 PR 时关联 Issue、规格编号和前置依赖，记录实际验证及缺口。评审基于当前提交，处理阻塞意见后默认 squash 合并，随后删除主题分支。完整兑现 Issue 时使用 `Closes #编号`，只完成部分时引用 Issue 并保留其后续工作。tag 和 Release 来自已验收的 `main` 提交。

## Agent 协作

1. 由 Qwen3.8 Flash High 担任 lead 并启动 agent 团队。Lead 只负责分工、审阅、跟踪阻塞和汇总交付。Oracle、实现和验证由所分派的 subagent 完成。
2. 先由独立的 GPT-6 Luna High subagent 编制测试 Oracle，依据规格明确可观察的预期和验证方法。Lead 审阅并通过 Oracle 后才分派开发。如果工作无需测试或测试无法执行，Lead 记录理由和验证缺口后可以跳过 Oracle。
3. 由 Haiku 5.5 High subagent 按已审阅的 Oracle 和规格实施，并记录自测结果。
4. 开发完成后，Lead 跟踪 GitHub 上的自动 GPT 审阅及其对应提交。审阅整改限于 P0 和影响主体功能的 P1，由开发 subagent 修复后复验。其余审阅意见在交付时列出影响并交由用户裁决。自动审阅未返回时标记为待审，继续遵守仓库已有的 PR 门禁。

## GitHub Projects

AMindFlow 组织的 [dsh-search-chain Project #1](https://github.com/orgs/AMindFlow/projects/1/views/1) 已关联此仓库。用仓库 Issue 承载工作包，Issue 的 `Blocked by` 表示执行依赖。工作包按 [DAG](../project/development-dag.md)登记。之后负责人、进度、优先级和运行中的依赖在 GitHub 维护，仓库文档保留技术契约与里程碑。 [GitHub Issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies)

| 字段或视图 | 用途 |
| --- | --- |
| `Status` | `Inbox` 待分诊 → `Ready` 已定义范围并且可以开工 → `In progress` → `In review` → `Done` 已结案 |
| `Priority` | `P0` 当前里程碑门槛，`P1` 后续；待分诊可以留空 |
| `Assignees`、`Milestone` | 当前负责人和目标里程碑，首版使用路线图指定的里程碑 |
| `Board` | 按 `Status` 分列的看板 |
| `Triage`、`Roadmap` | 登记工作包时配置筛选 `Inbox` 的表格和按 `Milestone` 分组的表格 |

用 Projects 内置自动化从本仓库 auto-add `is:issue is:open`，新加入项默认 `Inbox`，Issue 关闭后转 `Done`。首次启用时导入已有的待处理 Issues。重新打开的 Issue 回到 `Inbox` 重新分诊。以一个测试项核对自动入板、状态迁移和依赖显示。 [自动添加 Items](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically) · [内置自动化](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations)

## 用户 Issues

1. 用户在 GitHub 的 `Issues` → `New issue` 页面填写缺陷或功能建议表单，也可以选 `Blank issue`，直接用普通文本或 Markdown 描述。仓库维护者在 [.github/ISSUE_TEMPLATE](../../.github/ISSUE_TEMPLATE/) 用 YAML 配置表单和空白入口，两种方式提交的 Issue 都进入分诊。缺陷可附 dsh 和插件版本、代理模式、可公开的复现步骤、预期及结果，诊断信息需脱敏。 [GitHub 创建 Issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue#creating-an-issue-from-a-repository)
2. 分诊时核对重复项和已有规格，确认是否可复现及是否需要用户补充。重复项关联原 Issue 后关闭。行为变更先写规格和验收条件，再排优先级。阻塞任务留在约定的依赖上，前置完成后进入 `Ready`。
3. 问题若需多个可独立合并的工作包，保留用户 Issue 与对应工作包 Issue 的关系，各工作包在自己的 PR 记录验收。用户 Issue 在承诺的行为可验证后结案，并关联修复 PR 或可用版本。
