const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const packageDir = path.join(root, 'auto-flow-cal.reaplugin');
const pluginSource = fs.readFileSync(path.join(packageDir, 'plugin.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'manifest.json'), 'utf8'));

// Decaid serializes timestamps as ISO-8601 strings. Epoch-zero offsets keep the
// synthetic seconds used by the fixtures exactly representable.
function iso(seconds) {
  return new Date(Math.round(seconds * 1000)).toISOString();
}

// MachineSnapshot.toJson()-shaped snapshot with the nested state object.
function machineSnapshot(timestamp, state, flow, pressure) {
  return {
    timestamp,
    state,
    flow,
    pressure,
    targetFlow: flow,
    targetPressure: pressure,
    mixTemperature: 92,
    groupTemperature: 93,
    targetMixTemperature: 93,
    targetGroupTemperature: 93,
    profileFrame: 0,
    steamTemperature: 0,
  };
}

function loadPlugin(host, fetch) {
  const context = { fetch, setTimeout, clearTimeout };
  vm.createContext(context);
  vm.runInContext(`${pluginSource}\nthis.createPlugin = createPlugin;`, context);
  return context.createPlugin(host);
}

function response(body, status = 200) {
  return { status, ok: status < 400, json: async () => body };
}

function stableShot(id, profile, serial = '12345', desired = 0.9, oldMultiplier = 0.8, options = {}) {
  const times = Array.from({ length: 9 }, (_, i) => i * 0.5);
  const workflow = {
    profile,
    machine: {
      provenanceStatus: options.provenanceStatus || 'captured',
      model: options.model || 'DE1Pro',
      serialNumber: options.serial || serial,
      flowCalibration: options.flowCalibration === undefined ? oldMultiplier : options.flowCalibration,
    },
  };
  const measurements = times.map(t => ({
    machine: machineSnapshot(
      iso(t),
      { state: 'espresso', substate: 'pouring' },
      oldMultiplier * (options.noFlat ? 2 + 0.5 * t : 2),
      9,
    ),
    scale: { timestamp: iso(t), weight: 5 + desired * 2 * t, weightFlow: desired * 2 },
    volume: null,
  }));
  if (options.noScale) for (const measurement of measurements) delete measurement.scale;
  if (options.oneScale) {
    for (let i = 1; i < measurements.length; i++) delete measurements[i].scale;
  }
  return { id, workflow, measurements };
}

function createHarness({
  current = 0.8,
  machine = { model: 'DE1Pro', serialNumber: '12345' },
  stored,
  settings,
  history = [],
  fullShots = [],
  fetchHook,
} = {}) {
  const calls = [];
  const logs = [];
  let calibration = current;
  let storageValue = stored;
  const storageWrites = [];
  let plugin;
  const host = {
    log(message) { logs.push(message); },
    storage(command) {
      calls.push({ type: 'storage', command });
      if (command.type === 'write') {
        storageValue = command.data;
        storageWrites.push(command.data);
      }
      return Promise.resolve();
    },
  };

  const fetch = async (url, options = {}) => {
    calls.push({ type: 'fetch', url, options });
    if (fetchHook) {
      const custom = await fetchHook({ url, options, calls, get calibration() { return calibration; }, set calibration(value) { calibration = value; } });
      if (custom) return custom;
    }
    const parsed = new URL(url);
    const requestPath = parsed.pathname;
    if (requestPath === '/api/v1/machine/info') {
      return response({ version: 'v1.1.0', GHC: true, extra: {}, ...machine });
    }
    if (requestPath === '/api/v1/machine/calibration') {
      if (options.method === 'POST') {
        calibration = JSON.parse(options.body).flowMultiplier;
        return response({ ok: true });
      }
      return response({ flowMultiplier: calibration });
    }
    if (requestPath === '/api/v1/machine/state') {
      return response(machineSnapshot(iso(0), { state: 'idle', substate: 'idle' }, 0, 0));
    }
    if (requestPath === '/api/v1/shots') {
      if (parsed.searchParams.has('ids')) return response(fullShots);
      return response({ items: history, total: history.length, limit: 2, offset: 0 });
    }
    throw new Error(`unexpected request ${url}`);
  };

  plugin = loadPlugin(host, fetch);

  return {
    plugin,
    calls,
    logs,
    get calibration() { return calibration; },
    get storageValue() { return storageValue; },
    storageWrites,
    async start(pluginSettings = settings) {
      await plugin.onLoad(pluginSettings);
      await plugin.onEvent({ name: 'storageRead', payload: { key: 'state', value: storageValue } });
    },
    async workflow(profile) {
      await plugin.onEvent({ name: 'workflowUpdated', payload: { profile } });
    },
    async event(name, payload) {
      await plugin.onEvent({ name, payload });
    },
    fetchCalls() { return calls.filter(call => call.type === 'fetch'); },
    historyCalls() { return this.fetchCalls().filter(call => new URL(call.url).pathname === '/api/v1/shots' && !new URL(call.url).searchParams.has('ids')); },
    fullShotCalls() { return this.fetchCalls().filter(call => new URL(call.url).pathname === '/api/v1/shots' && new URL(call.url).searchParams.has('ids')); },
    postCalls() { return this.fetchCalls().filter(call => call.options.method === 'POST'); },
  };
}

async function validRun(options = {}) {
  const profile = options.profile || { title: 'Profile', notes: 'same' };
  const shot1 = options.shot1 || stableShot('a', profile, '12345', options.desired1 || 0.9, options.old1 || 0.8, options.shotOptions1);
  const shot2 = options.shot2 || stableShot('b', profile, '12345', options.desired2 || options.desired1 || 0.9, options.old2 || 0.8, options.shotOptions2);
  const harness = createHarness({
    current: options.current === undefined ? 0.8 : options.current,
    machine: options.machine,
    stored: options.stored,
    settings: options.settings,
    history: [
      { id: shot1.id, workflow: shot1.workflow },
      { id: shot2.id, workflow: shot2.workflow },
    ],
    fullShots: [shot1, shot2],
    fetchHook: options.fetchHook,
  });
  await harness.start(options.settings);
  await harness.workflow(profile);
  return harness;
}

test('package, manifest, and runtime plugin IDs are consistent', () => {
  const packageName = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name;
  assert.equal(path.basename(packageDir), manifest.id);
  assert.equal(manifest.id, packageName);
  const host = { log() {}, storage() { return Promise.resolve(); } };
  const plugin = loadPlugin(host, async () => response({}));
  assert.equal(plugin.id, manifest.id);
});

test('manifest requests exactly the design permissions', () => {
  assert.deepEqual(manifest.permissions, ['log', 'api', 'pluginStorage', 'events.workflow', 'events.shots']);
});

test('explicit DE1 allowlist accepts every traditional model and rejects others', () => {
  for (const model of ['DE1', 'DE1Plus', 'DE1Pro', 'DE1XL', 'DE1Cafe', 'DE1XXL', 'DE1XXXL']) {
    assert.equal(loadPlugin({ log() {}, storage() {} }, async () => response({})).__test.isEligibleDE1({ model, serialNumber: 's' }), 's');
  }
  for (const model of ['Unknown', 'Bengle', 'DE1Future', 'DE10']) {
    assert.equal(loadPlugin({ log() {}, storage() {} }, async () => response({})).__test.isEligibleDE1({ model, serialNumber: 's' }), null);
  }
});

test('ineligible or unidentified machines never request history', async () => {
  for (const machine of [
    { model: 'Unknown', serialNumber: 's' },
    { model: 'Bengle', serialNumber: 's' },
    { model: 'FutureMachine', serialNumber: 's' },
    { model: 'DE1Pro', serialNumber: '0' },
  ]) {
    const harness = createHarness({ machine, history: [] });
    await harness.start();
    await harness.workflow({ title: 'Profile' });
    assert.equal(harness.historyCalls().length, 0, machine.model);
  }
});

test('every allowlisted DE1 model drives a real evaluation through to the history request', async () => {
  for (const model of ['DE1', 'DE1Plus', 'DE1Pro', 'DE1XL', 'DE1Cafe', 'DE1XXL', 'DE1XXXL']) {
    const harness = await validRun({
      machine: { model, serialNumber: '12345' },
      shotOptions1: { model },
      shotOptions2: { model },
    });
    assert.equal(harness.historyCalls().length, 1, model);
    assert.equal(harness.fullShotCalls().length, 1, model);
    assert.equal(harness.postCalls().length, 1, model);
  }
});

test('history access is exactly two filtered descending records with no fallback or pagination', async () => {
  const profile = { title: 'A profile' };
  const harness = await validRun({ profile });
  const request = harness.historyCalls()[0];
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('profileTitle'), 'A profile');
  assert.equal(url.searchParams.get('limit'), '2');
  assert.equal(url.searchParams.get('offset'), '0');
  assert.equal(url.searchParams.get('order'), 'desc');
  assert.equal(harness.historyCalls().length, 1);
  assert.equal(harness.fullShotCalls().length, 1);
  assert.equal(new URL(harness.fullShotCalls()[0].url).searchParams.has('profileTitle'), false);
  assert.deepEqual(new URL(harness.fullShotCalls()[0].url).searchParams.getAll('ids'), ['a', 'b']);
});

test('the real {items} history envelope reaches full-shot fetch, and non-array items fail closed', async () => {
  const applied = await validRun({ desired1: 0.9, current: 0.8 });
  assert.equal(applied.historyCalls().length, 1);
  assert.equal(applied.fullShotCalls().length, 1);
  assert.equal(applied.postCalls().length, 1);
  assert.match(applied.logs.at(-1), /action=apply/);

  const profile = { title: 'Profile', notes: 'same' };
  const bare = await validRun({
    profile,
    fetchHook: ({ url }) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v1/shots' && !parsed.searchParams.has('ids')) {
        const shot1 = stableShot('a', profile);
        const shot2 = stableShot('b', profile);
        return response([
          { id: shot1.id, workflow: shot1.workflow },
          { id: shot2.id, workflow: shot2.workflow },
        ]);
      }
    },
  });
  assert.equal(bare.fullShotCalls().length, 1);
  assert.equal(bare.postCalls().length, 1);

  for (const items of [undefined, 'nope', { nested: true }]) {
    const broken = await validRun({
      fetchHook: ({ url }) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/api/v1/shots' && !parsed.searchParams.has('ids')) {
          return response({ items, total: 0, limit: 2, offset: 0 });
        }
      },
    });
    assert.equal(broken.fullShotCalls().length, 0, String(items));
    assert.equal(broken.postCalls().length, 0, String(items));
    assert.match(broken.logs.at(-1), /reason=history_fetch_failed/, String(items));
  }
});

test('history and metadata failures stop before full-shot fetch or POST', async () => {
  const profile = { title: 'Profile', notes: 'current' };
  const cases = [
    ['one history item', { history: [{ id: 'a', workflow: stableShot('a', profile).workflow }] }, 'insufficient_history'],
    ['different exact profile', { profile, shot1: stableShot('a', { title: 'Profile', notes: 'old' }), shot2: stableShot('b', profile) }, 'profile_mismatch'],
    ['different serial', { shotOptions1: { serial: 'other' } }, 'different_machine'],
    ['uncaptured provenance', { shotOptions1: { provenanceStatus: 'inferred' } }, 'uncaptured_machine_provenance'],
    ['missing historical multiplier', { shotOptions1: { flowCalibration: null } }, 'missing_historical_multiplier'],
  ];
  for (const [name, options, reason] of cases) {
    const harness = options.history ? createHarness({ history: options.history }) : await validRun({ ...options, profile });
    if (options.history) {
      await harness.start();
      await harness.workflow(profile);
    }
    assert.equal(harness.fullShotCalls().length, 0, name);
    assert.equal(harness.postCalls().length, 0, name);
    assert.match(harness.logs.at(-1), new RegExp(`reason=${reason}`), name);
    // No fallback search: one bounded list request, never a retry with a
    // larger limit, a different query or an unfiltered sweep.
    assert.equal(harness.historyCalls().length, 1, name);
    const url = new URL(harness.historyCalls()[0].url);
    assert.equal(url.searchParams.get('limit'), '2', name);
    assert.equal(url.searchParams.get('offset'), '0', name);
    assert.equal(url.searchParams.get('order'), 'desc', name);
    assert.equal(url.searchParams.get('profileTitle'), profile.title, name);
  }
});

test('an unusable newest record never triggers a search for an older shot', async () => {
  const profile = { title: 'Profile', notes: 'current' };
  const scrap = stableShot('scrap', profile, '12345', 0.9, 0.8, { noScale: true });
  const good = stableShot('good', profile);
  const harness = createHarness({
    history: [
      { id: scrap.id, workflow: scrap.workflow },
      { id: good.id, workflow: good.workflow },
    ],
    fullShots: [scrap, good],
  });
  await harness.start();
  await harness.workflow(profile);
  assert.equal(harness.postCalls().length, 0);
  assert.match(harness.logs.at(-1), /reason=no_scale_data/);
  assert.equal(harness.historyCalls().length, 1, 'no shot #3 lookup');
  assert.deepEqual(new URL(harness.fullShotCalls()[0].url).searchParams.getAll('ids'), ['scrap', 'good']);
});

test('valid agreeing shots apply an estimate with no scale-independent shortcut', async () => {
  const harness = await validRun({ desired1: 0.9, current: 0.8 });
  assert.equal(harness.postCalls().length, 1);
  assert.equal(JSON.parse(harness.postCalls()[0].options.body).flowMultiplier, 0.85);
  assert.match(harness.logs.at(-1), /action=apply/);
});

test('disagreeing shots do not write', async () => {
  const harness = await validRun({ desired1: 0.9, desired2: 1.2, current: 0.8 });
  assert.equal(harness.postCalls().length, 0);
  assert.match(harness.logs.at(-1), /reason=shots_disagree/);
});

test('damping happens before the maximum adjustment cap and target rounds to 0.001', async () => {
  const capped = await validRun({ desired1: 1.3, current: 0.8 });
  assert.equal(JSON.parse(capped.postCalls()[0].options.body).flowMultiplier, 0.9);
  const rounded = await validRun({ desired1: 0.923, current: 0.8 });
  assert.equal(JSON.parse(rounded.postCalls()[0].options.body).flowMultiplier, 0.862);
});

test('external override becomes the new baseline and is not overwritten in that cycle', async () => {
  const harness = await validRun({
    stored: { version: 1, machines: { '12345': { baselineMultiplier: 0.7, lastPluginAppliedMultiplier: 0.9, ownsCurrentMultiplier: true } } },
    current: 0.8,
  });
  assert.equal(harness.postCalls().length, 0);
  assert.match(harness.logs.at(-1), /reason=external_override/);
  assert.deepEqual(harness.storageValue.machines['12345'], { baselineMultiplier: 0.8, lastPluginAppliedMultiplier: null, ownsCurrentMultiplier: false });
});

test('dry run detects an external override without persisting ownership changes', async () => {
  const profile = { title: 'Profile', notes: 'same' };
  const harness = await validRun({
    profile,
    settings: { DryRun: true },
    stored: { version: 1, machines: { '12345': { baselineMultiplier: 0.7, lastPluginAppliedMultiplier: 0.9, ownsCurrentMultiplier: true } } },
    current: 0.8,
  });
  assert.equal(harness.postCalls().length, 0);
  assert.match(harness.logs.at(-1), /reason=external_override/);
  assert.equal(harness.storageWrites.length, 0);

  // Nothing changed, so the next dry-run evaluation reports the same override
  // instead of quietly adopting it as a new baseline.
  await harness.workflow(profile);
  assert.match(harness.logs.at(-1), /reason=external_override/);
  assert.equal(harness.storageWrites.length, 0);
  assert.equal(harness.fullShotCalls().length, 0);
});

test('missing scale evidence restores an owned baseline but not an externally owned value', async () => {
  const owned = await validRun({
    stored: { version: 1, machines: { '12345': { baselineMultiplier: 0.7, lastPluginAppliedMultiplier: 0.9, ownsCurrentMultiplier: true } } },
    current: 0.9,
    shotOptions1: { noScale: true },
  });
  assert.equal(owned.postCalls().length, 1);
  assert.equal(JSON.parse(owned.postCalls()[0].options.body).flowMultiplier, 0.7);
  assert.deepEqual(owned.storageValue.machines['12345'], { baselineMultiplier: 0.7, lastPluginAppliedMultiplier: null, ownsCurrentMultiplier: false });

  const notOwned = await validRun({
    stored: { version: 1, machines: { '12345': { baselineMultiplier: 0.7, lastPluginAppliedMultiplier: null, ownsCurrentMultiplier: false } } },
    current: 0.9,
    shotOptions1: { noScale: true },
  });
  assert.equal(notOwned.postCalls().length, 0);

  const noFlat = await validRun({ shotOptions1: { noFlat: true } });
  assert.equal(noFlat.postCalls().length, 0);
  assert.match(noFlat.logs.at(-1), /reason=insufficient_stable_region/);
});

test('baseline ownership is retained when restoration verification fails', async () => {
  let calibrationGets = 0;
  const harness = await validRun({
    stored: { version: 1, machines: { '12345': { baselineMultiplier: 0.7, lastPluginAppliedMultiplier: 0.9, ownsCurrentMultiplier: true } } },
    current: 0.9,
    shotOptions1: { noScale: true },
    fetchHook: ({ url, options }) => {
      if (new URL(url).pathname === '/api/v1/machine/calibration' && !options.method) {
        calibrationGets++;
        if (calibrationGets >= 2) throw new Error('verification failed');
      }
    },
  });
  assert.equal(harness.postCalls().length, 1);
  assert.deepEqual(harness.storageValue.machines['12345'], { baselineMultiplier: 0.7, lastPluginAppliedMultiplier: 0.9, ownsCurrentMultiplier: true });
});

test('a write the machine does not keep is not reported as applied', async () => {
  // The DE1 accepts the POST but keeps its previous calibration (an emulated
  // DE1 reports 0.0 whatever is written). The plugin must not claim ownership
  // of the value it did not set.
  const harness = await validRun({
    current: 0.8,
    desired1: 0.98,
    desired2: 0.98,
    fetchHook: ({ url, options }) => {
      if (new URL(url).pathname === '/api/v1/machine/calibration' && options.method === 'POST') {
        return response({ ok: true });
      }
    },
  });
  assert.equal(harness.postCalls().length, 1);
  assert.match(harness.logs.at(-1), /reason=calibration_verify_failed/);
  assert.match(harness.logs.at(-1), /verified=0\.800/);
  assert.equal(harness.calibration, 0.8);
  const record = harness.storageValue.machines['12345'];
  assert.equal(record.baselineMultiplier, 0.8);
  assert.equal(record.lastPluginAppliedMultiplier, null, 'a value the machine kept must not be recorded as applied');
  assert.equal(record.ownsCurrentMultiplier, false, 'ownership must not be claimed for a value the machine kept');
});

test('profile races cannot write stale work', async () => {
  const profileA = { title: 'A' };
  const profileB = { title: 'B' };
  const shotA1 = stableShot('a1', profileA);
  const shotA2 = stableShot('a2', profileA);
  let releaseState;
  let stateRequested;
  const stateReady = new Promise(resolve => { stateRequested = resolve; });
  const race = createHarness({
    history: [{ id: 'a1', workflow: shotA1.workflow }, { id: 'a2', workflow: shotA2.workflow }],
    fullShots: [shotA1, shotA2],
    fetchHook: async ({ url }) => {
      if (new URL(url).pathname === '/api/v1/machine/state') {
        stateRequested();
        await new Promise(resolve => { releaseState = resolve; });
      }
    },
  });
  await race.start();
  const first = race.workflow(profileA);
  await stateReady;
  const second = race.workflow(profileB);
  releaseState();
  await Promise.all([first, second]);
  assert.equal(race.postCalls().length, 0);
  assert.ok(
    race.logs.some(line => /reason=profile_changed_during_analysis/.test(line)),
    'the raced evaluation must abandon its stale work',
  );
});

test('machine replacement immediately before POST aborts for another DE1 and for Bengle', async () => {
  for (const replacement of [
    { model: 'DE1Pro', serialNumber: 'other' },
    { model: 'Bengle', serialNumber: '12345' },
  ]) {
    let infoCalls = 0;
    const harness = await validRun({ fetchHook: ({ url }) => {
      if (new URL(url).pathname === '/api/v1/machine/info') {
        infoCalls++;
        if (infoCalls > 1) return response(replacement);
      }
    } });
    assert.equal(harness.postCalls().length, 0);
    assert.match(harness.logs.at(-1), /reason=machine_changed_during_analysis/);
  }
});

test('shotStored only dirties history, and a shot stored during analysis is not lost', async () => {
  const harness = await validRun();
  const before = harness.fetchCalls().length;
  await harness.event('shotStored', { id: 'new' });
  assert.equal(harness.fetchCalls().length, before);
  await harness.workflow({ title: 'Profile', notes: 'same' });
  assert.ok(harness.historyCalls().length >= 2);

  let release;
  let listReturned;
  let blockFullFetch = false;
  const listReady = new Promise(resolve => { listReturned = resolve; });
  const slow = createHarness({
    history: [{ id: 'a', workflow: stableShot('a', { title: 'Profile', notes: 'same' }).workflow }, { id: 'b', workflow: stableShot('b', { title: 'Profile', notes: 'same' }).workflow }],
    fullShots: [stableShot('a', { title: 'Profile', notes: 'same' }), stableShot('b', { title: 'Profile', notes: 'same' })],
    fetchHook: async ({ url }) => {
      if (blockFullFetch && new URL(url).pathname === '/api/v1/shots' && new URL(url).searchParams.has('ids')) {
        listReturned();
        await new Promise(resolve => { release = resolve; });
      }
    },
  });
  await slow.start();
  await slow.workflow({ title: 'Profile', notes: 'same' });
  blockFullFetch = true;
  await slow.event('shotStored', { id: 'during' });
  const pending = slow.workflow({ title: 'Profile', notes: 'same' });
  await listReady;
  await slow.event('shotStored', { id: 'during-analysis' });
  release();
  await pending;
  blockFullFetch = false;
  const count = slow.historyCalls().length;
  await slow.workflow({ title: 'Profile', notes: 'same' });
  assert.equal(slow.historyCalls().length, count + 1);
});

test('same profile is ignored without dirty history and shotUpdated is ignored', async () => {
  const harness = await validRun();
  const before = harness.fetchCalls().length;
  await harness.workflow({ title: 'Profile', notes: 'same' });
  await harness.event('shotUpdated', { id: 'a' });
  assert.equal(harness.fetchCalls().length, before);
});

test('a disabled evaluation does not mark the history revision as evaluated', async () => {
  const profile = { title: 'Profile' };
  const harness = createHarness({ settings: { Enabled: false } });
  await harness.start({ Enabled: false });
  await harness.event('shotStored', { id: 'pre-existing' });
  await harness.workflow(profile);
  assert.equal(harness.logs.length, 1);
  assert.match(harness.logs.at(-1), /reason=disabled/);
  await harness.workflow(profile);
  assert.equal(harness.logs.length, 2);
  assert.match(harness.logs.at(-1), /reason=disabled/);
  assert.equal(harness.historyCalls().length, 0);
});

test('busy machine, REST failure, and unload/shutdown never start a retry or fallback write', async () => {
  const busy = await validRun({ fetchHook: ({ url }) => {
    if (new URL(url).pathname === '/api/v1/machine/state') return response({ state: 'espresso' });
  } });
  assert.equal(busy.postCalls().length, 0);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(busy.postCalls().length, 0);
  assert.match(busy.logs.at(-1), /reason=machine_busy/);

  const failed = createHarness({ fetchHook: ({ url }) => {
    if (new URL(url).pathname === '/api/v1/shots') throw new Error('REST down');
  } });
  await failed.start();
  await failed.workflow({ title: 'Profile' });
  assert.equal(failed.postCalls().length, 0);
  assert.match(failed.logs.at(-1), /reason=history_fetch_failed/);

  const lifecycle = await validRun({ settings: { Enabled: false } });
  await lifecycle.event('shutdown');
  await lifecycle.plugin.onUnload();
  assert.equal(lifecycle.postCalls().length, 0);
  assert.match(lifecycle.logs.at(-1), /reason=disabled/);
});

test('dry run performs complete analysis without POST or ownership', async () => {
  const harness = await validRun({ settings: { DryRun: true }, current: 0.8 });
  assert.equal(harness.postCalls().length, 0);
  assert.ok(harness.fetchCalls().some(call => new URL(call.url).pathname === '/api/v1/machine/state'));
  assert.ok(harness.fetchCalls().some(call => new URL(call.url).pathname === '/api/v1/machine/info'));
  assert.match(harness.logs.at(-1), /action=dry_run/);
  assert.equal(harness.storageValue.machines['12345'].ownsCurrentMultiplier, false);
});

test('dry run logs evidence failures as skip rather than dry_run', async () => {
  const harness = await validRun({ settings: { DryRun: true }, shotOptions1: { noScale: true } });
  assert.equal(harness.postCalls().length, 0);
  assert.match(harness.logs.at(-1), /action=skip/);
  assert.match(harness.logs.at(-1), /reason=no_scale_data/);
  assert.doesNotMatch(harness.logs.at(-1), /action=dry_run/);
});

test('malformed persisted state is discarded instead of granting ownership', async () => {
  const malformed = [
    { version: 2, machines: {} },
    { version: 1, machines: { '12345': { baselineMultiplier: 1, lastPluginAppliedMultiplier: 0.9, ownsCurrentMultiplier: 'yes' } } },
    { version: 1, machines: { '12345': { baselineMultiplier: 1, lastPluginAppliedMultiplier: 0, ownsCurrentMultiplier: true } } },
    { version: 1, machines: { '12345': { baselineMultiplier: 1, lastPluginAppliedMultiplier: null, ownsCurrentMultiplier: false, extra: true } } },
  ];
  for (const stored of malformed) {
    const harness = await validRun({ stored, current: 0.9, shotOptions1: { noScale: true } });
    assert.equal(harness.postCalls().length, 0);
    assert.equal(harness.storageValue.machines['12345'].ownsCurrentMultiplier, false);
  }
});
