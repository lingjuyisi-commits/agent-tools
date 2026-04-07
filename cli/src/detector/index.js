const claudeCode = require('./claude-code');
const codebuddy = require('./codebuddy');

const ALL_DETECTORS = [claudeCode, codebuddy];

function detectAll() {
  return ALL_DETECTORS.map(d => ({
    name: d.name,
    installed: d.isInstalled(),
    configExists: d.configExists(),
    hooksConfigured: d.hasAgentToolsHooks(),
  }));
}

function setupAll(options = {}) {
  const results = [];
  for (const d of ALL_DETECTORS) {
    // If a specific agent filter is set, skip others
    if (options.agentFilter && d.name !== options.agentFilter) continue;

    if (d.isInstalled() || d.configExists()) {
      try {
        const result = d.injectHooks(options);
        results.push({ name: d.name, ...result });
      } catch (err) {
        results.push({ name: d.name, success: false, error: err.message });
      }
    }
  }
  return results;
}

module.exports = { detectAll, setupAll, ALL_DETECTORS };
