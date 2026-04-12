const fs = require('fs');
const { computeDelta } = require('../../utils/token-snapshots');

function normalize(eventType, rawData) {
  const base = {
    agent: 'claude-code',
    session_id: rawData.session_id || rawData.sessionId || 'unknown',
    event_type: mapEventType(eventType),
  };

  // tool_name is directly in the hook payload for PreToolUse/PostToolUse
  if (rawData.tool_name) base.tool_name = rawData.tool_name;

  // model is only available in SessionStart hook payload
  if (rawData.model) base.model = rawData.model;

  // ── File change extraction (PostToolUse) ────────────────────────────────
  // Claude Code hook payloads do NOT include file change metrics directly.
  // We infer them from tool_input for Write/Edit tools.
  if (eventType === 'PostToolUse') {
    const input = rawData.tool_input || {};
    extractFileChanges(base, rawData.tool_name, input);
  }

  // ── Token extraction (Stop / SessionEnd) ────────────────────────────────
  // Claude Code hook payloads do NOT include usage/token data.
  // We read the transcript JSONL and compute INCREMENTAL token usage:
  //   delta = current_cumulative - last_snapshot
  // This avoids double-counting when the server SUMs all events.
  if ((eventType === 'Stop' || eventType === 'SessionEnd') && rawData.transcript_path) {
    try {
      const cumulative = readTranscriptUsage(rawData.transcript_path);
      const delta = computeDelta(base.session_id, cumulative);

      if (delta.input_tokens)  base.token_input = delta.input_tokens;
      if (delta.output_tokens) base.token_output = delta.output_tokens;
      if (delta.cache_read)    base.token_cache_read = delta.cache_read;
      if (delta.cache_write)   base.token_cache_write = delta.cache_write;
      if (cumulative.model)    base.model = cumulative.model;
    } catch {
      // transcript read failure is non-fatal — hook must never crash
    }
  }

  // ── Skill detection ─────────────────────────────────────────────────────
  // Inline path: UserPromptSubmit with prompt starting with "/"
  if (eventType === 'UserPromptSubmit' && typeof rawData.prompt === 'string') {
    const trimmed = rawData.prompt.trim();
    if (trimmed.startsWith('/')) {
      const skillName = trimmed.split(/\s+/)[0].slice(1);
      if (skillName) {
        base.skill_name = skillName;
        base.event_type = 'skill_use';
      }
    }
  }

  // Fork path: PostToolUse with tool_name="Skill"
  if (eventType === 'PostToolUse' && base.tool_name === 'Skill') {
    const skillInput = rawData.tool_input || rawData.input || {};
    if (typeof skillInput.skill === 'string' && skillInput.skill) {
      base.skill_name = skillInput.skill;
    }
    base.event_type = 'skill_use';
  }

  return base;
}

// ── File change helpers ───────────────────────────────────────────────────

function countLines(str) {
  if (!str) return 0;
  return str.split('\n').length;
}

function extractFileChanges(base, toolName, input) {
  if (toolName === 'Write') {
    base.files_created = 1;
    base.lines_added = countLines(input.content);
  } else if (toolName === 'Edit') {
    base.files_modified = 1;
    const oldLines = countLines(input.old_string);
    const newLines = countLines(input.new_string);
    base.lines_added = Math.max(0, newLines - oldLines);
    base.lines_removed = Math.max(0, oldLines - newLines);
  }
}

// ── Transcript token extraction ───────────────────────────────────────────

/**
 * Read a Claude Code transcript JSONL and sum all usage data.
 * Each assistant message contains `.message.usage` with token counts.
 * Also captures the model from the last assistant message.
 *
 * This is synchronous — transcript files are local and small enough.
 * Called from Stop/SessionEnd hooks which run at session end.
 */
function readTranscriptUsage(transcriptPath) {
  const totals = { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, model: null };
  if (!fs.existsSync(transcriptPath)) return totals;

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const usage = entry?.message?.usage;
      if (usage) {
        totals.input_tokens  += usage.input_tokens || 0;
        totals.output_tokens += usage.output_tokens || 0;
        totals.cache_read    += usage.cache_read_input_tokens || 0;
        totals.cache_write   += usage.cache_creation_input_tokens || 0;
      }
      const model = entry?.message?.model;
      if (model) totals.model = model;
    } catch {
      // skip malformed lines
    }
  }
  return totals;
}

// ── Event type mapping ────────────────────────────────────────────────────

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
