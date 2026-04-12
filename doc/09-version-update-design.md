# 版本管理与自动更新设计

## 1. 背景与目标

当前系统缺少以下能力：

- CLI 无法查看自身版本号
- 无法检查是否有新版本、无法自动更新
- 服务端没有提供客户端版本查询和下载能力
- Dashboard 没有客户端下载入口
- 新安装的客户端需要手动 `init` 配置服务器地址

### 目标

1. CLI 提供 `version` 命令查看当前版本
2. CLI 提供 `check-update` 命令，向服务器查询最新版本并自动下载安装
3. 服务器内嵌 CLI tgz，提供版本查询 API 和下载接口
4. 服务器下载接口动态注入自身地址到 CLI tgz 中的预置配置，确保通过该服务器下载的客户端自动上报到该服务器
5. CLI 安装后通过 postinstall 脚本自动应用预置配置（服务器地址）
6. Dashboard 右上角提供客户端下载链接
7. GitHub CI 按 CLI → Server 的顺序打包，将 CLI tgz 内嵌到 Server 包中

## 2. 整体架构

```
GitHub CI (tag v*)
  │
  ├── 1. 打包 CLI tgz (npm version 写入版本号 + 含 default-config.json 占位)
  │         │
  │         ▼
  ├── 2. 复制 CLI tgz → server/dist/agent-tools-cli.tgz
  │
  ├── 3. 打包 Server tgz (npm version 写入版本号 + 内嵌 CLI tgz)
  │
  └── 4. 创建 GitHub Release (两个 tgz)

运行时（服务器）：
  浏览器/CLI ──→ GET /api/v1/client/version ──→ 返回 { version }（读取 server/package.json）
  浏览器/CLI ──→ GET /api/v1/client/download ──→ 动态注入服务器地址的 CLI tgz

  动态注入流程：
  ┌────────────────────────────────────────────┐
  │  原始 CLI tgz (dist/agent-tools-cli.tgz)   │
  │    └── package/default-config.json          │
  │          { "server": { "url": "" } }        │
  └──────────────────┬─────────────────────────┘
                     │ 解压 → 修改 → 重新打包
                     ▼
  ┌────────────────────────────────────────────┐
  │  定制 CLI tgz                               │
  │    └── package/default-config.json          │
  │          { "server": { "url":               │
  │            "http://this-server:3000" } }    │
  └────────────────────────────────────────────┘

客户端安装后（npm install -g <tgz>）：
  postinstall 脚本 → 检测 ~/.agent-tools/config.json 是否存在
    不存在 → 从 default-config.json 复制为用户配置
    已存在 → 不覆盖（保留用户手动配置）
```

## 3. 版本号管理

### 单一版本源：`package.json`

版本号的唯一来源是 `server/package.json` 和 `cli/package.json` 中的 `version` 字段。
不再使用独立的 `client-version.json` 文件。

| 阶段 | 版本号来源 |
|------|-----------|
| 代码仓库中 | `package.json` 中的开发版本（如 `0.1.0`） |
| CI release job | `npm version <tag>` 覆写 `package.json`（如 `0.2.0`） |
| Server 运行时 | `require('../../package.json').version`，health 和 client/version 端点统一读取 |
| CLI 运行时 | `require('../../package.json').version`，version 和 check-update 命令使用 |

### API 响应

`GET /api/v1/client/version` 返回：

```json
{
  "version": "0.2.0"
}
```

`GET /api/v1/health` 也返回同一个版本号，Dashboard 直接使用 health 端点，无需额外请求。

## 4. CLI 预置配置 (`default-config.json`)

### 结构

```json
{
  "server": { "url": "" },
  "sync": { "batchSize": 100, "intervalSeconds": 300 }
}
```

### 存放位置

`cli/default-config.json`，随 CLI 包一起发布。

### 生命周期

| 阶段 | `server.url` 值 |
|------|------|
| 代码仓库中 | `""`（空字符串） |
| CI 打包后原始 tgz | `""`（空字符串） |
| 服务器 `/api/v1/client/download` 提供的 tgz | 动态注入为当前服务器地址（如 `"http://192.168.1.10:3000"`） |
| `npm install -g` 后 postinstall 执行时 | 若 url 非空且用户无已有配置 → 写入 `~/.agent-tools/config.json` |

### postinstall 脚本 (`cli/scripts/postinstall.js`)

```
1. 读取 default-config.json
2. 若 server.url 为空 → 跳过（用户需手动 init）
3. 若 ~/.agent-tools/config.json 已存在 → 跳过（不覆盖）
4. 否则 → 复制为用户配置，补充 initialized/initTime 字段
5. 静默执行，不中断安装（所有错误 catch 忽略）
```

> CLI package.json 已有 `"postinstall": "node scripts/postinstall.js"`。

## 5. 服务端 API

### `GET /api/v1/client/version`

返回客户端版本信息。

**响应**

```json
{
  "version": "0.2.0"
}
```

版本号直接读取 `server/package.json`，与 health 端点返回一致。

### `GET /api/v1/client/download`

返回动态注入了服务器地址的 CLI tgz 文件。

**处理流程**

1. 从请求中解析用户原始访问的服务器 base URL（详见下方 URL 解析规则）
2. 读取 `dist/agent-tools-cli.tgz`（原始 CLI 包）
3. 解压 tgz（gzip → tar）
4. 找到 `package/default-config.json`，将 `server.url` 替换为解析出的 base URL
5. 重新打包为 tgz
6. 设置响应头 `Content-Disposition: attachment; filename="agent-tools-cli.tgz"` 和 `Content-Type: application/gzip`
7. 返回修改后的 tgz

#### 原始请求 URL 解析规则

用户可能通过直连、单层反向代理、多层反向代理等不同方式访问服务器，需要从请求头中正确还原用户浏览器/CLI 实际请求的 URL。

**解析优先级（从高到低）**：

| 优先级 | 头部 | 说明 | 示例 |
|--------|------|------|------|
| 1 | `X-Original-URL` | 部分反向代理（如 Nginx ingress）设置的完整原始 URL | `http://agent.example.com/tools/api/v1/client/download` |
| 2 | `X-Forwarded-*` 组合 | 标准反向代理头组合 | 见下方 |
| 3 | `Forwarded` (RFC 7239) | 标准化格式 | `for=1.2.3.4;proto=https;host=agent.example.com` |
| 4 | 直连请求属性 | Fastify `request.protocol` + `request.hostname` + 监听端口 | `http://192.168.1.10:3000` |

**`X-Forwarded-*` 组合解析细节**：

```
协议: X-Forwarded-Proto > X-Forwarded-Scheme > request.protocol
     取第一个值（多层代理时逗号分隔，第一个是客户端原始协议）

主机: X-Forwarded-Host > X-Original-Host > Host header > request.hostname
     取第一个值（可能含端口，如 "agent.example.com:8443"）

端口: X-Forwarded-Port > 从主机中提取 > 根据协议推断
     若 Host 含端口则用 Host 中的端口
     否则 X-Forwarded-Port
     否则 https→443, http→80

前缀: X-Forwarded-Prefix
     反向代理的路径前缀（如 "/tools"）
     生成 base URL 时需追加此前缀
```

**base URL 组装**：

```
baseUrl = {proto}://{host}[:{port}]{prefix}

其中端口省略规则：
  - proto=https 且 port=443 → 省略
  - proto=http  且 port=80  → 省略
  - 其他 → 保留
```

**示例场景**：

| 场景 | 请求头 | 解析结果 |
|------|--------|----------|
| 直连 | 无代理头 | `http://192.168.1.10:3000` |
| Nginx 反代 | `X-Forwarded-Proto: https`, `X-Forwarded-Host: agent.example.com` | `https://agent.example.com` |
| Nginx 反代 (非标准端口) | `X-Forwarded-Proto: https`, `X-Forwarded-Host: agent.example.com`, `X-Forwarded-Port: 8443` | `https://agent.example.com:8443` |
| 带路径前缀的反代 | `X-Forwarded-Proto: https`, `X-Forwarded-Host: company.com`, `X-Forwarded-Prefix: /agent-tools` | `https://company.com/agent-tools` |
| 完整原始 URL | `X-Original-URL: http://internal:9000/proxy/api/v1/client/download` | `http://internal:9000/proxy`（截取 API 路径前的部分） |
| RFC 7239 | `Forwarded: proto=https;host=agent.example.com` | `https://agent.example.com` |
| 多层代理 | `X-Forwarded-Proto: https, http`, `X-Forwarded-Host: public.com, internal.com` | `https://public.com`（取第一个） |

**实现为独立函数 `resolveBaseUrl(request)`**，便于单元测试：

```js
function resolveBaseUrl(request) {
  // 1. X-Original-URL — 截取 /api/v1/ 之前的部分
  const originalUrl = request.headers['x-original-url'];
  if (originalUrl) {
    const idx = originalUrl.indexOf('/api/v1/');
    if (idx > 0) return originalUrl.slice(0, idx);
  }

  // 2. X-Forwarded-* 组合
  const fwdProto = firstVal(request.headers['x-forwarded-proto'])
                || firstVal(request.headers['x-forwarded-scheme']);
  const fwdHost  = firstVal(request.headers['x-forwarded-host'])
                || firstVal(request.headers['x-original-host']);
  if (fwdHost) {
    const proto  = fwdProto || request.protocol || 'http';
    const prefix = request.headers['x-forwarded-prefix'] || '';
    return buildUrl(proto, fwdHost,
                    request.headers['x-forwarded-port'], prefix);
  }

  // 3. Forwarded (RFC 7239)
  const fwd = parseForwarded(request.headers['forwarded']);
  if (fwd && fwd.host) {
    return buildUrl(fwd.proto || request.protocol || 'http', fwd.host);
  }

  // 4. 直连 fallback
  const proto = request.protocol || 'http';
  const host  = request.hostname;
  const port  = request.socket?.localPort || '';
  return buildUrl(proto, host, String(port));
}

// 逗号分隔取第一个值
function firstVal(header) {
  if (!header) return null;
  return header.split(',')[0].trim();
}

// 组装 URL，省略默认端口
function buildUrl(proto, host, port, prefix) {
  // host 可能已包含端口
  let hostPort = host;
  if (port && !host.includes(':')) {
    const isDefault = (proto === 'https' && port === '443')
                   || (proto === 'http' && port === '80');
    if (!isDefault) hostPort = `${host}:${port}`;
  }
  const pfx = (prefix || '').replace(/\/+$/, '');
  return `${proto}://${hostPort}${pfx}`;
}
```

#### 缓存策略

- **文件缓存**，存放在服务器数据目录 `~/.agent-tools-server/cache/` 下
- 文件名格式：`cli-{version}-{hash}.tgz`，其中 `hash` 是 base URL 的 MD5 短哈希（取前 12 位）
- 文件名含版本号，服务器升级后版本号变化，旧缓存自然失效
- 不同 base URL（用户通过不同端点/代理访问）各自独立缓存文件
- 启动时可选清理旧版本缓存文件（版本号不匹配的文件删除）

```
~/.agent-tools-server/cache/
  cli-0.2.0-a1b2c3d4e5f6.tgz    ← baseUrl=http://192.168.1.10:3000
  cli-0.2.0-f6e5d4c3b2a1.tgz    ← baseUrl=https://agent.example.com
```

```js
const crypto = require('crypto');
const CACHE_DIR = path.join(os.homedir(), '.agent-tools-server', 'cache');

function getCachePath(version, baseUrl) {
  const hash = crypto.createHash('md5').update(baseUrl).digest('hex').slice(0, 12);
  return path.join(CACHE_DIR, `cli-${version}-${hash}.tgz`);
}

async function getCustomizedTgz(version, baseUrl) {
  const cachePath = getCachePath(version, baseUrl);
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath);

  const buf = await buildCustomTgz(baseUrl);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, buf);
  return buf;
}
```

#### 容错

- `dist/agent-tools-cli.tgz` 不存在（dev 环境）→ 返回 404 + JSON 提示信息
- 解压/打包失败 → 返回 500 + 错误详情
- base URL 解析失败 → 回退到直连地址，不中断下载

### 实现

**新建**: `server/src/routes/client.js` — 包含 version 和 download 两个路由。

使用 Node.js 内置的 `zlib`（gzip/gunzip）和 `tar`（需要 `tar` npm 包或手动处理 tar 格式）。

> 考虑到 tgz = gzip(tar)，推荐使用 npm `tar` 包（轻量，广泛使用）来处理解压/修改/重新打包。需要在 server/package.json 中添加 `"tar": "^7.0.0"` 依赖。

### 修改

**`server/src/app.js`** — 注册 `routes/client` 路由

**`server/src/routes/health.js`** — version 从 `package.json` 读取而非硬编码 `'0.1.0'`

## 6. CLI 命令

### `agent-tools version`

显示当前安装版本。版本来自 `package.json`（CI 通过 `npm version` 写入 tag 版本）。

```
$ agent-tools version
agent-tools v0.2.0
```

> Commander.js 自带的 `--version` / `-V` 标志继续可用。

### `agent-tools check-update [--check-only]`

#### 流程

```
1. 读取 ~/.agent-tools/config.json 获取 server URL
2. GET {serverUrl}/api/v1/client/version
3. 比较版本号（三段数字比较）
4. 若当前 >= 最新 → "已是最新版本"
5. 若有更新：
   a. --check-only → 仅提示，不安装
   b. 默认：
      - GET {serverUrl}/api/v1/client/download → 下载 tgz 到临时目录
      - npm install -g <tgz>
      - 清理临时文件
```

#### 版本比较

简单三段语义化版本比较 (`X.Y.Z`)，不引入 semver 库：

```js
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}
```

#### 输出示例

```
$ agent-tools check-update

检查更新...

  当前版本: v0.1.0
  最新版本: v0.2.0

  正在下载 v0.2.0...
  正在安装...

  ✓ 已成功更新到 v0.2.0。
```

## 7. CI 工作流变更

### 打包顺序（release job）

```
  CLI install → CLI npm version → CLI pack → CLI rename
→ 复制 CLI tgz 到 server/dist/
→ Server install → Server npm version → Server pack → Server rename
→ Create Release
```

版本号由 `npm version` 统一写入各 `package.json`，不再需要生成独立的版本清单文件。

### 关键步骤

```yaml
# ── 内嵌 CLI tgz 到 Server ──
- name: Embed CLI tgz in server
  run: |
    mkdir -p server/dist
    cp cli/agent-tools-cli-${{ steps.version.outputs.version }}.tgz \
       server/dist/agent-tools-cli.tgz
```

### Server package.json 变更

确保 `npm pack` 包含 `dist/` 目录。在 `package.json` 中添加 `files` 字段：

```json
{
  "files": [
    "bin/",
    "src/",
    "dist/",
    "migrations/"
  ]
}
```

### .gitignore 变更

`dist/` 已在 `.gitignore` 中被忽略（现有规则），`server/dist/` 不会被提交到仓库。CI 中由步骤动态创建。

## 8. Dashboard 下载链接

### 右上角 header 修改

将状态栏区域增加下载链接：

```html
<div style="display:flex;align-items:center;gap:16px;">
  <a id="client-download" href="/api/v1/client/download"
     style="display:none;color:#8fc;font-size:13px;">
    下载客户端
  </a>
  <div class="status" id="server-status">加载中...</div>
</div>
```

### 页面初始化时

Dashboard 在请求 `/api/v1/health` 时已获取版本号，直接复用：

```js
// health 端点返回 data.version，复用于下载链接
const link = document.getElementById('client-download');
link.textContent = `下载客户端 v${data.version}`;
link.style.display = '';
```

点击链接直接触发浏览器下载（download API 返回 `Content-Disposition: attachment`）。
无需额外请求 `/api/v1/client/version`，减少一次 HTTP 请求。

## 9. 涉及文件

| 文件 | 操作 | 说明 |
|------|------|------|
| **CLI** | | |
| `cli/bin/cli.js` | 修改 | 注册 `version` 和 `check-update` 命令 |
| `cli/src/cli/check-update.js` | 新建 | 检查更新 + 自动下载安装 |
| `cli/default-config.json` | 新建 | 预置配置文件（server.url 占位） |
| `cli/scripts/postinstall.js` | 新建 | 安装后自动应用预置配置 |
| `cli/package.json` | 修改 | 确认 postinstall 脚本和 files 字段 |
| **Server** | | |
| `server/src/routes/client.js` | 新建 | 版本查询（读 package.json）+ 动态 tgz 下载 API |
| `server/src/app.js` | 修改 | 注册 client 路由 |
| `server/src/routes/health.js` | 修改 | version 读 package.json |
| `server/package.json` | 修改 | 添加 `tar` 依赖 + `files` 字段含 `dist/`，版本号唯一来源 |
| `server/src/dashboard/index.html` | 修改 | header 下载链接（版本号来自 health 端点） |
| **CI** | | |
| `.github/workflows/ci.yml` | 修改 | CLI tgz 内嵌，npm version 统一写入版本号 |

## 10. 完整数据流

### 首次部署流程

```
管理员:
  1. git push tag v0.2.0
  2. CI 自动打包: CLI tgz → 内嵌到 Server → Server tgz
  3. 从 GitHub Release 下载 server tgz
  4. npm install -g agent-tools-server-0.2.0.tgz
  5. agent-tools-server (启动，此时 dist/ 中已包含 CLI tgz)

开发者:
  6. 浏览器访问 http://server:3000 → 右上角点击"下载客户端 v0.2.0"
  7. 浏览器下载 agent-tools-cli.tgz (已注入 server URL)
  8. npm install -g agent-tools-cli.tgz
  9. postinstall 自动写入 config.json (server.url = http://server:3000)
  10. 直接可用, 无需手动 init
```

### 版本更新流程

```
管理员:
  1. git push tag v0.3.0
  2. CI 打包 → GitHub Release
  3. 更新服务器: npm install -g agent-tools-server-0.3.0.tgz

开发者:
  4. agent-tools check-update
     → GET http://server:3000/api/v1/client/version
     → { version: "0.3.0" }
     → 当前 v0.2.0 < 最新 v0.3.0
     → GET http://server:3000/api/v1/client/download
     → npm install -g <下载的 tgz>
     → ✓ 更新完成
```

## 11. 安全考虑

- **下载源可信**：tgz 从用户已配置的服务器下载，不涉及第三方
- **不自动提权**：`npm install -g` 权限不足时由 npm 报错，不自动执行 `sudo`
- **不覆盖用户配置**：postinstall 仅在无已有配置时写入，不覆盖用户手动配置
- **超时保护**：版本查询 10s 超时，tgz 下载 120s 超时
- **临时文件清理**：下载的 tgz 在安装后立即清理
- **postinstall 静默**：所有错误被 catch，不中断 npm 安装流程

## 12. 验证方案

### 本地开发验证

1. 创建测试 tgz：`cd cli && npm pack` → 复制到 `server/dist/agent-tools-cli.tgz`
2. 启动 server：`node server/bin/server.js`（版本号来自 `server/package.json`）
3. `curl http://localhost:3000/api/v1/client/version` → 返回 `{ "version": "0.1.0" }`
4. `curl http://localhost:3000/api/v1/health` → version 字段与上一步一致
5. `curl -o test.tgz http://localhost:3000/api/v1/client/download` → 下载 tgz
6. 解压验证：`tar xzf test.tgz package/default-config.json -O` → server.url 应为 `http://localhost:3000`
7. `node cli/bin/cli.js version` → 输出当前版本
8. `node cli/bin/cli.js check-update --check-only` → 版本对比正确
9. Dashboard 右上角显示"下载客户端 v0.1.0"链接（版本来自 health 端点）

### CI 端到端验证

1. 推送 tag → CI 完整流程
2. 下载 Release 中的 server tgz → 安装 → 启动
3. 浏览器下载客户端 → 安装 → 验证 config.json 中 server.url 已自动填充
4. `agent-tools check-update` → "已是最新版本"
