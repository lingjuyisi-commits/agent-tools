#!/usr/bin/env node

// Called by AI coding agents via hook configuration.
// Reads event data from stdin, normalizes it, stores locally, and optionally syncs.
// MUST never block or crash the agent — all errors are silently caught.

async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  const agentArg = args.find(a => a.startsWith('--agent='));
  const eventArg = args.find(a => a.startsWith('--event='));
  const dbArg   = args.find(a => a.startsWith('--db='));

  const agent    = agentArg ? agentArg.split('=')[1] : 'unknown';
  const eventType = eventArg ? eventArg.split('=')[1] : 'unknown';
  const dbPath   = dbArg ? dbArg.split('=').slice(1).join('=') : null; // support paths with '='

  // Read stdin (agent pipes JSON event data)
  const rawData = await readStdin();

  processEvent(agent, eventType, rawData, dbPath);
}

function readStdin() {
  return new Promise((resolve) => {
    let input = '';
    const stdin = process.stdin;

    // If stdin is a TTY (no pipe), resolve immediately
    if (stdin.isTTY) {
      resolve({});
      return;
    }

    stdin.setEncoding('utf-8');

    // Timeout — don't hang forever if no stdin data arrives
    const timeout = setTimeout(() => {
      stdin.removeAllListeners();
      resolve({});
    }, 1000);

    stdin.on('data', (chunk) => { input += chunk; });

    stdin.on('end', () => {
      clearTimeout(timeout);
      let data = {};
      try {
        if (input.trim()) data = JSON.parse(input);
      } catch {
        // Invalid JSON, use empty object
      }
      resolve(data);
    });

    stdin.on('error', () => {
      clearTimeout(timeout);
      resolve({});
    });

    stdin.resume();
  });
}

function processEvent(agent, eventType, rawData, dbPath) {
  try {
    // Load adapter
    let adapter;
    try {
      adapter = require(`./adapters/${agent}`);
    } catch {
      // Fallback generic adapter
      adapter = {
        normalize: (et, data) => ({
          agent,
          session_id: data.session_id || 'unknown',
          event_type: et.toLowerCase(),
          tool_name: data.tool_name,
          model: data.model,
        }),
      };
    }

    // Normalize event using adapter
    const normalized = adapter.normalize(eventType, rawData);

    // Create full event with system fields using event-normalizer
    const { createNormalizedEvent } = require('../collector/event-normalizer');
    const event = createNormalizedEvent(normalized);

    // Store locally in SQLite (dbPath overrides default when running in test mode)
    const { LocalStore } = require('../collector/local-store');
    const store = new LocalStore(dbPath);
    try {
      store.insert(event);

      // Check if we should trigger a background sync.
      // Two conditions (either one triggers sync):
      //   1. Batch threshold: unsynced events >= batchSize (default 100)
      //   2. Time interval:   seconds since last sync >= intervalSeconds (default 300)
      const config = require('../utils/config');
      const cfg = config.load();
      const batchSize = cfg?.sync?.batchSize || 100;
      const intervalSeconds = cfg?.sync?.intervalSeconds || 300;
      const unsyncedCount = store.getUnsyncedCount();

      let shouldSync = false;

      // Condition 1: batch threshold
      if (unsyncedCount >= batchSize) {
        shouldSync = true;
      }

      // Condition 2: time interval (only if there are unsynced events)
      if (!shouldSync && unsyncedCount > 0) {
        const lastSyncAt = store.getMeta('last_sync_at');
        if (lastSyncAt) {
          const elapsed = (Date.now() - new Date(lastSyncAt).getTime()) / 1000;
          if (elapsed >= intervalSeconds) shouldSync = true;
        } else {
          // First run — record start time, wait for interval to elapse
          store.setMeta('last_sync_at', new Date().toISOString());
        }
      }

      if (shouldSync) {
        store.setMeta('last_sync_at', new Date().toISOString());
        store.close();
        // Fire-and-forget sync
        const { Uploader } = require('../collector/uploader');
        const uploader = new Uploader();
        uploader.sync().catch(() => {}).finally(() => process.exit(0));
        return;
      }
    } finally {
      try { store.close(); } catch { /* already closed */ }
    }
  } catch {
    // Never fail — silently exit
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
