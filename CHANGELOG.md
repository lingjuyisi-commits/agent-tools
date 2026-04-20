# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/) 和 [Keep a Changelog](https://keepachangelog.com/zh-CN/) 格式。

## 版本号规范

- 格式：`MAJOR.MINOR.PATCH`（如 `0.4.0`）
- **MAJOR**：不兼容的 API 变更（如事件格式变更、数据库 schema 不兼容升级）
- **MINOR**：向下兼容的新功能（如新增 Agent 支持、新增 API 端点）
- **PATCH**：向下兼容的问题修复（如 bug 修复、性能优化）
- 版本号严格递增，基于上游仓库 [leoaday/agent-tools](https://github.com/leoaday/agent-tools) 的最新 tag（当前 `v0.3.4`）继续递增
- 发布流程：`git tag v<version>` → CI 自动构建并创建 GitHub Release

---

## [Unreleased]

## [0.8.8] - 2026-04-20

### Added
- `user_profiles` 表（server/migrations/007）：作为 display_name / email / dept 的权威源，导入后 Dashboard 全局的用户名展示（stats 各表、管理员管理）统一从这张表覆盖，管理员和从未活跃用户也能显示正确的名字
- cc-switch 检测器：probe `/Applications/CC Switch.app` 与 Windows `%LOCALAPPDATA%\Programs\cc-switch`，读取 package.json 版本，并扫描 `~/.cc-switch/cc-switch.db` 字节流判断 Common Config 是否已包含本工具钩子
- 开放 SSO 登录 + `/api/v1/my/*` 个人统计端点：任意 SSO 登录用户可在 "我的统计" Tab 看到自己的数据，无需加入白名单；原 `/api/v1/stats/*` 端点改为 admin-only
- Dashboard 新 "我的统计" Tab：KPI + Token 趋势 + 按 model / hostname / agent 分布 + 最近 7 天明细
- 静态排查指南 `/dashboard/troubleshooting.html`：覆盖 4 类常见场景（"我的统计"为空、cc-switch 抹钩子、管理员看不全员、SSO login 与 OS username 不一致）
- `cli/src/utils/semver.js`：共用的 `versionGte`，消除 claude-code / codebuddy 两份重复实现

### Changed
- postinstall guard 决策改为"保护状态"而非"版本号"驱动：只有 cc-switch 已把 agent-tools 钩子写进 Common Config Snippet（且版本非 3.11.0 bug 版本）时才跳过 guard；其余情形（老版本、新版本但未配通用配置、未检测到 cc-switch）仍装 guard 并附排查指南链接
- auth 守卫拆为 `createAuthGuard`（任何 SSO session）+ `createAdminGuard`（`allowed_users.role=admin`）
- `/auth/session` 返回新增 `isAdmin` 字段；Dashboard 按此决定 Tab 可见性，非 admin 只看 "我的统计"
- 管理员管理 Tab：从"用户管理"改名；新增时不再暴露 viewer 选项，role 强制 admin

### Fixed
- `/api/v1/my/*` 严格拒绝空/缺失的 session.user.login（401 Invalid session），消除了 `applyFilters` 对空 user 跳过 WHERE 导致的 fleet 数据泄漏
- dashboard：`loadMyTrend` / `loadMyPies` / `loadMyRecentTable` 以前 `catch {}` 静默吞异常，改为 `console.error` 方便排查

## [0.8.7] - 2026-04-17

### Added
- Guard 守护进程：长驻 node watcher 监控 `~/.claude/settings.json`，被 cc-switch 等外部工具抹掉钩子时自动重新注入
- `agent-tools guard install|uninstall|status|run` 子命令
- `default-config.json` 新增 `guard.enabled`（默认 `true`）作为服务端远程 kill switch
- Windows 通过 schtasks ONLOGON + VBS launcher（UTF-16 LE 编码，兼容中文用户名路径）自启
- macOS 通过 LaunchAgent（RunAtLoad + KeepAlive）自启
- `cli/src/utils/json-logger.js`：rolling JSON 日志工具，watcher 与 auto-update worker 共用
- `doc/13-hook-protection-design.md`：hook 保护与自愈的设计文档与远程关停操作手册

### Fixed
- 升级后 Claude Code 钩子路径未刷新：`postinstall` 里 `setupAll()` 改为 `setupAll({ force: true })`，覆盖旧的 `universal-hook.js` 绝对路径
- `isAgentToolsHookEntry` 改为匹配 `universal-hook.js` 文件名而非 `agent-tools` 子串，避免误识别用户自己带 `agent-tools` 字样的钩子
- `acquireLock` 改用 `{ flag: 'wx' }` 原子创建，消除两个 guard 同时启动时的 TOCTOU 竞争

### Changed
- Windows/macOS 且检测到 Claude Code 时，`postinstall` 默认安装 guard；`preuninstall` 无条件卸载，避免残留 schtasks/LaunchAgent
- Watcher 重试从固定 30s 改为指数退避，30s 起上限 5min，成功 attach 后复位

## [0.8.6] - 2026-04-16

### Added
- 用户排名表支持分页、搜索（用户名或显示名）、服务端排序
- 概览页新增「已安装用户」表格（用户/版本/首次使用/最后活跃/事件数）
- `/api/v1/stats/installed-users` 端点：已安装用户列表
- `/api/v1/stats/user-names` 端点：用户显示名映射
- 用户名统一展示为「显示名 (username)」格式

### Changed
- `getRankingAll` 从全量返回改为分页返回 `{ data, total, page, pageSize }`
- 排名相关配置从 `rankingLimit` 改为 `rankingPageSize`（默认 50）
- 客户端安装说明简化（自动配置 + 自动注入 hooks）

### Fixed
- 切换筛选器后停留在错误页码的问题
- `page > totalPages` 时显示空白（自动回退到最后有效页）

## [0.8.5] - 2026-04-16

### Added
- 自动更新机制：events/batch 响应中附带版本更新信息，客户端自动静默安装
- CLI 事件携带 `agent_version` 字段 + `X-Client-Version` 请求头
- `/api/v1/stats/cli-versions` 端点：版本分布统计（活跃用户数 + 事件数）
- Dashboard 工具与技能 Tab 新增客户端版本分布饼图和详情表
- postinstall 自动注入 hooks，安装后零操作即可开始采集
- `server.publicUrl` 配置项，支持 Docker/代理部署指定客户端下载地址
- 自动更新设计文档 `doc/12-auto-update-design.md`

### Changed
- better-sqlite3 升级 11.x → 12.9.0（SQLite 3.49.2 → 3.53.0）
- 最低 Node 版本要求从 18 提升到 20
- CI 测试矩阵更新为 Node 20.x + 22.x
- 所有时间戳统一使用本地时区（配合 `TZ=Asia/Shanghai`）
- postinstall 始终覆盖客户端配置（配置由服务端统一控制）

### Fixed
- MySQL/PostgreSQL 下 SUM 返回字符串导致 token 统计被放大
- Windows 下自动更新弹出命令行窗口（spawn + windowsHide）
- 数据库迁移脚本全部改为幂等（hasTable/hasColumn 前置检查）
- 时区问题：event_time/received_time/sync_time 统一转本地时间
- 筛选 agent/hostname 时正确排除外部数据
- getDrilldown 按 model 下钻合并外部数据
- getRanking 合并外部数据（token/event_count 指标）
- getSummary user_count 去重跟随筛选器

## [0.8.0] - 2026-04-15

### Added
- 钻取页自动选择数据最多的分组维度（model/agent/hostname）
- OAuth2 provider 支持 userinfo query 模式（`userinfoTokenMethod: "query"`），兼容更多 IDaaS
- `server.publicUrl` 配置项，Docker/代理部署时直接指定客户端下载地址
- OAuth2 回调全流程调试日志（token 交换、userinfo 请求、登录成功/失败）
- 对话轮次统计（turn_count）显示在概览 KPI 和排名表中

### Changed
- OAuth2 通用 provider 改为手动 POST token endpoint（不再依赖 simple-oauth2），兼容所有 OAuth2 提供方
- 日期计算改用本地时区（`localDate()`），配合 `TZ=Asia/Shanghai` 环境变量确保东八区正确
- 聚合定时任务 cron 从 UTC 改为跟随系统时区
- package.json 版本号更新为 0.7.0（与 tag 同步）

### Fixed
- 数据库迁移脚本全部改为幂等（hasTable/hasColumn 前置检查）
- 筛选 agent/hostname 时正确排除外部数据
- getRanking 合并外部数据（token/event_count 指标）
- getSummary user_count 去重跟随筛选器
- getDrilldown 按 model 下钻时合并外部数据

## [0.7.0] - 2026-04-13

### Added
- 对话轮次统计：概览 KPI 显示「N 轮对话」，排名表增加「对话轮次」列
- 基于 UserPromptSubmit 事件（event_type='user_message'）计数

## [0.6.0] - 2026-04-12

### Added
- 外部数据同步 API：`POST /api/v1/external/daily-stats`，接收外部系统日粒度聚合数据
- 数据库 migration `006_add_external_fields`：daily_stats 表增加 source/display_name/tool_type 列
- Dashboard 概览和排名自动合并 hook + 外部数据（同一用户汇总显示）
- 外部数据 `tool_type=cli` 自动排除，只统计 plugin/ide
- 用户数去重计数（UNION DISTINCT，同一用户不重复计算）
- 接入指导文档 `doc/11-integration-guide.md`：登录认证配置 + 外部数据同步 API 使用

## [0.5.0] - 2026-04-12

### Added
- 可插拔 OAuth2/OIDC 认证系统（`server/src/auth/`）
  - 通用 OAuth2/OIDC provider：适配任意 IDaaS 平台，通过配置字段映射
  - GitHub OAuth provider：开发/测试备用
  - 用户白名单管理：`allowed_users` 数据库表，管理员在 Dashboard 中添加/删除用户
  - 认证守卫：实时查 DB 白名单，admin 改动即时生效
  - Dashboard 登录/登出 UI + 用户管理 Tab（管理员可见）
  - 401/403 响应处理 + 登录引导遮罩层
- 用户管理 API：`GET/POST/DELETE /api/v1/admin/users`（管理员专属）
- 数据库 migration `005_create_allowed_users`

### Changed
- Cookie/Session 注册提升到 app 级别（解决 Fastify 插件封装作用域问题）
- 认证可选：未配置 `auth.provider` 时所有端点保持公开（向后兼容）
- README 补充认证配置说明和设计文档索引

## [0.4.0] - 2026-04-12

### Added
- Token 增量计算：Stop 事件改为上报增量 token（避免服务端 SUM 重复计数）
- 公共 token-snapshots 模块：提取到 `cli/src/utils/token-snapshots.js`，原子写入防并发
- 定时自动同步：hook 触发时检查时间间隔（默认 300s），超时自动上传事件
- 本地数据库 metadata 表：支持 `last_sync_at` 等元数据持久化
- `CHANGELOG.md` 及版本号规范文档
- 代码审核报告：`doc/code-review-report.md`

### Changed
- 版本号管理统一为单一来源（`package.json`），移除 `client-version.json`
- Dashboard 下载链接改用 health 端点版本，减少一次 HTTP 请求
- build.sh / CI 移除 client-version.json 生成步骤

### Fixed
- CodeBuddy adapter 补齐 cache_read / cache_write token 采集
- Dashboard 下载链接添加 version 空值防御

---

## [0.3.4] - 2026-04-10

### Fixed
- CI release-full job 在 Windows 上提取版本号失败，添加 `shell: bash`

## [0.3.3] - 2026-04-10

### Added
- 多平台 full 包构建（linux / darwin / win32），含 bundled dependencies 离线安装

## [0.3.2] - 2026-04-10

### Added
- `build.sh` 本地构建脚本（minimal + full 平台包）
- CLI `preuninstall.js` 清理脚本

## [0.3.1] - 2026-04-10

### Changed
- 更新开发指南和 Server README，补充版本管理说明

## [0.3.0] - 2026-04-09

### Added
- 版本管理与自动更新系统
  - `agent-tools version` 命令
  - `agent-tools check-update` 命令（自动下载安装）
  - 服务端 `/api/v1/client/version` 和 `/api/v1/client/download` 接口
  - CLI `default-config.json` + `postinstall.js` 自动配置
  - Dashboard 右上角下载链接
  - 动态注入服务器地址到 CLI tgz
  - 缓存策略：`cli-{version}-{urlHash}.tgz`

## [0.2.0] - 2026-04-08

### Added
- Skill 独立统计（tool-usage / skill-usage 分离）
- 排名页面重新设计：全指标表格 + 趋势折线图
- 服务端可配置 Dashboard 参数（rankingLimit）

### Changed
- CI 统一为单文件 `ci.yml`，`v*` tag 触发 Release

## [0.1.6] - 2026-04-07

### Fixed
- npm pack 输出文件名已匹配目标时跳过重命名

## [0.1.5] - 2026-04-07

### Fixed
- CI 测试任务改用 npm（替代 pnpm）

## [0.1.4] - 2026-04-07

### Fixed
- Server 迁移测试改用 `node -e`（替代 `shell:node`）

## [0.1.3] - 2026-04-07

### Changed
- 合并 release 到 CI，单一 `v*` tag 触发 CLI + Server 打包

## [0.1.2] - 2026-04-07

### Changed
- 发布方式从 npm publish 改为 GitHub Release tgz 下载
- 测试命令增加 Edit 文件校验

## [0.1.1] - 2026-04-06

### Added
- 版本感知的 hook 格式（兼容 Claude Code ≥2.1.x）
- CodeBuddy adapter 与 Claude Code 完全对齐

### Fixed
- Hook payload 中补充 token usage、文件变更、模型信息

## [0.1.0] - 2026-04-05

首个功能完整版本。

### Added
- **CLI 客户端**：init / setup / sync / stats / status / agents / test 命令
- **Agent 支持**：Claude Code + CodeBuddy 完整 hook 适配
- **事件采集**：Token 消耗、文件变更、工具使用、Skill 调用、本地 SQLite 缓存 + 批量上传
- **服务端**：Fastify REST API、多数据库支持（SQLite/MySQL/PostgreSQL）、首次运行向导、每日聚合、事件去重
- **Dashboard**：概览 / 排名 / 钻取 / 工具与技能 四个 Tab
- **CI/CD**：GitHub Actions 测试（3 平台 × 2 Node 版本）
