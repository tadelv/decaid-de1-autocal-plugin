const fs = require('node:fs');
const path = require('node:path');
const { createExperimentalFlowFitter } = require('./experimental-flow-fit');
const root = path.join(__dirname, '..');

function buildPlugin(directory, primaryZeroOnly = false) {
  const source = fs.readFileSync(path.join(root, 'auto-flow-cal.reaplugin/plugin.js'), 'utf8');
  const names = ['finite', 'canonicalize', 'timestampSeconds', 'scaleFromMeasurement', 'dedupeScaleByTimestamp', 'interpolateLinear'];
  const helpers = names.map(name => {
    const match = source.match(new RegExp('  function ' + name + '\\([\\s\\S]*?\\n  }'));
    if (!match) throw new Error(`Missing production helper: ${name}`);
    return match[0];
  }).join('\n');
  const factory = createExperimentalFlowFitter.toString().replace(/(\w+)\.at\(-1\)/g, '$1[$1.length - 1]');
  const plugin = 'function observerHelpers() {\n' + helpers + '\nreturn { canonicalize: canonicalize, timestampSeconds: timestampSeconds, dedupeScaleByTimestamp: dedupeScaleByTimestamp, interpolateLinear: interpolateLinear };\n}\n' +
    factory + '\nvar experimentalFitFlow = createExperimentalFlowFitter(observerHelpers(), ' + JSON.stringify({ primaryZeroOnly }) + ');\n' +
    (directory === 'updater' ? fs.readFileSync(path.join(root, 'updater/ui.js'), 'utf8') + '\n' : '') +
    fs.readFileSync(path.join(root, directory, 'plugin.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, directory, 'manifest.json'), 'utf8'));
  return { manifest, plugin };
}

function buildObserver() { return buildPlugin('observer'); }
module.exports = { buildObserver, buildPlugin };

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
