const knex = require('knex');
const path = require('path');
const fs = require('fs');

function createDb(config) {
  const dbConfig = { ...config.database };

  // For SQLite, ensure the data directory exists
  if (dbConfig.client === 'better-sqlite3' || dbConfig.client === 'sqlite3') {
    const dbFile = dbConfig.connection.filename;
    const dbDir = path.dirname(dbFile);
    fs.mkdirSync(dbDir, { recursive: true });
  }

  return knex(dbConfig);
}

module.exports = { createDb };
