# 系统架构设计

## 1. 整体架构

```
+----------------------------------------------------------+
|                     开发者机器 (Client)                    |
|                                                          |
|          +-----------+       +-----------+                |
|          |Claude Code|       | CodeBuddy |    (P0)        |
|          +-----+-----+       +-----+-----+               |
|                |                    |                     |
|                v                    v                     |
|  +--------------------------------------------------+    |
|  |         用户级 Hook 层 (~/.claude/ ~/.codebuddy/)  |    |
|  |    (用户级settings.json中注入hook配置)              |    |
|  +-------------------------+------------------------+    |
|                            |                             |
|                            v                             |
|  +--------------------------------------------------+    |
|  |           agent-tools 客户端 (Node.js)             |    |
|  |                                                    |    |
|  |  - 事件标准化                                       |    |
|  |  - 本地数据 (~/.agent-tools/data/)                 |    |
|  |    - SQLite缓存 + 本地统计                          |    |
|  |  - 配置 (~/.agent-tools/config.json)               |    |
|  |  - 数据批量上报                                     |    |
|  |  - CLI: init/setup/stats/sync                      |    |
|  +-------------------------+------------------------+    |
|                            |                             |
+----------------------------|-----------------------------+
                             | HTTP POST (批量上报，无鉴权)
                             v
+----------------------------------------------------------+
|              中央服务器 (Linux/Mac/Windows)                |
|                                                          |
|  +--------------------------------------------------+    |
|  |            agent-tools-server (Node.js)            |    |
|  |                                                    |    |
|  |  - 首次启动向导 (数据库类型/端口/等)                 |    |
|  |  - REST API (数据接收/查询，上报无需鉴权)            |    |
|  |  - 数据聚合引擎                                     |    |
|  |  - 图表生成 (ECharts SSR / API)                    |    |
|  |  - Web Dashboard                                   |    |
|  +-------------------------+------------------------+    |
|                            |                             |
|                            v                             |
|              +---------------------------+               |
|              | SQLite / MySQL / PostgreSQL |               |
|              |    (首次向导中选择配置)      |               |
|              +---------------------------+               |
+----------------------------------------------------------+
```

## 2. 客户端架构

### 2.1 包结构

```
agent-tools/
├── package.json
├── bin/
│   └── cli.js                    # CLI入口 (#!/usr/bin/env node)
├── src/
│   ├── index.js                  # 主模块导出
│   ├── cli/
│   │   ├── init.js               # init命令 - 首次初始化(指定服务器地址)
│   │   ├── setup.js              # setup命令 - 自动检测并配置Agent
│   │   ├── stats.js              # stats命令 - 本地统计查看
│   │   └── sync.js               # sync命令 - 手动上报
│   ├── detector/
│   │   ├── index.js              # Agent检测协调器
│   │   ├── claude-code.js        # Claude Code检测 & 配置 (P0)
│   │   └── codebuddy.js          # CodeBuddy检测 & 配置 (P0)
│   ├── hooks/
│   │   ├── universal-hook.js     # 通用hook脚本 (被各Agent调用)
│   │   ├── adapters/
│   │   │   ├── claude-code.js    # Claude Code事件适配
│   │   │   └── codebuddy.js      # CodeBuddy事件适配
│   │   └── templates/            # 各Agent的hook配置模板
│   ├── collector/
│   │   ├── event-normalizer.js   # 事件标准化
│   │   ├── metrics-calculator.js # 指标计算
│   │   ├── local-store.js        # 本地SQLite缓存
│   │   └── uploader.js           # 批量上报
│   └── utils/
│       ├── platform.js           # 跨平台工具
│       ├── env.js                # 环境变量获取
│       └── config.js             # 客户端配置管理
├── scripts/
│   └── postinstall.js            # npm postinstall (检测+提示+触发init)
└── hooks/                        # 预构建的hook脚本文件
    ├── hook-claude-code.sh       # Unix
    ├── hook-claude-code.ps1      # Windows PowerShell
    └── ...
```

**用户数据目录 (`~/.agent-tools/`)：**

```
~/.agent-tools/                    # 用户主目录下
├── config.json                    # 客户端配置(服务器地址等)
└── data/
    ├── local.db                   # SQLite本地缓存(事件暂存+离线查询)
    └── stats/                     # 本地生成的统计数据
        └── ...
```

### 2.2 Agent检测机制

```javascript
// 检测策略：CLI存在性 + 用户级配置目录存在性
const AGENT_DETECTORS = {
  'claude-code': {
    commands: ['claude'],
    // 用户级配置文件（hook注入目标）
    userConfigFile: {
      darwin: '~/.claude/settings.json',
      linux: '~/.claude/settings.json',
      win32: '%USERPROFILE%\\.claude\\settings.json'
    }
  },
  'codebuddy': {
    commands: ['codebuddy'],
    userConfigFile: {
      darwin: '~/.codebuddy/settings.json',
      linux: '~/.codebuddy/settings.json',
      win32: '%USERPROFILE%\\.codebuddy\\settings.json'
    }
  },
};
```

### 2.3 Hook注入策略

**关键：注入到用户级配置文件**（`~/.claude/settings.json`、`~/.codebuddy/settings.json`），而非项目级配置，确保全局生效。

每个Agent使用各自的hook机制，但所有hook最终调用同一个 `universal-hook.js`：

**Claude Code 用户级 (`~/.claude/settings.json`)：**
```json
{
  "hooks": {
    "SessionStart": [{ "type": "command", "command": "node /path/to/universal-hook.js --agent=claude-code --event=SessionStart", "async": true }],
    "SessionEnd": [{ "type": "command", "command": "node /path/to/universal-hook.js --agent=claude-code --event=SessionEnd", "async": true }],
    "PreToolUse": [{ "type": "command", "command": "node /path/to/universal-hook.js --agent=claude-code --event=PreToolUse", "async": true }],
    "PostToolUse": [{ "type": "command", "command": "node /path/to/universal-hook.js --agent=claude-code --event=PostToolUse", "async": true }]
  }
}
```

**CodeBuddy 用户级 (`~/.codebuddy/settings.json`)：**
```json
{
  "hooks": {
    "PreToolUse": [{ "type": "command", "command": "node /path/to/universal-hook.js --agent=codebuddy --event=PreToolUse", "async": true }],
    "PostToolUse": [{ "type": "command", "command": "node /path/to/universal-hook.js --agent=codebuddy --event=PostToolUse", "async": true }]
  }
}
```

### 2.4 数据采集流程

```
Agent生命周期事件
       |
       v
Hook脚本触发 (stdin接收JSON事件数据)
       |
       v
事件适配器 (将各Agent特有格式转为统一格式)
       |
       v
标准化事件 {
  timestamp, agent, event_type, session_id,
  user, hostname, platform, model,
  tool_name, skill_name, token_input, token_output,
  files_created, files_modified, lines_added, lines_removed
}
       |
       v
写入本地SQLite缓存
       |
       v
异步批量上报到中央服务器 (每5分钟或缓存超100条)
```

## 3. 服务器架构

### 3.1 技术栈

- **运行时**：Node.js (v18+)
- **Web框架**：Fastify
- **数据库**：SQLite（开发/轻量部署）/ MySQL / PostgreSQL（生产），通过Knex.js抽象
- **图表**：ECharts (SSR渲染 或 前端渲染)
- **前端**：轻量SPA (Vue3 + ECharts)
- **上报接口**：无需鉴权（简化部署，内网使用场景）
- **首次启动**：交互式向导配置数据库类型、连接参数、端口等

### 3.2 API设计

```
POST   /api/v1/events/batch          # 批量上报事件
GET    /api/v1/stats/summary          # 汇总统计
GET    /api/v1/stats/ranking          # 排名
GET    /api/v1/stats/drilldown        # 下钻查询
GET    /api/v1/stats/trend            # 趋势数据
GET    /api/v1/charts/:type           # 图表渲染(SVG/PNG)
GET    /dashboard                     # Web仪表板
```

### 3.3 查询参数

```
?period=day|week|month|custom        # 时间维度
&start=2026-01-01&end=2026-03-31     # 自定义日期段
&model=claude-opus-4                 # 模型过滤(可选)
&user=leon                           # 用户过滤(可选)
&hostname=dev-machine-01             # 机器名过滤(可选)
&agent=claude-code                   # Agent过滤(可选)
&drilldown=hostname|user|agent|model # 下钻维度
```

## 4. 双通道集成策略

基于调研，采用 **Hook + MCP** 双通道策略：

### 4.1 Hook通道（主要-数据采集）

用于实时数据采集，覆盖支持hook的Agent：
- Claude Code, CodeBuddy, OpenCode, Copilot CLI, Cursor, Continue, Amazon Q

### 4.2 MCP通道（辅助-交互查询）

提供MCP Server，让Agent内部可直接查询统计数据：

```javascript
// MCP Tools
server.tool("agent_stats_summary", { period, model, user }, async (params) => {
  // 返回统计摘要
});

server.tool("agent_stats_ranking", { period, metric, limit }, async (params) => {
  // 返回排名数据
});
```

### 4.3 后续Agent扩展

其他Agent（OpenCode、Copilot CLI、Cursor等）的适配器作为后续Phase实现，采用与P0相同的Hook+MCP双通道模式。各Agent适配器独立模块化，不影响核心采集链路。
