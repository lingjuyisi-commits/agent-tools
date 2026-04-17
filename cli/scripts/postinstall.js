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

  // --- Refresh guard if the user previously opted in ---
  // We do NOT auto-install guard here — it stays opt-in.
  // But if the user already ran `agent-tools guard install` before, we must
  // re-register the autostart entry so it points at this version's watcher.js
  // and uses the current node binary. install() is idempotent.
  if (os.platform() === 'win32' || os.platform() === 'darwin') {
    try {
      const guard = require('../src/guard');
      if (guard.status().installed) {
        guard.install();
        console.log('[agent-tools] guard 已刷新以指向新版本。');
      }
    } catch {
      // Never block install on guard refresh failure.
    }
  }
} catch {
  // Post-install should never fail the installation
}
