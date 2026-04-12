# agent-tools 项目代码审核报告

## 项目概述

agent-tools 是一个 AI 编程 Agent 使用统计收集平台，包含 CLI 客户端和 Server 服务端，用于自动采集 Claude Code / CodeBuddy 等 Agent 的 Token 消耗、工具使用、文件变更等指标，并通过 Dashboard 可视化展示。

---

## 一、安全漏洞（Critical / High）

### 1.1 命令注入漏洞
- **`cli/src/cli/check-update.js:73`** — `tgzPath` 直接拼入 shell 命令 `execSync(\`npm install -g "${tgzPath}"\`)`，可被利用注入命令
- **`cli/src/detector/claude-code.js:97`、`codebuddy.js:71`** — `event` 参数未转义直接拼入命令字符串
- **建议**：使用 `execFileSync` 或 `spawn` 传递参数数组，避免 shell 解析

### 1.2 路径遍历 + 任意代码执行
- **`cli/src/hooks/universal-hook.js:70`** — `require(\`./adapters/${agent}\`)` 中 `agent` 来自命令行参数，未校验白名单，攻击者可传 `--agent=../../../malicious` 加载任意模块
- **建议**：硬编码 `VALID_AGENTS = ['claude-code', 'codebuddy']`，拒绝非白名单值

### 1.3 Dashboard XSS 漏洞
- **`server/src/dashboard/index.html`** 多处使用 `innerHTML` 直接拼接 API 返回数据（用户名、模型名、Agent 名等），且 `onclick` 内联处理器中直接拼接用户数据
  - 行 285-290：下拉选项拼接 `innerHTML += \`<option value="${m.model}">\``
  - 行 520-537：`onclick="goToDrilldown('${d.username}')"`，用户名含引号即可逃逸
- **建议**：改用 `document.createElement` + `textContent`；用 `addEventListener` 替代内联 `onclick`

### 1.4 无认证/无鉴权
- **所有 API 端点完全无认证**。任何人可以：
  - `POST /api/v1/events/batch` 注入虚假数据
  - `GET /api/v1/stats/drilldown?username=xxx` 查询任意用户数据
- **建议**：至少实现 API Key 认证；敏感查询加权限控制

### 1.5 X-Forwarded 头部欺骗
- **`server/src/routes/client.js:69-77`** — 信任 `X-Forwarded-Proto/Host/Port` 构造 base URL，可被伪造指向恶意服务器
- **建议**：仅在配置了可信代理时信任这些头部

### 1.6 Server URL 协议未限制
- **`cli/src/cli/init.js:18`** — `new URL(val)` 校验接受 `file://`、`data://` 等危险协议
- **建议**：限制为 `http://` 和 `https://`

---

## 二、可靠性问题（Medium-High）

### 2.1 静默错误吞没
- **`cli/src/hooks/universal-hook.js:114-116`** — 顶层 catch 直接 `process.exit(0)`，所有错误无任何输出
- **多个文件** 的 `try/catch` 块不记录错误，调试极为困难
- **`server/src/dashboard/index.html:279`** — `catch {}` 空块吞没筛选器加载失败
- **建议**：至少输出到 stderr；hook 添加 `--debug` 模式

### 2.2 路由缺少错误处理
- **`server/src/routes/stats.js`、`events.js`** — async 路由处理器无 try-catch，数据库异常会导致未处理的 Promise 拒绝
- **建议**：添加 Fastify 全局错误钩子或逐路由 try-catch

### 2.3 配置文件解析无保护
- **`server/src/config.js:21`** — `JSON.parse()` 无 try-catch，配置文件损坏即崩溃
- **建议**：添加错误处理，损坏时提示用户重新配置

### 2.4 日聚合任务竞态条件
- **`server/src/jobs/daily-aggregation.js:41-69`** — 先 SELECT 再 INSERT/UPDATE，并发时可能导致重复插入
- **建议**：使用数据库级 upsert（`ON CONFLICT UPDATE` / `ON DUPLICATE KEY UPDATE`）

### 2.5 事件数据覆盖风险
- **`cli/src/collector/event-normalizer.js:4-21`** — `...agentData` 展开可覆盖 `event_id`、`event_time` 等关键字段
- **建议**：白名单展开，或先设置关键字段再展开

### 2.6 重复错误检测依赖字符串匹配
- **`server/src/services/event-service.js:46-54`** — 通过 `err.message.includes('unique')` 判断重复，不同数据库错误消息格式不同
- **建议**：检查 `err.code`（如 `SQLITE_CONSTRAINT`）

---

## 三、性能与资源问题（Medium）

### 3.1 大文件全量读取
- **`cli/src/hooks/adapters/claude-code.js:100`** — `fs.readFileSync(transcriptPath)` 无大小限制，超大 transcript 可能耗尽内存
- **建议**：添加文件大小上限检查（如 50MB）

### 3.2 API 查询无上限
- **`server/src/services/stats-service.js:106`** — `limit` 参数无最大值限制，`?limit=999999999` 可触发 DoS
- **建议**：`Math.min(parseInt(limit), 1000)`

### 3.3 缺少数据库连接池配置
- **`server/src/db.js`** — 使用默认 Knex 连接池，高并发下可能不足
- **建议**：在配置中暴露连接池参数

### 3.4 客户端下载路由内存缓冲
- **`server/src/routes/client.js:154-169`** — tar 流全量缓存到内存
- **建议**：改为流式响应

### 3.5 自动同步无速率限制
- **`cli/src/hooks/universal-hook.js:103`** — 每 100 事件触发一次同步，快速开发会产生大量 HTTP 请求
- **建议**：添加最小间隔限制

### 3.6 数据库兼容性问题
- **`server/src/services/stats-service.js:202`** — `SUBSTR(event_time, 1, 10)` 假设 ISO 格式，跨数据库不完全兼容
- **建议**：使用数据库原生日期函数

---

## 四、工程质量问题

### 4.1 完全没有测试
- **无任何 `.test.js`、`.spec.js` 文件**
- CI 仅做 `require()` 加载检查，不是真正的测试
- 无单元测试、集成测试、E2E 测试
- **建议**：建立 Jest/Vitest 测试框架，优先覆盖核心路径

### 4.2 无代码质量工具
- 无 ESLint / Prettier 配置
- 无 TypeScript / JSDoc 类型检查
- 无代码覆盖率工具
- **建议**：添加 ESLint + Prettier，CI 中检查

### 4.3 包管理混乱
- 同时存在 `package-lock.json` 和 `pnpm-lock.yaml`
- CI 用 npm，本地可能用 pnpm，依赖树可能不一致
- **建议**：统一使用一种包管理器，删除另一种的 lock 文件

### 4.4 CI/CD 不完善
- 无依赖缓存（每次全量安装）
- 无安全审计（`npm audit`）
- 无构建产物校验（SHA256 checksum）
- Release 未生成 changelog
- 版本号未验证 semver 格式
- **建议**：添加缓存、安全扫描、checksum 生成

### 4.5 代码重复
- `cli/src/detector/claude-code.js` 与 `codebuddy.js` 的 `injectHooks()` 逻辑高度重复（各 70+ 行）
- 两个 adapter 文件结构几乎一致
- **建议**：提取公共 `injectHooks` 工具函数

### 4.6 魔法字符串/数字散布
- `'http://localhost:3000'`（多处 fallback）
- 事件名、Agent 名、超时时间等硬编码
- **建议**：提取为常量模块

### 4.7 杂余文件
- **`cli/hi.txt`** — 仅含 "hi"，应为调试遗留，应删除

---

## 五、平台兼容性问题

### 5.1 Windows 路径处理
- 命令拼接使用字符串插值，空格/特殊字符路径在 Windows 下可能出错
- knexfile.js 未做路径规范化

### 5.2 build.sh 仅支持 Bash
- 使用 `rm -rf`、`date -u` 等 Unix 命令
- Windows 用户必须有 Git Bash
- **建议**：考虑提供 Node.js 构建脚本或 Makefile 替代

### 5.3 本地数据库 Schema 无迁移机制
- **`cli/src/collector/local-store.js`** — 使用 `CREATE TABLE IF NOT EXISTS`，未来 schema 变更无法自动迁移
- **建议**：添加版本号和简单迁移逻辑

---

## 六、问题汇总

| 优先级 | 类别 | 数量 | 代表性问题 |
|--------|------|------|-----------|
| **P0 Critical** | 安全 | 6 | 命令注入、路径遍历、XSS、无认证 |
| **P1 High** | 可靠性 | 6 | 错误吞没、配置解析崩溃、竞态条件 |
| **P2 Medium** | 性能/资源 | 6 | 大文件读取、无查询上限、内存缓冲 |
| **P3 Medium** | 工程质量 | 7 | 无测试、无 lint、包管理混乱、代码重复 |
| **P4 Low** | 兼容性/文档 | 3 | Windows 路径、build.sh 可移植性、Schema 迁移 |

---

## 七、修复建议优先级

### 立即修复（安全相关）
1. universal-hook.js 的 agent 参数白名单校验
2. Dashboard innerHTML → textContent / createElement
3. 添加 API 认证机制（至少 API Key）
4. check-update.js / detector 命令注入修复
5. Server URL 协议限制

### 短期修复（可靠性）
6. 路由处理器添加错误处理
7. 配置文件解析添加 try-catch
8. 日聚合使用数据库 upsert
9. 事件规范化字段白名单
10. hook 错误输出到 stderr

### 中期建设（工程质量）
11. 建立测试框架 + 核心路径测试
12. 添加 ESLint + Prettier
13. 统一包管理器
14. CI 添加缓存和安全扫描
15. 提取公共代码、消除重复
