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
    const hookEntry = {
      type: 'command',
      command: `node "${hookScript}" --agent=claude-code --event=${event}`,
      async: true,
    };

    if (!settings.hooks[event]) {
      settings.hooks[event] = [hookEntry];
    } else if (!Array.isArray(settings.hooks[event])) {
      // Normalize to array if it isn't
      settings.hooks[event] = [settings.hooks[event], hookEntry];
    } else {
      // Check if agent-tools hook already exists
      const idx = settings.hooks[event].findIndex(
        (h) => h.command && h.command.includes('agent-tools')
      );
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
