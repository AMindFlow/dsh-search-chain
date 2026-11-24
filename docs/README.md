# 项目文档

- [需求映射](project/requirements.md)关联原文 R1–R8、最新输入和对应规格。
- [路线图](project/roadmap.md)记录交付顺序和首版完成条件。[开发 DAG](project/development-dag.md)用于切分 Issue、安排并行和收口。
- [规格规则](specs/AGENTS.md)指向各维度草案和生效方式。[设置面板](specs/draft/settings-ui.md)与[首期工具目录](specs/draft/providers.md)是本轮审核入口。
- [规格模板](templates/spec.md)用于编写独立验收的行为条款。[GitHub 协作](workflow/github.md)规定分支、Projects、用户 Issues 和 PR 的管理方式。
- [用户文档](user/README.md)面向安装、启用、配置、排错和升级，随可安装版本发布。

## 项目标识

| 用途 | 标识 |
| --- | --- |
| GitHub 仓库 | [AMindFlow/dsh-search-chain](https://github.com/AMindFlow/dsh-search-chain) |
| dsh bundle 包名 | `dsh-search-chain` |
| dsh 搜索 provider ID、插件配置行 ID | `search-chain` |

实现基线采用 dsh 的 Node 24 宿主、JavaScript ESM 和 `node:test`。本机安装的 dsh `0.2.2-rc.5` 已用来静态核对注册、选择和工具预算。发布时由实际安装测试决定 `engines.dsh` 的范围。

## 存放位置

| 路径 | 内容 |
| --- | --- |
| `README.md`、`AGENTS.md` | 项目入口和持续适用的协作规则 |
| `docs/project/` | 需求索引、路线图、DAG，发版时加入 `releases/` 验收记录 |
| `docs/specs/draft/`、`docs/specs/official/` | 待确认或实现的规格、生效规格。首次生效时创建 `official/` |
| `docs/templates/` | 项目文档模板 |
| `docs/workflow/`、`.github/` | 协作流程，以及 Issue 表单、PR 模板和后续 CI |
| `docs/user/` | 随可安装版本加入安装、配置、排错和回退说明 |
| `package.json`、锁文件 | bundle 入口、依赖、版本、dsh 兼容范围和测试命令 |
| `THIRD_PARTY_NOTICES.md` | 复用第三方源码时随包加入的来源、版权与许可 |
| `src/index.js`、`src/cordis.patch.yml` | 宿主注册与卸载、bundle 安装补丁 |
| `src/client.js`、`src/settings/` | DSH 设置插槽与工具列表交互 |
| `src/config.js`、`src/transport.js`、`src/search.js` | 配置与凭据、HTTP 传输、降级编排 |
| `src/backends/` | [首期工具目录](specs/draft/providers.md)的供应商适配器 |
| `test/`、`test/fixtures/` | 行为测试和脱敏的供应商响应样本 |
| `dist/`、`artifacts/` | 有打包需求时使用的本地生成目录 |

实现和用户文档随工作包加入。安装使用的清单和源码由同一提交提供，分发复用该来源。真实配置、凭据和原始诊断数据留在用户 profile 或本地工作区之外。
