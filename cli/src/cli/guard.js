const chalk = require('chalk');

async function runGuard(action) {
  if (action === 'run') {
    // Used by the OS autostart wrapper and for manual debugging.
    require('../guard/watcher').main();
    return;
  }

  let guard;
  try {
    guard = require('../guard');
  } catch (err) {
    console.log(chalk.red(`\n  ${err.message}\n`));
    process.exitCode = 1;
    return;
  }

  try {
    if (action === 'install') {
      const r = guard.install();
      console.log(chalk.green('\n  guard installed'));
      Object.entries(r).forEach(([k, v]) => console.log(`    ${k}: ${v}`));
      console.log(chalk.gray('\n  开机登录时自动启动，守护 ~/.claude/settings.json 不被外部工具抹掉。'));
      console.log(chalk.gray('  日志：~/.agent-tools/data/guard-log.json\n'));
    } else if (action === 'uninstall') {
      guard.uninstall();
      console.log(chalk.green('\n  guard uninstalled\n'));
    } else if (action === 'status') {
      const r = guard.status();
      if (r.installed) {
        console.log(chalk.green('\n  guard is installed'));
        Object.entries(r).forEach(([k, v]) => {
          if (k === 'details') return;
          console.log(`    ${k}: ${v}`);
        });
        if (r.details) {
          console.log(chalk.gray('\n  详情:'));
          console.log(r.details.split('\n').map((l) => '    ' + l).join('\n'));
        }
        console.log('');
      } else {
        console.log(chalk.yellow('\n  guard is not installed\n'));
      }
    } else {
      console.log(chalk.red(`未知子命令: ${action}`));
      console.log('用法: agent-tools guard <install|uninstall|status|run>');
      process.exitCode = 1;
    }
  } catch (err) {
    console.log(chalk.red(`\n  失败: ${err.message}\n`));
    process.exitCode = 1;
  }
}

module.exports = { runGuard };
