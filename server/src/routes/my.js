/**
 * Per-user stats endpoints. Every request is auto-scoped to the caller's
 * SSO login — we assume `session.user.login === daily_stats.username`
 * (confirmed by ops). A user with no uploaded data simply gets empty numbers.
 */

const { getSummary, getTrend, getDrilldown } = require('../services/stats-service');

async function myRoutes(fastify, opts) {
  const { db } = opts;

  const callerUsername = (request) => request.session?.user?.login || '';

  fastify.get('/api/v1/my/summary', async (request) => {
    const username = callerUsername(request);
    return getSummary(db, { ...request.query, user: username });
  });

  fastify.get('/api/v1/my/trend', async (request) => {
    const username = callerUsername(request);
    return getTrend(db, { ...request.query, user: username });
  });

  fastify.get('/api/v1/my/drilldown', async (request) => {
    const username = callerUsername(request);
    return getDrilldown(db, { ...request.query, username });
  });
}

module.exports = myRoutes;
