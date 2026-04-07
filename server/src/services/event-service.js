async function insertEventBatch(db, events) {
  const receivedTime = new Date().toISOString();
  let accepted = 0;
  let duplicates = 0;
  let errors = 0;

  await db.transaction(async trx => {
    for (const event of events) {
      try {
        if (!event.event_id || !event.agent || !event.username ||
            !event.hostname || !event.platform || !event.session_id ||
            !event.event_type || !event.event_time) {
          errors++;
          continue;
        }

        const row = {
          event_id: event.event_id,
          agent: event.agent,
          agent_version: event.agent_version || null,
          username: event.username,
          hostname: event.hostname,
          platform: event.platform,
          session_id: event.session_id,
          conversation_turn: event.conversation_turn || null,
          event_type: event.event_type,
          event_time: event.event_time,
          received_time: receivedTime,
          model: event.model || null,
          token_input: event.token_input || 0,
          token_output: event.token_output || 0,
          token_cache_read: event.token_cache_read || 0,
          token_cache_write: event.token_cache_write || 0,
          tool_name: event.tool_name || null,
          skill_name: event.skill_name || null,
          files_created: event.files_created || 0,
          files_modified: event.files_modified || 0,
          lines_added: event.lines_added || 0,
          lines_removed: event.lines_removed || 0,
          extra: event.extra ? JSON.stringify(event.extra) : null
        };

        // Try insert, catch unique constraint violation for dedup
        await trx('events').insert(row);
        accepted++;
      } catch (err) {
        // SQLite: SQLITE_CONSTRAINT, PG/MySQL: unique_violation / ER_DUP_ENTRY
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('unique') || msg.includes('duplicate') || msg.includes('constraint')) {
          duplicates++;
        } else {
          errors++;
        }
      }
    }
  });

  return { accepted, duplicates, errors };
}

module.exports = { insertEventBatch };
