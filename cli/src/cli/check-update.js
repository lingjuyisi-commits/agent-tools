const chalk = require('chalk');
const config = require('../utils/config');
const pkg = require('../../package.json');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function runCheckUpdate(options) {
  // 1. Load config to get server URL
  if (!config.exists()) {
    console.log(chalk.yellow('未初始化。请从团队 Dashboard 重新下载客户端并重新安装。'));
    process.exitCode = 1;
    return;
  }
  const cfg = config.load();
  const serverUrl = cfg?.server?.url || 'http://localhost:3000';

  // 2. Query server for latest client version
  console.log(chalk.bold('\n检查更新...\n'));
  let manifest;
  try {
    const res = await fetch(`${serverUrl}/api/v1/client/version`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`服务器返回 ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    console.log(chalk.red(`  检查更新失败: ${err.message}`));
    process.exitCode = 1;
    return;
  }

  // 3. Compare versions
  const current = pkg.version;
  const latest = manifest.version;

  if (!latest) {
    console.log(chalk.gray('  服务器未返回版本信息。'));
    return;
  }

  if (compareVersions(current, latest) >= 0) {
    console.log(chalk.green(`  已是最新版本 (v${current})。`));
    return;
  }

  console.log(`  当前版本: ${chalk.yellow('v' + current)}`);
  console.log(`  最新版本: ${chalk.green('v' + latest)}`);

  // 4. Auto-update unless --check-only
  if (options.checkOnly) {
    console.log(chalk.gray('\n  运行 "agent-tools check-update" (不加 --check-only) 以安装更新。\n'));
    return;
  }

  console.log(`\n  正在下载 v${latest}...`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-update-'));
  const tgzPath = path.join(tmpDir, `agent-tools-cli-${latest}.tgz`);

  try {
    const dlRes = await fetch(`${serverUrl}/api/v1/client/download`, {
      signal: AbortSignal.timeout(120000),
    });
    if (!dlRes.ok) throw new Error(`下载失败: HTTP ${dlRes.status}`);
    const buffer = Buffer.from(await dlRes.arrayBuffer());
    fs.writeFileSync(tgzPath, buffer);

    console.log('  正在安装...');
    try {
      execSync(`npm install -g --prefer-offline "${tgzPath}"`, { stdio: 'inherit' });
    } catch {
      execSync(`npm install -g "${tgzPath}"`, { stdio: 'inherit' });
    }
    console.log(chalk.green(`\n  ✓ 已成功更新到 v${latest}。\n`));
  } catch (err) {
    console.log(chalk.red(`\n  更新失败: ${err.message}`));
    console.log(chalk.gray(`  可手动下载: ${serverUrl}/api/v1/client/download`));
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

/**
 * Simple semver comparison: returns -1, 0, or 1
 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

module.exports = { runCheckUpdate };
