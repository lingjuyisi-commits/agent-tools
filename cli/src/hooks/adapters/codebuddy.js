function normalize(eventType, rawData) {
  const base = {
    agent: 'codebuddy',
    session_id: rawData.session_id || rawData.sessionId || 'unknown',
    event_type: mapEventType(eventType),
  };
  if (rawData.tool_name) base.tool_name = rawData.tool_name;
  if (rawData.tool) base.tool_name = rawData.tool;
  if (rawData.model) base.model = rawData.model;
  if (rawData.usage) {
    base.token_input = rawData.usage.input_tokens || 0;
    base.token_output = rawData.usage.output_tokens || 0;
  }
  if (rawData.skill_name) base.skill_name = rawData.skill_name;
  return base;
}

function mapEventType(event) {
  const map = { 'PreToolUse': 'tool_pre', 'PostToolUse': 'tool_use' };
  return map[event] || event.toLowerCase();
}

module.exports = { normalize };
