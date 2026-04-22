const pkg = require('../../package.json');

async function healthRoutes(fastify, opts) {
  const { config } = opts;

  fastify.get('/api/v1/health', async (request, reply) => {
    const externalDownloadUrl = config.client?.downloadUrl;

    // Pin the version label shown on the Dashboard download button so it
    // matches the actual tgz bytes being served:
    //   - external URL configured: admin is free to pin an older stable version,
    //     so the server's own pkg.version is meaningless. Use config-supplied
    //     client.downloadVersion if present, otherwise omit the version label.
    //   - default local download: /api/v1/client/download serves this server's
    //     embedded tgz, so pkg.version is accurate.
    const clientDownloadVersion = externalDownloadUrl
      ? (config.client?.downloadVersion || null)
      : pkg.version;

    return {
      status: 'ok',
      version: pkg.version,
      database: config.database.client,
      uptime: process.uptime(),
      dashboard: {
        rankingPageSize: (config.dashboard && config.dashboard.rankingPageSize) || 50,
      },
      // URL shown on Dashboard for users to download the full client package.
      // Defaults to the server's own /api/v1/client/download so existing
      // deployments work without any config change.
      clientDownloadUrl: externalDownloadUrl || '/api/v1/client/download',
      clientDownloadVersion,
    };
  });
}

module.exports = healthRoutes;
