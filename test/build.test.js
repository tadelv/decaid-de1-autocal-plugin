const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildPlugin } = require('../tools/build-plugin');

// Exercise the actual installable source, not only the in-memory builder.
test('the shipped original-ID package is the current build and matches its manifest', () => {
  const payload = buildPlugin(), directory = path.join(__dirname, '../auto-flow-cal.reaplugin');
  assert.equal(payload.manifest.id, 'auto-flow-cal.reaplugin');
  assert.equal(payload.manifest.name, 'Auto Flow Calibration');
  assert.equal(payload.manifest.version, '2.0.0');
  const source = fs.readFileSync(path.join(directory, 'plugin.js'), 'utf8');
  assert.equal(source, payload.plugin);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'))), payload.manifest);
  assert.ok(!source.includes('auto-flow-cal-updater.reaplugin'));
  const calls = [];
  const runtime = vm.runInNewContext(source + '\ncreatePlugin', { setTimeout, clearTimeout })(
    { log() {}, storage: command => calls.push(command), emit() {} });
  assert.equal(runtime.id, payload.manifest.id);
  assert.equal(runtime.version, payload.manifest.version);
  runtime.onLoad({});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'read');
  assert.equal(calls[0].namespace, payload.manifest.id);
  assert.equal(calls[0].key, 'calibration-v2');
  runtime.onUnload();
});
