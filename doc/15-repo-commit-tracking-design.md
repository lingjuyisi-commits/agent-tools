# AI 协助代码提交量统计（按仓库）

## Context

当前 `agent-tools` 记录 token、编辑行数、工具调用，但**不知道"这些代码最终进了哪个项目"**。业务方想知道 AI 协助产生的代码中，有多少真正落到了公司指定的仓库里——而不只是 Claude 在临时目录里敲出的字节数。

为此需要**组合两种数据源**：

- **Hook 自采**（实时，偏高——统计每一次 Edit/Write 的行数，含被丢弃内容）
- **SessionEnd 时 `git log --numstat` 采样**（ground truth——会话窗口内真正提交的行数）

同时展示两个数值可以计算出**保留率** = 提交行数 / 编辑行数（按仓库 × 开发者），这才是"有多少 AI 工作真正落盘"的可操作指标。

仓库由**管理员按域名配置**（如 `github.com/myorg`、`gitlab.corp.com`），不在 allowlist 里的仓库 URL 在服务端入库阶段就丢弃，避免积累个人仓库信息。

## 统计口径（每项独立可查）

为避免任何"折中口径"导致的争议，**所有可计算的指标都各自独立采集和暴露**，前端给一个独立 tab 让用户切换查看。

### 编辑侧（hook 自采）

| 指标 | 含义 | 来源 |
|---|---|---|
| `edit_lines_added` | 所有 Edit/Write 的 `lines_added` 求和（含 churn） | PostToolUse |
| `edit_lines_removed` | 所有 Edit/Write 的 `lines_removed` 求和 | PostToolUse |
| `edit_lines_net` | added − removed | 计算 |
| `edit_files_touched` | 去重的文件路径数 | PostToolUse |
| `edit_ops_count` | Edit/Write 操作次数 | PostToolUse |

### 提交侧（git 采样，两种归因都存）

| 指标 | 含义 | 计算 |
|---|---|---|
| `commit_count_window` | 窗口内 author 全部 commit 数（粗口径） | git log 直接计 |
| `commit_lines_added_window` | 窗口内全部 commit 的 +lines | git numstat 求和 |
| `commit_lines_removed_window` | 窗口内全部 commit 的 −lines | git numstat 求和 |
| `commit_count_intersect` | 至少有一个文件被 hook 编辑过的 commit 数（细口径） | 文件交集 |
| `commit_lines_added_intersect` | 仅"hook 编辑过的文件"在 commit 里的 +lines | 文件交集 |
| `commit_lines_removed_intersect` | 同上 −lines | 文件交集 |
| `commit_files_count` | commit 中独立文件数 | numstat |

### 派生指标（前端按需算，不入库）

- `retention_window = commit_lines_added_window / edit_lines_added`
- `retention_intersect = commit_lines_added_intersect / edit_lines_added`
- `churn_ratio = edit_lines_removed / edit_lines_added`（衡量 Claude 自我改写程度）

### 落库结构

`session_commits` 事件的 `extra` 把两套都存下来，前端不需要客户端重算：

```json
{
  "edit_files": ["src/a.js", "src/b.js"],   // hook 期间编辑过的文件去重列表
  "window": {
    "commit_count": 3,
    "lines_added": 240,
    "lines_removed": 80
  },
  "intersect": {
    "commit_count": 2,
    "lines_added": 180,
    "lines_removed": 60
  },
  "commits": [
    {
      "hash": "abc",
      "time": "...",
      "subject": "feat: x",
      "in_intersect": true,
      "files": [{"path":"src/a.js","added":12,"removed":3}]
    }
  ]
}
```

跨 session 的同一 commit 在服务端按 `(commit_hash, git_remote_url)` **去重，谁先 ingest 算谁的**，避免并发 session 双计数。

## 数据流

```
Claude Code hook                CLI universal-hook            Local SQLite             Server
   │                                 │                             │                        │
   ├─ SessionStart ─────────────────►│                             │                        │
   │                                 ├─ git remote get-url origin  │                        │
   │                                 ├─ git config user.email      │                        │
   │                                 ├─ 写 session_meta            │                        │
   │                                 ├─ 写 event(cwd, git_remote,  │                        │
   │                                 │          git_author_email) ─►                        │
   │                                                                                        │
   ├─ PostToolUse (Edit/Write) ─────►│─ 正常记录 lines_added ─────►│                        │
   │                                                                                        │
   ├─ SessionEnd ───────────────────►│─ 写正常 SessionEnd event ──►│                        │
   │                                 ├─ 读 session_start_time       │                        │
   │                                 ├─ git log --numstat --author │                        │
   │                                 │         --since=<start>     │                        │
   │                                 └─ 写 session_commits event ─►│                        │
   │                                                               │                        │
   │                               uploader batch sync             │                        │
   │                                 ─────────────────────────────────►  POST /events/batch │
   │                                                                                        │
   │                                                              入库前：normalizeRepoUrl  │
   │                                                              不在 allowlist → 丢 URL / │
   │                                                              丢 session_commits        │
```

## 改动点

### 1. 数据库 schema（migration 002）

`server/migrations/002_add_repo_tracking.js` 给 `events` 表增加：

- `cwd` TEXT（nullable）
- `git_remote_url` VARCHAR(512)（nullable，建索引）
- `git_author_email` VARCHAR(256)（nullable，建索引）
- 复合索引 `[git_remote_url, event_time]`

同时新建 `commit_facts` 表（用于跨 session 去重 + 高效仓库聚合）：

| 列 | 类型 | 说明 |
|---|---|---|
| `commit_hash` | VARCHAR(40) | 与 `git_remote_url` 组成主键 |
| `git_remote_url` | VARCHAR(512) | 已规范化 |
| `git_author_email` | VARCHAR(256) | indexed |
| `username` | VARCHAR(128) | 由 ingest 时从同 session 的事件回填 |
| `commit_time` | TIMESTAMP | indexed |
| `subject` | TEXT | |
| `lines_added` | INT | |
| `lines_removed` | INT | |
| `files_count` | INT | |
| `in_intersect` | BOOL | hook 编辑过的文件是否覆盖到此 commit |
| `session_id` | VARCHAR | 首次写入此 commit 的 session（仅供溯源） |

主键 `(commit_hash, git_remote_url)` 保证跨 session 去重：第二次 INSERT 走 `INSERT OR IGNORE`。

`session_commits` 事件的 `extra` JSON 仍保留全量明细（便于审计）：

```json
{
  "edit_files": ["src/a.js", "src/b.js"],
  "window":    { "commit_count": 3, "lines_added": 240, "lines_removed": 80 },
  "intersect": { "commit_count": 2, "lines_added": 180, "lines_removed": 60 },
  "commits": [
    {
      "hash": "abc",
      "time": "...",
      "subject": "feat: x",
      "in_intersect": true,
      "lines_added": 12,
      "lines_removed": 3,
      "files": [{"path":"src/a.js","added":12,"removed":3}]
    }
  ]
}
```

### 2. CLI git helper（新文件 `cli/src/utils/git.js`）

所有 shell-out 使用 `execFileSync`，`timeout: 5000`，`stdio: ['ignore','pipe','ignore']`；任何异常返回 `null` / `[]`，**永不抛错**：

- `isGitRepo(cwd)` — 先查 `.git` 是否存在，再 `rev-parse` 兜底
- `getRemoteUrl(cwd)` — `git -C <cwd> remote get-url origin`
- `getAuthorEmail(cwd)` — `git -C <cwd> config user.email`
- `getCommitsSince(cwd, email, sinceIso)` —
  `git -C <cwd> log --numstat --author=<email> --since=<iso> --pretty=format:%H%x00%aI%x00%s`
  解析为 commit 对象列表

### 3. CLI hook 接入

**`cli/src/hooks/universal-hook.js`**（读完 stdin 后）：

- 计算 `cwd = rawData.cwd || process.cwd()`，通过 `rawData` 传给 adapter
- `SessionStart` 时把 `{session_start_time, cwd}` 写入新 `session_meta` SQLite 表（主键 `session_id`）
- `PostToolUse`（Edit/Write/NotebookEdit）时，把命中的 `file_path` 累加进 `session_meta.edit_files`（JSON array），用于 SessionEnd 的文件交集
- `SessionEnd` 时，在写完正常事件之后调用 `emitSessionCommits(store, baseEvent, cwd)`：
  1. 从 `session_meta` 读 `session_start_time` 与 `edit_files`（兜底：24h 前 / 空集）
  2. 调 `getRemoteUrl` + `getAuthorEmail` + `getCommitsSince`
  3. 如果 remote 存在且 commits 非空，对每个 commit 算 `in_intersect = commit.files.some(f => edit_files.has(f.path))`，分别累加 `window.*` 与 `intersect.*` 两套总数
  4. 构造 `event_type: 'session_commits'` 事件：
     - 顶层 `lines_added` / `lines_removed` 仍取**窗口口径**（保持与 events 表已有列含义一致）
     - 全量明细放 `extra`（含 `edit_files` / `window` / `intersect` / `commits[].in_intersect`）
  5. `store.insert(event2)` — best-effort，失败吞掉

**`cli/src/hooks/adapters/claude-code.js` 的 `normalize()`**：

- `SessionStart`：设 `base.cwd` / `base.git_remote_url` / `base.git_author_email`
- 其他事件类型：仅透传 `cwd`，**不做 git 查询**（性能考虑）

**`cli/src/collector/event-normalizer.js`**：把 `cwd` / `git_remote_url` / `git_author_email` 加入 adapter 字段白名单。

### 4. 服务端入库过滤

新增 `server/src/services/repo-url.js`：

- `normalizeRepoUrl(raw)` — 剥 userinfo，统一 `git@host:org/repo(.git)` 与 `https://host/org/repo(.git)`，host 小写，去掉尾部 `.git`，返回规范化形式 `host/org/repo`
- `isAllowedDomain(normalized, allowedDomains)` — 前缀匹配 `host/org` 或 `host`

`POST /api/v1/events/batch` 入库前：

- 事件带 `git_remote_url` → 规范化 → 不在 allowlist：**清空** `git_remote_url` / `git_author_email`（事件仍入库，只丢仓库归属）
- `event_type === 'session_commits'` 且不在 allowlist：**整条跳过**
- 在 allowlist 内的 `session_commits`：除了写 events 表，**逐条 commit 写入 `commit_facts`**（`INSERT OR IGNORE`），跨 session 自动去重

### 5. 服务端 stats service

`server/src/services/stats-service.js` 的 `applyFilters` 新增 `repoUrl` / `gitAuthorEmail` 参数。新增方法（**每项指标都独立返回**，前端按需取）：

- `getRepoSummary({start,end,filters})` → 返回完整指标包：
  ```
  {
    edit: { lines_added, lines_removed, lines_net, files_touched, ops_count },
    commit_window:    { commit_count, lines_added, lines_removed, files_count },
    commit_intersect: { commit_count, lines_added, lines_removed, files_count },
    repo_count, developer_count, session_count
  }
  ```
- `getRepoRanking({start,end,groupBy:'user'|'repo'|'user_repo',metric,limit})` —
  `groupBy` 默认 `'user'`（前端默认视角是开发者）；
  `metric` 枚举：`edit_added` / `edit_net` / `commit_added_window` / `commit_added_intersect` / `retention_window` / `retention_intersect` / `churn_ratio`
- `getRepoTrend({start,end,repo,bucket:'day',metrics:[...]})` — 一次返回多条时间序列，前端复选框开关

**实现要点**：
- 编辑指标：从 `tool_use` 类事件聚合 `lines_added` / `lines_removed`
- 提交指标 `commit_window`：直接读 `session_commits` 顶层列
- 提交指标 `commit_intersect`：读 `session_commits.extra.intersect.*`，需要在 SQL 层用 `json_extract(extra, '$.intersect.lines_added')`（SQLite 原生支持）
- 仓库归属：编辑事件 `LEFT JOIN session_repo CTE ON session_id`（CTE 来自 `event_type='session_start' AND git_remote_url IS NOT NULL`）；`session_commits` 自带 `git_remote_url`
- **跨 session 去重**：`session_commits` ingest 时按 `(commit_hash, git_remote_url)` 去重——给 `extra.commits[].hash` 建 dedupe 索引或在写入前先查；简化方案：写入时把每个 commit 拆成单独行存到新表 `commit_facts`，主键 `(hash, git_remote_url)`，统计走该表

### 6. 路由与权限

**两套并行**——和现有 `/api/v1/stats/*` 与 `/api/v1/my/*` 的鉴权模式完全一致：

#### Admin（全量）—— `createAdminGuard` 拦截

- `GET /api/v1/stats/repos/summary` — 完整指标包（全员）
- `GET /api/v1/stats/repos/ranking?groupBy=user|repo|user_repo&metric=<key>&limit=`
- `GET /api/v1/stats/repos/trend?repo=<url>&user=<email>&metrics=edit_added,commit_added_intersect,retention_intersect`
- `GET /api/v1/stats/repos/list` — 已采集到的仓库列表（用于下拉选择器）
- `GET /api/v1/stats/repos/users` — 已采集到的开发者列表（email 列表，用于下拉）

#### 个人（只看自己）—— `createUserGuard` 拦截，强制注入 `username`

- `GET /api/v1/my/repos/summary` — 等价 admin summary，但 filter `username = req.user.login`
- `GET /api/v1/my/repos/ranking?groupBy=repo&metric=<key>` — 个人视角下只允许 `groupBy=repo`（不允许 `user` / `user_repo`，不能看别人）
- `GET /api/v1/my/repos/trend?repo=<url>&metrics=...` — 同样强制按 username 过滤

**服务端实现**：所有 `/my/*` 路由在调用 `stats-service` 前**强制覆写** `filters.username = req.user.login`，避免请求方传任意 `username` 越权。这与现有 `/my/trend`、`/my/recent` 的模式一致。

**Dashboard 切换**：

- 顶部菜单和现在一样有"个人统计 / 全员统计"两个 tab
- "全员统计"下新增"代码量统计"子 tab → 调 `/api/v1/stats/repos/*`，admin 才能看
- "个人统计"下新增"我的代码量"子 tab → 调 `/api/v1/my/repos/*`，所有登录用户都能看自己的
- 非 admin 用户**看不到**"全员统计 → 代码量统计"入口（前端按 `auth.role` 隐藏，后端按 admin guard 兜底）

### 7. Dashboard 新 tab "代码量统计"

`server/src/dashboard/index.html` 新增独立 tab，所有指标可单独切换查看。

**默认视角：开发者**（不是仓库）。理由：管理者最常问"谁在用 AI、产出怎样"，而不是"哪个仓库 AI 用得多"。仓库视角作为切换项 + 下钻入口保留。

**布局**：

```
┌─ 代码量统计 ─────────────────────────────────────────────────────────────┐
│ 视角 ⦿ 开发者  ○ 仓库     [开发者 ▼] [仓库 ▼] [日期范围]                  │
│ 口径 ⦿ 交集（推荐）  ○ 窗口                                                │
├─────────────────────────────────────────────────────────────────────────┤
│ ┌─KPI─┬─KPI─┬─KPI─┬─KPI─┬─KPI─┬─KPI─┐                                    │
│ │编辑+│编辑-│净增│提交+│提交-│保留率│                                    │
│ └─────┴─────┴─────┴─────┴─────┴─────┘                                    │
│                                                                            │
│ ┌── 趋势图（多指标可勾选）──────────────────────────┐                   │
│ │ ☑ 编辑+ ☑ 提交+(交集) ☐ 提交+(窗口) ☐ 保留率 ...  │                   │
│ └──────────────────────────────────────────────────┘                   │
│                                                                            │
│ ┌── 开发者排行（默认）─ 列头点击可切排序 ─────────────────────────┐      │
│ │ 开发者 · 编辑+ · 编辑- · 提交+ · 提交- · 保留率 · Commit · 涉及仓库│      │
│ │ ▶ leon (lj@…)    8,420   2,140   4,820   910   57.2%   38    4    │      │
│ │ ▶ alice (a@corp) 4,580   1,210   2,310   480   50.4%   21    2    │      │
│ │ ...                                                                │      │
│ │ ↳ 点 ▶ 展开：该开发者在各仓库的明细 + 最近 commit                   │      │
│ └────────────────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────────┘
```

**视角切换**：

- ⦿ **开发者**（默认）→ 主表按 `git_author_email` 聚合；下钻：开发者 → 该人在各仓库的拆分 → commit 列表
- ○ **仓库**（次要）→ 主表按 `git_remote_url` 聚合；下钻：仓库 → 该仓库的开发者明细 → commit 列表

两个视角共用同一套 KPI / 趋势图 / 过滤器，只换主排行表的 `groupBy` 和列定义。

**主表列定义**（保留全部 8 列，先不裁；上线后按使用反馈再决定）：

| 视角 | 列 |
|---|---|
| 开发者 | 开发者 · 编辑+ · 编辑- · 提交+ · 提交- · 保留率 · Commit · **涉及仓库数** |
| 仓库 | 仓库 · 编辑+ · 编辑- · 提交+ · 提交- · 保留率 · Commit · **涉及人数** |

**关键交互**：

- **口径切换器**（窗口 / 交集）放全局——切换后所有 KPI / 趋势 / 排行同步刷新；默认"交集"
- **趋势图多指标勾选**：复用 ECharts 多 series，至少支持同时叠加 4 条
- **排行表**列头点击切排序指标
- **行下钻**：开发者视角 → 展开为该人在各仓库的拆分 → 再点进 commit 列表（commit hash / subject / +/− / 是否落入交集）
- 复用现有日期范围选择器与全站 admin 鉴权

**用户个人视角**（`/my/repos`）：默认就是当前登录用户自己，**无视角切换、无开发者过滤器**，主排行表直接就是该用户在各仓库的明细（即 admin 视角下钻第二层的样子）。

### 8. 管理员配置

`~/.agent-tools-server/config.json` 新增：

```json
"repoTracking": {
  "enabled": true,
  "allowedDomains": ["github.com/myorg", "gitlab.corp.com"]
}
```

每次请求时重新读取（复用现有 `guard` 热读模式）。先采用文件编辑方式，不加 UI。

### 9. 异常处理

- 没装 git / 不是 git 仓库 / 超时 → `getRemoteUrl` 返回 null → SessionStart 仍记录（只是无 git 字段），不发 `session_commits`
- 会话期间无提交 → 不发 `session_commits`，避免零值行
- 老版本客户端没有新字段 → 入库层容忍缺列
- 时钟漂移：服务端不重算窗口，只用 CLI 自己记录的 `session_start_time`

## 验证步骤

1. 在一个 tracked 仓库里 `cd` 进去 → 启动 Claude Code → 编辑+提交 → 退出。查 `~/.agent-tools/data/local.db`：应有带 `git_remote_url` 的 SessionStart、带 `cwd` 的编辑事件、一条 `session_commits` 记录。
2. 强制同步（`agent-tools sync`）：服务端 DB 有对应行，URL 已规范化。
3. `curl /api/v1/stats/repos/summary` — 保留率 = commit/edit，`repo_count > 0`。
4. 负向：`cd /tmp && claude` → 无 git 字段，无报错。
5. allowlist：在非列表仓库里编辑 → 行仍入库但 `git_remote_url` 被清空；无仓库维度数据泄露。
6. 打开 Dashboard "项目统计" tab → KPI / 柱状图 / 表格有数据；点行下钻到趋势图。
7. 单元测试：
   - `server/tests/repo-url.test.js`（URL 规范化的各类边界）
   - `cli/tests/git.test.js`（使用临时仓库 fixture）
