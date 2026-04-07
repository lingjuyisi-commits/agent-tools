const { insertEventBatch } = require('../services/event-service');

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
    return result;
  });
}

module.exports = eventsRoutes;
