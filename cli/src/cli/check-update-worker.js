#!/usr/bin/env node

/**
 * Silent auto-update worker — called via fork() from uploader.js.
 * Downloads and installs a new CLI version without user interaction.
 *
 * Usage: node check-update-worker.js <version> <downloadUrl>
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { appendLog } = require('../utils/json-logger');

const LOG_FILE = path.join(os.homedir(), '.agent-tools', 'data', 'update-log.json');

// Climb from __dirname to find the package root, then derive {prefix}/bin/npm.
// Handles nvm, homebrew, system npm, and Windows without relying on PATH.
function findNpmByInstallPath() {
  let dir = __dirname;
  let pkgRoot = null;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) { pkgRoot = dir; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!pkgRoot) return null;

  const nodeModulesDir = path.dirname(pkgRoot);
  if (path.basename(nodeModulesDir) !== 'node_modules') return null;

  // prefix/node_modules/pkg  → prefix/bin/npm
  // prefix/lib/node_modules/pkg → prefix/bin/npm  (Linux/Mac standard layout)
  const libOrPrefix = path.dirname(nodeModulesDir);
  const candidates = process.platform === 'win32'
    ? [path.join(libOrPrefix, 'npm.cmd')]
    : [
        path.join(libOrPrefix, 'bin', 'npm'),
        path.join(path.dirname(libOrPrefix), 'bin', 'npm'),
      ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Persist locally AND fire a best-effort direct POST. The local file is the
// reliable channel (next sync piggy-backs it), but it depends on the user
// triggering more hook events afterwards. Idle users would never report
// upgrade outcomes — so we also POST directly here.
//
// Both paths reuse the same `entry.time` so the server's
// `username|hostname|version|time|status` dedup hash collapses them into a
// single event_id (no double counting).
async function log(entry) {
  const stamped = { time: new Date().toISOString(), ...entry };
  appendLog(LOG_FILE, stamped, 20);
  // Await so the worker process doesn't exit before the POST completes.
  // The unref'd timer inside reportDirect caps the wait at 5s.
  await reportDirect(stamped);
}

async function reportDirect(entry) {
  if (typeof fetch !== 'function') return;

  const CONFIG_FILE = path.join(os.homedir(), '.agent-tools', 'config.json');
  let serverUrl = '';
  let username = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    serverUrl = (cfg?.server?.url || '').replace(/\/+$/, '');
    username = cfg?.username || '';
  } catch {}
  if (!serverUrl) return;
  if (!username) {
    try { username = os.userInfo().username; } catch { return; }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    await fetch(`${serverUrl}/api/v1/updates/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        hostname: os.hostname(),
        platform: os.platform(),
        logs: [entry],
      }),
      signal: controller.signal,
    });
  } catch {} finally {
    clearTimeout(timer);
  }
}

async function main() {
  const [,, version, downloadUrl] = process.argv;
  if (!version || !downloadUrl) process.exit(0);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-autoupdate-'));
  const tgzPath = path.join(tmpDir, `agent-tools-cli-${version}.tgz`);

  try {
    // Download
    const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tgzPath, buffer);

    // Find the npm that owns this package's install location so the update
    // lands in the same global prefix — making the new version take effect
    // immediately without restarting the terminal.
    let npmCmd = 'npm';
    try {
      const discovered = findNpmByInstallPath();
      if (discovered) {
        npmCmd = `"${discovered}"`;
      } else {
        const siblingNpm = path.join(path.dirname(process.execPath), 'npm');
        if (fs.existsSync(siblingNpm)) npmCmd = `"${siblingNpm}"`;
      }
    } catch {}

    // Install — prefer local cache first, fall back to network
    const spawnOpts = { stdio: 'ignore', timeout: 120000, shell: true, windowsHide: true };
    let result = spawnSync(`${npmCmd} install -g --prefer-offline "${tgzPath}"`, spawnOpts);
    if (result.status !== 0) {
      result = spawnSync(`${npmCmd} install -g "${tgzPath}"`, spawnOpts);
    }
    if (result.status !== 0) throw new Error(`npm install exited with code ${result.status}`);

    // Record where npm installed to — helps diagnose wrong-prefix issues.
    let prefix = '';
    try {
      const r = spawnSync(`${npmCmd} prefix -g`, { shell: true, encoding: 'utf8', timeout: 10000 });
      prefix = (r.stdout || '').trim();
    } catch {}

    await log({ status: 'success', version, from: require('../../package.json').version, npm: npmCmd, prefix });
  } catch (err) {
    await log({ status: 'failed', version, error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

main().catch(() => process.exit(0));
