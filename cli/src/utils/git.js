/**
 * Safe git shell-outs. Every function:
 *   - times out at 5s (long enough for a slow repo, short enough not to stall the hook)
 *   - swallows ALL errors and returns null / [] (hook must never crash the agent)
 *   - uses execFileSync with shell:false to avoid quoting bugs and shell injection
 *   - silences stderr (`stdio:['ignore','pipe','ignore']`) — we don't need it
 *
 * Used by universal-hook on SessionStart (capture remote/email) and SessionEnd
 * (sample commits in the session window).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TIMEOUT_MS = 5000;
const EXEC_OPTS = {
  encoding: 'utf-8',
  timeout: TIMEOUT_MS,
  stdio: ['ignore', 'pipe', 'ignore'],
  windowsHide: true,
  maxBuffer: 8 * 1024 * 1024, // 8MB — covers very chatty `git log --numstat`
};

function safeRun(args, cwd) {
  try {
    return execFileSync('git', args, { ...EXEC_OPTS, cwd }).trim();
  } catch {
    return null;
  }
}

/** Cheap check first (file system), git rev-parse as fallback. */
function isGitRepo(cwd) {
  if (!cwd) return false;
  try {
    if (fs.existsSync(path.join(cwd, '.git'))) return true;
  } catch {}
  return safeRun(['rev-parse', '--is-inside-work-tree'], cwd) === 'true';
}

function getRemoteUrl(cwd) {
  if (!isGitRepo(cwd)) return null;
  return safeRun(['remote', 'get-url', 'origin'], cwd) || null;
}

function getAuthorEmail(cwd) {
  if (!isGitRepo(cwd)) return null;
  return safeRun(['config', 'user.email'], cwd) || null;
}

/**
 * Run `git log --numstat --author=<email> --since=<iso>` in cwd and parse.
 * Returns an array of commit objects:
 *   { hash, time, subject, files: [{path, added, removed}], added, removed }
 * Returns [] on any failure or empty output.
 *
 * The `--pretty=format:%H%x00%aI%x00%s%x1e` separator (NUL between fields,
 * RS between commits) lets us parse commits with messages that contain tabs,
 * pipes, or quotes safely.
 */
function getCommitsSince(cwd, email, sinceIso) {
  if (!isGitRepo(cwd) || !email || !sinceIso) return [];

  const args = [
    'log',
    '--numstat',
    `--author=${email}`,
    `--since=${sinceIso}`,
    '--no-merges',
    '--pretty=format:%x1eCOMMIT%x1f%H%x1f%aI%x1f%s',
  ];
  const out = safeRun(args, cwd);
  if (!out) return [];

  const commits = [];
  // Split on the record separator we inserted before each commit header.
  // First chunk before the first separator is empty.
  for (const block of out.split('\x1e').slice(1)) {
    const lines = block.split('\n');
    const header = lines.shift() || '';
    if (!header.startsWith('COMMIT\x1f')) continue;
    const [, hash, time, subject] = header.split('\x1f');
    if (!hash) continue;

    const files = [];
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      // numstat format: <added>\t<removed>\t<path>
      // binary files show "-\t-\t<path>" — count as 0
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const a = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
      const r = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
      const p = parts.slice(2).join('\t'); // paths with tabs are unusual but possible
      files.push({ path: p, added: a, removed: r });
      added += a;
      removed += r;
    }

    commits.push({
      hash,
      time: time || null,
      subject: subject || '',
      files,
      added,
      removed,
    });
  }
  return commits;
}

module.exports = { isGitRepo, getRemoteUrl, getAuthorEmail, getCommitsSince };
