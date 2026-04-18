exports.up = async function(knex) {
  if (await knex.schema.hasTable('user_profiles')) return;
  return knex.schema.createTable('user_profiles', (t) => {
    t.string('username', 128).primary();
    t.string('display_name', 128);
    t.string('email', 255);
    t.string('dept', 128);
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('user_profiles');
};
