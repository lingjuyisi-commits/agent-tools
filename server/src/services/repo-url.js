/**
 * Normalize a git remote URL into a canonical `host/path` form, and decide
 * whether it is in an admin-configured allowlist.
 *
 * Why normalize?
 *   The same repo can be referenced as:
 *     - https://github.com/myorg/repo.git
 *     - git@github.com:myorg/repo.git
 *     - https://user:tok@github.com/myorg/repo
 *     - GitHub.com/MyOrg/repo
 *   Storing them all separately would shatter stats. We collapse to lowercase
 *   `host/path-without-trailing-.git`.
 *
 * Why allowlist by domain prefix?
 *   Admins want to track org repos (`github.com/myorg`) without enumerating
 *   every project. A prefix match on the canonical form does this naturally.
 */

function normalizeRepoUrl(raw) {
  if (typeof raw !== 'string') return null;
  let url = raw.trim();
  if (!url) return null;

  // SSH form: git@host:org/repo(.git) → https://host/org/repo
  // (does not include scheme, so URL parser can't help directly)
  const sshMatch = url.match(/^[\w.-]+@([^:]+):(.+)$/);
  if (sshMatch) {
    url = `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  // Strip ssh:// or git:// schemes — treat all the same
  url = url.replace(/^(ssh|git|git\+ssh|git\+https):\/\//i, 'https://');

  // No scheme yet? Default to https so URL() can parse.
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // Strip credentials, port, query, fragment.
  // Lowercase the entire form (host AND path): GitHub treats org/repo names
  // case-insensitively, and we'd rather collapse `MyOrg/Repo` and `myorg/repo`
  // into one bucket than shatter the same repo across two stat rows.
  let host = parsed.hostname.toLowerCase();
  let path = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
  if (path.endsWith('.git')) path = path.slice(0, -4);
  if (!host || !path) return null;

  return `${host}/${path}`;
}

/**
 * Allow-list match. Each rule is itself normalized then compared as a path
 * prefix split on '/'. So `github.com/myorg` matches
 * `github.com/myorg/repo` but NOT `github.com/myorg-evil/repo`.
 *
 * A bare host rule like `gitlab.corp.com` matches everything under that host.
 */
function isAllowedDomain(normalizedRepo, allowedDomains) {
  if (!normalizedRepo) return false;
  if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) return false;

  const repoSegs = normalizedRepo.split('/');
  for (const rule of allowedDomains) {
    const normRule = normalizeRepoUrl(rule) || (typeof rule === 'string' ? rule.toLowerCase().trim() : '');
    if (!normRule) continue;
    const ruleSegs = normRule.split('/').filter(Boolean);
    if (ruleSegs.length === 0) continue;
    if (ruleSegs.length > repoSegs.length) continue;
    let match = true;
    for (let i = 0; i < ruleSegs.length; i++) {
      if (ruleSegs[i] !== repoSegs[i]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

module.exports = { normalizeRepoUrl, isAllowedDomain };
