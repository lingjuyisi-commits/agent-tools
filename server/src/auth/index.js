/**
 * Auth plugin — registers OAuth provider and auth routes.
 *
 * Cookie and session are registered at app level (in app.js) so that
 * all sub-plugins (auth, stats guard, admin) can access request.session.
 *
 * Only loaded when config.auth.provider is set. When not loaded, all endpoints
 * remain public (backward compatible with unauthenticated intranet deployments).
 */

const VALID_PROVIDERS = ['oauth2', 'github'];

module.exports = async function authPlugin(fastify, opts) {
  const { config, db } = opts;
  const auth = config.auth || {};
  const provider = auth.provider;
  const serverPort = config.server?.port || 3000;

  // Validate provider name (prevent path traversal)
  if (!VALID_PROVIDERS.includes(provider)) {
    throw new Error(`Unknown auth provider: "${provider}". Valid: ${VALID_PROVIDERS.join(', ')}`);
  }

  fastify.log.info({ provider, callbackUrl: auth.callbackUrl || `http://localhost:${serverPort}/auth/callback` }, 'Auth enabled, loading provider');

  // Load provider plugin (registers /auth/login and /auth/callback)
  const providerPlugin = require(`./providers/${provider}`);
  fastify.register(providerPlugin, { auth, serverPort });

  // Session query endpoint. approved/role kept for backward-compat; the
  // canonical gate is now `isAdmin` — any authenticated SSO session can
  // see its own /api/v1/my/* data without being in allowed_users.
  fastify.get('/auth/session', async (request) => {
    if (!request.session?.user) {
      request.log.debug('Session check: not authenticated');
      return { authenticated: false, user: null };
    }

    const login = request.session.user.login;
    const allowed = await db('allowed_users').where('login', login).first();
    const isAdmin = !!(allowed && allowed.role === 'admin');
    request.log.debug({ login, isAdmin }, 'Session check: user found');

    return {
      authenticated: true,
      user: {
        ...request.session.user,
        isAdmin,
        approved: true,
        role: allowed?.role || 'user',
      },
    };
  });

  // Logout endpoint
  fastify.post('/auth/logout', async (request) => {
    const login = request.session?.user?.login || 'unknown';
    request.session.destroy();
    request.log.info({ login }, 'User logged out');
    return { message: 'Logged out' };
  });
};
