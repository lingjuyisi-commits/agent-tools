const Database = require('better-sqlite3');
const config = require('../utils/config');

class LocalStore {
  /**
   * @param {string} [dbPath] - Optional override for the DB file path.
   *   Used by `agent-tools test` to write into an isolated test database
   *   instead of the user's production store.
   */
  constructor(dbPath) {
    if (dbPath) {
      const { mkdirSync } = require('fs');
      const { dirname } = require('path');
      mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new Database(dbPath);
    } else {
      config.ensureDirs();
      this.db = new Database(config.DB_FILE);
    }
    this.db.pragma('journal_mode = WAL');
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        synced INTEGER DEFAULT 0,
        synced_at TEXT DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_synced ON local_events(synced, created_at);
      CREATE INDEX IF NOT EXISTS idx_created ON local_events(created_at);

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(key, value);
  }

  insert(event) {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO local_events (event_id, data, created_at) VALUES (?, ?, ?)');
    stmt.run(event.event_id, JSON.stringify(event), new Date().toISOString());
  }

  getUnsynced(limit = 100) {
    return this.db.prepare('SELECT id, event_id, data FROM local_events WHERE synced = 0 ORDER BY id LIMIT ?')
      .all(limit).map(row => JSON.parse(row.data));
  }

  getUnsyncedCount() {
    return this.db.prepare('SELECT COUNT(*) as count FROM local_events WHERE synced = 0').get().count;
  }

  markSynced(eventIds) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE local_events SET synced = 1, synced_at = ? WHERE event_id = ?');
    const tx = this.db.transaction((ids) => { for (const id of ids) stmt.run(now, id); });
    tx(eventIds);
  }

  getLocalStats(dateFrom, dateTo) {
    return this.db.prepare(`
      SELECT json_extract(data, '$.agent') as agent,
             json_extract(data, '$.event_type') as event_type,
             COUNT(*) as count
      FROM local_events
      WHERE created_at >= ? AND created_at < ?
      GROUP BY agent, event_type ORDER BY agent, count DESC
    `).all(dateFrom, dateTo);
  }

  getAllCount() {
    return this.db.prepare('SELECT COUNT(*) as count FROM local_events').get().count;
  }

  close() { this.db.close(); }
}

module.exports = { LocalStore };
