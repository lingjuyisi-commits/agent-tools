exports.up = function (knex) {
  return knex.schema.createTable('allowed_users', (t) => {
    t.increments('id').primary();
    t.string('login').notNullable().unique();
    t.string('name');
    t.string('role').defaultTo('viewer'); // "admin" | "viewer"
    t.string('created_by');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTable('allowed_users');
};
