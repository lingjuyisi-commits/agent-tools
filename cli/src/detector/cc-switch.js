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

module.exports = { detect };
