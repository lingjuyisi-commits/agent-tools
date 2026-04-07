const cron = require('node-cron');

/**
 * Run daily aggregation: summarize events into daily_stats and tool_usage_detail.
 * Runs for yesterday's data by default.
 */
async function aggregateDay(db, dateStr) {
  if (!dateStr) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    dateStr = yesterday.toISOString().slice(0, 10);
  }

  const startTime = dateStr + 'T00:00:00.000Z';
  const endTime = dateStr + 'T23:59:59.999Z';

  // Aggregate daily stats grouped by username, hostname, agent, model
  const statsRows = await db('events')
    .select(
      db.raw('? as stat_date', [dateStr]),
      'username',
      'hostname',
      'agent',
      db.raw("COALESCE(model, 'unknown') as model"),
      db.raw('COUNT(*) as event_count'),
      db.raw('COUNT(DISTINCT session_id) as session_count'),
      db.raw('COALESCE(SUM(token_input), 0) as token_input_total'),
      db.raw('COALESCE(SUM(token_output), 0) as token_output_total'),
      db.raw('COALESCE(SUM(token_cache_read), 0) as token_cache_read_total'),
      db.raw('COALESCE(SUM(token_cache_write), 0) as token_cache_write_total'),
      db.raw('COALESCE(SUM(files_created), 0) as files_created_total'),
      db.raw('COALESCE(SUM(files_modified), 0) as files_modified_total'),
      db.raw('COALESCE(SUM(lines_added), 0) as lines_added_total'),
      db.raw('COALESCE(SUM(lines_removed), 0) as lines_removed_total')
    )
    .where('event_time', '>=', startTime)
    .where('event_time', '<=', endTime)
    .groupBy('username', 'hostname', 'agent', 'model');

  // Upsert into daily_stats
  for (const row of statsRows) {
    const existing = await db('daily_stats')
      .where({
        stat_date: dateStr,
        username: row.username,
        hostname: row.hostname,
        agent: row.agent,
        model: row.model
      })
      .first();

    if (existing) {
      await db('daily_stats')
        .where({ id: existing.id })
        .update({
          event_count: row.event_count,
          session_count: row.session_count,
          token_input_total: row.token_input_total,
          token_output_total: row.token_output_total,
          token_cache_read_total: row.token_cache_read_total,
          token_cache_write_total: row.token_cache_write_total,
          files_created_total: row.files_created_total,
          files_modified_total: row.files_modified_total,
          lines_added_total: row.lines_added_total,
          lines_removed_total: row.lines_removed_total
        });
    } else {
      await db('daily_stats').insert(row);
    }
  }

  // Aggregate tool usage
  const toolRows = await db('events')
    .select(
      db.raw('? as stat_date', [dateStr]),
      'username',
      'hostname',
      'agent',
      'tool_name',
      db.raw('COUNT(*) as usage_count')
    )
    .where('event_time', '>=', startTime)
    .where('event_time', '<=', endTime)
    .whereNotNull('tool_name')
    .where('tool_name', '!=', '')
    .groupBy('username', 'hostname', 'agent', 'tool_name');

  for (const row of toolRows) {
    const existing = await db('tool_usage_detail')
      .where({
        stat_date: dateStr,
        username: row.username,
        hostname: row.hostname,
        agent: row.agent,
        tool_name: row.tool_name
      })
      .first();

    if (existing) {
      await db('tool_usage_detail')
        .where({ id: existing.id })
        .update({ usage_count: row.usage_count });
    } else {
      await db('tool_usage_detail').insert(row);
    }
  }

  return { dailyStats: statsRows.length, toolUsage: toolRows.length };
}

/**
 * Start the daily aggregation cron job.
 * Runs every day at 00:05 UTC.
 */
function startDailyAggregation(db) {
  cron.schedule('5 0 * * *', async () => {
    try {
      console.log('Running daily aggregation...');
      const result = await aggregateDay(db);
      console.log('Daily aggregation complete:', result);
    } catch (err) {
      console.error('Daily aggregation failed:', err);
    }
  }, {
    timezone: 'UTC'
  });

  console.log('Daily aggregation job scheduled (00:05 UTC).');
}

module.exports = { startDailyAggregation, aggregateDay };
