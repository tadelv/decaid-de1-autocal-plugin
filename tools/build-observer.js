const fs = require('node:fs');
const path = require('node:path');
const { createExperimentalFlowFitter } = require('./experimental-flow-fit');
const { createMeasurementHelpers } = require('../src/measurement-helpers');
const root = path.join(__dirname, '..');

function buildBundle(directory, primaryZeroOnly = false) {
  const production = directory === 'auto-flow-cal.reaplugin';
  const manifest = JSON.parse(fs.readFileSync(path.join(root, directory, 'manifest.json'), 'utf8'));
  const factory = createExperimentalFlowFitter.toString().replace(/(\w+)\.at\(-1\)/g, '$1[$1.length - 1]');
  const plugin = (production ? 'var FLOW_CAL_METADATA = ' + JSON.stringify({ id: manifest.id, version: manifest.version }) + ';\n' : '') +
    createMeasurementHelpers.toString() + '\n' + factory + '\n' +
    'var experimentalFitFlow = createExperimentalFlowFitter(createMeasurementHelpers(), ' + JSON.stringify({ primaryZeroOnly }) + ');\n' +
    (production ? fs.readFileSync(path.join(root, 'src/ui.js'), 'utf8') + '\n' : '') +
    fs.readFileSync(path.join(root, production ? 'src/plugin.js' : directory + '/plugin.js'), 'utf8');
  return { manifest, plugin };
}

function buildObserver() { return buildBundle('observer'); }
module.exports = { buildObserver, buildBundle };

if (require.main === module) {
  const output = path.resolve(process.argv[2] || path.join(root, '.pi/observer-build'));
  const payload = buildObserver();
  const dir = path.join(output, payload.manifest.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.js'), payload.plugin);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(payload.manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'source.json'), JSON.stringify(payload));
  console.log(output);
}
