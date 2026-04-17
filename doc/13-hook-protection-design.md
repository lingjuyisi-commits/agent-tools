# Hook 保护与自愈设计

## Context

现象：用户安装新版 CLI 后，Dashboard 仍显示其活跃在旧版本，甚至完全没有新事件上报。重装、重启均无效。

排查结论：**钩子在 `~/.claude/settings.json` 里被抹掉或路径过时**，导致 Claude Code 启动后根本不调用 `universal-hook.js`，事件无从产生。

有两条独立的成因，下面分别给出决策过程和方案。

---

## 成因一：升级后 hook 路径未刷新

### 根因

`cli/scripts/postinstall.js:62` 调用 `setupAll()` 时没有传 `force`。而 `cli/src/detector/claude-code.js:124-136` 的逻辑是：**检测到已有 agent-tools 钩子就跳过**，不覆盖。

结果：首次安装把 `universal-hook.js` 的绝对路径写进了 settings.json；之后 npm 升级即便把文件写到了同一个全局目录，只要首次安装位置和升级位置不一致（例如一次管理员一次普通用户、nvm 切换等），settings 里那条钩子就永远指向旧路径，永远跑老代码。

### 方案

一行改动：`setupAll()` → `setupAll({ force: true })`。

`injectHooks` 只会替换"包含 agent-tools 的那一条"，用户自己写的钩子不受影响。

### 状态

已合并到 master（commit `a1519b9`）。

---

## 成因二：外部工具（cc-switch）覆盖 settings.json

### 根因

`farion1231/cc-switch` 在启动及切换供应商时会用一个精简模板**整块重写** `~/.claude/settings.json`，把 `hooks`、`permissions`、`contextFiles` 等字段全部抹掉（参见 cc-switch issue #1198、#685、#927）。之后 Claude Code 再启动就读不到钩子，事件采集完全中断。

### 关键事实

实测确认：**Claude Code 对 settings.json 是热加载**，不是会话启动时缓存。所以：

- cc-switch 写完的那一刻，当前会话的钩子立即失效；
- 任何"在钩子内自检并补回 settings.json"的方案（下文称 Plan A）都**没有入口** —— 钩子已被抹，永远不会被调起来。

### 候选方案

| 方案 | 思路 | 能否解决 cc-switch |
|---|---|---|
| **A. 钩子内自检** | `universal-hook.js` 每次触发时检查 settings.json 完整性，缺了就补 | ❌ 钩子抹光就没入口 |
| **B1. 包装 claude 命令** | 往 PATH 里放 wrapper，每次启动 Claude 前补钩子 | ⚠️ 仅覆盖"下次启动"；运行中被抹救不回 |
| **B2. 定时任务** | schtasks / launchd StartInterval 每 N 分钟跑一次 `agent-tools heal` | ✅ N 分钟恢复窗口 |
| **B3-a. OS 原生文件事件** | launchd WatchPaths / systemd PathChanged 监听 settings.json | ✅ 秒级恢复，但 Windows 无原生支持 |
| **B3-b. 常驻 node watcher** | 长进程 fs.watch，一家实现三平台自启 | ✅ 秒级恢复，跨平台统一 |

A 被热加载特性直接判死。B1 对"运行中被抹"这个高频场景无效（cc-switch 跟着开机自启时就会抹一次）。B2/B3 是真正的候选。

### B3-a vs B3-b：为什么不混合

曾考虑 mac/Linux 走 B3-a（零常驻）、Windows 退化到 B3-b。在"均衡平台"下这是最佳方案，**但部署环境是 Windows 主导，极少 mac，无 Linux**，这个混合没有回报：

- 多维护一套 launchd plist + systemd unit 代码只服务极少数 mac；
- Windows 那头无论选哪个，终究是 B3-b；
- B3-a 的主要收益（零常驻）只对 mac/Linux 生效，占比过小。

### B2 vs B3-b：最终权衡

| 维度 | B2（每 1 min 定时） | B3-b（常驻 watcher） |
|---|---|---|
| 恢复延迟 | 最多 1 分钟 | 秒级 |
| 常驻进程 | 无 | 有（~30–50 MB） |
| Windows 任务管理器可见性 | 只在触发瞬间有个 node 进程 | 一直可见 |
| 企业 EDR 观感 | 定时任务属于标准运维动作 | 常驻进程容易被盯 |
| 崩溃恢复 | 无需（每次新进程） | 依赖 Restart/KeepAlive 语义 |
| 卸载复杂度 | 一条 `schtasks /delete` | 需要确保进程被 kill |

B2 更贴合企业 Windows 环境。但用户选择了 **B3-b**，理由是对恢复延迟的要求高于内存/观感代价。

### 最终决策：B3-b

> 用长驻 node watcher，三平台统一实现逻辑，通过各自的自启机制拉起。

#### 实施拆解

1. **`cli/src/guard/watcher.js`**（核心长进程）
   - `fs.watch('~/.claude/', { persistent: true })`：监控目录而非文件，防止 cc-switch 的"写临时文件 + rename"导致 inode 变化造成 watch 句柄失效；
   - 过滤：仅处理 `filename === 'settings.json'` 的事件；
   - 去抖：500ms 合并连续事件；
   - 心跳：每 5 分钟兜底跑一次 `setupAll({ force: true })`，防 watch 句柄静默丢失；
   - 互斥：`~/.agent-tools/.guard.lock` PID 文件，防止多实例；
   - 自写忽略：记录自己最近一次写 settings.json 的时间戳，10 秒内触发的事件直接跳过，避免循环；
   - 日志：追加到 `~/.agent-tools/data/guard-log.json`，保留最近 100 条。

2. **`cli/src/guard/index.js`**（平台分发）
   - 导出 `install()` / `uninstall()` / `status()` / `run()`；
   - `run()` 启动 watcher（阻塞）；
   - `install/uninstall` 按 `process.platform` 分派到 `windows.js` / `darwin.js`。

3. **`cli/src/guard/windows.js`**
   - 写 VBS launcher 到 `%APPDATA%\agent-tools\guard-launcher.vbs`，内容是 `WshShell.Run "node path/to/watcher.js", 0, False`（窗口模式 0 = 隐藏）；
   - `schtasks /create /tn "AgentToolsGuard" /sc ONLOGON /rl LIMITED /tr "wscript.exe <VBS path>" /f`；
   - 启动时立即 `schtasks /run` 一次，不等下次登录；
   - 卸载：先 `schtasks /end /tn`，再 `schtasks /delete /tn /f`，再删 VBS。

4. **`cli/src/guard/darwin.js`**
   - 写 plist 到 `~/Library/LaunchAgents/com.agent-tools.guard.plist`，包含：
     - `ProgramArguments`：`[process.execPath, "path/to/watcher.js"]`（安装时固化 node 路径）；
     - `RunAtLoad = true`；
     - `KeepAlive = true`（崩溃自动拉起）；
     - `StandardOutPath` / `StandardErrorPath` 指向 `~/.agent-tools/data/guard.{out,err}`；
   - `launchctl bootstrap gui/$UID <plist>`；
   - 卸载：`launchctl bootout` + 删 plist。

5. **CLI 入口 `bin/cli.js`** 新增子命令
   - `agent-tools guard install` / `uninstall` / `status` / `run`；
   - 默认 opt-in：postinstall 不自动装 guard，由用户按需启用。

6. **postinstall / preuninstall 集成（第二步再做）**
   - `postinstall.js` 末尾：若 `~/.agent-tools/config.json` 的 `guard.enabled === true`，则静默调用 `guard install`；
   - `preuninstall.js`：无条件调用 `guard uninstall`，失败静默；
   - 先不默认开启，观察一段时间用户反馈再决定是否默认启用。

#### 风险与回退

- **企业 EDR 拦截 schtasks 创建或 node 长进程**：无法绕过，提供 `agent-tools guard uninstall` 干净回退；
- **node 版本切换（nvm / fnm）后旧的 watcher 指向失效 node**：重装时固化当前 `process.execPath`，升级后需要 `guard uninstall && guard install` 刷新。建议在 postinstall 里加一步"已装则重装"逻辑；
- **watcher 自身崩溃**：macOS 靠 KeepAlive 拉起；Windows 靠 schtasks 的 `/RL` + Task Scheduler 重试策略（需补配）；
- **cc-switch 改变覆盖机制（比如切成合并而非替换）**：watcher 仍然有效，因为我们只关心"钩子是否完整"，不假设具体的覆盖方式。

---

## 总结

| 成因 | 方案 | 状态 |
|---|---|---|
| 升级路径未刷新 | `setupAll({ force: true })` | 已合并 master |
| cc-switch 抹掉 settings.json | B3-b 常驻 watcher + 平台自启 | 待实现 |

下一步：按本文 "实施拆解" 在 `claude/fix-client-version-update-4dRWh` 分支上实现 B3-b。
