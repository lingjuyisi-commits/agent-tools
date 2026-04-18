/**
 * Admin routes — CRUD for allowed_users whitelist.
 * All routes require admin role (enforced by preHandler hook).
 */
const { getProfilesNameMap } = require('../services/user-profile-service');

async function adminRoutes(fastify, opts) {
  const { db } = opts;

  // Admin guard: must be logged in + approved + admin role
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.session?.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const login = request.session.user.login;
    const allowed = await db('allowed_users').where('login', login).first();
    if (!allowed || allowed.role !== 'admin') {
      return reply.status(403).send({ error: 'Admin access required' });
    }
  });

  // List all allowed users. name is overlaid from user_profiles when present,
  // otherwise falls back to the value stored in allowed_users.
  fastify.get('/api/v1/admin/users', async () => {
    const users = await db('allowed_users').select('*').orderBy('created_at', 'asc');
    const profileNames = await getProfilesNameMap(db);
    return users.map((u) => ({ ...u, name: profileNames[u.login] || u.name }));
  });

  // Add a user to whitelist
  fastify.post('/api/v1/admin/users', async (request, reply) => {
    const { login, name, role } = request.body || {};
    if (!login) {
      return reply.status(400).send({ error: 'login is required' });
    }
    const validRole = (role === 'admin') ? 'admin' : 'viewer';

    try {
      await db('allowed_users').insert({
        login,
        name: name || '',
        role: validRole,
        created_by: request.session.user.login,
      });
      return { message: `User ${login} added as ${validRole}` };
    } catch (err) {
      const msg = (err.message || '').toLowerCase();
      if (msg.includes('unique') || msg.includes('duplicate') || msg.includes('constraint')) {
        return reply.status(409).send({ error: `User ${login} already exists` });
      }
      throw err;
    }
  });

  // Remove a user from whitelist
  fastify.delete('/api/v1/admin/users/:login', async (request, reply) => {
    const { login } = request.params;
    const deleted = await db('allowed_users').where('login', login).del();
    if (deleted === 0) {
      return reply.status(404).send({ error: `User ${login} not found` });
    }
    return { message: `User ${login} removed` };
  });
}

module.exports = adminRoutes;
