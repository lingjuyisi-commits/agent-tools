#!/usr/bin/env node

// Post-install script:
// 1. Apply default-config.json (server URL pre-configured by server download API)
// 2. Detect agents and suggest initialization
// Must never fail the installation — wrap everything in try/catch.

try {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');

  // --- Check better-sqlite3 ABI compatibility ---
  // When installed from a local .tgz, the bundled prebuilt binary may have been
  // compiled against a different Node.js ABI (e.g. the package was built on
  // Node 24 but the user runs Node 22). Detect this early and auto-rebuild.
  try {
    require('better-sqlite3');
  } catch (e) {
    // Only handle the specific ABI mismatch case. Rely on err.code rather than
    // error message text — Node.js wording is not a stable API.
    if (e.code === 'ERR_DLOPEN_FAILED') {
      console.log('\n[agent-tools] 检测到 better-sqlite3 与当前 Node.js 版本不兼容，正在重新编译...');
      console.log('              （首次编译可能需要 1-2 分钟，请耐心等待）');
      const pkgRoot = path.join(__dirname, '..');

      // Rename stale native binaries to .bak instead of deleting, so a failed
      // rebuild (no network, no compiler toolchain) can roll back to the
      // original — better a non-working binary than a totally missing one.
      const staleBinaryPaths = [
        path.join(pkgRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
        path.join(pkgRoot, 'node_modules', 'better-sqlite3', 'build', 'Debug', 'better_sqlite3.node'),
        path.join(pkgRoot, 'node_modules', 'better-sqlite3', 'prebuilds'),
      ];
      const backups = [];
      for (const p of staleBinaryPaths) {
        try {
          if (fs.existsSync(p)) {
            const bak = `${p}.bak-${Date.now()}`;
            fs.renameSync(p, bak);
            backups.push({ original: p, backup: bak });
          }
        } catch {}
      }

      // --ignore-scripts prevents re-running postinstall recursively and avoids
      // Windows npm lock contention from nested lifecycle hooks.
      const rebuildResult = spawnSync(
        'npm', ['rebuild', '--ignore-scripts', 'better-sqlite3'],
        { stdio: 'inherit', shell: true, cwd: pkgRoot, timeout: 180000 },
      );
      if (rebuildResult.status === 0) {
        // Rebuild succeeded — clean up backups.
        for (const { backup } of backups) {
          try { fs.rmSync(backup, { recursive: true, force: true }); } catch {}
        }
        console.log('[agent-tools] better-sqlite3 重新编译成功。\n');
      } else {
        // Rebuild failed — roll back to original binaries (ABI-wrong but at
        // least the file layout is intact for a later manual fix).
        for (const { original, backup } of backups) {
          try {
            if (fs.existsSync(backup) && !fs.existsSync(original)) {
              fs.renameSync(backup, original);
            }
          } catch {}
        }
        console.log('[agent-tools] 重新编译失败，已回滚到原始二进制。');
        console.log('             请手动运行: npm rebuild better-sqlite3');
        console.log('             （需要 Python、node-gyp 及 C++ 编译工具）\n');
      }
    }
  }

  const HOME = path.join(os.homedir(), '.agent-tools');
  const CONFIG_FILE = path.join(HOME, 'config.json');
  const DATA_DIR = path.join(HOME, 'data');

  // --- Apply default config (always overwrite — config is server-controlled) ---
  const defaultCfgPath = path.join(__dirname, '..', 'default-config.json');
  let autoConfigured = false;

  if (fs.existsSync(defaultCfgPath)) {
    const defaultCfg = JSON.parse(fs.readFileSync(defaultCfgPath, 'utf-8'));
    const serverUrl = defaultCfg?.server?.url;

    if (serverUrl) {
      const cfg = {
        ...defaultCfg,
        initialized: true,
        initTime: new Date().toISOString(),
        autoConfigured: true,
      };
      fs.mkdirSync(HOME, { recursive: true });
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
      console.log(`\n[agent-tools] 已配置服务器地址: ${serverUrl}`);
      autoConfigured = true;
    }
  }

  // --- Detect and auto-setup hooks ---
  const { detectAll, setupAll } = require('../src/detector');
  const claudeCode = require('../src/detector/claude-code');

  console.log('\n[agent-tools] 扫描已安装的 AI 编程 Agent...\n');

  const agents = detectAll();
  const detected = agents.filter(a => a.installed || a.configExists);

  if (detected.length > 0) {
    console.log('  检测到:');
    for (const a of detected) {
      const parts = [];
      if (a.installed) parts.push('已安装');
      if (a.configExists) parts.push('配置存在');
      if (a.hooksConfigured) parts.push('hooks 已配置');
      console.log(`    + ${a.name} (${parts.join(', ')})`);
    }

    // Auto-inject hooks for all detected agents.
    // force: true ensures hook script paths are refreshed on every install,
    // so upgrades don't leave stale absolute paths pointing to the old version.
    if (autoConfigured || fs.existsSync(CONFIG_FILE)) {
      console.log('\n  自动注入 hooks...');
      try {
        setupAll({ force: true });
        console.log('  hooks 注入完成。\n');
      } catch {
        console.log('  hooks 注入失败，请手动运行: agent-tools setup\n');
      }
    }
  } else {
    console.log('  未检测到支持的 AI 编程 Agent。');
  }

  if (!autoConfigured && !fs.existsSync(CONFIG_FILE)) {
    console.log('\n  开始使用:');
    console.log('    agent-tools init');
    console.log('\n  本地开发:');
    console.log('    agent-tools init --server http://localhost:3000\n');
  }

  // --- Guard + cc-switch branching ---
  //
  // Protection-aware decision table. cc-switch rewrites ~/.claude/settings.json
  // on every provider switch, even in recent versions — hooks only survive if
  // the user has pasted our universal-hook.js reference into cc-switch's Common
  // Config Snippet (which gets overlaid on the snapshot). We detect that by
  // scanning the raw bytes of cc-switch's local db for the filename.
  //
  // Guard is the safety net whenever we can't confirm protection.
  //
  // Only applies on Windows/macOS with Claude Code detected: guard's whole job
  // is to protect ~/.claude/settings.json.
  const CC_SWITCH_MIN_VERSION  = '3.12.0';
  const CC_SWITCH_BROKEN_VERSION = '3.11.0';

  const hasClaudeCode = detected.some(
    (a) => a.name === claudeCode.name && (a.installed || a.configExists),
  );
  if ((os.platform() === 'win32' || os.platform() === 'darwin') && hasClaudeCode) {
    let guardEnabled = true;
    let downloadUrl  = '';
    let serverUrl    = '';
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (cfg?.guard?.enabled === false) guardEnabled = false;
      if (typeof cfg?.guard?.ccSwitchDownloadUrl === 'string') {
        downloadUrl = cfg.guard.ccSwitchDownloadUrl;
      }
      if (typeof cfg?.server?.url === 'string') serverUrl = cfg.server.url.replace(/\/+$/, '');
    } catch {}

    const troubleshootingUrl = serverUrl ? `${serverUrl}/dashboard/troubleshooting.html` : '';

    try {
      const guard = require('../src/guard');

      if (!guardEnabled) {
        guard.uninstall();
        console.log('[agent-tools] guard 已按配置禁用。');
      } else {
        const ccSwitch = require('../src/detector/cc-switch').detect();
        const { versionGte } = require('../src/utils/semver');

        const isBroken = ccSwitch.installed && ccSwitch.version === CC_SWITCH_BROKEN_VERSION;
        const isRecent = ccSwitch.installed && versionGte(ccSwitch.version, CC_SWITCH_MIN_VERSION);

        if (ccSwitch.installed && ccSwitch.protected && !isBroken) {
          // cc-switch is installed AND our hook is already in Common Config.
          // Switching providers won't wipe settings.json hooks — guard is redundant.
          guard.uninstall();
        } else if (ccSwitch.installed && isBroken) {
          guard.install();
          console.log(`[agent-tools] 检测到 cc-switch v${CC_SWITCH_BROKEN_VERSION}（此版本通用配置合并有 bug）。`);
          console.log(`              请升级到 ≥ ${CC_SWITCH_MIN_VERSION}，guard 已临时启用守护。`);
          if (downloadUrl)       console.log(`              下载: ${downloadUrl}`);
          if (troubleshootingUrl) console.log(`              排查: ${troubleshootingUrl}`);
        } else if (ccSwitch.installed && !ccSwitch.protected) {
          guard.install();
          if (isRecent) {
            console.log(`[agent-tools] 检测到 cc-switch v${ccSwitch.version}，但通用配置里没有 agent-tools 钩子。`);
            console.log('              切换供应商时 settings.json 仍会被重写，钩子会丢。');
            console.log('              请把 agent-tools 钩子加到 cc-switch 的"通用配置"里（详见排查指南）。');
          } else {
            console.log(`[agent-tools] 检测到 cc-switch v${ccSwitch.version}，请升级到 ≥ ${CC_SWITCH_MIN_VERSION}。`);
            if (downloadUrl) console.log(`              下载: ${downloadUrl}`);
          }
          console.log('              guard 已临时启用守护。');
          if (troubleshootingUrl) console.log(`              排查指南: ${troubleshootingUrl}`);
        } else {
          guard.install();
          console.log(`[agent-tools] 未检测到 cc-switch，请安装 ≥ ${CC_SWITCH_MIN_VERSION}。`);
          if (downloadUrl)        console.log(`              下载: ${downloadUrl}`);
          console.log('              guard 已启用，保护 ~/.claude/settings.json 的钩子不被覆盖。');
          if (troubleshootingUrl) console.log(`              排查指南: ${troubleshootingUrl}`);
        }
      }
    } catch (err) {
      console.log(`[agent-tools] guard 配置失败（已忽略）: ${err && err.message}`);
    }
  }
} catch {
  // Post-install should never fail the installation
}
