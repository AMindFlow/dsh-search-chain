# 实施代理调用规范（agy CLI / Gemini）

面向在终端唤起 agy CLI 承担**实施角色**的场景。评审（Oracle）路由不在本文范围。

## 通道优先级

1. **首选：OAuth 个人订阅**——显式置空 modelProvider，让 `--model` 命中 CLI 默认（订阅）后端：

   ```bash
   agy --settings '{"modelProvider":null}' --model gemini-4-hydrogen-high --effort high --print='…'
   ```

2. **降级：本地 API key 通道**——当且仅当订阅通道报配额墙
   （`429 / RESOURCE_EXHAUSTED / "Individual quota reached"`）时，
   **去掉 `--settings` 覆盖**，`modelProvider` 交由 settings.json（当前为 `gemini`）：

   ```bash
   zsh -lic 'agy --model gemini-4-hydrogen-high --effort high --print="…"'
   ```

   `GEMINI_API_KEY` 只在 zsh 登录环境中注入；**不得**写入仓库、脚本、日志或会话记录。
   bash 非登录壳看不到该变量，必须经 `zsh -lic` 唤起。

3. **回退：DSH 内 `masterbee/Qwen3.8-27B-oQ6e-mtp`**（用户钦定的最终回退实施路由）。

## 权限与配置边界

- **禁止 `--dangerously-skip-permissions`**（避免权限面意外放宽）。
- 代理模式、工具许可、沙箱、信任目录**一律**由 `~/.gemini/antigravity-cli/settings.json` 管理
  （`agentMode` / `toolPermission` / `enableTerminalSandbox` / `trustedWorkspaces`）。
- 在新的工作目录（含 git worktree）执行前，须先把该目录加入 `trustedWorkspaces`；
  否则非跳过模式下会卡在交互确认。

## 取证

- 配额墙报错（`error_id`、重置时间）记入路由证据日志（`artifacts/`，gitignored）。
- 换通道执行的工作包，交付记录须写明实际通道（订阅 / API key / Qwen 回退）。
