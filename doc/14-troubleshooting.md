# 问题排查指南

针对用户反馈"数据不上报"类问题的诊断与修复流程。适用于 `agent-tools` CLI 所有版本（含 0.8.7 及之前的旧版本）。

## 一键解决：重装

90% 的问题重装即可修复（刷新 hooks 路径、重置上报 cursor、修复自动升级异常）：

```bash
npm install -g agent-tools-cli-x.x.x.tgz
```

安装完成后，在 Claude Code 里执行任意一次操作（改个文件、跑个命令都行），等 1–2 分钟刷新 Dashboard。

如果重装后仍然没数据，按下面的步骤诊断。

---

## 诊断 checklist

### 1. 确认 CLI 实际版本

```bash
agent-tools --version
which agent-tools
```

如果 `--version` 和你刚装的版本不一致，说明装到了不同的 npm prefix（常见于 nvm / 多 node 环境）。解决：

```bash
npm root -g        # 查看当前终端的全局目录
npm prefix -g      # 查看全局 prefix
```

让 `which agent-tools` 指向的路径和 `npm prefix -g`/`bin` 一致。

### 2. 确认 hooks 被写入

```bash
cat ~/.claude/settings.json | grep -A 2 agent-tools
```

应该能看到 `PostToolUse` / `Stop` / `SessionStart` 等 hook 指向 `agent-tools` 的路径。如果没有，执行：

```bash
agent-tools install        # 重新写 hooks
```

### 3. 确认本地有事件产生

```bash
ls -la ~/.agent-tools/data/
sqlite3 ~/.agent-tools/data/events.db "SELECT COUNT(*), MAX(event_time) FROM events;"
sqlite3 ~/.agent-tools/data/events.db "SELECT COUNT(*) FROM events WHERE synced = 0;"
```

- 如果 `COUNT(*) = 0`：hooks 没触发，回到步骤 2
- 如果有事件但 `synced = 0` 堆积：上报失败，看步骤 4

### 4. 确认能连通服务器

```bash
cat ~/.agent-tools/config.json | grep url
curl -v $(jq -r .server.url ~/.agent-tools/config.json)/api/v1/health
```

如果 curl 失败：网络/DNS/服务器地址配错。修改 `~/.agent-tools/config.json` 里的 `server.url`。

### 5. 手动触发一次上报

```bash
DEBUG_AGENT_TOOLS=1 agent-tools sync
```

正常应输出 `synced: N`。如果报错，按错误信息排查。

### 6. 查看自动升级日志

```bash
cat ~/.agent-tools/data/update-log.json
```

如果显示 `status: failed`，说明自动升级失败，跟着错误信息修。常见原因：

- 无全局 npm 写权限 → 重装时加 `sudo` 或修好 npm prefix 权限
- 装到了错误的 prefix（日志里的 `prefix` 字段和你期望的 global 目录不一致）→ 手动指定 npm 的全局目录后重装

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
- `node -v` / `npm -v` / 操作系统版本
- `which agent-tools` 和 `npm prefix -g`
- `~/.agent-tools/data/update-log.json` 全部内容
- `sqlite3 ~/.agent-tools/data/events.db "SELECT COUNT(*), MIN(event_time), MAX(event_time), SUM(synced=0) FROM events;"` 输出
- `DEBUG_AGENT_TOOLS=1 agent-tools sync` 输出
