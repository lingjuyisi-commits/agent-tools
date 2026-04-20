const os = require('os');
const fs = require('fs');
const path = require('path');

/**
 * Best-effort detection of farion1231/cc-switch. The app is an Electron desktop
 * binary, not a CLI — not on PATH. We probe electron-builder's conventional
 * install locations for package.json and read the `version` field.
 *
 * Returns { installed, version, path, protected }.
 *  - installed:  app found at one of the probed paths.
 *  - version:    semver string extracted from that package.json.
 *  - path:       path that was found.
 *  - protected:  agent-tools hooks are in cc-switch's Common Config Snippet.
 *                Only meaningful when installed is true.
 *
 * `installed: false` means "not found at any of the probed paths", NOT a
 * reliable "user has never installed cc-switch" — they may have a portable
 * install elsewhere.
 */

// Max bytes to scan when probing the cc-switch SQLite db for our hook string.
// The db is small in practice (single-digit MB); this cap is just insurance.
const DB_SCAN_MAX_BYTES = 16 * 1024 * 1024;

function probePaths() {
  const home = os.homedir();
  const platform = os.platform();
  if (platform === 'darwin') {
    return [
      '/Applications/CC Switch.app/Contents/Resources/app/package.json',
      path.join(home, 'Applications', 'CC Switch.app', 'Contents', 'Resources', 'app', 'package.json'),
    ];
  }
  if (platform === 'win32') {
    const appData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(appData, 'Programs', 'cc-switch', 'resources', 'app', 'package.json'),
      // Older/alternate Squirrel layout keeps the real app under app-<version>/:
      path.join(appData, 'cc-switch', 'app', 'resources', 'app', 'package.json'),
    ];
  }
  return [];
}

function readVersionFrom(pkgPath) {
  try {
    const text = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(text);
    if (typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version)) {
      return pkg.version;
    }
  } catch {}
  return null;
}

// cc-switch stores provider configs + common config in a SQLite db at
// ~/.cc-switch/cc-switch.db (all platforms, per upstream docs). The
// 'universal-hook.js' string would only land there if the user pasted our
// hooks into the Common Config Snippet — provider configs don't reference
// it. Scanning the raw bytes avoids coupling to the internal schema.
function ccSwitchDbCandidates() {
  const home = os.homedir();
  const paths = [path.join(home, '.cc-switch', 'cc-switch.db')];
  if (os.platform() === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) paths.push(path.join(appData, 'cc-switch', 'cc-switch.db'));
  }
  return paths;
}

function isCommonConfigProtected() {
  for (const p of ccSwitchDbCandidates()) {
    try {
      if (!fs.existsSync(p)) continue;
      const stat = fs.statSync(p);
      if (stat.size > DB_SCAN_MAX_BYTES) continue;
      const buf = fs.readFileSync(p);
      if (buf.includes('universal-hook.js')) return true;
    } catch {}
  }
  return false;
}

function detect() {
  for (const p of probePaths()) {
    if (!fs.existsSync(p)) continue;
    const version = readVersionFrom(p);
    if (version) {
      return {
        installed: true,
        version,
        path: p,
        protected: isCommonConfigProtected(),
      };
    }
  }
  return { installed: false, version: null, path: null, protected: false };
}

/**
 * Inject hooks into cc-switch's Common Config and enable commonConfigEnabled
 * for all claude providers, so hooks survive provider switches.
 *
 * @param {object} hooks - The hooks object from ~/.claude/settings.json
 * @returns {{ success: boolean, dbPath?: string, error?: string }}
 */
function injectCommonConfig(hooks) {
  let dbPath = null;
  for (const p of ccSwitchDbCandidates()) {
    if (fs.existsSync(p)) { dbPath = p; break; }
  }
  if (!dbPath) return { success: false, error: 'cc-switch db not found' };

  let Database;
  try { Database = require('better-sqlite3'); } catch {
    return { success: false, error: 'better-sqlite3 not available' };
  }

  let conn;
  try {
    conn = new Database(dbPath);

    // 1. Merge hooks into common_config_claude
    const row = conn.prepare("SELECT value FROM settings WHERE key='common_config_claude'").get();
    let config = {};
    try { if (row) config = JSON.parse(row.value); } catch {}
    config.hooks = hooks;
    conn.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('common_config_claude', ?)"
    ).run(JSON.stringify(config, null, 2));

    // 2. Enable commonConfigEnabled for all claude providers
    const providers = conn.prepare(
      "SELECT id, app_type, meta FROM providers WHERE app_type='claude'"
    ).all();
    for (const p of providers) {
      let meta = {};
      try { meta = JSON.parse(p.meta); } catch {}
      if (!meta.commonConfigEnabled) {
        meta.commonConfigEnabled = true;
        conn.prepare(
          "UPDATE providers SET meta=? WHERE id=? AND app_type=?"
        ).run(JSON.stringify(meta), p.id, p.app_type);
      }
    }

    return { success: true, dbPath };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    try { if (conn) conn.close(); } catch {}
  }
}

module.exports = { detect, injectCommonConfig };
