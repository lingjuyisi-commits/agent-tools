const chalk = require('chalk');
const config = require('../utils/config');

async function runStats(options) {
  if (!config.exists()) {
    console.log(chalk.yellow('Not initialized. Run: agent-tools init'));
    process.exitCode = 1;
    return;
  }

  const { LocalStore } = require('../collector/local-store');

  const period = options.period || 'day';
  const baseDate = options.date ? new Date(options.date + 'T00:00:00') : new Date();

  // Calculate date range
  let dateFrom, dateTo;
  if (period === 'day') {
    dateFrom = new Date(baseDate);
    dateFrom.setHours(0, 0, 0, 0);
    dateTo = new Date(dateFrom);
    dateTo.setDate(dateTo.getDate() + 1);
  } else if (period === 'week') {
    dateFrom = new Date(baseDate);
    dateFrom.setHours(0, 0, 0, 0);
    dateFrom.setDate(dateFrom.getDate() - dateFrom.getDay()); // start of week (Sunday)
    dateTo = new Date(dateFrom);
    dateTo.setDate(dateTo.getDate() + 7);
  } else if (period === 'month') {
    dateFrom = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
    dateTo = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 1);
  } else {
    console.log(chalk.red(`Invalid period: ${period}. Use day, week, or month.`));
    process.exitCode = 1;
    return;
  }

  const fromStr = dateFrom.toISOString();
  const toStr = dateTo.toISOString();

  let store;
  try {
    store = new LocalStore();
    const stats = store.getLocalStats(fromStr, toStr);
    const unsyncedCount = store.getUnsyncedCount();

    const periodLabel = period === 'day'
      ? dateFrom.toISOString().split('T')[0]
      : period === 'week'
        ? `week of ${dateFrom.toISOString().split('T')[0]}`
        : `${dateFrom.toISOString().split('T')[0].substring(0, 7)}`;

    console.log(chalk.bold(`\nLocal Stats — ${periodLabel}\n`));

    if (stats.length === 0) {
      console.log(chalk.gray('  No events recorded for this period.\n'));
    } else {
      // Group by agent
      const byAgent = {};
      for (const row of stats) {
        const agent = row.agent || 'unknown';
        if (!byAgent[agent]) byAgent[agent] = [];
        byAgent[agent].push({ event_type: row.event_type, count: row.count });
      }

      for (const [agent, events] of Object.entries(byAgent)) {
        console.log(chalk.bold(`  ${agent}:`));
        const total = events.reduce((sum, e) => sum + e.count, 0);
        for (const e of events) {
          console.log(`    ${e.event_type.padEnd(20)} ${String(e.count).padStart(6)}`);
        }
        console.log(chalk.dim(`    ${'total'.padEnd(20)} ${String(total).padStart(6)}`));
        console.log('');
      }
    }

    console.log(chalk.dim(`  Unsynced events: ${unsyncedCount}\n`));
  } catch (err) {
    console.log(chalk.red(`Error reading local database: ${err.message}`));
    process.exitCode = 1;
  } finally {
    if (store) store.close();
  }
}

module.exports = { runStats };
