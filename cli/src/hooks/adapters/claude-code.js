function normalize(eventType, rawData) {
  const base = {
    agent: 'claude-code',
    session_id: rawData.session_id || rawData.sessionId || 'unknown',
    event_type: mapEventType(eventType),
  };
  if (rawData.tool_name) base.tool_name = rawData.tool_name;
  if (rawData.tool) base.tool_name = rawData.tool;
  if (rawData.model) base.model = rawData.model;
  if (rawData.usage) {
    base.token_input = rawData.usage.input_tokens || 0;
    base.token_output = rawData.usage.output_tokens || 0;
    base.token_cache_read = rawData.usage.cache_read_input_tokens || 0;
    base.token_cache_write = rawData.usage.cache_creation_input_tokens || 0;
  }
  if (rawData.skill_name) base.skill_name = rawData.skill_name;
  if (rawData.files_created !== undefined) base.files_created = rawData.files_created;
  if (rawData.files_modified !== undefined) base.files_modified = rawData.files_modified;
  if (rawData.lines_added !== undefined) base.lines_added = rawData.lines_added;
  if (rawData.lines_removed !== undefined) base.lines_removed = rawData.lines_removed;
  if (rawData.conversation_turn !== undefined) base.conversation_turn = rawData.conversation_turn;
  return base;
}

function mapEventType(event) {
  const map = {
    'SessionStart': 'session_start', 'SessionEnd': 'session_end',
    'PreToolUse': 'tool_pre', 'PostToolUse': 'tool_use',
    'PostToolUseFailure': 'tool_failure', 'UserPromptSubmit': 'user_message',
    'Stop': 'assistant_stop',
  };
  return map[event] || event.toLowerCase();
}

module.exports = { normalize };
