#!/usr/bin/env node

// Called by AI coding agents via hook configuration.
// Reads event data from stdin, normalizes it, stores locally, and optionally syncs.
// MUST never block or crash the agent — all errors are silently caught.

async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  const agentArg = args.find(a => a.startsWith('--agent='));
  const eventArg = args.find(a => a.startsWith('--event='));
  const dbArg   = args.find(a => a.startsWith('--db='));

  const agent    = agentArg ? agentArg.split('=')[1] : 'unknown';
  const eventType = eventArg ? eventArg.split('=')[1] : 'unknown';
  const dbPath   = dbArg ? dbArg.split('=').slice(1).join('=') : null; // support paths with '='

  // Read stdin (agent pipes JSON event data)
  const rawData = await readStdin();

  processEvent(agent, eventType, rawData, dbPath);
}

function readStdin() {
  return new Promise((resolve) => {
    let input = '';
    const stdin = process.stdin;

    // If stdin is a TTY (no pipe), resolve immediately
    if (stdin.isTTY) {
      resolve({});
      return;
    }

    stdin.setEncoding('utf-8');

    // Timeout — don't hang forever if no stdin data arrives
    const timeout = setTimeout(() => {
      stdin.removeAllListeners();
      resolve({});
    }, 1000);

    stdin.on('data', (chunk) => { input += chunk; });

    stdin.on('end', () => {
      clearTimeout(timeout);
      let data = {};
      try {
        if (input.trim()) data = JSON.parse(input);
      } catch {
        // Invalid JSON, use empty object
      }
      resolve(data);
    });

    stdin.on('error', () => {
      clearTimeout(timeout);
      resolve({});
    });

    stdin.resume();
  });
}

function processEvent(agent, eventType, rawData, dbPath) {
  try {
    // Load adapter
    let adapter;
    try {
      adapter = require(`./adapters/${agent}`);
    } catch {
      // Fallback generic adapter
      adapter = {
        normalize: (et, data) => ({
          agent,
          session_id: data.session_id || 'unknown',
          event_type: et.toLowerCase(),
          tool_name: data.tool_name,
          model: data.model,
        }),
      };
    }

    // Normalize event using adapter
    const normalized = adapter.normalize(eventType, rawData);

    // Create full event with system fields using event-normalizer
    const { createNormalizedEvent } = require('../collector/event-normalizer');
    const event = createNormalizedEvent(normalized);

    // Store locally in SQLite (dbPath overrides default when running in test mode)
    const { LocalStore } = require('../collector/local-store');
    const store = new LocalStore(dbPath);
    try {
      store.insert(event);

      // ── Repo-commit tracking side effects ─────────────────────────────
      // All swallowed — must never crash the agent. See doc/15-*.
      try { trackRepoLifecycle(store, eventType, rawData, event); } catch {}

      // Check if we should trigger a background sync.
      // Two conditions (either one triggers sync):
      //   1. Batch threshold: unsynced events >= batchSize (default 100)
      //   2. Time interval:   seconds since last sync >= intervalSeconds (default 300)
      const config = require('../utils/config');
      const cfg = config.load();
      const batchSize = cfg?.sync?.batchSize || 100;
      const intervalSeconds = cfg?.sync?.intervalSeconds || 300;
      const unsyncedCount = store.getUnsyncedCount();

      let shouldSync = false;

      // Condition 1: batch threshold
      if (unsyncedCount >= batchSize) {
        shouldSync = true;
      }

      // Condition 2: time interval (only if there are unsynced events)
      if (!shouldSync && unsyncedCount > 0) {
        const lastSyncAt = store.getMeta('last_sync_at');
        if (lastSyncAt) {
          const elapsed = (Date.now() - new Date(lastSyncAt).getTime()) / 1000;
          if (elapsed >= intervalSeconds) shouldSync = true;
        } else {
          // First run — record start time, wait for interval to elapse
          store.setMeta('last_sync_at', new Date().toISOString());
        }
      }

      if (shouldSync) {
        store.setMeta('last_sync_at', new Date().toISOString());
        store.close();
        // Fire-and-forget sync
        const { Uploader } = require('../collector/uploader');
        const uploader = new Uploader();
        uploader.sync().catch(() => {}).finally(() => process.exit(0));
        return;
      }
    } finally {
      try { store.close(); } catch { /* already closed */ }
    }
  } catch {
    // Never fail — silently exit
  }

  process.exit(0);
}

// ── Repo-commit tracking ──────────────────────────────────────────────────
// Three integration points across the session lifecycle:
//
//   SessionStart  → record start_time + cwd + git context in session_meta
//   PostToolUse   → if Edit/Write/NotebookEdit, add the touched file to the
//                   session's edit_files set (used later for AI attribution)
//   SessionEnd    → run `git log --numstat --since=<start>` in cwd, classify
//                   each commit as in_intersect (touched at least one
//                   edit_files entry) and emit a synthetic `session_commits`
//                   event carrying both window and intersect totals
//
// All work is best-effort and inside try/catch — a non-git cwd, missing git
// binary, or empty result must result in a no-op, never a thrown error.
function trackRepoLifecycle(store, eventType, rawData, event) {
  const sessionId = event.session_id;
  if (!sessionId || sessionId === 'unknown') return;

  if (eventType === 'SessionStart') {
    store.upsertSessionMeta(sessionId, {
      start_time: event.event_time,
      cwd: event.cwd || null,
      git_remote_url: event.git_remote_url || null,
      git_author_email: event.git_author_email || null,
    });
    return;
  }

  if (eventType === 'PostToolUse') {
    // Use the file path from the raw tool_input. The adapter already counted
    // lines but didn't preserve the path. Edit/Write/NotebookEdit all use
    // `file_path`, so a single lookup covers them.
    const input = rawData.tool_input || {};
    const filePath = input.file_path || input.notebook_path || null;
    if (filePath) store.addSessionEditFile(sessionId, filePath);
    return;
  }

  if (eventType === 'SessionEnd') {
    emitSessionCommits(store, sessionId, event);
    return;
  }
}

function emitSessionCommits(store, sessionId, sessionEndEvent) {
  const meta = store.getSessionMeta(sessionId);
  // SessionStart writes meta.cwd + meta.git_author_email + meta.git_remote_url
  // when in a tracked repo. If any of those are missing, this isn't a
  // tracked-repo session — skip entirely without re-shelling out to git.
  if (!meta || !meta.cwd || !meta.git_author_email || !meta.git_remote_url) return;

  const git = require('../utils/git');
  const cwd = meta.cwd;
  const email = meta.git_author_email;
  const remote = meta.git_remote_url;

  // Fall back to 24h ago if we somehow don't have a start_time. Better to
  // overcount than to skip the whole session.
  const since = meta.start_time || new Date(Date.now() - 86400_000).toISOString();
  const commits = git.getCommitsSince(cwd, email, since);
  if (!commits || commits.length === 0) return;

  let editFiles = [];
  try { editFiles = JSON.parse(meta.edit_files || '[]'); } catch {}
  const editSet = new Set(Array.isArray(editFiles) ? editFiles : []);

  const window = { commit_count: 0, lines_added: 0, lines_removed: 0 };
  const intersect = { commit_count: 0, lines_added: 0, lines_removed: 0 };
  const detailed = [];

  for (const c of commits) {
    window.commit_count += 1;
    window.lines_added += c.added;
    window.lines_removed += c.removed;

    let inIntersect = false;
    let iAdded = 0;
    let iRemoved = 0;
    if (editSet.size > 0) {
      for (const f of c.files) {
        if (editSet.has(f.path)) {
          inIntersect = true;
          iAdded += f.added;
          iRemoved += f.removed;
        }
      }
    }
    if (inIntersect) {
      intersect.commit_count += 1;
      intersect.lines_added += iAdded;
      intersect.lines_removed += iRemoved;
    }

    detailed.push({
      hash: c.hash,
      time: c.time,
      subject: c.subject,
      in_intersect: inIntersect,
      lines_added: c.added,
      lines_removed: c.removed,
      lines_added_intersect: iAdded,
      lines_removed_intersect: iRemoved,
      files: c.files,
    });
  }

  const { createNormalizedEvent } = require('../collector/event-normalizer');
  const commitEvent = createNormalizedEvent({
    agent: sessionEndEvent.agent,
    session_id: sessionId,
    event_type: 'session_commits',
    cwd,
    git_remote_url: remote,
    git_author_email: email,
    // Top-level columns mirror the WINDOW totals so existing aggregations
    // (sum lines_added etc.) remain meaningful for this event_type.
    lines_added: window.lines_added,
    lines_removed: window.lines_removed,
    files_modified: detailed.reduce(
      (acc, c) => acc + new Set(c.files.map(f => f.path)).size,
      0,
    ),
    extra: {
      edit_files: Array.from(editSet),
      window,
      intersect,
      commits: detailed,
    },
  });

  store.insert(commitEvent);
}

main().catch(() => process.exit(0));
