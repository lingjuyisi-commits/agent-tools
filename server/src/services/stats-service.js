const { localDate } = require('../utils/date');
const { getDisplayNameMap } = require('./user-profile-service');

/** Ensure a value from DB is a number (MySQL/PG may return string for SUM). */
function num(v) { return Number(v) || 0; }

/**
 * Compute date range from period + date parameters.
 * Returns { start, end } as ISO date strings (YYYY-MM-DD) in local timezone, or null for no filter.
 */
function computeDateRange(params) {
  const { period, date, start, end } = params;

  if (!period || period === 'all') {
    return null;
  }

  if (period === 'custom') {
    if (!start || !end) return null;
    return { start, end };
  }

  const refDate = date ? new Date(date) : new Date();

  if (period === 'day') {
    const d = localDate(refDate);
    return { start: d, end: d };
  }

  if (period === 'week') {
    // Monday to Sunday
    const day = refDate.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(refDate);
    monday.setDate(refDate.getDate() + diffToMonday);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return {
      start: localDate(monday),
      end: localDate(sunday)
    };
  }

  if (period === 'month') {
    const year = refDate.getFullYear();
    const month = refDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    return {
      start: localDate(firstDay),
      end: localDate(lastDay)
    };
  }

  return null;
}

/**
 * Apply common filters (date range, model, user, hostname, agent) to a Knex query.
 *
 * Also excludes synthetic lifecycle events (`download` / `update`) that
 * /api/v1/client/download and /api/v1/updates/report write into the `events`
 * table. They are not real user activity and would inflate session_count,
 * event_count, and user counts in trend / summary / ranking views. Lifecycle
 * stats have their own dedicated endpoint at /api/v1/stats/updates.
 */
function applyFilters(query, params) {
  const range = computeDateRange(params);

  if (range) {
    // event_time is ISO string, compare date portion
    query.where('event_time', '>=', range.start)
         .where('event_time', '<', range.end + 'T23:59:59.999Z');
  }

  query.whereNotIn('event_type', ['download', 'update']);

  if (params.model) query.where('model', params.model);
  if (params.user) query.where('username', params.user);
  if (params.hostname) query.where('hostname', params.hostname);
  if (params.agent) query.where('agent', params.agent);

  return query;
}

/**
 * Apply common filters to a daily_stats query (date uses stat_date, not event_time).
 * Returns false if the filter would exclude all external data (e.g. filtering by
 * a specific hostname or agent that isn't 'external'), so callers can skip the query.
 */
function applyExternalFilters(query, params) {
  // If filtering by specific hostname or agent, external data doesn't match
  if (params.hostname && params.hostname !== 'external') return false;
  if (params.agent && params.agent !== 'external') return false;

  const range = computeDateRange(params);
  if (range) {
    query.where('stat_date', '>=', range.start)
         .where('stat_date', '<=', range.end);
  }
  if (params.model) query.where('model', params.model);
  if (params.user) query.where('username', params.user);
  return true;
}

/**
 * Query external data from daily_stats (source='external', exclude tool_type='cli').
 */
function externalBaseQuery(db) {
  return db('daily_stats')
    .where('source', 'external')
    .where(function () {
      this.whereNull('tool_type').orWhereNot('tool_type', 'cli');
    });
}

/**
 * GET /api/v1/stats/summary
 * Returns aggregated totals for the given filters, merging hook + external data.
 */
async function getSummary(db, params) {
  // 1. Hook data from events table
  let query = db('events')
    .select(
      db.raw('COUNT(*) as event_count'),
      db.raw('COUNT(DISTINCT session_id) as session_count'),
      db.raw("SUM(CASE WHEN event_type = 'user_message' THEN 1 ELSE 0 END) as turn_count"),
      db.raw('COUNT(DISTINCT username) as user_count'),
      db.raw('COUNT(DISTINCT hostname) as host_count'),
      db.raw('COALESCE(SUM(token_input), 0) as token_input_total'),
      db.raw('COALESCE(SUM(token_output), 0) as token_output_total'),
      db.raw('COALESCE(SUM(token_cache_read), 0) as token_cache_read_total'),
      db.raw('COALESCE(SUM(token_cache_write), 0) as token_cache_write_total'),
      db.raw('COALESCE(SUM(token_input + token_output + COALESCE(token_cache_read, 0) + COALESCE(token_cache_write, 0)), 0) as token_total'),
      db.raw('COALESCE(SUM(files_created), 0) as files_created_total'),
      db.raw('COALESCE(SUM(files_modified), 0) as files_modified_total'),
      db.raw('COALESCE(SUM(lines_added), 0) as lines_added_total'),
      db.raw('COALESCE(SUM(lines_removed), 0) as lines_removed_total'),
      db.raw("SUM(CASE WHEN event_type = 'skill_use' THEN 1 ELSE 0 END) as skill_count"),
      db.raw("COUNT(DISTINCT CASE WHEN event_type = 'skill_use' THEN skill_name ELSE NULL END) as skill_unique")
    );
  applyFilters(query, params);
  const hookRow = (await query)[0];

  // 2. External data from daily_stats table (skip if filter excludes external)
  let extRow = { event_count: 0, user_count: 0, token_input_total: 0, token_output_total: 0, token_total: 0 };
  const extQuery = externalBaseQuery(db)
    .select(
      db.raw('COALESCE(SUM(event_count), 0) as event_count'),
      db.raw('COUNT(DISTINCT username) as user_count'),
      db.raw('COALESCE(SUM(token_input_total), 0) as token_input_total'),
      db.raw('COALESCE(SUM(token_output_total), 0) as token_output_total'),
      db.raw('COALESCE(SUM(token_input_total + token_output_total), 0) as token_total')
    );
  if (applyExternalFilters(extQuery, params)) {
    extRow = (await extQuery)[0];
  }

  // 3. Deduplicated user count — query distinct usernames from both sources then merge in JS
  let hookUsersQuery = db('events').distinct('username');
  applyFilters(hookUsersQuery, params);
  const hookUsers = (await hookUsersQuery).map(r => r.username);

  const allUsers = new Set(hookUsers);

  if (extRow.user_count > 0) {
    let extUsersQuery = externalBaseQuery(db).distinct('username');
    if (applyExternalFilters(extUsersQuery, params)) {
      const extUsers = (await extUsersQuery).map(r => r.username);
      extUsers.forEach(u => allUsers.add(u));
    }
  }

  const deduplicatedUserCount = allUsers.size;

  return {
    event_count: num(hookRow.event_count) + num(extRow.event_count),
    session_count: num(hookRow.session_count),
    turn_count: num(hookRow.turn_count),
    user_count: deduplicatedUserCount,
    host_count: num(hookRow.host_count),
    token_input_total: num(hookRow.token_input_total) + num(extRow.token_input_total),
    token_output_total: num(hookRow.token_output_total) + num(extRow.token_output_total),
    token_cache_read_total: num(hookRow.token_cache_read_total),
    token_cache_write_total: num(hookRow.token_cache_write_total),
    token_total: num(hookRow.token_total) + num(extRow.token_total),
    files_created_total: num(hookRow.files_created_total),
    files_modified_total: num(hookRow.files_modified_total),
    lines_added_total: num(hookRow.lines_added_total),
    lines_removed_total: num(hookRow.lines_removed_total),
    skill_count: num(hookRow.skill_count),
    skill_unique: num(hookRow.skill_unique),
  };
}

/**
 * GET /api/v1/stats/ranking
 * Returns ranked users by the given metric, merging hook + external data.
 */
async function getRanking(db, params) {
  const metric = params.metric || 'token_total';
  const limit = parseInt(params.limit, 10) || 2000;

  const metricMap = {
    token_total: db.raw('SUM(token_input + token_output + COALESCE(token_cache_read, 0) + COALESCE(token_cache_write, 0)) as metric_value'),
    token_input: db.raw('SUM(token_input) as metric_value'),
    token_output: db.raw('SUM(token_output) as metric_value'),
    session_count: db.raw('COUNT(DISTINCT session_id) as metric_value'),
    event_count: db.raw('COUNT(*) as metric_value'),
    lines_added: db.raw('SUM(lines_added) as metric_value'),
    lines_removed: db.raw('SUM(lines_removed) as metric_value'),
    files_created: db.raw('SUM(files_created) as metric_value'),
    files_modified: db.raw('SUM(files_modified) as metric_value'),
    skill_count: db.raw("SUM(CASE WHEN event_type = 'skill_use' THEN 1 ELSE 0 END) as metric_value"),
    skill_unique: db.raw("COUNT(DISTINCT CASE WHEN event_type = 'skill_use' THEN skill_name ELSE NULL END) as metric_value"),
  };

  // External data only has token and event_count metrics
  const extMetricMap = {
    token_total: 'SUM(token_input_total + token_output_total)',
    token_input: 'SUM(token_input_total)',
    token_output: 'SUM(token_output_total)',
    event_count: 'SUM(event_count)',
  };

  const metricExpr = metricMap[metric] || metricMap.token_total;

  // 1. Hook data
  let hookQuery = db('events')
    .select('username', metricExpr)
    .groupBy('username');
  applyFilters(hookQuery, params);
  const hookRows = await hookQuery;

  // 2. External data (only for metrics that exist in external)
  const extMetricSql = extMetricMap[metric];
  let extRows = [];
  if (extMetricSql) {
    const extQuery = externalBaseQuery(db)
      .select('username', db.raw(`COALESCE(${extMetricSql}, 0) as metric_value`))
      .groupBy('username');
    if (applyExternalFilters(extQuery, params)) {
      extRows = await extQuery;
    }
  }

  // 3. Merge by username
  const merged = {};
  for (const row of hookRows) merged[row.username] = { ...row };
  for (const ext of extRows) {
    if (merged[ext.username]) {
      merged[ext.username].metric_value += num(ext.metric_value);
    } else {
      merged[ext.username] = { ...ext };
    }
  }

  return Object.values(merged)
    .sort((a, b) => b.metric_value - a.metric_value)
    .slice(0, limit);
}

/**
 * GET /api/v1/stats/ranking-all
 * Returns paginated metrics per user, merging hook + external data.
 * Supports: page, pageSize, sortBy, sortOrder, search (by username/display_name).
 */
const VALID_SORT_FIELDS = new Set([
  'token_total','token_input','token_output','session_count','event_count',
  'turn_count','files_created','files_modified','lines_added','lines_removed',
  'skill_count','skill_unique','username',
]);

async function getRankingAll(db, params) {
  const page = Math.max(1, parseInt(params.page, 10) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(params.pageSize, 10) || 50));
  const sortBy = VALID_SORT_FIELDS.has(params.sortBy) ? params.sortBy : 'token_total';
  const sortOrder = params.sortOrder === 'asc' ? 'asc' : 'desc';
  const search = (params.search || '').trim().toLowerCase();

  // 1. Hook data from events
  let hookQuery = db('events')
    .select(
      'username',
      db.raw('COALESCE(SUM(token_input), 0) as token_input'),
      db.raw('COALESCE(SUM(token_output), 0) as token_output'),
      db.raw('COALESCE(SUM(token_input + token_output + COALESCE(token_cache_read, 0) + COALESCE(token_cache_write, 0)), 0) as token_total'),
      db.raw('COUNT(DISTINCT session_id) as session_count'),
      db.raw('COUNT(*) as event_count'),
      db.raw("SUM(CASE WHEN event_type = 'user_message' THEN 1 ELSE 0 END) as turn_count"),
      db.raw('COALESCE(SUM(files_created), 0) as files_created'),
      db.raw('COALESCE(SUM(files_modified), 0) as files_modified'),
      db.raw('COALESCE(SUM(lines_added), 0) as lines_added'),
      db.raw('COALESCE(SUM(lines_removed), 0) as lines_removed'),
      db.raw("SUM(CASE WHEN event_type = 'skill_use' THEN 1 ELSE 0 END) as skill_count"),
      db.raw("COUNT(DISTINCT CASE WHEN event_type = 'skill_use' THEN skill_name ELSE NULL END) as skill_unique"),
    )
    .groupBy('username');
  applyFilters(hookQuery, params);
  const hookRows = await hookQuery;

  // 2. External data from daily_stats (exclude cli; skip if filter excludes external)
  let extRows = [];
  const extQuery = externalBaseQuery(db)
    .select(
      'username',
      db.raw('COALESCE(SUM(token_input_total), 0) as token_input'),
      db.raw('COALESCE(SUM(token_output_total), 0) as token_output'),
      db.raw('COALESCE(SUM(token_input_total + token_output_total), 0) as token_total'),
      db.raw('COALESCE(SUM(event_count), 0) as event_count'),
    )
    .groupBy('username');
  if (applyExternalFilters(extQuery, params)) {
    extRows = await extQuery;
  }

  // 3. Merge by username (num() ensures no string concat from MySQL/PG)
  const merged = {};
  for (const row of hookRows) {
    merged[row.username] = { ...row };
    // Ensure numeric types for all metric fields
    for (const k of ['token_input','token_output','token_total','session_count','event_count','turn_count','files_created','files_modified','lines_added','lines_removed','skill_count','skill_unique']) {
      merged[row.username][k] = num(row[k]);
    }
  }
  for (const ext of extRows) {
    if (merged[ext.username]) {
      merged[ext.username].token_input += num(ext.token_input);
      merged[ext.username].token_output += num(ext.token_output);
      merged[ext.username].token_total += num(ext.token_total);
      merged[ext.username].event_count += num(ext.event_count);
    } else {
      merged[ext.username] = {
        username: ext.username,
        token_input: num(ext.token_input),
        token_output: num(ext.token_output),
        token_total: num(ext.token_total),
        session_count: 0,
        event_count: num(ext.event_count),
        turn_count: 0,
        files_created: 0, files_modified: 0,
        lines_added: 0, lines_removed: 0,
        skill_count: 0, skill_unique: 0,
      };
    }
  }

  // 4. Attach display names (user_profiles overlays daily_stats; see user-profile-service)
  const nameMap = await getDisplayNameMap(db);

  let all = Object.values(merged).map(u => ({
    ...u,
    display_name: nameMap[u.username] || null,
  }));

  // 5. Search filter (case-insensitive, match username or display_name)
  if (search) {
    all = all.filter(u =>
      u.username.toLowerCase().includes(search) ||
      (u.display_name && u.display_name.toLowerCase().includes(search))
    );
  }

  // 6. Sort (descending by default)
  const dir = sortOrder === 'asc' ? 1 : -1;
  all.sort((a, b) => {
    const va = a[sortBy], vb = b[sortBy];
    if (typeof va === 'string') return va.localeCompare(vb) * dir;
    return ((va || 0) - (vb || 0)) * dir;
  });

  // 7. Paginate
  const total = all.length;
  const start = (page - 1) * pageSize;
  const data = all.slice(start, start + pageSize);

  return { data, total, page, pageSize };
}

/**
 * GET /api/v1/stats/drilldown
 * Returns breakdown for a specific user by hostname, agent, or model.
 * Merges external data when drilling down by model.
 */
async function getDrilldown(db, params) {
  const { username, drilldown } = params;
  const groupCol = drilldown || 'hostname';

  const validGroups = ['hostname', 'agent', 'model', 'skill_name'];
  const groupBy = validGroups.includes(groupCol) ? groupCol : 'hostname';

  const orderCol = groupBy === 'skill_name' ? 'event_count' : 'token_total';

  // Hook data
  let query = db('events')
    .select(
      groupBy,
      db.raw('COUNT(*) as event_count'),
      db.raw('COUNT(DISTINCT session_id) as session_count'),
      db.raw('COALESCE(SUM(token_input), 0) as token_input_total'),
      db.raw('COALESCE(SUM(token_output), 0) as token_output_total'),
      db.raw('COALESCE(SUM(token_input + token_output + COALESCE(token_cache_read, 0) + COALESCE(token_cache_write, 0)), 0) as token_total')
    )
    .where('username', username)
    .groupBy(groupBy)
    .orderBy(orderCol, 'desc');

  if (groupBy === 'skill_name') query.where('event_type', 'skill_use');
  applyFilters(query, { ...params, user: undefined });
  const hookRows = await query;

  // External data — only merge when drilling by model (hostname/agent are always 'external')
  if (groupBy === 'model') {
    const extQuery = externalBaseQuery(db)
      .select(
        'model',
        db.raw('COALESCE(SUM(event_count), 0) as event_count'),
        db.raw('0 as session_count'),
        db.raw('COALESCE(SUM(token_input_total), 0) as token_input_total'),
        db.raw('COALESCE(SUM(token_output_total), 0) as token_output_total'),
        db.raw('COALESCE(SUM(token_input_total + token_output_total), 0) as token_total')
      )
      .where('username', username)
      .groupBy('model');
    if (applyExternalFilters(extQuery, { ...params, user: undefined })) {
      const extRows = await extQuery;

      // Merge by model name
      const merged = {};
      for (const row of hookRows) merged[row.model] = { ...row };
      for (const ext of extRows) {
        if (merged[ext.model]) {
          merged[ext.model].event_count += num(ext.event_count);
          merged[ext.model].token_input_total += num(ext.token_input_total);
          merged[ext.model].token_output_total += num(ext.token_output_total);
          merged[ext.model].token_total += num(ext.token_total);
        } else {
          merged[ext.model] = { ...ext };
        }
      }
      return Object.values(merged).sort((a, b) => b.token_total - a.token_total);
    }
  }

  return hookRows;
}

/**
 * GET /api/v1/stats/trend
 * Returns daily aggregated stats for the given filters.
 */
async function getTrend(db, params) {
  let query = db('events')
    .select(
      db.raw("SUBSTR(event_time, 1, 10) as date"),
      db.raw('COUNT(*) as event_count'),
      db.raw('COUNT(DISTINCT session_id) as session_count'),
      db.raw('COALESCE(SUM(token_input), 0) as token_input_total'),
      db.raw('COALESCE(SUM(token_output), 0) as token_output_total'),
      db.raw('COALESCE(SUM(token_cache_read), 0) as token_cache_read_total'),
      db.raw('COALESCE(SUM(token_cache_write), 0) as token_cache_write_total'),
      db.raw('COALESCE(SUM(token_input + token_output + COALESCE(token_cache_read, 0) + COALESCE(token_cache_write, 0)), 0) as token_total')
    )
    .groupBy(db.raw("SUBSTR(event_time, 1, 10)"))
    .orderBy('date', 'asc');

  applyFilters(query, params);

  return query;
}

/**
 * GET /api/v1/stats/ranking-trend
 * Returns all ranking metrics aggregated by time bucket (day or hour).
 */
async function getRankingTrend(db, params) {
  const granularity = params.granularity || 'day';
  const bucketExpr = granularity === 'hour'
    ? "SUBSTR(event_time, 1, 13)"
    : "SUBSTR(event_time, 1, 10)";

  let query = db('events')
    .select(
      db.raw(`${bucketExpr} as bucket`),
      db.raw('COALESCE(SUM(token_input), 0) as token_input'),
      db.raw('COALESCE(SUM(token_output), 0) as token_output'),
      db.raw('COALESCE(SUM(token_input + token_output + COALESCE(token_cache_read, 0) + COALESCE(token_cache_write, 0)), 0) as token_total'),
      db.raw('COUNT(DISTINCT session_id) as session_count'),
      db.raw('COUNT(*) as event_count'),
      db.raw('COALESCE(SUM(files_created), 0) as files_created'),
      db.raw('COALESCE(SUM(files_modified), 0) as files_modified'),
      db.raw('COALESCE(SUM(lines_added), 0) as lines_added'),
      db.raw('COALESCE(SUM(lines_removed), 0) as lines_removed'),
      db.raw("SUM(CASE WHEN event_type = 'skill_use' THEN 1 ELSE 0 END) as skill_count"),
      db.raw("COUNT(DISTINCT CASE WHEN event_type = 'skill_use' THEN skill_name ELSE NULL END) as skill_unique"),
    )
    .groupBy(db.raw(bucketExpr))
    .orderBy('bucket', 'asc');

  applyFilters(query, params);
  return query;
}

// ── Repo-commit tracking stats ────────────────────────────────────────────
//
// Two data sources collaborate:
//   1. `events` table — per-tool-call edit lines on `tool_use` events. Edit
//      events themselves carry no repo URL; we derive it via a CTE that
//      joins to `session_start` events on session_id (where the adapter
//      wrote git_remote_url at session boundary).
//   2. `commit_facts` table — one row per (commit_hash, repo). Source of
//      truth for "提交+/−". Already deduped across overlapping sessions.
//
// `applyRepoFilters` is intentionally separate from `applyFilters` —
// they operate on different tables (commit_facts has no event_type) and
// commit-window filters use commit_time, not event_time.

function applyDateRange(query, params, column) {
  const range = computeDateRange(params);
  if (range) {
    query.where(column, '>=', range.start)
         .where(column, '<', range.end + 'T23:59:59.999Z');
  }
}

/** Apply user/repo filters to a commit_facts query. */
function applyCommitFactFilters(query, params) {
  applyDateRange(query, params, 'commit_time');
  if (params.repo)         query.where('git_remote_url', params.repo);
  if (params.gitEmail)     query.where('git_author_email', params.gitEmail);
  if (params.user)         query.where('username', params.user);
  return query;
}

/**
 * Build the per-session repo map as a CTE-style subquery factory. Edit-line
 * stats need it because `tool_use` events themselves don't carry repo info.
 * Calling code does:
 *     .leftJoin(sessionRepoSub(db).as('sr'), 'events.session_id', 'sr.session_id')
 * to bring `git_remote_url` and `git_author_email` along for grouping.
 *
 * If a session has multiple session_start rows (replay, restart in another
 * directory), pick the EARLIEST by event_time. Using MAX() would be
 * non-deterministic across repo URLs and silently misattribute edits to the
 * "alphabetically larger" repo. Using the earliest matches user intent: the
 * repo they were in when they started — later edits stay attributed to it
 * even if they cd'd elsewhere mid-session, which is the conservative default.
 *
 * Why subquery (not knex `.with()`)? — better-sqlite3 supports both, but the
 * subquery form composes more cleanly with applyFilters(...) chains.
 */
function sessionRepoSub(db) {
  // Use a correlated MIN(event_time) per session, then a self-join to pluck
  // the row whose event_time matches. Equivalent to ROW_NUMBER() OVER but
  // works on every dialect knex supports without window functions.
  //
  // Tiebreaker: event_time has 1-second resolution. Two session_start rows
  // for the same session can share event_time (replay, restart in same
  // second). Without a tiebreaker the inner join would return BOTH rows
  // and downstream LEFT JOIN would double-count edit lines. We wrap the
  // inner join in an outer aggregation with MIN(git_remote_url) — collapses
  // to one row per session deterministically, even on collision.
  const earliest = db('events')
    .select('session_id')
    .min('event_time as min_time')
    .where('event_type', 'session_start')
    .whereNotNull('git_remote_url')
    .groupBy('session_id')
    .as('e1');

  const tied = db('events as e2')
    .select('e2.session_id', 'e2.git_remote_url', 'e2.git_author_email')
    .innerJoin(earliest, function () {
      this.on('e2.session_id', '=', 'e1.session_id')
        .andOn('e2.event_time', '=', 'e1.min_time');
    })
    .where('e2.event_type', 'session_start')
    .whereNotNull('e2.git_remote_url')
    .as('tied');

  return db(tied)
    .select('session_id')
    .min('git_remote_url as git_remote_url')
    .min('git_author_email as git_author_email')
    .groupBy('session_id');
}

/**
 * Edit-side aggregates for a date / user / repo filter, attributed to repos
 * via the session_start join. Returns:
 *   { lines_added, lines_removed, lines_net, files_touched, ops_count, sessions }
 *
 * `commit_facts` is a separate concern — combine with `getCommitAggregates`.
 */
async function getEditAggregates(db, params) {
  const sub = sessionRepoSub(db).as('sr');
  let q = db('events')
    .leftJoin(sub, 'events.session_id', 'sr.session_id')
    .select(
      db.raw('COALESCE(SUM(events.lines_added), 0) as lines_added'),
      db.raw('COALESCE(SUM(events.lines_removed), 0) as lines_removed'),
      db.raw('COALESCE(SUM(COALESCE(events.files_created, 0) + COALESCE(events.files_modified, 0)), 0) as files_touched'),
      db.raw("SUM(CASE WHEN events.event_type = 'tool_use' THEN 1 ELSE 0 END) as ops_count"),
      db.raw('COUNT(DISTINCT events.session_id) as sessions')
    )
    .where('events.event_type', 'tool_use');

  applyDateRange(q, params, 'events.event_time');
  if (params.user)     q.where('events.username', params.user);
  if (params.repo)     q.where('sr.git_remote_url', params.repo);
  if (params.gitEmail) q.where('sr.git_author_email', params.gitEmail);
  // When repo filter is active and we only want repo-attributable edits,
  // require the join to have matched. Without a repo filter, we still want
  // global edit totals — but for repo stats specifically the caller usually
  // passes `requireRepo=true` to drop sessions that aren't tracked.
  if (params.requireRepo) q.whereNotNull('sr.git_remote_url');

  const r = (await q)[0] || {};
  return {
    lines_added: num(r.lines_added),
    lines_removed: num(r.lines_removed),
    lines_net: num(r.lines_added) - num(r.lines_removed),
    files_touched: num(r.files_touched),
    ops_count: num(r.ops_count),
    sessions: num(r.sessions),
  };
}

/**
 * Boolean truthiness expression for `in_intersect` that works on every
 * dialect we support, without requiring an explicit comparison literal:
 *   - SQLite stores `t.boolean()` as INTEGER (0/1). `CASE WHEN <int>` treats
 *     non-zero as true.
 *   - Postgres stores `t.boolean()` as native bool. `CASE WHEN <bool>` is
 *     direct evaluation.
 *   - MySQL stores `t.boolean()` as TINYINT(1). Same as SQLite.
 *
 * We use this inside `SUM(CASE WHEN ${TRUE_EXPR} THEN ... ELSE 0 END)`. Note
 * `CASE WHEN <column>` (no comparison) is sargable on Postgres bool indexes,
 * which `<column> = 1 OR <column> = true` is NOT.
 */
const TRUE_EXPR = 'in_intersect';

/** Commit-side aggregates from commit_facts. Note: first-writer-wins on
 *  shared commits — see commit_facts dedupe in event-service. */
async function getCommitAggregates(db, params) {
  let q = db('commit_facts').select(
    db.raw('COUNT(*) as commit_count_window'),
    db.raw('COALESCE(SUM(lines_added), 0) as lines_added_window'),
    db.raw('COALESCE(SUM(lines_removed), 0) as lines_removed_window'),
    db.raw('COALESCE(SUM(files_count), 0) as files_count_window'),
    db.raw(`SUM(CASE WHEN ${TRUE_EXPR} THEN 1 ELSE 0 END) as commit_count_intersect`),
    db.raw('COALESCE(SUM(lines_added_intersect), 0) as lines_added_intersect'),
    db.raw('COALESCE(SUM(lines_removed_intersect), 0) as lines_removed_intersect'),
    // intersect files_count is conservative: only commits flagged in_intersect contribute
    db.raw(`COALESCE(SUM(CASE WHEN ${TRUE_EXPR} THEN files_count ELSE 0 END), 0) as files_count_intersect`)
  );
  applyCommitFactFilters(q, params);

  const r = (await q)[0] || {};
  return {
    window: {
      commit_count: num(r.commit_count_window),
      lines_added: num(r.lines_added_window),
      lines_removed: num(r.lines_removed_window),
      files_count: num(r.files_count_window),
    },
    intersect: {
      commit_count: num(r.commit_count_intersect),
      lines_added: num(r.lines_added_intersect),
      lines_removed: num(r.lines_removed_intersect),
      files_count: num(r.files_count_intersect),
    },
  };
}

/**
 * GET /api/v1/stats/repos/summary  — full metric package for the dashboard
 * KPI row. The frontend picks "window" or "intersect" via the global toggle.
 */
async function getRepoSummary(db, params) {
  const [edit, commit, repoCount, devCount] = await Promise.all([
    getEditAggregates(db, { ...params, requireRepo: true }),
    getCommitAggregates(db, params),
    db('commit_facts').countDistinct('git_remote_url as c').modify(q => applyCommitFactFilters(q, params)).first(),
    db('commit_facts').countDistinct('git_author_email as c').modify(q => applyCommitFactFilters(q, params)).first(),
  ]);

  return {
    edit,
    commit_window: commit.window,
    commit_intersect: commit.intersect,
    repo_count: num(repoCount?.c),
    developer_count: num(devCount?.c),
    session_count: edit.sessions,
  };
}

/**
 * Ranking by user / repo / user_repo for any single metric.
 *
 * The shape of the result is `{rows: [...], metric: '<key>'}` so the
 * frontend can render the ranked metric column without re-deriving the key.
 *
 * Implementation strategy:
 *   - Edit-only metrics queried from `events` LEFT JOIN session_repo
 *   - Commit-only metrics queried from `commit_facts`
 *   - Combined metrics (retention) need both — we do two queries and merge
 *     by the group key in JS. (Simpler than a 4-way SQL join, and the group
 *     cardinality is small.)
 */
async function getRepoRanking(db, params) {
  const groupBy = ['user', 'repo', 'user_repo'].includes(params.groupBy)
    ? params.groupBy : 'user';
  const metric = params.metric || 'commit_added_intersect';
  const limit = Math.min(2000, parseInt(params.limit, 10) || 200);

  // Always fetch both sides so every column in the row is populated, no
  // matter which metric the user is sorting by. The frontend table renders
  // edit+, commit+, retention etc. for every row regardless of sort key —
  // so a half-populated row would render zeros and look broken.

  // Edit query (group by chosen dimension)
  const sub = sessionRepoSub(db).as('sr');
  let editQ = db('events').leftJoin(sub, 'events.session_id', 'sr.session_id');
  addGroupByCols(editQ, groupBy, 'events.username', 'sr.git_remote_url');
  editQ.select(
    db.raw('COALESCE(SUM(events.lines_added), 0) as edit_added'),
    db.raw('COALESCE(SUM(events.lines_removed), 0) as edit_removed')
  ).where('events.event_type', 'tool_use')
   .whereNotNull('sr.git_remote_url');
  applyDateRange(editQ, params, 'events.event_time');
  if (params.user)     editQ.where('events.username', params.user);
  if (params.repo)     editQ.where('sr.git_remote_url', params.repo);
  if (params.gitEmail) editQ.where('sr.git_author_email', params.gitEmail);
  addGroupByGroup(editQ, groupBy, 'events.username', 'sr.git_remote_url');
  const editRows = await editQ;

  // Commit query
  let commitQ = db('commit_facts');
  addGroupByCols(commitQ, groupBy, 'username', 'git_remote_url');
  commitQ.select(
    db.raw('COUNT(*) as commit_count_window'),
    db.raw('COALESCE(SUM(lines_added), 0) as commit_added_window'),
    db.raw('COALESCE(SUM(lines_removed), 0) as commit_removed_window'),
    db.raw(`SUM(CASE WHEN ${TRUE_EXPR} THEN 1 ELSE 0 END) as commit_count_intersect`),
    db.raw('COALESCE(SUM(lines_added_intersect), 0) as commit_added_intersect'),
    db.raw('COALESCE(SUM(lines_removed_intersect), 0) as commit_removed_intersect')
  );
  applyCommitFactFilters(commitQ, params);
  addGroupByGroup(commitQ, groupBy, 'username', 'git_remote_url');
  const commitRows = await commitQ;

  // Merge by group key
  const byKey = {};
  const groupKey = (r) => groupBy === 'user' ? r.username
                       : groupBy === 'repo' ? r.git_remote_url
                       : `${r.username}|${r.git_remote_url}`;

  for (const r of editRows) {
    const k = groupKey(r);
    byKey[k] = byKey[k] || baseRankingRow(r, groupBy);
    byKey[k].edit_added = num(r.edit_added);
    byKey[k].edit_removed = num(r.edit_removed);
    byKey[k].edit_net = num(r.edit_added) - num(r.edit_removed);
  }
  for (const r of commitRows) {
    const k = groupKey(r);
    byKey[k] = byKey[k] || baseRankingRow(r, groupBy);
    byKey[k].commit_count_window = num(r.commit_count_window);
    byKey[k].commit_added_window = num(r.commit_added_window);
    byKey[k].commit_removed_window = num(r.commit_removed_window);
    byKey[k].commit_count_intersect = num(r.commit_count_intersect);
    byKey[k].commit_added_intersect = num(r.commit_added_intersect);
    byKey[k].commit_removed_intersect = num(r.commit_removed_intersect);
  }

  // Compute derived metrics + sort
  const all = Object.values(byKey).map(row => {
    const editAdded = row.edit_added || 0;
    const editRemoved = row.edit_removed || 0;
    row.retention_window = editAdded > 0 ? (row.commit_added_window || 0) / editAdded : 0;
    row.retention_intersect = editAdded > 0 ? (row.commit_added_intersect || 0) / editAdded : 0;
    row.churn_ratio = editAdded > 0 ? editRemoved / editAdded : 0;
    return row;
  });

  all.sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
  return { rows: all.slice(0, limit), metric, groupBy };
}

function baseRankingRow(r, groupBy) {
  const row = {};
  if (groupBy === 'user' || groupBy === 'user_repo') row.username = r.username || null;
  if (groupBy === 'repo' || groupBy === 'user_repo') row.git_remote_url = r.git_remote_url || null;
  // Pre-fill all metric columns so the row shape is uniform
  Object.assign(row, {
    edit_added: 0, edit_removed: 0, edit_net: 0,
    commit_count_window: 0, commit_added_window: 0, commit_removed_window: 0,
    commit_count_intersect: 0, commit_added_intersect: 0, commit_removed_intersect: 0,
    retention_window: 0, retention_intersect: 0, churn_ratio: 0,
  });
  return row;
}

function addGroupByCols(q, groupBy, userCol, repoCol) {
  if (groupBy === 'user' || groupBy === 'user_repo') q.select(`${userCol} as username`);
  if (groupBy === 'repo' || groupBy === 'user_repo') q.select(`${repoCol} as git_remote_url`);
}
function addGroupByGroup(q, groupBy, userCol, repoCol) {
  if (groupBy === 'user' || groupBy === 'user_repo') q.groupBy(userCol);
  if (groupBy === 'repo' || groupBy === 'user_repo') q.groupBy(repoCol);
}

/**
 * Daily time series for one or more metrics. The frontend picks which
 * series to render via checkboxes and we send all of them in one shot to
 * avoid multiple round trips when toggling.
 */
async function getRepoTrend(db, params) {
  // Edit time series
  const sub = sessionRepoSub(db).as('sr');
  let editQ = db('events')
    .leftJoin(sub, 'events.session_id', 'sr.session_id')
    .select(
      db.raw("SUBSTR(events.event_time, 1, 10) as date"),
      db.raw('COALESCE(SUM(events.lines_added), 0) as edit_added'),
      db.raw('COALESCE(SUM(events.lines_removed), 0) as edit_removed')
    )
    .where('events.event_type', 'tool_use')
    .whereNotNull('sr.git_remote_url')
    .groupBy(db.raw("SUBSTR(events.event_time, 1, 10)"))
    .orderBy('date', 'asc');
  applyDateRange(editQ, params, 'events.event_time');
  if (params.user)     editQ.where('events.username', params.user);
  if (params.repo)     editQ.where('sr.git_remote_url', params.repo);
  if (params.gitEmail) editQ.where('sr.git_author_email', params.gitEmail);
  const editRows = await editQ;

  // Commit time series
  let commitQ = db('commit_facts')
    .select(
      db.raw("SUBSTR(commit_time, 1, 10) as date"),
      db.raw('COUNT(*) as commit_count_window'),
      db.raw('COALESCE(SUM(lines_added), 0) as commit_added_window'),
      db.raw(`SUM(CASE WHEN ${TRUE_EXPR} THEN 1 ELSE 0 END) as commit_count_intersect`),
      db.raw('COALESCE(SUM(lines_added_intersect), 0) as commit_added_intersect')
    )
    .groupBy(db.raw("SUBSTR(commit_time, 1, 10)"))
    .orderBy('date', 'asc');
  applyCommitFactFilters(commitQ, params);
  const commitRows = await commitQ;

  // Merge by date so the frontend gets one row per day with all metrics
  const byDate = {};
  for (const r of editRows) {
    byDate[r.date] = byDate[r.date] || { date: r.date };
    byDate[r.date].edit_added = num(r.edit_added);
    byDate[r.date].edit_removed = num(r.edit_removed);
  }
  for (const r of commitRows) {
    byDate[r.date] = byDate[r.date] || { date: r.date };
    byDate[r.date].commit_count_window = num(r.commit_count_window);
    byDate[r.date].commit_added_window = num(r.commit_added_window);
    byDate[r.date].commit_count_intersect = num(r.commit_count_intersect);
    byDate[r.date].commit_added_intersect = num(r.commit_added_intersect);
  }
  return Object.values(byDate)
    .map(d => ({
      ...d,
      retention_window:    (d.edit_added || 0) > 0 ? (d.commit_added_window || 0) / d.edit_added : 0,
      retention_intersect: (d.edit_added || 0) > 0 ? (d.commit_added_intersect || 0) / d.edit_added : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** List of distinct repos in commit_facts — for the repo dropdown filter. */
async function getRepoList(db) {
  const rows = await db('commit_facts')
    .distinct('git_remote_url')
    .orderBy('git_remote_url', 'asc');
  return rows.map(r => r.git_remote_url).filter(Boolean);
}

/** List of distinct git_author_email — for the developer dropdown. */
async function getRepoDeveloperList(db) {
  const rows = await db('commit_facts')
    .select('git_author_email', 'username')
    .max('first_seen as last_seen')
    .whereNotNull('git_author_email')
    .groupBy('git_author_email', 'username')
    .orderBy('last_seen', 'desc');
  return rows;
}

/** Latest commits for a given repo (for the deepest drilldown panel). */
async function getRepoCommits(db, params) {
  const limit = Math.min(500, parseInt(params.limit, 10) || 100);
  let q = db('commit_facts')
    .select('commit_hash', 'subject', 'commit_time', 'username',
            'git_author_email', 'git_remote_url',
            'lines_added', 'lines_removed', 'in_intersect')
    .orderBy('commit_time', 'desc')
    .limit(limit);
  applyCommitFactFilters(q, params);
  return q;
}

module.exports = {
  getSummary, getRanking, getRankingAll, getDrilldown, getTrend, getRankingTrend, computeDateRange,
  // Repo-commit tracking
  getRepoSummary, getRepoRanking, getRepoTrend, getRepoList, getRepoDeveloperList, getRepoCommits,
};
