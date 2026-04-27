/**
 * Repo-commit tracking schema.
 *
 * Adds three nullable columns to `events` for per-event git context, plus a
 * dedicated `commit_facts` table for cross-session-deduplicated commit rows.
 *
 * Why a separate table for commits?
 *   - Two concurrent sessions in the same repo will both run `git log` at
 *     SessionEnd and both report the same commit. Storing every commit on
 *     every session_commits event would double-count by 2x or more.
 *   - The natural dedupe key is (commit_hash, git_remote_url). A unique
 *     constraint + INSERT OR IGNORE in ingest gives us "first writer wins"
 *     for free.
 *   - Stats queries can then sum directly from commit_facts without
 *     wrestling with json_extract on events.extra.
 *
 * ⚠ DEPLOYMENT NOTE — large `events` tables on MySQL:
 *   - SQLite + Postgres ≥11: ALTER ADD COLUMN is metadata-only, instant.
 *   - MySQL 8.0+: instant for nullable columns without DEFAULT.
 *   - MySQL <8.0: rewrites the entire table. Multi-million-row events
 *     tables can lock for minutes. Run during a maintenance window or use
 *     pt-online-schema-change.
 *   The two index creations on `git_remote_url` and `git_author_email` are
 *   blocking on MySQL pre-8.0 too. The columns are NULL on legacy rows so
 *   the indexes themselves are tiny — only the row scan during index build
 *   is the cost.
 */
exports.up = async function (knex) {
  // 1. Extend events table with git context (nullable — old clients still ingest)
  if (await knex.schema.hasTable('events')) {
    const hasCwd = await knex.schema.hasColumn('events', 'cwd');
    const hasRemote = await knex.schema.hasColumn('events', 'git_remote_url');
    const hasEmail = await knex.schema.hasColumn('events', 'git_author_email');
    if (!hasCwd || !hasRemote || !hasEmail) {
      await knex.schema.alterTable('events', t => {
        if (!hasCwd) t.text('cwd');
        if (!hasRemote) t.string('git_remote_url', 512);
        if (!hasEmail) t.string('git_author_email', 256);
      });
      // Indexes added separately so the alterTable above stays simple and
      // works on databases that don't allow `INDEX` inside alterTable.
      await knex.schema.alterTable('events', t => {
        t.index('git_remote_url');
        t.index('git_author_email');
        t.index(['git_remote_url', 'event_time']);
      });
    }
  }

  // 2. Per-commit fact table (one row per (hash, repo))
  if (!(await knex.schema.hasTable('commit_facts'))) {
    await knex.schema.createTable('commit_facts', t => {
      t.increments('id');
      t.string('commit_hash', 64).notNullable();
      t.string('git_remote_url', 512).notNullable();
      t.string('git_author_email', 256);
      t.string('username', 128);            // Cached from the session that first reported this commit
      t.string('hostname', 256);            // Same — useful for forensic queries
      t.string('agent', 32);                // claude-code / codebuddy / ...
      t.string('commit_time', 32);          // ISO8601 from `git log %aI`
      t.text('subject');
      t.integer('lines_added').defaultTo(0);
      t.integer('lines_removed').defaultTo(0);
      t.integer('lines_added_intersect').defaultTo(0);
      t.integer('lines_removed_intersect').defaultTo(0);
      t.integer('files_count').defaultTo(0);
      t.boolean('in_intersect').defaultTo(false);  // Did Claude touch any file in this commit?
      t.string('session_id', 128);          // First session that reported it (for traceability)
      t.string('first_seen', 32).notNullable();    // When the server first ingested this commit
      // Composite uniqueness — same commit ingested by a 2nd session is silently ignored
      t.unique(['commit_hash', 'git_remote_url']);
      t.index(['git_remote_url', 'commit_time']);
      t.index(['git_author_email', 'commit_time']);
      t.index('username');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('commit_facts');
  if (await knex.schema.hasTable('events')) {
    await knex.schema.alterTable('events', t => {
      t.dropColumn('cwd');
      t.dropColumn('git_remote_url');
      t.dropColumn('git_author_email');
    });
  }
};
