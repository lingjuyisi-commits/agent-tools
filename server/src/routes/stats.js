const {
  getSummary,
  getRanking,
  getRankingAll,
  getDrilldown,
  getTrend,
  getRankingTrend,
  computeDateRange
} = require('../services/stats-service');

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

  // CLI version distribution: active users and event count per version
  fastify.get('/api/v1/stats/cli-versions', async (request, reply) => {
    let query = db('events')
      .select('agent_version as version')
      .countDistinct('username as active_users')
      .count('* as event_count')
      .whereNotNull('agent_version')
      .groupBy('agent_version')
      .orderBy('event_count', 'desc');

    const range = computeDateRange(request.query);
    if (range) {
      query.where('event_time', '>=', range.start)
           .where('event_time', '<', range.end + 'T23:59:59.999Z');
    }

    return query;
  });

  // User display name mapping (from external data)
  fastify.get('/api/v1/stats/user-names', async (request, reply) => {
    const rows = await db('daily_stats')
      .select('username', 'display_name')
      .whereNotNull('display_name')
      .andWhere('display_name', '!=', '')
      .groupBy('username');
    const map = {};
    for (const r of rows) map[r.username] = r.display_name;
    return map;
  });
}

module.exports = statsRoutes;
