#!/usr/bin/env node

// Long-running guard process — watches ~/.claude/settings.json and re-injects
// agent-tools hooks whenever they get wiped or overwritten by external tools
// (primarily cc-switch). Started by the OS autostart mechanism (schtasks on
// Windows, LaunchAgent on macOS). Safe to run in foreground; blocks forever.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR    = path.join(os.homedir(), '.claude');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const HOME          = path.join(os.homedir(), '.agent-tools');
const LOCK_FILE     = path.join(HOME, '.guard.lock');
const LOG_FILE      = path.join(HOME, 'data', 'guard-log.json');

const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse',
  'UserPromptSubmit', 'Stop',
];

const DEBOUNCE_MS           = 500;
const HEARTBEAT_MS          = 5 * 60 * 1000;
const SELF_WRITE_IGNORE_MS  = 10 * 1000;
const MAX_LOG_ENTRIES       = 100;
const WATCH_RETRY_MS        = 30 * 1000;

let lastSelfWriteAt = 0;
let debounceTimer   = null;
let heartbeatTimer  = null;
let currentWatcher  = null;

// ===== Logging =====

function log(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    let logs = [];
    if (fs.existsSync(LOG_FILE)) {
      try { logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')); } catch {}
      if (!Array.isArray(logs)) logs = [];
    }
    logs.push({ ...entry, time: new Date().toISOString(), pid: process.pid });
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs.slice(-MAX_LOG_ENTRIES), null, 2));
  } catch {}
}

// ===== Lock (prevent multiple instances) =====

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8'), 10);
    if (pid && pid !== process.pid && isProcessAlive(pid)) {
      throw new Error(`guard already running (pid ${pid})`);
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8'), 10);
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ===== Heal logic =====

function hooksIntact(settings) {
  if (!settings || !settings.hooks) return false;
  for (const ev of HOOK_EVENTS) {
    const entries = settings.hooks[ev];
    if (!Array.isArray(entries) || entries.length === 0) return false;
    const hasOurs = entries.some((h) => {
      if (h && typeof h.command === 'string' && h.command.includes('agent-tools')) return true;
      if (h && Array.isArray(h.hooks)) {
        return h.hooks.some((i) => i && typeof i.command === 'string' && i.command.includes('agent-tools'));
      }
      return false;
    });
    if (!hasOurs) return false;
  }
  return true;
}

function checkAndHeal(reason) {
  // Skip if we just wrote settings ourselves — avoid reacting to our own write
  if (Date.now() - lastSelfWriteAt < SELF_WRITE_IGNORE_MS) return;

  // If Claude Code has never run, no settings.json exists yet. Nothing to heal.
  if (!fs.existsSync(SETTINGS_FILE)) return;

  let settings = null;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch (err) {
    log({ reason, event: 'settings-parse-failed', error: err.message });
    // Don't touch a file we can't parse — user may have a syntax error in progress.
    return;
  }

  if (hooksIntact(settings)) return;

  try {
    const { setupAll } = require('../detector');
    const results = setupAll({ force: true });
    lastSelfWriteAt = Date.now();
    log({ reason, event: 'healed', results });
  } catch (err) {
    log({ reason, event: 'heal-failed', error: err.message });
  }
}

function scheduleHeal(reason) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    checkAndHeal(reason);
  }, DEBOUNCE_MS);
}

// ===== Watcher =====

function startWatcher() {
  if (currentWatcher) return;
  if (!fs.existsSync(CLAUDE_DIR)) {
    // Claude Code not yet installed / run — retry later.
    setTimeout(startWatcher, WATCH_RETRY_MS);
    return;
  }

  try {
    // Watch the DIRECTORY, not the file: cc-switch and similar tools often
    // replace settings.json atomically (write temp + rename), which changes
    // the inode and would silently detach a file-level watch.
    currentWatcher = fs.watch(CLAUDE_DIR, { persistent: true }, (eventType, filename) => {
      if (filename !== 'settings.json') return;
      scheduleHeal(`fs.watch:${eventType}`);
    });
    currentWatcher.on('error', (err) => {
      log({ event: 'watcher-error', error: err.message });
      try { currentWatcher.close(); } catch {}
      currentWatcher = null;
      setTimeout(startWatcher, WATCH_RETRY_MS);
    });
    log({ event: 'watcher-started', dir: CLAUDE_DIR });
  } catch (err) {
    log({ event: 'watcher-start-failed', error: err.message });
    setTimeout(startWatcher, WATCH_RETRY_MS);
  }
}

// ===== Main =====

function main() {
  try {
    acquireLock();
  } catch (err) {
    // Another instance is running — exit quietly.
    log({ event: 'startup-skipped', reason: err.message });
    return;
  }

  log({ event: 'startup' });

  const cleanup = () => {
    releaseLock();
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT',  cleanup);
  process.on('exit', releaseLock);

  // Initial heal on startup — in case settings.json was wiped while guard was down.
  checkAndHeal('startup');

  startWatcher();

  // Heartbeat: periodic safety net in case fs.watch silently stops delivering
  // events (happens on some filesystems and when the dir is replaced).
  heartbeatTimer = setInterval(() => checkAndHeal('heartbeat'), HEARTBEAT_MS);
}

if (require.main === module) main();

module.exports = { main, checkAndHeal, hooksIntact };
