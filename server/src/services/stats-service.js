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
 */
function applyFilters(query, params) {
  const range = computeDateRange(params);

  if (range) {
    // event_time is ISO string, compare date portion
    query.where('event_time', '>=', range.start)
         .where('event_time', '<', range.end + 'T23:59:59.999Z');
  }

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

module.exports = { getSummary, getRanking, getRankingAll, getDrilldown, getTrend, getRankingTrend, computeDateRange };
