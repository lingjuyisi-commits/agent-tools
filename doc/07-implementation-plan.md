# 实施计划

## 阶段划分

### Phase 1：核心骨架（MVP）

**目标：** 跑通 Claude Code + CodeBuddy 的完整数据链路，服务端支持SQLite快速启动

| 任务 | 说明 |
|------|------|
| **客户端** | |
| CLI骨架 | `agent-tools init / setup / stats / sync` 命令框架 |
| init命令 | 交互式指定服务器地址，创建 `~/.agent-tools/` 目录结构 |
| Claude Code检测器 | 检测安装、读写用户级 `~/.claude/settings.json` |
| CodeBuddy检测器 | 检测安装、读写用户级 `~/.codebuddy/settings.json` |
| setup命令 | 向用户级settings.json注入hooks |
| 通用Hook脚本 | universal-hook.js + Claude Code/CodeBuddy适配器 |
| 事件标准化 | NormalizedEvent格式定义与转换 |
| 本地SQLite存储 | `~/.agent-tools/data/local.db` 写入、查询 |
| 上报模块 | 批量POST到服务器（无鉴权） |
| postinstall脚本 | 检测Agent + 提示init |
| **服务端** | |
| 首次启动向导 | 交互式选择数据库(SQLite/MySQL/PG)、配置端口 |
| Fastify骨架 | 含health检查、CORS |
| Knex数据库抽象 | 支持SQLite/MySQL/PostgreSQL |
| 数据库迁移 | 4张表的Knex迁移脚本 |
| 数据上报API | POST /api/v1/events/batch (无鉴权) |
| 基础统计API | GET /api/v1/stats/summary (按日) |

### Phase 2：完整统计与排名

**目标：** 实现所有统计维度和排名功能

| 任务 | 说明 |
|------|------|
| 时间维度查询 | 日/周/月/自定义/全部 |
| 模型过滤 | 按模型或不区分模型 |
| 排名API | 多指标排名 |
| 下钻API | 用户→机器→Agent→模型→会话 |
| 趋势API | 时间序列数据 |
| 每日聚合任务 | daily_stats + tool_usage_detail |
| 会话汇总任务 | sessions表聚合 |
| 数据清理任务 | 过期数据删除 |
| 客户端stats命令 | 本地离线统计展示 |

### Phase 3：可视化Dashboard

**目标：** Web仪表板和图表

| 任务 | 说明 |
|------|------|
| Dashboard前端 | Vue3 SPA |
| 概览页 | KPI + 趋势 + 分布 |
| 排名页 | 交互式排名 + 下钻 |
| 用户详情页 | 机器分布 + 会话列表 |
| Tool/Skill分析页 | 使用频率排名 |
| 图表SSR | node-canvas渲染PNG/SVG |
| 图表API | 供CLI和外部使用 |

### Phase 4：MCP Server与增强

**目标：** MCP交互查询 + 更多Agent支持

| 任务 | 说明 |
|------|------|
| MCP Server | 暴露stats查询工具 |
| MCP自动配置 | setup时写入Claude Code/CodeBuddy的MCP配置 |
| 更多Agent适配器 | OpenCode、Copilot CLI、Cursor等 (P1) |
| Windows兼容性测试 | PowerShell hook脚本 |
| 性能优化 | 批量写入、查询缓存 |

## 技术依赖

### 客户端 (agent-tools)

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "commander": "^12.0.0",
    "inquirer": "^10.0.0",
    "chalk": "^5.0.0",
    "uuid": "^10.0.0"
  }
}
```

### 服务端 (agent-tools-server)

```json
{
  "dependencies": {
    "fastify": "^5.0.0",
    "@fastify/static": "^8.0.0",
    "@fastify/cors": "^10.0.0",
    "knex": "^3.0.0",
    "better-sqlite3": "^11.0.0",
    "mysql2": "^3.0.0",
    "pg": "^8.0.0",
    "inquirer": "^10.0.0",
    "echarts": "^5.0.0",
    "canvas": "^3.0.0",
    "node-cron": "^3.0.0",
    "pino": "^9.0.0"
  }
}
```

> 注：mysql2和pg作为可选依赖(optionalDependencies)，SQLite为默认内置。
> 用户选择MySQL或PG时，向导提示安装对应驱动包。

### MCP Server (Phase 4)

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.0.0"
  }
}
```
