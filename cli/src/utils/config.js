const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = path.join(os.homedir(), '.agent-tools');
const CONFIG_FILE = path.join(HOME, 'config.json');
const DATA_DIR = path.join(HOME, 'data');
const DB_FILE = path.join(DATA_DIR, 'local.db');

function load() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function save(config) {
  ensureDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function exists() {
  return fs.existsSync(CONFIG_FILE);
}

function ensureDirs() {
  if (!fs.existsSync(HOME)) fs.mkdirSync(HOME, { recursive: true });
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

module.exports = { load, save, exists, ensureDirs, HOME, CONFIG_FILE, DATA_DIR, DB_FILE };
