const crypto = require('crypto');

async function updatesRoutes(fastify, opts) {
  const { db } = opts;

  // POST /api/v1/updates/report
  // Client uploads its local update-log entries in bulk — stored as events.
  fastify.post('/api/v1/updates/report', async (request, reply) => {
    const { username, hostname, platform, logs } = request.body || {};
    if (!username || !Array.isArray(logs) || logs.length === 0) {
      return reply.status(400).send({ error: 'username and logs[] required' });
    }

    const now = new Date().toISOString();
    let inserted = 0;
    for (const entry of logs) {
      if (!entry.time || !entry.status) continue;
      const eventId = crypto
        .createHash('sha1')
        .update(`${username}|${hostname || ''}|${entry.version || ''}|${entry.time}`)
        .digest('hex');
      try {
        await db('events').insert({
          event_id: eventId,
          agent: 'agent-tools-cli',
          agent_version: entry.from || null,
          username,
          hostname: hostname || '',
          platform: platform || '',
          session_id: `update_${entry.time}`,
          conversation_turn: 0,
          event_type: 'update',
          event_time: entry.time,
          received_time: now,
          extra: JSON.stringify({
            status: entry.status,
            to_version: entry.version || null,
            from_version: entry.from || null,
            error: entry.error || null,
            npm_bin: entry.npm || null,
          }),
        }).onConflict('event_id').ignore();
        inserted++;
      } catch {}
    }

    return { reported: inserted };
  });

  // GET /api/v1/stats/updates
  fastify.get('/api/v1/stats/updates', async (request) => {
    const { period, start, end } = request.query;

    let query = db('events').where('event_type', 'update');
    if (period === 'day') {
      query.where('event_time', '>=', new Date().toISOString().slice(0, 10));
    } else if (period === 'week') {
      query.where('event_time', '>=', new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
    } else if (period === 'month') {
      query.where('event_time', '>=', new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
    } else if (period === 'custom' && start && end) {
      query.where('event_time', '>=', start).where('event_time', '<=', end + 'T23:59:59Z');
    }

    const rows = await query.select('username', 'event_time', 'extra');
    const parsed = rows.map(r => {
      let d = {};
      try { d = JSON.parse(r.extra || '{}'); } catch {}
      return { username: r.username, event_time: r.event_time, ...d };
    });

    const success_count = parsed.filter(r => r.status === 'success').length;
    const failed_count = parsed.filter(r => r.status === 'failed').length;
    const user_count = new Set(parsed.map(r => r.username)).size;

    // by version
    const vMap = {};
    for (const r of parsed) {
      const v = r.to_version || 'unknown';
      if (!vMap[v]) vMap[v] = { to_version: v, success: 0, failed: 0 };
      if (r.status === 'success') vMap[v].success++;
      else vMap[v].failed++;
    }
    const byVersion = Object.values(vMap).sort((a, b) => b.to_version.localeCompare(a.to_version));

    // failure reasons
    const errMap = {};
    for (const r of parsed.filter(r => r.status === 'failed')) {
      const e = (r.error || 'unknown').slice(0, 200);
      errMap[e] = (errMap[e] || 0) + 1;
    }
    const failures = Object.entries(errMap)
      .map(([error, cnt]) => ({ error, cnt }))
      .sort((a, b) => b.cnt - a.cnt)
      .slice(0, 20);

    return {
      summary: { success_count, failed_count, user_count },
      byVersion,
      failures,
    };
  });
}

module.exports = updatesRoutes;
