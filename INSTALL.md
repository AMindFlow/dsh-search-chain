# 安装与更新（dsh-search-chain）

面向仓库协作者与试用者。安装走 Git 固定提交，与同仓库生态（dsh-auto-retitle）一致；npm 包名 `dsh-search-chain` 已被无关包占用，请勿尝试 npm 渠道。

## 前提（一次性）

1. DSH 版本满足 `package.json` 的 `engines.dsh`（`>=0.2.2-rc.5 <0.3.0-0`）。版本不符会被宿主挡下，不会装坏。
2. 机器上有 **pnpm** 且在 PATH（Git 渠道安装由 pnpm 拉取与解析依赖；缺了会报 `spawn pnpm ENOENT`）：`npm install -g pnpm` 或 `corepack enable pnpm`。
3. 本仓库为公开仓库，HTTPS 匿名可读；无需 GitHub 授权。私有化后需把你的 Git 凭证配好（推荐 `ssh -T git@github.com` 验证通过）。
4. 本插件注册搜索 provider `search-chain`，不自动改写 `web.searchProvider`。若同时装了其他把 `web.searchProvider` 指到自己或内置行的补丁插件（modsearch、free-web-search、官方「会话/搜索」实验包等），后装的补丁可能赢，行为不可预期——先卸掉同类再装本插件，或装完后核对 `web.searchProvider` 行。

## 安装（固定 40 位提交）

取发布 tag 指向的完整 commit：

```bash
git ls-remote --tags https://github.com/AMindFlow/dsh-search-chain.git
# 取最新 refs/tags/v0.1.*^{} 那一行的 40 位 SHA（^{} 解引用后的 commit，不是 tag 对象本身）
```

**方式 A · 交给你的 DSH 装**（推荐，桌面版/网页版皆可）——把这句话发给 DeepSeek Harness（Standard 模式，它会用插件管理器安装并要求你确认）：

> 用 plugin_manager 的 install_bundle 安装 `git+https://github.com/AMindFlow/dsh-search-chain.git#<SHA>`。

**方式 B · 桌面插件页**：Plugins → Add plugin → 输入 `git+https://github.com/AMindFlow/dsh-search-chain.git#<SHA>` → 安装 → 启用。

**方式 C · 命令行**（终端用户/CI）：

```bash
npx -y @deepseek-ai/dsh plugin --profile <profile名> add "git+https://github.com/AMindFlow/dsh-search-chain.git#<SHA>"
```

profile 不存在会自动创建；成功后 `<profile>/package.json` 的 dependencies 与 `dsh.profile.bundles` 均写入本插件，重启 DSH 生效。

注意：**spec 必须钉 40 位完整 commit**。用分支名或裸 tag 安装的副本在 DSH 里没有「更新」能力（官方规则：非完整 commit 的 git spec 不可更新）。

装完重启一次 DSH。安装只注册 provider `search-chain`，不改你现有的搜索选择；要在「设置 → 网页搜索链」添加条目并保存，再把 `web.searchProvider` 设为 `search-chain`（面板启用开关或 profile 补丁均可）。

（安装报「无法连接 github.com / timed out」时：宿主 GitHub 连通探测超时太紧，在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾追加后重启：

```yaml
- id: plugin-manager
  config:
    githubConnectionTimeoutMs: 30000
    gitTransportTimeoutMs: 30000
```

## 验证装好了

1. 插件页出现 dsh-search-chain 卡片，详情页可读。
2. 「设置」页出现与「模型」同级的「网页搜索链」面板；添加一个你有凭据的条目（如 Bing RSS，无需 key）保存并重开后读回一致。
3. 新开会话发一条 `timeRange: "week"` 的搜索。若走了本链，结果带 `[n]` 编号引用；宿主工具时间线显示 web_search 完成。凭据缺失时收到可读的配置错误而非静默官方回退。

## 更新

重复安装步骤，`<SHA>` 换成新发布 tag 解引用后的 commit。回退：插件页卸载本插件并重启，再把 `web.searchProvider` 改回原值。
