# 数据库设计

## 0. 多数据库支持策略

通过 **Knex.js** 作为数据库抽象层，统一支持三种数据库：

| 数据库 | 适用场景 | npm驱动包 |
|--------|---------|----------|
| **SQLite** | 本地开发调试、单人/小团队轻量部署 | `better-sqlite3` |
| **MySQL** | 生产环境、中大团队 | `mysql2` |
| **PostgreSQL** | 生产环境、偏好PG的团队 | `pg` |

**Knex.js兼容性要点：**
- DDL通过Knex迁移脚本编写，自动适配各数据库方言
- 避免使用数据库特有语法（如MySQL的 `ON DUPLICATE KEY UPDATE`，改用Knex的 `onConflict().merge()`）
- SQLite不支持 `ALTER TABLE` 修改列，迁移时需注意
- JSON字段：MySQL/PG原生支持，SQLite存为TEXT
- 时间精度：MySQL/PG支持 `DATETIME(3)` 毫秒精度，SQLite存为ISO字符串

**建表统一使用Knex迁移：**

```javascript
// migrations/001_create_events.js
exports.up = function(knex) {
  return knex.schema.createTable('events', (table) => {
    table.increments('id');
    table.string('event_id', 64).notNullable().unique();
    // ... 以下字段定义
  });
};
```

## 1. ER关系

```
events N──1 sessions
  |              |
  +── daily_stats (聚合)
  |
  +── tool_usage_detail (明细)
```

## 2. 表结构

> 以下SQL为逻辑定义，实际建表通过Knex迁移实现，自动适配SQLite/MySQL/PostgreSQL。

### 2.1 events（核心事件表）

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,  -- SQLite; MySQL/PG用各自自增语法
  event_id VARCHAR(64) NOT NULL UNIQUE,  -- 客户端生成的UUID，用于去重
  
  -- 来源信息
  agent VARCHAR(32) NOT NULL,            -- 编程Agent名称: claude-code/codebuddy
  agent_version VARCHAR(32) DEFAULT NULL,
  
  -- 用户与机器
  username VARCHAR(128) NOT NULL,        -- os.userInfo().username
  hostname VARCHAR(256) NOT NULL,        -- os.hostname()
  platform VARCHAR(16) NOT NULL,         -- darwin/linux/win32
  
  -- 会话与对话
  session_id VARCHAR(128) NOT NULL,
  conversation_turn INTEGER DEFAULT NULL,
  
  -- 事件信息
  event_type VARCHAR(64) NOT NULL,       -- session_start/session_end/tool_use/skill_use等
  event_time TEXT NOT NULL,              -- ISO 8601 (SQLite兼容; MySQL/PG用DATETIME(3))
  received_time TEXT NOT NULL,           -- 服务器接收时间
  
  -- 模型信息
  model VARCHAR(64) DEFAULT NULL,
  
  -- Token消耗
  token_input INTEGER DEFAULT 0,
  token_output INTEGER DEFAULT 0,
  token_cache_read INTEGER DEFAULT 0,
  token_cache_write INTEGER DEFAULT 0,
  
  -- Tool/Skill使用
  tool_name VARCHAR(128) DEFAULT NULL,
  skill_name VARCHAR(128) DEFAULT NULL,
  
  -- 文件变更
  files_created INTEGER DEFAULT 0,
  files_modified INTEGER DEFAULT 0,
  lines_added INTEGER DEFAULT 0,
  lines_removed INTEGER DEFAULT 0,
  
  -- 扩展数据
  extra TEXT DEFAULT NULL               -- JSON字符串(SQLite兼容)
);

-- 索引(通过Knex迁移创建)
CREATE INDEX idx_events_time ON events(event_time);
CREATE INDEX idx_events_user_time ON events(username, event_time);
CREATE INDEX idx_events_session ON events(session_id);
CREATE INDEX idx_events_agent_time ON events(agent, event_time);
CREATE INDEX idx_events_hostname ON events(hostname, event_time);
CREATE INDEX idx_events_model ON events(model, event_time);
```

### 2.2 sessions（会话汇总表，定期聚合）

```sql
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id VARCHAR(128) NOT NULL UNIQUE,
  
  agent VARCHAR(32) NOT NULL,
  username VARCHAR(128) NOT NULL,
  hostname VARCHAR(256) NOT NULL,
  platform VARCHAR(16) NOT NULL,
  model VARCHAR(64) DEFAULT NULL,        -- 主要使用的模型
  
  start_time TEXT NOT NULL,
  end_time TEXT DEFAULT NULL,
  duration_seconds INTEGER DEFAULT NULL,
  
  conversation_turns INTEGER DEFAULT 0,
  token_input_total INTEGER DEFAULT 0,
  token_output_total INTEGER DEFAULT 0,
  token_total INTEGER DEFAULT 0,
  
  tool_use_count INTEGER DEFAULT 0,
  tool_distinct_count INTEGER DEFAULT 0,
  skill_use_count INTEGER DEFAULT 0,
  skill_distinct_count INTEGER DEFAULT 0,
  
  files_created_total INTEGER DEFAULT 0,
  files_modified_total INTEGER DEFAULT 0,
  lines_added_total INTEGER DEFAULT 0,
  lines_removed_total INTEGER DEFAULT 0
);

CREATE INDEX idx_sessions_user_time ON sessions(username, start_time);
CREATE INDEX idx_sessions_agent_time ON sessions(agent, start_time);
CREATE INDEX idx_sessions_hostname ON sessions(hostname, start_time);
```

### 2.3 daily_stats（每日统计快照，定时任务生成）

```sql
CREATE TABLE daily_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stat_date TEXT NOT NULL,               -- YYYY-MM-DD
  
  username VARCHAR(128) NOT NULL,
  hostname VARCHAR(256) NOT NULL,
  agent VARCHAR(32) NOT NULL,
  model VARCHAR(64) DEFAULT '__all__',   -- __all__表示不区分模型
  
  session_count INTEGER DEFAULT 0,
  conversation_turns INTEGER DEFAULT 0,
  token_input INTEGER DEFAULT 0,
  token_output INTEGER DEFAULT 0,
  token_total INTEGER DEFAULT 0,
  
  tool_use_count INTEGER DEFAULT 0,
  tool_distinct_count INTEGER DEFAULT 0,
  skill_use_count INTEGER DEFAULT 0,
  skill_distinct_count INTEGER DEFAULT 0,
  
  files_created INTEGER DEFAULT 0,
  files_modified INTEGER DEFAULT 0,
  lines_added INTEGER DEFAULT 0,
  lines_removed INTEGER DEFAULT 0,
  
  UNIQUE(stat_date, username, hostname, agent, model)
);

CREATE INDEX idx_daily_date ON daily_stats(stat_date);
CREATE INDEX idx_daily_user_date ON daily_stats(username, stat_date);
```

### 2.4 tool_usage_detail（工具/Skill使用明细，支持聚合和不聚合查询）

```sql
CREATE TABLE tool_usage_detail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stat_date TEXT NOT NULL,
  username VARCHAR(128) NOT NULL,
  hostname VARCHAR(256) NOT NULL,
  agent VARCHAR(32) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  
  usage_type VARCHAR(8) NOT NULL,        -- 'tool' 或 'skill' (避免ENUM不兼容SQLite)
  name VARCHAR(128) NOT NULL,
  use_count INTEGER DEFAULT 0
);

CREATE INDEX idx_tool_date_user ON tool_usage_detail(stat_date, username);
CREATE INDEX idx_tool_session ON tool_usage_detail(session_id);
CREATE INDEX idx_tool_name ON tool_usage_detail(name, stat_date);
```

## 3. 查询示例

> 以下SQL使用标准SQL语法，兼容SQLite/MySQL/PostgreSQL。实际代码中通过Knex query builder构建。

### 3.1 按日统计排名（Token消耗Top10）

```javascript
// Knex写法（自动适配数据库方言）
const ranking = await knex('daily_stats')
  .select('username')
  .sum('token_total as total_tokens')
  .sum('token_input as input_tokens')
  .sum('token_output as output_tokens')
  .sum('session_count as sessions')
  .sum('conversation_turns as turns')
  .where('stat_date', '2026-04-07')
  .where('model', '__all__')
  .groupBy('username')
  .orderBy('total_tokens', 'desc')
  .limit(10);
```

### 3.2 按周统计（指定模型过滤）

```javascript
const weekStats = await knex('daily_stats')
  .select('username')
  .sum('token_total as total_tokens')
  .sum('session_count as sessions')
  .whereBetween('stat_date', ['2026-03-31', '2026-04-06'])
  .where('model', 'claude-opus-4')
  .groupBy('username')
  .orderBy('total_tokens', 'desc');
```

### 3.3 下钻到机器维度

```javascript
const drilldown = await knex('daily_stats')
  .select('hostname', 'agent')
  .sum('token_total as total_tokens')
  .sum('session_count as sessions')
  .whereBetween('stat_date', ['2026-04-01', '2026-04-07'])
  .where({ username: 'leon', model: '__all__' })
  .groupBy('hostname', 'agent')
  .orderBy('total_tokens', 'desc');
```

### 3.4 单会话Skill使用统计

```javascript
// 不聚合（列出每次使用）
const detail = await knex('tool_usage_detail')
  .where({ usage_type: 'skill', session_id: 'xxx' });

// 按Skill名称聚合
const aggregated = await knex('tool_usage_detail')
  .select('name')
  .sum('use_count as total_uses')
  .where('usage_type', 'skill')
  .whereBetween('stat_date', ['2026-04-01', '2026-04-07'])
  .groupBy('name')
  .orderBy('total_uses', 'desc');
```

## 4. 数据生命周期

| 数据层 | 保留策略 | 用途 |
|--------|---------|------|
| events | 90天（可配置） | 原始事件，支持任意维度回溯 |
| sessions | 180天 | 会话级聚合，快速查询 |
| daily_stats | 永久 | 每日快照，报表和趋势 |
| tool_usage_detail | 90天 | 工具使用明细 |
