exports.up = async function(knex) {
  const hasSource = await knex.schema.hasColumn('daily_stats', 'source');
  if (hasSource) return; // already applied

  return knex.schema.alterTable('daily_stats', (t) => {
    t.string('source').defaultTo('hook');
    t.string('display_name');
    t.string('tool_type');
  });
};

exports.down = function(knex) {
  return knex.schema.alterTable('daily_stats', (t) => {
    t.dropColumn('source');
    t.dropColumn('display_name');
    t.dropColumn('tool_type');
  });
};
