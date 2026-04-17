const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const name = 'claude-code';
const displayName = 'Claude Code';
const CONFIG_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse',
  'UserPromptSubmit', 'Stop',
];

// True if the entry (flat or nested form) is an agent-tools hook.
// Matches the universal-hook.js filename rather than the looser string
// "agent-tools" — avoids false-positive hits on unrelated user hooks that
// happen to have "agent-tools" in their command path.
function isAgentToolsHookEntry(h) {
  if (!h) return false;
  const isOurs = (cmd) => typeof cmd === 'string' && cmd.includes('universal-hook.js');
  if (isOurs(h.command)) return true;
  if (Array.isArray(h.hooks)) return h.hooks.some((i) => i && isOurs(i.command));
  return false;
}

// Strict check: every HOOK_EVENT has at least one agent-tools entry.
// Used by the guard to decide whether settings.json needs re-injection.
function hasAllAgentToolsHooks(settings) {
  if (!settings || !settings.hooks) return false;
  for (const ev of HOOK_EVENTS) {
    const entries = settings.hooks[ev];
    if (!Array.isArray(entries) || entries.length === 0) return false;
    if (!entries.some(isAgentToolsHookEntry)) return false;
  }
  return true;
}

/**
 * Get the installed Claude Code version string (e.g. "2.1.92").
 * Returns null if not installed or version cannot be determined.
 */
function getVersion() {
  try {
    const output = execSync('claude --version', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    // Output format: "2.1.92 (Claude Code)" or just "2.1.92"
    const match = output.match(/^(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch { return null; }
}

/**
 * Compare two semver strings. Returns true if `ver` >= `minVer`.
 */
function versionGte(ver, minVer) {
  const a = ver.split('.').map(Number);
  const b = minVer.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true; // equal
}

/**
 * Claude Code ≥ 2.1.0 requires hooks in nested format:
 *   { matcher: "", hooks: [{ type: "command", command: "..." }] }
 * Older versions use flat format:
 *   { type: "command", command: "..." }
 * Using old format on ≥ 2.1.0 silently fails (Zod schema drops entire settings).
 * Using new format on < 2.1.0 is untested but unlikely to work.
 */
function needsNestedFormat() {
  const ver = getVersion();
  if (!ver) return true; // default to new format (safer — old format is catastrophic on new versions)
  return versionGte(ver, '2.1.0');
}

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

  const hookScript = path.join(__dirname, '..', 'hooks', 'universal-hook.js');

  if (!settings.hooks) settings.hooks = {};

  const nested = needsNestedFormat();

  for (const event of HOOK_EVENTS) {
    const command = `node "${hookScript}" --agent=claude-code --event=${event}`;

    // Build hook entry in the format matching the installed version.
    // ≥ 2.1.0: nested { matcher, hooks: [{ type, command }] }
    // < 2.1.0: flat { type, command }
    const hookEntry = nested
      ? { matcher: '', hooks: [{ type: 'command', command, async: true }] }
      : { type: 'command', command, async: true };

    if (!settings.hooks[event]) {
      settings.hooks[event] = [hookEntry];
    } else if (!Array.isArray(settings.hooks[event])) {
      // Normalize to array
      settings.hooks[event] = [settings.hooks[event], hookEntry];
    } else {
      // If using nested format, migrate any old-format entries
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

      const idx = settings.hooks[event].findIndex(isAgentToolsHookEntry);
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
  hasAllAgentToolsHooks,
  isAgentToolsHookEntry,
  injectHooks,
  getVersion,
  needsNestedFormat,
  HOOK_EVENTS,
  CONFIG_DIR,
  SETTINGS_FILE,
};
