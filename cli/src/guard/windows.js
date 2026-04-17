const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TASK_NAME = 'AgentToolsGuard';
const APP_DATA  = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const VBS_DIR   = path.join(APP_DATA, 'agent-tools');
const VBS_PATH  = path.join(VBS_DIR, 'guard-launcher.vbs');

function watcherPath() {
  return path.join(__dirname, 'watcher.js');
}

// Build a VBS script that launches node with a hidden window. The window
// style of 0 means "no window at all" — without this, schtasks ONLOGON would
// flash a cmd console every login.
function buildVbs() {
  const cmd = `"${process.execPath}" "${watcherPath()}"`;
  // VBS string literal: wrap in " and double every internal "
  const quoted = '"' + cmd.replace(/"/g, '""') + '"';
  return [
    `Set WshShell = CreateObject("WScript.Shell")`,
    `WshShell.Run ${quoted}, 0, False`,
    '',
  ].join('\r\n');
}

function install() {
  fs.mkdirSync(VBS_DIR, { recursive: true });
  // Write as UTF-16 LE with BOM. wscript.exe interprets .vbs files as the
  // system ANSI codepage unless a UTF-16 BOM is present, so UTF-8 paths
  // containing non-ASCII characters (e.g. 中文 usernames under APPDATA)
  // would be mangled. UTF-16 LE with BOM is the reliably supported form.
  const bom = Buffer.from([0xFF, 0xFE]);
  const body = Buffer.from(buildVbs(), 'utf16le');
  fs.writeFileSync(VBS_PATH, Buffer.concat([bom, body]));

  // If a previous task exists (e.g. left over from an older install), remove it
  // so we don't end up with stale watcher paths.
  try { execFileSync('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], { stdio: 'ignore' }); } catch {}

  execFileSync('schtasks', [
    '/create',
    '/tn', TASK_NAME,
    '/sc', 'ONLOGON',
    '/rl', 'LIMITED',
    '/tr', `wscript.exe "${VBS_PATH}"`,
    '/f',
  ], { stdio: 'pipe' });

  // Start it right now — don't wait for the next logon.
  try { execFileSync('schtasks', ['/run', '/tn', TASK_NAME], { stdio: 'ignore' }); } catch {}

  return { installed: true, taskName: TASK_NAME, launcher: VBS_PATH };
}

function uninstall() {
  try { execFileSync('schtasks', ['/end',    '/tn', TASK_NAME],       { stdio: 'ignore' }); } catch {}
  try { execFileSync('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], { stdio: 'ignore' }); } catch {}
  try { fs.unlinkSync(VBS_PATH); } catch {}
  return { uninstalled: true };
}

function status() {
  try {
    const out = execFileSync('schtasks', ['/query', '/tn', TASK_NAME, '/fo', 'LIST'], { stdio: 'pipe' }).toString();
    return { installed: true, taskName: TASK_NAME, launcher: VBS_PATH, details: out };
  } catch {
    return { installed: false };
  }
}

module.exports = { install, uninstall, status };
