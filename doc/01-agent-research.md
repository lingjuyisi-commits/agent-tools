# CLI编程Agent调研报告

## 1. 主流CLI编程Agent概览

> **优先支持范围：** Claude Code、CodeBuddy（Phase 1/2），其余Agent后续扩展。

| Agent | 安装方式 | 配置格式 | Hook系统 | MCP支持 | 会话存储 | 优先级 |
|-------|---------|---------|----------|---------|---------|--------|
| **Claude Code** | npm | JSON (`.claude/`) | 21个生命周期事件 | 完整支持 | JSONL + telemetry | **P0** |
| **CodeBuddy (腾讯)** | 腾讯云分发 | JSON (`.codebuddy/`) | PreToolUse/PostToolUse | 支持 | 本地聊天历史 | **P0** |
| OpenCode | Go binary | JSON (`opencode.json`) | JS/TS插件系统 | 支持 | SQLite | P1 |
| GitHub Copilot CLI | gh extension | JSON (`.github/hooks/`) | 6个事件 | 支持 | GitHub托管 | P1 |
| Cursor CLI | 随IDE安装 | JSON (`.cursor/`) | Pre/Post tool hooks | 完整支持 | IDE内部管理 | P1 |
| Continue CLI | npm | YAML (`config.yaml`) | onPreToolUse/onPostToolUse | 完整支持 | 本地 | P2 |
| Amazon Q CLI | brew/aws installer | JSON (`.amazonq/`) | Agent hooks | 支持 | AWS托管 | P2 |
| Cline CLI | npm | VS Code配置 | 无文档化hook | 支持(VS Code) | VS Code内部 | P2 |
| Roo Code CLI | npm | VS Code配置 | 无文档化hook | 支持(VS Code) | VS Code内部 | P2 |

## 2. 各Agent详细配置

### 2.1 Claude Code

**配置文件位置：**
- 用户级：`~/.claude/settings.json`
- 项目级：`.claude/settings.json`（可提交）
- 项目本地：`.claude/settings.local.json`（gitignore）

**Hook系统（最成熟）：**
- 21个生命周期事件，4种handler类型（command, HTTP, prompt, agent）
- 关键事件：`SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`, `FileChanged`, `SubagentStart/Stop`, `Notification`
- Hook通过stdin接收JSON，stdout返回JSON，exit code 0=成功, 2=阻塞错误
- 支持 `"async": true` 用于异步触发
- HTTP hook直接POST事件JSON到URL
- PreToolUse可返回 `permissionDecision: "allow|deny|ask|defer"`

**会话存储：**
- `~/.claude/sessions/<id>.json` — 会话数据
- `~/.claude/projects/<project-hash>/` — JSONL格式转录
- `~/.claude/history.jsonl` — 对话历史
- `~/.claude/telemetry/` — 本地遥测数据

**MCP配置：** `.mcp.json`（项目级）或 `--mcp-config` 参数

**插件系统：** `~/.claude/plugins/` 目录，通过 `/plugin` 命令安装，可打包hooks、skills、agents

### 2.2 CodeBuddy（腾讯）

**配置文件位置（与Claude Code几乎一致的结构）：**
- 用户级：`~/.codebuddy/settings.json`
- 项目级：`.codebuddy/settings.json`
- 项目本地：`.codebuddy/settings.local.json`

**Hook系统：** PreToolUse/PostToolUse hooks，Bash命令执行，支持 `disableAllHooks` 设置

**插件系统：** `enabledPlugins` 配置 + 市场支持

**MCP：** 通过 `enableAllProjectMcpServers`, `enabledMcpjsonServers` 等配置

### 2.3 OpenCode

**配置文件位置：**
- 全局：`~/.config/opencode/opencode.json`
- 项目级：`opencode.json`（项目根目录）

**插件系统（JS/TS）：**
- 全局：`~/.config/opencode/plugins/`
- 项目级：`.opencode/plugins/`
- 支持npm包：`"plugin": ["package-name"]`
- Hook事件：`tool.execute.before`, `tool.execute.after`, `session.created`, `session.idle`, `session.compacted`, `message.updated`, `permission.asked`, `permission.replied`, `file.edited`, `command.executed`
- 插件函数接收context对象（`project`, `directory`, `client`, `$`）

**会话存储：** SQLite数据库

### 2.4 GitHub Copilot CLI

**配置文件：** `.github/hooks/hooks.json`（per-repo），JSON格式

**Hook系统：**
- 6个事件：`sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `errorOccurred`
- Hook类型为 `"command"`，支持平台特定脚本（`bash`/`powershell`字段）
- PreToolUse可返回 `permissionDecision: "deny|allow|ask"`

### 2.6 Cursor CLI

**配置文件：**
- MCP：`.cursor/mcp.json`（项目）、`~/.cursor/mcp.json`（全局）
- Hooks：`.cursor/hooks.json`
- 沙箱：`sandbox.json`

**Hook系统：** session start/end, prompt submitted, stop, `beforeReadFile`, `beforeSubmitPrompt`, pre/post tool use

### 2.7 Continue CLI

**配置文件：** `~/.continue/config.yaml`（YAML），`~/.continue/permissions.yaml`

**Hook系统：** `onPreToolUse`, `onPostToolUse`

**MCP：** 配置在 config.yaml 或 `.continue/mcpServers/` 目录，兼容 Claude Desktop/Cursor 的JSON格式

### 2.8 Amazon Q Developer CLI

**配置文件：**
- 全局：`~/.aws/amazonq/default.json`
- 项目级：`.amazonq/default.json`
- MCP：`~/.aws/amazonq/mcp.json` 或 `.amazonq/mcp.json`
- 自定义Agents：`.amazonq/agents/` 目录

**Hook系统：** Agent hooks，触发器 `agentSpawn` 和 `userPromptSubmit`，支持 `timeout_ms` 和 `cache_ttl_seconds`

## 3. 跨Agent集成能力矩阵

| 集成机制 | 支持的Agent |
|---------|------------|
| **Pre/Post tool hooks (JSON stdin/stdout)** | Claude Code, Copilot CLI, Cursor, OpenCode, CodeBuddy, Continue |
| **dotfile JSON配置** | Claude Code, Copilot, Cursor, CodeBuddy, Amazon Q, OpenCode |
| **MCP服务器协议** | 除Aider外全部 |
| **YAML配置** | Aider, Continue |
| **插件/扩展系统** | Claude Code, OpenCode, CodeBuddy, Copilot CLI, Continue |
| **HTTP hook端点** | 仅Claude Code原生支持 |

## 4. 关键发现

1. **Hook系统是最佳数据采集点**：大多数主流Agent支持PreToolUse/PostToolUse hooks，可在此注入数据采集逻辑
2. **MCP是最通用的集成协议**：8/9的Agent支持MCP，可作为统一接口层
3. **配置结构高度相似**：Claude Code和CodeBuddy几乎一致的配置模式，说明业界在趋同
4. **没有现成的跨工具统计方案**：当前市场上不存在成熟的跨AI编程工具统计聚合开源项目
5. **Claude Code和CodeBuddy配置结构几乎一致**：可复用大部分适配器逻辑，作为首批支持的Agent最为合理
