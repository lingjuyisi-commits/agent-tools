const {
  getSummary,
  getRanking,
  getDrilldown,
  getTrend,
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

  // Dashboard helper: tool usage frequency
  fastify.get('/api/v1/stats/tool-usage', async (request, reply) => {
    let query = db('events')
      .select('tool_name as name')
      .count('* as use_count')
      .whereNotNull('tool_name')
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
}

module.exports = statsRoutes;
