/**
 * Authentication + authorization guard factory.
 *
 * Returns a preHandler hook that checks:
 * 1. User is logged in (session.user exists) → 401 if not
 * 2. User is in the allowed_users whitelist → 403 if not
 *
 * Whitelist is checked in real-time from the database (not cached in session)
 * so that admin changes take effect immediately without requiring re-login.
 */
function createAuthGuard(db) {
  return async function authGuard(request, reply) {
    if (!request.session?.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const login = request.session.user.login;
    const allowed = await db('allowed_users').where('login', login).first();

    if (!allowed) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: '账号未获授权，请联系管理员',
      });
    }

    // Attach current role to request for downstream use
    request.userRole = allowed.role;
  };
}

module.exports = { createAuthGuard };
