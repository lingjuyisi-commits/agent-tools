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

  // --- Auto-apply default config if server URL is pre-configured ---
  const defaultCfgPath = path.join(__dirname, '..', 'default-config.json');
  let autoConfigured = false;

  if (fs.existsSync(defaultCfgPath) && !fs.existsSync(CONFIG_FILE)) {
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
      console.log(`\n[agent-tools] 已自动配置服务器地址: ${serverUrl}`);
      autoConfigured = true;
    }
  }

  // --- Detect installed agents ---
  const { detectAll } = require('../src/detector');

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
  } else {
    console.log('  未检测到支持的 AI 编程 Agent。');
  }

  if (fs.existsSync(CONFIG_FILE) && !autoConfigured) {
    console.log('\n  已初始化。运行 "agent-tools setup" 更新 hooks。\n');
  } else if (!autoConfigured) {
    console.log('\n  开始使用:');
    console.log('    agent-tools init');
    console.log('\n  本地开发:');
    console.log('    agent-tools init --server http://localhost:3000\n');
  } else {
    console.log('\n  运行 "agent-tools setup" 注入 hooks 开始采集数据。\n');
  }
} catch {
  // Post-install should never fail the installation
}
