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

      -- Per-session scratch space used by the repo-commit tracking feature.
      -- Populated on SessionStart (start_time, cwd, git fields) and updated
      -- on each PostToolUse Edit/Write (edit_files JSON array). Read on
      -- SessionEnd to drive git log --numstat --since=<start> and the
      -- file-intersection filter for AI-attribution. Rows are best-effort
      -- and never blocking -- failure to write must not crash the hook.
      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        start_time TEXT,
        cwd TEXT,
        git_remote_url TEXT,
        git_author_email TEXT,
        edit_files TEXT,           -- JSON array of distinct file paths
        updated_at TEXT NOT NULL
      );
    `);
  }

  // ── session_meta helpers ──────────────────────────────────────────────────
  // Used by universal-hook to remember per-session context across hook
  // invocations (each hook is its own short-lived process).

  upsertSessionMeta(sessionId, fields) {
    if (!sessionId) return;
    const existing = this.getSessionMeta(sessionId) || {};
    const merged = {
      session_id: sessionId,
      start_time: fields.start_time ?? existing.start_time ?? null,
      cwd: fields.cwd ?? existing.cwd ?? null,
      git_remote_url: fields.git_remote_url ?? existing.git_remote_url ?? null,
      git_author_email: fields.git_author_email ?? existing.git_author_email ?? null,
      edit_files: fields.edit_files ?? existing.edit_files ?? '[]',
      updated_at: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO session_meta (session_id, start_time, cwd, git_remote_url, git_author_email, edit_files, updated_at)
      VALUES (@session_id, @start_time, @cwd, @git_remote_url, @git_author_email, @edit_files, @updated_at)
      ON CONFLICT(session_id) DO UPDATE SET
        start_time       = COALESCE(excluded.start_time, session_meta.start_time),
        cwd              = COALESCE(excluded.cwd, session_meta.cwd),
        git_remote_url   = COALESCE(excluded.git_remote_url, session_meta.git_remote_url),
        git_author_email = COALESCE(excluded.git_author_email, session_meta.git_author_email),
        edit_files       = excluded.edit_files,
        updated_at       = excluded.updated_at
    `).run(merged);
  }

  getSessionMeta(sessionId) {
    if (!sessionId) return null;
    return this.db.prepare('SELECT * FROM session_meta WHERE session_id = ?').get(sessionId) || null;
  }

  /** Add a file path to the session's edit_files set. Idempotent (no duplicates). */
  addSessionEditFile(sessionId, filePath) {
    if (!sessionId || !filePath) return;
    const row = this.getSessionMeta(sessionId);
    let files = [];
    if (row?.edit_files) {
      try { files = JSON.parse(row.edit_files); } catch {}
      if (!Array.isArray(files)) files = [];
    }
    if (files.indexOf(filePath) === -1) {
      files.push(filePath);
      this.upsertSessionMeta(sessionId, { edit_files: JSON.stringify(files) });
    }
  }

  /** Best-effort cleanup — not currently called automatically; a future
   *  cron could prune sessions older than N days. Intentionally lenient. */
  pruneSessionMeta(olderThanIso) {
    try {
      this.db.prepare('DELETE FROM session_meta WHERE updated_at < ?').run(olderThanIso);
    } catch {}
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
