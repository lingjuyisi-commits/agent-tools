const fastify = require('fastify');
const path = require('path');
const crypto = require('crypto');

function buildApp(db, config) {
  const app = fastify({ logger: true });
  const authEnabled = !!(config.auth?.provider && config.auth?.clientId);

  app.register(require('@fastify/cors'));

  // Cookie + Session at app level (when auth enabled) so all sub-plugins
  // (auth routes, stats guard, admin routes) can access request.session.
  if (authEnabled) {
    const auth = config.auth;
    app.register(require('@fastify/cookie'));
    app.register(require('@fastify/session'), {
      secret: auth.sessionSecret || crypto.randomBytes(32).toString('hex'),
      cookie: {
        secure: 'auto',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
    });
  }

  // Auth plugin (optional — registers OAuth provider + session/logout routes)
  if (authEnabled) {
    app.register(require('./auth'), { config, db });
  }

  // Serve dashboard static files
  app.register(require('@fastify/static'), {
    root: path.join(__dirname, 'dashboard'),
    prefix: '/dashboard/',
  });

  // Redirect / to /dashboard/
  app.get('/', async (request, reply) => {
    reply.redirect('/dashboard/index.html');
  });

  // Public routes
  app.register(require('./routes/health'), { config });
  app.register(require('./routes/events'), { db });
  app.register(require('./routes/client'), { config });
  app.register(require('./routes/external'), { db });

  // Stats routes — admin-only when auth is enabled
  app.register(async function protectedStats(instance) {
    if (authEnabled) {
      const { createAdminGuard } = require('./auth/guard');
      instance.addHook('preHandler', createAdminGuard(db));
    }
    instance.register(require('./routes/stats'), { db });
  });

  // Per-user stats — any authenticated SSO session, only when auth is enabled.
  // When auth is off, there is no session.user.login to scope by, so /my/* is
  // skipped entirely (same pattern as admin routes).
  if (authEnabled) {
    app.register(async function myStats(instance) {
      const { createAuthGuard } = require('./auth/guard');
      instance.addHook('preHandler', createAuthGuard(db));
      instance.register(require('./routes/my'), { db });
    });
  }

  // Admin routes (only when auth is enabled)
  if (authEnabled) {
    app.register(require('./routes/admin'), { db });
  }

  return app;
}

module.exports = { buildApp };
