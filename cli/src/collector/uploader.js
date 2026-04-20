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
        const ids = events.map(e => e.event_id);
        store.markSynced(ids);

        // Auto-update: server tells us a newer version is available
        if (result.update?.version && result.update?.downloadUrl) {
          this._triggerAutoUpdate(result.update);
        }

        // Fire-and-forget: upload update logs alongside event sync
        this._reportUpdateLogs().catch(err => {
          if (process.env.DEBUG_AGENT_TOOLS) console.error('[agent-tools] update log report failed:', err.message);
        });

        return { synced: events.length, ...result };
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
