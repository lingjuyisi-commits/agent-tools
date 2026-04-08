const fastify = require('fastify');
const path = require('path');

function buildApp(db, config) {
  const app = fastify({ logger: true });

  app.register(require('@fastify/cors'));

  // Serve dashboard static files
  app.register(require('@fastify/static'), {
    root: path.join(__dirname, 'dashboard'),
    prefix: '/dashboard/',
  });

  // Redirect / to /dashboard/
  app.get('/', async (request, reply) => {
    reply.redirect('/dashboard/index.html');
  });

  app.register(require('./routes/health'), { config });
  app.register(require('./routes/events'), { db });
  app.register(require('./routes/stats'), { db });
  app.register(require('./routes/client'));

  return app;
}

module.exports = { buildApp };
