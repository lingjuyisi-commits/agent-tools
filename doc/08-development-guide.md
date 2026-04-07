# 08 - AI 辅助开发指南

本文档面向 AI（如 Claude）或新加入的开发者，帮助快速理解代码库结构、数据流向和扩展方式，以便高效继续开发。

---

## 项目当前状态

### Phase 1（已完成）

- [x] Claude Code hook 注入（`~/.claude/settings.json`）
- [x] `universal-hook.js` 入口脚本（stdin 读取 → 适配 → 存储）
- [x] Claude Code 适配器（`adapters/claude-code.js`）
- [x] 本地 SQLite 存储（`local-store.js`，`better-sqlite3`）
- [x] 批量 HTTP 上报（`uploader.js`，`POST /api/v1/events/batch`）
- [x] 服务端接收接口（去重入库）
- [x] 基础统计查询 API（`/api/v1/stats/summary`，`/api/v1/stats/ranking`）
- [x] 服务端 SQLite 存储（Knex + `better-sqlite3`）
- [x] 首次运行交互式向导（SQLite 路径选择）
- [x] CLI 命令：`init`、`setup`、`sync`、`status`

### Phase 2（待实现）

- [ ] CodeBuddy 支持（detector + adapter）
- [ ] `agent-tools stats` 本地查询命令
- [ ] `agent-tools agents` 命令
- [ ] 服务端向导支持 MySQL / PostgreSQL
- [ ] Knex migrations 脚本（`server/migrations/`）
- [ ] `daily_stats` 表和聚合定时任务

### Phase 3（待实现）

- [ ] Web Dashboard 基础框架（`server/src/dashboard/index.html`）
- [ ] Overview Tab（汇总卡片 + Token 趋势图）
- [ ] Ranking Tab（排名表格）
- [ ] `/api/v1/stats/trend` 接口
- [ ] `/api/v1/stats/ranking` 接口（支持 drilldown 参数）

### Phase 4（待实现）

- [ ] Dashboard Drilldown Tab
- [ ] Dashboard Tools Tab
- [ ] `/api/v1/stats/drilldown` 接口
- [ ] `/api/v1/stats/tool-usage` 接口
- [ ] `/api/v1/stats/models` 和 `/api/v1/stats/event-types` 接口
- [ ] 数据保留策略（定时清理，`node-cron`）

### Phase 5（待实现）

- [ ] OpenCode 支持
- [ ] 服务端向导支持 `--skip-wizard` / 环境变量完整覆盖
- [ ] 客户端自动更新检测
- [ ] Dashboard 时间范围选择器（自定义日期段）
- [ ] 多模型对比视图
- [ ] npm 发布流程（CI/CD）

---

## 代码库导航

### 关键文件清单

#### 客户端（`cli/`）

| 文件路径 | 职责 |
|----------|------|
| `cli/bin/cli.js` | CLI 入口，注册所有命令（Commander.js） |
| `cli/src/hooks/universal-hook.js` | Hook 脚本入口：从 stdin 读取 JSON → 选择适配器 → 调用 `local-store` 存储。**此文件必须永不 crash** |
| `cli/src/hooks/adapters/claude-code.js` | Claude Code 事件字段映射：将 Claude Code 的原始 hook 数据 normalize 为 `StandardEvent` |
| `cli/src/hooks/adapters/codebuddy.js` | CodeBuddy 适配器（Phase 2 待实现） |
| `cli/src/detector/index.js` | 检测器注册表：`getAllDetectors()` 返回所有已注册 detector 实例 |
| `cli/src/detector/claude-code.js` | Claude Code 检测器：`isInstalled()`、`configExists()`、`hasAgentToolsHooks()`、`injectHooks()` |
| `cli/src/detector/codebuddy.js` | CodeBuddy 检测器（Phase 2 待实现） |
| `cli/src/collector/local-store.js` | 本地 SQLite 读写：`saveEvent(event)`、`getPendingEvents()`、`markUploaded(ids)` |
| `cli/src/collector/uploader.js` | 批量 HTTP 上报：`upload()`（读取 pending → POST → markUploaded），`startAutoUpload()` |
| `cli/src/commands/init.js` | `agent-tools init` 实现 |
| `cli/src/commands/setup.js` | `agent-tools setup` 实现 |
| `cli/src/commands/sync.js` | `agent-tools sync` 实现 |
| `cli/src/commands/status.js` | `agent-tools status` 实现 |
| `cli/src/commands/stats.js` | `agent-tools stats` 实现（Phase 2 待实现） |

#### 服务端（`server/`）

| 文件路径 | 职责 |
|----------|------|
| `server/bin/server.js` | 服务器入口：解析 CLI 参数，加载配置，启动 Express |
| `server/src/app.js` | Express 应用初始化：注册路由、中间件 |
| `server/src/db/knex.js` | Knex 实例创建，根据 config 选择 client |
| `server/src/db/migrations/` | Knex migration 文件（建表 DDL） |
| `server/src/routes/events.js` | `POST /api/v1/events/batch` 路由 |
| `server/src/routes/stats.js` | 所有 `GET /api/v1/stats/*` 路由注册 |
| `server/src/routes/health.js` | `GET /api/v1/health` 路由 |
| `server/src/services/event-service.js` | 写入 + 去重：`batchInsert(events)` → 按 `event_id` 去重后 insert |
| `server/src/services/stats-service.js` | 查询逻辑核心：`computeDateRange(params)` 计算时间范围，`applyFilters(query, params)` 附加过滤条件，各统计方法 |
| `server/src/wizard/index.js` | 首次运行向导：交互式配置数据库和端口 |
| `server/src/dashboard/index.html` | 单文件前端（ECharts CDN），内嵌 HTML + CSS + JS |

---

## 数据流详解

以下是从 hook 触发到 Dashboard 展示的完整数据流：

```
1. 用户在终端使用 claude-code / codebuddy 执行任务

2. Agent 执行工具调用（如 Read 文件）
   → Agent 触发 PostToolUse hook
   → 将事件 JSON 写入 universal-hook.js 的 stdin

3. universal-hook.js（~/.agent-tools/hooks/universal-hook.js）
   → 读取 stdin（整个 JSON 字符串）
   → 解析 --agent 参数（如 claude-code）
   → 加载对应适配器（adapters/claude-code.js）
   → 调用 adapter.normalize(rawData, eventType) → StandardEvent
   → 调用 local-store.saveEvent(standardEvent)

4. local-store.js（SQLite: ~/.agent-tools/data/local.db）
   → INSERT INTO events (event_id, ...) VALUES (...)
   → uploaded = 0（标记为待上报）

5. uploader.js（定时任务：每 5 分钟 或 pending >= 100）
   → SELECT * FROM events WHERE uploaded = 0 LIMIT 100
   → POST http://server:3000/api/v1/events/batch { events: [...] }
   → 收到 200 响应后：UPDATE events SET uploaded = 1 WHERE id IN (...)

6. server/src/routes/events.js
   → 接收 POST /api/v1/events/batch
   → 调用 event-service.batchInsert(events)

7. event-service.js
   → 对每个 event 检查 event_id 是否已存在（去重）
   → INSERT INTO events（新事件）
   → 更新 sessions 表（upsert session 统计）
   → 返回 { received, inserted, duplicates }

8. 用户打开 Dashboard（http://localhost:3000）
   → 前端加载 index.html
   → 调用 GET /api/v1/stats/summary?period=week
   → stats-service.getSummary(params) → 查询数据库 → 返回 JSON
   → ECharts 渲染图表
```

---

## 扩展新 Agent 的步骤

以添加 **OpenCode** 支持为例：

### Step 1：创建 Detector

新建 `cli/src/detector/opencode.js`：

```javascript
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.opencode', 'config.json');
const HOOK_MARKER = 'agent-tools';

module.exports = {
  name: 'opencode',
  displayName: 'OpenCode',

  // 判断是否安装（检查可执行文件是否存在）
  isInstalled() {
    const { execSync } = require('child_process');
    try {
      execSync('which opencode', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },

  // 判断配置文件是否存在
  configExists() {
    return fs.existsSync(CONFIG_PATH);
  },

  // 判断 hooks 是否已注入（通过 marker 字符串检测）
  hasAgentToolsHooks() {
    if (!this.configExists()) return false;
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return content.includes(HOOK_MARKER);
  },

  // 注入 hooks 到配置文件
  injectHooks(hookScriptPath) {
    let config = {};
    if (this.configExists()) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }

    // 根据 OpenCode 的实际 hook 格式调整此结构
    config.hooks = config.hooks || {};
    const events = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'Stop'];
    for (const event of events) {
      config.hooks[event] = [
        {
          // marker: HOOK_MARKER （注入到注释或某个字段中以便检测）
          command: `node ${hookScriptPath} --agent=opencode --event=${event}`
        }
      ];
    }

    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }
};
```

### Step 2：创建 Adapter

新建 `cli/src/hooks/adapters/opencode.js`：

```javascript
const os = require('os');

/**
 * 将 OpenCode 的原始 hook 数据标准化为 StandardEvent。
 * rawData 的实际字段需根据 OpenCode 实际传入的数据结构调整。
 */
function normalize(rawData, eventType) {
  return {
    event_id: rawData.event_id || `opencode-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    event_type: eventType,
    session_id: rawData.session_id || rawData.conversationId || 'unknown',
    agent: 'opencode',
    model: rawData.model || rawData.modelId || null,
    hostname: os.hostname(),
    username: os.userInfo().username,
    timestamp: rawData.timestamp || new Date().toISOString(),

    // Tool 信息
    tool_name: rawData.tool_name || rawData.toolName || null,
    duration_ms: rawData.duration_ms || rawData.durationMs || null,

    // Token 信息（字段名根据实际情况调整）
    input_tokens: rawData.usage?.input_tokens || rawData.inputTokens || null,
    output_tokens: rawData.usage?.output_tokens || rawData.outputTokens || null,

    // 文件变更
    files_changed: rawData.files_changed || null,
    lines_added: rawData.lines_added || null,
    lines_removed: rawData.lines_removed || null,
  };
}

module.exports = { normalize };
```

### Step 3：注册到 Detector Index

编辑 `cli/src/detector/index.js`，添加新 detector：

```javascript
const claudeCode = require('./claude-code');
const codebuddy = require('./codebuddy');
const opencode = require('./opencode');   // 新增这行

const ALL_DETECTORS = [claudeCode, codebuddy, opencode];  // 添加到数组

function getAllDetectors() {
  return ALL_DETECTORS;
}

function getDetector(name) {
  return ALL_DETECTORS.find(d => d.name === name);
}

module.exports = { getAllDetectors, getDetector };
```

### Step 4：注册适配器

编辑 `cli/src/hooks/universal-hook.js`，在适配器映射中添加：

```javascript
const ADAPTERS = {
  'claude-code': require('./adapters/claude-code'),
  'codebuddy': require('./adapters/codebuddy'),
  'opencode': require('./adapters/opencode'),  // 新增这行
};
```

### Step 5：测试

```bash
# 模拟 OpenCode hook 事件
echo '{"session_id":"test-001","tool_name":"Read","model":"gpt-4o","usage":{"input_tokens":800,"output_tokens":120}}' \
  | node cli/src/hooks/universal-hook.js --agent=opencode --event=PostToolUse

# 验证数据已写入本地 DB
node cli/bin/cli.js stats --period day
```

---

## 已知问题和注意事项

### 1. `better-sqlite3` 需要 Native 编译

`better-sqlite3` 是 native Node.js addon，安装后可能需要重新编译：

```bash
# npm
npm rebuild better-sqlite3

# pnpm（推荐）
pnpm approve-builds
pnpm rebuild
```

如果在 CI/CD 中遇到问题，确保安装了 `node-gyp` 依赖（Python、C++ 编译工具链）。

### 2. Claude Code Hooks 注入位置

Claude Code hooks 注入到**用户级配置**（`~/.claude/settings.json`），而非项目级配置（`.claude/settings.json`）。

这是有意为之——用户级 hooks 对所有项目生效，无需在每个项目中重复配置。修改时注意不要与用户已有的 hooks 配置冲突，`injectHooks()` 应合并而非覆盖现有配置。

### 3. `universal-hook.js` 必须永不 Crash

Hook 脚本作为 Agent 的一个子进程运行。如果 hook 脚本 crash（exit code 非 0），部分 Agent 可能会报错影响正常使用。

规则：**`universal-hook.js` 中所有逻辑必须包裹在 try/catch 中，任何错误只写日志，不向上抛出。**

```javascript
// 正确写法
async function main() {
  try {
    const raw = await readStdin();
    const event = adapter.normalize(JSON.parse(raw), eventType);
    await store.saveEvent(event);
  } catch (err) {
    // 写入日志文件，但不 throw，不 process.exit(1)
    appendErrorLog(err);
  }
}

main();  // 不 .catch(err => process.exit(1))
```

### 4. 服务器上报接口无鉴权

当前 `POST /api/v1/events/batch` 接口没有鉴权，适合在内网（团队局域网）使用。

如果需要暴露到公网或添加鉴权，参考 `doc/06-server-detail.md` 的安全设计部分。计划在 Phase 5 添加可选的 API Key 认证。

### 5. Knex `better-sqlite3` Client 名称

Knex 中 SQLite 的 client 名称是 `"better-sqlite3"`，**不是** `"sqlite3"`（后者是另一个性能较差的包）：

```javascript
// 正确
const knex = Knex({ client: 'better-sqlite3', connection: { filename: dbPath } });

// 错误（会找不到 driver）
const knex = Knex({ client: 'sqlite3', ... });
```

### 6. 上报时机的并发问题

`uploader.js` 的自动上报（`startAutoUpload()`）和手动 `agent-tools sync` 可能同时运行。建议使用文件锁或 `uploading` 状态标志防止并发上报同一批事件：

```javascript
let isUploading = false;

async function upload() {
  if (isUploading) return;
  isUploading = true;
  try {
    // ... 上报逻辑
  } finally {
    isUploading = false;
  }
}
```

---

## 测试方法

### 端到端完整测试

```bash
# 1. 启动服务器（SQLite，跳过向导，使用临时数据库）
cd /path/to/agent-tools/server
node bin/server.js --port 3000 --db-path /tmp/test-server.db

# 2. 初始化客户端（非交互模式）
cd /path/to/agent-tools/cli
node bin/cli.js init --server http://localhost:3000

# 3. 模拟 hook 事件（PostToolUse）
echo '{"session_id":"test-001","tool_name":"Read","model":"claude-opus-4","usage":{"input_tokens":1500,"output_tokens":200}}' \
  | node src/hooks/universal-hook.js --agent=claude-code --event=PostToolUse

# 4. 模拟 SessionStart 事件
echo '{"session_id":"test-001","model":"claude-opus-4"}' \
  | node src/hooks/universal-hook.js --agent=claude-code --event=SessionStart

# 5. 手动同步（上报到服务器）
node bin/cli.js sync

# 6. 查询服务器统计
curl http://localhost:3000/api/v1/stats/summary?period=all
curl http://localhost:3000/api/v1/stats/ranking?drilldown=username

# 7. 查看本地状态
node bin/cli.js status
```

### 单元测试各模块

```bash
# 测试适配器标准化
node -e "
const adapter = require('./src/hooks/adapters/claude-code');
const raw = { session_id: 'test', tool_name: 'Read', usage: { input_tokens: 100, output_tokens: 50 } };
console.log(adapter.normalize(raw, 'PostToolUse'));
"

# 测试本地存储
node -e "
const store = require('./src/collector/local-store');
store.saveEvent({ event_id: 'test-1', event_type: 'PostToolUse', session_id: 'sess-1', agent: 'claude-code', timestamp: new Date().toISOString() });
console.log('Pending:', store.getPendingEvents().length);
"

# 测试服务器健康检查
curl http://localhost:3000/api/v1/health
```

### 调试 Hook 脚本

在 `universal-hook.js` 开头添加临时调试日志：

```javascript
// 临时调试：将原始 stdin 写入日志
const DEBUG = process.env.AGENT_TOOLS_DEBUG === '1';
if (DEBUG) {
  fs.appendFileSync('/tmp/agent-tools-debug.log', `[${new Date().toISOString()}] ${JSON.stringify({ args: process.argv, data: rawData })}\n`);
}
```

触发 hook 时设置环境变量：

```bash
AGENT_TOOLS_DEBUG=1 echo '...' | node src/hooks/universal-hook.js --agent=claude-code --event=PostToolUse
tail -f /tmp/agent-tools-debug.log
```

---

## 待实现功能清单

### Phase 2 任务

- [ ] **CodeBuddy Detector**（`cli/src/detector/codebuddy.js`）
  - `isInstalled()`：检测 `~/.codebuddy/` 目录或 `codebuddy` 可执行文件
  - `injectHooks()`：向 `~/.codebuddy/settings.json` 注入 hooks（格式待调研）
- [ ] **CodeBuddy Adapter**（`cli/src/hooks/adapters/codebuddy.js`）
  - 调研 CodeBuddy hook 传入的原始数据字段结构
  - 实现 `normalize(rawData, eventType)` 映射到 `StandardEvent`
- [ ] **`agent-tools stats` 命令**（`cli/src/commands/stats.js`）
  - 从本地 SQLite 查询，支持 `--period` 和 `--date` 参数
  - 格式化输出 Token 统计、工具使用 Top 5
- [ ] **`agent-tools agents` 命令**（`cli/src/commands/agents.js`）
  - 遍历所有 detectors，输出安装状态和 hooks 注入状态
- [ ] **服务端向导 MySQL/PostgreSQL 支持**（`server/src/wizard/index.js`）
  - 选择 MySQL/PostgreSQL 时显示 host/port/database/user/password 输入项
  - 测试连接：`knex.raw('SELECT 1')`
- [ ] **Knex Migrations**（`server/src/db/migrations/`）
  - `001_create_events.js`：events 表
  - `002_create_sessions.js`：sessions 表
  - `003_create_daily_stats.js`：daily_stats 表
- [ ] **`daily_stats` 聚合定时任务**（`server/src/jobs/aggregate.js`）
  - 每天凌晨 1:00 将前一天的 events 汇总写入 `daily_stats`

### Phase 3 任务

- [ ] **Web Dashboard 框架**（`server/src/dashboard/index.html`）
  - 单文件，内嵌 ECharts CDN + CSS + JavaScript
  - Tab 切换：Overview / Ranking / Drilldown / Tools
  - 顶部过滤栏：时间段选择、Agent 过滤、模型过滤
- [ ] **Overview Tab**
  - 汇总卡片：总 Token、会话数、对话轮次、活跃用户数
  - Token 趋势折线图（调用 `/api/v1/stats/trend`）
  - 输入/输出 Token 堆叠图
- [ ] **Ranking Tab**
  - 按 username / hostname / agent 切换（调用 `/api/v1/stats/ranking?drilldown=xxx`）
  - 表格展示：排名、标识、Token 总数、会话数、活跃天数
- [ ] **`/api/v1/stats/trend` 接口**（`server/src/services/stats-service.js`）
  - 按天 GROUP BY，返回 `[{ date, total_tokens, session_count }]`
- [ ] **`/api/v1/stats/ranking` 接口**
  - 支持 `drilldown` 参数动态 GROUP BY 字段

### Phase 4 任务

- [ ] **Dashboard Drilldown Tab**
  - 点击 Ranking 中某行 → 下钻到该用户/机器
  - 饼图：各 Agent 占比；柱状图：日期趋势；工具列表
- [ ] **Dashboard Tools Tab**
  - 工具调用次数 Top 20（横向柱状图）
  - 工具平均耗时表格
- [ ] **`/api/v1/stats/drilldown` 接口**
  - 接收 `user` 或 `hostname` 参数
  - 返回 `by_agent`、`by_model`、`top_tools` 三个维度数据
- [ ] **`/api/v1/stats/tool-usage` 接口**
  - 按 `tool_name` GROUP BY，统计次数和平均耗时
- [ ] **`/api/v1/stats/models` 和 `/api/v1/stats/event-types` 接口**
- [ ] **数据保留清理任务**（`server/src/jobs/cleanup.js`）
  - 每天凌晨 2:00 删除超过 `retention.eventsDays` 的 events
  - 删除超过 `retention.sessionsDays` 的 sessions

### Phase 5 任务

- [ ] **OpenCode 支持**（按本文档"扩展新 Agent"步骤实现）
- [ ] **环境变量完整覆盖**（`server/src/config/index.js`）
  - 所有配置项均可通过环境变量覆盖，无需 `config.json`
- [ ] **`--skip-wizard` 参数**
  - 当所有必要配置通过环境变量提供时，跳过向导直接启动
- [ ] **客户端自动更新检测**
  - 启动时检查 npm registry 是否有新版本，提示用户更新
- [ ] **Dashboard 自定义日期范围选择器**
  - 日期 picker 控件，设置 `start` 和 `end` 参数
- [ ] **API Key 可选鉴权**
  - 生成随机 API Key，客户端配置后在请求头中携带 `X-Agent-Tools-Key`
  - 服务端中间件验证，无效 key 返回 401
- [ ] **npm 发布流程**
  - `cli/package.json` 和 `server/package.json` 配置 `publishConfig`
  - GitHub Actions workflow：tag 触发 → `npm publish`
