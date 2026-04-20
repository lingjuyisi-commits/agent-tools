/**
 * Per-user stats endpoints. Every request is auto-scoped to the caller's
 * SSO login — we assume `session.user.login === daily_stats.username`
 * (confirmed by ops). A user with no uploaded data simply gets empty numbers.
 */

const { getSummary, getTrend, getDrilldown } = require('../services/stats-service');

// applyFilters in stats-service skips the username WHERE clause when
// `user` is falsy. An empty-string login (malformed session, edge race)
// would therefore return fleet-wide data. Refuse such requests outright
// so /my/* can never silently leak other users' stats.
function callerUsername(request) {
  const login = request.session?.user?.login;
  return typeof login === 'string' && login.length > 0 ? login : null;
}

async function myRoutes(fastify, opts) {
  const { db } = opts;

  function requireSelf(request, reply) {
    const username = callerUsername(request);
    if (!username) {
      reply.status(401).send({ error: 'Invalid session' });
      return null;
    }
    return username;
  }

  fastify.get('/api/v1/my/summary', async (request, reply) => {
    const username = requireSelf(request, reply);
    if (!username) return;
    return getSummary(db, { ...request.query, user: username });
  });

  fastify.get('/api/v1/my/trend', async (request, reply) => {
    const username = requireSelf(request, reply);
    if (!username) return;
    return getTrend(db, { ...request.query, user: username });
  });

  fastify.get('/api/v1/my/drilldown', async (request, reply) => {
    const username = requireSelf(request, reply);
    if (!username) return;
    return getDrilldown(db, { ...request.query, username });
  });
}

module.exports = myRoutes;
