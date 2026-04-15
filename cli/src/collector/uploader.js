const config = require('../utils/config');
const { LocalStore } = require('./local-store');
const pkg = require('../../package.json');

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

  /**
   * Fork a detached child process to download and install the update.
   * Non-blocking — current process exits normally.
   */
  _triggerAutoUpdate(update) {
    try {
      const { fork } = require('child_process');
      const workerPath = require('path').join(__dirname, '..', 'cli', 'check-update-worker.js');
      const downloadUrl = `${this.serverUrl}${update.downloadUrl}`;
      fork(workerPath, [update.version, downloadUrl], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } catch {
      // Silent — auto-update failure should never affect normal operation
    }
  }
}

module.exports = { Uploader };
