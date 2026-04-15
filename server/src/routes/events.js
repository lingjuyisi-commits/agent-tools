const { insertEventBatch } = require('../services/event-service');
const pkg = require('../../package.json');

/**
 * Simple semver comparison: returns -1, 0, or 1
 */
function compareVersions(a, b) {
  const pa = (a || '').split('.').map(Number);
  const pb = (b || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

async function eventsRoutes(fastify, opts) {
  const { db } = opts;

  fastify.post('/api/v1/events/batch', async (request, reply) => {
    const { events } = request.body || {};

    if (!events || !Array.isArray(events) || events.length === 0) {
      return reply.status(400).send({
        error: 'Request body must contain a non-empty "events" array'
      });
    }

    const result = await insertEventBatch(db, events);

    // Check if client needs update
    const clientVersion = request.headers['x-client-version'];
    if (clientVersion && compareVersions(clientVersion, pkg.version) < 0) {
      result.update = {
        version: pkg.version,
        downloadUrl: '/api/v1/client/download',
      };
    }

    return result;
  });
}

module.exports = eventsRoutes;
