const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LABEL      = 'com.agent-tools.guard';
const PLIST_DIR  = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = path.join(PLIST_DIR, `${LABEL}.plist`);
const LOG_DIR    = path.join(os.homedir(), '.agent-tools', 'data');

function watcherPath() {
  return path.join(__dirname, 'watcher.js');
}

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(watcherPath())}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(LOG_DIR, 'guard.out'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(LOG_DIR, 'guard.err'))}</string>
</dict>
</plist>
`;
}

function domain() {
  return `gui/${process.getuid()}`;
}

function install() {
  fs.mkdirSync(PLIST_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR,   { recursive: true });
  fs.writeFileSync(PLIST_PATH, buildPlist(), 'utf-8');

  // Unload any previous instance — may be left behind by an older install
  // pointing at a stale watcher path.
  try { execFileSync('launchctl', ['bootout', domain(), PLIST_PATH], { stdio: 'ignore' }); } catch {}

  execFileSync('launchctl', ['bootstrap', domain(), PLIST_PATH], { stdio: 'pipe' });
  try { execFileSync('launchctl', ['enable', `${domain()}/${LABEL}`], { stdio: 'ignore' }); } catch {}

  return { installed: true, label: LABEL, plist: PLIST_PATH };
}

function uninstall() {
  try { execFileSync('launchctl', ['bootout', domain(), PLIST_PATH], { stdio: 'ignore' }); } catch {}
  try { fs.unlinkSync(PLIST_PATH); } catch {}
  return { uninstalled: true };
}

function status() {
  try {
    const out = execFileSync('launchctl', ['print', `${domain()}/${LABEL}`], { stdio: 'pipe' }).toString();
    return { installed: true, label: LABEL, plist: PLIST_PATH, details: out };
  } catch {
    return { installed: false };
  }
}

module.exports = { install, uninstall, status };
