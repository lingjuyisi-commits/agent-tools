const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const name = 'claude-code';
const displayName = 'Claude Code';
const CONFIG_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

function isInstalled() {
  try {
    const cmd = os.platform() === 'win32' ? 'where claude' : 'which claude';
    execSync(cmd, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function configExists() {
  return fs.existsSync(CONFIG_DIR);
}

function hasAgentToolsHooks() {
  if (!fs.existsSync(SETTINGS_FILE)) return false;
  try {
    const content = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    return content.includes('agent-tools');
  } catch {
    return false;
  }
}

function injectHooks(options = {}) {
  // Read existing settings or create new
  let settings = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  // Find path to universal-hook.js
  const hookScript = path.join(__dirname, '..', 'hooks', 'universal-hook.js');

  // Build hooks config for all supported Claude Code events
  const hookEvents = ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'];

  if (!settings.hooks) settings.hooks = {};

  for (const event of hookEvents) {
    // Claude Code ≥ 2.1.x requires hooks in the new nested format:
    //   { matcher: "", hooks: [{ type: "command", command: "..." }] }
    // The old flat format ({ type, command }) silently fails schema validation,
    // causing ALL user settings (including hooks) to be dropped.
    const hookEntry = {
      matcher: '',
      hooks: [{
        type: 'command',
        command: `node "${hookScript}" --agent=claude-code --event=${event}`,
        async: true,
      }],
    };

    if (!settings.hooks[event]) {
      settings.hooks[event] = [hookEntry];
    } else if (!Array.isArray(settings.hooks[event])) {
      // Normalize to array
      settings.hooks[event] = [settings.hooks[event], hookEntry];
    } else {
      // Migrate any old-format entries to new format
      settings.hooks[event] = settings.hooks[event].map((h) => {
        if (h.command && !h.hooks) {
          // Old flat format → wrap in new nested format
          const inner = { type: 'command', command: h.command };
          if (h.async !== undefined) inner.async = h.async;
          return { matcher: h.matcher ?? '', hooks: [inner] };
        }
        return h;
      });

      // Check if agent-tools hook already exists (look inside nested hooks array)
      const idx = settings.hooks[event].findIndex((h) => {
        if (h.command && h.command.includes('agent-tools')) return true;   // old format (just in case)
        if (Array.isArray(h.hooks)) return h.hooks.some(
          (inner) => inner.command && inner.command.includes('agent-tools'),
        );
        return false;
      });
      if (idx >= 0) {
        if (options.force) {
          settings.hooks[event][idx] = hookEntry;
        }
        // else leave existing hook as-is
      } else {
        settings.hooks[event].push(hookEntry);
      }
    }
  }

  // Ensure config dir exists
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');

  return { success: true, configFile: SETTINGS_FILE };
}

module.exports = {
  name,
  displayName,
  isInstalled,
  configExists,
  hasAgentToolsHooks,
  injectHooks,
  CONFIG_DIR,
  SETTINGS_FILE,
};
