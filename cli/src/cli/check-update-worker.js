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

    // Install — prefer local cache first, fall back to network
    const spawnOpts = { stdio: 'ignore', timeout: 120000, shell: true, windowsHide: true };
    let result = spawnSync(`npm install -g --prefer-offline "${tgzPath}"`, spawnOpts);
    if (result.status !== 0) {
      result = spawnSync(`npm install -g "${tgzPath}"`, spawnOpts);
    }
    if (result.status !== 0) throw new Error(`npm install exited with code ${result.status}`);

    log({ status: 'success', version, from: require('../../package.json').version });
  } catch (err) {
    log({ status: 'failed', version, error: err.message });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

main().catch(() => process.exit(0));
