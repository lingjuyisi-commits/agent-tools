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

function log(entry) {
  appendLog(LOG_FILE, entry, 20);
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

    log({ status: 'success', version, from: require('../../package.json').version, npm: npmCmd });
  } catch (err) {
    log({ status: 'failed', version, error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

main().catch(() => process.exit(0));
