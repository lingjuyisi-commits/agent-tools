const { localNow } = require('../utils/date');
const { normalizeRepoUrl, isAllowedDomain } = require('./repo-url');

/**
 * Resolve the admin-configured allowlist of repo domains.
 *
 * Looked up per-batch (not cached) so an admin editing
 * `~/.agent-tools-server/config.json` takes effect on the next request,
 * matching the existing pattern for `guard.*` and `client.downloadUrl`.
 *
 * `repoTracking.enabled = false` (or missing) treats *every* repo URL as
 * disallowed, which silently nulls all repo attribution and skips
 * session_commits ingestion entirely. Safe default for fresh installs.
 */
function loadRepoTrackingConfig() {
  try {
    const cfg = require('../config').load();
    const rt = cfg?.repoTracking || {};
    return {
      enabled: rt.enabled !== false && Array.isArray(rt.allowedDomains) && rt.allowedDomains.length > 0,
      allowedDomains: Array.isArray(rt.allowedDomains) ? rt.allowedDomains : [],
    };
  } catch {
    return { enabled: false, allowedDomains: [] };
  }
}

async function insertEventBatch(db, events) {
  const receivedTime = localNow();
  const repoCfg = loadRepoTrackingConfig();
  let accepted = 0;
  let duplicates = 0;
  let dropped = 0;     // counted separately so operators can debug allowlist config
  let errors = 0;
  // Buffer commit_facts inserts so we can run them after the events txn —
  // commit dedupe is independent of event dedupe and the two failure modes
  // shouldn't tangle.
  const commitFactsToInsert = [];

  await db.transaction(async trx => {
    for (const event of events) {
      try {
        if (!event.event_id || !event.agent || !event.username ||
            !event.hostname || !event.platform || !event.session_id ||
            !event.event_type || !event.event_time) {
          errors++;
          continue;
        }

        // ── Repo allowlist filter ─────────────────────────────────────
        // Three outcomes:
        //   1. event has no repo URL    → keep event, no repo attribution
        //   2. URL not in allowlist     → null out repo fields (event still
        //      stored for general stats), and drop session_commits entirely
        //   3. URL in allowlist         → normalize, store, queue commit_facts
        let normalizedRepo = null;
        if (event.git_remote_url) {
          normalizedRepo = normalizeRepoUrl(event.git_remote_url);
          if (!repoCfg.enabled || !isAllowedDomain(normalizedRepo, repoCfg.allowedDomains)) {
            normalizedRepo = null;
          }
        }
        if (event.event_type === 'session_commits' && !normalizedRepo) {
          // Synthetic event has no value without repo attribution — silently
          // drop. Counted in `dropped` (NOT `duplicates`) so operators can
          // distinguish "real duplicate" from "allowlist excluded this".
          dropped++;
          continue;
        }

        const row = {
          event_id: event.event_id,
          agent: event.agent,
          agent_version: event.agent_version || null,
          username: event.username,
          hostname: event.hostname,
          platform: event.platform,
          session_id: event.session_id,
          conversation_turn: event.conversation_turn || null,
          event_type: event.event_type,
          event_time: event.event_time,
          received_time: receivedTime,
          model: event.model || null,
          token_input: event.token_input || 0,
          token_output: event.token_output || 0,
          token_cache_read: event.token_cache_read || 0,
          token_cache_write: event.token_cache_write || 0,
          tool_name: event.tool_name || null,
          skill_name: event.skill_name || null,
          files_created: event.files_created || 0,
          files_modified: event.files_modified || 0,
          lines_added: event.lines_added || 0,
          lines_removed: event.lines_removed || 0,
          cwd: event.cwd || null,
          git_remote_url: normalizedRepo,
          git_author_email: normalizedRepo ? (event.git_author_email || null) : null,
          extra: event.extra ? JSON.stringify(event.extra) : null
        };

        // Try insert, catch unique constraint violation for dedup
        await trx('events').insert(row);
        accepted++;

        // Queue commit_facts rows (one per commit) for after the events txn.
        if (event.event_type === 'session_commits' && normalizedRepo) {
          const extra = event.extra && typeof event.extra === 'object' ? event.extra : null;
          const commits = Array.isArray(extra?.commits) ? extra.commits : [];
          for (const c of commits) {
            if (!c || !c.hash) continue;
            commitFactsToInsert.push({
              commit_hash: c.hash,
              git_remote_url: normalizedRepo,
              git_author_email: event.git_author_email || null,
              username: event.username,
              hostname: event.hostname,
              agent: event.agent,
              commit_time: c.time || null,
              subject: c.subject || null,
              lines_added: c.lines_added || 0,
              lines_removed: c.lines_removed || 0,
              lines_added_intersect: c.lines_added_intersect || 0,
              lines_removed_intersect: c.lines_removed_intersect || 0,
              files_count: Array.isArray(c.files) ? c.files.length : 0,
              in_intersect: !!c.in_intersect,
              session_id: event.session_id,
              first_seen: receivedTime,
            });
          }
        }
      } catch (err) {
        // SQLite: SQLITE_CONSTRAINT, PG/MySQL: unique_violation / ER_DUP_ENTRY
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('unique') || msg.includes('duplicate') || msg.includes('constraint')) {
          duplicates++;
        } else {
          errors++;
        }
      }
    }
  });

  // commit_facts inserts run outside the events transaction. Each row is
  // independent — a duplicate (commit already seen via another session) is
  // EXPECTED and silently ignored. Errors here never affect the events
  // ingest result the client sees.
  // commit_facts dedupe + caveats:
  //
  // knex `.onConflict(...).ignore()` compiles to INSERT OR IGNORE / ON
  // CONFLICT DO NOTHING / INSERT IGNORE depending on dialect.
  //
  //   1. First-writer-wins. Two sessions in the same repo can both report
  //      the same commit_hash; we keep the first session's row, including
  //      that session's `lines_added_intersect` and `in_intersect`. A
  //      different session might have a larger edit_files set and would
  //      have flagged the commit as in_intersect, but we don't second-guess.
  //      Stats stability > marginal accuracy.
  //
  //   2. Post-transaction loss. These inserts run AFTER the events txn
  //      commits. If the process crashes between the two, we keep the
  //      session_commits event but lose its commit_facts. Retry sees the
  //      event as a duplicate and skips the commit_facts push, so the
  //      commit is permanently absent — until the SAME commit shows up via
  //      another session, which will write it. Acceptable for the same
  //      reason as (1): commits matter, attribution to a specific session
  //      doesn't.
  for (const fact of commitFactsToInsert) {
    try {
      await db('commit_facts')
        .insert(fact)
        .onConflict(['commit_hash', 'git_remote_url'])
        .ignore();
    } catch {
      // Swallow — commit_facts failure must never break events ingest
    }
  }

  return { accepted, duplicates, dropped, errors };
}

module.exports = { insertEventBatch };
