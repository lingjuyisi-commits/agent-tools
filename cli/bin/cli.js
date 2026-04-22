#!/usr/bin/env node

const { Command } = require('commander');
const pkg = require('../package.json');

const program = new Command();

program
  .name('agent-tools')
  .description(pkg.description)
  .version(pkg.version);

program
  .command('version')
  .description('显示当前 CLI 版本号')
  .action(() => {
    console.log(`agent-tools v${pkg.version}`);
  });

program
  .command('check-update')
  .description('检查 CLI 更新并自动安装')
  .option('--check-only', '仅检查，不安装', false)
  .action(async (options) => {
    const { runCheckUpdate } = require('../src/cli/check-update');
    await runCheckUpdate(options);
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
      console.log(chalk.yellow('未初始化：配置文件 ~/.agent-tools/config.json 不存在。'));
      console.log(chalk.yellow('请从团队 Dashboard 重新下载客户端安装包并重新安装。'));
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

const guardCmd = program
  .command('guard')
  .description('管理 hook 守护进程（防止 cc-switch 等工具抹掉 settings.json 里的钩子）');

guardCmd
  .command('install')
  .description('安装守护进程为用户级开机自启服务')
  .action(async () => {
    const { runGuard } = require('../src/cli/guard');
    await runGuard('install');
  });

guardCmd
  .command('uninstall')
  .description('卸载守护进程的开机自启')
  .action(async () => {
    const { runGuard } = require('../src/cli/guard');
    await runGuard('uninstall');
  });

guardCmd
  .command('status')
  .description('查看守护进程安装状态')
  .action(async () => {
    const { runGuard } = require('../src/cli/guard');
    await runGuard('status');
  });

guardCmd
  .command('run')
  .description('前台运行守护进程（供自启脚本调用或手动调试）')
  .action(async () => {
    const { runGuard } = require('../src/cli/guard');
    await runGuard('run');
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
