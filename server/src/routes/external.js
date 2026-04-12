/**
 * External data sync routes.
 * Receives daily aggregated stats from external systems (e.g. AI gateways)
 * and upserts them into the daily_stats table with source='external'.
 */
async function externalRoutes(fastify, opts) {
  const { db } = opts;

  fastify.post('/api/v1/external/daily-stats', async (request, reply) => {
    const { records } = request.body || {};

    if (!Array.isArray(records) || records.length === 0) {
      return reply.status(400).send({ error: 'records array is required' });
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const r of records) {
      if (!r.username || !r.sync_time) {
        skipped++;
        continue;
      }

      const statDate = r.sync_time.slice(0, 10); // YYYY-MM-DD
      const row = {
        stat_date: statDate,
        username: r.username,
        hostname: 'external',
        agent: 'external',
        model: r.model || 'unknown',
        source: 'external',
        display_name: r.name || '',
        tool_type: r.tool_type || '',
        event_count: parseInt(r.request_count, 10) || 0,
        session_count: 0,
        token_input_total: parseInt(r.token_in, 10) || 0,
        token_output_total: parseInt(r.token_out, 10) || 0,
        token_cache_read_total: 0,
        token_cache_write_total: 0,
        files_created_total: 0,
        files_modified_total: 0,
        lines_added_total: 0,
        lines_removed_total: 0,
      };

      // Upsert: unique constraint is [stat_date, username, hostname, agent, model]
      const existing = await db('daily_stats').where({
        stat_date: row.stat_date,
        username: row.username,
        hostname: row.hostname,
        agent: row.agent,
        model: row.model,
      }).first();

      if (existing) {
        await db('daily_stats').where({ id: existing.id }).update({
          token_input_total: row.token_input_total,
          token_output_total: row.token_output_total,
          event_count: row.event_count,
          display_name: row.display_name,
          tool_type: row.tool_type,
        });
        updated++;
      } else {
        await db('daily_stats').insert(row);
        inserted++;
      }
    }

    return { inserted, updated, skipped, total: records.length };
  });
}

module.exports = externalRoutes;
