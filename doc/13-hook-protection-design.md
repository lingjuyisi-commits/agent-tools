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
   - 互斥：`~/.agent-tools/.guard.lock` PID 文件，使用 `{ flag: 'wx' }` 原子创建防止 TOCTOU，防止多实例；
   - 自写忽略：`setupAll` 之前（不是之后）记录时间戳，10 秒内触发的事件直接跳过，避免循环；
   - 重试退避：`fs.watch` attach 失败或 CLAUDE_DIR 尚不存在时，从 30s 开始指数退避到 5min 封顶，成功 attach 后复位；
   - 清理：`SIGTERM/SIGINT` 和 `process.exit` 时清掉 heartbeat interval、debounce timeout、watcher handle，再释放 lock；
   - 日志：追加到 `~/.agent-tools/data/guard-log.json`，保留最近 100 条。

2. **`cli/src/guard/index.js`**（平台分发）
   - 导出 `install()` / `uninstall()` / `status()` / `run()`；
   - `run()` 启动 watcher（阻塞）；
   - `install/uninstall` 按 `process.platform` 分派到 `windows.js` / `darwin.js`。

3. **`cli/src/guard/windows.js`**
   - 写 VBS launcher 到 `%APPDATA%\agent-tools\guard-launcher.vbs`，内容是 `WshShell.Run "node path/to/watcher.js", 0, False`（窗口模式 0 = 隐藏）；
   - **VBS 以 UTF-16 LE + BOM 编码写入**：wscript.exe 默认按系统 ANSI 代码页解析 .vbs，UTF-8 路径里的中文字符（例如 `C:\Users\张三\AppData\...`）会被 GBK 误读导致启动失败。UTF-16 LE BOM 是 wscript 稳定支持的 Unicode 形式；
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
   - `agent-tools guard install` / `uninstall` / `status` / `run`。

6. **postinstall / preuninstall 集成**：**默认开启 + 服务端远程开关**
   - `cli/default-config.json` 里加 `guard.enabled: true` 作为默认；
   - `postinstall.js`：
     - 仅当检测到 Claude Code（installed 或 configExists）时执行；
     - 从 `~/.agent-tools/config.json` 读 `guard.enabled`，缺省视为 true；
     - `true` → 调 `guard.install()`（幂等，首次安装 = 注册；之后 = 刷新路径）；
     - `false` → 调 `guard.uninstall()`（幂等，对从未装过的用户也安全）；
   - `preuninstall.js`：无条件调 `guard.uninstall()`，避免残留 schtasks 任务 / LaunchAgent。

#### 为什么默认开启 + 远程开关

之前的草案是"先 opt-in，观察一段再翻 opt-out"。拍板改成默认开启的理由：

- **cc-switch 受害者默认得不到保护**（opt-in 下的最大代价）。在 Windows 为主的办公环境里，受影响人群最多却最不可能自己 opt-in；
- **有 CLI 自升级能力兜底**：如果某家公司的 EDR 拦截 schtasks / 长进程，我们把 `default-config.json` 里的 `guard.enabled` 翻成 false，下一次 `/api/v1/events/batch` 返回的 update 推送就会触发全量自升级，postinstall 检测到开关为 false 会主动卸掉 guard。相当于一个服务端的 kill switch，出事可以集中一键关停；
- **幂等语义让"默认开 + 需要时关"比"默认关 + 需要时开"更安全**：前者出问题能远程关，后者出问题得挨个通知用户开。

#### 风险与回退

- **企业 EDR 拦截 schtasks 创建或 node 长进程**：postinstall 已 try/catch 兜住，install 不会失败；服务端翻 `guard.enabled=false` 作为兜底远程关停；
- **node 版本切换（nvm / fnm）后旧 watcher 指向失效 node**：每次 `npm install -g` 升级时 postinstall 都会重跑 `guard.install()`（幂等），自动用当前 `process.execPath` 覆盖；
- **watcher 自身崩溃**：macOS 靠 KeepAlive 拉起；Windows 下短暂停顿至下次登录触发（接受代价）；
- **cc-switch 改变覆盖机制（比如切成合并而非替换）**：watcher 仍然有效，只关心"钩子是否完整"，不假设具体的覆盖方式。

---

## 远程关停 guard 的操作手册

guard 默认开启，但可以通过服务端一键关停全量用户。流程：

1. 修改 `cli/default-config.json`，把 `guard.enabled` 改成 `false`；
2. 执行 `./build.sh <new-version>`，产出新的 CLI tarball + Server tarball；
3. 部署新 Server（tarball 里已内嵌新 CLI tarball，会覆盖 `server/dist/agent-tools-cli.tgz`）；
4. 用户端继续正常使用 Claude Code，下一次 `/api/v1/events/batch` 请求返回体里会带 `update.version` 和 `downloadUrl`（server 检测到客户端版本旧）；
5. 客户端的 `_triggerAutoUpdate` detached 子进程下载并 `npm install -g <new-tgz>`；
6. 新版 postinstall 读到 `guard.enabled=false`，调 `guard.uninstall()` 清掉 schtasks / LaunchAgent / VBS launcher；
7. watcher 下次登录（Windows）或 launchd 拉起间歇期（macOS）就不会再起来。

全程对用户零感知，无需用户操作。

### 重新开启

把 `guard.enabled` 改回 `true`，重复上述打包和部署流程即可。`guard.install()` 对"之前被 uninstall 掉的机器"是幂等的，会重新注册自启。

### 单台机器手动回退（紧急情况）

```
agent-tools guard uninstall
```

但下一次自升级如果 `guard.enabled=true`，postinstall 会再次装回。只有服务端 kill switch 能**持续**关停。

---

## 已知局限

### guard 自身 bug → 依赖自升级链路回收

整条远程关停链路依赖 CLI 的自升级能力：`events/batch` 响应驱动的 `_triggerAutoUpdate`。如果某一版 guard 引入了足够严重的 bug，导致：

- watcher 死循环把 CPU 打满、或反复重写 settings.json 引发 Claude Code 异常；
- 同时 uploader 也出故障（或被 watcher 的副作用拖死），自升级链路断开；

那么 kill switch 的 update 推送用户收不到，guard 无法远程关停，只能逐台手动 `agent-tools guard uninstall`。

这是经典的 chicken-and-egg —— 管理通道和被管理对象跑在同一台机器上，没有分离的带外控制面。对一个"使用量追踪"级别的工具引入独立的带外通道不划算，所以选择**接受这个风险 + 把 guard 本身写得尽量简单稳定**：

- watcher 主循环只有 fs.watch + 心跳，没有网络调用；
- heal 的唯一副作用是 `setupAll({ force: true })`，复用现有经过考验的逻辑；
- 任何异常都进 try/catch + 写 guard-log.json，不 crash、不反噬 uploader。

如果后面真踩雷，除了逐台手动回退，还可以通过邮件 / IM 引导用户跑一次卸载命令；或者把 "卸载 guard" 的 oneliner 做成单独的小工具下发。

### guard 装完到首次触发之间的短窗口

用户机器上 guard 首次安装后：

- Windows 上 `schtasks /run` 会立即拉起一次，但从 `guard install` 返回到 watcher 真正开始 `fs.watch` 之间有几百毫秒；
- 这个窗口里如果 cc-switch 正好写了 settings.json，会漏掉一次。

由于 cc-switch 多为开机自启或人为触发，这种巧合极少。且 guard 启动时会主动跑一次 `checkAndHeal('startup')`，哪怕漏了 watch 事件也会在启动瞬间补回来。实际影响近似为零。

---

## 总结

| 成因 | 方案 | 状态 |
|---|---|---|
| 升级路径未刷新 | `setupAll({ force: true })` | 已合并 master（a1519b9）|
| cc-switch 抹掉 settings.json | B3-b 常驻 watcher + 平台自启 | 已实现（ea35d34）|
| guard 生命周期（升级刷新、卸载清理） | postinstall / preuninstall 集成 | 已实现（9373019）|
| guard 默认策略 | 默认开启 + 服务端 `guard.enabled` kill switch | 已实现 |
