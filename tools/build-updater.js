const fs = require('node:fs');
const path = require('node:path');
const { buildPlugin } = require('./build-observer');
function buildUpdater() { return buildPlugin('updater', true); }
module.exports = { buildUpdater };
if (require.main === module) {
  const output = path.resolve(process.argv[2] || path.join(__dirname, '../.pi/updater-build'));
  const payload = buildUpdater(), directory = path.join(output, payload.manifest.id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'plugin.js'), payload.plugin);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(payload.manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'source.json'), JSON.stringify(payload));
  console.log(output);
}
