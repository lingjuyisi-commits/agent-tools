# 自动更新 + 版本活跃度统计

## Context

当前 CLI 更新只能手动 `agent-tools check-update`，用户可能长期停留在旧版本。需要：
1. 每次数据上报时携带 CLI 版本号，服务端检测到旧版本在响应中返回更新信息
2. 客户端收到更新指令后自动静默安装
3. 服务端统计每个 CLI 版本的活跃用户数

## 方案：上报 piggyback 版本检查 + 响应驱动更新

### 数据流

```
CLI sync 上报                          Server
  │                                      │
  ├─ POST /api/v1/events/batch           │
  │  Header: X-Client-Version: 0.7.0     │
  │  Body: { events: [...] }             │
  │                                      │
  │                              比较 0.7.0 < 0.8.0 (pkg.version)
  │                                      │
  │  ◄── Response 200 ──────────────────┤
  │  {                                   │
  │    accepted: 5,                      │
  │    update: {                         │
  │      version: "0.8.0",              │
  │      downloadUrl: "/api/v1/client/download" │
  │    }                                 │
  │  }                                   │
  │                                      │
  ├─ 检测到 update 字段                    │
  ├─ fork 子进程静默下载安装               │
  └─ 当前进程正常退出（不阻塞）             │
```

### 改动点

#### 1. CLI 上报时带版本号

`cli/src/collector/uploader.js` — 在 fetch header 加 `X-Client-Version`：

```js
headers: {
  'Content-Type': 'application/json',
  'X-Client-Version': require('../../package.json').version,
},
```

#### 2. CLI 事件携带版本号

`cli/src/collector/event-normalizer.js` — 加 `agent_version` 字段（events 表已有此列）：

```js
agent_version: require('../../package.json').version,
```

#### 3. Server 响应中附带更新信息

`server/src/routes/events.js` — 读取 `X-Client-Version` header，比较 `pkg.version`，有更新则在响应中加 `update` 字段：

```js
const clientVersion = request.headers['x-client-version'];
const serverVersion = pkg.version;
const result = { ...insertResult };
if (clientVersion && compareVersions(clientVersion, serverVersion) < 0) {
  result.update = { version: serverVersion, downloadUrl: '/api/v1/client/download' };
}
return result;
```

#### 4. CLI 收到 update 后静默安装

`cli/src/collector/uploader.js` — sync 成功后检查响应中的 `update` 字段：

```js
if (result.update) {
  // fork 子进程静默安装，不阻塞当前进程
  const { fork } = require('child_process');
  fork(updateWorkerPath, [result.update.downloadUrl], { detached: true, stdio: 'ignore' }).unref();
}
```

`cli/src/cli/check-update-worker.js`（新建）— 独立脚本，下载 tgz 并 npm install -g

#### 5. 服务端版本统计 API

`server/src/routes/stats.js` — 新增端点：

```
GET /api/v1/stats/cli-versions?period=day&date=2026-04-15
→ [{ version: "0.8.0", active_users: 15, event_count: 3200 }, ...]
```

从 events 表 `GROUP BY agent_version`。

---

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `cli/src/collector/event-normalizer.js` | 修改 | 加 `agent_version` 字段 |
| `cli/src/collector/uploader.js` | 修改 | 加 `X-Client-Version` header + 检测 update 响应 |
| `cli/src/cli/check-update-worker.js` | **新建** | 静默下载安装脚本（fork 调用） |
| `server/src/routes/events.js` | 修改 | 响应中附带版本更新信息 |
| `server/src/routes/stats.js` | 修改 | 新增 `/api/v1/stats/cli-versions` 端点 |

---

## 验证方案

1. sync 上报后检查 events 表 → `agent_version` 列有值
2. 用旧版本 CLI sync → 响应包含 `update` 字段
3. 用最新版本 CLI sync → 响应无 `update` 字段
4. 旧版本 CLI sync 后 → 子进程自动下载安装 → 版本更新
5. `GET /api/v1/stats/cli-versions` → 返回版本分布
6. 自动安装不阻塞 sync 进程
