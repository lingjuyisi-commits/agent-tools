/**
 * GitHub OAuth provider — for development/testing or GitHub-based teams.
 *
 * Required config fields:
 *   auth.clientId, auth.clientSecret
 */
const oauthPlugin = require('@fastify/oauth2');

module.exports = async function githubProvider(fastify, opts) {
  const { auth, serverPort } = opts;

  fastify.register(oauthPlugin, {
    name: 'github',
    credentials: {
      client: { id: auth.clientId, secret: auth.clientSecret },
      auth: oauthPlugin.GITHUB_CONFIGURATION,
    },
    startRedirectPath: '/auth/login',
    callbackUri: auth.callbackUrl || `http://localhost:${serverPort}/auth/callback`,
    scope: ['read:user'],
  });

  fastify.get('/auth/callback', async (request, reply) => {
    try {
      request.log.info('GitHub OAuth callback received, exchanging code for token...');
      const tokenResult = await fastify.github.getAccessTokenFromAuthorizationCodeFlow(request);
      request.log.info('GitHub token obtained successfully');

      request.log.info('Fetching GitHub user info...');
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tokenResult.token.access_token}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        request.log.error({ status: res.status, body }, 'GitHub API failed');
        throw new Error(`GitHub API failed: ${res.status} ${body}`);
      }
      const userData = await res.json();
      request.log.info({ login: userData.login, id: userData.id }, 'GitHub user info received');

      request.session.user = {
        id: userData.id,
        login: userData.login,
        name: userData.name || userData.login,
        avatar_url: userData.avatar_url,
      };
      request.log.info({ login: userData.login }, 'GitHub login successful');

      reply.redirect('/dashboard/index.html');
    } catch (err) {
      request.log.error(err, 'GitHub OAuth callback failed');
      reply.status(400).send({ error: 'GitHub 认证失败', detail: err.message });
    }
  });
};
