/**
 * Generic OAuth2/OIDC provider — adapts to any IDaaS platform via config.
 *
 * Uses manual HTTP POST to token endpoint for maximum compatibility
 * with all OAuth2 providers (some IDaaS platforms are not compatible
 * with the simple-oauth2 library used by @fastify/oauth2).
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
 *   auth.userinfoTokenMethod  (default: 'header') — 'header' uses Authorization Bearer, 'query' appends access_token to URL
 */
const crypto = require('crypto');

module.exports = async function oauth2Provider(fastify, opts) {
  const { auth, serverPort } = opts;

  const authorizeHost = auth.authorizeHost;
  const authorizePath = auth.authorizePath || '/oauth/authorize';
  const tokenHost = auth.tokenHost || authorizeHost;
  const tokenPath = auth.tokenPath || '/oauth/token';
  const callbackUrl = auth.callbackUrl || `http://localhost:${serverPort}/auth/callback`;
  const scope = Array.isArray(auth.scope) ? auth.scope.join(' ') : (auth.scope || 'openid profile');

  // Store state tokens in memory to prevent CSRF
  const pendingStates = new Map();

  // Login: redirect to IDaaS authorization endpoint
  fastify.get('/auth/login', async (request, reply) => {
    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, Date.now());

    // Cleanup stale states (older than 10 minutes)
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of pendingStates) {
      if (v < cutoff) pendingStates.delete(k);
    }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: auth.clientId,
      redirect_uri: callbackUrl,
      scope,
      state,
    });

    const authorizeUrl = `${authorizeHost}${authorizePath}?${params}`;
    request.log.info({ authorizeUrl }, 'Redirecting to OAuth2 authorization');
    reply.redirect(authorizeUrl);
  });

  // Callback: exchange code for token via POST, then fetch userinfo
  fastify.get('/auth/callback', async (request, reply) => {
    try {
      const { code, state, error, error_description } = request.query;

      // Check for error from provider
      if (error) {
        request.log.error({ error, error_description }, 'OAuth2 provider returned error');
        return reply.status(400).send({ error: 'OAuth2 认证被拒绝', detail: error_description || error });
      }

      if (!code) {
        request.log.error('OAuth2 callback missing code parameter');
        return reply.status(400).send({ error: 'OAuth2 回调缺少 code 参数' });
      }

      // Validate state to prevent CSRF
      if (!state || !pendingStates.has(state)) {
        request.log.error({ state }, 'OAuth2 invalid or expired state');
        return reply.status(400).send({ error: 'OAuth2 state 验证失败，请重新登录' });
      }
      pendingStates.delete(state);

      // Exchange code for token via standard POST
      const tokenUrl = `${tokenHost}${tokenPath}`;
      request.log.info({ tokenUrl }, 'Exchanging code for token...');

      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
      });

      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody.toString(),
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text().catch(() => '');
        request.log.error({ status: tokenRes.status, body }, 'Token exchange failed');
        throw new Error(`Token exchange failed: ${tokenRes.status} ${body}`);
      }

      const tokenData = await tokenRes.json();
      const accessToken = tokenData.access_token;
      if (!accessToken) {
        request.log.error({ tokenDataKeys: Object.keys(tokenData) }, 'Token response missing access_token');
        throw new Error('Token response missing access_token');
      }
      request.log.info('OAuth2 token obtained successfully');

      // Fetch user info (support both header and query param for token)
      const userinfoBase = auth.userinfoUrl || `${authorizeHost}/oauth/userinfo`;
      const tokenInQuery = auth.userinfoTokenMethod === 'query';
      let userinfoUrl = userinfoBase;
      let userinfoHeaders = { Authorization: `Bearer ${accessToken}` };
      if (tokenInQuery) {
        const sep = userinfoBase.includes('?') ? '&' : '?';
        const queryParams = new URLSearchParams({
          access_token: accessToken,
          client_id: auth.clientId,
          scope,
        });
        userinfoUrl = `${userinfoBase}${sep}${queryParams}`;
        userinfoHeaders = {};
      }
      request.log.info({ userinfoUrl, tokenMethod: tokenInQuery ? 'query' : 'header' }, 'Fetching user info...');
      const userRes = await fetch(userinfoUrl, { headers: userinfoHeaders });
      if (!userRes.ok) {
        const body = await userRes.text().catch(() => '');
        request.log.error({ status: userRes.status, body }, 'Userinfo request failed');
        throw new Error(`Userinfo request failed: ${userRes.status} ${body}`);
      }
      const userData = await userRes.json();
      request.log.info({ userDataKeys: Object.keys(userData) }, 'Userinfo response received');

      // Map user fields
      const fm = auth.fieldMap || {};
      request.session.user = {
        id: userData[fm.id || 'sub'],
        login: userData[fm.login || 'preferred_username'] || userData.name || 'unknown',
        name: userData[fm.name || 'name'] || '',
        avatar_url: userData[fm.avatar || 'picture'] || null,
      };
      request.log.info({ login: request.session.user.login }, 'OAuth2 login successful');

      reply.redirect('/dashboard/index.html');
    } catch (err) {
      request.log.error(err, 'OAuth2 callback failed');
      reply.status(400).send({ error: 'OAuth2 认证失败', detail: err.message });
    }
  });
};
