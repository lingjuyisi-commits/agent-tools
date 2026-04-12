# 接入指导文档

本文档介绍如何接入 agent-tools 的两个扩展功能：**登录认证**和**外部数据同步**。

---

## 一、登录认证接入

### 1.1 功能概述

agent-tools 支持可选的 OAuth2/OIDC 登录认证。启用后：

- **数据上报、健康检查、客户端下载** — 保持公开（CLI 正常工作）
- **Dashboard 和统计 API** — 需要登录后才能访问
- **用户白名单** — 管理员在 Dashboard 中管理允许访问的用户

未配置认证时，所有端点保持公开（向后兼容）。

### 1.2 前置准备

在公司 IDaaS 平台（或 GitHub）创建一个 OAuth 应用：

| 配置项 | 值 |
|--------|-----|
| 应用名称 | agent-tools |
| Homepage URL | `http://your-server:3000` |
| Callback URL | `http://your-server:3000/auth/callback` |
| 授权范围 (Scope) | `openid profile`（IDaaS）或 `read:user`（GitHub） |

创建完成后获得 **Client ID** 和 **Client Secret**。

### 1.3 配置认证

编辑服务器配置文件 `~/.agent-tools-server/config.json`，添加 `auth` 段：

#### 方式一：通用 OAuth2/OIDC（推荐，适配任意 IDaaS）

```json
{
  "server": { "port": 3000 },
  "database": { "..." : "..." },
  "auth": {
    "provider": "oauth2",
    "clientId": "your-client-id",
    "clientSecret": "your-client-secret",
    "authorizeHost": "https://idaas.company.com",
    "authorizePath": "/oauth/authorize",
    "tokenPath": "/oauth/token",
    "userinfoUrl": "https://idaas.company.com/oauth/userinfo",
    "scope": ["openid", "profile"],
    "callbackUrl": "http://your-server:3000/auth/callback",
    "sessionSecret": "至少32个字符的随机字符串用于签名session",
    "adminUsers": ["admin-username"],
    "fieldMap": {
      "id": "sub",
      "login": "preferred_username",
      "name": "name",
      "avatar": "picture"
    }
  }
}
```

**配置项说明：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `provider` | 是 | `"oauth2"` 或 `"github"` |
| `clientId` | 是 | OAuth 应用的 Client ID |
| `clientSecret` | 是 | OAuth 应用的 Client Secret |
| `authorizeHost` | 是 | IDaaS 授权服务器域名（如 `https://idaas.company.com`） |
| `authorizePath` | 否 | 授权路径，默认 `/oauth/authorize` |
| `tokenPath` | 否 | Token 路径，默认 `/oauth/token` |
| `tokenHost` | 否 | Token 服务器，默认同 `authorizeHost` |
| `userinfoUrl` | 否 | 用户信息端点，默认 `{authorizeHost}/oauth/userinfo` |
| `scope` | 否 | 授权范围，默认 `["openid", "profile"]` |
| `callbackUrl` | 否 | 回调地址，默认 `http://localhost:{port}/auth/callback` |
| `sessionSecret` | 否 | Session 签名密钥（建议配置，否则每次重启生成随机值） |
| `adminUsers` | 否 | 管理员用户名列表（服务器启动时自动写入数据库） |
| `fieldMap` | 否 | IDaaS userinfo 字段映射，见下方说明 |

**fieldMap 说明：**

不同 IDaaS 平台返回的用户信息字段名可能不同。通过 `fieldMap` 配置映射：

```json
{
  "id": "sub",                    // 用户唯一标识（OIDC 标准为 sub）
  "login": "preferred_username",  // 登录用户名（显示在 Dashboard 和排名中）
  "name": "name",                 // 显示名称
  "avatar": "picture"             // 头像 URL
}
```

#### 方式二：GitHub OAuth（开发/测试用）

```json
{
  "auth": {
    "provider": "github",
    "clientId": "Ov23li...",
    "clientSecret": "your-github-secret",
    "sessionSecret": "至少32个字符的随机字符串",
    "adminUsers": ["your-github-username"]
  }
}
```

GitHub provider 自动使用 GitHub API 获取用户信息，无需配置 `authorizeHost` 和 `fieldMap`。

### 1.4 管理用户白名单

启动服务器后：

1. `adminUsers` 中的用户自动获得管理员权限
2. 管理员登录 Dashboard 后可在**「用户管理」Tab** 中添加/删除允许访问的用户
3. 非白名单用户登录后会看到"请联系管理员"提示

**用户管理 API（管理员专用）：**

```bash
# 查看所有用户
curl http://your-server:3000/api/v1/admin/users

# 添加用户
curl -X POST http://your-server:3000/api/v1/admin/users \
  -H "Content-Type: application/json" \
  -d '{"login": "zhangsan", "name": "张三", "role": "viewer"}'

# 删除用户
curl -X DELETE http://your-server:3000/api/v1/admin/users/zhangsan
```

角色说明：
- `admin` — 可访问 Dashboard + 管理用户白名单
- `viewer` — 仅可访问 Dashboard

### 1.5 扩展新的认证 Provider

如需对接其他认证系统（如企业微信、CAS 等），只需：

1. 在 `server/src/auth/providers/` 下新建文件（如 `wechat-work.js`）
2. 导出一个 Fastify 插件，注册两个路由：
   - `GET /auth/login` — 跳转到认证页面
   - `GET /auth/callback` — 处理回调，将用户信息写入 `request.session.user`
3. 配置 `"provider": "wechat-work"` 并在 `auth/index.js` 的 `VALID_PROVIDERS` 数组中添加

```js
// server/src/auth/providers/wechat-work.js 示例骨架
module.exports = async function wechatWorkProvider(fastify, opts) {
  const { auth, serverPort } = opts;

  fastify.get('/auth/login', async (request, reply) => {
    // 构造企业微信授权 URL 并重定向
    const authUrl = `https://open.work.weixin.qq.com/...`;
    reply.redirect(authUrl);
  });

  fastify.get('/auth/callback', async (request, reply) => {
    const { code } = request.query;
    // 用 code 换取 access_token，获取用户信息
    // ...
    request.session.user = { id: userId, login: userId, name: userName };
    reply.redirect('/dashboard/index.html');
  });
};
```

### 1.6 认证相关端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/auth/login` | GET | 跳转到 IDaaS 登录页 |
| `/auth/callback` | GET | OAuth 回调（由 IDaaS 调用） |
| `/auth/session` | GET | 查询当前登录状态：`{ authenticated, user: { login, name, approved, role } }` |
| `/auth/logout` | POST | 退出登录，清除 session |

---

## 二、外部数据同步接入

### 2.1 功能概述

agent-tools 支持从外部系统（如公司 AI 网关、统一计费平台）接收日粒度聚合的使用数据。外部数据会与本地 hook 采集的数据**合并显示**在 Dashboard 的概览和排名中。

**关键规则**：`tool_type = "cli"` 的外部数据不参与统计，只统计 `plugin` 和 `ide` 类型。

### 2.2 API 接口

```
POST /api/v1/external/daily-stats
Content-Type: application/json
```

**请求体：**

```json
{
  "records": [
    {
      "username": "zhangsan",
      "name": "张三",
      "tool_type": "plugin",
      "model": "gpt-4",
      "token_in": 5000,
      "token_out": 15000,
      "request_count": 50,
      "sync_time": "2026-04-12T10:00:00Z"
    },
    {
      "username": "lisi",
      "name": "李四",
      "tool_type": "ide",
      "model": "claude-sonnet",
      "token_in": 3000,
      "token_out": 10000,
      "request_count": 30,
      "sync_time": "2026-04-12T10:00:00Z"
    }
  ]
}
```

**字段说明：**

| 字段 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `username` | 是 | string | 用户名（与本地 hook 采集的用户名一致时会合并统计） |
| `name` | 否 | string | 用户显示名 |
| `tool_type` | 否 | string | 工具类型：`cli` / `plugin` / `ide`。`cli` 类型数据不计入统计 |
| `model` | 否 | string | 模型名称，默认 `"unknown"` |
| `token_in` | 否 | number | 输入 Token 数 |
| `token_out` | 否 | number | 输出 Token 数 |
| `request_count` | 否 | number | 请求次数 |
| `sync_time` | 是 | string | 同步时间（ISO 8601 格式），取日期部分作为统计日期 |

**响应：**

```json
{
  "inserted": 2,
  "updated": 0,
  "skipped": 0,
  "total": 2
}
```

| 字段 | 说明 |
|------|------|
| `inserted` | 新插入的记录数 |
| `updated` | 更新的记录数（同一天+用户+模型重复推送时覆盖更新） |
| `skipped` | 跳过的记录数（缺少必填字段） |
| `total` | 总记录数 |

### 2.3 去重与更新

按 `[日期, 用户名, 模型]` 去重：

- **首次推送**：插入新记录
- **重复推送**：更新 token 和请求次数（覆盖，非累加）

因此外部系统可以安全地重复推送同一天的数据，不会产生重复统计。

### 2.4 数据如何在 Dashboard 显示

外部数据与本地 hook 数据在查询时自动合并：

| Dashboard 位置 | 合并方式 |
|----------------|---------|
| **概览 KPI** | Token 合计 = hook token + external token（排除 cli） |
| **排名表** | 同一 username 的 hook 数据和 external 数据求和显示为一行 |
| **用户数** | 去重计数（同一用户在 hook 和 external 中只计 1 次） |

**示例**：用户 `zhangsan` 通过 CLI hook 使用了 10K tokens，外部 plugin 使用了 5K tokens，排名中显示 15K tokens。

### 2.5 接入示例

#### Python 脚本推送

```python
import requests
import json

data = {
    "records": [
        {
            "username": "zhangsan",
            "name": "张三",
            "tool_type": "plugin",
            "model": "gpt-4",
            "token_in": 5000,
            "token_out": 15000,
            "request_count": 50,
            "sync_time": "2026-04-12T00:00:00Z"
        }
    ]
}

resp = requests.post(
    "http://your-server:3000/api/v1/external/daily-stats",
    json=data
)
print(resp.json())  # {"inserted": 1, "updated": 0, "skipped": 0, "total": 1}
```

#### cURL 推送

```bash
curl -X POST http://your-server:3000/api/v1/external/daily-stats \
  -H "Content-Type: application/json" \
  -d '{
    "records": [
      {
        "username": "zhangsan",
        "name": "张三",
        "tool_type": "plugin",
        "model": "gpt-4",
        "token_in": 5000,
        "token_out": 15000,
        "request_count": 50,
        "sync_time": "2026-04-12T00:00:00Z"
      }
    ]
  }'
```

#### 定时同步（推荐）

建议外部系统每天定时推送前一天的汇总数据：

```bash
# crontab 示例：每天凌晨 1 点推送前一天数据
0 1 * * * /path/to/sync-script.py
```

### 2.6 注意事项

1. **`tool_type` 过滤**：`cli` 类型的数据会被存储但不参与 Dashboard 统计。如需统计所有类型，请使用 `plugin` 或 `ide`
2. **用户名一致性**：外部数据的 `username` 应与本地 hook 采集的用户名保持一致，才能正确合并
3. **时区**：`sync_time` 建议使用 UTC 时间（带 `Z` 后缀），系统取日期部分（前 10 位）作为统计日期
4. **端点认证**：此端点为公开端点，与 `events/batch` 同级，外部系统调用无需登录认证
5. **批量推送**：建议一次推送一天的所有用户数据，减少 HTTP 请求次数

---

## 三、快速验证清单

### 登录认证验证

- [ ] 配置 `auth.provider` 和 `clientId/clientSecret`
- [ ] 重启服务器，访问 Dashboard → 显示"登录"按钮
- [ ] 点击登录 → 跳转 IDaaS → 授权 → 回调
- [ ] 管理员看到「用户管理」Tab
- [ ] 添加一个 viewer 用户 → 该用户登录后可正常查看数据
- [ ] 未授权用户登录后显示"请联系管理员"
- [ ] `curl /api/v1/stats/summary` 未登录 → 401
- [ ] `curl /api/v1/health` → 200（公开端点不受影响）

### 外部数据同步验证

- [ ] `POST /api/v1/external/daily-stats` 推送测试数据 → 返回 `inserted: N`
- [ ] Dashboard 概览 Token 合计包含外部数据
- [ ] 排名表中同一用户的 hook + external 数据合并显示
- [ ] 推送 `tool_type=cli` 的数据 → 不出现在统计中
- [ ] 重复推送同一天数据 → 返回 `updated: N`（覆盖更新）
