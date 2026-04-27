const {
  getSummary,
  getRanking,
  getRankingAll,
  getDrilldown,
  getTrend,
  getRankingTrend,
  computeDateRange,
  getRepoSummary,
  getRepoRanking,
  getRepoTrend,
  getRepoList,
  getRepoDeveloperList,
  getRepoCommits,
} = require('../services/stats-service');
const { getDisplayNameMap } = require('../services/user-profile-service');

async function statsRoutes(fastify, opts) {
  const { db } = opts;

  fastify.get('/api/v1/stats/summary', async (request, reply) => {
    const result = await getSummary(db, request.query);
    return result;
  });

  fastify.get('/api/v1/stats/ranking', async (request, reply) => {
    const result = await getRanking(db, request.query);
    return result;
  });

  fastify.get('/api/v1/stats/ranking-all', async (request, reply) => {
    const result = await getRankingAll(db, request.query);
    return result;
  });

  fastify.get('/api/v1/stats/drilldown', async (request, reply) => {
    const { username } = request.query;
    if (!username) {
      return reply.status(400).send({ error: 'username query param is required' });
    }
    const result = await getDrilldown(db, request.query);
    return result;
  });

  fastify.get('/api/v1/stats/trend', async (request, reply) => {
    const result = await getTrend(db, request.query);
    return result;
  });

  // Dashboard helper: list distinct models
  fastify.get('/api/v1/stats/models', async (request, reply) => {
    const rows = await db('events')
      .distinct('model')
      .whereNotNull('model')
      .orderBy('model');
    return rows;
  });

  // Dashboard helper: event types with counts
  fastify.get('/api/v1/stats/event-types', async (request, reply) => {
    let query = db('events')
      .select('event_type')
      .count('* as count')
      // Exclude lifecycle events (download / update / install) — those have
      // dedicated views in the Update stats section. Mixing them into the
      // event-type pie would drown out real hook activity.
      .whereNotIn('event_type', ['download', 'update'])
      .groupBy('event_type')
      .orderBy('count', 'desc');

    const range = computeDateRange(request.query);
    if (range) {
      query.where('event_time', '>=', range.start)
           .where('event_time', '<', range.end + 'T23:59:59.999Z');
    }
    if (request.query.model) query.where('model', request.query.model);
    if (request.query.user) query.where('username', request.query.user);

    return query;
  });

  // Dashboard helper: tool usage frequency (excludes skill_use events)
  fastify.get('/api/v1/stats/tool-usage', async (request, reply) => {
    let query = db('events')
      .select('tool_name as name')
      .count('* as use_count')
      .whereNotNull('tool_name')
      .where('event_type', '!=', 'skill_use')
      .groupBy('tool_name')
      .orderBy('use_count', 'desc')
      .limit(50);

    const range = computeDateRange(request.query);
    if (range) {
      query.where('event_time', '>=', range.start)
           .where('event_time', '<', range.end + 'T23:59:59.999Z');
    }
    if (request.query.model) query.where('model', request.query.model);
    if (request.query.user) query.where('username', request.query.user);

    return query;
  });

  // Ranking trend (metrics aggregated by time bucket)
  fastify.get('/api/v1/stats/ranking-trend', async (request, reply) => {
    const result = await getRankingTrend(db, request.query);
    return result;
  });

  // Dashboard helper: list distinct agents
  fastify.get('/api/v1/stats/agents', async (request, reply) => {
    const rows = await db('events')
      .distinct('agent')
      .whereNotNull('agent')
      .orderBy('agent');
    return rows;
  });

  // Dashboard helper: skill usage frequency (by skill_name)
  fastify.get('/api/v1/stats/skill-usage', async (request, reply) => {
    let query = db('events')
      .select('skill_name as name')
      .count('* as use_count')
      .countDistinct('username as user_count')
      .countDistinct('session_id as session_count')
      .where('event_type', 'skill_use')
      .whereNotNull('skill_name')
      .groupBy('skill_name')
      .orderBy('use_count', 'desc')
      .limit(50);

    const range = computeDateRange(request.query);
    if (range) {
      query.where('event_time', '>=', range.start)
           .where('event_time', '<', range.end + 'T23:59:59.999Z');
    }
    if (request.query.model) query.where('model', request.query.model);
    if (request.query.user) query.where('username', request.query.user);

    return query;
  });

  // CLI version distribution: active users and event count per version.
  // Excludes synthetic events (download/update) — those record distribution
  // / lifecycle, not actual CLI activity.
  fastify.get('/api/v1/stats/cli-versions', async (request, reply) => {
    let query = db('events')
      .select('agent_version as version')
      .countDistinct('username as active_users')
      .count('* as event_count')
      .whereNotNull('agent_version')
      .whereNotIn('event_type', ['download', 'update'])
      .groupBy('agent_version')
      .orderBy('event_count', 'desc');

    const range = computeDateRange(request.query);
    if (range) {
      query.where('event_time', '>=', range.start)
           .where('event_time', '<', range.end + 'T23:59:59.999Z');
    }

    return query;
  });

  // Installed users: who installed and their latest version + activity
  fastify.get('/api/v1/stats/installed-users', async (request, reply) => {
    const rows = await db('events')
      .select(
        'username',
        db.raw('MAX(agent_version) as latest_version'),
        db.raw('MAX(event_time) as last_active'),
        db.raw('COUNT(*) as event_count'),
        db.raw('MIN(event_time) as first_seen'),
      )
      .whereNotNull('username')
      .where('username', '!=', '')
      .whereNotIn('event_type', ['download'])
      .groupBy('username')
      .orderBy('last_active', 'desc');

    const nameMap = await getDisplayNameMap(db);
    return rows.map(r => ({
      ...r,
      display_name: nameMap[r.username] || null,
    }));
  });

  // User display name mapping — user_profiles (authoritative) over
  // daily_stats.display_name (fallback for users we haven't imported yet).
  fastify.get('/api/v1/stats/user-names', async (request, reply) => {
    return getDisplayNameMap(db);
  });

  // ── Repo-commit tracking endpoints (admin only — protected at app level) ──
  fastify.get('/api/v1/stats/repos/summary', async (request) => {
    return getRepoSummary(db, request.query);
  });

  fastify.get('/api/v1/stats/repos/ranking', async (request) => {
    return getRepoRanking(db, request.query);
  });

  fastify.get('/api/v1/stats/repos/trend', async (request) => {
    return getRepoTrend(db, request.query);
  });

  fastify.get('/api/v1/stats/repos/list', async () => {
    return getRepoList(db);
  });

  fastify.get('/api/v1/stats/repos/developers', async () => {
    return getRepoDeveloperList(db);
  });

  fastify.get('/api/v1/stats/repos/commits', async (request, reply) => {
    if (!request.query.repo && !request.query.user && !request.query.gitEmail) {
      return reply.status(400).send({ error: 'one of repo / user / gitEmail is required' });
    }
    return getRepoCommits(db, request.query);
  });
}

module.exports = statsRoutes;
