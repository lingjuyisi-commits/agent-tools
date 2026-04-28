const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../utils/config');
const { LocalStore } = require('./local-store');
const pkg = require('../../package.json');

const UPDATE_LOG_FILE = path.join(os.homedir(), '.agent-tools', 'data', 'update-log.json');
const UPDATE_LOG_CURSOR = path.join(os.homedir(), '.agent-tools', 'data', 'update-log-cursor.json');

class Uploader {
  constructor() {
    const cfg = config.load();
    this.serverUrl = cfg?.server?.url || 'http://localhost:3000';
    this.batchSize = cfg?.sync?.batchSize || 100;
  }

  async sync() {
    const store = new LocalStore();
    try {
      const events = store.getUnsynced(this.batchSize);
      if (events.length === 0) return { synced: 0 };

      const response = await fetch(`${this.serverUrl}/api/v1/events/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Version': pkg.version,
        },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(15000),
      });

      if (response.ok) {
        const result = await response.json();

        // Only mark synced when the server actually accounted for every
        // event. Three benign outcomes per event:
        //   - accepted   (newly stored)
        //   - duplicates (server saw this event_id before)
        //   - dropped    (server intentionally skipped, e.g. session_commits
        //                 to a non-allowlisted repo)
        // If `errors > 0` the server hit a real failure (schema mismatch,
        // bad data) — we DON'T know which event failed, so we leave the
        // whole batch unsynced and retry on next sync. This is what
        // prevents the "client says success, server has nothing" bug from
        // silently losing data when a server is mis-migrated.
        const total = events.length;
        const handled = (result.accepted || 0) + (result.duplicates || 0) + (result.dropped || 0);
        const allHandled = handled === total && !result.errors;

        if (allHandled) {
          const ids = events.map(e => e.event_id);
          store.markSynced(ids);
        } else {
          // Surface the discrepancy so operators can debug. Skip on the
          // first failure too quiet — only print when DEBUG flag set or
          // when the loss would be silent (errors > 0).
          if (process.env.DEBUG_AGENT_TOOLS || result.errors) {
            console.error(
              `[agent-tools] sync incomplete: sent ${total}, accepted ${result.accepted || 0}, ` +
              `duplicates ${result.duplicates || 0}, dropped ${result.dropped || 0}, errors ${result.errors || 0}. ` +
              `Events left unsynced for retry; check server schema (migrations) and logs.`
            );
          }
        }

        // Auto-update: server tells us a newer version is available
        if (result.update?.version && result.update?.downloadUrl) {
          this._triggerAutoUpdate(result.update);
        }

        // Fire-and-forget: upload update logs alongside event sync
        this._reportUpdateLogs().catch(err => {
          if (process.env.DEBUG_AGENT_TOOLS) console.error('[agent-tools] update log report failed:', err.message);
        });

        return { synced: allHandled ? events.length : 0, ...result };
      } else {
        const text = await response.text().catch(() => '');
        return { error: `Server returned ${response.status}: ${text}` };
      }
    } catch (err) {
      return { error: err.message };
    } finally {
      store.close();
    }
  }

  async _reportUpdateLogs() {
    if (!fs.existsSync(UPDATE_LOG_FILE)) return;
    let logs = [];
    try { logs = JSON.parse(fs.readFileSync(UPDATE_LOG_FILE, 'utf-8')); } catch { return; }
    if (!Array.isArray(logs) || logs.length === 0) return;

    // Only send entries newer than the last successfully reported time.
    let lastReported = '';
    try { lastReported = JSON.parse(fs.readFileSync(UPDATE_LOG_CURSOR, 'utf-8'))?.time || ''; } catch {}
    const newLogs = lastReported ? logs.filter(e => e.time > lastReported) : logs;
    if (newLogs.length === 0) return;

    const cfg = config.load();
    const res = await fetch(`${this.serverUrl}/api/v1/updates/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: cfg?.username || os.userInfo().username,
        hostname: os.hostname(),
        platform: os.platform(),
        logs: newLogs,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      // Advance cursor to the latest entry we just reported.
      const latest = newLogs.reduce((max, e) => (e.time > max ? e.time : max), '');
      if (latest) {
        fs.writeFileSync(UPDATE_LOG_CURSOR, JSON.stringify({ time: latest }), 'utf-8');
      }
    }
  }

  /**
   * Fork a detached child process to download and install the update.
   * Non-blocking — current process exits normally.
   */
  _triggerAutoUpdate(update) {
    try {
      const { spawn } = require('child_process');
      const workerPath = require('path').join(__dirname, '..', 'cli', 'check-update-worker.js');
      const downloadUrl = `${this.serverUrl}${update.downloadUrl}`;
      spawn(process.execPath, [workerPath, update.version, downloadUrl], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } catch {
      // Silent — auto-update failure should never affect normal operation
    }
  }
}

module.exports = { Uploader };
