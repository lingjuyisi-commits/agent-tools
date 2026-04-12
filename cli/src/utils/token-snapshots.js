/**
 * Token snapshot persistence — shared by all adapters.
 *
 * Stores per-session cumulative token totals so each Stop event can report
 * only the *delta* since the last Stop, avoiding double-counting on the server.
 *
 * Uses atomic write (write to .tmp then rename) to mitigate concurrent
 * hook processes writing at the same time.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const SNAPSHOT_FILE = path.join(os.homedir(), '.agent-tools', 'data', 'token-snapshots.json');

const EMPTY_TOTALS = { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 };

function loadSnapshots() {
  try {
    if (!fs.existsSync(SNAPSHOT_FILE)) return {};
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSnapshots(snapshots) {
  try {
    const dir = path.dirname(SNAPSHOT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to temp file then rename to avoid partial reads
    const tmpFile = SNAPSHOT_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(snapshots), 'utf-8');
    fs.renameSync(tmpFile, SNAPSHOT_FILE);
  } catch {
    // non-fatal — hook must never crash
  }
}

/**
 * Compute incremental token delta and persist the new snapshot.
 *
 * @param {string} sessionId  - current session identifier
 * @param {object} cumulative - cumulative totals from transcript
 *   { input_tokens, output_tokens, cache_read, cache_write }
 * @returns {object} delta - incremental tokens since last snapshot
 *   { input_tokens, output_tokens, cache_read, cache_write }
 */
function computeDelta(sessionId, cumulative) {
  const snapshots = loadSnapshots();
  const prev = { ...EMPTY_TOTALS, ...snapshots[sessionId] };

  const delta = {
    input_tokens:  Math.max(0, (cumulative.input_tokens  || 0) - prev.input_tokens),
    output_tokens: Math.max(0, (cumulative.output_tokens || 0) - prev.output_tokens),
    cache_read:    Math.max(0, (cumulative.cache_read    || 0) - prev.cache_read),
    cache_write:   Math.max(0, (cumulative.cache_write   || 0) - prev.cache_write),
  };

  // Save current cumulative as snapshot for next delta calculation
  snapshots[sessionId] = {
    input_tokens:  cumulative.input_tokens  || 0,
    output_tokens: cumulative.output_tokens || 0,
    cache_read:    cumulative.cache_read    || 0,
    cache_write:   cumulative.cache_write   || 0,
    updated_at:    new Date().toISOString(),
  };

  // Cleanup stale sessions (older than 7 days) to prevent file bloat
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const sid of Object.keys(snapshots)) {
    const ts = snapshots[sid].updated_at;
    if (ts && new Date(ts).getTime() < cutoff) delete snapshots[sid];
  }

  saveSnapshots(snapshots);

  return delta;
}

module.exports = { computeDelta };
