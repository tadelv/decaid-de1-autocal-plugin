const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { buildBundle } = require('./build-observer');
const root = path.join(__dirname, '..');
function buildPlugin() { return buildBundle('auto-flow-cal.reaplugin', true); }
module.exports = { buildPlugin };
if (require.main === module) {
  const payload = buildPlugin();
  if (process.argv[2] === '--check') {
    assert.equal(fs.readFileSync(path.join(root, payload.manifest.id, 'plugin.js'), 'utf8'), payload.plugin, 'Run npm run build to refresh the installable plugin');
  } else {
    const output = path.resolve(process.argv[2] || root), directory = path.join(output, payload.manifest.id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'plugin.js'), payload.plugin);
    if (output !== root) {
      fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(payload.manifest, null, 2) + '\n');
      fs.writeFileSync(path.join(output, 'source.json'), JSON.stringify(payload));
    }
    console.log(directory);
  }
}
