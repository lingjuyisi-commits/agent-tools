const os = require('os');
const { v4: uuidv4 } = require('uuid');

function createNormalizedEvent(agentData) {
  return {
    event_id: uuidv4(),
    username: os.userInfo().username,
    hostname: os.hostname(),
    platform: os.platform(),
    event_time: new Date().toISOString(),
    token_input: 0, token_output: 0,
    token_cache_read: 0, token_cache_write: 0,
    files_created: 0, files_modified: 0,
    lines_added: 0, lines_removed: 0,
    ...agentData,
  };
}

module.exports = { createNormalizedEvent };
