exports.up = async function(knex) {
  if (await knex.schema.hasTable('tool_usage_detail')) return;
  return knex.schema.createTable('tool_usage_detail', t => {
    t.increments('id');
    t.string('stat_date', 10).notNullable();
    t.string('username', 128).notNullable();
    t.string('hostname', 256).notNullable();
    t.string('agent', 32).notNullable();
    t.string('tool_name', 128).notNullable();
    t.integer('usage_count').defaultTo(0);
    t.unique(['stat_date', 'username', 'hostname', 'agent', 'tool_name']);
    t.index('stat_date');
    t.index(['username', 'stat_date']);
    t.index('tool_name');
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('tool_usage_detail');
};
