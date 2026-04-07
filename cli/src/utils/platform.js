const os = require('os');
const { execSync } = require('child_process');

function isWindows() {
  return os.platform() === 'win32';
}

function isMac() {
  return os.platform() === 'darwin';
}

function isLinux() {
  return os.platform() === 'linux';
}

function whichCommand(name) {
  try {
    const cmd = isWindows() ? `where ${name}` : `which ${name}`;
    const result = execSync(cmd, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 });
    return result.toString().trim().split('\n')[0];
  } catch {
    return null;
  }
}

function getUserInfo() {
  return {
    username: os.userInfo().username,
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
  };
}

module.exports = { isWindows, isMac, isLinux, whichCommand, getUserInfo };
