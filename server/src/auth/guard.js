/**
 * Auth guards.
 *
 * createAuthGuard  — any authenticated SSO session. Populates request.isAdmin
 *                    from allowed_users.role for downstream use.
 * createAdminGuard — rejects unless allowed_users.role === 'admin'.
 *
 * Admin membership is checked in real-time from the database (not cached in
 * session) so that admin changes take effect immediately.
 */

async function lookupIsAdmin(db, login) {
  if (!login) return false;
  const row = await db('allowed_users').where('login', login).first();
  return !!(row && row.role === 'admin');
}

function createAuthGuard(db) {
  return async function authGuard(request, reply) {
    if (!request.session?.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    request.isAdmin = await lookupIsAdmin(db, request.session.user.login);
  };
}

function createAdminGuard(db) {
  return async function adminGuard(request, reply) {
    if (!request.session?.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const isAdmin = await lookupIsAdmin(db, request.session.user.login);
    if (!isAdmin) {
      return reply.status(403).send({ error: 'Admin access required' });
    }
    request.isAdmin = true;
  };
}

module.exports = { createAuthGuard, createAdminGuard, lookupIsAdmin };
