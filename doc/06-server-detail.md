# 服务端详细设计

## 1. 技术栈

| 组件 | 选型 | 说明 |
|------|------|------|
| 运行时 | Node.js 18+ | 与客户端统一技术栈 |
| Web框架 | Fastify | 高性能，原生JSON schema校验 |
| 数据库 | **SQLite / MySQL / PostgreSQL** | 首次向导中选择 |
| 数据库抽象 | Knex.js | 统一query builder + 迁移，屏蔽方言差异 |
| 图表 | ECharts + node-canvas (SSR) | 服务端渲染为PNG/SVG |
| 前端 | 静态SPA (Vue3 + ECharts) | 嵌入到Fastify静态资源 |
| 定时任务 | node-cron | 每日聚合、数据清理 |
| 日志 | pino (Fastify内置) | 结构化JSON日志 |

## 2. 首次启动向导

服务器首次执行时，检测是否存在配置文件，若不存在则进入交互式初始化向导：

### 2.1 向导流程

```
agent-tools-server
  │
  ├─ 检测 ~/.agent-tools-server/config.json 是否存在
  │
  ├─ [不存在] 进入初始化向导
  │   │
  │   ├─ ? Select database type: (Use arrow keys)
  │   │   > SQLite (recommended for development/small teams)
  │   │     MySQL
  │   │     PostgreSQL
  │   │
  │   ├─ [SQLite]
  │   │   ? Database file path: (~/.agent-tools-server/data/server.db)
  │   │
  │   ├─ [MySQL]
  │   │   ? Host: (localhost)
  │   │   ? Port: (3306)
  │   │   ? Database name: (agent_tools)
  │   │   ? Username: (root)
  │   │   ? Password:
  │   │
  │   ├─ [PostgreSQL]
  │   │   ? Host: (localhost)
  │   │   ? Port: (5432)
  │   │   ? Database name: (agent_tools)
  │   │   ? Username: (postgres)
  │   │   ? Password:
  │   │
  │   ├─ ? Server port: (3000)
  │   │
  │   ├─ 测试数据库连接...
  │   │   ├─ 成功: ✓ Database connected
  │   │   └─ 失败: ✗ Connection failed, retry? (Y/n)
  │   │
  │   ├─ 运行数据库迁移 (创建表结构)
  │   │   └─ ✓ Migrations complete (4 tables created)
  │   │
  │   └─ 保存配置到 ~/.agent-tools-server/config.json
  │       └─ ✓ Configuration saved. Starting server...
  │
  └─ [存在] 直接加载配置启动
```

### 2.2 配置文件

```json
// ~/.agent-tools-server/config.json
{
  "server": {
    "port": 3000,
    "host": "0.0.0.0"
  },
  "database": {
    "client": "sqlite3",          // sqlite3 | mysql2 | pg
    "connection": {
      "filename": "~/.agent-tools-server/data/server.db"
    }
    // MySQL示例:
    // "client": "mysql2",
    // "connection": {
    //   "host": "localhost",
    //   "port": 3306,
    //   "database": "agent_tools",
    //   "user": "root",
    //   "password": "xxx"
    // }
    // PostgreSQL示例:
    // "client": "pg",
    // "connection": {
    //   "host": "localhost",
    //   "port": 5432,
    //   "database": "agent_tools",
    //   "user": "postgres",
    //   "password": "xxx"
    // }
  },
  "retention": {
    "eventsDays": 90,
    "sessionsDays": 180
  },
  "initialized": true,
  "initTime": "2026-04-07T10:00:00Z"
}
```

### 2.3 也支持非交互模式

```bash
# 环境变量方式（适合Docker/CI部署）
DB_CLIENT=mysql2 \
DB_HOST=localhost \
DB_PORT=3306 \
DB_NAME=agent_tools \
DB_USER=root \
DB_PASSWORD=xxx \
SERVER_PORT=3000 \
agent-tools-server

# 或指定配置文件
agent-tools-server --config /path/to/config.json
```

## 3. 服务端包结构

```
agent-tools-server/
├── package.json
├── bin/
│   └── server.js                  # 入口 (#!/usr/bin/env node)
├── migrations/                    # Knex数据库迁移 (兼容SQLite/MySQL/PG)
│   ├── 001_create_events.js
│   ├── 002_create_sessions.js
│   ├── 003_create_daily_stats.js
│   └── 004_create_tool_usage.js
├── src/
│   ├── config.js                  # 配置加载与管理
│   ├── init-wizard.js             # 首次启动交互式向导
│   ���── db.js                      # Knex实例化(根据配置选择数据库)
│   ├── app.js                     # Fastify app初始化
│   ├── routes/
│   │   ├── health.js              # GET /api/v1/health
│   │   ├── events.js              # POST /api/v1/events/batch (无鉴权)
│   │   ├── stats.js               # GET /api/v1/stats/*
│   │   └── charts.js              # GET /api/v1/charts/*
│   ├── services/
│   │   ├── event-service.js       # 事件写入与去重
│   │   ├── stats-service.js       # 统计查询
│   │   ├── aggregation-service.js # 数据聚合
│   │   └── chart-service.js       # 图表生成
│   ├── jobs/
│   │   ├── daily-aggregation.js   # ���日聚合任务
│   │   ├── session-summarize.js   # 会话汇总任务
│   │   └── data-cleanup.js        # 过期数据清理
│   └── dashboard/                 # 前端静态文件
│       ├── index.html
│       ├── app.js
│       └── style.css
└── .env.example
```

## 4. 数据库初始化

### 4.1 Knex实例化

```javascript
// src/db.js
const knex = require('knex');
const config = require('./config');

function createDb() {
  const dbConfig = config.get('database');
  
  const knexConfig = {
    client: dbConfig.client,
    connection: dbConfig.connection,
    useNullAsDefault: true,      // SQLite需要
  };
  
  // SQLite特殊处理
  if (dbConfig.client === 'sqlite3') {
    knexConfig.connection = {
      filename: expandPath(dbConfig.connection.filename),
    };
  }
  
  // MySQL/PG连接池
  if (dbConfig.client !== 'sqlite3') {
    knexConfig.pool = { min: 2, max: 10 };
  }
  
  return knex(knexConfig);
}

module.exports = { createDb };
```

### 4.2 迁移脚本示例（兼容三种数据库）

```javascript
// migrations/001_create_events.js
exports.up = function(knex) {
  return knex.schema.createTable('events', (table) => {
    table.increments('id');
    table.string('event_id', 64).notNullable().unique();
    
    table.string('agent', 32).notNullable();
    table.string('agent_version', 32).nullable();
    
    table.string('username', 128).notNullable();
    table.string('hostname', 256).notNullable();
    table.string('platform', 16).notNullable();
    
    table.string('session_id', 128).notNullable();
    table.integer('conversation_turn').nullable();
    
    table.string('event_type', 64).notNullable();
    table.string('event_time', 32).notNullable();    // ISO 8601字符串(SQLite兼容)
    table.string('received_time', 32).notNullable();
    
    table.string('model', 64).nullable();
    
    table.integer('token_input').defaultTo(0);
    table.integer('token_output').defaultTo(0);
    table.integer('token_cache_read').defaultTo(0);
    table.integer('token_cache_write').defaultTo(0);
    
    table.string('tool_name', 128).nullable();
    table.string('skill_name', 128).nullable();
    
    table.integer('files_created').defaultTo(0);
    table.integer('files_modified').defaultTo(0);
    table.integer('lines_added').defaultTo(0);
    table.integer('lines_removed').defaultTo(0);
    
    table.text('extra').nullable();  // JSON字符串
    
    // 索引
    table.index('event_time');
    table.index(['username', 'event_time']);
    table.index('session_id');
    table.index(['agent', 'event_time']);
    table.index(['hostname', 'event_time']);
    table.index(['model', 'event_time']);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('events');
};
```

## 5. API详细设计

### 5.1 健康检查

```
GET /api/v1/health

Response 200:
{
  "status": "ok",
  "version": "1.0.0",
  "database": "sqlite3",
  "uptime": 3600
}
```

### 5.2 数据上报（无鉴权）

```
POST /api/v1/events/batch
Content-Type: application/json

Request:
{
  "events": [
    {
      "event_id": "uuid-v4",
      "agent": "claude-code",
      "agent_version": "1.5.0",
      "username": "leon",
      "hostname": "leon-mbp",
      "platform": "darwin",
      "session_id": "sess-xxx",
      "conversation_turn": 5,
      "event_type": "tool_use",
      "event_time": "2026-04-07T10:30:00.123Z",
      "model": "claude-opus-4",
      "token_input": 1500,
      "token_output": 800,
      "tool_name": "Read",
      "files_modified": 0,
      "lines_added": 0,
      "lines_removed": 0
    }
  ]
}

Response 200:
{
  "accepted": 50,
  "duplicates": 2,
  "errors": 0
}

Response 400: { "error": "validation_error", "details": [...] }
```

### 5.3 汇��统计

```
GET /api/v1/stats/summary?period=week&date=2026-04-07&model=claude-opus-4

Response 200:
{
  "period": { "type": "week", "start": "2026-03-31", "end": "2026-04-06" },
  "filters": { "model": "claude-opus-4" },
  "summary": {
    "total_users": 15,
    "total_sessions": 234,
    "total_turns": 4567,
    "token_input": 12500000,
    "token_output": 3400000,
    "token_total": 15900000,
    "files_created": 89,
    "files_modified": 456,
    "lines_added": 12340,
    "lines_removed": 5670,
    "tool_use_count": 3456,
    "tool_distinct_count": 18,
    "skill_use_count": 234,
    "skill_distinct_count": 12
  }
}
```

### 5.4 排名查询

```
GET /api/v1/stats/ranking?period=week&date=2026-04-07&metric=token_total&limit=10

Response 200:
{
  "period": { ... },
  "metric": "token_total",
  "rankings": [
    {
      "rank": 1,
      "username": "leon",
      "token_total": 1250000,
      "token_input": 980000,
      "token_output": 270000,
      "session_count": 45,
      "conversation_turns": 320
    },
    ...
  ]
}
```

### 5.5 下钻查询

```
GET /api/v1/stats/drilldown?period=week&date=2026-04-07&username=leon&drilldown=hostname

Response 200:
{
  "period": { ... },
  "drilldown_by": "hostname",
  "parent": { "username": "leon" },
  "items": [
    {
      "hostname": "leon-mbp",
      "token_total": 800000,
      "session_count": 30,
      "agent_breakdown": {
        "claude-code": { "token_total": 600000, "session_count": 22 },
        "codebuddy": { "token_total": 200000, "session_count": 8 }
      }
    },
    {
      "hostname": "leon-linux",
      "token_total": 450000,
      "session_count": 15
    }
  ]
}
```

### 5.6 趋势数据

```
GET /api/v1/stats/trend?period=month&date=2026-04&metric=token_total&granularity=day

Response 200:
{
  "period": { ... },
  "metric": "token_total",
  "granularity": "day",
  "data": [
    { "date": "2026-04-01", "value": 450000 },
    { "date": "2026-04-02", "value": 520000 },
    ...
  ]
}
```

### 5.7 图表API

```
GET /api/v1/charts/token-trend?period=month&date=2026-04&format=png
GET /api/v1/charts/user-ranking?period=week&metric=token_total&format=svg
GET /api/v1/charts/agent-distribution?period=month&format=png
GET /api/v1/charts/tool-ranking?period=week&limit=20&format=png
```

## 6. 聚合任务

### 6.1 每日聚合（每天凌晨2:00��

```javascript
// jobs/daily-aggregation.js
async function aggregateDaily(date) {
  const db = getDb();
  
  // 使用Knex语法，兼容所有数据库
  // 1. 查询当日聚合数据
  const rows = await db('events')
    .select('username', 'hostname', 'agent')
    .select(db.raw("COALESCE(model, '__unknown__') as model"))
    .count('distinct session_id as session_count')
    .max('conversation_turn as conversation_turns')
    .sum('token_input as token_input')
    .sum('token_output as token_output')
    .sum(db.raw('token_input + token_output as token_total'))
    .sum(db.raw("CASE WHEN tool_name IS NOT NULL THEN 1 ELSE 0 END as tool_use_count"))
    .countDistinct('tool_name as tool_distinct_count')
    .sum(db.raw("CASE WHEN skill_name IS NOT NULL THEN 1 ELSE 0 END as skill_use_count"))
    .countDistinct('skill_name as skill_distinct_count')
    .sum('files_created as files_created')
    .sum('files_modified as files_modified')
    .sum('lines_added as lines_added')
    .sum('lines_removed as lines_removed')
    .where(db.raw("substr(event_time, 1, 10) = ?", [date]))
    .groupBy('username', 'hostname', 'agent', db.raw("COALESCE(model, '__unknown__')"));
  
  // 2. Upsert到daily_stats (使用onConflict兼容所有数据库)
  for (const row of rows) {
    await db('daily_stats')
      .insert({ stat_date: date, ...row })
      .onConflict(['stat_date', 'username', 'hostname', 'agent', 'model'])
      .merge();
  }
  
  // 3. 生成 __all__ 汇总行
  // ...
}
```

### 6.2 会话汇���（每小时）

```javascript
async function summarizeSessions() {
  // 找出有session_end但尚未���总的会话
  // 或者超过2小时无新事件的会话（视为结束）
  // 聚合events表写入sessions表
}
```

### 6.3 数据清理（每天凌晨3:00）

```javascript
async function cleanup() {
  const db = getDb();
  const retentionDays = config.get('retention.eventsDays', 90);
  
  // 使用ISO字符串比较，兼容所有数据库
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
  
  await db('events').where('event_time', '<', cutoff).del();
  
  const cutoffDate = cutoff.substring(0, 10);
  await db('tool_usage_detail').where('stat_date', '<', cutoffDate).del();
}
```

## 7. Dashboard设计

### 7.1 页面结构

```
Dashboard (SPA)
├── 概览页
��   ├── 时间段选择器 (日/周/月/自定义/全部)
│   ├── 模型过滤器 (下拉多选)
│   ├── KPI卡片 (用户数/会话数/Token总量/文件变更)
│   ├── Token消耗趋势图
│   └── Agent分布饼图
├── 排名页
│   ├── 排名指标选择器
│   ├── 用户排名柱状图
│   └── 排名明细表格 (可展开下钻)
├── 用户详情页 (点击排名条目进入)
│   ├── 用户KPI卡片
│   ├── 机器分布
│   ├── Agent使用趋势
│   ├── Tool/Skill使用排名
│   └── 会话列表
└── Tool/Skill分析页
    ├── Tool使用频率排名
    ├── Skill使用频率排名
    └── 使用趋势
```

### 7.2 图表服务端渲染

```javascript
const { createCanvas } = require('canvas');
const echarts = require('echarts');

function renderChart(option, width = 800, height = 400) {
  const canvas = createCanvas(width, height);
  const chart = echarts.init(canvas);
  chart.setOption(option);
  return canvas.toBuffer('image/png');
}
```

## 8. 数据隐私

- 不采集代码内容，仅采集元数据（工具名、文件数、行数等）
- 不采集用户输入的prompt内容
- 上报接口无鉴权，适合内网部署场景
- 提供数据导出和删除API（可按用户清除数据）
