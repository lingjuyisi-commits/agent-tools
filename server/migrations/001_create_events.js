exports.up = async function(knex) {
  if (await knex.schema.hasTable('events')) return;
  return knex.schema.createTable('events', t => {
    t.increments('id');
    t.string('event_id', 64).notNullable().unique();
    t.string('agent', 32).notNullable();
    t.string('agent_version', 32);
    t.string('username', 128).notNullable();
    t.string('hostname', 256).notNullable();
    t.string('platform', 16).notNullable();
    t.string('session_id', 128).notNullable();
    t.integer('conversation_turn');
    t.string('event_type', 64).notNullable();
    t.string('event_time', 32).notNullable();
    t.string('received_time', 32).notNullable();
    t.string('model', 64);
    t.integer('token_input').defaultTo(0);
    t.integer('token_output').defaultTo(0);
    t.integer('token_cache_read').defaultTo(0);
    t.integer('token_cache_write').defaultTo(0);
    t.string('tool_name', 128);
    t.string('skill_name', 128);
    t.integer('files_created').defaultTo(0);
    t.integer('files_modified').defaultTo(0);
    t.integer('lines_added').defaultTo(0);
    t.integer('lines_removed').defaultTo(0);
    t.text('extra');
    t.index('event_time');
    t.index(['username', 'event_time']);
    t.index('session_id');
    t.index(['agent', 'event_time']);
    t.index(['hostname', 'event_time']);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('events');
};
