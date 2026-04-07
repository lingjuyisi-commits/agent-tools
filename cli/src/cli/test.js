/**
 * agent-tools test --agent <name>
 *
 * End-to-end hook collection test.  Spawns the real agent CLI with a
 * temporary settings file whose hooks write to an isolated SQLite database,
 * then verifies that every expected event type was captured.
 *
 * Isolation guarantees:
 *   - Temp dir under /tmp — never touches the user's working directory.
 *   - Separate test DB — production ~/.agent-tools/data/local.db is untouched.
 *   - Test hooks are injected into user-level settings, both test and production
 *     hooks fire but only the test DB is inspected.
 *   - Test hooks are synchronous (no async:true) so all writes are done when
 *     the agent process exits.
 *
 * Hook format note:
 *   Claude Code ≥ 2.1.x requires hooks in the nested format:
 *     { matcher: "", hooks: [{ type: "command", command: "..." }] }
 *   The old flat format { type, command } silently fails schema validation and
 *   causes ALL user settings to be dropped (settings = null), so hooks never fire.
 */

'use strict';

const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { execFileSync, spawnSync } = require('child_process');
const chalk   = require('chalk');
const Database = require('better-sqlite3');

const HOOK_SCRIPT = path.resolve(__dirname, '../hooks/universal-hook.js');

// ─────────────────────────────────────────────────────────────────────────────
// Agent definitions
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_DEFS = {
  'claude-code': {
    displayName  : 'Claude Code',
    bin          : 'claude',
    hookEvents   : ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'],
    userSettings : path.join(os.homedir(), '.claude', 'settings.json'),
    // Skills must be placed in the user-level commands dir (~/.claude/commands/) because:
    //   • --plugin-dir does not load markdown skills in -p mode
    //   • Project-level .claude/skills/ is ignored in -p mode without workspace trust
    //   • ~/.claude/skills/ is not the actual commands path (despite debug log saying so)
    userSkillsDir: path.join(os.homedir(), '.claude', 'commands'),
    buildArgv(workDir, prompt) {
      return ['--dangerously-skip-permissions', '-p', prompt];
    },
    scenarios: [
      {
        name     : 'Basic tool use & session lifecycle',
        prompt   : 'Write the text "hello agent-tools test" to a file named greet.txt',
        useSkill : false,
        checks: [
          {
            label : 'session_start event captured',
            fn    : evts => evts.some(e => e.event_type === 'session_start'),
          },
          {
            label : 'user_message event captured (UserPromptSubmit)',
            fn    : evts => evts.some(e => e.event_type === 'user_message'),
          },
          {
            label : 'tool_pre event captured (PreToolUse)',
            fn    : evts => evts.some(e => e.event_type === 'tool_pre'),
          },
          {
            label : 'tool_use event captured (PostToolUse)',
            fn    : evts => evts.some(e => e.event_type === 'tool_use'),
          },
          {
            label : 'tool_name field populated on tool_use',
            fn    : evts => evts.some(e => e.event_type === 'tool_use' && e.tool_name),
          },
          {
            label : 'session_id populated on all events',
            fn    : evts => evts.length > 0 && evts.every(e => e.session_id && e.session_id !== 'unknown'),
          },
          {
            label : 'session end or stop event captured',
            fn    : evts => evts.some(e =>
                              e.event_type === 'assistant_stop' ||
                              e.event_type === 'session_end'),
          },
        ],
      },
      {
        name     : 'Skill invocation via /skill-name',
        prompt   : '/agent-tools-test-verify',
        useSkill : true,
        skillName: 'agent-tools-test-verify',
        skillBody: 'List the files in the current directory using the Bash tool.\n',
        checks: [
          {
            label : 'skill_use event captured',
            fn    : evts => evts.some(e => e.event_type === 'skill_use'),
          },
          {
            label : 'skill_name = "agent-tools-test-verify"',
            fn    : evts => evts.some(e =>
                              e.event_type === 'skill_use' &&
                              e.skill_name === 'agent-tools-test-verify'),
          },
        ],
      },
    ],
  },

  'codebuddy': {
    displayName  : 'CodeBuddy',
    bin          : 'codebuddy',
    hookEvents   : ['PreToolUse', 'PostToolUse'],
    userSettings : path.join(os.homedir(), '.codebuddy', 'settings.json'),
    buildArgv(workDir, prompt) {
      return ['--dangerously-skip-permissions', '-p', prompt];
    },
    scenarios: [
      {
        name      : 'Basic tool use',
        prompt    : 'Write the text "hello agent-tools test" to a file named greet.txt',
        usePlugin : false,
        checks: [
          {
            label : 'tool_pre event captured (PreToolUse)',
            fn    : evts => evts.some(e => e.event_type === 'tool_pre'),
          },
          {
            label : 'tool_use event captured (PostToolUse)',
            fn    : evts => evts.some(e => e.event_type === 'tool_use'),
          },
          {
            label : 'tool_name field populated on tool_use',
            fn    : evts => evts.some(e => e.event_type === 'tool_use' && e.tool_name),
          },
        ],
      },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Check whether a binary exists in PATH */
function binExists(name) {
  try {
    const cmd = os.platform() === 'win32' ? 'where' : 'which';
    execFileSync(cmd, [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Read all events from the test DB */
function readTestEvents(dbPath) {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT data FROM local_events ORDER BY id').all();
    return rows.map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
  } finally {
    db.close();
  }
}

/** Delete all rows from the test DB (between scenarios) */
function clearTestDb(dbPath) {
  if (!fs.existsSync(dbPath)) return;
  const db = new Database(dbPath);
  try { db.exec('DELETE FROM local_events'); } finally { db.close(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress printer
// ─────────────────────────────────────────────────────────────────────────────

let spinFrame = 0;
const SPIN_CHARS = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

function printRunning(msg) {
  const s = chalk.yellow(SPIN_CHARS[spinFrame++ % SPIN_CHARS.length]);
  process.stdout.write(`\r  ${s} ${msg}   `);
}

function printDone(msg, elapsed) {
  process.stdout.clearLine?.(0);
  process.stdout.cursorTo?.(0);
  console.log(`  ${chalk.green('✓')} ${msg}  ${chalk.dim(`(${(elapsed / 1000).toFixed(1)}s)`)}`);
}

function printFail(msg, reason) {
  process.stdout.clearLine?.(0);
  process.stdout.cursorTo?.(0);
  console.log(`  ${chalk.red('✗')} ${msg}`);
  if (reason) console.log(`    ${chalk.dim(reason)}`);
}

function printCheck(label, passed) {
  const icon = passed ? chalk.green('    ✓') : chalk.red('    ✗');
  console.log(`${icon} ${label}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inject test hooks into the agent's user-level settings file.
 * Returns the original settings content so it can be restored.
 * Uses a MARKER comment key to identify test-injected entries.
 */
const TEST_MARKER = '__agent_tools_test__';

function injectTestHooks(settingsPath, agentKey, hookEvents, testDbPath) {
  let settings = {};
  let originalContent = null;
  if (fs.existsSync(settingsPath)) {
    originalContent = fs.readFileSync(settingsPath, 'utf-8');
    try { settings = JSON.parse(originalContent); } catch { settings = {}; }
  }

  if (!settings.hooks) settings.hooks = {};

  for (const event of hookEvents) {
    // Claude Code ≥ 2.1.x requires new nested format: {matcher, hooks:[{type,command}]}
    // Old flat format silently fails schema validation and the entire userSettings file
    // is dropped, so hooks never fire.
    const testEntry = {
      [TEST_MARKER]: true,
      matcher: '',
      hooks: [{
        type   : 'command',
        // Synchronous hook — agent waits, guaranteeing DB write before process exits
        command: `node "${HOOK_SCRIPT}" --agent=${agentKey} --event=${event} --db="${testDbPath}"`,
      }],
    };
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [testEntry];
    } else {
      // Migrate any old-format entries inline (needed if production hooks are still old format)
      settings.hooks[event] = settings.hooks[event].map((h) => {
        if (h.command && !h.hooks) {
          const inner = { type: 'command', command: h.command };
          if (h.async !== undefined) inner.async = h.async;
          return { matcher: h.matcher ?? '', hooks: [inner] };
        }
        return h;
      });
      // Remove any stale test entries, then append ours
      settings.hooks[event] = settings.hooks[event].filter(h => !h[TEST_MARKER]);
      settings.hooks[event].push(testEntry);
    }
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return originalContent; // null means file didn't exist before
}

/** Remove test hooks from the settings file and restore original content */
function restoreSettings(settingsPath, originalContent) {
  try {
    if (originalContent === null) {
      // File didn't exist before — delete it if it's now empty/only test data
      fs.unlinkSync(settingsPath);
    } else {
      fs.writeFileSync(settingsPath, originalContent);
    }
  } catch { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────────────────────

async function runTest(options) {
  const { agent: agentFilter, keep = false, timeout: timeoutSec = 60 } = options;

  const agentKeys = agentFilter ? [agentFilter] : Object.keys(AGENT_DEFS);

  let globalPass = 0;
  let globalFail = 0;

  for (const agentKey of agentKeys) {
    const def = AGENT_DEFS[agentKey];
    if (!def) {
      console.log(chalk.red(`\nUnknown agent: "${agentKey}". Supported: ${Object.keys(AGENT_DEFS).join(', ')}`));
      process.exitCode = 1;
      return;
    }

    console.log(chalk.bold(`\n${'─'.repeat(60)}`));
    console.log(chalk.bold(`Testing ${def.displayName} hook collection`));
    console.log(chalk.bold(`${'─'.repeat(60)}\n`));

    if (!binExists(def.bin)) {
      console.log(chalk.yellow(`  ${def.bin} not found in PATH — skipping.\n`));
      continue;
    }

    // ── Temp environment ──────────────────────────────────────────────────────
    const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), `agent-tools-test-`));
    const testDbPath = path.join(tmpDir, 'test.db');
    const workDir    = path.join(tmpDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });

    console.log(chalk.dim(`  Temp dir : ${tmpDir}`));
    console.log(chalk.dim(`  Test DB  : ${testDbPath}`));
    console.log(chalk.dim(`  Settings : ${def.userSettings}\n`));

    // ── Inject test hooks into user-level settings ────────────────────────────
    let originalSettings = null;
    try {
      originalSettings = injectTestHooks(def.userSettings, agentKey, def.hookEvents, testDbPath);
      console.log(`  ${chalk.green('✓')} Test hooks injected into ${path.basename(def.userSettings)} (${def.hookEvents.length} events)`);
    } catch (err) {
      console.log(chalk.red(`  ✗ Failed to inject test hooks: ${err.message}`));
      continue;
    }

    console.log('');

    // ── Run scenarios ─────────────────────────────────────────────────────────
    let agentPass = 0;
    let agentFail = 0;
    const totalScenarios = def.scenarios.length;

    try {
      for (let si = 0; si < totalScenarios; si++) {
        const scenario = def.scenarios[si];
        const label    = `[${si + 1}/${totalScenarios}] ${scenario.name}`;

        clearTestDb(testDbPath);

        // ── Create/remove temporary user-level skill for skill scenarios ─────────
        let skillFilePath = null;
        if (scenario.useSkill && def.userSkillsDir && scenario.skillName) {
          fs.mkdirSync(def.userSkillsDir, { recursive: true });
          skillFilePath = path.join(def.userSkillsDir, `${scenario.skillName}.md`);
          fs.writeFileSync(skillFilePath, scenario.skillBody || 'List the files in the current directory.\n');
        }

        const argv = def.buildArgv(workDir, scenario.prompt);

        const t0 = Date.now();
        const spinInterval = setInterval(() => printRunning(label), 150);

        let agentOk    = true;
        let agentErrMsg = '';
        try {
          spawnSync(def.bin, argv, {
            cwd     : workDir,
            timeout : timeoutSec * 1000,
            stdio   : 'pipe',
            encoding: 'utf-8',
          });
        } catch (err) {
          agentOk     = false;
          agentErrMsg = err.message;
        }

        clearInterval(spinInterval);
        const elapsed = Date.now() - t0;

        // ── Remove temp skill file ──────────────────────────────────────────────
        if (skillFilePath) try { fs.unlinkSync(skillFilePath); } catch { /* ignore */ }

        if (!agentOk) {
          printFail(label, `Agent error: ${agentErrMsg}`);
          agentFail  += scenario.checks.length;
          globalFail += scenario.checks.length;
          continue;
        }

        printDone(label, elapsed);

        // ── Verify ─────────────────────────────────────────────────────────────
        const events = readTestEvents(testDbPath);

        if (events.length === 0) {
          console.log(chalk.yellow(`    ⚠ No events in test DB — hooks may not have fired.`));
          console.log(chalk.dim(`      Check: ${def.userSettings}`));
        }

        for (const check of scenario.checks) {
          let passed = false;
          try { passed = check.fn(events); } catch { /* treat as fail */ }
          printCheck(check.label, passed);
          if (passed) { agentPass++; globalPass++; }
          else         { agentFail++; globalFail++; }
        }

        if (events.length > 0) {
          const types = [...new Set(events.map(e => e.event_type))].join(', ');
          console.log(chalk.dim(`    Captured: ${events.length} event(s) — [${types}]`));
        }
        console.log('');
      }
    } finally {
      // ── Always restore user settings ────────────────────────────────────────
      restoreSettings(def.userSettings, originalSettings);
      console.log(chalk.dim(`  ${path.basename(def.userSettings)} restored.`));
    }

    // ── Agent summary ─────────────────────────────────────────────────────────
    const total   = agentPass + agentFail;
    const summary = `${agentPass}/${total} checks passed`;
    if (agentFail === 0) {
      console.log(chalk.green(`  ✓ ${def.displayName}: ${summary}`));
    } else {
      console.log(chalk.red(`  ✗ ${def.displayName}: ${summary} (${agentFail} failed)`));
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────
    if (keep) {
      console.log(chalk.dim(`  Temp dir kept: ${tmpDir}`));
    } else {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      console.log(chalk.dim('  Temp directory removed.'));
    }
  }

  // ── Global summary ────────────────────────────────────────────────────────
  const totalChecks = globalPass + globalFail;
  console.log(`\n${'─'.repeat(60)}`);
  if (globalFail === 0) {
    console.log(chalk.green(`All ${totalChecks} checks passed — hooks are collecting data correctly.`));
  } else {
    console.log(chalk.red(`${globalFail}/${totalChecks} checks failed.`));
    console.log(chalk.dim('Run with --keep to inspect the temp directory and test DB.'));
    process.exitCode = 1;
  }
  console.log('');
}

module.exports = { runTest };
