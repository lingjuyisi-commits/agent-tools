exports.up = async function(knex) {
  if (await knex.schema.hasTable('allowed_users')) return;
  return knex.schema.createTable('allowed_users', (t) => {
    t.increments('id').primary();
    t.string('login').notNullable().unique();
    t.string('name');
    t.string('role').defaultTo('viewer');
    t.string('created_by');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('allowed_users');
};
