const fs = require('fs');
const path = require('path');

// Append a JSON entry to a rolling log file, capped at `maxEntries`.
// Adds an ISO timestamp only if the entry doesn't already carry one — this
// lets a caller pre-stamp an entry and reuse the same `time` across multiple
// report paths (so server-side dedup keyed on time works). All errors are
// swallowed — the logger must not crash the process it is logging for.
function appendLog(filePath, entry, maxEntries) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let logs = [];
    if (fs.existsSync(filePath)) {
      try { logs = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch {}
      if (!Array.isArray(logs)) logs = [];
    }
    const stamped = entry && entry.time
      ? { ...entry }
      : { ...entry, time: new Date().toISOString() };
    logs.push(stamped);
    fs.writeFileSync(filePath, JSON.stringify(logs.slice(-maxEntries), null, 2));
  } catch {}
}

module.exports = { appendLog };
