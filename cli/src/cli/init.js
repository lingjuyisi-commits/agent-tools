const chalk = require('chalk');
const config = require('../utils/config');

async function runInit(options) {
  console.log(chalk.bold('\nAgent Tools — Initialization\n'));

  let serverUrl = options.server;

  if (!serverUrl) {
    // Dynamic import for inquirer (ESM package used via async import)
    const { default: inquirer } = await import('inquirer');
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'serverUrl',
        message: 'Server URL:',
        default: 'http://localhost:3000',
        validate: (val) => {
          try {
            new URL(val);
            return true;
          } catch {
            return 'Please enter a valid URL';
          }
        },
      },
    ]);
    serverUrl = answers.serverUrl;
  }

  // Test server connection
  console.log(`\nTesting connection to ${serverUrl}...`);
  let serverReachable = false;
  try {
    const response = await fetch(`${serverUrl}/api/v1/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      console.log(chalk.green('  Server is reachable.'));
      serverReachable = true;
    } else {
      console.log(chalk.yellow(`  Server returned status ${response.status}. Saving config anyway.`));
    }
  } catch (err) {
    console.log(chalk.yellow(`  Could not reach server: ${err.message}`));
    console.log(chalk.yellow('  Config will be saved — you can sync later when the server is available.'));
  }

  // Save configuration
  const cfg = {
    server: { url: serverUrl },
    sync: { batchSize: 100, intervalSeconds: 300 },
    initialized: true,
    initTime: new Date().toISOString(),
    serverReachableOnInit: serverReachable,
  };
  config.save(cfg);
  config.ensureDirs();

  console.log(chalk.green(`\nConfig saved to ${config.CONFIG_FILE}`));
  console.log(chalk.green(`Data directory: ${config.DATA_DIR}\n`));

  // Auto-trigger setup
  console.log(chalk.bold('Running agent setup...\n'));
  const { runSetup } = require('./setup');
  await runSetup({});
}

module.exports = { runInit };
