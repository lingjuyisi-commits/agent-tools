exports.up = function (knex) {
  return knex.schema.alterTable('daily_stats', (t) => {
    t.string('source').defaultTo('hook');   // 'hook' | 'external'
    t.string('display_name');               // user display name (from external system)
    t.string('tool_type');                  // 'cli' | 'plugin' | 'ide' (external data)
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable('daily_stats', (t) => {
    t.dropColumn('source');
    t.dropColumn('display_name');
    t.dropColumn('tool_type');
  });
};
