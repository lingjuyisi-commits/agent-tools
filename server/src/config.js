const os = require('os');
const path = require('path');
const fs = require('fs');

const CONFIG_DIR = path.join(os.homedir(), '.agent-tools-server');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_DB_PATH = path.join(CONFIG_DIR, 'data', 'server.db');

function load() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {
      server: { port: 3000 },
      database: {
        client: 'better-sqlite3',
        connection: { filename: DEFAULT_DB_PATH },
        useNullAsDefault: true
      }
    };
  }
  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  return JSON.parse(raw);
}

function save(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function exists() {
  return fs.existsSync(CONFIG_FILE);
}

function defaultDbPath() {
  return DEFAULT_DB_PATH;
}

module.exports = { load, save, exists, defaultDbPath, CONFIG_DIR, CONFIG_FILE };
