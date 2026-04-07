const config = require('./src/config');

const cfg = config.load();

module.exports = {
  ...cfg.database,
  migrations: {
    directory: './migrations'
  }
};
