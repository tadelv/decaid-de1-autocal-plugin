const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const packageDir = path.join(root, 'auto-flow-cal.reaplugin');
const manifest = JSON.parse(
  fs.readFileSync(path.join(packageDir, 'manifest.json'), 'utf8'),
);

// Mirrors Decaid's loader contract: PluginManifest.fromJson requires every
// field below, and PluginApi.fromJsonList takes a non-nullable list, so a
// manifest without an `api` array throws before the plugin can load.
test('the manifest satisfies the Decaid loader contract', () => {
  for (const field of ['id', 'name', 'author', 'description', 'version']) {
    assert.equal(typeof manifest[field], 'string', field);
    assert.ok(manifest[field].length > 0, field);
  }
  assert.equal(manifest.apiVersion, 1);

  // A missing or null `api` throws in PluginApi.fromJsonList.
  assert.ok(Array.isArray(manifest.api), 'api must be an array');
  assert.ok(Array.isArray(manifest.permissions), 'permissions must be an array');
  assert.ok(manifest.settings && typeof manifest.settings === 'object');
});

test('the manifest id is the package directory name and a safe path component', () => {
  assert.equal(manifest.id, path.basename(packageDir));
  assert.ok(!manifest.id.includes('/') && !manifest.id.includes('\\'));
  assert.notEqual(manifest.id, '.');
  assert.notEqual(manifest.id, '..');
});

test('the manifest requests exactly the permissions the design allows', () => {
  assert.deepEqual([...manifest.permissions].sort(), [
    'api',
    'events.shots',
    'events.workflow',
    'log',
    'pluginStorage',
  ]);
});

test('every setting carries a type, a label and a description', () => {
  const types = ['string', 'number', 'boolean', 'enum'];
  for (const [key, setting] of Object.entries(manifest.settings)) {
    assert.ok(types.includes(setting.type), `${key} type`);
    assert.equal(typeof setting.label, 'string', `${key} label`);
    assert.ok(setting.description.length > 0, `${key} description`);
    if (setting.type === 'enum') {
      assert.ok(Array.isArray(setting.values), `${key} values`);
    }
  }
});
