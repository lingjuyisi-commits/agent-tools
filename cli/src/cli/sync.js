const chalk = require('chalk');
const config = require('../utils/config');

async function runSync() {
  if (!config.exists()) {
    console.log(chalk.yellow('未初始化。请从团队 Dashboard 重新下载客户端并重新安装。'));
    process.exitCode = 1;
    return;
  }

  const { Uploader } = require('../collector/uploader');
  const uploader = new Uploader();

  console.log(chalk.bold('\nSyncing events to server...\n'));

  const result = await uploader.sync();

  if (result.error) {
    console.log(chalk.red(`  Error: ${result.error}`));
    process.exitCode = 1;
  } else if (result.synced === 0) {
    console.log(chalk.gray('  No unsynced events found.'));
  } else {
    console.log(chalk.green(`  Successfully synced ${result.synced} event(s).`));
  }
  console.log('');
}

module.exports = { runSync };
