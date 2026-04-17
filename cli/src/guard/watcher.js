#!/usr/bin/env node

// Long-running guard process — watches ~/.claude/settings.json and re-injects
// agent-tools hooks whenever they get wiped or overwritten by external tools
// (primarily cc-switch). Started by the OS autostart mechanism (schtasks on
// Windows, LaunchAgent on macOS). Safe to run in foreground; blocks forever.

const fs = require('fs');
const path = require('path');
const os = require('os');
const claudeCode = require('../detector/claude-code');
const { appendLog } = require('../utils/json-logger');

const CLAUDE_DIR    = claudeCode.CONFIG_DIR;
const SETTINGS_FILE = claudeCode.SETTINGS_FILE;
const HOME          = path.join(os.homedir(), '.agent-tools');
const LOCK_FILE     = path.join(HOME, '.guard.lock');
const LOG_FILE      = path.join(HOME, 'data', 'guard-log.json');

const DEBOUNCE_MS            = 500;
const HEARTBEAT_MS           = 5 * 60 * 1000;
const SELF_WRITE_IGNORE_MS   = 10 * 1000;
const MAX_LOG_ENTRIES        = 100;
const WATCH_RETRY_MIN_MS     = 30 * 1000;
const WATCH_RETRY_MAX_MS     = 5 * 60 * 1000;

let lastSelfWriteAt = 0;
let debounceTimer   = null;
let heartbeatTimer  = null;
let currentWatcher  = null;
let nextRetryMs     = WATCH_RETRY_MIN_MS;

function log(entry) {
  appendLog(LOG_FILE, { ...entry, pid: process.pid }, MAX_LOG_ENTRIES);
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

function checkAndHeal(reason) {
  // Suppress feedback loop: our own setupAll write also fires fs.watch.
  if (Date.now() - lastSelfWriteAt < SELF_WRITE_IGNORE_MS) return;

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return;
    // Don't touch a file we can't parse — user may have a syntax error in progress.
    log({ reason, event: 'settings-parse-failed', error: err.message });
    return;
  }

  if (claudeCode.hasAllAgentToolsHooks(settings)) return;

  try {
    const { setupAll } = require('../detector');
    // Set BEFORE the write so any fs.watch event fired during setupAll is
    // suppressed. If the write throws, the next heartbeat retries anyway.
    lastSelfWriteAt = Date.now();
    const results = setupAll({ force: true });
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

function scheduleRetry() {
  setTimeout(startWatcher, nextRetryMs);
  nextRetryMs = Math.min(nextRetryMs * 2, WATCH_RETRY_MAX_MS);
}

function startWatcher() {
  if (currentWatcher) return;
  if (!fs.existsSync(CLAUDE_DIR)) {
    scheduleRetry();
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
      scheduleRetry();
    });
    log({ event: 'watcher-started', dir: CLAUDE_DIR });
    nextRetryMs = WATCH_RETRY_MIN_MS;
  } catch (err) {
    log({ event: 'watcher-start-failed', error: err.message });
    scheduleRetry();
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
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (debounceTimer)  clearTimeout(debounceTimer);
    if (currentWatcher) { try { currentWatcher.close(); } catch {} }
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

module.exports = { main };
