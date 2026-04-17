const pkg = require('../../package.json');

async function healthRoutes(fastify, opts) {
  const { config } = opts;

  fastify.get('/api/v1/health', async (request, reply) => {
    return {
      status: 'ok',
      version: pkg.version,
      database: config.database.client,
      uptime: process.uptime(),
      dashboard: {
        rankingPageSize: (config.dashboard && config.dashboard.rankingPageSize) || 50,
      },
    };
  });
}

module.exports = healthRoutes;
