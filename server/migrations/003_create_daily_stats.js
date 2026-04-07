exports.up = function(knex) {
  return knex.schema.createTable('daily_stats', t => {
    t.increments('id');
    t.string('stat_date', 10).notNullable();
    t.string('username', 128).notNullable();
    t.string('hostname', 256).notNullable();
    t.string('agent', 32).notNullable();
    t.string('model', 64).notNullable();
    t.integer('event_count').defaultTo(0);
    t.integer('session_count').defaultTo(0);
    t.integer('token_input_total').defaultTo(0);
    t.integer('token_output_total').defaultTo(0);
    t.integer('token_cache_read_total').defaultTo(0);
    t.integer('token_cache_write_total').defaultTo(0);
    t.integer('files_created_total').defaultTo(0);
    t.integer('files_modified_total').defaultTo(0);
    t.integer('lines_added_total').defaultTo(0);
    t.integer('lines_removed_total').defaultTo(0);
    t.unique(['stat_date', 'username', 'hostname', 'agent', 'model']);
    t.index('stat_date');
    t.index(['username', 'stat_date']);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('daily_stats');
};
