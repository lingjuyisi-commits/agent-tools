exports.up = function(knex) {
  return knex.schema.createTable('sessions', t => {
    t.increments('id');
    t.string('session_id', 128).notNullable().unique();
    t.string('agent', 32).notNullable();
    t.string('agent_version', 32);
    t.string('username', 128).notNullable();
    t.string('hostname', 256).notNullable();
    t.string('platform', 16).notNullable();
    t.string('model', 64);
    t.string('started_at', 32);
    t.string('ended_at', 32);
    t.integer('event_count').defaultTo(0);
    t.integer('conversation_turns').defaultTo(0);
    t.integer('token_input_total').defaultTo(0);
    t.integer('token_output_total').defaultTo(0);
    t.integer('token_cache_read_total').defaultTo(0);
    t.integer('token_cache_write_total').defaultTo(0);
    t.integer('files_created_total').defaultTo(0);
    t.integer('files_modified_total').defaultTo(0);
    t.integer('lines_added_total').defaultTo(0);
    t.integer('lines_removed_total').defaultTo(0);
    t.index('username');
    t.index('started_at');
    t.index(['username', 'started_at']);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('sessions');
};
