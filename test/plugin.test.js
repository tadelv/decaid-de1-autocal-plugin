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
    failStorage: false, failStorageAt: null, storageAttempts: 0, failPost: false, wrongReadback: false, hook: null, ackHook: null,
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
    async view() { return JSON.parse((await plugin.__httpRequestHandler({ endpoint: 'view', method: 'GET' })).body); },
    async recover(body) { return await plugin.__httpRequestHandler({ endpoint: 'recover', method: 'POST', body }); },
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
    if (options.ack !== false && options.ackAt !== h.storageAttempts) queueMicrotask(() => {
      plugin.onEvent({ name: 'storageWrite', payload: structuredClone(stored) });
      // Runs after the acknowledgement and before the request continues, so a real-world change can land in that window.
      if (h.ackHook) h.ackHook();
    });
  } };
  plugin = vm.runInNewContext(payload.plugin + '\ncreatePlugin', {
    setTimeout: (fn, delay) => setTimeout(fn, options.ack === false || options.ackAt ? 5 : delay), clearTimeout,
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

async function legacyVerificationHold(options = {}) {
  const filter = { title: 'Filter3', version: '1', steps: [{ name: 'pour', flow: 2 }] };
  const dflow = { title: 'D-Flow / Step-down', version: '1', steps: [{ name: 'pour', pressure: 6 }] };
  const seed = harness(); seed.current = 2; seed.workflow = { profile: structuredClone(filter) }; await seed.start();
  const filterKey = seed.status().profile.key;
  await seed.select(dflow); await seed.mode('manual', 1);
  const saved = seed.stored();
  saved.pending = { serial, key: filterKey, shotId: null, expected: 1, command: 2, kind: 'baseline' };
  const h = harness({ ...options, saved }); h.current = 2; h.workflow = { profile: structuredClone(filter) }; await h.start();
  return { h, filter, dflow };
}

function recoveryBody(review) {
  return { context: review.context, profileKey: review.profileKey, value: review.value, confirmSettled: true };
}

// Reported state: the paused command was 2.000 but the machine now reads 1.000.
async function reloadHold(mode = 'auto', options = {}) {
  const filter = { title: 'Filter3', version: '1', steps: [{ name: 'pour', flow: 2 }] };
  const dflow = { title: 'D-Flow / Step-down', version: '1', steps: [{ name: 'pour', pressure: 6 }] };
  const seed = harness(); seed.current = 2; seed.workflow = { profile: structuredClone(filter) }; await seed.start();
  const filterKey = seed.status().profile.key;
  await seed.select(dflow); await seed.mode('manual', 1);
  if (mode === 'manual') { await seed.select(filter); await seed.mode('manual', 2); }
  const saved = seed.stored(), record = saved.machines['s:' + serial];
  record.programs[filterKey] = mode === 'manual' ? { target: 1.35, applied: 1.13 } : { target: 2, applied: 2 };
  saved.pending = { serial, model: 'DE1Pro', key: filterKey, shotId: null, expected: 2, command: 2, kind: 'learning' };
  const h = harness({ ...options, saved }); h.current = 1; h.workflow = { profile: structuredClone(filter) }; await h.start();
  return { h, filter, dflow, filterKey };
}

// A retry reuses what the failed preparation recorded, so these cases all start from a real prepared reload.
async function preparedReload(mode = 'auto') {
  const { h, filter, filterKey } = await reloadHold(mode);
  h.failStorageAt = h.storageAttempts + 2; // the preparation lands, the completion write fails
  assert.ok((await h.recover({ ...recoveryBody((await h.view()).recovery), action: 'reload_current' })).status >= 400);
  const saved = h.stored();
  assert.ok(saved.pending); assert.equal(saved.lastRecovery.status, 'prepared');
  return { saved, filter, filterKey };
}

const omittedShotId = Symbol('omitted shot id');

// The same reported pause, carrying the shot provenance that the persisted intent records.
async function reloadHoldShot(shotId) {
  const filter = { title: 'Filter3', version: '1', steps: [{ name: 'pour', flow: 2 }] };
  const dflow = { title: 'D-Flow / Step-down', version: '1', steps: [{ name: 'pour', pressure: 6 }] };
  const seed = harness(); seed.current = 2; seed.workflow = { profile: structuredClone(filter) }; await seed.start();
  const filterKey = seed.status().profile.key;
  await seed.select(dflow); await seed.mode('manual', 1);
  const saved = seed.stored(), record = saved.machines['s:' + serial];
  record.programs[filterKey] = { target: 2, applied: 2 };
  saved.pending = { serial, model: 'DE1Pro', key: filterKey, expected: 2, command: 2, kind: 'learning' };
  if (shotId !== omittedShotId) saved.pending.shotId = shotId;
  const h = harness({ saved }); h.current = 1; h.workflow = { profile: structuredClone(filter) }; await h.start();
  return { h, filter, filterKey };
}

async function preparedShot(shotId) {
  const { h, filter, filterKey } = await reloadHoldShot(shotId);
  h.failStorageAt = h.storageAttempts + 2; // the preparation lands, the completion write fails
  assert.ok((await h.recover({ ...recoveryBody((await h.view()).recovery), action: 'reload_current' })).status >= 400);
  const saved = h.stored();
  assert.ok(saved.pending); assert.equal(saved.lastRecovery.status, 'prepared');
  return { saved, filter, filterKey };
}

test('late workflow events during a verified write cannot replace the authoritative active profile', async () => {
  const h = harness(), filter = { title: 'Filter3', version: '1', steps: [{ name: 'pour', flow: 2 }] };
  h.current = 2; h.workflow = { profile: structuredClone(filter) }; await h.start();
  await h.select(profile); await h.mode('manual', 1); let late;
  h.hook = (u, init) => {
    if (!late && u.pathname.endsWith('/calibration') && init.method === 'POST' && JSON.parse(init.body).flowMultiplier === 2) {
      late = h.event('workflowUpdated', { profile });
    }
  };
  await h.select(filter); await late;
  assert.equal(h.current, 2); assert.equal(h.status().held, null);
  assert.equal(h.status().profile.title, 'Filter3'); assert.equal(h.status().unresolvedIntent, null);
  assert.equal(h.status().machines['s:' + serial].expected, 2);
  assert.deepEqual(h.posts.map(p => p.flowMultiplier), [1, 2]);
});

test('workflow events after unload do not start refreshes or resume work', async () => {
  const h = harness(); await h.start(); h.plugin.onUnload(); const before = h.calls.length;
  await h.event('workflowUpdated', { profile });
  assert.equal(h.calls.length, before); assert.equal(h.status().stopped, true); assert.equal(h.posts.length, 0);
});

test('a real profile change during dispatch still holds and exposes the failed verification checks', async () => {
  const h = harness(); await h.start(); let changed;
  h.hook = (u, init) => {
    if (!changed && init.method === 'POST') changed = h.select({ ...profile, title: 'Really changed' });
  };
  await h.store(); await changed;
  const s = h.status(); assert.equal(s.held, 'write_verification_failed'); assert.ok(s.unresolvedIntent);
  assert.equal(s.profile.title, 'Really changed');
  assert.ok(s.verificationFailure.reasons.includes('profile_changed'));
  assert.ok(s.verificationFailure.reasons.includes('controller_context_changed'));
  assert.equal(h.posts.length, 1);
});

test('Check again reviews the current profile and a legacy intent without changing durable state', async () => {
  const { h, dflow } = await legacyVerificationHold(); const before = h.stored(), writes = h.writes.length;
  const model = await h.view(); assert.equal(model.profile.title, 'Filter3');
  assert.equal(model.value, 2); assert.equal(model.canSetMode, false);
  assert.equal(model.recovery.available, true); assert.equal(model.recovery.value, 2);
  assert.equal(model.recovery.requiresSettledConfirmation, true);
  assert.deepEqual(h.stored(), before); assert.equal(h.writes.length, writes); assert.equal(h.posts.length, 0);
  await h.select(dflow); const other = await h.view(); assert.equal(other.profile.title, dflow.title);
  assert.equal(other.recovery.available, false); assert.equal(other.recovery.reason, 'recovery_profile_mismatch');
  assert.deepEqual(h.stored(), before);
});

test('explicit recovery keeps the checked current value in Manual, preserves other profiles and never resends', async () => {
  const { h, dflow } = await legacyVerificationHold(); const before = h.stored();
  const review = (await h.view()).recovery, response = await h.recover(recoveryBody(review));
  assert.equal(response.status, 200); assert.equal(h.status().held, null); assert.equal(h.status().ready, true);
  assert.equal(h.status().unresolvedIntent, null); assert.equal(h.status().profile.mode, 'manual');
  assert.equal(h.status().profile.manualValue, 2); assert.equal(h.current, 2); assert.equal(h.posts.length, 0);
  const m = h.stored().machines['s:' + serial];
  assert.equal(m.expected, 2); assert.equal(m.baseline, 2); assert.equal(m.overrides['t:' + dflow.title], 1);
  assert.deepEqual(m.programs, before.machines['s:' + serial].programs);
  assert.deepEqual(m.consumed, before.machines['s:' + serial].consumed);
  assert.equal(h.stored().lastRecovery.previousIntent.command, 2);
  assert.equal(h.stored().lastRecovery.authority, 'operator_confirmed_manual');
  assert.equal((await h.recover(recoveryBody(review))).status, 409);
  const restart = harness({ saved: h.stored() }); restart.current = 2; restart.workflow = h.workflow; await restart.start();
  assert.equal(restart.status().held, null); assert.equal(restart.status().profile.mode, 'manual'); assert.equal(restart.posts.length, 0);
});

test('recovery rejects absent confirmation, stale requests, changed machines/profiles/values and busy state', async () => {
  for (const mutate of [
    (h, b) => { b.confirmSettled = false; }, (h, b) => { b.context = 'stale'; },
    h => { h.machine.serialNumber = 'different'; }, h => { h.machine.model = 'Bengle'; },
    h => { h.state = 'espresso'; }, h => { h.workflow = { profile }; }, h => { h.current = 1; },
  ]) {
    const { h } = await legacyVerificationHold(), before = h.stored(), body = recoveryBody((await h.view()).recovery);
    mutate(h, body); const response = await h.recover(body);
    assert.ok(response.status >= 400); assert.ok(h.status().held); assert.ok(h.status().unresolvedIntent);
    assert.equal(h.posts.length, 0); assert.deepEqual(h.stored(), before);
  }
});

test('recovery storage failures retain the hold and intent; profile changes during preparation cannot resume', async () => {
  for (const offset of [1, 2]) {
    const { h } = await legacyVerificationHold(), body = recoveryBody((await h.view()).recovery);
    h.failStorageAt = h.storageAttempts + offset;
    assert.ok((await h.recover(body)).status >= 400); assert.ok(h.status().held); assert.ok(h.status().unresolvedIntent);
    assert.ok(h.stored().pending); assert.equal(h.posts.length, 0);
  }
  const { h } = await legacyVerificationHold(), before = h.stored(), body = recoveryBody((await h.view()).recovery);
  h.hook = u => { if (u.pathname.endsWith('/shots')) h.workflow = { profile }; };
  assert.equal((await h.recover(body)).status, 409); assert.ok(h.status().unresolvedIntent);
  assert.deepEqual(h.stored(), before); assert.equal(h.posts.length, 0);
});

test('recovery cannot bypass a pending model binding, missing acknowledgement, or a late context change', async () => {
  const modelCase = await legacyVerificationHold();
  const saved = modelCase.h.stored(); saved.pending.model = 'DE1Pro';
  const changedModel = harness({ saved }); changedModel.current = 2; changedModel.machine.model = 'DE1Plus';
  changedModel.workflow = { profile: modelCase.filter }; await changedModel.start();
  assert.equal((await changedModel.view()).recovery.available, false); assert.equal(changedModel.posts.length, 0);

  const { h: noAck } = await legacyVerificationHold({ ack: false });
  const noAckBody = recoveryBody((await noAck.view()).recovery);
  assert.ok((await noAck.recover(noAckBody)).status >= 400);
  assert.equal(noAck.status().held, 'storage_ack_timeout'); assert.ok(noAck.stored().pending); assert.equal(noAck.posts.length, 0);

  const { h } = await legacyVerificationHold(); const body = recoveryBody((await h.view()).recovery);
  let reads = 0;
  h.hook = u => { if (u.pathname.endsWith('/workflow') && ++reads === 4) h.workflow = { profile }; };
  assert.equal((await h.recover(body)).status, 409); assert.ok(h.status().held); assert.ok(h.stored().pending);
  assert.equal(h.posts.length, 0);
});

test('verification diagnostics distinguish a value mismatch and a newly busy machine', async () => {
  const value = harness(); await value.start(); value.wrongReadback = true; await value.store();
  assert.deepEqual(value.status().verificationFailure.reasons, ['value_mismatch']);
  assert.equal(value.status().verificationFailure.observed.value, 1.13);
  const busy = harness(); await busy.start(); busy.hook = (u, init) => { if (init.method === 'POST') busy.state = 'espresso'; };
  await busy.store(); assert.deepEqual(busy.status().verificationFailure.reasons, ['machine_busy']);
  assert.equal(busy.status().verificationFailure.observed.state, 'espresso');
});

test('Check again reviews the differing readback without touching state and offers a mode-preserving reload', async () => {
  const { h, dflow } = await reloadHold('auto'), before = h.stored(), writes = h.writes.length, posts = h.posts.length;
  const model = await h.view();
  assert.equal(model.profile.mode, 'auto'); assert.equal(model.canSetMode, false);
  assert.equal(model.recovery.available, true); assert.equal(model.recovery.action, 'reload_current');
  assert.equal(model.recovery.mode, 'auto'); assert.equal(model.recovery.command, 2); assert.equal(model.recovery.value, 1);
  assert.equal(model.recovery.requiresSettledConfirmation, true);
  assert.match(model.recoveryText, /Automatic/);
  assert.match(model.recoveryText, /×2\.000/); assert.match(model.recoveryText, /×1\.000/);
  assert.deepEqual(h.stored(), before); assert.equal(h.writes.length, writes);
  assert.equal(h.posts.length, posts); assert.ok(h.status().held); assert.ok(h.status().unresolvedIntent);
  assert.deepEqual(Object.keys(h.stored().machines['s:' + serial].overrides), ['t:' + dflow.title]);
});

test('an Auto reload keeps Automatic, rebases only that profile and never sends a calibration command', async () => {
  const { h, dflow, filterKey } = await reloadHold('auto'), posted = h.posts.length;
  const review = (await h.view()).recovery;
  const response = await h.recover({ ...recoveryBody(review), action: 'reload_current' }), body = JSON.parse(response.body);
  assert.equal(response.status, 200); assert.equal(body.saved, true);
  assert.equal(body.mode, 'auto'); assert.equal(body.value, 1); assert.equal(body.calibrationCommandSent, false);
  assert.equal(h.status().held, null); assert.equal(h.status().ready, true); assert.equal(h.status().unresolvedIntent, null);
  assert.equal(h.status().profile.mode, 'auto'); assert.equal(h.status().profile.manualValue, null);
  assert.equal(h.posts.length, posted); assert.equal(h.current, 1);
  const m = h.stored().machines['s:' + serial];
  assert.equal(m.expected, 1); assert.equal(m.overrides['t:' + dflow.title], 1);
  assert.equal(Object.prototype.hasOwnProperty.call(m.overrides, 't:Filter3'), false, 'Auto must not become Manual');
  assert.deepEqual(m.programs[filterKey], { target: 1, applied: 1 }, 'the checked value is the new starting point');
  const audit = h.stored().lastRecovery;
  assert.equal(audit.authority, 'operator_confirmed_reload_current'); assert.equal(audit.mode, 'auto');
  assert.equal(audit.value, 1); assert.equal(audit.command, 2); assert.equal(audit.calibrationCommandSent, false);
  assert.deepEqual(audit.previous.program, { target: 2, applied: 2 }, 'the replaced profile record is retained');
  assert.equal(audit.previousIntent.command, 2);
  assert.ok(!h.status().decisions.some(d => d.reason === 'applied_verified'), 'the old command is not called verified');
  assert.equal((await h.recover({ ...recoveryBody(review), action: 'reload_current' })).status, 409);
});

test('a Manual reload keeps Manual, replaces its saved value and preserves the automatic record', async () => {
  const { h, dflow, filterKey } = await reloadHold('manual'), before = h.stored().machines['s:' + serial], posted = h.posts.length;
  const model = await h.view();
  assert.equal(model.profile.mode, 'manual'); assert.equal(model.recovery.mode, 'manual');
  assert.match(model.recoveryText, /Manual/);
  const response = await h.recover({ ...recoveryBody(model.recovery), action: 'reload_current' }), body = JSON.parse(response.body);
  assert.equal(response.status, 200); assert.equal(body.mode, 'manual'); assert.equal(body.value, 1);
  assert.equal(h.status().held, null); assert.equal(h.status().profile.mode, 'manual');
  assert.equal(h.status().profile.manualValue, 1); assert.equal(h.posts.length, posted);
  const m = h.stored().machines['s:' + serial];
  assert.equal(m.expected, 1); assert.equal(m.overrides['t:Filter3'], 1);
  assert.deepEqual(m.programs, before.programs, 'the automatic record survives for a later explicit Auto');
  assert.deepEqual(m.programs[filterKey], { target: 1.35, applied: 1.13 });
  assert.equal(m.overrides['t:' + dflow.title], 1); assert.equal(m.baseline, before.baseline);
  assert.deepEqual(m.consumed, before.consumed);
  assert.equal(h.stored().lastRecovery.authority, 'operator_confirmed_reload_current');
  assert.equal(h.stored().lastRecovery.previous.override, 2);
  assert.equal(h.stored().lastRecovery.previous.program.applied, 1.13);
  assert.deepEqual(h.status().decisions[0].reason, 'recovered_manual');
});

test('Auto stays Automatic across a reload with zero commands and later recalls the accepted value', async () => {
  const { h, filter, filterKey } = await reloadHold('auto');
  await h.recover({ ...recoveryBody((await h.view()).recovery), action: 'reload_current' });
  const restart = harness({ saved: h.stored() }); restart.current = 1; restart.workflow = h.workflow; await restart.start();
  assert.equal(restart.status().held, null); assert.equal(restart.status().ready, true);
  assert.equal(restart.status().profile.mode, 'auto'); assert.equal(restart.posts.length, 0);
  await restart.select({ ...filter, title: 'Other profile' });
  await restart.select(filter);
  assert.deepEqual(restart.posts.map(p => p.flowMultiplier), [2, 1], 'the accepted value is recalled, never the old command');
  assert.equal(restart.stored().machines['s:' + serial].programs[filterKey].applied, 1);
});

test('a Manual reload needs no command on restart and keeps other profile choices intact', async () => {
  const { h, dflow } = await reloadHold('manual');
  await h.recover({ ...recoveryBody((await h.view()).recovery), action: 'reload_current' });
  const restart = harness({ saved: h.stored() }); restart.current = 1; restart.workflow = h.workflow; await restart.start();
  assert.equal(restart.status().held, null); assert.equal(restart.status().profile.mode, 'manual');
  assert.equal(restart.status().profile.manualValue, 1); assert.equal(restart.posts.length, 0);
  assert.equal(restart.stored().machines['s:' + serial].overrides['t:' + dflow.title], 1);
});

test('after an Auto reload a delayed pre-recovery shot is ignored but a genuinely new shot still learns', async () => {
  const { h, filter, filterKey } = await reloadHold('auto');
  await h.recover({ ...recoveryBody((await h.view()).recovery), action: 'reload_current' });
  // Controlled timestamps around the stored recovery cutoff, not the host clock.
  const cutoff = h.stored().machines['s:' + serial].recoveryCutoff;
  assert.equal(typeof cutoff, 'number'); assert.ok(isFinite(cutoff));
  const delayed = shot('delayed', 1.6);
  delayed.timestamp = new Date(cutoff - 1000).toISOString(); delayed.workflow.profile = structuredClone(filter);
  h.shots.push(delayed);
  await h.store('delayed');
  assert.equal(h.posts.length, 0); assert.equal(h.current, 1);
  assert.ok(h.status().decisions.some(d => d.reason === 'old_or_duplicate_shot'));
  assert.deepEqual(h.stored().machines['s:' + serial].programs[filterKey], { target: 1, applied: 1 });
  const fresh = shot('fresh', 1.6);
  fresh.timestamp = new Date(cutoff + 60000).toISOString(); fresh.workflow.profile = structuredClone(filter);
  h.shots.push(fresh); await h.store('fresh');
  assert.deepEqual(h.posts.map(p => p.flowMultiplier), [1.6]);
  assert.equal(h.status().profile.mode, 'auto');
  const learned = h.stored().machines['s:' + serial].programs[filterKey];
  assert.equal(learned.applied, 1.6); assert.ok(Math.abs(learned.target - 1.6) < 1e-9);
});

test('the reload authority is explicit: old matching-only requests, typed targets and stale reviews fail closed', async () => {
  const { h } = await reloadHold('auto'), before = h.stored(), posted = h.posts.length;
  const review = (await h.view()).recovery;
  // A stale 2.0.1 page sends no action: matching-only Manual semantics, so the mismatch fails clearly.
  assert.equal((await h.recover(recoveryBody(review))).status, 409);
  for (const body of [
    { ...recoveryBody(review), action: 'reload_current', confirmSettled: false },
    { ...recoveryBody(review), action: 'reset_ledger' },
    { ...recoveryBody(review), action: 'reload_current', value: 1.5 },
    { ...recoveryBody(review), action: 'reload_current', value: 1.0001 },
    { ...recoveryBody(review), action: 'reload_current', context: 'stale' },
    { ...recoveryBody(review), action: 'reload_current', profileKey: 'p:other' },
  ]) assert.ok((await h.recover(body)).status >= 400);
  assert.deepEqual(h.stored(), before); assert.equal(h.posts.length, posted);
  assert.ok(h.status().held); assert.ok(h.status().unresolvedIntent); assert.equal(h.status().profile.mode, 'auto');
  h.machine.model = 'DE1Plus';
  const wrong = await h.view();
  assert.equal(wrong.recovery.available, false); assert.equal(wrong.recovery.reason, 'wrong_machine');
  assert.deepEqual(h.stored(), before);
});

test('reload-current persistence failures and missing acknowledgements keep the hold and claim no success', async () => {
  for (const offset of [1, 2]) {
    const { h } = await reloadHold('auto'), body = { ...recoveryBody((await h.view()).recovery), action: 'reload_current' };
    h.failStorageAt = h.storageAttempts + offset;
    const response = await h.recover(body);
    assert.ok(response.status >= 400); assert.notEqual(JSON.parse(response.body).saved, true);
    assert.ok(h.status().held); assert.ok(h.stored().pending); assert.equal(h.posts.length, 0);
    assert.equal(h.status().profile.mode, 'auto');
    const events = h.storageAttempts;
    await h.event('stateUpdate', {}); await h.event('workflowUpdated', h.workflow); await h.store();
    assert.equal(h.storageAttempts, events); assert.equal(h.posts.length, 0, 'no automatic retry');
    const restart = harness({ saved: h.stored() }); restart.current = 1; restart.workflow = h.workflow; await restart.start();
    assert.ok(restart.status().held); assert.equal(restart.posts.length, 0);
  }
  const { h: noAck } = await reloadHold('auto', { ack: false }), review = (await noAck.view()).recovery;
  assert.ok((await noAck.recover({ ...recoveryBody(review), action: 'reload_current' })).status >= 400);
  assert.equal(noAck.status().held, 'storage_ack_timeout'); assert.equal(noAck.posts.length, 0);
  const restart = harness({ saved: noAck.stored() }); restart.current = 1; restart.workflow = noAck.workflow; await restart.start();
  assert.equal(restart.status().held, 'unresolved_write_intent'); assert.equal(restart.posts.length, 0);
  // The durable result of the ambiguous write is either retained intent or a committed reload; both reload safely.
  const retry = await restart.view();
  assert.equal(retry.recovery.available, true); assert.equal(retry.recovery.mode, 'auto');
  const again = await restart.recover({ ...recoveryBody(retry.recovery), action: 'reload_current' });
  assert.equal(again.status, 200); assert.equal(restart.status().held, null);
  assert.equal(restart.status().profile.mode, 'auto'); assert.equal(restart.posts.length, 0);
});

test('a second reload request cannot start while the first is still committing', async () => {
  const { h } = await reloadHold('auto'), review = (await h.view()).recovery;
  const body = { ...recoveryBody(review), action: 'reload_current' };
  const first = h.plugin.__httpRequestHandler({ endpoint: 'recover', method: 'POST', body });
  assert.equal((await h.recover(body)).status, 409);
  assert.equal((await first).status, 200);
  assert.equal(h.posts.length, 0); assert.equal(h.stored().machines['s:' + serial].expected, 1);
});

test('a legacy intent without a recorded model uses the same reload; a recorded model mismatch still blocks', async () => {
  const seeded = await reloadHold('auto'), saved = seeded.h.stored(); delete saved.pending.model;
  const h = harness({ saved }); h.current = 1; h.workflow = seeded.h.workflow; await h.start();
  assert.ok(h.status().held);
  const review = (await h.view()).recovery;
  assert.equal(review.available, true); assert.equal(review.mode, 'auto'); assert.equal(review.command, 2); assert.equal(review.value, 1);
  const response = await h.recover({ ...recoveryBody(review), action: 'reload_current' });
  assert.equal(response.status, 200); assert.equal(h.status().profile.mode, 'auto'); assert.equal(h.posts.length, 0);
  const bound = seeded.h.stored(); bound.pending.model = 'DE1Plus';
  const wrong = harness({ saved: bound }); wrong.current = 1; wrong.workflow = seeded.h.workflow; await wrong.start();
  const blocked = await wrong.view();
  assert.equal(blocked.recovery.available, false); assert.equal(blocked.recovery.reason, 'wrong_machine');
  assert.equal(wrong.posts.length, 0);
});

test('a value change or busy machine during reload preparation aborts without writing', async () => {
  const { h } = await reloadHold('auto'), before = h.stored(), body = { ...recoveryBody((await h.view()).recovery), action: 'reload_current' };
  h.hook = u => { if (u.pathname.endsWith('/shots')) h.current = 1.2; };
  assert.equal((await h.recover(body)).status, 409);
  assert.deepEqual(h.stored(), before); assert.equal(h.posts.length, 0);
  assert.ok(h.status().held); assert.ok(h.status().unresolvedIntent);
  const busy = await reloadHold('auto'), settled = busy.h.stored(), request = { ...recoveryBody((await busy.h.view()).recovery), action: 'reload_current' };
  busy.h.hook = u => { if (u.pathname.endsWith('/shots')) busy.h.state = 'espresso'; };
  assert.equal((await busy.h.recover(request)).status, 409);
  assert.deepEqual(busy.h.stored(), settled); assert.equal(busy.h.posts.length, 0);
  assert.ok(busy.h.status().held); assert.ok(busy.h.status().unresolvedIntent);
});

test('a lost completion acknowledgement may still have persisted a finished reload', async () => {
  const seeded = await reloadHold('auto'), saved = seeded.h.stored();
  const h = harness({ saved, ackAt: 2 }); h.current = 1; h.workflow = seeded.h.workflow; await h.start();
  const response = await h.recover({ ...recoveryBody((await h.view()).recovery), action: 'reload_current' });
  assert.ok(response.status >= 400); assert.equal(h.status().held, 'storage_ack_timeout'); assert.equal(h.posts.length, 0);
  const persisted = h.stored();
  assert.equal(persisted.pending, null, 'the completion write landed even though its acknowledgement was lost');
  assert.equal(persisted.lastRecovery.mode, 'auto'); assert.equal(persisted.lastRecovery.value, 1);
  const restart = harness({ saved: persisted }); restart.current = 1; restart.workflow = h.workflow; await restart.start();
  assert.equal(restart.status().held, null); assert.equal(restart.status().unresolvedIntent, null);
  assert.equal(restart.status().profile.mode, 'auto'); assert.equal(restart.posts.length, 0);
});

for (const mode of ['auto', 'manual']) {
  test(`a ${mode} reload retried after a failed completion keeps the state it replaced in the audit`, async () => {
    const { h, filterKey } = await reloadHold(mode), record = h.stored().machines['s:' + serial];
    const replaced = { expected: record.expected, baseline: record.baseline, program: record.programs[filterKey],
      override: record.overrides['t:Filter3'] === undefined ? null : record.overrides['t:Filter3'] };
    h.failStorageAt = h.storageAttempts + 2; // the preparation lands, the completion write fails
    const first = await h.recover({ ...recoveryBody((await h.view()).recovery), action: 'reload_current' });
    assert.ok(first.status >= 400); assert.notEqual(JSON.parse(first.body).saved, true);
    assert.ok(h.status().held); assert.equal(h.posts.length, 0);
    const prepared = h.stored();
    assert.ok(prepared.pending, 'the old intent stays durable until completion');
    assert.deepEqual(prepared.lastRecovery.previous, replaced);
    const restart = harness({ saved: prepared }); restart.current = 1; restart.workflow = h.workflow; await restart.start();
    assert.equal(restart.status().held, 'unresolved_write_intent'); assert.equal(restart.posts.length, 0);
    const review = (await restart.view()).recovery;
    assert.equal(review.available, true); assert.equal(review.mode, mode);
    const retry = await restart.recover({ ...recoveryBody(review), action: 'reload_current' });
    assert.equal(retry.status, 200); assert.equal(JSON.parse(retry.body).saved, true); assert.equal(restart.posts.length, 0);
    const audit = restart.stored().lastRecovery, m = restart.stored().machines['s:' + serial];
    assert.deepEqual(audit.previous, replaced, 'the original replaced state survives the retry');
    assert.deepEqual(audit.previousIntent, prepared.lastRecovery.previousIntent);
    assert.equal(audit.previousIntent.command, 2); assert.equal(audit.previousIntent.key, filterKey);
    assert.equal(audit.attempts, 2); assert.equal(audit.status, 'completed'); assert.equal(audit.mode, mode);
    assert.ok(audit.cutoff >= prepared.lastRecovery.cutoff, 'the retry keeps a monotonic cutoff');
    assert.equal(m.expected, 1); assert.ok(m.recoveryCutoff >= prepared.machines['s:' + serial].recoveryCutoff);
    assert.equal(m.recoveryCutoff, audit.cutoff);
    if (mode === 'auto') assert.deepEqual(m.programs[filterKey], { target: 1, applied: 1 });
    else { assert.equal(m.overrides['t:Filter3'], 1); assert.deepEqual(m.programs[filterKey], { target: 1.35, applied: 1.13 }); }
    const again = harness({ saved: restart.stored() }); again.current = 1; again.workflow = h.workflow; await again.start();
    assert.equal(again.status().held, null); assert.equal(again.status().profile.mode, mode); assert.equal(again.posts.length, 0);
  });

  test(`a ${mode} reload with a missing preparation acknowledgement retries from the durable state and ignores the late acknowledgement`, async () => {
    const { h, filterKey } = await reloadHold(mode, { ackAt: 1 }), record = h.stored().machines['s:' + serial];
    const replaced = { expected: record.expected, baseline: record.baseline, program: record.programs[filterKey],
      override: record.overrides['t:Filter3'] === undefined ? null : record.overrides['t:Filter3'] };
    const first = await h.recover({ ...recoveryBody((await h.view()).recovery), action: 'reload_current' });
    assert.ok(first.status >= 400); assert.notEqual(JSON.parse(first.body).saved, true);
    assert.equal(h.status().held, 'storage_ack_timeout'); assert.equal(h.posts.length, 0);
    const durable = h.stored();
    assert.ok(durable.pending, 'the acknowledged-late preparation keeps the old intent');
    assert.deepEqual(durable.lastRecovery.previous, replaced);
    const writes = h.writes.length, attempts = h.storageAttempts;
    await h.event('storageWrite', structuredClone(durable)); // the acknowledgement arrives after the timeout
    assert.equal(h.writes.length, writes); assert.equal(h.storageAttempts, attempts);
    assert.equal(h.status().held, 'storage_ack_timeout'); assert.equal(h.status().unresolvedIntent.command, 2);
    assert.equal(h.posts.length, 0);
    const retry = harness({ saved: durable }); retry.current = 1; retry.workflow = h.workflow; await retry.start();
    assert.equal(retry.status().held, 'unresolved_write_intent'); assert.equal(retry.posts.length, 0);
    const review = (await retry.view()).recovery;
    assert.equal(review.available, true); assert.equal(review.mode, mode);
    const response = await retry.recover({ ...recoveryBody(review), action: 'reload_current' });
    assert.equal(response.status, 200); assert.equal(retry.posts.length, 0);
    const audit = retry.stored().lastRecovery, m = retry.stored().machines['s:' + serial];
    assert.deepEqual(audit.previous, replaced, 'the retry does not audit the already rebased values');
    assert.equal(audit.previousIntent.command, 2); assert.equal(audit.previousIntent.key, filterKey);
    assert.equal(audit.attempts, 2); assert.equal(audit.status, 'completed');
    assert.equal(m.expected, 1); assert.ok(m.recoveryCutoff >= durable.machines['s:' + serial].recoveryCutoff);
    assert.equal(m.recoveryCutoff, audit.cutoff);
    if (mode === 'auto') assert.deepEqual(m.programs[filterKey], { target: 1, applied: 1 });
    else { assert.equal(m.overrides['t:Filter3'], 1); assert.deepEqual(m.programs[filterKey], { target: 1.35, applied: 1.13 }); }
  });
}

const unreadableAudit = [
  ['previousIntent is not an intent', audit => { audit.previousIntent = 'corrupt'; }],
  ['previousIntent is missing', audit => { delete audit.previousIntent; }],
  ['previousIntent is an array', audit => { audit.previousIntent = []; }],
  ['previousIntent names another profile', audit => { audit.previousIntent = { ...audit.previousIntent, key: 'p:other', command: 1.5 }; }],
  ['previousIntent holds an unsupported command', audit => { audit.previousIntent = { ...audit.previousIntent, command: 9 }; }],
  ['previousIntent lost the recorded model', audit => { delete audit.previousIntent.model; }],
  ['previous is an array', audit => { audit.previous = []; }],
  ['previous is missing', audit => { delete audit.previous; }],
  ['previous is null', audit => { audit.previous = null; }],
  ['previous expected is not a multiplier', audit => { audit.previous.expected = 'bad'; }],
  ['previous baseline is out of bounds', audit => { audit.previous.baseline = 3; }],
  ['previous program is an array', audit => { audit.previous.program = []; }],
  ['previous program target is out of bounds', audit => { audit.previous.program = { target: 9, applied: 2 }; }],
  ['previous program applied value is unreadable', audit => { audit.previous.program = { target: 2, applied: 'bad' }; }],
  ['previous override is not a multiplier', audit => { audit.previous.override = 'bad'; }],
  ['attempts is not a number', audit => { audit.attempts = 'bad'; }],
  ['attempts is zero', audit => { audit.attempts = 0; }],
  ['attempts is fractional', audit => { audit.attempts = 1.5; }],
  ['attempts is missing', audit => { delete audit.attempts; }],
  ['firstAt is not a timestamp', audit => { audit.firstAt = 'bad'; }],
  ['firstAt is not a string', audit => { audit.firstAt = 42; }],
];

for (const [label, corrupt] of unreadableAudit) {
  test(`a prepared reload with unreadable provenance (${label}) fails closed and keeps the retained intent`, async () => {
    const { saved, filter } = await preparedReload('auto');
    const record = saved.machines['s:' + serial];
    corrupt(saved.lastRecovery);
    const corruptRecord = structuredClone(saved);
    const h = harness({ saved }); h.current = 1; h.workflow = { profile: structuredClone(filter) }; await h.start();
    assert.deepEqual(h.stored(), corruptRecord, 'reloading an unreadable audit does not rewrite it');
    const review = (await h.view()).recovery;
    assert.equal(review.available, true); assert.equal(review.mode, 'auto');
    const writes = h.writes.length;
    const response = await h.recover({ ...recoveryBody(review), action: 'reload_current' }), body = JSON.parse(response.body);
    assert.ok(response.status >= 400, 'an unreadable audit is never a successful recovery');
    assert.notEqual(body.saved, true); assert.equal(body.error, 'invalid_recovery_audit');
    const after = h.stored();
    assert.equal(h.writes.length, writes, 'nothing is durably rewritten before the audit is proven readable');
    assert.deepEqual(after, corruptRecord, 'the retained intent, ledger and audit stay exactly as they were');
    assert.deepEqual(after.pending, saved.pending, 'no original intent audit is destroyed');
    assert.deepEqual(after.machines['s:' + serial], record, 'the ledger is not rebased');
    assert.equal(after.pending.command, 2); assert.equal(after.pending.key, review.profileKey);
    assert.equal(h.posts.length, 0, 'recovery never sends a calibration command');
    assert.equal(h.status().held, 'unresolved_write_intent'); assert.equal(h.status().unresolvedIntent.command, 2);
    assert.equal(h.status().profile.mode, 'auto');
  });
}

// Provenance is only readable while it is the SAME original intent: a grid-valid but different command,
// expected value, kind or shot id would otherwise replace the original intent audit the retry carries forward.
const driftedAudit = [
  ['previousIntent holds another expected value', audit => { audit.previousIntent.expected = 1.5; }],
  ['previousIntent holds another command', audit => { audit.previousIntent.command = 1.35; }],
  ['previousIntent holds another kind', audit => { audit.previousIntent.kind = 'manual'; }],
  ['previousIntent holds another shot id', audit => { audit.previousIntent.shotId = 'another-shot'; }],
  ['previousIntent invents a shot id the retained intent never had', audit => { audit.previousIntent.shotId = 7; }],
];

for (const [label, corrupt] of driftedAudit) {
  test(`a prepared reload whose audit keeps only the machine and profile (${label}) fails closed`, async () => {
    const { saved, filter } = await preparedReload('auto');
    const record = saved.machines['s:' + serial], pristine = structuredClone(saved.lastRecovery.previousIntent);
    corrupt(saved.lastRecovery);
    const corruptRecord = structuredClone(saved);
    const h = harness({ saved }); h.current = 1; h.workflow = { profile: structuredClone(filter) }; await h.start();
    const review = (await h.view()).recovery;
    assert.equal(review.available, true); assert.equal(review.mode, 'auto');
    const writes = h.writes.length;
    const response = await h.recover({ ...recoveryBody(review), action: 'reload_current' }), body = JSON.parse(response.body);
    assert.ok(response.status >= 400, 'a different original intent is never a successful recovery');
    assert.notEqual(body.saved, true); assert.equal(body.error, 'invalid_recovery_audit');
    assert.equal(body.field, 'previousIntent');
    const after = h.stored();
    assert.equal(h.writes.length, writes, 'nothing is durably rewritten before the audit is proven readable');
    assert.deepEqual(after, corruptRecord, 'the retained intent, ledger and audit stay exactly as they were');
    assert.deepEqual(after.pending, saved.pending, 'the original intent is never replaced by the drifted one');
    assert.deepEqual(after.machines['s:' + serial], record, 'the ledger is not rebased');
    assert.equal(h.posts.length, 0, 'recovery never sends a calibration command');
    assert.equal(h.status().held, 'unresolved_write_intent'); assert.equal(h.status().profile.mode, 'auto');
    assert.notDeepEqual(after.lastRecovery.previousIntent, pristine, 'the unreadable provenance is never rebuilt from the retained intent');
  });
}

// The persisted marker joins its fields with '|', and a profile key or shot id may itself contain that separator.
// A record that only reproduces the joined string is not this same attempt: the fields themselves decide, so a
// shot id shifted into the key fails closed instead of consuming the retained intent.
test('a prepared reload whose audit only reproduces the joined marker from shifted fields fails closed', async () => {
  const { h, filter, filterKey } = await reloadHold('auto'), saved = h.stored();
  saved.pending.shotId = 'left|right';
  const first = harness({ saved }); first.current = 1; first.workflow = { profile: structuredClone(filter) }; await first.start();
  first.failStorageAt = first.storageAttempts + 2;
  assert.ok((await first.recover({ ...recoveryBody((await first.view()).recovery), action: 'reload_current' })).status >= 400);
  const prepared = first.stored();
  assert.ok(prepared.pending); assert.equal(prepared.lastRecovery.status, 'prepared');
  assert.equal(prepared.lastRecovery.previousIntent.key, filterKey);
  assert.equal(prepared.lastRecovery.previousIntent.shotId, 'left|right');
  // Moving the separator moves the same characters into another field: the joined marker is unchanged.
  prepared.lastRecovery.previousIntent.key = filterKey + '|left';
  prepared.lastRecovery.previousIntent.shotId = 'right';
  const marker = i => [i.serial, i.model, i.key, String(i.shotId), i.expected, i.command, i.kind].join('|');
  assert.equal(marker(prepared.lastRecovery.previousIntent), prepared.lastRecovery.intent);
  const corruptRecord = structuredClone(prepared);
  const restart = harness({ saved: prepared }); restart.current = 1; restart.workflow = { profile: structuredClone(filter) }; await restart.start();
  assert.equal(restart.status().held, 'unresolved_write_intent');
  const review = (await restart.view()).recovery;
  assert.equal(review.available, true); assert.equal(review.mode, 'auto'); assert.equal(review.command, 2);
  const writes = restart.writes.length;
  const response = await restart.recover({ ...recoveryBody(review), action: 'reload_current' }), body = JSON.parse(response.body);
  assert.equal(response.status, 409, 'a marker collision is never a successful recovery');
  assert.equal(body.error, 'invalid_recovery_audit'); assert.equal(body.field, 'previousIntent');
  assert.notEqual(body.saved, true);
  const after = restart.stored();
  assert.equal(restart.writes.length, writes, 'nothing is durably rewritten before the audit is proven readable');
  assert.deepEqual(after, corruptRecord, 'the retained intent, ledger and audit stay exactly as they were');
  assert.deepEqual(after.pending, corruptRecord.pending, 'the retained intent is not consumed');
  assert.deepEqual(after.lastRecovery, corruptRecord.lastRecovery, 'the shifted provenance is never carried forward');
  assert.deepEqual(after.machines['s:' + serial], corruptRecord.machines['s:' + serial], 'the ledger is not rebased');
  assert.equal(restart.posts.length, 0, 'recovery never sends a calibration command');
  assert.equal(restart.status().profile.mode, 'auto'); assert.equal(restart.status().unresolvedIntent.command, 2);
});

// The separator is legal inside a profile key or shot id, so a pipe-containing intent is still one single
// intent: it must retry exactly like any other one.
test('a prepared reload whose original intent contains the marker separator still retries', async () => {
  const piped = { title: 'Filter|3', version: '1', steps: [{ name: 'pour|two', flow: 2 }] };
  const dflow = { title: 'D-Flow / Step-down', version: '1', steps: [{ name: 'pour', pressure: 6 }] };
  const seed = harness(); seed.current = 2; seed.workflow = { profile: structuredClone(piped) }; await seed.start();
  const pipedKey = seed.status().profile.key;
  assert.ok(pipedKey.indexOf('|') > 0, 'the fixture key contains the marker separator');
  await seed.select(dflow); await seed.mode('manual', 1);
  const saved = seed.stored(), record = saved.machines['s:' + serial];
  record.programs[pipedKey] = { target: 2, applied: 2 };
  saved.pending = { serial, model: 'DE1Pro', key: pipedKey, shotId: 'left|right', expected: 2, command: 2, kind: 'learning' };
  const h = harness({ saved }); h.current = 1; h.workflow = { profile: structuredClone(piped) }; await h.start();
  h.failStorageAt = h.storageAttempts + 2; // the preparation lands, the completion write fails
  assert.ok((await h.recover({ ...recoveryBody((await h.view()).recovery), action: 'reload_current' })).status >= 400);
  const prepared = h.stored();
  assert.ok(prepared.pending); assert.equal(prepared.lastRecovery.status, 'prepared');
  assert.equal(prepared.lastRecovery.previousIntent.key, pipedKey);
  assert.equal(prepared.lastRecovery.previousIntent.shotId, 'left|right');
  const restart = harness({ saved: prepared }); restart.current = 1; restart.workflow = { profile: structuredClone(piped) }; await restart.start();
  assert.equal(restart.status().held, 'unresolved_write_intent');
  const retry = await restart.recover({ ...recoveryBody((await restart.view()).recovery), action: 'reload_current' });
  assert.equal(retry.status, 200); assert.equal(JSON.parse(retry.body).saved, true);
  const audit = restart.stored().lastRecovery, m = restart.stored().machines['s:' + serial];
  assert.equal(audit.status, 'completed'); assert.equal(audit.attempts, 2); assert.equal(audit.mode, 'auto');
  assert.deepEqual(audit.previousIntent, prepared.lastRecovery.previousIntent);
  assert.equal(m.expected, 1); assert.deepEqual(m.programs[pipedKey], { target: 1, applied: 1 });
  assert.equal(restart.stored().pending, null); assert.equal(restart.posts.length, 0);
});

// A prepared reload that survives only in part is still the same attempt: the retry must never discard it and
// rebuild the replaced-profile audit out of the values the failed preparation already rebased.
const partialAudit = [
  ['status is missing', audit => { delete audit.status; }, 'status'],
  ['status is unreadable', audit => { audit.status = 42; }, 'status'],
  ['status is null', audit => { audit.status = null; }, 'status'],
  ['status is an unknown value', audit => { audit.status = 'applied'; }, 'status'],
  ['intent is missing', audit => { delete audit.intent; }, 'intent'],
  ['intent is unreadable', audit => { audit.intent = 42; }, 'intent'],
  ['intent is an array', audit => { audit.intent = []; }, 'intent'],
  ['intent names another attempt', audit => { audit.intent = audit.intent.replace(/\|learning$/, '|recall'); }, 'intent'],
];

for (const [label, corrupt, field] of partialAudit) {
  test(`a prepared reload whose audit keeps only part of the attempt (${label}) fails closed on that field`, async () => {
    const { saved, filter } = await preparedReload('auto');
    const record = saved.machines['s:' + serial], previous = structuredClone(saved.lastRecovery.previous);
    corrupt(saved.lastRecovery);
    const corruptRecord = structuredClone(saved);
    const h = harness({ saved }); h.current = 1; h.workflow = { profile: structuredClone(filter) }; await h.start();
    assert.deepEqual(h.stored(), corruptRecord, 'reloading a partially unreadable audit does not rewrite it');
    const review = (await h.view()).recovery;
    assert.equal(review.available, true); assert.equal(review.mode, 'auto');
    assert.equal(review.command, 2); assert.equal(review.value, 1);
    const writes = h.writes.length;
    const response = await h.recover({ ...recoveryBody(review), action: 'reload_current' }), body = JSON.parse(response.body);
    assert.equal(response.status, 409, 'the surviving part of the attempt is validated, not bypassed');
    assert.equal(body.error, 'invalid_recovery_audit'); assert.equal(body.field, field); assert.equal(body.saved, undefined);
    const after = h.stored();
    assert.equal(h.writes.length, writes, 'nothing is durably rewritten before the audit is proven readable');
    assert.deepEqual(after, corruptRecord, 'the retained intent, ledger and audit stay exactly as they were');
    assert.deepEqual(after.pending, saved.pending, 'the retained intent is not consumed');
    assert.deepEqual(after.machines['s:' + serial], record, 'the ledger is not rebased from the prepared values');
    assert.deepEqual(after.lastRecovery.previous, previous, 'the replaced profile audit is not rebuilt from the rebased values');
    assert.equal(h.posts.length, 0, 'recovery never sends a calibration command');
    assert.equal(h.status().held, 'unresolved_write_intent'); assert.equal(h.status().unresolvedIntent.command, 2);
    assert.equal(h.status().profile.mode, 'auto');
  });
}

test('a prepared reload that lost both its status and its intent is still recognized by its original intent', async () => {
  const { saved, filter } = await preparedReload('auto');
  delete saved.lastRecovery.status; delete saved.lastRecovery.intent;
  const corruptRecord = structuredClone(saved);
  const h = harness({ saved }); h.current = 1; h.workflow = { profile: structuredClone(filter) }; await h.start();
  const review = (await h.view()).recovery;
  assert.equal(review.available, true); assert.equal(review.command, 2);
  const writes = h.writes.length;
  const response = await h.recover({ ...recoveryBody(review), action: 'reload_current' }), body = JSON.parse(response.body);
  assert.equal(response.status, 409); assert.equal(body.error, 'invalid_recovery_audit'); assert.equal(body.field, 'status');
  assert.equal(h.writes.length, writes); assert.deepEqual(h.stored(), corruptRecord);
  assert.equal(h.posts.length, 0);
});

test('a prepared legacy reload keeps retrying while both the intent and its audit omit the model', async () => {
  const seeded = await reloadHold('auto'), saved = seeded.h.stored();
  delete saved.pending.model;
  const h = harness({ saved }); h.current = 1; h.workflow = seeded.h.workflow; await h.start();
  h.failStorageAt = h.storageAttempts + 2;
  assert.ok((await h.recover({ ...recoveryBody((await h.view()).recovery), action: 'reload_current' })).status >= 400);
  const prepared = h.stored();
  assert.ok(prepared.pending); assert.equal(prepared.pending.model, undefined);
  assert.equal(prepared.lastRecovery.previousIntent.model, undefined, 'a legacy intent is audited without a model');
  const restart = harness({ saved: prepared }); restart.current = 1; restart.workflow = seeded.h.workflow; await restart.start();
  assert.equal(restart.status().held, 'unresolved_write_intent');
  const retry = await restart.recover({ ...recoveryBody((await restart.view()).recovery), action: 'reload_current' });
  assert.equal(retry.status, 200); assert.equal(JSON.parse(retry.body).saved, true);
  assert.equal(restart.posts.length, 0);
  const audit = restart.stored().lastRecovery, m = restart.stored().machines['s:' + serial];
  assert.equal(restart.stored().pending, null); assert.equal(audit.status, 'completed');
  assert.equal(audit.previousIntent.command, 2); assert.equal(audit.previousIntent.model, undefined);
  assert.equal(m.expected, 1); assert.equal(restart.status().profile.mode, 'auto');
});

test('a Manual prepared reload with unreadable provenance also fails closed and stays Manual', async () => {
  const { saved, filter } = await preparedReload('manual');
  saved.lastRecovery.previousIntent = 'corrupt'; saved.lastRecovery.previous = []; saved.lastRecovery.attempts = 'bad';
  const corruptRecord = structuredClone(saved);
  const h = harness({ saved }); h.current = 1; h.workflow = { profile: structuredClone(filter) }; await h.start();
  const review = (await h.view()).recovery;
  assert.equal(review.available, true); assert.equal(review.mode, 'manual');
  const response = await h.recover({ ...recoveryBody(review), action: 'reload_current' }), body = JSON.parse(response.body);
  assert.ok(response.status >= 400); assert.equal(body.error, 'invalid_recovery_audit'); assert.notEqual(body.saved, true);
  assert.deepEqual(h.stored(), corruptRecord); assert.equal(h.posts.length, 0);
  assert.equal(h.status().profile.mode, 'manual'); assert.equal(h.status().unresolvedIntent.command, 2);
});

// A paused intent records either a shot name or null for a change that had no shot. Those are the only shapes
// the controller ever persists, so anything else is unreadable saved state: it must stop hydration instead of
// being read back as a usable intent.
const malformedShotIds = [['an array', []], ['an object', {}], ['a number', 7], ['a boolean', true]];

for (const [label, shotId] of malformedShotIds) {
  test(`a paused intent with a malformed shot id (${label}) is refused as invalid saved state`, async () => {
    const { h: seed, filter } = await reloadHold('auto'), saved = seed.stored();
    saved.pending.shotId = shotId;
    const corruptRecord = structuredClone(saved);
    const h = harness({ saved }); h.current = 1; h.workflow = { profile: structuredClone(filter) }; await h.start();
    assert.equal(h.status().held, 'invalid_saved_state', 'unreadable saved state is refused, never hydrated');
    assert.equal(h.status().ready, false); assert.equal(h.status().unresolvedIntent, null);
    assert.equal(h.writes.length, 0, 'refused saved state is never rewritten');
    assert.deepEqual(h.stored(), corruptRecord, 'the unreadable record is retained exactly as stored');
    assert.equal((await h.view()).recovery, null, 'no review is offered for unreadable state');
    const response = await h.recover({ context: 'stale', profileKey: 'p:stale', value: 1, confirmSettled: true, action: 'reload_current' });
    assert.equal(response.status, 409); assert.equal(JSON.parse(response.body).error, 'recovery_unavailable');
    assert.equal(h.writes.length, 0); assert.equal(h.posts.length, 0, 'recovery never sends a calibration command');
    assert.deepEqual(h.stored(), corruptRecord, 'the unreadable record is still retained');
  });
}

// Provenance is only readable while it is literally the same original intent. A shot id that merely coerces to
// the same text (an array, an object, a number or a boolean), or an empty name standing in for "no shot at all",
// is a different record: it fails closed instead of consuming the retained intent.
// The persisted marker folds an absent shot id and an empty name alike, so every one of these records reproduces
// the retained intent's marker exactly: only the fields themselves can refuse them.
const intentMarker = i => [i.serial, i.model === undefined ? '' : i.model, i.key,
  i.shotId === null || i.shotId === undefined ? '' : String(i.shotId), i.expected, i.command, i.kind].join('|');
const shotIdShapes = [
  ['an array where the intent has no shot', null, audit => { audit.previousIntent.shotId = []; }],
  ['an array where the intent has an empty name', '', audit => { audit.previousIntent.shotId = []; }],
  ['an array around the same name', 'left', audit => { audit.previousIntent.shotId = ['left']; }],
  ['an object where the intent holds the object string', '[object Object]', audit => { audit.previousIntent.shotId = {}; }],
  ['a number where the intent holds its string', '7', audit => { audit.previousIntent.shotId = 7; }],
  ['a boolean where the intent holds its string', 'true', audit => { audit.previousIntent.shotId = true; }],
  ['an empty name where the intent has no shot', omittedShotId, audit => { audit.previousIntent.shotId = ''; }],
  ['no shot where the intent has an empty name', '', audit => { delete audit.previousIntent.shotId; }],
];

for (const [label, shotId, corrupt] of shotIdShapes) {
  test(`a prepared reload whose audit holds a different shot id (${label}) fails closed`, async () => {
    const { saved, filter } = await preparedShot(shotId);
    const record = saved.machines['s:' + serial];
    corrupt(saved.lastRecovery);
    assert.equal(intentMarker(saved.lastRecovery.previousIntent), saved.lastRecovery.intent,
      'the joined marker alone would call this the same attempt');
    const corruptRecord = structuredClone(saved);
    const h = harness({ saved }); h.current = 1; h.workflow = { profile: structuredClone(filter) }; await h.start();
    assert.equal(h.status().held, 'unresolved_write_intent');
    const review = (await h.view()).recovery;
    assert.equal(review.available, true); assert.equal(review.mode, 'auto'); assert.equal(review.command, 2);
    const writes = h.writes.length;
    const response = await h.recover({ ...recoveryBody(review), action: 'reload_current' }), body = JSON.parse(response.body);
    assert.equal(response.status, 409, 'a coerced shot id is never a successful recovery');
    assert.equal(body.error, 'invalid_recovery_audit'); assert.equal(body.field, 'previousIntent'); assert.equal(body.saved, undefined);
    const after = h.stored();
    assert.equal(h.writes.length, writes, 'nothing is durably rewritten before the audit is proven readable');
    assert.deepEqual(after, corruptRecord, 'the retained intent, ledger and audit stay exactly as they were');
    assert.deepEqual(after.pending, corruptRecord.pending, 'the retained intent is not consumed');
    assert.deepEqual(after.machines['s:' + serial], record, 'the ledger is not rebased');
    assert.equal(h.posts.length, 0, 'recovery never sends a calibration command');
    assert.equal(h.status().profile.mode, 'auto'); assert.equal(h.status().unresolvedIntent.command, 2);
  });
}

// The two shapes the controller itself writes stay readable, including a legacy record that never recorded a shot
// at all: an absent shot id and an explicit null both mean "this change had no shot".
test('a prepared reload keeps retrying when a legacy audit leaves the shot id absent and the intent records none', async () => {
  const { saved, filter } = await preparedReload('auto');
  delete saved.lastRecovery.previousIntent.shotId; // a legacy record never carried a shot
  const h = harness({ saved }); h.current = 1; h.workflow = { profile: structuredClone(filter) }; await h.start();
  assert.equal(h.status().held, 'unresolved_write_intent');
  const retry = await h.recover({ ...recoveryBody((await h.view()).recovery), action: 'reload_current' });
  assert.equal(retry.status, 200); assert.equal(JSON.parse(retry.body).saved, true);
  const audit = h.stored().lastRecovery, m = h.stored().machines['s:' + serial];
  assert.equal(audit.status, 'completed'); assert.equal(audit.attempts, 2);
  assert.equal(audit.previousIntent.shotId, undefined, 'an absent shot id is carried forward as absent');
  assert.equal(h.stored().pending, null); assert.equal(h.posts.length, 0);
  assert.equal(m.expected, 1); assert.deepEqual(m.programs[saved.lastRecovery.profileKey], { target: 1, applied: 1 });
});

test('a prepared legacy reload keeps retrying when the audit records no shot id and the intent omits it', async () => {
  const { saved, filter } = await preparedShot(omittedShotId);
  saved.lastRecovery.previousIntent.shotId = null; // the same absence, recorded explicitly
  const h = harness({ saved }); h.current = 1; h.workflow = { profile: structuredClone(filter) }; await h.start();
  assert.equal(h.status().held, 'unresolved_write_intent');
  const retry = await h.recover({ ...recoveryBody((await h.view()).recovery), action: 'reload_current' });
  assert.equal(retry.status, 200); assert.equal(JSON.parse(retry.body).saved, true);
  const audit = h.stored().lastRecovery;
  assert.equal(audit.status, 'completed'); assert.equal(audit.attempts, 2);
  assert.equal(audit.previousIntent.shotId, null);
  assert.equal(h.stored().pending, null); assert.equal(h.posts.length, 0);
  assert.equal(h.stored().machines['s:' + serial].expected, 1);
});

for (const [label, shotId] of [['the same shot name', 'left'], ['the same empty shot name', '']]) {
  test(`a prepared reload whose audit keeps ${label} still retries`, async () => {
    const { saved, filter } = await preparedShot(shotId);
    assert.equal(saved.lastRecovery.previousIntent.shotId, shotId);
    const h = harness({ saved }); h.current = 1; h.workflow = { profile: structuredClone(filter) }; await h.start();
    assert.equal(h.status().held, 'unresolved_write_intent');
    const review = (await h.view()).recovery;
    assert.equal(review.available, true); assert.equal(review.mode, 'auto'); assert.equal(review.command, 2);
    const retry = await h.recover({ ...recoveryBody(review), action: 'reload_current' });
    assert.equal(retry.status, 200); assert.equal(JSON.parse(retry.body).saved, true);
    const audit = h.stored().lastRecovery, m = h.stored().machines['s:' + serial];
    assert.equal(audit.status, 'completed'); assert.equal(audit.attempts, 2);
    assert.equal(audit.previousIntent.shotId, shotId);
    assert.equal(h.stored().pending, null); assert.equal(h.posts.length, 0);
    assert.equal(m.expected, 1); assert.deepEqual(m.programs[saved.lastRecovery.profileKey], { target: 1, applied: 1 });
  });
}

test('a damaged audit on an unrelated finished record never blocks a new reload', async () => {
  const { h, filter, filterKey } = await reloadHold('auto');
  await h.recover({ ...recoveryBody((await h.view()).recovery), action: 'reload_current' });
  const saved = h.stored();
  assert.equal(saved.lastRecovery.status, 'completed'); assert.equal(saved.pending, null);
  saved.lastRecovery.previousIntent = 'corrupt'; saved.lastRecovery.previous = []; saved.lastRecovery.attempts = 'bad';
  saved.pending = { serial, model: 'DE1Pro', key: filterKey, shotId: null, expected: 2, command: 2, kind: 'learning' };
  const next = harness({ saved }); next.current = 2; next.workflow = { profile: structuredClone(filter) }; await next.start();
  const review = (await next.view()).recovery;
  assert.equal(review.available, true); assert.equal(review.value, 2);
  const response = await next.recover({ ...recoveryBody(review), action: 'reload_current' });
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).saved, true);
  assert.equal(next.posts.length, 0);
  const audit = next.stored().lastRecovery;
  assert.equal(audit.status, 'completed'); assert.equal(audit.attempts, 1, 'a finished record is replaced, not retried');
  assert.equal(audit.previousIntent.command, 2); assert.equal(audit.previousIntent.kind, 'learning');
  assert.equal(audit.previousIntent.key, filterKey); assert.equal(audit.previousIntent.serial, serial);
  assert.deepEqual(audit.previous.program, { target: 1, applied: 1 }); assert.equal(audit.previous.override, null);
  assert.equal(audit.previous.expected, 1);
});

test('a finished reload audit is never lent to a later, byte-identical pause', async () => {
  const { h, filter, filterKey } = await reloadHold('auto');
  await h.recover({ ...recoveryBody((await h.view()).recovery), action: 'reload_current' });
  const completed = h.stored();
  assert.equal(completed.lastRecovery.status, 'completed');
  assert.deepEqual(completed.lastRecovery.previous.program, { target: 2, applied: 2 });
  // A new pause with the same fields must be audited from the current record, not from the finished reload.
  const next = structuredClone(completed);
  next.pending = { serial, model: 'DE1Pro', key: filterKey, shotId: null, expected: 2, command: 2, kind: 'learning' };
  const h2 = harness({ saved: next }); h2.current = 2; h2.workflow = { profile: structuredClone(filter) }; await h2.start();
  assert.equal(h2.status().held, 'unresolved_write_intent');
  const review = (await h2.view()).recovery;
  assert.equal(review.available, true); assert.equal(review.command, 2); assert.equal(review.value, 2);
  assert.equal((await h2.recover({ ...recoveryBody(review), action: 'reload_current' })).status, 200);
  const audit = h2.stored().lastRecovery;
  assert.deepEqual(audit.previous.program, { target: 1, applied: 1 }, 'the current record is audited, not the earlier snapshot');
  assert.equal(audit.previous.expected, 1); assert.equal(audit.attempts, 1);
  assert.equal(h2.posts.length, 0);
});

test('returning to the reviewed value after another read does not resurrect an earlier recovery consent', async () => {
  const { h } = await reloadHold('auto'), review = (await h.view()).recovery, before = h.stored();
  assert.equal(review.value, 1);
  h.current = 1.5; const away = (await h.view()).recovery;
  assert.equal(away.value, 1.5); assert.notEqual(away.context, review.context);
  h.current = 1; const back = (await h.view()).recovery;
  assert.equal(back.value, 1); assert.equal(back.mode, 'auto'); assert.equal(back.available, true);
  assert.notEqual(back.context, review.context, 'the old review cannot come back with the old value');
  assert.notEqual(back.context, away.context);
  const stale = await h.recover({ ...recoveryBody(review), action: 'reload_current' });
  assert.equal(stale.status, 409);
  assert.deepEqual(h.stored(), before); assert.equal(h.posts.length, 0); assert.ok(h.status().held);
  assert.equal((await h.recover({ ...recoveryBody(back), action: 'reload_current' })).status, 200);
});

test('a busy round-trip also ends the earlier recovery consent', async () => {
  const { h } = await reloadHold('manual'), review = (await h.view()).recovery, before = h.stored();
  assert.equal(review.mode, 'manual');
  h.state = 'espresso'; const busy = (await h.view()).recovery;
  assert.equal(busy.available, false); assert.equal(busy.reason, 'machine_busy');
  h.state = 'idle'; const back = (await h.view()).recovery;
  assert.equal(back.available, true); assert.equal(back.value, 1); assert.equal(back.mode, 'manual');
  assert.notEqual(back.context, review.context);
  assert.equal((await h.recover({ ...recoveryBody(review), action: 'reload_current' })).status, 409);
  assert.deepEqual(h.stored(), before); assert.equal(h.posts.length, 0); assert.ok(h.status().unresolvedIntent);
  assert.equal((await h.recover({ ...recoveryBody(back), action: 'reload_current' })).status, 200);
});

test('a review consent is mode-bound: a partially prepared legacy recovery cannot turn an Automatic consent into Manual', async () => {
  const { h } = await reloadHold('auto');
  h.current = 2; // the machine reads the paused command again, so a matching-only legacy recovery becomes possible
  h.failStorage = true;
  await h.recover({ ...recoveryBody((await h.view()).recovery), action: 'reload_current' });
  h.failStorage = false;
  assert.equal(h.status().held, 'storage_write_failed'); assert.equal(h.status().profile.mode, 'auto');
  const consent = (await h.view()).recovery, oldBody = { ...recoveryBody(consent), action: 'reload_current' };
  assert.equal(consent.mode, 'auto'); assert.equal(consent.value, 2);
  // A stale 2.0.1 page sends no action: the matching intent prepares its Manual completion, the completion write fails.
  h.failStorageAt = h.storageAttempts + 2;
  assert.ok((await h.recover(recoveryBody(consent))).status >= 400);
  h.failStorageAt = null;
  assert.equal(h.status().held, 'storage_write_failed'); assert.equal(h.status().profile.mode, 'manual');
  assert.ok(h.stored().pending, 'the old intent stays durable'); assert.equal(h.posts.length, 0);
  const prepared = h.stored();
  assert.equal(prepared.machines['s:' + serial].overrides['t:Filter3'], 2);
  const fresh = (await h.view()).recovery, again = (await h.view()).recovery;
  assert.equal(fresh.mode, 'manual'); assert.equal(fresh.value, 2); assert.equal(fresh.available, true);
  assert.notEqual(fresh.context, consent.context, 'a profile mode change must end the earlier review consent');
  assert.equal(again.context, fresh.context, 'unchanged polls keep one review context');
  // The Automatic consent is void: it may not be replayed as a Manual reload.
  assert.equal((await h.recover(oldBody)).status, 409);
  assert.deepEqual(h.stored(), prepared); assert.equal(h.posts.length, 0);
  const response = await h.recover({ ...recoveryBody(again), action: 'reload_current' }), body = JSON.parse(response.body);
  assert.equal(response.status, 200); assert.equal(body.saved, true); assert.equal(body.mode, 'manual');
  assert.equal(h.status().held, null); assert.equal(h.status().profile.mode, 'manual');
  assert.equal(h.status().profile.manualValue, 2); assert.equal(h.posts.length, 0, 'recovery never sends a calibration command');
  const m = h.stored().machines['s:' + serial];
  assert.equal(m.overrides['t:Filter3'], 2); assert.equal(m.expected, 2); assert.equal(h.stored().pending, null);
  assert.equal(h.stored().lastRecovery.authority, 'operator_confirmed_reload_current');
  assert.equal(h.stored().lastRecovery.mode, 'manual');
});

test('unchanged polls keep one review context so a normal confirmation still works', async () => {
  const { h } = await reloadHold('auto');
  const first = (await h.view()).recovery, second = (await h.view()).recovery, third = (await h.view()).recovery;
  assert.equal(second.context, first.context); assert.equal(third.context, first.context);
  assert.equal(third.value, first.value); assert.equal(third.command, first.command); assert.equal(third.mode, first.mode);
  assert.equal((await h.recover({ ...recoveryBody(third), action: 'reload_current' })).status, 200);
  assert.equal(h.posts.length, 0); assert.equal(h.status().profile.mode, 'auto');
});

test('an invalid saved recovery cutoff fails closed and a rewound clock cannot widen the exclusion', async () => {
  const { h, filter } = await reloadHold('auto');
  for (const bad of ['soon', null, NaN, Infinity, -Infinity, {}]) {
    const corrupt = h.stored(); corrupt.machines['s:' + serial].recoveryCutoff = bad;
    const rejected = harness({ saved: corrupt }); rejected.current = 1; rejected.workflow = h.workflow; await rejected.start();
    assert.equal(rejected.status().held, 'invalid_saved_state'); assert.equal(rejected.posts.length, 0);
  }
  const future = Date.parse('2030-01-01T00:00:00Z'), saved = h.stored();
  saved.machines['s:' + serial].recoveryCutoff = future;
  const reopened = harness({ saved }); reopened.current = 1; reopened.workflow = h.workflow; await reopened.start();
  const review = (await reopened.view()).recovery;
  assert.equal(review.available, true);
  assert.equal((await reopened.recover({ ...recoveryBody(review), action: 'reload_current' })).status, 200);
  const m = reopened.stored().machines['s:' + serial];
  assert.equal(m.recoveryCutoff, future, 'the earlier cutoff is not lowered when the clock is behind it');
  assert.equal(reopened.stored().lastRecovery.cutoff, future);
  const late = shot('late', 1.6); late.workflow.profile = structuredClone(filter);
  late.timestamp = new Date(future - 60000).toISOString(); reopened.shots.push(late);
  await reopened.store('late');
  assert.equal(reopened.posts.length, 0);
  assert.ok(reopened.status().decisions.some(d => d.reason === 'old_or_duplicate_shot'));
});

test('recovery never accepts an unreviewed request or a read-only request as confirmation', async () => {
  const { h } = await legacyVerificationHold(); const before = h.stored();
  assert.equal((await h.recover({ context: h.status().context, profileKey: h.status().profile?.key, value: 2, confirmSettled: true })).status, 409);
  assert.equal(h.plugin.__httpRequestHandler({ endpoint: 'recover', method: 'GET' }).status, 405);
  assert.deepEqual(h.stored(), before); assert.equal(h.posts.length, 0);
});

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
  const before = h.storageAttempts, context = h.status().context; await h.event('workflowUpdated', h.workflow);
  assert.equal(h.storageAttempts, before); assert.equal(h.status().context, context); assert.equal(h.posts.length, 1);
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

test('Auto starts from the current machine value, then learns only future shots', async () => {
  const h = harness(); await h.start(); await h.store(); await h.mode('manual', 2);
  const manual = shot('manual-shot', .7, 2); h.shots.push(manual);
  h.history = [{ timestamp: manual.timestamp }]; // Delayed manual-shot event has not arrived yet.
  const writes = h.posts.length;
  assert.equal((await h.mode('auto')).status, 200); assert.equal(h.current, 2);
  assert.equal(h.posts.length, writes, 'selecting Automatic recalls and sends nothing');
  assert.equal(h.status().profile.mode, 'auto'); await h.store('manual-shot'); assert.equal(h.current, 2);
  const future = shot('future', 1.6);
  future.timestamp = new Date(h.stored().machines['s:' + serial].recoveryCutoff + 60000).toISOString();
  h.shots.push(future); await h.store('future'); assert.equal(h.current, 1.6);
});

// Reported case: the saved Manual is 2.000, the machine reads 1.000 and Automatic used to restore 2.000.
test('an explicit Auto selection starts from the live value, sends no calibration command and keeps the saved Manual', async () => {
  const h = harness(); await h.start(); await h.store();
  assert.ok(Math.abs(h.current - 1.45) < .001); // an older automatic estimate exists
  assert.equal((await h.mode('manual', 2)).status, 200); assert.equal(h.current, 2);
  const writes = h.posts.length;
  h.current = 1; // the machine now reads 1.000
  const response = await h.mode('auto'), result = JSON.parse(response.body);
  assert.equal(response.status, 200);
  assert.deepEqual(result, { saved: true, profile: 'Trial', mode: 'auto', value: 1, calibrationCommandSent: false });
  assert.equal(h.posts.length, writes, 'selecting Automatic must never send a calibration command');
  assert.equal(h.current, 1, 'the live value is left alone');
  const m = h.stored().machines['s:' + serial];
  assert.equal(m.expected, 1); assert.equal(m.baseline, 1.13, 'the machine baseline is not rebased');
  assert.equal(m.overrides['t:Trial'], undefined);
  assert.deepEqual(m.manual, { 't:Trial': 2 }, 'the saved Manual value is remembered, not overwritten');
  assert.deepEqual(Object.values(m.programs), [{ target: 1, applied: 1 }]);
  // A value sent by a stale or modified page is ignored for Automatic: the live reading wins.
  const ignored = JSON.parse((await h.mode('auto', 1.9)).body);
  assert.equal(ignored.value, 1); assert.equal(h.posts.length, writes);
  assert.deepEqual(h.stored().machines['s:' + serial].manual, { 't:Trial': 2 });
  const s = h.status();
  assert.equal(s.profile.mode, 'auto'); assert.equal(s.profile.manualValue, null); assert.equal(s.profile.rememberedManual, 2);
  assert.equal(s.held, null); assert.equal(s.unresolvedIntent, null);
  const view = await h.view(); // a fresh read keeps the remembered value
  assert.equal(view.profile.rememberedManual, 2); assert.equal(view.profile.mode, 'auto');
});

test('an explicit Auto restart uses the live value even while already Automatic and fences older shots', async () => {
  const h = harness(); await h.start(); await h.store();
  assert.ok(h.current > 1.4); const writes = h.posts.length;
  // A newer shot is recorded but its event has not arrived, so an older shot must not look new after this restart.
  h.history = [{ timestamp: '2026-11-26T12:00:06.000000' }];
  h.shots.push(shot('late', .7, 3));
  h.current = 1.37;
  const response = await h.mode('auto');
  assert.equal(response.status, 200); assert.equal(h.posts.length, writes); assert.equal(h.current, 1.37);
  const m = h.stored().machines['s:' + serial];
  assert.equal(m.expected, 1.37);
  assert.deepEqual(Object.values(m.programs), [{ target: 1.37, applied: 1.37 }], 'not the older estimate or the baseline');
  await h.store('late');
  assert.equal(h.posts.length, writes, 'a shot that predates the explicit Auto start cannot teach it');
  assert.ok(h.status().decisions.some(d => d.reason === 'old_or_duplicate_shot'));
  const next = shot('next', 1.6);
  next.timestamp = new Date(m.recoveryCutoff + 60000).toISOString();
  h.shots.push(next); await h.store('next');
  assert.equal(h.posts.length, writes + 1, 'a genuinely new shot still learns'); assert.ok(h.current > 1.5);
});

// AC1: an empty history leaves nothing to fence against, so the start needs its own monotonic fence.
test('a delayed pre-start shot cannot teach Automatic even when the history was empty', async () => {
  const h = harness(); h.history = []; await h.start();
  assert.equal(h.stored().machines['s:' + serial].highWater, -1, 'no recorded history to fence against yet');
  h.current = 1.4;
  const startedAt = Date.now();
  assert.equal((await h.mode('auto')).status, 200);
  const writes = h.posts.length, cutoff = h.stored().machines['s:' + serial].recoveryCutoff;
  // Recorded a minute before the explicit start, and its event only arrives afterwards.
  const delayed = shot('delayed', .7); delayed.timestamp = new Date(startedAt - 60000).toISOString();
  h.shots.push(delayed); await h.store('delayed');
  assert.equal(h.posts.length, writes, 'a shot recorded before the explicit start teaches nothing');
  assert.equal(h.current, 1.4); assert.equal(h.status().profile.mode, 'auto');
  assert.ok(h.status().decisions.some(d => d.reason === 'old_or_duplicate_shot'));
  assert.equal(typeof cutoff, 'number'); assert.ok(cutoff >= startedAt, 'the start keeps a monotonic fence');
  // Controlled timestamp after the stored fence; a genuinely new shot still teaches.
  const fresh = shot('fresh', 1.6); fresh.timestamp = new Date(cutoff + 60000).toISOString();
  h.shots.push(fresh); await h.store('fresh');
  assert.equal(h.posts.length, writes + 1, 'a genuinely new shot after the start still learns');
  assert.ok(h.current > 1.5);
});

test('Auto never inherits authority from polls or Manual requests and never clears a held cause', async () => {
  const h = harness(); await h.start(); await h.mode('manual', 2);
  const state = JSON.stringify(h.stored()), writes = h.writes.length;
  h.current = .95;
  const view = await h.view();
  assert.equal(view.value, .95); assert.equal(view.outsideUpdater, true);
  assert.equal(JSON.stringify(h.stored()), state); assert.equal(h.writes.length, writes);
  // A Manual request still pauses on an external change instead of adopting it.
  assert.equal((await h.mode('manual', 2)).status, 503);
  assert.equal(h.status().held, 'external_change_detected'); assert.equal(h.current, .95);
  assert.equal((await h.mode('auto')).status, 409, 'Auto cannot clear an existing hold');
  assert.equal(h.status().held, 'external_change_detected'); assert.equal(h.posts.length, 1);
  // A durable unresolved intent still requires the existing recovery and cannot be dropped by Auto.
  const ambiguous = harness(); await ambiguous.start(); ambiguous.failPost = true;
  assert.equal((await ambiguous.mode('manual', 2)).status, 503);
  const intent = ambiguous.stored().pending; assert.ok(intent);
  assert.equal((await ambiguous.mode('auto')).status, 409);
  assert.deepEqual(ambiguous.stored().pending, intent); assert.equal(ambiguous.status().profile.mode, 'manual');
});

test('2.0.2 saved state gains the remembered Manual additively, while malformed memories fail closed', async () => {
  const h = harness(); await h.start(); await h.mode('manual', 2);
  const legacy = h.stored(); delete legacy.machines['s:' + serial].manual;
  assert.equal(legacy.version, 2); assert.deepEqual(legacy.machines['s:' + serial].overrides, { 't:Trial': 2 });
  const restart = harness({ saved: legacy }); restart.current = 2; await restart.start();
  assert.equal(restart.status().profile.mode, 'manual'); assert.equal(restart.status().profile.rememberedManual, 2);
  assert.deepEqual(restart.stored().machines['s:' + serial].manual, { 't:Trial': 2 });
  assert.equal(restart.posts.length, 0);
  for (const manual of [null, [], { bad: 2 }, { 't:bad': 3 }, { 't:bad': 1.0001 }]) {
    const corrupt = h.stored(); corrupt.machines['s:' + serial].manual = manual;
    const bad = harness({ saved: corrupt }); await bad.start();
    assert.equal(bad.status().held, 'invalid_saved_state'); assert.equal(bad.posts.length, 0);
    assert.equal(bad.status().profile, null);
  }
});

test('profile switches recall the automatic value, never the inactive Manual memory', async () => {
  const h = harness(); await h.start(); await h.store();
  assert.equal((await h.mode('manual', 2)).status, 200);
  h.current = 1;
  assert.equal((await h.mode('auto')).status, 200);
  const writes = h.posts.length;
  await h.select({ ...profile, title: 'Other program' });
  assert.equal(h.current, 1.13, 'the unchanged baseline fallback still recalls');
  await h.select(profile);
  assert.equal(h.current, 1, 'returning recalls the Auto starting value, not the remembered Manual 2.000');
  assert.deepEqual(h.posts.slice(writes).map(p => p.flowMultiplier), [1.13, 1]);
  assert.equal(h.status().profile.mode, 'auto'); assert.equal(h.status().profile.rememberedManual, 2);
});

// AC6: the acknowledged write proves the save, never the reading it started from.
test('an Auto start that changes while the write is acknowledged fails clearly and never claims a start', async () => {
  async function raced(mutate) {
    const h = harness(); await h.start(); await h.mode('manual', 2);
    h.current = 1;
    const posts = h.posts.length;
    h.ackHook = () => mutate(h); // lands after the acknowledgement, before the request continues
    const response = await h.mode('auto');
    return { h, response, body: JSON.parse(response.body), posts };
  }
  // A machine that moves on while the start is saved is no confirmed start from the value that was read.
  const value = await raced(h => { h.current = 1.5; });
  assert.equal(value.h.current, 1.5);
  assert.equal(value.response.status, 409, 'a changed reading is never reported as a confirmed start: ' + value.response.body);
  assert.deepEqual(value.body, { error: 'stale_context' });
  assert.equal(value.h.posts.length, value.posts, 'a failed start sends no calibration command');
  assert.equal(value.h.status().decisions[0].reason, 'auto_start_not_confirmed');
  assert.equal(value.h.status().held, null);
  const record = value.h.stored().machines['s:' + serial];
  assert.equal(record.expected, 1, 'the acknowledged record is kept as written; there is no atomic rollback');
  // The committed state is read back honestly: a reload rebases to the live value and sends nothing.
  const reload = harness({ saved: value.h.stored() }); reload.current = 1.5; await reload.start();
  assert.equal(reload.status().held, null); assert.equal(reload.status().profile.mode, 'auto');
  assert.equal(reload.stored().machines['s:' + serial].expected, 1.5); assert.equal(reload.posts.length, 0);
  // A profile that changes in the same window is not started from either.
  const switched = await raced(h => { h.workflow = { profile: structuredClone({ ...profile, title: 'Other program' }) }; });
  assert.equal(switched.response.status, 409); assert.deepEqual(switched.body, { error: 'stale_context' });
  assert.equal(switched.h.posts.length, switched.posts);
  // A machine that is busy when the start is acknowledged reports busy instead of success.
  const busy = await raced(h => { h.state = 'espresso'; });
  assert.equal(busy.response.status, 409); assert.deepEqual(busy.body, { error: 'machine_busy' });
  assert.equal(busy.h.posts.length, busy.posts);
  // A different machine answering mid-write fails closed through the usual hold.
  const wrong = await raced(h => { h.machine = { model: 'DE1Pro', serialNumber: 'other-de1' }; });
  assert.equal(wrong.response.status, 503); assert.equal(wrong.body.error, 'wrong_machine'); assert.equal(wrong.body.saved, undefined);
  assert.equal(wrong.h.status().held, 'wrong_machine'); assert.equal(wrong.h.posts.length, wrong.posts);
  // An unloaded plugin never reports a start either.
  const stopped = await raced(h => h.plugin.onUnload());
  assert.equal(stopped.response.status, 409); assert.equal(stopped.body.saved, undefined);
  assert.equal(stopped.h.posts.length, stopped.posts);
});

test('a confirmed Manual reload replaces the remembered Manual value; an Auto reload keeps it', async () => {
  const auto = await reloadHold('auto');
  const review = (await auto.h.view()).recovery;
  assert.equal((await auto.h.recover({ ...recoveryBody(review), action: 'reload_current' })).status, 200);
  assert.deepEqual(auto.h.stored().machines['s:' + serial].manual, { 't:D-Flow / Step-down': 1 });
  const manual = await reloadHold('manual');
  const manualReview = (await manual.h.view()).recovery;
  assert.equal((await manual.h.recover({ ...recoveryBody(manualReview), action: 'reload_current' })).status, 200);
  const m = manual.h.stored().machines['s:' + serial];
  assert.equal(m.overrides['t:Filter3'], 1); assert.equal(m.manual['t:Filter3'], 1);
  assert.equal(m.manual['t:D-Flow / Step-down'], 1);
});

test('manual-only profiles use exact multipliers including 1.000, preserve baseline and remain dose/grind independent', async () => {
  const h = harness(); await h.start();
  await h.mode('manual', 2); await h.mode('manual', 1);
  assert.deepEqual(h.posts.map(p => p.flowMultiplier), [2, 1]);
  assert.equal(Object.keys(h.stored().machines['s:' + serial].programs).length, 0);
  assert.equal(h.stored().machines['s:' + serial].baseline, 1.13);
  h.workflow.context = { targetDoseWeight: 15, grinderSetting: 'new grind' };
  await h.event('workflowUpdated', h.workflow); assert.equal(h.status().profile.manualValue, 1);
  assert.equal((await h.mode('auto')).status, 200);
  assert.equal(h.current, 1, 'Auto keeps the live value instead of recalling the baseline');
  assert.equal(h.posts.length, 2); assert.equal(h.stored().machines['s:' + serial].baseline, 1.13);
});

test('recipe edits cannot silently remove a named profile manual override', async () => {
  const h = harness(); await h.start(); await h.mode('manual', 2);
  const edited = { ...profile, version: '2', steps: [{ name: 'edited pour', pressure: 4, temperature: 85 }] };
  await h.select(edited); assert.equal(h.status().profile.mode, 'manual'); assert.equal(h.current, 2);
  const input = shot('edited-shot', .75, 2); input.workflow.profile = edited; h.shots.push(input); await h.store('edited-shot');
  assert.equal(h.current, 2); assert.equal(h.posts.length, 1);
  await h.select({ ...edited, title: 'Different profile' }); assert.equal(h.current, 1.13);
  await h.select(edited); assert.equal(h.current, 2);
  const writes = h.posts.length; await h.mode('auto');
  assert.equal(h.current, 2, 'the edited recipe starts from the live value it already has');
  assert.equal(h.posts.length, writes);
  assert.deepEqual(h.stored().machines['s:' + serial].programs[h.status().profile.key], { target: 2, applied: 2 });
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
  // A repeated Manual request still checks ownership; a conflict is not an implicit overwrite approval.
  assert.equal((await h.mode('manual', 2)).status, 503); assert.equal(h.current, .95); assert.equal(h.posts.length, 1);
  assert.equal(h.status().held, 'external_change_detected');
  const restart = harness({ saved: h.stored() }); restart.current = .95; await restart.start();
  assert.equal(restart.status().held, 'external_change_detected'); assert.equal(restart.posts.length, 0);
  // Automatic is the different, explicit choice to start from the live reading: it adopts it and sends nothing.
  const auto = harness(); await auto.start(); await auto.mode('manual', 2); auto.current = .95;
  assert.equal((await auto.mode('auto')).status, 200);
  assert.equal(auto.current, .95); assert.equal(auto.posts.length, 1); assert.equal(auto.status().held, null);
  assert.equal(auto.status().profile.mode, 'auto'); assert.equal(auto.status().profile.rememberedManual, 2);
  const again = harness({ saved: auto.stored() }); again.current = .95; await again.start();
  assert.equal(again.status().held, null); assert.equal(again.status().profile.mode, 'auto'); assert.equal(again.posts.length, 0);
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
