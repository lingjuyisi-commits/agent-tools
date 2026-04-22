# 问题排查指南

针对用户反馈"数据不上报"类问题的诊断与修复流程。适用于 `agent-tools` CLI 所有版本（含 0.8.7 及之前的旧版本）。

> **路径约定**
> - macOS / Linux：`~` 表示用户主目录（如 `/Users/yourname`）
> - Windows：用 `%USERPROFILE%` 替代 `~`（如 `%USERPROFILE%\.agent-tools`）；下文有 Windows 专项说明

## 一键解决：重装

90% 的问题重装即可修复（刷新 hooks 路径、重置上报 cursor、修复自动升级异常）：

```bash
npm install -g agent-tools-cli-x.x.x.tgz
```

安装完成后，在 Claude Code 里执行任意一次操作（改个文件、跑个命令都行），等 1–2 分钟刷新 Dashboard。

> **Windows 注意**：如果提示权限不足，请用**管理员身份**打开 PowerShell 或 CMD 再执行。

如果重装后仍然没数据，按下面的步骤诊断。

---

## 诊断 checklist

### 1. 确认 CLI 实际版本

**macOS / Linux**
```bash
agent-tools --version
which agent-tools
npm root -g        # 查看全局安装目录
npm prefix -g      # 查看全局 prefix
```

**Windows (PowerShell)**
```powershell
agent-tools --version
where.exe agent-tools
npm root -g
npm prefix -g
```

如果 `--version` 和刚装的版本不一致，说明装到了不同的 npm prefix（常见于 nvm / 多 node 环境或 Windows 下 `%APPDATA%\npm` 与自定义 prefix 共存）。需要确认终端 PATH 中 `agent-tools` 指向的路径和 `npm prefix -g` 下的 `bin`（Windows 为 prefix 根目录）一致。

### 2. 确认 hooks 被写入

**macOS / Linux**
```bash
cat ~/.claude/settings.json | grep -A 2 agent-tools
```

**Windows (PowerShell)**
```powershell
Get-Content "$env:USERPROFILE\.claude\settings.json" | Select-String "agent-tools" -Context 0,2
```

应该能看到 `PostToolUse` / `Stop` / `SessionStart` 等 hook 指向 `agent-tools` 的路径。如果没有，执行：

```bash
agent-tools install        # 重新写 hooks
```

### 3. 确认本地有事件产生

**macOS / Linux**
```bash
ls -la ~/.agent-tools/data/
sqlite3 ~/.agent-tools/data/events.db "SELECT COUNT(*), MAX(event_time) FROM events;"
sqlite3 ~/.agent-tools/data/events.db "SELECT COUNT(*) FROM events WHERE synced = 0;"
```

**Windows (PowerShell)**
```powershell
dir "$env:USERPROFILE\.agent-tools\data"
sqlite3 "$env:USERPROFILE\.agent-tools\data\events.db" "SELECT COUNT(*), MAX(event_time) FROM events;"
sqlite3 "$env:USERPROFILE\.agent-tools\data\events.db" "SELECT COUNT(*) FROM events WHERE synced = 0;"
```

> Windows 上 `sqlite3` 需要单独安装：https://www.sqlite.org/download.html，下载 sqlite-tools 压缩包，将 `sqlite3.exe` 放到 PATH 里。

- 如果 `COUNT(*) = 0`：hooks 没触发，回到步骤 2
- 如果有事件但 `synced = 0` 堆积：上报失败，看步骤 4

### 4. 确认能连通服务器

先查出服务器地址：

**macOS / Linux**
```bash
cat ~/.agent-tools/config.json
# 取出 server.url 后用 curl 测试
curl -v http://your-server:3000/api/v1/health
```

**Windows (PowerShell)**
```powershell
Get-Content "$env:USERPROFILE\.agent-tools\config.json"
# 取出 server.url 后测试
Invoke-WebRequest -Uri "http://your-server:3000/api/v1/health" -UseBasicParsing
```

如果请求失败：网络/DNS/服务器地址配错。修改 config.json 里的 `server.url`。

### 5. 手动触发一次上报

**macOS / Linux**
```bash
DEBUG_AGENT_TOOLS=1 agent-tools sync
```

**Windows (PowerShell)**
```powershell
$env:DEBUG_AGENT_TOOLS=1; agent-tools sync
```

**Windows (CMD)**
```cmd
set DEBUG_AGENT_TOOLS=1 && agent-tools sync
```

正常应输出 `synced: N`。如果报错，按错误信息排查。

### 6. 查看自动升级日志

**macOS / Linux**
```bash
cat ~/.agent-tools/data/update-log.json
```

**Windows (PowerShell)**
```powershell
Get-Content "$env:USERPROFILE\.agent-tools\data\update-log.json"
```

如果显示 `status: failed`，说明自动升级失败，跟着错误信息修。常见原因：

- **无全局 npm 写权限**
  - macOS/Linux：重装时加 `sudo`，或修好 npm prefix 目录权限
  - Windows：用管理员身份打开 PowerShell 重装
- **装到了错误的 prefix**：日志里的 `prefix` 字段和你期望的全局目录不一致 → 手动指定 npm 的全局目录后重装

---

## 0.8.7 及更早版本的已知问题

| 问题 | 影响版本 | 解决 |
|------|---------|------|
| `_npmBin` postinstall 记录在多 node 环境下不准 | ≤ 0.8.7 | 升到 ≥ 0.8.8（改为运行时 `findNpmByInstallPath()`）|
| 没有 update-log cursor，重复上报 | ≤ 0.8.8 | 升到 ≥ 0.8.9 |
| Knex 链式 query 漏了赋值导致 stats 不过滤时间 | ≤ 0.8.8 | 升到 ≥ 0.8.9 |
| 自动升级 worker 装错 prefix 但无日志可查 | ≤ 0.8.8 | 升到 ≥ 0.8.9（worker 现在会记录 `npm prefix -g`）|

**0.8.7 用户升级方法**：让管理员直接从 Dashboard 的使用指南页下载最新 tgz，执行：

```bash
npm install -g agent-tools-cli-<latest>.tgz
```

0.8.7 还不具备稳定的自动升级能力，必须手动升一次。

---

## 仍然没解决？

到 [GitHub Issues](https://github.com/lingjuyisi-commits/agent-tools/issues) 反馈，请附上以下信息：

- `agent-tools --version` 输出
- `node -v` / `npm -v` / 操作系统版本（含 Windows 版本号）
- `which agent-tools`（Windows：`where.exe agent-tools`）和 `npm prefix -g`
- update-log.json 全部内容
  - macOS/Linux：`~/.agent-tools/data/update-log.json`
  - Windows：`%USERPROFILE%\.agent-tools\data\update-log.json`
- events.db 统计（macOS/Linux）：
  ```bash
  sqlite3 ~/.agent-tools/data/events.db "SELECT COUNT(*), MIN(event_time), MAX(event_time), SUM(synced=0) FROM events;"
  ```
  Windows (PowerShell)：
  ```powershell
  sqlite3 "$env:USERPROFILE\.agent-tools\data\events.db" "SELECT COUNT(*), MIN(event_time), MAX(event_time), SUM(synced=0) FROM events;"
  ```
- 手动 sync 输出（macOS/Linux：`DEBUG_AGENT_TOOLS=1 agent-tools sync`，Windows：`$env:DEBUG_AGENT_TOOLS=1; agent-tools sync`）
