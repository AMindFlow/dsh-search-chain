# FleetSeek · 网页搜索链

**出网边界最严格的多源搜索链**：把 Bing RSS、Brave、Exa、Tavily、OpenAI、Gemini、DeepSeek 的免费/低额搜索能力组成一条有序回退链——聚合高额度、始终可用的 web_search；同时每个条目的出网路径独立受控：直连或指定代理，支持 PAC 并由 OS 沙箱强制执行，**绝不静默换路径**。密钥只进宿主凭据服务（只写不读），保存即校验、明文自动清零。
**多 provider 降级，确保搜索工具可用且好用**：把 Bing RSS、Brave、Exa、Tavily、OpenAI、Gemini、DeepSeek 的搜索能力组成一条有序链，利用各厂商的免费额度聚合出一个高额度、始终可用的 web_search——结果质量比裸 Bing 网页或 web_fetch 单抓更好，一个厂商没额度、超时或无结果时自动降级到下一个。

为 DeepSeek Harness（DSH）提供搜索 provider 插件「网页搜索链」。你在设置面板添加、启停和排序条目（条目 = 供应商 × 端点），每次搜索按保存顺序逐个尝试，前一个失败或无结果才降级——不是并行聚合，不给结果掺水。DeepSeek 官方 API 会话可在宿主官方搜索和自定义链之间切换。

## 30 秒安装

先取最新发布的完整 commit（官方规则：钉 40 位 commit 才有「更新」能力）：

```bash
git ls-remote https://github.com/AMindFlow/dsh-fleetseek.git 'refs/tags/v*'
# 取最新 v* 的 refs/tags/v<版本>^{} 行的 40 位 SHA（^{} 解引用后的 commit，不是 tag 对象）
```

然后在 DSH 里说：**用 plugin_manager 的 install_bundle 安装 `git+https://github.com/AMindFlow/dsh-fleetseek.git#<SHA>`**。想装好后可在 Discover 里一键更新，把索引源 `https://raw.githubusercontent.com/AMindFlow/dsh-plugin-index/main/market-index.json` 加进插件页「自定义插件索引」。详细前提与回退见 [INSTALL.md](INSTALL.md)。

装好后：启用插件 → 「设置 → 网页搜索链」添加一个你有凭据的条目（Bing RSS 免 key 可先试）→ 把 `web.searchProvider` 设为 `search-chain` → 新会话搜一次，结果带 `[n]` 编号引用即已生效。

## 特性

- **七类供应商**：OpenAI、Tavily、Exa、Brave、Bing RSS、Gemini、DeepSeek（与宿主官方 DeepSeek 搜索分支共存，可随时切回）。
- **凭据走宿主 credentials 服务**：GUI 不回显明文，不落仓库。
- **条目级网络出口**：每个条目独立配置直连 / `host:port` 代理 / `pac:` PAC 脚本。配了代理的条目**只走该代理，绝不静默回退直连**（非对称拒绝，隐私承诺可验证）。
- **PAC 沙箱**：用户提供的 PAC 脚本在 vm 隔离环境求值——禁动态生码、原型链与外部内存对象封固、金丝雀自检失败即拒评；堆 24 MiB 硬限 + 进程 RSS 144 MiB 兜底闸、2 秒墙钟。远程 PAC 在保存时如实提示「内容可被服务器随时更改」。
- **经过对抗性打磨**：12 轮 codex 自动评审（末轮代码+安全双零发现）；真机 oracle 165 场景 PASS 151 / FAIL 0；`npm test` 880 用例。详见[发布验收记录](docs/project/releases/v0.1.0.md)。

## 已知限制

worker 内存目前是用户态两层边界，OS 级配额在 [#64](https://github.com/AMindFlow/dsh-fleetseek/issues/64)；npm 裸名已被无关包占用，安装请走 Git 钉 commit。

## 文档

用户向：[快速开始](docs/user/getting-started.md) · [排错](docs/user/troubleshooting.md) · [升级](docs/user/upgrade.md)。维护者向：[项目文档](docs/README.md) · [协作规则](AGENTS.md) · [路线图](docs/project/roadmap.md)。
