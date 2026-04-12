# agent-tools

AI 编程 Agent 使用统计工具，支持 Claude Code、CodeBuddy 等主流 CLI 编程 Agent，自动采集 Token 消耗、工具使用、文件变更等数据，上报到中央服务器，提供排名、下钻分析和可视化 Dashboard。

## 项目介绍

在团队协作中，AI 编程 Agent 的使用情况往往缺乏可见性——谁用得最多？哪个 Agent 效率更高？Token 消耗是否在预算之内？`agent-tools` 解决了这个问题：

- **自动采集**：通过向 Agent 注入 hooks，无感知采集每次会话的 Token 消耗、工具调用、文件变更等元数据
- **中央汇聚**：所有开发者的数据上报到同一台服务器，实现团队级别的统计和对比
- **多维分析**：按时间段、开发者、机器名、Agent、模型等多个维度下钻分析
- **可视化 Dashboard**：基于 ECharts 的单页应用，无需额外依赖

## 目录结构

```
agent-tools/
├── cli/          # 客户端 npm 包 (agent-tools)
├── server/       # 服务端 npm 包 (agent-tools-server)
└── doc/          # 设计文档
    ├── 01-agent-research.md
    ├── 02-architecture.md
    ├── 03-database-design.md
    ├── 04-metrics-design.md
    ├── 05-client-detail.md
    ├── 06-server-detail.md
    ├── 07-implementation-plan.md
    ├── 08-development-guide.md
    ├── 09-version-update-design.md
    ├── 10-auth-design.md
    └── 11-integration-guide.md
```

## 快速开始

### Step 1：启动服务器

在团队共享机器（或本地）上安装并启动统计服务器：

```bash
npm install -g agent-tools-server
agent-tools-server
# 首次运行将启动交互式初始化向导，引导配置数据库
```

### Step 2：安装客户端

在每台开发者机器上安装客户端并完成初始化：

```bash
npm install -g agent-tools
agent-tools init                                    # 首次初始化（交互式）
agent-tools init --server http://your-server:3000   # 非交互模式（指定服务器地址）
```

`init` 会自动检测已安装的 Agent 并注入 hooks，完成后即开始自动采集。

验证 hooks 是否正常工作：

```bash
agent-tools test                                    # 端到端测试所有已安装 Agent
agent-tools test --agent claude-code                # 仅测试指定 Agent
```

### Step 3：打开 Dashboard

在浏览器中访问：

```
http://localhost:3000
```

即可查看统计数据、排名和趋势图。

### （可选）启用登录认证

默认所有端点公开，适合内网部署。如需限制 Dashboard 访问，可配置 OAuth2 认证：

```json
// ~/.agent-tools-server/config.json 中添加 auth 段
{
  "auth": {
    "provider": "oauth2",
    "clientId": "your-client-id",
    "clientSecret": "your-client-secret",
    "authorizeHost": "https://idaas.company.com",
    "userinfoUrl": "https://idaas.company.com/oauth/userinfo",
    "adminUsers": ["admin-username"],
    "sessionSecret": "at-least-32-chars-random-string"
  }
}
```

启用后：
- 数据上报（`/api/v1/events/batch`）、健康检查、客户端下载仍保持公开
- Dashboard 和统计 API 需要登录后才能访问
- 管理员可在 Dashboard「用户管理」Tab 中添加/删除允许访问的用户
- 支持通用 OAuth2/OIDC（`"provider": "oauth2"`）和 GitHub（`"provider": "github"`）两种认证方式

详见 `doc/10-auth-design.md`。

---

## 支持的 Agent

| Agent | 优先级 | 状态 | Hook 机制 |
|-------|--------|------|-----------|
| Claude Code | P0 | 已支持 | `~/.claude/settings.json` hooks |
| CodeBuddy | P0 | 已支持 | `~/.codebuddy/settings.json` hooks |
| OpenCode | P1 | 规划中 | hooks 机制待调研 |
| GitHub Copilot CLI | P1 | 规划中 | wrapper 脚本 |
| Cursor | P2 | 规划中 | 插件/日志解析 |
| Windsurf | P2 | 规划中 | 插件/日志解析 |

## 架构概览

```
┌─────────────────────────────────────┐
│           开发者本地机器               │
│                                     │
│  ┌──────────┐    ┌────────────────┐ │
│  │  Claude  │    │   CodeBuddy    │ │
│  │   Code   │    │                │ │
│  └────┬─────┘    └───────┬────────┘ │
│       │  hooks            │  hooks  │
│       └──────────┬────────┘         │
│                  ▼                   │
│         ┌─────────────────┐         │
│         │ universal-hook  │         │
│         │    .js          │         │
│         └────────┬────────┘         │
│                  │ normalize         │
│                  ▼                   │
│         ┌─────────────────┐         │
│         │  local.db       │         │
│         │  (SQLite)       │         │
│         └────────┬────────┘         │
│                  │ batch upload      │
│                  │ (every 5min)      │
└──────────────────┼──────────────────┘
                   │
                   ▼ HTTP POST /api/v1/events/batch
┌─────────────────────────────────────┐
│           中央统计服务器               │
│                                     │
│  ┌──────────────────────────────┐   │
│  │  agent-tools-server          │   │
│  │  ┌────────┐  ┌────────────┐  │   │
│  │  │  REST  │  │  SQLite /  │  │   │
│  │  │  API   │  │  MySQL /   │  │   │
│  │  │        │  │  Postgres  │  │   │
│  │  └────────┘  └────────────┘  │   │
│  │  ┌────────────────────────┐  │   │
│  │  │   Web Dashboard        │  │   │
│  │  │   (ECharts, port 3000) │  │   │
│  │  └────────────────────────┘  │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

数据流：
1. Agent 执行工具调用时触发 hook，将事件数据通过 stdin 传给 `universal-hook.js`
2. Hook 脚本将事件标准化后写入本地 SQLite 缓存（`~/.agent-tools/data/local.db`）
3. 每 5 分钟（或积累 100 条事件）批量上报到中央服务器
4. 服务器入库后即可在 Dashboard 查询

## 统计指标

### Token 指标

| 指标 | 说明 |
|------|------|
| `input_tokens` | 输入 Token 总数 |
| `output_tokens` | 输出 Token 总数 |
| `total_tokens` | 输入 + 输出合计 |

### 活动指标

| 指标 | 说明 |
|------|------|
| `session_count` | 会话数（Session 数） |
| `turn_count` | 对话轮次（UserPromptSubmit 事件数） |
| `file_count` | 累计操作文件数 |
| `lines_changed` | 累计代码变更行数 |

### 工具指标

| 指标 | 说明 |
|------|------|
| `tool_use_count` | 工具使用总次数 |
| `unique_tools` | 使用过的不同工具数量 |
| `skill_use_count` | Skill 使用总次数 |
| `unique_skills` | 使用过的不同 Skill 数量 |

## 时间维度

### 预设时间段

| 参数值 | 说明 |
|--------|------|
| `day` | 今天（自然日） |
| `week` | 本周（周一至今） |
| `month` | 本月（1号至今） |
| `all` | 全部历史数据 |

### 自定义日期段

使用 `start` 和 `end` 参数指定任意日期范围：

```
GET /api/v1/stats/summary?start=2025-01-01&end=2025-03-31
```

### 过滤和下钻

- 按模型过滤：`?model=claude-opus-4`
- 按用户过滤：`?user=leon`
- 按机器名过滤：`?hostname=dev-machine`
- 按 Agent 过滤：`?agent=claude-code`
- 排名下钻：`?drilldown=hostname` / `?drilldown=agent` / `?drilldown=model`

## 发布状态

### 客户端

```bash
npm install -g agent-tools
```

[![npm version](https://img.shields.io/npm/v/agent-tools)](https://www.npmjs.com/package/agent-tools)

### 服务端

```bash
npm install -g agent-tools-server
```

[![npm version](https://img.shields.io/npm/v/agent-tools-server)](https://www.npmjs.com/package/agent-tools-server)

## 开发文档

详细设计文档位于 `doc/` 目录：

| 文件 | 内容 |
|------|------|
| `doc/01-agent-research.md` | 各主流 AI 编程 Agent 的 hook 机制调研，分析可注入点 |
| `doc/02-architecture.md` | 整体系统架构设计，组件划分和交互方式 |
| `doc/03-database-design.md` | 数据库表结构设计（events、sessions、daily_stats 等） |
| `doc/04-metrics-design.md` | 统计指标定义、计算方式和查询 SQL |
| `doc/05-client-detail.md` | 客户端详细设计：hook 注入、本地存储、上报机制 |
| `doc/06-server-detail.md` | 服务端详细设计：API、数据处理、安全设计 |
| `doc/07-implementation-plan.md` | 分阶段实施计划（Phase 1-5）和任务拆解 |
| `doc/08-development-guide.md` | AI 辅助开发指南：代码库导航、扩展新 Agent 等 |
| `doc/09-version-update-design.md` | 版本管理与自动更新设计：CLI 自更新、Server 分发、反向代理支持 |
| `doc/10-auth-design.md` | 认证与用户管理设计：可插拔 OAuth2/OIDC、用户白名单、管理员权限 |
| `doc/11-integration-guide.md` | 接入指导：登录认证配置 + 外部数据同步 API |

## License

MIT
