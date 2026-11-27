const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildPlugin } = require('../tools/build-plugin');
const { fitFlowZeroLag, fitFlow } = require('../tools/experimental-flow-fit');
const payload = buildPlugin();
const profile = { title: 'Trial', version: '1', steps: [{ name: 'pour' }] };
const serial = 'trial-de1';
function shot(id = 'new', multiplier = 1.45, second = 1, duration = 10) {
  return { id, timestamp: `2026-11-26T12:00:${String(second).padStart(2, '0')}.000001`,
    workflow: { profile: structuredClone(profile), machine: { model: 'DE1Pro', serialNumber: serial, provenanceStatus: 'captured', flowCalibration: 1.13 } },
    measurements: Array.from({ length: duration * 4 + 1 }, (_, i) => {
      const t = i / 4;
      return { machine: { timestamp: t, state: { state: 'espresso' }, profileFrame: 0, pressure: 6, flow: 2 * 1.13 },
        scale: { timestamp: t, weight: 10 + 2 * multiplier * t, weightFlow: 2 * multiplier } };
    }) };
}
function harness(options = {}) {
  const calls = [], writes = [], posts = [];
  let plugin, stored = options.saved;
  const h = { current: 1.13, state: 'idle', workflow: { profile: structuredClone(profile) },
    machine: { model: 'DE1Pro', serialNumber: serial }, shots: options.shots || [shot()],
    history: [{ timestamp: '2026-11-26T12:00:00.000000' }], calls, writes, posts,
    failStorage: false, failStorageAt: null, storageAttempts: 0, failPost: false, wrongReadback: false, hook: null,
    status: () => JSON.parse(plugin.__httpRequestHandler({ endpoint: 'status' }).body),
    stored: () => structuredClone(stored),
    async mode(mode, value, extra = {}) {
      const s = h.status();
      return await plugin.__httpRequestHandler({ endpoint: 'mode', method: 'POST', body: { mode, value, profileKey: s.profile?.key, context: s.context, ...extra } });
    },
    async start(settings = { Enabled: true, ExpectedSerial: serial }) {
      plugin.onLoad(settings);
      if (options.failRead) return;
      await plugin.onEvent({ name: 'storageRead', payload: { key: 'calibration-v2', value: stored } });
    },
    async event(name, payload) { await plugin.onEvent({ name, payload }); },
    async store(id = 'new') { await plugin.onEvent({ name: 'shotStored', payload: { id } }); },
    async select(next) { h.workflow = { profile: structuredClone(next) }; await h.event('workflowUpdated', h.workflow); },
  };
  const host = { log() {}, storage(command) {
    assert.equal(command.namespace, 'auto-flow-cal.reaplugin');
    assert.equal(command.key, 'calibration-v2');
    calls.push({ storage: command.type });
    if (command.type !== 'write') {
      if (options.failRead) throw new Error('read failed');
      return; // Real host returns void, not a Promise.
    }
    h.storageAttempts++;
    if (h.failStorage || h.storageAttempts === h.failStorageAt) throw new Error('disk failure');
    stored = structuredClone(command.data); writes.push(stored);
    if (options.ack !== false) queueMicrotask(() => plugin.onEvent({ name: 'storageWrite', payload: structuredClone(stored) }));
  } };
  plugin = vm.runInNewContext(payload.plugin + '\ncreatePlugin', {
    setTimeout: (fn, delay) => setTimeout(fn, options.ack === false ? 5 : delay), clearTimeout,
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method });
      const u = new URL(url);
      if (h.hook) await h.hook(u, init, h);
      let body;
      if (u.pathname === '/api/v1/machine/info') body = h.machine;
      else if (u.pathname === '/api/v1/workflow') body = h.workflow;
      else if (u.pathname === '/api/v1/machine/state') body = { state: { state: h.state } };
      else if (u.pathname === '/api/v1/machine/calibration') {
        if (init.method === 'POST') {
          posts.push(JSON.parse(init.body));
          assert.ok(h.stored().pending, 'durably acknowledged intent must precede POST');
          if (h.failPost) throw new Error('ambiguous network failure');
          if (!h.wrongReadback) h.current = JSON.parse(init.body).flowMultiplier;
        }
        body = { flowMultiplier: h.current };
      } else if (u.pathname === '/api/v1/shots') {
        body = u.searchParams.has('ids') ? h.shots.filter(s => s.id === u.searchParams.get('ids')) : { items: h.history };
      } else throw new Error('unexpected route ' + url);
      return { ok: true, status: 200, json: async () => structuredClone(body) };
    },
  })(host);
  h.plugin = plugin;
  return h;
}

test('the original plugin upgrade is serial-pinned, disabled by default, and read-only status has no effects', async () => {
  assert.equal(payload.manifest.settings.Enabled.default, false);
  assert.equal(payload.manifest.settings.ExpectedSerial.default, '');
  assert.equal(payload.manifest.id, 'auto-flow-cal.reaplugin');
  const h = harness(); await h.start({}); await h.store();
  const before = h.calls.length;
  assert.equal(h.status().calibrationWritesAllowed, false);
  assert.equal(h.status().queuedWriteProtection, 'best_effort_only');
  assert.equal(h.status().persistentManualOverride, true);
  assert.equal(h.plugin.version, payload.manifest.version);
  h.status();
  assert.equal(h.calls.length, before);
  assert.equal(h.writes.length, 0); assert.equal(h.posts.length, 0);
});

test('legacy storage events are ignored: no settings migration or legacy-state overwrite', async () => {
  const h = harness();
  h.plugin.onLoad({ Enabled: true, ExpectedSerial: serial });
  await h.event('storageRead', { key: 'state', value: { version: 1, machines: {} } });
  assert.equal(h.status().ready, false);
  assert.equal(h.writes.length, 0); assert.equal(h.posts.length, 0);
  await h.event('storageRead', { key: 'calibration-v2', value: null });
  assert.equal(h.status().ready, true);
  assert.equal(h.current, 1.13); assert.equal(h.posts.length, 0);
  assert.deepEqual(h.stored().machines['s:' + serial].overrides, {});
});

test('old enabled settings without the new serial pin cannot cause calibration changes', async () => {
  const h = harness();
  await h.start({ Enabled: true, Damping: .5, DryRun: false });
  assert.equal(h.status().held, 'expected_serial_required');
  assert.equal(h.writes.length, 0); assert.equal(h.posts.length, 0);
});

test('one usable new shot applies its full estimate once, uncapped, with verified read-back', async () => {
  const h = harness(); await h.start(); await h.store(); await h.store();
  assert.equal(h.posts.length, 1);
  assert.ok(Math.abs(h.current - 1.45) < .001);
  assert.equal(h.status().decisions[1].reason, 'applied_verified');
  assert.equal(h.status().unresolvedIntent, null);
  assert.equal(h.stored().machines['s:' + serial].consumed.length, 1);
});

test('zero-lag v2 accepts a valid 3-second trace without optional diagnostic support', () => {
  const input = shot('short', 0.9, 1, 3);
  assert.equal(fitFlow(input).fitted, false, 'preserve original comparison method');
  const fit = fitFlowZeroLag(input);
  assert.equal(fit.fitted, true); assert.equal(fit.fitMethod, 'fixed_zero_lag_v2');
  assert.ok(Math.abs(fit.multiplier - .9) < 1e-9);
  assert.equal(fit.lagDiagnostics.available, false);
});

test('bundled live fitter matches v2 offline fitter and retains a sub-deadband target without writing', async () => {
  const input = shot('new', 1.135), h = harness({ shots: [input] }); await h.start(); await h.store();
  const target = h.status().decisions.find(d => d.reason === 'new_target');
  assert.deepEqual(target.fit, fitFlowZeroLag(input));
  assert.equal(h.posts.length, 0);
  const program = Object.values(h.status().machines['s:' + serial].programs)[0];
  assert.ok(Math.abs(program.target - 1.135) < 1e-9); assert.equal(program.applied, null);
});

test('boot history, pre-hydration events, older shots and restart cannot replay calibration', async () => {
  const h = harness(); await h.store(); await h.start(); await h.store();
  const restart = harness({ saved: h.stored() }); await restart.start(); await restart.store();
  assert.equal(restart.posts.length, 0);
  const old = shot('old', 1.6, 0); restart.shots.push(old); await restart.store('old');
  assert.equal(restart.posts.length, 0);
  assert.ok(restart.status().decisions.some(d => d.reason === 'old_or_duplicate_shot'));
});

test('failed fit consumes the shot but neither erases a value nor restores baseline', async () => {
  const bad = shot('bad', 1, 2); bad.measurements.forEach(m => delete m.scale);
  const h = harness({ shots: [shot(), bad] }); await h.start(); await h.store(); const applied = h.current;
  await h.store('bad'); await h.store('bad');
  assert.equal(h.current, applied); assert.equal(h.posts.length, 1);
  assert.equal(h.stored().machines['s:' + serial].consumed.length, 2);
});

test('exact known-program recall and baseline fallback are independent of the old learning cap', async () => {
  const h = harness(); await h.start(); await h.store();
  await h.select({ ...profile, title: 'Other program' });
  assert.equal(h.current, 1.13);
  await h.select(profile);
  assert.equal(h.current, 1.45);
  assert.deepEqual(h.posts.map(p => p.flowMultiplier), [1.45, 1.13, 1.45]);
});

test('busy writes defer once and use machine events without creating extra authorizations', async () => {
  const h = harness(); await h.start(); h.state = 'espresso'; await h.store();
  assert.equal(h.posts.length, 0); assert.ok(h.status().pending);
  h.state = 'idle'; await h.event('stateUpdate', {});
  await h.event('stateUpdate', {}); await h.event('workflowUpdated', h.workflow);
  assert.equal(h.posts.length, 1);
});

test('an unapplied target cannot gain exact-recall authority by toggling profiles', async () => {
  const h = harness(); await h.start(); h.state = 'espresso'; await h.store();
  h.state = 'idle'; await h.select({ ...profile, title: 'Other program' }); await h.select(profile);
  assert.equal(h.posts.length, 0); assert.equal(h.current, 1.13);
});

test('manual change observed before dispatch pauses without overwrite', async () => {
  const h = harness(); await h.start();
  h.hook = (u, init) => {
    if (u.pathname.endsWith('/calibration') && init.method === 'GET' && h.stored().pending) h.current = .95;
  };
  await h.store();
  assert.equal(h.posts.length, 0); assert.equal(h.current, .95);
  assert.equal(h.status().held, 'external_change_detected');
});

test('shot start during intent persistence defers rather than dispatching', async () => {
  const h = harness(); await h.start();
  h.hook = () => { if (h.stored().pending) h.state = 'espresso'; };
  await h.store(); assert.equal(h.posts.length, 0); assert.equal(h.status().unresolvedIntent, null);
});

test('known queued-write gap is explicit: a start after final checks cannot be prevented client-side', async () => {
  const h = harness(); await h.start();
  h.hook = (u, init) => { if (init.method === 'POST') h.state = 'espresso'; };
  await h.store();
  assert.equal(h.posts.length, 1, 'documents deferred host-side race, not a safety guarantee');
  assert.equal(h.status().queuedWriteProtection, 'best_effort_only');
  assert.equal(h.status().held, 'write_verification_failed', 'pause once the unsafe outcome is observed');
});

test('workflow changes invalidate in-flight analysis and cannot apply it to the new program', async () => {
  const h = harness(); await h.start(); let switched;
  h.hook = (u) => {
    if (u.pathname.endsWith('/shots') && u.searchParams.has('ids')) {
      h.hook = null; switched = h.select({ ...profile, title: 'Changed while fetching' });
    }
  };
  await h.store(); await switched;
  assert.equal(h.posts.length, 0);
});

test('wrong live serial/model, missing pin, unsafe enable and corrupt storage fail closed', async () => {
  for (const change of [h => { h.machine.serialNumber = 'different'; }, h => { h.machine.model = 'Bengle'; },
    h => { h.state = 'espresso'; }, h => { h.current = 2.1; }]) {
    const h = harness(); change(h); await h.start(); await h.store();
    assert.ok(h.status().held); assert.equal(h.posts.length, 0);
  }
  const missing = harness(); await missing.start({ Enabled: true }); assert.equal(missing.status().held, 'expected_serial_required');
  const corrupt = harness({ saved: { version: 1, machines: {} } }); await corrupt.start();
  assert.equal(corrupt.status().held, 'invalid_saved_state');
});

test('wrong shot provenance, unknown final step and out-of-range fit do not write', async () => {
  for (const change of [s => { s.workflow.machine.serialNumber = 'other'; }, s => { delete s.workflow.machine.provenanceStatus; },
    s => { s.measurements.forEach(m => delete m.machine.profileFrame); },
    s => { s.measurements.forEach(m => { m.scale.weightFlow *= 3; }); }]) {
    const input = shot(); change(input); const h = harness({ shots: [input] }); await h.start(); await h.store();
    assert.equal(h.posts.length, 0);
  }
});

test('storage write failure or missing acknowledgement prevents dispatch', async () => {
  const h = harness(); await h.start(); h.failStorage = true; await h.store();
  assert.equal(h.posts.length, 0); assert.equal(h.status().held, 'storage_write_failed');
  const failedRead = harness({ failRead: true }); await failedRead.start();
  assert.equal(failedRead.status().held, 'storage_read_failed'); assert.equal(failedRead.posts.length, 0);
  const noAck = harness({ ack: false }); await noAck.start();
  assert.equal(noAck.status().held, 'storage_ack_timeout'); assert.equal(noAck.posts.length, 0);
});

for (const failure of ['failPost', 'wrongReadback']) {
  test(`${failure}: hold ambiguous intent, never retry on events or restart`, async () => {
    const h = harness(); await h.start(); h[failure] = true; await h.store();
    assert.equal(h.posts.length, 1); assert.ok(h.status().held); assert.ok(h.status().unresolvedIntent);
    await h.event('stateUpdate', {}); await h.store(); assert.equal(h.posts.length, 1);
    const restart = harness({ saved: h.stored() }); await restart.start();
    assert.equal(restart.status().held, 'unresolved_write_intent'); assert.equal(restart.posts.length, 0);
  });
}

test('unload during final checks prevents dispatch; endpoint reads cannot apply pending work', async () => {
  const h = harness(); await h.start();
  h.hook = () => { if (h.stored().pending) h.plugin.onUnload(); };
  await h.store(); assert.equal(h.posts.length, 0);
  const before = h.calls.length; h.status(); assert.equal(h.calls.length, before);
});

test('failure at intent persistence prevents POST; failure after read-back retains unresolved intent', async () => {
  const before = harness(); await before.start();
  before.failStorageAt = before.storageAttempts + 2; await before.store();
  assert.equal(before.posts.length, 0); assert.ok(before.status().held);
  const after = harness(); await after.start();
  after.failStorageAt = after.storageAttempts + 3; await after.store();
  assert.equal(after.posts.length, 1); assert.equal(after.status().held, 'storage_write_failed');
  assert.ok(after.status().unresolvedIntent);
  const restart = harness({ saved: after.stored() }); await restart.start();
  assert.equal(restart.status().held, 'unresolved_write_intent');
});

test('latest busy target replaces older pending work, without a staircase', async () => {
  const h = harness({ shots: [shot(), shot('second', 1.7, 2)] }); await h.start();
  h.state = 'espresso'; await h.store(); await h.store('second');
  h.state = 'idle'; await h.event('stateUpdate', {});
  assert.deepEqual(h.posts.map(p => p.flowMultiplier), [1.7]);
});

test('same serial with a changed live model cannot receive a calibration command', async () => {
  const h = harness(); await h.start(); h.machine.model = 'DE1Plus'; await h.store();
  assert.equal(h.posts.length, 0); assert.equal(h.status().held, 'wrong_machine');
});

test('per-shot dose/grind metadata does not create another extraction program or another write token', async () => {
  const h = harness(); await h.start(); await h.store();
  h.workflow.context = { targetDoseWeight: 15, grinderSetting: 'new grind' };
  const before = h.calls.length; await h.event('workflowUpdated', h.workflow);
  assert.equal(h.calls.length, before); assert.equal(h.posts.length, 1);
});

test('tile/page reads do not evaluate, write storage or touch calibration; fresh view remains observational', async () => {
  const h = harness(); await h.start();
  const beforeCalls = h.calls.length, beforeWrites = h.writes.length, beforeState = JSON.stringify(h.stored());
  const skin = h.plugin.__httpRequestHandler({ endpoint: 'skin', method: 'GET' });
  assert.match(JSON.parse(skin.body).surfaces[0].text, /1\.130/);
  assert.equal(h.plugin.__httpRequestHandler({ endpoint: 'ui', method: 'GET', query: {} }).status, 200);
  assert.equal(h.calls.length, beforeCalls); assert.equal(h.writes.length, beforeWrites);
  h.current = .95;
  const view = JSON.parse((await h.plugin.__httpRequestHandler({ endpoint: 'view', method: 'GET' })).body);
  assert.equal(view.value, .95); assert.equal(view.outsideUpdater, true);
  assert.equal(h.status().held, null); assert.equal(JSON.stringify(h.stored()), beforeState);
  assert.equal(h.posts.length, 0); assert.equal(h.writes.length, beforeWrites);
  await h.store();
  assert.equal(h.posts.length, 0); assert.equal(h.status().held, 'external_change_detected');
});

test('manual multiplier stays fixed per profile; automatic records survive manual shots', async () => {
  const h = harness(); await h.start(); await h.store();
  const automatic = structuredClone(Object.values(h.stored().machines['s:' + serial].programs)[0]);
  assert.equal((await h.mode('manual', 2)).status, 200);
  assert.equal(h.current, 2); assert.equal(h.status().profile.mode, 'manual');
  const manual = shot('manual-shot', .7, 2); manual.workflow.machine.flowCalibration = 2;
  h.shots.push(manual); await h.store('manual-shot'); await h.store('manual-shot');
  assert.equal(h.current, 2); assert.equal(h.posts.length, 2);
  assert.deepEqual(Object.values(h.stored().machines['s:' + serial].programs)[0], automatic);
  assert.ok(h.stored().machines['s:' + serial].consumed.includes('manual-shot'));
  await h.select({ ...profile, title: 'Other program' }); assert.equal(h.current, 1.13);
  await h.select(profile); assert.equal(h.current, 2);
  const restart = harness({ saved: h.stored() }); restart.current = h.current; await restart.start();
  assert.equal(restart.status().profile.manualValue, 2); assert.equal(restart.posts.length, 0);
  await restart.select({ ...profile, title: 'Other program' }); await restart.select(profile);
  assert.equal(restart.current, 2);
});

test('Auto restores the last automatic value, then learns only future shots', async () => {
  const h = harness(); await h.start(); await h.store(); await h.mode('manual', 2);
  const manual = shot('manual-shot', .7, 2); h.shots.push(manual);
  h.history = [{ timestamp: manual.timestamp }]; // Delayed manual-shot event has not arrived yet.
  assert.equal((await h.mode('auto')).status, 200); assert.equal(h.current, 1.45);
  assert.equal(h.status().profile.mode, 'auto'); await h.store('manual-shot'); assert.equal(h.current, 1.45);
  h.shots.push(shot('future', 1.6, 3)); await h.store('future'); assert.equal(h.current, 1.6);
});

test('manual-only profiles use exact multipliers including 1.000, preserve baseline and remain dose/grind independent', async () => {
  const h = harness(); await h.start();
  await h.mode('manual', 2); await h.mode('manual', 1);
  assert.deepEqual(h.posts.map(p => p.flowMultiplier), [2, 1]);
  assert.equal(Object.keys(h.stored().machines['s:' + serial].programs).length, 0);
  assert.equal(h.stored().machines['s:' + serial].baseline, 1.13);
  h.workflow.context = { targetDoseWeight: 15, grinderSetting: 'new grind' };
  await h.event('workflowUpdated', h.workflow); assert.equal(h.status().profile.manualValue, 1);
  await h.mode('auto'); assert.equal(h.current, 1.13);
});

test('recipe edits cannot silently remove a named profile manual override', async () => {
  const h = harness(); await h.start(); await h.mode('manual', 2);
  const edited = { ...profile, version: '2', steps: [{ name: 'edited pour', pressure: 4, temperature: 85 }] };
  await h.select(edited); assert.equal(h.status().profile.mode, 'manual'); assert.equal(h.current, 2);
  const input = shot('edited-shot', .75, 2); input.workflow.profile = edited; h.shots.push(input); await h.store('edited-shot');
  assert.equal(h.current, 2); assert.equal(h.posts.length, 1);
  await h.select({ ...edited, title: 'Different profile' }); assert.equal(h.current, 1.13);
  await h.select(edited); assert.equal(h.current, 2);
  await h.mode('auto'); assert.equal(h.current, 1.13, 'new recipe has no verified automatic value');
});

test('mode endpoint rejects invalid methods, values, wrong profile, stale and concurrent requests without mutation', async () => {
  const h = harness(); await h.start(); const state = h.stored(), calls = h.calls.length;
  for (const value of [null, '2', .349, 2.001, 1.0001, NaN, Infinity]) assert.equal((await h.mode('manual', value)).status, 400);
  assert.equal((await h.mode('other')).status, 400);
  assert.equal((await h.mode('manual', 2, { profileKey: 'wrong' })).status, 409);
  assert.equal((await h.mode('manual', 2, { context: 'old' })).status, 409);
  assert.equal((await h.plugin.__httpRequestHandler({ endpoint: 'mode', method: 'GET' })).status, 405);
  assert.equal((await h.plugin.__httpRequestHandler({ endpoint: 'mode', method: 'POST', body: '{' })).status, 400);
  assert.deepEqual(h.stored(), state); assert.equal(h.calls.length, calls);
  const s = h.status(), request = { endpoint: 'mode', method: 'POST', body: JSON.stringify({ mode: 'manual', value: 2, context: s.context, profileKey: s.profile.key }) };
  const first = h.plugin.__httpRequestHandler(request);
  assert.equal((await h.plugin.__httpRequestHandler(request)).status, 409);
  assert.equal((await first).status, 200);
  assert.equal((await h.plugin.__httpRequestHandler(request)).status, 409);
  assert.equal(h.posts.length, 1);
});

test('manual setting supersedes deferred automatic targets but busy requests do not cancel them', async () => {
  const h = harness(); await h.start(); h.state = 'espresso'; await h.store();
  const pending = h.status().pending;
  assert.equal((await h.mode('manual', 2)).status, 409);
  assert.deepEqual(h.status().pending, pending); assert.equal(h.status().profile.mode, 'auto');
  h.state = 'idle'; assert.equal((await h.mode('manual', 2)).status, 200);
  await h.event('stateUpdate', {}); assert.deepEqual(h.posts.map(p => p.flowMultiplier), [2]);
});

test('profile change or unload during mode validation cannot target another profile or write', async () => {
  for (const unload of [false, true]) {
    const h = harness(); await h.start(); let switched;
    h.hook = u => { if (u.pathname.endsWith('/calibration')) { h.hook = null; if (unload) h.plugin.onUnload(); else switched = h.select({ ...profile, title: 'Changed' }); } };
    assert.equal((await h.mode('manual', 2)).status, 409); if (switched) await switched;
    assert.equal(h.posts.length, 0); assert.equal(Object.keys(h.stored().machines['s:' + serial].overrides).length, 0);
  }
});

test('shot start after saving a manual choice defers it; manual shots cannot erase the pending choice', async () => {
  const h = harness(); await h.start();
  h.hook = () => { if (Object.keys(h.stored().machines['s:' + serial].overrides).length) h.state = 'espresso'; };
  assert.equal((await h.mode('manual', 2)).status, 202); assert.equal(h.posts.length, 0);
  await h.store(); assert.equal(h.status().pending.target, 2);
  h.hook = null; h.state = 'idle'; await h.event('stateUpdate', {}); assert.equal(h.current, 2);
});

test('manual persistence and ambiguous dispatch failures fail closed, including restart', async () => {
  const failed = harness(); await failed.start(); failed.failStorage = true;
  assert.equal((await failed.mode('manual', 2)).status, 503); assert.equal(failed.posts.length, 0);
  const ambiguous = harness(); await ambiguous.start(); ambiguous.failPost = true;
  assert.equal((await ambiguous.mode('manual', 2)).status, 503); assert.ok(ambiguous.stored().pending);
  const restart = harness({ saved: ambiguous.stored() }); await restart.start();
  assert.equal(restart.status().held, 'unresolved_write_intent'); assert.equal(restart.posts.length, 0);
});

test('external changes cannot be overwritten by a saved manual value, even after restart', async () => {
  const h = harness(); await h.start(); await h.mode('manual', 2);
  h.current = .95;
  const restart = harness({ saved: h.stored() }); restart.current = .95; await restart.start();
  assert.equal(restart.status().held, 'external_change_detected'); assert.equal(restart.posts.length, 0);
  // Leaving manual also checks ownership; a conflict is not an implicit overwrite approval.
  assert.equal((await h.mode('auto')).status, 503); assert.equal(h.current, .95);
  const again = harness({ saved: h.stored() }); again.current = .95; await again.start();
  assert.equal(again.status().held, 'external_change_detected'); assert.equal(again.posts.length, 0);
});

test('v1 ledger migrates without losing authority/history; corrupt overrides fail closed', async () => {
  const h = harness(); await h.start(); await h.store();
  const old = h.stored(); old.version = 1; Object.values(old.machines).forEach(m => delete m.overrides);
  const restart = harness({ saved: old }); restart.current = h.current; await restart.start();
  assert.equal(restart.stored().version, 2);
  assert.deepEqual(restart.stored().machines['s:' + serial].programs, old.machines['s:' + serial].programs);
  assert.deepEqual(restart.stored().machines['s:' + serial].consumed, old.machines['s:' + serial].consumed);
  for (const field of ['baseline', 'expected', 'highWater']) assert.equal(restart.stored().machines['s:' + serial][field], old.machines['s:' + serial][field]);
  for (const overrides of [null, [], { bad: 2 }, { 't:bad': 3 }, { 't:bad': 1.0001 }]) {
    const corrupt = h.stored(); corrupt.machines['s:' + serial].overrides = overrides;
    const bad = harness({ saved: corrupt }); await bad.start(); assert.equal(bad.status().held, 'invalid_saved_state'); assert.equal(bad.posts.length, 0);
  }
});

for (const name of ['short-output-tail', 'noisy-pressure-plateau', 'accepted-control', 'missing-scale-control']) {
  test(`v2 live bundle agrees with offline fitting on captured ${name}`, async () => {
    const input = shot();
    input.measurements = structuredClone(require(`./fixtures/real-shots/${name}.json`).measurements);
    const h = harness({ shots: [input] }); await h.start(); await h.store();
    const result = h.status().decisions.find(d => d.reason === 'new_target' || d.reason === 'no_fit');
    assert.deepEqual(result.fit, fitFlowZeroLag(input));
    assert.equal(result.fit.fitted, name !== 'missing-scale-control');
  });
}
