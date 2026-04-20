const fs = require('fs');
const chalk = require('chalk');
const config = require('../utils/config');
const { detectAll, setupAll } = require('../detector');
const ccSwitch = require('../detector/cc-switch');
const claudeCode = require('../detector/claude-code');

async function runSetup(options) {
  if (!config.exists()) {
    console.log(chalk.yellow('Not initialized. Run: agent-tools init'));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.bold('Detecting installed agents...\n'));

  const detected = detectAll();
  for (const agent of detected) {
    const status = agent.installed ? chalk.green('installed') : chalk.gray('not found');
    const configStatus = agent.configExists ? chalk.green('config dir exists') : chalk.gray('no config dir');
    console.log(`  ${agent.name}: ${status}, ${configStatus}`);
  }

  const anyFound = detected.some(a => a.installed || a.configExists);
  if (!anyFound) {
    console.log(chalk.yellow('\nNo supported agents detected. Hooks were not configured.'));
    console.log('Supported agents: Claude Code, CodeBuddy\n');
    return;
  }

  console.log(chalk.bold('\nConfiguring hooks...\n'));

  const setupOptions = {
    force: options.force || false,
    agentFilter: options.agent || null,
  };

  const results = setupAll(setupOptions);
  for (const r of results) {
    if (setupOptions.agentFilter && r.name !== setupOptions.agentFilter) continue;
    if (r.success) {
      console.log(chalk.green(`  ${r.name}: hooks configured -> ${r.configFile}`));
    } else {
      console.log(chalk.red(`  ${r.name}: failed — ${r.error || 'unknown error'}`));
    }
  }

  // Inject hooks into cc-switch Common Config if installed
  const ccSwitchInfo = ccSwitch.detect();
  if (ccSwitchInfo.installed) {
    console.log(chalk.bold('\nConfiguring cc-switch common config...\n'));
    let hooks = {};
    try {
      const settings = JSON.parse(fs.readFileSync(claudeCode.SETTINGS_FILE, 'utf-8'));
      hooks = settings.hooks || {};
    } catch {}
    const r = ccSwitch.injectCommonConfig(hooks);
    if (r.success) {
      console.log(chalk.green(`  cc-switch: common config + all providers updated -> ${r.dbPath}`));
    } else {
      console.log(chalk.yellow(`  cc-switch: skipped — ${r.error}`));
    }
  }

  console.log(chalk.bold('\nSetup complete.\n'));
}

module.exports = { runSetup };
