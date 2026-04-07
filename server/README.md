# agent-tools-server

`agent-tools-server` 是 agent-tools 的中央统计服务器，负责接收所有开发者机器上传的事件数据，提供 REST API 查询接口和 Web Dashboard 可视化界面。

## Introduction

- **数据接收**：提供 `POST /api/v1/events/batch` 接口，接受客户端批量上报的事件
- **去重入库**：基于 `event_id` 去重，保证幂等性（客户端重试不会产生重复数据）
- **多维查询**：支持按时间、用户、机器名、Agent、模型等多个维度聚合和过滤
- **Web Dashboard**：内置基于 ECharts 的单页应用，无需部署前端
- **多数据库支持**：SQLite（零配置）、MySQL 8.0+、PostgreSQL 13+

---

## Installation

```bash
npm install -g agent-tools-server
agent-tools-server
# 首次运行自动启动交互式初始化向导
```

---

## First-Run Wizard

首次运行时，如果 `~/.agent-tools-server/config.json` 不存在，服务器会自动启动交互式初始化向导：

```
agent-tools-server v1.0.0

No configuration found. Starting setup wizard...

? Select database type:
  > SQLite (recommended, zero-config)
    MySQL
    PostgreSQL

[SQLite selected]
? Database file path: (~/.agent-tools-server/data/server.db)

Testing connection... OK
Running migrations... OK (8 tables created)

? Server port: (3000)

Configuration saved to ~/.agent-tools-server/config.json
Starting server on http://localhost:3000
```

向导步骤：

1. **选择数据库类型**：SQLite / MySQL / PostgreSQL
2. **配置连接参数**：
   - SQLite：数据库文件路径
   - MySQL/PostgreSQL：host、port、database、user、password
3. **测试连接**：验证数据库可达且有权限
4. **自动建表**：运行 Knex migrations 创建所有表结构
5. **设置端口**：监听端口（默认 3000）
6. **保存配置并启动**：写入 `~/.agent-tools-server/config.json` 后启动 HTTP 服务

---

## Non-Interactive Mode

### CLI 参数

```bash
# SQLite（指定数据库文件路径）
agent-tools-server --port 3000 --db-path ~/.agent-tools-server/data/server.db

# 查看所有参数
agent-tools-server --help
```

### 环境变量

```bash
# SQLite
DB_CLIENT=better-sqlite3 \
DB_PATH=~/.agent-tools-server/data/server.db \
SERVER_PORT=3000 \
agent-tools-server

# MySQL
DB_CLIENT=mysql2 \
DB_HOST=localhost \
DB_PORT=3306 \
DB_NAME=agent_tools \
DB_USER=root \
DB_PASSWORD=secret \
SERVER_PORT=3000 \
agent-tools-server

# PostgreSQL
DB_CLIENT=pg \
DB_HOST=localhost \
DB_PORT=5432 \
DB_NAME=agent_tools \
DB_USER=postgres \
DB_PASSWORD=secret \
SERVER_PORT=3000 \
agent-tools-server
```

所有环境变量说明：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SERVER_PORT` | HTTP 监听端口 | `3000` |
| `SERVER_HOST` | HTTP 监听地址 | `0.0.0.0` |
| `DB_CLIENT` | 数据库驱动：`better-sqlite3` / `mysql2` / `pg` | `better-sqlite3` |
| `DB_PATH` | SQLite 文件路径（仅 SQLite） | `~/.agent-tools-server/data/server.db` |
| `DB_HOST` | 数据库主机（MySQL/PostgreSQL） | `localhost` |
| `DB_PORT` | 数据库端口（MySQL/PostgreSQL） | `3306` / `5432` |
| `DB_NAME` | 数据库名称（MySQL/PostgreSQL） | `agent_tools` |
| `DB_USER` | 数据库用户名（MySQL/PostgreSQL） | — |
| `DB_PASSWORD` | 数据库密码（MySQL/PostgreSQL） | — |
| `RETENTION_EVENTS_DAYS` | events 表保留天数 | `90` |
| `RETENTION_SESSIONS_DAYS` | sessions 表保留天数 | `180` |

---

## Database Support

| 数据库 | 版本要求 | 适用场景 |
|--------|----------|----------|
| SQLite | 任意版本（通过 `better-sqlite3`） | 个人使用、小团队（<20人）、快速上手 |
| MySQL | 8.0+ | 中大型团队、已有 MySQL 基础设施 |
| PostgreSQL | 13+ | 中大型团队、已有 PostgreSQL 基础设施 |

> **注意**：MySQL/PostgreSQL 需要提前手动创建数据库（`CREATE DATABASE agent_tools`），表结构由向导/迁移脚本自动创建。

---

## Dashboard

访问 `http://localhost:3000` 打开 Web Dashboard，共四个 Tab：

### Overview（概览）

- 当前时间段的汇总卡片：总 Token 数、会话数、对话轮次、活跃用户数
- Token 趋势折线图（按天）
- 输入 Token vs 输出 Token 对比
- 工具使用频率排行（Top 10 工具）

### Ranking（排名）

- 可按用户名 / 机器名 / Agent 切换排名维度
- 每行显示：排名、标识名、Token 总数、会话数、活跃天数
- 支持点击某行下钻到该用户/机器的详细数据

### Drilldown（下钻）

- 选定用户/机器后，展示其在各 Agent、各模型上的使用分布
- 饼图：各 Agent 占比（按 Token）
- 柱状图：按日期的 Token 消耗
- 列表：使用的所有工具及次数

### Tools（工具分析）

- 所有工具调用的汇总统计
- 调用次数、平均耗时、成功率
- 支持按 Agent、模型、用户过滤

---

## REST API

所有 API 均以 `Content-Type: application/json` 返回，失败时包含 `{ "error": "message" }` 字段。

### 接口清单

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/health` | 健康检查 |
| `POST` | `/api/v1/events/batch` | 批量上报事件 |
| `GET` | `/api/v1/stats/summary` | 统计摘要 |
| `GET` | `/api/v1/stats/ranking` | 排名数据 |
| `GET` | `/api/v1/stats/drilldown` | 下钻数据 |
| `GET` | `/api/v1/stats/trend` | 趋势数据（按天） |
| `GET` | `/api/v1/stats/models` | 模型使用分布 |
| `GET` | `/api/v1/stats/event-types` | 事件类型分布 |
| `GET` | `/api/v1/stats/tool-usage` | 工具使用详情 |

---

### `GET /api/v1/health`

健康检查接口，客户端 `init` 时用于测试连接。

**Response 200:**

```json
{
  "status": "ok",
  "version": "1.0.0",
  "db": "connected",
  "uptime": 3600
}
```

---

### `POST /api/v1/events/batch`

客户端批量上报事件。

**Request Body:**

```json
{
  "events": [
    {
      "event_id": "uuid-v4",
      "event_type": "PostToolUse",
      "session_id": "session-uuid",
      "agent": "claude-code",
      "model": "claude-opus-4",
      "hostname": "dev-machine",
      "username": "leon",
      "tool_name": "Read",
      "input_tokens": 1500,
      "output_tokens": 200,
      "duration_ms": 342,
      "timestamp": "2025-04-07T10:23:45.000Z"
    }
  ]
}
```

**Response 200:**

```json
{
  "received": 15,
  "inserted": 14,
  "duplicates": 1
}
```

---

### `GET /api/v1/stats/summary`

获取指定时间段、过滤条件下的统计摘要。

**Response 200:**

```json
{
  "period": "week",
  "date_range": { "start": "2025-03-31", "end": "2025-04-07" },
  "total_input_tokens": 2450000,
  "total_output_tokens": 380000,
  "total_tokens": 2830000,
  "session_count": 142,
  "turn_count": 867,
  "active_users": 8,
  "tool_use_count": 4231,
  "unique_tools": 12
}
```

---

### `GET /api/v1/stats/ranking`

获取排名数据，可按用户/机器名/Agent/模型排序。

**Response 200:**

```json
{
  "drilldown": "username",
  "data": [
    {
      "label": "leon",
      "total_tokens": 980000,
      "input_tokens": 850000,
      "output_tokens": 130000,
      "session_count": 45,
      "turn_count": 312,
      "active_days": 6
    }
  ]
}
```

---

### `GET /api/v1/stats/drilldown`

获取特定用户/机器的详细统计。

**Response 200:**

```json
{
  "subject": "leon",
  "by_agent": [
    { "agent": "claude-code", "total_tokens": 750000, "session_count": 38 },
    { "agent": "codebuddy", "total_tokens": 230000, "session_count": 7 }
  ],
  "by_model": [
    { "model": "claude-opus-4", "total_tokens": 600000 },
    { "model": "claude-sonnet-4", "total_tokens": 380000 }
  ],
  "top_tools": [
    { "tool_name": "Read", "count": 423 },
    { "tool_name": "Edit", "count": 218 }
  ]
}
```

---

### `GET /api/v1/stats/trend`

获取按天聚合的趋势数据。

**Response 200:**

```json
{
  "data": [
    { "date": "2025-04-01", "total_tokens": 320000, "session_count": 18 },
    { "date": "2025-04-02", "total_tokens": 415000, "session_count": 24 }
  ]
}
```

---

### `GET /api/v1/stats/models`

获取各模型的使用分布。

**Response 200:**

```json
{
  "data": [
    { "model": "claude-opus-4", "total_tokens": 1800000, "percentage": 63.6 },
    { "model": "claude-sonnet-4", "total_tokens": 1030000, "percentage": 36.4 }
  ]
}
```

---

### `GET /api/v1/stats/event-types`

获取各事件类型的数量统计。

**Response 200:**

```json
{
  "data": [
    { "event_type": "PostToolUse", "count": 4231 },
    { "event_type": "UserPromptSubmit", "count": 867 },
    { "event_type": "SessionStart", "count": 142 }
  ]
}
```

---

### `GET /api/v1/stats/tool-usage`

获取工具使用详情统计。

**Response 200:**

```json
{
  "data": [
    { "tool_name": "Read", "count": 1823, "avg_duration_ms": 145, "agents": ["claude-code", "codebuddy"] },
    { "tool_name": "Edit", "count": 942, "avg_duration_ms": 230 },
    { "tool_name": "Bash", "count": 687, "avg_duration_ms": 1840 }
  ]
}
```

---

## Query Parameters

所有 `GET /api/v1/stats/*` 接口均支持以下查询参数：

| 参数 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `period` | string | 预设时间段：`day` / `week` / `month` / `all` | `?period=week` |
| `date` | string | `period=day` 时指定具体日期，格式 `YYYY-MM-DD` | `?period=day&date=2025-04-01` |
| `start` | string | 自定义范围起始日期，格式 `YYYY-MM-DD` | `?start=2025-01-01` |
| `end` | string | 自定义范围截止日期，格式 `YYYY-MM-DD` | `?end=2025-03-31` |
| `model` | string | 按模型过滤 | `?model=claude-opus-4` |
| `user` | string | 按用户名过滤 | `?user=leon` |
| `hostname` | string | 按机器名过滤 | `?hostname=dev-01` |
| `agent` | string | 按 Agent 过滤 | `?agent=claude-code` |
| `drilldown` | string | 排名/下钻维度：`username` / `hostname` / `agent` / `model` | `?drilldown=hostname` |
| `metric` | string | 排序指标：`total_tokens` / `session_count` / `turn_count` | `?metric=session_count` |
| `limit` | number | 返回条数上限（排名接口） | `?limit=20` |

参数优先级：`start`/`end` > `period`/`date`。

---

## Server Config File

配置文件位于 `~/.agent-tools-server/config.json`，可手动编辑。

### SQLite（默认）

```json
{
  "server": {
    "port": 3000,
    "host": "0.0.0.0"
  },
  "database": {
    "client": "better-sqlite3",
    "connection": {
      "filename": "/Users/leon/.agent-tools-server/data/server.db"
    },
    "useNullAsDefault": true
  },
  "retention": {
    "eventsDays": 90,
    "sessionsDays": 180
  }
}
```

### MySQL

```json
{
  "server": {
    "port": 3000,
    "host": "0.0.0.0"
  },
  "database": {
    "client": "mysql2",
    "connection": {
      "host": "localhost",
      "port": 3306,
      "database": "agent_tools",
      "user": "root",
      "password": "secret"
    },
    "pool": { "min": 2, "max": 10 }
  },
  "retention": {
    "eventsDays": 90,
    "sessionsDays": 180
  }
}
```

### PostgreSQL

```json
{
  "server": {
    "port": 3000,
    "host": "0.0.0.0"
  },
  "database": {
    "client": "pg",
    "connection": {
      "host": "localhost",
      "port": 5432,
      "database": "agent_tools",
      "user": "postgres",
      "password": "secret"
    },
    "pool": { "min": 2, "max": 10 }
  },
  "retention": {
    "eventsDays": 90,
    "sessionsDays": 180
  }
}
```

---

## Data Retention

| 数据表 | 保留策略 | 说明 |
|--------|----------|------|
| `events` | 90 天 | 原始事件记录，定期清理旧数据 |
| `sessions` | 180 天 | 会话汇总记录，保留较长时间用于趋势分析 |
| `daily_stats` | 永久保留 | 按天聚合的统计快照，空间占用极小 |

清理任务在服务器启动时和每天凌晨 2:00 自动执行（基于 `node-cron`）。

如需修改保留天数，编辑 `~/.agent-tools-server/config.json` 中的 `retention` 字段后重启服务器。

---

## Development

```bash
git clone https://github.com/your-org/agent-tools
cd agent-tools/server
pnpm install
node bin/server.js --port 3000
```

详细开发指南见 [`../doc/08-development-guide.md`](../doc/08-development-guide.md)。
