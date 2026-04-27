/**
 * Per-user stats endpoints. Every request is auto-scoped to the caller's
 * SSO login — we assume `session.user.login === daily_stats.username`
 * (confirmed by ops). A user with no uploaded data simply gets empty numbers.
 */

const {
  getSummary, getTrend, getDrilldown,
  getRepoSummary, getRepoRanking, getRepoTrend, getRepoCommits,
} = require('../services/stats-service');

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

  // ── Repo-commit tracking — auto-scoped to the caller ────────────────────
  // Note: `groupBy` is forced to 'repo' for /my/repos/ranking — disallowing
  // 'user' / 'user_repo' prevents an authenticated user from seeing other
  // people's data via the ranking endpoint. The service layer would also
  // honor `user`, but defense-in-depth.

  fastify.get('/api/v1/my/repos/summary', async (request, reply) => {
    const username = requireSelf(request, reply);
    if (!username) return;
    return getRepoSummary(db, { ...request.query, user: username });
  });

  fastify.get('/api/v1/my/repos/ranking', async (request, reply) => {
    const username = requireSelf(request, reply);
    if (!username) return;
    return getRepoRanking(db, { ...request.query, user: username, groupBy: 'repo' });
  });

  fastify.get('/api/v1/my/repos/trend', async (request, reply) => {
    const username = requireSelf(request, reply);
    if (!username) return;
    return getRepoTrend(db, { ...request.query, user: username });
  });

  fastify.get('/api/v1/my/repos/commits', async (request, reply) => {
    const username = requireSelf(request, reply);
    if (!username) return;
    return getRepoCommits(db, { ...request.query, user: username });
  });
}

module.exports = myRoutes;
