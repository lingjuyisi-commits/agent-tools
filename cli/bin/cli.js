#!/usr/bin/env node

const { Command } = require('commander');
const pkg = require('../package.json');

const program = new Command();

program
  .name('agent-tools')
  .description(pkg.description)
  .version(pkg.version);

program
  .command('init')
  .description('First-time setup — configure server URL and create local data directory')
  .option('--server <url>', 'Server URL (skip interactive prompt)')
  .action(async (options) => {
    const { runInit } = require('../src/cli/init');
    await runInit(options);
  });

program
  .command('setup')
  .description('Detect and configure AI coding agents')
  .option('--force', 'Overwrite existing hook configurations', false)
  .option('--agent <name>', 'Only configure a specific agent')
  .action(async (options) => {
    const { runSetup } = require('../src/cli/setup');
    await runSetup(options);
  });

program
  .command('sync')
  .description('Manually upload cached events to the server')
  .action(async () => {
    const { runSync } = require('../src/cli/sync');
    await runSync();
  });

program
  .command('stats')
  .description('Show local usage statistics')
  .option('--period <period>', 'Time period: day, week, or month', 'day')
  .option('--date <date>', 'Date in YYYY-MM-DD format (defaults to today)')
  .action(async (options) => {
    const { runStats } = require('../src/cli/stats');
    await runStats(options);
  });

program
  .command('status')
  .description('Show current configuration and detected agents')
  .action(async () => {
    const config = require('../src/utils/config');
    const chalk = require('chalk');
    const { detectAll } = require('../src/detector');

    const cfg = config.load();
    if (!cfg) {
      console.log(chalk.yellow('Not initialized. Run: agent-tools init'));
      return;
    }

    console.log(chalk.bold('\nConfiguration:'));
    console.log(`  Server URL:   ${cfg.server?.url || 'not set'}`);
    console.log(`  Batch size:   ${cfg.sync?.batchSize || 'default'}`);
    console.log(`  Sync interval: ${cfg.sync?.intervalSeconds || 'default'}s`);
    console.log(`  Initialized:  ${cfg.initTime || 'unknown'}`);

    console.log(chalk.bold('\nDetected Agents:'));
    const agents = detectAll();
    for (const a of agents) {
      const status = a.installed ? chalk.green('installed') : chalk.gray('not found');
      const hooks = a.hooksConfigured ? chalk.green('configured') : chalk.yellow('not configured');
      console.log(`  ${a.name}: ${status}, hooks: ${hooks}`);
    }
    console.log('');
  });

program
  .command('agents')
  .description('List detected AI coding agents')
  .action(async () => {
    const chalk = require('chalk');
    const { detectAll } = require('../src/detector');

    console.log(chalk.bold('\nAgent Detection Results:\n'));
    const agents = detectAll();
    for (const a of agents) {
      const installed = a.installed ? chalk.green('yes') : chalk.red('no');
      const configDir = a.configExists ? chalk.green('yes') : chalk.gray('no');
      const hooks = a.hooksConfigured ? chalk.green('yes') : chalk.yellow('no');
      console.log(`  ${chalk.bold(a.name)}`);
      console.log(`    Installed:        ${installed}`);
      console.log(`    Config exists:    ${configDir}`);
      console.log(`    Hooks configured: ${hooks}`);
      console.log('');
    }
  });

program
  .command('test')
  .description('Test hook collection by running real agent tasks in a temporary environment')
  .option('--agent <name>', 'Agent to test: claude-code, codebuddy (default: all installed)')
  .option('--keep', 'Keep temp directory after test (useful for debugging)', false)
  .option('--timeout <seconds>', 'Seconds to wait per scenario before timing out', '60')
  .action(async (options) => {
    const { runTest } = require('../src/cli/test');
    await runTest({ ...options, timeout: parseInt(options.timeout, 10) });
  });

program.parse();
