# Dashboard 登录功能实现方案

## Context

agent-tools 是内网部署的 AI Agent 统计平台。当前所有端点无认证，任何人可查看数据。需求：
- 数据上报（events/batch）、健康检查、客户端下载**保持公开**
- Dashboard 和 stats API **需要登录后才能访问**
- 通过公司 IDaaS 平台认证（标准 OAuth2/OIDC 协议）
- 认证模块设计为**可插拔插件**，不绑定具体 IDaaS 厂商，方便切换
- 未配置认证时保持全公开（向后兼容）

## 方案：通用 OAuth2/OIDC + 可插拔 Provider + Cookie Session

### 架构设计

```
┌─────────────────────────────────────────────────┐
│  server/src/auth/                                │
│  ├── index.js          # Auth 插件入口（注册      │
│  │                       session + provider）     │
│  ├── guard.js          # preHandler 认证守卫       │
│  └── providers/        # 可插拔 Provider          │
│      ├── oauth2.js     # 通用 OAuth2/OIDC         │
│      └── github.js     # GitHub（示例/备用）       │
└─────────────────────────────────────────────────┘
```

Provider 接口约定：

```js
// 每个 provider 导出一个 Fastify 插件，注册以下路由：
//   GET  /auth/login     → 跳转 IDaaS 登录页
//   GET  /auth/callback  → 处理回调，写入 session
// 并将用户信息写入 request.session.user = { id, login, name, avatar_url? }
```

### 端点权限划分

| 端点 | 认证 | 说明 |
|------|------|------|
| `GET /api/v1/health` | 公开 | 健康检查 |
| `POST /api/v1/events/batch` | 公开 | CLI 数据上报 |
| `GET /api/v1/client/version` | 公开 | 版本查询 |
| `GET /api/v1/client/download` | 公开 | 客户端下载 |
| `GET /api/v1/stats/*` | **需登录** | 所有统计查询 |
| `GET /dashboard/*` | 公开 | 静态 HTML（前端检查 session） |
| `GET /auth/login` | 公开 | 跳转 IDaaS 登录 |
| `GET /auth/callback` | 公开 | OAuth 回调 |
| `GET /auth/session` | 公开 | 返回当前登录状态 |
| `POST /auth/logout` | 公开 | 退出登录 |

---

## 实现步骤

### 1. 安装依赖

```bash
cd server && npm install @fastify/oauth2 @fastify/cookie @fastify/session
```

### 2. 新建 `server/src/auth/providers/oauth2.js` — 通用 OAuth2/OIDC Provider

适配任意 IDaaS 平台，通过配置指定 authorize/token/userinfo 端点：

```js
const oauthPlugin = require('@fastify/oauth2');

module.exports = async function oauth2Provider(fastify, opts) {
  const { auth, serverPort } = opts;

  fastify.register(oauthPlugin, {
    name: 'idaas',
    credentials: {
      client: { id: auth.clientId, secret: auth.clientSecret },
      auth: {
        authorizeHost: auth.authorizeHost,     // e.g. "https://idaas.company.com"
        authorizePath: auth.authorizePath || '/oauth/authorize',
        tokenHost: auth.tokenHost || auth.authorizeHost,
        tokenPath: auth.tokenPath || '/oauth/token',
      },
    },
    startRedirectPath: '/auth/login',
    callbackUri: auth.callbackUrl || `http://localhost:${serverPort}/auth/callback`,
    scope: auth.scope || ['openid', 'profile'],
  });

  fastify.get('/auth/callback', async (request, reply) => {
    const token = await fastify.idaas.getAccessTokenFromAuthorizationCodeFlow(request);
    const accessToken = token.token.access_token;

    // 从 userinfo 端点获取用户信息
    const userinfoUrl = auth.userinfoUrl || `${auth.authorizeHost}/oauth/userinfo`;
    const res = await fetch(userinfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const user = await res.json();

    // 标准化用户字段（不同 IDaaS 返回格式可能不同，通过配置映射）
    request.session.user = {
      id:   user[auth.fieldMap?.id   || 'sub'],
      login: user[auth.fieldMap?.login || 'preferred_username'] || user.name,
      name:  user[auth.fieldMap?.name  || 'name'],
      avatar_url: user[auth.fieldMap?.avatar || 'picture'] || null,
    };

    reply.redirect('/dashboard/index.html');
  });
};
```

### 3. 新建 `server/src/auth/providers/github.js` — GitHub Provider（示例/备用）

```js
const oauthPlugin = require('@fastify/oauth2');

module.exports = async function githubProvider(fastify, opts) {
  const { auth, serverPort } = opts;

  fastify.register(oauthPlugin, {
    name: 'github',
    credentials: {
      client: { id: auth.clientId, secret: auth.clientSecret },
      auth: oauthPlugin.GITHUB_CONFIGURATION,
    },
    startRedirectPath: '/auth/login',
    callbackUri: auth.callbackUrl || `http://localhost:${serverPort}/auth/callback`,
    scope: ['read:user'],
  });

  fastify.get('/auth/callback', async (request, reply) => {
    const token = await fastify.github.getAccessTokenFromAuthorizationCodeFlow(request);
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token.token.access_token}` },
    });
    const user = await res.json();
    request.session.user = {
      id: user.id,
      login: user.login,
      name: user.name,
      avatar_url: user.avatar_url,
    };
    reply.redirect('/dashboard/index.html');
  });
};
```

### 4. 新建 `server/src/auth/index.js` — Auth 插件入口

```js
const crypto = require('crypto');

module.exports = async function authPlugin(fastify, opts) {
  const { config } = opts;
  const auth = config.auth || {};
  const provider = auth.provider; // "oauth2" | "github" | 自定义
  const serverPort = config.server?.port || 3000;

  // 注册 cookie + session
  fastify.register(require('@fastify/cookie'));
  fastify.register(require('@fastify/session'), {
    secret: auth.sessionSecret || crypto.randomBytes(32).toString('hex'),
    cookie: { secure: 'auto', maxAge: 7 * 24 * 60 * 60 * 1000 },
  });

  // 加载 provider 插件
  const providerPlugin = require(`./providers/${provider}`);
  fastify.register(providerPlugin, { auth, serverPort });

  // 会话查询
  fastify.get('/auth/session', async (request) => ({
    authenticated: !!request.session?.user,
    user: request.session?.user || null,
  }));

  // 登出
  fastify.post('/auth/logout', async (request) => {
    request.session.destroy();
    return { message: 'Logged out' };
  });
};
```

### 5. 新建 `server/src/auth/guard.js` — 认证守卫

OAuth 登录成功后，还需检查该用户是否在白名单中：

```js
async function authGuard(request, reply) {
  if (!request.session?.user) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
  // 检查用户是否被允许访问（白名单）
  if (!request.session.user.approved) {
    return reply.status(403).send({ error: 'Forbidden', message: '账号未获授权，请联系管理员' });
  }
}
module.exports = { authGuard };
```

### 6. 新建数据库 migration `server/migrations/005_create_allowed_users.js`

用户白名单表：

```js
exports.up = function(knex) {
  return knex.schema.createTable('allowed_users', t => {
    t.increments('id').primary();
    t.string('login').notNullable().unique();  // OAuth 用户名
    t.string('name');                           // 显示名
    t.string('role').defaultTo('viewer');        // "admin" | "viewer"
    t.string('created_by');                     // 谁添加的
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
};
exports.down = function(knex) {
  return knex.schema.dropTable('allowed_users');
};
```

### 7. 修改 `server/src/auth/index.js` — 回调中检查白名单

OAuth 回调成功后，查数据库判断用户是否被允许：

```js
// 在 provider 回调写入 session.user 后：
const allowed = await db('allowed_users').where('login', user.login).first();
request.session.user.approved = !!allowed;
request.session.user.role = allowed?.role || null;
```

管理员在 config.json 中配置 `auth.adminUsers: ["zhangsan"]`，server 启动时自动写入 `allowed_users` 表（role=admin）。

### 8. 新建 `server/src/routes/admin.js` — 用户管理 API

管理员专属端点，CRUD 白名单用户：

```
GET    /api/v1/admin/users          → 列出所有允许的用户
POST   /api/v1/admin/users          → 添加用户 { login, name, role }
DELETE /api/v1/admin/users/:login   → 移除用户
```

带 admin 角色校验：

```js
instance.addHook('preHandler', async (request, reply) => {
  if (request.session?.user?.role !== 'admin') {
    return reply.status(403).send({ error: 'Admin access required' });
  }
});
```

### 9. 修改 `server/src/app.js`

```js
function buildApp(db, config) {
  const app = require('fastify')({ logger: true });
  const authEnabled = !!(config.auth?.provider && config.auth?.clientId);

  app.register(require('@fastify/cors'));

  // Auth 插件（可选）
  if (authEnabled) {
    app.register(require('./auth'), { config, db });
  }

  // 静态文件 + 公开路由
  app.register(require('@fastify/static'), { root: ..., prefix: '/dashboard/' });
  app.get('/', (req, reply) => reply.redirect('/dashboard/index.html'));
  app.register(require('./routes/health'), { config });
  app.register(require('./routes/events'), { db });
  app.register(require('./routes/client'));

  // Stats 路由（带认证 + 白名单守卫）
  app.register(async function protectedStats(instance) {
    if (authEnabled) {
      const { authGuard } = require('./auth/guard');
      instance.addHook('preHandler', authGuard);
    }
    instance.register(require('./routes/stats'), { db });
  });

  // Admin 路由（管理员专属）
  if (authEnabled) {
    app.register(require('./routes/admin'), { db });
  }

  return app;
}
```

### 10. 修改 `server/src/config.js`

默认配置增加 auth 段：

```js
{
  auth: {
    provider: '',          // "oauth2" | "github" | 留空=不启用
    clientId: '',
    clientSecret: '',
    callbackUrl: '',
    sessionSecret: '',
    adminUsers: [],        // 管理员用户名列表（config 指定）
    // 通用 OAuth2 专用：
    authorizeHost: '',
    authorizePath: '',
    tokenPath: '',
    userinfoUrl: '',
    scope: [],
    fieldMap: {}
  }
}
```

### 11. 修改 `server/src/init-wizard.js`

向导末尾增加可选认证配置：

```
? 是否启用登录认证？(y/N) y
? 认证方式: (oauth2 / github) oauth2
? OAuth2 授权服务器地址: https://idaas.company.com
? Client ID: xxx
? Client Secret: xxx
? 管理员用户名（逗号分隔）: zhangsan,lisi
```

### 12. 修改 Dashboard (`server/src/dashboard/index.html`)

#### Header 增加登录/登出 UI

```html
<span id="user-info" style="display:none;color:#fff;font-size:13px;"></span>
<a id="login-btn" href="/auth/login" style="display:none;color:#8fc;">登录</a>
<button id="logout-btn" style="display:none;">登出</button>
```

#### 新增「用户管理」Tab（仅管理员可见）

在现有 Tab 栏（概览/排名/钻取/工具与技能）后增加第 5 个 Tab：

```html
<button id="tab-admin" style="display:none;">用户管理</button>
```

内容区：用户列表表格 + 添加用户表单 + 删除按钮

```
┌──────────────────────────────────────────────┐
│  用户管理                                      │
│                                               │
│  [添加用户]  用户名: [______] 角色: [viewer ▾] [添加] │
│                                               │
│  用户名     | 显示名   | 角色   | 添加人  | 操作  │
│  zhangsan  | 张三    | admin  | config | —    │
│  wangwu    | 王五    | viewer | admin  | [删除]│
└──────────────────────────────────────────────┘
```

#### JavaScript 认证检查 + 401/403 处理

```js
async function checkAuth() {
  try {
    const res = await fetch('/auth/session');
    const data = await res.json();
    if (data.authenticated && data.user.approved) {
      // 显示用户名 + 登出
      if (data.user.role === 'admin') {
        // 显示「用户管理」Tab
      }
    } else if (data.authenticated && !data.user.approved) {
      // 已登录但未授权：显示"请联系管理员"
    } else {
      // 未登录：显示登录按钮
    }
  } catch {
    // auth 未启用
  }
}

// apiFetch 中处理 401/403
if (res.status === 401) showLoginPrompt();
if (res.status === 403) showForbiddenPrompt();
```

---

## 配置示例

### 示例 1：公司 IDaaS（通用 OAuth2）

```json
{
  "auth": {
    "provider": "oauth2",
    "clientId": "agent-tools-app",
    "clientSecret": "xxx",
    "authorizeHost": "https://idaas.company.com",
    "authorizePath": "/oauth/authorize",
    "tokenPath": "/oauth/token",
    "userinfoUrl": "https://idaas.company.com/oauth/userinfo",
    "scope": ["openid", "profile"],
    "sessionSecret": "minimum-32-chars-random-string-here",
    "fieldMap": { "id": "sub", "login": "preferred_username", "name": "name" }
  }
}
```

### 示例 2：GitHub（开发/测试用）

```json
{
  "auth": {
    "provider": "github",
    "clientId": "Ov23li...",
    "clientSecret": "xxx",
    "sessionSecret": "minimum-32-chars-random-string-here"
  }
}
```

### 示例 3：不启用认证（默认）

```json
{}
```

---

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `server/package.json` | 修改 | 添加 `@fastify/oauth2`, `@fastify/cookie`, `@fastify/session` |
| `server/src/auth/index.js` | **新建** | Auth 插件入口：cookie + session + provider + 白名单校验 |
| `server/src/auth/guard.js` | **新建** | 认证 + 授权守卫（检查 session + approved） |
| `server/src/auth/providers/oauth2.js` | **新建** | 通用 OAuth2/OIDC provider（适配任意 IDaaS） |
| `server/src/auth/providers/github.js` | **新建** | GitHub provider（示例/备用） |
| `server/src/routes/admin.js` | **新建** | 用户管理 API（CRUD 白名单，管理员专属） |
| `server/migrations/005_create_allowed_users.js` | **新建** | 白名单用户表 |
| `server/src/app.js` | 修改 | 条件注册 auth/admin 插件，stats 加认证守卫 |
| `server/src/config.js` | 修改 | 默认配置增加 auth 段（含 adminUsers） |
| `server/src/init-wizard.js` | 修改 | 向导增加可选认证 + 管理员配置 |
| `server/src/dashboard/index.html` | 修改 | 登录/登出 UI + 用户管理 Tab + 401/403 处理 |
| `server/bin/server.js` | 修改 | 启动时同步 adminUsers → allowed_users 表 |

---

## 用户访问流程

```
用户访问 Dashboard
  │
  ├─ auth 未启用 → 全公开（向后兼容）
  │
  └─ auth 已启用 → 检查 /auth/session
       │
       ├─ 未登录 → 显示 "登录" 按钮
       │     └─ 点击 → 跳转 IDaaS → 回调 → 查白名单
       │           ├─ 在白名单中 → session.approved=true → 进入 Dashboard
       │           └─ 不在白名单 → session.approved=false → 显示 "请联系管理员"
       │
       └─ 已登录
            ├─ approved=true, role=viewer → 正常使用 Dashboard
            └─ approved=true, role=admin  → 正常使用 + 显示「用户管理」Tab
```

## 扩展新 Provider

在 `server/src/auth/providers/` 下新建文件，实现 `/auth/login` 和 `/auth/callback`，
回调中写入 `request.session.user = { id, login, name }`，配置 `"provider": "xxx"` 即可。

---

## 验证方案

### 测试 1：无认证模式（向后兼容）

```bash
# 不配置 auth，启动 server
node server/bin/server.js --port 3000

# 验证：所有端点公开
curl http://localhost:3000/api/v1/health          # → 200
curl http://localhost:3000/api/v1/stats/summary    # → 200（无守卫）

# 验证：Dashboard 无登录按钮
# 浏览器打开 http://localhost:3000 → 不显示登录/登出按钮，无用户管理 Tab
```

### 测试 2：GitHub OAuth 登录（开发环境）

```bash
# 前置：在 GitHub 创建 OAuth App
#   Homepage URL: http://localhost:3000
#   Callback URL: http://localhost:3000/auth/callback

# 配置 auth（写入 ~/.agent-tools-server/config.json）
# {
#   "auth": {
#     "provider": "github",
#     "clientId": "Ov23li...",
#     "clientSecret": "xxx",
#     "adminUsers": ["your-github-username"],
#     "sessionSecret": "at-least-32-chars-random-string-here!!"
#   }
# }

node server/bin/server.js --port 3000
```

**验证步骤：**

| # | 操作 | 预期结果 |
|---|------|---------|
| 1 | 浏览器访问 `http://localhost:3000` | Dashboard 显示 "登录" 按钮 |
| 2 | `curl /api/v1/stats/summary` | 401 Unauthorized |
| 3 | `curl /api/v1/health` | 200（公开端点不受影响） |
| 4 | `curl -X POST /api/v1/events/batch` | 200（上报端点不受影响） |
| 5 | 点击 "登录" → GitHub 授权 | 跳转 GitHub → 授权 → 回调 |
| 6 | 授权完成 | 重定向到 Dashboard，显示用户名 + 登出按钮 |
| 7 | 管理员看到「用户管理」Tab | 因为在 adminUsers 中 |
| 8 | 刷新页面 `curl /api/v1/stats/summary`（带 cookie） | 200（session 有效） |

### 测试 3：白名单管理

| # | 操作 | 预期结果 |
|---|------|---------|
| 1 | 用非白名单 GitHub 账号登录 | 登录成功但 Dashboard 显示 "请联系管理员" |
| 2 | `curl /api/v1/stats/summary`（带该用户 cookie） | 403 Forbidden |
| 3 | 管理员打开「用户管理」Tab → 添加该用户 | POST /api/v1/admin/users 成功 |
| 4 | 该用户刷新页面 | Dashboard 正常显示数据 |
| 5 | 管理员删除该用户 | DELETE /api/v1/admin/users/:login 成功 |
| 6 | 该用户再次刷新 | 回到 "请联系管理员" 状态 |

### 测试 4：Admin 权限隔离

| # | 操作 | 预期结果 |
|---|------|---------|
| 1 | 普通用户（viewer）请求 `GET /api/v1/admin/users` | 403 Admin access required |
| 2 | 管理员请求 `GET /api/v1/admin/users` | 200 + 用户列表 |
| 3 | 普通用户看不到「用户管理」Tab | Tab 按钮 display:none |

### 测试 5：公开端点始终可用

```bash
# 无论 auth 是否启用，无论是否登录，以下端点始终返回 200
curl http://localhost:3000/api/v1/health
curl http://localhost:3000/api/v1/client/version
curl http://localhost:3000/api/v1/client/download  # 需 dist/cli.tgz 存在
curl -X POST http://localhost:3000/api/v1/events/batch \
  -H 'Content-Type: application/json' \
  -d '{"events":[]}'
```

### 测试 6：通用 OAuth2 Provider（IDaaS）

```bash
# 配置 auth.provider = "oauth2"，填入 IDaaS 端点
# 验证同测试 2 的流程，但跳转目标是 IDaaS 而非 GitHub
# 验证 fieldMap 正确映射用户字段
```
