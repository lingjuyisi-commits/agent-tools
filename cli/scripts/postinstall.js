#!/usr/bin/env node

// Post-install script: detect agents and suggest initialization.
// Must never fail the installation — wrap everything in try/catch.

try {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');

  // Use the detector module to find installed agents
  const { detectAll } = require('../src/detector');

  console.log('\n[agent-tools] Scanning for installed AI coding agents...\n');

  const agents = detectAll();
  const detected = agents.filter(a => a.installed || a.configExists);

  if (detected.length > 0) {
    console.log('  Detected:');
    for (const a of detected) {
      const parts = [];
      if (a.installed) parts.push('in PATH');
      if (a.configExists) parts.push('config dir exists');
      if (a.hooksConfigured) parts.push('hooks already configured');
      console.log(`    + ${a.name} (${parts.join(', ')})`);
    }
  } else {
    console.log('  No supported AI coding agents detected.');
  }

  const configPath = path.join(os.homedir(), '.agent-tools', 'config.json');
  if (fs.existsSync(configPath)) {
    console.log('\n  Already initialized. Run "agent-tools setup" to update hooks.\n');
  } else {
    console.log('\n  To get started, run:');
    console.log('    agent-tools init');
    console.log('\n  For local development:');
    console.log('    agent-tools init --server http://localhost:3000\n');
  }
} catch {
  // Post-install should never fail the installation
}
