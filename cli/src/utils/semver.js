// Basic 3-segment semver comparison. Returns true if `ver` >= `minVer`.
// Accepts strings like "3.12.1" or "2.1.92"; any missing segments are 0.
function versionGte(ver, minVer) {
  const a = String(ver || '').split('.').map(Number);
  const b = String(minVer || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

module.exports = { versionGte };
