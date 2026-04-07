const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const name = 'codebuddy';
const displayName = 'CodeBuddy';
const CONFIG_DIR = path.join(os.homedir(), '.codebuddy');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

function isInstalled() {
  try {
    const cmd = os.platform() === 'win32' ? 'where codebuddy' : 'which codebuddy';
    execSync(cmd, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch { return false; }
}

function configExists() { return fs.existsSync(CONFIG_DIR); }

function hasAgentToolsHooks() {
  if (!fs.existsSync(SETTINGS_FILE)) return false;
  try {
    const content = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    return content.includes('agent-tools');
  } catch { return false; }
}

function injectHooks(options = {}) {
  let settings = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')); } catch { settings = {}; }
  }
  const hookScript = path.join(__dirname, '..', 'hooks', 'universal-hook.js');
  const hookEvents = ['PreToolUse', 'PostToolUse'];
  if (!settings.hooks) settings.hooks = {};
  for (const event of hookEvents) {
    // Use new nested format: { matcher: "", hooks: [{type, command}] }
    const hookEntry = {
      matcher: '',
      hooks: [{ type: 'command', command: `node "${hookScript}" --agent=codebuddy --event=${event}`, async: true }],
    };
    if (!settings.hooks[event]) {
      settings.hooks[event] = [hookEntry];
    } else if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [settings.hooks[event], hookEntry];
    } else {
      // Migrate old-format entries
      settings.hooks[event] = settings.hooks[event].map((h) => {
        if (h.command && !h.hooks) {
          const inner = { type: 'command', command: h.command };
          if (h.async !== undefined) inner.async = h.async;
          return { matcher: h.matcher ?? '', hooks: [inner] };
        }
        return h;
      });
      const idx = settings.hooks[event].findIndex((h) => {
        if (h.command && h.command.includes('agent-tools')) return true;
        if (Array.isArray(h.hooks)) return h.hooks.some(i => i.command && i.command.includes('agent-tools'));
        return false;
      });
      if (idx >= 0) { if (options.force) settings.hooks[event][idx] = hookEntry; }
      else { settings.hooks[event].push(hookEntry); }
    }
  }
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  return { success: true, configFile: SETTINGS_FILE };
}

module.exports = { name, displayName, isInstalled, configExists, hasAgentToolsHooks, injectHooks, CONFIG_DIR, SETTINGS_FILE };
