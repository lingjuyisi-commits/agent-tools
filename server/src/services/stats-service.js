/**
 * Compute date range from period + date parameters.
 * Returns { start, end } as ISO date strings (YYYY-MM-DD), or null for no filter.
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
    const d = refDate.toISOString().slice(0, 10);
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
      start: monday.toISOString().slice(0, 10),
      end: sunday.toISOString().slice(0, 10)
    };
  }

  if (period === 'month') {
    const year = refDate.getFullYear();
    const month = refDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    return {
      start: firstDay.toISOString().slice(0, 10),
      end: lastDay.toISOString().slice(0, 10)
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
 */
function applyExternalFilters(query, params) {
  const range = computeDateRange(params);
  if (range) {
    query.where('stat_date', '>=', range.start)
         .where('stat_date', '<=', range.end);
  }
  if (params.model) query.where('model', params.model);
  if (params.user) query.where('username', params.user);
  // External data always has hostname='external' and agent='external',
  // so hostname/agent filters only apply to non-external queries
  return query;
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
      db.raw('COUNT(DISTINCT username) as user_count'),
      db.raw('COUNT(DISTINCT hostname) as host_count'),
      db.raw('COALESCE(SUM(token_input), 0) as token_input_total'),
      db.raw('COALESCE(SUM(token_output), 0) as token_output_total'),
      db.raw('COALESCE(SUM(token_cache_read), 0) as token_cache_read_total'),
      db.raw('COALESCE(SUM(token_cache_write), 0) as token_cache_write_total'),
      db.raw('COALESCE(SUM(token_input + token_output), 0) as token_total'),
      db.raw('COALESCE(SUM(files_created), 0) as files_created_total'),
      db.raw('COALESCE(SUM(files_modified), 0) as files_modified_total'),
      db.raw('COALESCE(SUM(lines_added), 0) as lines_added_total'),
      db.raw('COALESCE(SUM(lines_removed), 0) as lines_removed_total')
    );
  applyFilters(query, params);
  const hookRow = (await query)[0];

  // 2. External data from daily_stats table
  let extQuery = externalBaseQuery(db)
    .select(
      db.raw('COALESCE(SUM(event_count), 0) as event_count'),
      db.raw('COUNT(DISTINCT username) as user_count'),
      db.raw('COALESCE(SUM(token_input_total), 0) as token_input_total'),
      db.raw('COALESCE(SUM(token_output_total), 0) as token_output_total'),
      db.raw('COALESCE(SUM(token_input_total + token_output_total), 0) as token_total')
    );
  applyExternalFilters(extQuery, params);
  const extRow = (await extQuery)[0];

  // 3. Deduplicated user count (same user in both hook + external counts as 1)
  const userCountResult = await db.raw(`
    SELECT COUNT(*) as total FROM (
      SELECT DISTINCT username FROM events WHERE 1=1
      UNION
      SELECT DISTINCT username FROM daily_stats WHERE source = 'external' AND (tool_type IS NULL OR tool_type != 'cli')
    ) t
  `);
  const deduplicatedUserCount = userCountResult[0]?.total ?? userCountResult?.total ?? (hookRow.user_count + extRow.user_count);

  return {
    event_count: hookRow.event_count + extRow.event_count,
    session_count: hookRow.session_count,
    user_count: deduplicatedUserCount,
    host_count: hookRow.host_count,
    token_input_total: hookRow.token_input_total + extRow.token_input_total,
    token_output_total: hookRow.token_output_total + extRow.token_output_total,
    token_cache_read_total: hookRow.token_cache_read_total,
    token_cache_write_total: hookRow.token_cache_write_total,
    token_total: hookRow.token_total + extRow.token_total,
    files_created_total: hookRow.files_created_total,
    files_modified_total: hookRow.files_modified_total,
    lines_added_total: hookRow.lines_added_total,
    lines_removed_total: hookRow.lines_removed_total,
  };
}

/**
 * GET /api/v1/stats/ranking
 * Returns ranked users by the given metric.
 */
async function getRanking(db, params) {
  const metric = params.metric || 'token_total';
  const limit = parseInt(params.limit, 10) || 20;

  const metricMap = {
    token_total: db.raw('SUM(token_input + token_output) as metric_value'),
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

  const metricExpr = metricMap[metric] || metricMap.token_total;

  let query = db('events')
    .select('username', metricExpr)
    .groupBy('username')
    .orderBy('metric_value', 'desc')
    .limit(limit);

  applyFilters(query, params);

  return query;
}

/**
 * GET /api/v1/stats/ranking-all
 * Returns all metrics per user, merging hook + external data. Sorting is done client-side.
 */
async function getRankingAll(db, params) {
  const limit = parseInt(params.limit, 10) || 50;

  // 1. Hook data from events
  let hookQuery = db('events')
    .select(
      'username',
      db.raw('COALESCE(SUM(token_input), 0) as token_input'),
      db.raw('COALESCE(SUM(token_output), 0) as token_output'),
      db.raw('COALESCE(SUM(token_input + token_output), 0) as token_total'),
      db.raw('COUNT(DISTINCT session_id) as session_count'),
      db.raw('COUNT(*) as event_count'),
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

  // 2. External data from daily_stats (exclude cli)
  let extQuery = externalBaseQuery(db)
    .select(
      'username',
      db.raw('COALESCE(SUM(token_input_total), 0) as token_input'),
      db.raw('COALESCE(SUM(token_output_total), 0) as token_output'),
      db.raw('COALESCE(SUM(token_input_total + token_output_total), 0) as token_total'),
      db.raw('COALESCE(SUM(event_count), 0) as event_count'),
    )
    .groupBy('username');
  applyExternalFilters(extQuery, params);
  const extRows = await extQuery;

  // 3. Merge by username
  const merged = {};
  for (const row of hookRows) {
    merged[row.username] = { ...row };
  }
  for (const ext of extRows) {
    if (merged[ext.username]) {
      merged[ext.username].token_input += ext.token_input;
      merged[ext.username].token_output += ext.token_output;
      merged[ext.username].token_total += ext.token_total;
      merged[ext.username].event_count += ext.event_count;
    } else {
      merged[ext.username] = {
        username: ext.username,
        token_input: ext.token_input,
        token_output: ext.token_output,
        token_total: ext.token_total,
        session_count: 0,
        event_count: ext.event_count,
        files_created: 0, files_modified: 0,
        lines_added: 0, lines_removed: 0,
        skill_count: 0, skill_unique: 0,
      };
    }
  }

  // 4. Sort and limit
  return Object.values(merged)
    .sort((a, b) => b.token_total - a.token_total)
    .slice(0, limit);
}

/**
 * GET /api/v1/stats/drilldown
 * Returns breakdown for a specific user by hostname, agent, or model.
 */
async function getDrilldown(db, params) {
  const { username, drilldown } = params;
  const groupCol = drilldown || 'hostname';

  const validGroups = ['hostname', 'agent', 'model'];
  const groupBy = validGroups.includes(groupCol) ? groupCol : 'hostname';

  let query = db('events')
    .select(
      groupBy,
      db.raw('COUNT(*) as event_count'),
      db.raw('COUNT(DISTINCT session_id) as session_count'),
      db.raw('COALESCE(SUM(token_input), 0) as token_input_total'),
      db.raw('COALESCE(SUM(token_output), 0) as token_output_total'),
      db.raw('COALESCE(SUM(token_input + token_output), 0) as token_total')
    )
    .where('username', username)
    .groupBy(groupBy)
    .orderBy('token_total', 'desc');

  applyFilters(query, { ...params, user: undefined });

  return query;
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
      db.raw('COALESCE(SUM(token_input + token_output), 0) as token_total')
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
      db.raw('COALESCE(SUM(token_input + token_output), 0) as token_total'),
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
