# 用户文档

本目录面向安装和使用 dsh-fleetseek 的用户。内容以当前提交实现为准；与开发规格（`docs/specs/draft/`）不一致的地方，以本目录为准描述实际行为。

- [快速开始](getting-started.md)：安装与启用、设置面板、配置条目的字段含义、凭据来源与优先级、DeepSeek 官方分支、`maxResults` 语义，以及当前已知限制（含代理/PAC 实际链路与响应体 2 MiB 上限）。
- [排错指南](troubleshooting.md)：按错误码查看现象和可操作的处理办法，并说明如何读取 `details.attempts`。
- [升级指南](upgrade.md)：从 0.x 开发版升级到本版时的变化、影响和手动检查清单。
- [evidence/](evidence/)：文档结论的本地复测材料。[proxy-retest-v0.1.mjs](evidence/proxy-retest-v0.1.mjs) 是只连回环地址的 headless fixture，[proxy-retest-v0.1.log](evidence/proxy-retest-v0.1.log) 是其输出（代理零出站、PAC 直连下载、2 MiB 上限、指令选择）。
- [项目文档](../README.md)：规格、路线图和开发协作规则（面向维护者）。
