const fs = require('fs');
const path = require('path');

// Append a JSON entry to a rolling log file, capped at `maxEntries`.
// Adds an ISO timestamp to every entry. All errors are swallowed — the
// logger must not crash the process it is logging for.
function appendLog(filePath, entry, maxEntries) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let logs = [];
    if (fs.existsSync(filePath)) {
      try { logs = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch {}
      if (!Array.isArray(logs)) logs = [];
    }
    logs.push({ ...entry, time: new Date().toISOString() });
    fs.writeFileSync(filePath, JSON.stringify(logs.slice(-maxEntries), null, 2));
  } catch {}
}

module.exports = { appendLog };
