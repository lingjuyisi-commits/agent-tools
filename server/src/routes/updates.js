const crypto = require('crypto');

// Compare semver strings numerically (e.g. "0.10.0" > "0.9.0").
function semverCmp(a, b) {
  const pa = (a || '').split('.').map(Number);
  const pb = (b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

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
    let attempted = 0;
    for (const entry of logs) {
      if (!entry.time || !entry.status) continue;
      attempted++;
      // Include status in hash so a retry (failed→success) on same version+time is stored separately.
      const eventId = crypto
        .createHash('sha1')
        .update(`${username}|${hostname || ''}|${entry.version || ''}|${entry.time}|${entry.status}`)
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
            // Install-specific fields. Present only for install-success /
            // install-failed entries produced by postinstall.
            stages: entry.stages || null,
            node: entry.node || null,
            arch: entry.arch || null,
          }),
        }).onConflict('event_id').ignore();
      } catch {}
    }

    return { attempted };
  });

  // GET /api/v1/stats/updates
  fastify.get('/api/v1/stats/updates', async (request) => {
    const { period, start, end } = request.query;

    const applyTimeFilter = (q) => {
      if (period === 'day') {
        return q.where('event_time', '>=', new Date().toISOString().slice(0, 10));
      } else if (period === 'week') {
        return q.where('event_time', '>=', new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
      } else if (period === 'month') {
        return q.where('event_time', '>=', new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
      } else if (period === 'custom' && start && end) {
        return q.where('event_time', '>=', start).where('event_time', '<=', end + 'T23:59:59Z');
      }
      return q;
    };

    // Download tallies come straight from the grouped aggregate — no need to
    // parse each row's extra blob.
    const downloadRows = await applyTimeFilter(
      db('events').where('event_type', 'download')
    )
      .select('agent_version')
      .count('* as cnt')
      .groupBy('agent_version');
    const downloadsByVersion = downloadRows
      .map(r => ({ version: r.agent_version || 'unknown', count: Number(r.cnt) }))
      .sort((a, b) => semverCmp(a.version, b.version));
    const download_count = downloadsByVersion.reduce((s, d) => s + d.count, 0);

    let query = applyTimeFilter(db('events').where('event_type', 'update'));

    const rows = await query.select('username', 'event_time', 'extra').limit(50000);
    const parsed = rows.map(r => {
      let d = {};
      try { d = JSON.parse(r.extra || '{}'); } catch {}
      return { username: r.username, event_time: r.event_time, ...d };
    });

    // Update events (status: success/failed) come from check-update-worker.
    // Install events (status: install-success/install-failed) come from postinstall.
    const isUpdate  = (r) => r.status === 'success' || r.status === 'failed';
    const isInstall = (r) => r.status === 'install-success' || r.status === 'install-failed';

    const success_count = parsed.filter(r => r.status === 'success').length;
    const failed_count  = parsed.filter(r => r.status === 'failed').length;
    const install_success_count = parsed.filter(r => r.status === 'install-success').length;
    const install_failed_count  = parsed.filter(r => r.status === 'install-failed').length;
    const user_count = new Set(parsed.map(r => r.username)).size;

    // by version (updates only) — sorted by semver desc
    const vMap = {};
    for (const r of parsed.filter(isUpdate)) {
      const v = r.to_version || 'unknown';
      if (!vMap[v]) vMap[v] = { to_version: v, success: 0, failed: 0 };
      if (r.status === 'success') vMap[v].success++;
      else vMap[v].failed++;
    }
    const byVersion = Object.values(vMap).sort((a, b) => semverCmp(a.to_version, b.to_version));

    // by install version — first-time installs, separate from updates
    const iMap = {};
    for (const r of parsed.filter(isInstall)) {
      const v = r.to_version || 'unknown';
      if (!iMap[v]) iMap[v] = { version: v, success: 0, failed: 0 };
      if (r.status === 'install-success') iMap[v].success++;
      else iMap[v].failed++;
    }
    const byInstallVersion = Object.values(iMap).sort((a, b) => semverCmp(a.version, b.version));

    // failure reasons (merges update + install failures — both are relevant
    // for "why is agent-tools broken for this user")
    const errMap = {};
    for (const r of parsed.filter(r => r.status === 'failed' || r.status === 'install-failed')) {
      const e = (r.error || 'unknown').slice(0, 200);
      errMap[e] = (errMap[e] || 0) + 1;
    }
    const failures = Object.entries(errMap)
      .map(([error, cnt]) => ({ error, cnt }))
      .sort((a, b) => b.cnt - a.cnt)
      .slice(0, 20);

    return {
      summary: {
        success_count,
        failed_count,
        install_success_count,
        install_failed_count,
        download_count,
        user_count,
      },
      byVersion,
      byInstallVersion,
      downloadsByVersion,
      failures,
    };
  });
}

module.exports = updatesRoutes;
