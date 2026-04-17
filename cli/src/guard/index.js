const os = require('os');

function getImpl() {
  const p = os.platform();
  if (p === 'win32')  return require('./windows');
  if (p === 'darwin') return require('./darwin');
  throw new Error(`platform '${p}' not supported (guard only supports Windows and macOS)`);
}

module.exports = {
  install:   () => getImpl().install(),
  uninstall: () => getImpl().uninstall(),
  status:    () => getImpl().status(),
};
