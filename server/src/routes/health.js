async function healthRoutes(fastify, opts) {
  const { config } = opts;

  fastify.get('/api/v1/health', async (request, reply) => {
    return {
      status: 'ok',
      version: '0.1.0',
      database: config.database.client,
      uptime: process.uptime(),
      dashboard: {
        rankingLimit: (config.dashboard && config.dashboard.rankingLimit) || 100,
      },
    };
  });
}

module.exports = healthRoutes;
