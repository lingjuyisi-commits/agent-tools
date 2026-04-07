const config = require('../utils/config');
const { LocalStore } = require('./local-store');

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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(15000),
      });

      if (response.ok) {
        const result = await response.json();
        const ids = events.map(e => e.event_id);
        store.markSynced(ids);
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
}

module.exports = { Uploader };
