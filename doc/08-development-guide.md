# 08 - AI 辅助开发指南

本文档面向 AI（如 Claude）或新加入的开发者，帮助快速理解代码库结构、数据流向和扩展方式，以便高效继续开发。

---

## 项目当前状态

> 当前目标范围：**Claude Code + CodeBuddy**（v1 不扩展其他 Agent）

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

### Phase 2（已完成）

- [x] CodeBuddy 支持（`cli/src/detector/codebuddy.js` + `cli/src/hooks/adapters/codebuddy.js`）
- [x] `agent-tools stats` 本地查询命令（`cli/src/cli/stats.js`）
- [x] `agent-tools agents` 命令（`cli/bin/cli.js`）
- [x] 服务端向导支持 MySQL / PostgreSQL（`server/src/init-wizard.js`）
- [x] Knex migrations 脚本（`server/migrations/001~004`）
- [x] `daily_stats` 聚合定时任务（`server/src/jobs/daily-aggregation.js`）

### Phase 3（已完成）

- [x] Web Dashboard 基础框架（`server/src/dashboard/index.html`，单文件 SPA）
- [x] Overview Tab（KPI 卡片 + Token 趋势折线图 + Agent 分布饼图）
- [x] Ranking Tab（指标选择 + 排名柱状图 + 表格）
- [x] `/api/v1/stats/trend` 接口
- [x] `/api/v1/stats/ranking` 接口

### Phase 4（已完成）

- [x] Dashboard Drilldown Tab（用户/机器下钻，饼图 + 表格）
- [x] Dashboard Tools Tab（工具使用频率柱状图 + 事件类型表格）
- [x] `/api/v1/stats/drilldown` 接口
- [x] `/api/v1/stats/tool-usage` 接口
- [x] `/api/v1/stats/models` 和 `/api/v1/stats/event-types` 接口
- [x] Skill 调用统计（斜线命令 + 模型发起的 Skill tool）
- [x] Dashboard 自定义日期范围选择器（Custom period）
- [x] GitHub Actions CI/CD（`ci.yml`、`publish-cli.yml`、`publish-server.yml`）

### Phase 5（待实现）

- [ ] **数据保留清理任务**：定时删除超出保留期的旧事件（目前无清理逻辑）
- [ ] **服务端环境变量覆盖**：通过 `AT_PORT`、`AT_DB_*` 等环境变量配置，无需 config.json
- [ ] **API Key 可选鉴权**：上报接口可选 `X-Agent-Tools-Key` 校验，适合公网部署

### Phase 6（已完成）

- [x] **Hook 采集测试命令**（`cli/src/cli/test.js`）：`agent-tools test --agent <name>`，端到端验证 hooks 采集是否正常

---

## 代码库导航

### 关键文件清单

#### 客户端（`cli/`）

| 文件路径 | 职责 |
|----------|------|
| `cli/bin/cli.js` | CLI 入口，注册所有命令（Commander.js）：init / setup / sync / stats / status / agents |
| `cli/src/hooks/universal-hook.js` | Hook 脚本入口：从 stdin 读取 JSON → 选择适配器 → 调用 `local-store` 存储。**此文件必须永不 crash** |
| `cli/src/hooks/adapters/claude-code.js` | Claude Code 适配器：normalize 原始 hook 数据，含斜线命令和 Skill 工具检测 |
| `cli/src/hooks/adapters/codebuddy.js` | CodeBuddy 适配器：normalize PreToolUse / PostToolUse 数据 |
| `cli/src/detector/index.js` | 检测器注册表：`detectAll()` / `setupAll()` |
| `cli/src/detector/claude-code.js` | Claude Code 检测器：`isInstalled()`、`configExists()`、`hasAgentToolsHooks()`、`injectHooks()` |
| `cli/src/detector/codebuddy.js` | CodeBuddy 检测器：同上，注入 `~/.codebuddy/settings.json` |
| `cli/src/collector/local-store.js` | 本地 SQLite 读写（`LocalStore` 类）：`insert()`、`getUnsynced()`、`markSynced()`、`getLocalStats()` |
| `cli/src/collector/uploader.js` | 批量 HTTP 上报：读取 pending → `POST /api/v1/events/batch` → markSynced |
| `cli/src/cli/init.js` | `agent-tools init` 实现（配置服务器 URL，自动触发 setup） |
| `cli/src/cli/setup.js` | `agent-tools setup` 实现（检测并注入各 Agent hooks） |
| `cli/src/cli/sync.js` | `agent-tools sync` 实现（手动上报） |
| `cli/src/cli/stats.js` | `agent-tools stats` 实现（本地 SQLite 查询，支持 --period / --date） |
| `cli/src/utils/config.js` | 客户端配置管理（`~/.agent-tools/config.json`） |

#### 服务端（`server/`）

| 文件路径 | 职责 |
|----------|------|
| `server/bin/server.js` | 服务器入口：解析 `--port` / `--db-path`，运行 migrations，启动 Fastify |
| `server/src/app.js` | Fastify 应用：注册 CORS、静态文件、health / events / stats 路由 |
| `server/src/db.js` | `createDb(config)` — Knex 实例创建，自动建 SQLite 数据目录 |
| `server/migrations/` | Knex migration 文件（001-004：events / sessions / daily_stats / tool_usage_detail） |
| `server/src/routes/events.js` | `POST /api/v1/events/batch` 路由 |
| `server/src/routes/stats.js` | 所有 `GET /api/v1/stats/*` 路由 |
| `server/src/routes/health.js` | `GET /api/v1/health` 路由 |
| `server/src/services/event-service.js` | 批量写入 + event_id 去重 |
| `server/src/services/stats-service.js` | 统计查询核心：`computeDateRange`、`applyFilters`、`getSummary`、`getRanking`、`getDrilldown`、`getTrend` |
| `server/src/init-wizard.js` | 首次运行向导：交互式配置 SQLite / MySQL / PostgreSQL 和端口 |
| `server/src/config.js` | 服务端配置管理（`~/.agent-tools-server/config.json`） |
| `server/src/jobs/daily-aggregation.js` | 每日聚合 cron 任务（00:05 UTC 触发，写入 daily_stats / tool_usage_detail） |
| `server/src/dashboard/index.html` | 单文件前端（ECharts CDN）：Overview / Ranking / Drilldown / Tools 四个 Tab |

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

> v1 范围仅支持 Claude Code 和 CodeBuddy，以下步骤供将来扩展其他 Agent 参考。以添加 **OpenCode** 为例：

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

### 4. Skill（斜线命令）调用的统计方式

#### 背景与结论

用户通过 `/skill-name`（如 `/commit`）调用 Skill 时，存在两种执行路径：

- **Inline 模式**：Claude Code 在用户提交前将 Skill 内容展开内联到对话，模型不会调用名为 `"Skill"` 的工具。此时 PostToolUse hook 中 **不会出现** `tool_name="Skill"`，事件流和普通对话一样（Bash/Edit/Read 等工具）。
- **Fork 模式**：Claude Code 以子 Agent 身份运行 Skill，模型会调用 `tool_name="Skill"` 的工具。此时 PostToolUse hook 中会有 `tool_name="Skill"`，输入中含 `skill` 字段。

经过对 `~/.claude/projects/**/*.jsonl` 的完整分析以及对 Claude Code 源码（`/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js`）的审查，确认：

- **用户级别斜线命令（Inline 模式）**：通过 **UserPromptSubmit hook** 检测。Claude Code 在 hook 触发时传入原始 `prompt` 字段（未经 Skill 展开），其值为 `"/commit"` 等斜线开头字符串。
- **模型发起的 Skill 调用（Fork 模式）**：通过 **PostToolUse hook** 检测，`tool_name="Skill"`，`tool_input.skill` 为 Skill 名称。

#### 实现位置

`cli/src/hooks/adapters/claude-code.js` 中的 `normalize()` 函数已实现两种检测：

```javascript
// Inline 路径：UserPromptSubmit 中 prompt 以 "/" 开头
if (eventType === 'UserPromptSubmit' && typeof rawData.prompt === 'string') {
  const trimmed = rawData.prompt.trim();
  if (trimmed.startsWith('/')) {
    const skillName = trimmed.split(/\s+/)[0].slice(1);
    if (skillName) {
      base.skill_name = skillName;
      base.event_type = 'skill_use';
    }
  }
}

// Fork 路径：PostToolUse 中 tool_name 为 "Skill"
if (eventType === 'PostToolUse' && base.tool_name === 'Skill') {
  const skillInput = rawData.tool_input || rawData.input || {};
  if (typeof skillInput.skill === 'string' && skillInput.skill) {
    base.skill_name = skillInput.skill;
  }
  base.event_type = 'skill_use';
}
```

#### 注意事项

- Inline 模式的斜线命令检测依赖 `UserPromptSubmit` hook，因此必须确保该事件已注入（`claude-code.js` detector 中已包含）。
- 若用户在 UserPromptSubmit 中输入了以 `/` 开头的普通文本（非 Skill 名称），也会被计为 `skill_use`。实际中这种情况极少见，可接受。
- `skill_name` 取斜线后第一个 token（空格分隔），不含参数部分。

### 5. 服务器上报接口无鉴权

当前 `POST /api/v1/events/batch` 接口没有鉴权，适合在内网（团队局域网）使用。

如果需要暴露到公网或添加鉴权，参考 `doc/06-server-detail.md` 的安全设计部分。计划在 Phase 5 添加可选的 API Key 认证。

### 6. Knex `better-sqlite3` Client 名称

Knex 中 SQLite 的 client 名称是 `"better-sqlite3"`，**不是** `"sqlite3"`（后者是另一个性能较差的包）：

```javascript
// 正确
const knex = Knex({ client: 'better-sqlite3', connection: { filename: dbPath } });

// 错误（会找不到 driver）
const knex = Knex({ client: 'sqlite3', ... });
```

### 7. Claude Code Hook 格式：新旧格式不兼容（≥ 2.1.x）

**重要：Claude Code 2.1.x 起更新了 settings.json 中 hooks 的格式，旧格式会导致 hooks 完全失效。**

#### 旧格式（Claude Code < 2.1.x，现已失效）

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "command": "node universal-hook.js --agent=claude-code --event=PreToolUse",
        "async": true
      }
    ]
  }
}
```

#### 新格式（Claude Code ≥ 2.1.x，当前必须使用）

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node universal-hook.js --agent=claude-code --event=PreToolUse",
            "async": true
          }
        ]
      }
    ]
  }
}
```

#### 失败机制

旧格式不是"降级有效"或"部分有效"，而是**彻底失效**：
- Claude Code 用 Zod schema 验证 settings.json
- 旧格式条目缺少必填的 `hooks` 数组字段，schema 验证失败
- 整个 `userSettings` 被置为 `null`（而非仅忽略 hooks）
- 所有用户设置（含 hooks）被丢弃，`gd()["PreToolUse"]` = undefined
- `bb6()` 返回 false，所有 hook 都不触发
- **无任何错误提示**，agent 正常运行，数据静默丢失

#### 调试方式

在 `-p` 模式下用 `--debug-file` 可以看到 settings 加载信息，但不会直接报告 schema 失败。可用以下方式验证 hooks 格式是否正确：

```bash
# 测试 hook 是否触发（应创建文件）
echo '{"matcher":"","hooks":[{"type":"command","command":"touch /tmp/hook_test"}]}' > /tmp/test.json

# 运行 agent-tools setup --force 可自动迁移旧格式到新格式
agent-tools setup --force
```

`cli/src/detector/claude-code.js` 的 `injectHooks()` 已处理旧格式迁移（自动将老条目包裹为新格式）。

### 8. Claude Code hooks 在 `-p` 模式子进程中的触发条件

Claude Code 在 `-p`（非交互式）模式下通过 `spawnSync` 调用时，hooks **可以**正常触发，但有以下前提条件：

1. **hooks 必须使用新格式**（见 §7）。旧格式会导致 userSettings 被整体丢弃，hooks 完全不触发。
2. **不能传 `--bare` 标志**（会设置 `CLAUDE_CODE_SIMPLE=1` 跳过 hooks）。
3. **工作区信任**：`-p` 模式自动信任当前目录（跳过弹窗），无需手动配置。
4. 设置文件路径：`Y7()` 优先读 `CLAUDE_CONFIG_DIR` 环境变量，默认为 `~/.claude`。

#### `--settings` 和 project-level settings 的限制

- **`--settings <file>` 不加载 hooks**：这是 Claude Code 的安全限制，`--settings` 仅用于合并部分设置，不处理 hooks。
- **`.claude/settings.json`（project-level）不在 `-p` 模式下生效**：项目级设置因工作区信任机制，在非交互模式下可能被忽略。
- **结论**：hooks 必须注入到用户级设置 `~/.claude/settings.json`，test 命令通过临时注入并在 finally 块恢复来实现隔离。

### 9. 上报时机的并发问题

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

### Hook 采集测试命令（agent-tools test）

`agent-tools test` 是端到端测试命令，通过实际调用 Agent CLI 并验证 hooks 采集到的事件，确认整个管道正常工作。

#### 使用方式

```bash
# 测试所有已安装的 Agent
agent-tools test

# 仅测试指定 Agent
agent-tools test --agent claude-code
agent-tools test --agent codebuddy

# 调试选项：测试完成后不删除临时目录
agent-tools test --agent claude-code --keep

# 自定义超时（秒，默认 60）
agent-tools test --agent claude-code --timeout 90
```

#### 技术方案

**隔离机制**：每次测试在系统临时目录创建 `agent-tools-test-XXXX/` 文件夹，包含：
- `test.db`：专用 SQLite 测试库（与生产库完全独立）
- `work/`：Agent 工作目录（避免污染当前目录）

**Hook 注入**：测试时临时修改用户级配置（如 `~/.claude/settings.json`），注入指向 `test.db` 的同步 hooks（`--db=<path>` 参数传给 `universal-hook.js`）。测试结束后在 `finally` 块恢复原始配置。hooks 中不设置 `async: true`（同步模式），确保 Agent 进程退出时所有写入已完成。

**注入时同步迁移**：`injectTestHooks()` 在注入测试条目时，会同时将已存在的旧格式 hooks 自动迁移为新格式，避免旧格式导致整个 settings 被丢弃。

**Skill 测试**：Skill 文件临时放置在 `~/.claude/commands/<skill-name>.md`（用户级命令目录），测试完成后立即删除。注意：`--plugin-dir` 和 `.claude/skills/` 均无法在 `-p` 模式下加载 skill，必须使用 `~/.claude/commands/`。

#### Claude Code 测试场景

| 场景 | Agent 指令 | 验证事件 |
|------|-----------|---------|
| 基础工具调用 | `Write "hello" to greet.txt` | `session_start`、`user_message`、`tool_pre`、`tool_use`（含 `tool_name`、`session_id`）、`assistant_stop` |
| Skill 调用 | `/agent-tools-test-verify` | `skill_use`，`skill_name=agent-tools-test-verify` |

**注意**：`PostToolUse` 事件中不包含 token 用量（`usage` 字段为空）。token 数据仅在 Stop/SessionEnd hook 中的 `usage` 字段提供，但当前版本（2.1.x）的 Stop/SessionEnd hook 数据中也没有 token 信息，因此 token 相关字段（`token_input`/`token_output`）在工具调用事件中始终为 0。

#### CodeBuddy 测试场景

| 场景 | Agent 指令 | 验证事件 |
|------|-----------|---------|
| 基础工具调用 | `Write "hello" to greet.txt` | `tool_pre`、`tool_use`（含 `tool_name`） |

#### 关键实现文件

| 文件 | 变更说明 |
|------|---------|
| `cli/src/hooks/universal-hook.js` | 新增 `--db=<path>` 参数支持，用于写入测试库 |
| `cli/src/collector/local-store.js` | `LocalStore` 构造函数接受可选 `dbPath` 参数 |
| `cli/src/cli/test.js` | 测试命令主逻辑：临时环境 → 运行场景 → 验证 → 报告 → 清理 |
| `cli/bin/cli.js` | 注册 `test` 子命令 |

---

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

## 待实现功能清单（Phase 5）

以下三项是目前代码库中**尚未实现**的功能，优先级从高到低：

### 1. 数据保留清理任务

**文件**：`server/src/jobs/cleanup.js`（待新建）

每天定时删除超出保留期的旧数据，防止数据库无限膨胀：

- 每天凌晨 2:00 UTC 执行（使用 `node-cron`，与 daily-aggregation 错开）
- 默认保留 90 天的 events，30 天的 tool_usage_detail
- 保留期可在 `~/.agent-tools-server/config.json` 的 `retention` 字段配置

```javascript
// server/src/jobs/cleanup.js 参考结构
const cron = require('node-cron');

async function runCleanup(db, config) {
  const eventsDays = config.retention?.eventsDays ?? 90;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - eventsDays);
  const cutoffStr = cutoff.toISOString();

  await db('events').where('event_time', '<', cutoffStr).delete();
  await db('tool_usage_detail').where('stat_date', '<', cutoffStr.slice(0, 10)).delete();
}

function startCleanup(db, config) {
  // 每天 02:05 UTC
  cron.schedule('5 2 * * *', () => runCleanup(db, config));
}

module.exports = { startCleanup, runCleanup };
```

实现后在 `server/bin/server.js` 中调用 `startCleanup(db, cfg)`。

---

### 2. 服务端环境变量覆盖

**文件**：`server/src/config.js`（修改 `load()` 函数）

支持通过环境变量配置服务端，适合容器化部署，无需写入 `config.json`：

| 环境变量 | 对应配置 | 示例 |
|----------|----------|------|
| `AT_PORT` | `server.port` | `3000` |
| `AT_DB_CLIENT` | `database.client` | `better-sqlite3` / `mysql2` / `pg` |
| `AT_DB_FILE` | `database.connection.filename`（SQLite） | `/data/server.db` |
| `AT_DB_HOST` | `database.connection.host`（MySQL/PG） | `localhost` |
| `AT_DB_PORT` | `database.connection.port` | `5432` |
| `AT_DB_NAME` | `database.connection.database` | `agent_tools` |
| `AT_DB_USER` | `database.connection.user` | `root` |
| `AT_DB_PASS` | `database.connection.password` | `secret` |

```javascript
// server/src/config.js load() 修改参考
function load() {
  let cfg = fs.existsSync(CONFIG_FILE)
    ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
    : { server: { port: 3000 }, database: { client: 'better-sqlite3', connection: { filename: DEFAULT_DB_PATH }, useNullAsDefault: true } };

  // Env var overrides
  if (process.env.AT_PORT) cfg.server.port = parseInt(process.env.AT_PORT, 10);
  if (process.env.AT_DB_CLIENT) cfg.database.client = process.env.AT_DB_CLIENT;
  if (process.env.AT_DB_FILE) cfg.database.connection = { filename: process.env.AT_DB_FILE };
  if (process.env.AT_DB_HOST) {
    cfg.database.connection = {
      host: process.env.AT_DB_HOST,
      port: parseInt(process.env.AT_DB_PORT || '3306', 10),
      database: process.env.AT_DB_NAME,
      user: process.env.AT_DB_USER,
      password: process.env.AT_DB_PASS,
    };
  }
  return cfg;
}
```

---

### 3. API Key 可选鉴权

**文件**：`server/src/app.js`（添加中间件）、`server/src/config.js`（存储 key）、`cli/src/collector/uploader.js`（发送请求头）

适合将服务器暴露到公网时使用，默认关闭（内网不需要）：

**服务端**：
```javascript
// server/src/app.js 中添加 preHandler
app.addHook('preHandler', async (request, reply) => {
  const apiKey = app.config?.security?.apiKey;
  if (!apiKey) return; // 未配置 key，跳过鉴权
  // 仅对上报接口鉴权，dashboard 和 stats 不鉴权
  if (request.url.startsWith('/api/v1/events/')) {
    if (request.headers['x-agent-tools-key'] !== apiKey) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  }
});
```

**客户端**（`cli/src/collector/uploader.js`）：
```javascript
const headers = { 'Content-Type': 'application/json' };
if (cfg.apiKey) headers['X-Agent-Tools-Key'] = cfg.apiKey;
```

API Key 通过 `agent-tools init` 交互配置，或直接写入 `~/.agent-tools/config.json` 的 `apiKey` 字段。
