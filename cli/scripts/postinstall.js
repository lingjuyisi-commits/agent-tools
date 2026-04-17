#!/usr/bin/env node

// Post-install script:
// 1. Apply default-config.json (server URL pre-configured by server download API)
// 2. Detect agents and suggest initialization
// Must never fail the installation — wrap everything in try/catch.

try {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');

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

  // --- Install / refresh / disable guard per config ---
  // Default-on with a server-controlled kill switch: config.guard.enabled
  // (bundled in default-config.json, propagated via server's buildCustomTgz).
  // Flip it to false server-side and the next auto-update uninstalls guard
  // on every machine. install()/uninstall() are both idempotent.
  //
  // Only relevant when Claude Code is the agent being used — guard's whole
  // job is to protect ~/.claude/settings.json.
  const hasClaudeCode = detected.some(
    (a) => a.name === 'claude-code' && (a.installed || a.configExists),
  );
  if ((os.platform() === 'win32' || os.platform() === 'darwin') && hasClaudeCode) {
    let guardEnabled = true;
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (cfg?.guard?.enabled === false) guardEnabled = false;
    } catch {
      // No config yet — fall through with the default (enabled).
    }

    try {
      const guard = require('../src/guard');
      if (guardEnabled) {
        guard.install();
        console.log('[agent-tools] guard 已启用（防止外部工具抹掉 ~/.claude/settings.json 里的钩子）。');
      } else {
        guard.uninstall();
        console.log('[agent-tools] guard 已按配置禁用。');
      }
    } catch (err) {
      console.log(`[agent-tools] guard 配置失败（已忽略）: ${err && err.message}`);
    }
  }
} catch {
  // Post-install should never fail the installation
}
