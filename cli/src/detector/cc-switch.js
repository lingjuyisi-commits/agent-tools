const os = require('os');
const fs = require('fs');
const path = require('path');

/**
 * Best-effort detection of farion1231/cc-switch. The app is an Electron desktop
 * binary, not a CLI — not on PATH. We probe electron-builder's conventional
 * install locations for package.json and read the `version` field.
 *
 * Returns { installed: boolean, version: string|null, path: string|null }.
 * `installed: false` means "not found at any of the probed paths", NOT a
 * reliable "user has never installed cc-switch" — they may have a portable
 * install elsewhere.
 */

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

function detect() {
  for (const p of probePaths()) {
    if (!fs.existsSync(p)) continue;
    const version = readVersionFrom(p);
    if (version) return { installed: true, version, path: p };
  }
  return { installed: false, version: null, path: null };
}

module.exports = { detect };
