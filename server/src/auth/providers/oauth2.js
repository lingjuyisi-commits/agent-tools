/**
 * Generic OAuth2/OIDC provider — adapts to any IDaaS platform via config.
 *
 * Required config fields:
 *   auth.clientId, auth.clientSecret, auth.authorizeHost
 *
 * Optional config fields:
 *   auth.authorizePath  (default: /oauth/authorize)
 *   auth.tokenHost      (default: same as authorizeHost)
 *   auth.tokenPath      (default: /oauth/token)
 *   auth.userinfoUrl    (default: {authorizeHost}/oauth/userinfo)
 *   auth.scope          (default: ['openid', 'profile'])
 *   auth.callbackUrl    (default: http://localhost:{port}/auth/callback)
 *   auth.fieldMap       (default: { id: 'sub', login: 'preferred_username', name: 'name', avatar: 'picture' })
 */
const oauthPlugin = require('@fastify/oauth2');

module.exports = async function oauth2Provider(fastify, opts) {
  const { auth, serverPort } = opts;

  fastify.register(oauthPlugin, {
    name: 'idaas',
    credentials: {
      client: { id: auth.clientId, secret: auth.clientSecret },
      auth: {
        authorizeHost: auth.authorizeHost,
        authorizePath: auth.authorizePath || '/oauth/authorize',
        tokenHost: auth.tokenHost || auth.authorizeHost,
        tokenPath: auth.tokenPath || '/oauth/token',
      },
    },
    startRedirectPath: '/auth/login',
    callbackUri: auth.callbackUrl || `http://localhost:${serverPort}/auth/callback`,
    scope: auth.scope || ['openid', 'profile'],
  });

  fastify.get('/auth/callback', async (request, reply) => {
    try {
      const tokenResult = await fastify.idaas.getAccessTokenFromAuthorizationCodeFlow(request);
      const accessToken = tokenResult.token.access_token;

      const userinfoUrl = auth.userinfoUrl || `${auth.authorizeHost}/oauth/userinfo`;
      const res = await fetch(userinfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Userinfo request failed: ${res.status}`);
      const userData = await res.json();

      const fm = auth.fieldMap || {};
      request.session.user = {
        id: userData[fm.id || 'sub'],
        login: userData[fm.login || 'preferred_username'] || userData.name || 'unknown',
        name: userData[fm.name || 'name'] || '',
        avatar_url: userData[fm.avatar || 'picture'] || null,
      };

      reply.redirect('/dashboard/index.html');
    } catch (err) {
      request.log.error(err, 'OAuth2 callback failed');
      reply.status(400).send({ error: 'OAuth2 认证失败', detail: err.message });
    }
  });
};
