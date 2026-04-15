const os = require('os');
const { v4: uuidv4 } = require('uuid');
const pkg = require('../../package.json');

/** Local ISO time string (YYYY-MM-DDTHH:mm:ss, no Z suffix). */
function localNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function createNormalizedEvent(agentData) {
  return {
    event_id: uuidv4(),
    username: os.userInfo().username,
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
    ...agentData,
  };
}

module.exports = { createNormalizedEvent };
