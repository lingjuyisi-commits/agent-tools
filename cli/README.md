# agent-tools (CLI)

`agent-tools` 是安装在开发者本地的客户端工具。它自动向已安装的 AI 编程 Agent 注入 hooks，无感知采集每次会话的 Token 消耗、工具调用、文件变更等元数据，并批量上报到中央统计服务器。

## Installation & Setup

### 安装

```bash
npm install -g agent-tools
```

### 初始化

推荐通过团队 Dashboard 的「下载客户端」获取预配置好的 tgz 安装包，安装完成后
postinstall 会自动读取包内的 `default-config.json`，写入 `~/.agent-tools/config.json`
并注入 hooks，**无需执行任何额外命令**。

如果 postinstall 未能自动配置（例如手动从公开 npm registry 安装），请从团队 Dashboard
重新下载客户端安装包并重新安装。

---

## Commands

### `setup`

检测本机已安装的 Agent 并注入 hooks 配置。

```bash
agent-tools setup [--force] [--agent <name>]
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--force` | 强制重新注入，即使 hooks 已存在 | `false` |
| `--agent <name>` | 只配置指定 Agent（如 `claude-code`） | 配置所有检测到的 Agent |

---

### `sync`

手动将本地缓存的事件批量上报到服务器。

```bash
agent-tools sync
```

通常不需要手动运行，客户端会每 5 分钟自动同步。适用于调试或在无网络环境下补报数据。

---

### `stats`

查看本地采集的统计摘要（无需联网，从本地 SQLite 读取）。

```bash
agent-tools stats [--period day|week|month] [--date YYYY-MM-DD]
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--period` | 时间段：`day` / `week` / `month` | `day` |
| `--date` | 指定日期（`day` 模式下有效），格式 `YYYY-MM-DD` | 今天 |

示例：

```bash
agent-tools stats                          # 今天的统计
agent-tools stats --period week            # 本周统计
agent-tools stats --period day --date 2025-03-01   # 指定某天
```

---

### `status`

显示当前配置信息和检测到的 Agent 状态。

```bash
agent-tools status
```

输出示例：

```
agent-tools status
─────────────────────────────────────────
Server:    http://team-server:3000  (reachable)
Config:    ~/.agent-tools/config.json
Database:  ~/.agent-tools/data/local.db  (1,234 events)
─────────────────────────────────────────
Detected Agents:
  ✓ claude-code     hooks injected    v1.2.3
  ✓ codebuddy       hooks injected    v2.1.0
  - opencode        not installed
─────────────────────────────────────────
Last sync: 2025-04-07 14:32:05 (3 min ago)
Pending:   12 events
```

---

### `agents`

列出所有支持的 Agent 及其检测状态。

```bash
agent-tools agents
```

输出每个 Agent 的安装情况、hooks 注入状态和配置文件路径。

---

### `test`

端到端测试 hook 采集管道，验证 hooks 是否正常注入和触发。

```bash
agent-tools test [--agent <name>] [--keep] [--timeout <seconds>]
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--agent <name>` | 只测试指定 Agent（如 `claude-code`、`codebuddy`） | 测试所有已安装的 Agent |
| `--keep` | 测试完成后保留临时目录（便于调试） | `false` |
| `--timeout <seconds>` | 每个测试场景的超时时间（秒） | `60` |

示例：

```bash
agent-tools test                          # 测试所有已安装 Agent
agent-tools test --agent claude-code      # 仅测试 Claude Code
agent-tools test --agent codebuddy --keep # 测试 CodeBuddy，保留临时文件
```

测试流程：
1. 在系统临时目录创建隔离环境（独立 SQLite 测试库 + 工作目录）
2. 临时向 Agent 的用户级配置注入指向测试库的同步 hooks
3. 调用 Agent CLI（`-p` 模式）执行预定义场景（工具调用、Skill 调用）
4. 检查测试库中是否采集到预期的事件类型和字段
5. 恢复原始配置，清理临时文件

每个 Agent 测试 2 个场景（Claude Code 18 项检查，CodeBuddy 17 项检查）：
- **场景 1**（基础工具调用 + 文件变更）：验证 session_start、user_message、tool_pre、tool_use（含 tool_name）、session_id、session_end/stop、files_created/lines_added（Write）、files_modified/line counts（Edit）、磁盘文件存在性和内容验证、token_input/output、model
- **场景 2**（Skill 调用）：验证 skill_use 事件和 skill_name 字段

---

## How It Works

### Hook 注入机制

`agent-tools setup` 运行时，会修改各 Agent 的配置文件，将 `universal-hook.js` 注册为事件 hook：

**Claude Code** (`~/.claude/settings.json`)：

```json
{
  "hooks": {
    "PreToolUse":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "node ~/.agent-tools/hooks/universal-hook.js --agent=claude-code --event=PreToolUse" }] }],
    "PostToolUse":    [{ "matcher": "", "hooks": [{ "type": "command", "command": "node ~/.agent-tools/hooks/universal-hook.js --agent=claude-code --event=PostToolUse" }] }],
    "SessionStart":   [{ "matcher": "", "hooks": [{ "type": "command", "command": "node ~/.agent-tools/hooks/universal-hook.js --agent=claude-code --event=SessionStart" }] }],
    "SessionEnd":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "node ~/.agent-tools/hooks/universal-hook.js --agent=claude-code --event=SessionEnd" }] }],
    "UserPromptSubmit":[{ "matcher": "", "hooks": [{ "type": "command", "command": "node ~/.agent-tools/hooks/universal-hook.js --agent=claude-code --event=UserPromptSubmit" }] }],
    "Stop":           [{ "matcher": "", "hooks": [{ "type": "command", "command": "node ~/.agent-tools/hooks/universal-hook.js --agent=claude-code --event=Stop" }] }]
  }
}
```

**CodeBuddy** (`~/.codebuddy/settings.json`)：结构类似，命令参数为 `--agent=codebuddy`。

### 数据处理流程

```
Agent 触发 hook
      │
      ▼  stdin (JSON)
universal-hook.js
      │
      ▼  适配器（按 --agent 参数选择）
normalize(rawData) → StandardEvent
      │
      ▼
local-store.js → ~/.agent-tools/data/local.db (SQLite)
      │
      ▼  每 5 分钟 或 累计 100 条事件
uploader.js → POST /api/v1/events/batch
      │
      ▼
中央服务器入库
```

1. **触发**：Agent 在执行工具调用前后、会话开始/结束时触发 hook，通过 stdin 向 `universal-hook.js` 传入 JSON 格式的事件数据
2. **标准化**：适配器（`adapters/claude-code.js` 等）将各 Agent 的原始字段映射到统一的 `StandardEvent` 结构
3. **本地存储**：标准化后的事件写入本地 SQLite（`~/.agent-tools/data/local.db`）
4. **批量上报**：每 5 分钟或积累 100 条事件时，`uploader.js` 将未上报的事件批量发送到服务器的 `POST /api/v1/events/batch` 接口
5. **容错**：网络不可用时，事件留在本地，等网络恢复后下次上报时补发；`universal-hook.js` 所有逻辑都在 try/catch 中，不会因 hook 错误影响 Agent 正常使用

---

## Collected Events

### 事件类型

| 事件类型 | 触发时机 | 采集字段 |
|----------|----------|----------|
| `SessionStart` | Agent 会话开始时 | `session_id`, `agent`, `model`, `hostname`, `username`, `timestamp` |
| `SessionEnd` | Agent 会话结束时 | `session_id`, `duration_ms`, `total_input_tokens`, `total_output_tokens`, `turn_count` |
| `PreToolUse` | 工具调用前 | `session_id`, `tool_name`, `model`, `input_tokens`, `output_tokens` |
| `PostToolUse` | 工具调用后 | `session_id`, `tool_name`, `model`, `input_tokens`, `output_tokens`, `duration_ms`, `exit_code` |
| `UserPromptSubmit` | 用户提交 prompt 时 | `session_id`, `model`, `timestamp` |
| `Stop` | Agent 任务完成时 | `session_id`, `stop_reason`, `total_input_tokens`, `total_output_tokens` |

### StandardEvent 结构

```typescript
interface StandardEvent {
  // 必填字段
  event_type: string;          // 事件类型
  session_id: string;          // 会话唯一标识
  agent: string;               // agent 名称（claude-code / codebuddy）
  timestamp: string;           // ISO 8601 时间戳

  // 环境信息
  hostname?: string;           // 机器名
  username?: string;           // 系统用户名

  // 模型信息
  model?: string;              // 模型名称（如 claude-opus-4）

  // Token 数据
  input_tokens?: number;       // 本次输入 token
  output_tokens?: number;      // 本次输出 token

  // 工具信息（PreToolUse / PostToolUse）
  tool_name?: string;          // 工具名称
  duration_ms?: number;        // 工具执行耗时（毫秒）

  // 文件变更（PostToolUse Write/Edit 类工具）
  files_changed?: number;      // 变更文件数
  lines_added?: number;        // 新增行数
  lines_removed?: number;      // 删除行数

  // Skill 信息
  skill_name?: string;         // Skill 名称（如果适用）
}
```

---

## Local Data Directory

```
~/.agent-tools/
├── config.json          # 配置文件（服务器地址、用户标识等）
├── hooks/
│   └── universal-hook.js    # 自动安装的 hook 脚本（软链接或拷贝）
└── data/
    └── local.db         # 本地 SQLite 缓存
```

### config.json 示例

```json
{
  "server": "http://team-server:3000",
  "username": "leon",
  "installDate": "2025-04-01T08:00:00.000Z",
  "upload": {
    "intervalMinutes": 5,
    "batchSize": 100
  }
}
```

---

## Supported Agents

| Agent | 配置文件 | Hook 机制 |
|-------|----------|-----------|
| Claude Code | `~/.claude/settings.json` | 原生 hooks 支持（PreToolUse/PostToolUse/SessionStart/SessionEnd/UserPromptSubmit/Stop） |
| CodeBuddy | `~/.codebuddy/settings.json` | 原生 hooks 支持（字段结构略有差异，通过适配器标准化） |

---

## Privacy

`agent-tools` 只采集**元数据**，不采集任何敏感内容：

- **不采集**：prompt 内容、代码内容、文件内容、工具调用的参数值
- **采集**：工具名称、Token 数量（不含文本）、文件数量、代码行数变化量、会话时长、模型名称、机器名、系统用户名

所有数据上报到你自己控制的服务器（由安装包内的 `default-config.json` 指定），不会发送到任何第三方。

---

## Troubleshooting

### hooks 未生效

```bash
agent-tools status         # 检查 hooks 是否已注入
agent-tools setup --force  # 强制重新注入
```

### 上报失败

```bash
agent-tools status   # 检查服务器连接状态
agent-tools sync     # 手动触发上报，查看错误信息
```

### 本地数据库损坏

```bash
rm ~/.agent-tools/data/local.db   # 删除后 hook 下次触发时自动重建
```

### better-sqlite3 编译问题

如果在安装后遇到 native addon 相关错误：

```bash
npm rebuild better-sqlite3
# 或使用 pnpm
pnpm approve-builds
pnpm rebuild
```

---

## Development

```bash
git clone https://github.com/your-org/agent-tools
cd agent-tools/cli
npm install
node bin/cli.js init --server http://localhost:3000
```

详细开发指南见 [`../doc/08-development-guide.md`](../doc/08-development-guide.md)。
