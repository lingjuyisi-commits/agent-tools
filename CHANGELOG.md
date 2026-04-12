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
