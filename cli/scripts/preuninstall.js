#!/usr/bin/env node

// Pre-uninstall script:
// 1. Remove agent-tools hooks from all Agent settings files
// 2. Remove ~/.agent-tools/ directory (config, data, local.db)
// Must never fail the uninstallation — wrap everything in try/catch.

try {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');

  const HOME = path.join(os.homedir(), '.agent-tools');

  // --- Remove hooks from Agent settings ---

  const agentConfigs = [
    { name: 'Claude Code', settingsFile: path.join(os.homedir(), '.claude', 'settings.json') },
    { name: 'CodeBuddy', settingsFile: path.join(os.homedir(), '.codebuddy', 'settings.json') },
  ];

  for (const agent of agentConfigs) {
    try {
      if (!fs.existsSync(agent.settingsFile)) continue;

      const raw = fs.readFileSync(agent.settingsFile, 'utf-8');
      if (!raw.includes('agent-tools')) continue;

      const settings = JSON.parse(raw);
      if (!settings.hooks) continue;

      let changed = false;
      for (const event of Object.keys(settings.hooks)) {
        if (!Array.isArray(settings.hooks[event])) continue;

        const before = settings.hooks[event].length;
        settings.hooks[event] = settings.hooks[event].filter((h) => {
          // Old flat format: { type, command }
          if (h.command && h.command.includes('agent-tools')) return false;
          // New nested format: { matcher, hooks: [{ type, command }] }
          if (Array.isArray(h.hooks)) {
            h.hooks = h.hooks.filter((inner) => !inner.command || !inner.command.includes('agent-tools'));
            if (h.hooks.length === 0) return false;
          }
          return true;
        });

        if (settings.hooks[event].length !== before) changed = true;
        if (settings.hooks[event].length === 0) {
          delete settings.hooks[event];
          changed = true;
        }
      }

      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
        changed = true;
      }

      if (changed) {
        fs.writeFileSync(agent.settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
        console.log(`[agent-tools] ${agent.name}: hooks 已清除`);
      }
    } catch {
      // Skip this agent on error
    }
  }

  // --- Remove ~/.agent-tools/ ---

  // --- Remove guard autostart (if installed) ---
  // Unconditional, idempotent: uninstall() is a no-op when not installed.
  // Prevents zombie schtasks tasks / LaunchAgent plists from lingering and
  // spawning failed node invocations after the package is gone.
  if (os.platform() === 'win32' || os.platform() === 'darwin') {
    try {
      require('../src/guard').uninstall();
    } catch {
      // Never block uninstall on guard teardown failure.
    }
  }

  if (fs.existsSync(HOME)) {
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log(`[agent-tools] 已删除 ${HOME}`);
  }

  console.log('[agent-tools] 清理完成');
} catch {
  // Pre-uninstall should never fail the uninstallation
}
