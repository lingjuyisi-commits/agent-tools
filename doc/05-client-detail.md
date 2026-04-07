# 客户端详细设计

## 1. CLI命令设计

### 1.1 命令总览

```bash
# 安装
npm install -g agent-tools

# 首次初始化 - 指定服务器地址（必须先执行）
agent-tools init
# 交互式向导:
#   ? Server URL: (http://localhost:3000)
#   ? Confirm: y
# 或非交互模式:
agent-tools init --server http://localhost:3000
agent-tools init --server https://stats.company.com:8080

# 自动检测并配置Agent（向用户级settings.json注入hooks）
agent-tools setup [--force] [--agent=claude-code,codebuddy]

# 查看检测到的Agent
agent-tools agents

# 本地统计（离线可用，数据存储在~/.agent-tools/data/）
agent-tools stats [--period=day|week|month] [--model=xxx] [--date=2026-04-07]

# 手动触发上报
agent-tools sync

# 查看当前配置和状态
agent-tools status
```

### 1.2 init命令流程（首次安装必须）

```
agent-tools init [--server <url>]
  │
  ├─ 1. 创建 ~/.agent-tools/ 目录结构
  │     ├─ config.json
  │     └─ data/
  │
  ├─ 2. 交互式询问或从参数获取:
  │     └─ 服务器地址 (默认 http://localhost:3000)
  │
  ├─ 3. 测试服务器连通性 (GET /api/v1/health)
  │     ├─ 成功: 保存配置
  │     └─ 失败: 警告但仍保存(支持离线先配置)
  │
  └─ 4. 自动触发 setup 流程
```

**~/.agent-tools/config.json 示例：**
```json
{
  "server": {
    "url": "http://localhost:3000"
  },
  "sync": {
    "batchSize": 100,
    "intervalSeconds": 300
  },
  "initialized": true,
  "initTime": "2026-04-07T10:00:00Z"
}
```

### 1.3 setup命令流程

```
agent-tools setup
  │
  ├─ 0. 检查是否已init，未init则提示先执行init
  │
  ├─ 1. 检测平台 (darwin/linux/win32)
  │
  ├─ 2. 扫描已安装的编程Agent (当前: Claude Code + CodeBuddy)
  │     ├─ 检查CLI命令 (which/where)
  │     ├─ 检查用户级配置目录是否存在
  │     └─ 输出检测结果列表
  │
  ├─ 3. 对每个检测到的Agent:
  │     ├─ 读取用户级配置文件 (~/.claude/settings.json 等)
  │     ├─ 检查是否已配置agent-tools hooks
  │     ├─ 生成hook配置(使用模板)
  │     ├─ 合并到现有配置(不覆盖用户已有hooks)
  │     └─ 写入用户级配置文件
  │
  ├─ 4. 配置MCP Server(对支持MCP的Agent)
  │
  └─ 5. 输出配置摘要
       ├─ 已配置的Agent列表
       └─ 服务器连接状态
```

### 1.4 配置合并策略

**核心原则：不破坏用户现有配置**

```javascript
function mergeHooksConfig(existingConfig, agentToolsHooks) {
  const config = JSON.parse(JSON.stringify(existingConfig));
  
  for (const [event, hooks] of Object.entries(agentToolsHooks)) {
    if (!config.hooks) config.hooks = {};
    if (!config.hooks[event]) config.hooks[event] = [];
    
    // 检查是否已存在agent-tools的hook
    const hasAgentTools = config.hooks[event].some(h => 
      h.command && h.command.includes('agent-tools')
    );
    
    if (!hasAgentTools) {
      // 追加到末尾，不影响已有hooks
      config.hooks[event].push(...hooks);
    } else {
      // 更新已有的agent-tools hook（版本更新场景）
      config.hooks[event] = config.hooks[event].map(h => {
        if (h.command && h.command.includes('agent-tools')) {
          return hooks[0]; // 替换为新版
        }
        return h;
      });
    }
  }
  
  return config;
}
```

## 2. 通用Hook脚本设计

### 2.1 universal-hook.js

所有Agent的hook最终都调用此脚本，它负责：
1. 从stdin读取Agent传入的事件JSON
2. 通过适配器转换为统一格式
3. 写入本地缓存
4. 触发异步上报（如有必要）

```javascript
#!/usr/bin/env node

const { stdin, argv } = process;
const { normalize } = require('./adapters');
const { LocalStore } = require('../collector/local-store');
const { Uploader } = require('../collector/uploader');

async function main() {
  const agent = argv.find(a => a.startsWith('--agent='))?.split('=')[1];
  const event = argv.find(a => a.startsWith('--event='))?.split('=')[1];
  
  // 读取stdin
  let input = '';
  for await (const chunk of stdin) input += chunk;
  
  const rawEvent = input ? JSON.parse(input) : {};
  
  // 适配为统一格式
  const normalized = normalize(agent, event, rawEvent);
  
  // 写入本地缓存
  const store = new LocalStore();
  await store.insert(normalized);
  
  // 检查是否需要上报
  const uploader = new Uploader();
  await uploader.checkAndSync();
}

main().catch(() => process.exit(0)); // hook不应阻塞Agent运行
```

### 2.2 事件标准化格式

```typescript
interface NormalizedEvent {
  event_id: string;           // UUID v4
  
  // 来源
  agent: string;              // claude-code | codebuddy | opencode | ...
  agent_version?: string;
  
  // 用户与机器
  username: string;           // os.userInfo().username
  hostname: string;           // os.hostname()
  platform: string;           // os.platform()
  
  // 会话
  session_id: string;
  conversation_turn?: number;
  
  // 事件
  event_type: string;         // session_start | session_end | tool_use | skill_use | message | ...
  event_time: string;         // ISO 8601
  
  // 模型
  model?: string;
  
  // Token
  token_input?: number;
  token_output?: number;
  token_cache_read?: number;
  token_cache_write?: number;
  
  // Tool/Skill
  tool_name?: string;
  skill_name?: string;
  
  // 文件变更
  files_created?: number;
  files_modified?: number;
  lines_added?: number;
  lines_removed?: number;
  
  // 扩展
  extra?: Record<string, unknown>;
}
```

### 2.3 各Agent适配器示例

**Claude Code适配器：**

```javascript
function adaptClaudeCode(eventType, raw) {
  // Claude Code hook通过stdin传入的JSON结构
  // SessionStart: { session_id, cwd, ... }
  // PostToolUse: { session_id, tool_name, tool_input, tool_output, ... }
  
  const base = {
    agent: 'claude-code',
    session_id: raw.session_id,
    event_type: mapEventType(eventType),
  };
  
  if (eventType === 'PostToolUse') {
    base.tool_name = raw.tool_name;
    // 从tool_output中提取token信息（如果有）
    if (raw.usage) {
      base.token_input = raw.usage.input_tokens;
      base.token_output = raw.usage.output_tokens;
    }
  }
  
  return base;
}

function mapEventType(claudeEvent) {
  const map = {
    'SessionStart': 'session_start',
    'SessionEnd': 'session_end',
    'PreToolUse': 'tool_pre',
    'PostToolUse': 'tool_use',
    'UserPromptSubmit': 'user_message',
    'Stop': 'assistant_stop',
  };
  return map[claudeEvent] || claudeEvent.toLowerCase();
}
```

**Copilot CLI适配器：**

```javascript
function adaptCopilot(eventType, raw) {
  return {
    agent: 'copilot-cli',
    session_id: raw.sessionId || raw.session_id,
    event_type: mapEventType(eventType),
    tool_name: raw.toolName || raw.tool_name,
  };
}
```

## 3. 本地存储设计

### 3.1 本地数据目录

所有客户端数据存放于用户目录 `~/.agent-tools/data/` 下：

```
~/.agent-tools/
├── config.json                    # 客户端配置
└── data/
    └── local.db                   # SQLite (事件缓存 + 本地统计)
```

### 3.2 SQLite Schema

```sql
-- 客户端本地SQLite (~/.agent-tools/data/local.db)
-- 用于离线缓存和本地统计查询
CREATE TABLE local_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL,
  data TEXT NOT NULL,          -- JSON序列化的NormalizedEvent
  created_at TEXT NOT NULL,    -- ISO 8601
  synced INTEGER DEFAULT 0,   -- 0=未同步, 1=已同步
  synced_at TEXT DEFAULT NULL
);

CREATE INDEX idx_synced ON local_events(synced, created_at);
CREATE INDEX idx_created ON local_events(created_at);
```

### 3.3 上报策略

```javascript
class Uploader {
  constructor() {
    // 从 ~/.agent-tools/config.json 读取配置
    const config = loadConfig();
    this.batchSize = config.sync?.batchSize || 100;
    this.syncInterval = config.sync?.intervalSeconds || 300;
    this.serverUrl = config.server?.url || 'http://localhost:3000';
    // 上报接口无需鉴权
  }

  async checkAndSync() {
    const store = new LocalStore();  // 读写 ~/.agent-tools/data/local.db
    const unsyncedCount = await store.getUnsyncedCount();
    const lastSync = await store.getLastSyncTime();
    const elapsed = (Date.now() - lastSync) / 1000;
    
    if (unsyncedCount >= this.batchSize || elapsed >= this.syncInterval) {
      await this.sync();
    }
  }

  async sync() {
    const store = new LocalStore();
    const events = await store.getUnsynced(this.batchSize);
    if (events.length === 0) return;
    
    try {
      const response = await fetch(`${this.serverUrl}/api/v1/events/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 无需Authorization header
        body: JSON.stringify({ events }),
      });
      
      if (response.ok) {
        const ids = events.map(e => e.event_id);
        await store.markSynced(ids);
      }
    } catch (err) {
      // 网络失败不阻塞，下次再试
    }
  }
}
```

## 4. 跨平台处理

### 4.1 路径处理

```javascript
const os = require('os');
const path = require('path');

// agent-tools自身数据目录
const AGENT_TOOLS_HOME = path.join(os.homedir(), '.agent-tools');
const AGENT_TOOLS_CONFIG = path.join(AGENT_TOOLS_HOME, 'config.json');
const AGENT_TOOLS_DB = path.join(AGENT_TOOLS_HOME, 'data', 'local.db');

// 各Agent的用户级配置文件路径
function getAgentUserConfigPath(agent) {
  const home = os.homedir();
  
  const paths = {
    'claude-code': path.join(home, '.claude', 'settings.json'),
    'codebuddy': path.join(home, '.codebuddy', 'settings.json'),
  };
  
  return paths[agent];
}
```

### 4.2 用户信息获取

```javascript
const os = require('os');

function getUserInfo() {
  return {
    username: os.userInfo().username,   // 跨平台统一
    hostname: os.hostname(),
    platform: os.platform(),            // darwin | linux | win32
    homeDir: os.homedir(),
    shell: process.env.SHELL || process.env.COMSPEC || 'unknown',
  };
}
```

## 5. postinstall脚本

```javascript
#!/usr/bin/env node
// scripts/postinstall.js
// 检测已安装Agent并提示执行init

const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const agents = [
  { name: 'Claude Code', cmd: 'claude' },
  { name: 'CodeBuddy', cmd: 'codebuddy' },
];

function isInstalled(cmd) {
  try {
    const check = os.platform() === 'win32' ? 'where' : 'which';
    execSync(`${check} ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

console.log('\n[agent-tools] Scanning for installed AI coding agents...\n');

const detected = agents.filter(a => isInstalled(a.cmd));

if (detected.length > 0) {
  console.log('  Detected:');
  detected.forEach(a => console.log(`    + ${a.name}`));
} else {
  console.log('  No supported AI coding agents detected in PATH.');
}

// 检查是否已初始化
const configPath = path.join(os.homedir(), '.agent-tools', 'config.json');
if (fs.existsSync(configPath)) {
  console.log('\n  Already initialized. Run "agent-tools setup" to update hooks.\n');
} else {
  console.log('\n  Run "agent-tools init" to initialize (set server address).');
  console.log('  For local development: agent-tools init --server http://localhost:3000\n');
}
```
