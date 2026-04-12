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

  // Load provider plugin (registers /auth/login and /auth/callback)
  const providerPlugin = require(`./providers/${provider}`);
  fastify.register(providerPlugin, { auth, serverPort });

  // Session query endpoint
  fastify.get('/auth/session', async (request) => {
    if (!request.session?.user) {
      return { authenticated: false, user: null };
    }

    // Real-time whitelist + role check
    const login = request.session.user.login;
    const allowed = await db('allowed_users').where('login', login).first();

    return {
      authenticated: true,
      user: {
        ...request.session.user,
        approved: !!allowed,
        role: allowed?.role || null,
      },
    };
  });

  // Logout endpoint
  fastify.post('/auth/logout', async (request) => {
    request.session.destroy();
    return { message: 'Logged out' };
  });
};
