const os = require('os');
const { v4: uuidv4 } = require('uuid');
const pkg = require('../../package.json');
const config = require('../utils/config');

/** Local ISO time string (YYYY-MM-DDTHH:mm:ss, no Z suffix). */
function localNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Resolve username — config-supplied value (e.g. SSO login the user
 * pasted into config.json) wins over OS username. Lets users align their
 * agent-tools identity with whatever the dashboard / authentication system
 * recognizes them as, without requiring a CLI auth flow. Same precedence
 * pattern as uploader._reportUpdateLogs.
 */
function resolveUsername() {
  try {
    const cfg = config.load();
    const u = cfg?.username;
    if (typeof u === 'string' && u.trim()) return u.trim();
  } catch {}
  return os.userInfo().username;
}

function createNormalizedEvent(agentData) {
  return {
    event_id: uuidv4(),
    username: resolveUsername(),
    hostname: os.hostname(),
    platform: os.platform(),
    agent_version: pkg.version,
    event_time: localNow(),
    // Defaults are null (not 0) to distinguish "not available" from "genuinely zero".
    // Adapters set actual values only when the data source provides them:
    //   - token_*: populated on Stop/SessionEnd events via transcript JSONL
    //   - files_*/lines_*: populated on PostToolUse events for Write/Edit tools
    token_input: null, token_output: null,
    token_cache_read: null, token_cache_write: null,
    files_created: null, files_modified: null,
    lines_added: null, lines_removed: null,
    // Repo-commit tracking fields (populated by claude-code adapter on
    // SessionStart, and by universal-hook on the synthetic session_commits
    // event). Null when not in a git repo or git unavailable — server tolerates.
    cwd: null,
    git_remote_url: null,
    git_author_email: null,
    ...agentData,
  };
}

module.exports = { createNormalizedEvent };
