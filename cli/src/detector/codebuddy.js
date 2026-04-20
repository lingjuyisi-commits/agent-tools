const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { versionGte } = require('../utils/semver');

const name = 'codebuddy';
const displayName = 'CodeBuddy';
const CONFIG_DIR = path.join(os.homedir(), '.codebuddy');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

// CodeBuddy (≥ 2.x, fork of Claude Code) supports all 7 hook events.
// Previous versions only injected PreToolUse/PostToolUse, which missed session
// lifecycle and skill invocation data.
const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'];

function getVersion() {
  try {
    const output = execSync('codebuddy --version', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const match = output.match(/^(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch { return null; }
}

// CodeBuddy is a Claude Code fork — same Zod schema validation applies.
// Version threshold is conservative: default to nested (safe) when unknown.
function needsNestedFormat() {
  const ver = getVersion();
  if (!ver) return true;
  return versionGte(ver, '2.1.0');
}

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
  const hookEvents = HOOK_EVENTS;
  const nested = needsNestedFormat();

  if (!settings.hooks) settings.hooks = {};
  for (const event of hookEvents) {
    const command = `node "${hookScript}" --agent=codebuddy --event=${event}`;
    const hookEntry = nested
      ? { matcher: '', hooks: [{ type: 'command', command, async: true }] }
      : { type: 'command', command, async: true };
    if (!settings.hooks[event]) {
      settings.hooks[event] = [hookEntry];
    } else if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [settings.hooks[event], hookEntry];
    } else {
      if (nested) {
        settings.hooks[event] = settings.hooks[event].map((h) => {
          if (h.command && !h.hooks) {
            const inner = { type: 'command', command: h.command };
            if (h.async !== undefined) inner.async = h.async;
            return { matcher: h.matcher ?? '', hooks: [inner] };
          }
          return h;
        });
      }
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

module.exports = { name, displayName, isInstalled, configExists, hasAgentToolsHooks, injectHooks, getVersion, needsNestedFormat, CONFIG_DIR, SETTINGS_FILE, HOOK_EVENTS };
