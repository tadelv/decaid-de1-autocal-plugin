function createPlugin(host) {
  'use strict';
  var ID = 'auto-flow-cal-updater.reaplugin', VERSION = '0.4.0';
  var canonicalize = observerHelpers().canonicalize;
  var models = ['DE1', 'DE1Plus', 'DE1Pro', 'DE1XL', 'DE1Cafe', 'DE1XXL', 'DE1XXXL'];
  var enabled = false, expectedSerial = '', boundModel = null, stopped = true, ready = false, hydrated = false, held = null;
  var generation = 0, activeKey = null, activeTitle = null, pending = null, waiting = null, retryQueued = false, lastRetry = 0, controlBusy = false;
  var chain = Promise.resolve(), decisions = [], db = empty();
  var session = Date.now().toString(36) + '-' + Math.random().toString(36), revision = 0;
  var ui = createFlowCalibrationUI(host, get, status, function () { return expectedSerial; }, models);

  // v2 prevents an older writer from silently ignoring persistent manual overrides after a downgrade.
  function empty() { return { version: 2, machines: {}, pending: null }; }
  function context() { return session + ':' + generation + ':' + revision; }
  function canSetMode() { return alive(generation) && !!activeTitle && !!activeTitle.trim() && !waiting && !db.pending && !controlBusy; }
  // Manual is a choice for the named profile; editing its recipe must not silently turn Auto back on.
  function manualKey(title) { return 't:' + title; }
  function range(n) { return typeof n === 'number' && isFinite(n) && n >= 0.35 && n <= 2; }
  function grid(n) { return range(n) && Math.abs(n - Math.round(n * 1000) / 1000) < 1e-9; }
  function safe(s) { return ['idle', 'heating', 'preheating', 'sleeping'].indexOf(s && s.state) >= 0; }
  function key(profile) {
    if (!profile || typeof profile.title !== 'string' || !Array.isArray(profile.steps) || !profile.steps.length) throw new Error('invalid_program');
    return 'p:' + canonicalize({ title: profile.title, version: profile.version, steps: profile.steps });
  }
  function order(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new Error('invalid_shot_timestamp');
    var n = Date.parse(/[zZ]$|[+-]\d{2}:\d{2}$/.test(value) ? value : value + 'Z');
    if (!isFinite(n)) throw new Error('invalid_shot_timestamp');
    return n;
  }
  function alive(token) { return enabled && ready && !stopped && !held && generation === token; }
  function note(reason, extra) {
    var result = Object.assign({ reason: reason, at: new Date().toISOString() }, extra || {});
    decisions.unshift(result); decisions = decisions.slice(0, 20);
    host.log('[flow-updater] ' + JSON.stringify(result));
    ui.changed(reason);
  }
  function hold(reason) { held = reason; pending = null; note(reason); }
  function serialized(work) {
    chain = chain.then(work).catch(function (error) { hold(String(error.message || error)); });
    return chain;
  }
  async function get(path) {
    var response = await fetch('http://localhost:8080/api/v1' + path, { method: 'GET' });
    if (response.ok === false || response.status >= 400) throw new Error('read_failed:' + path.split('?')[0]);
    return await response.json();
  }
  function save() {
    if (stopped) return Promise.reject(new Error('unloaded'));
    db.writeToken = session + ':' + (++revision);
    // storage() returns void. Only the host's matching storageWrite event proves acknowledgement.
    return new Promise(function (resolve, reject) {
      var token = db.writeToken;
      var timer = setTimeout(function () {
        if (waiting && waiting.token === token) { waiting = null; reject(new Error('storage_ack_timeout')); }
      }, 10000);
      waiting = { token: token, resolve: resolve, reject: reject, timer: timer };
      try { host.storage({ type: 'write', key: 'state', namespace: ID, data: JSON.parse(JSON.stringify(db)) }); }
      catch (error) { clearTimeout(timer); waiting = null; reject(new Error('storage_write_failed')); }
    });
  }
  function validate(value) {
    if (!value || [1, 2].indexOf(value.version) < 0 || !value.machines || typeof value.machines !== 'object' || Array.isArray(value.machines) ||
        !Object.prototype.hasOwnProperty.call(value, 'pending')) throw new Error('invalid_saved_state');
    Object.keys(value.machines).forEach(function (serial) {
      var m = value.machines[serial];
      if (!m || !grid(m.baseline) || !grid(m.expected) || typeof m.highWater !== 'number' || !isFinite(m.highWater) ||
          !Array.isArray(m.consumed) || m.consumed.some(function (id) { return typeof id !== 'string'; }) ||
          !m.programs || typeof m.programs !== 'object' || Array.isArray(m.programs)) throw new Error('invalid_saved_state');
      Object.keys(m.programs).forEach(function (p) {
        var r = m.programs[p];
        if (!r || !range(r.target) || (r.applied !== null && !grid(r.applied))) throw new Error('invalid_saved_state');
      });
      if (value.version === 1 && m.overrides === undefined) m.overrides = {};
      if (!m.overrides || typeof m.overrides !== 'object' || Array.isArray(m.overrides) ||
          Object.keys(m.overrides).some(function (p) { return p.indexOf('t:') !== 0 || !p.slice(2).trim() || !grid(m.overrides[p]); })) throw new Error('invalid_saved_state');
    });
    value.version = 2;
    return value;
  }
  async function snapshot() {
    var info = await get('/machine/info');
    if (models.indexOf(info.model) < 0 || !info.serialNumber || String(info.serialNumber) === '0' || String(info.serialNumber) !== expectedSerial ||
        (boundModel !== null && info.model !== boundModel)) throw new Error('wrong_machine');
    boundModel = info.model;
    var workflow = await get('/workflow');
    var machineState = await get('/machine/state');
    var calibration = await get('/machine/calibration');
    if (!grid(calibration.flowMultiplier)) throw new Error('unsupported_live_multiplier');
    ui.observe(info, calibration.flowMultiplier);
    return { serial: String(info.serialNumber), model: info.model, key: key(workflow.profile), title: workflow.profile.title,
      safe: safe(machineState.state), value: Math.round(calibration.flowMultiplier * 1000) / 1000 };
  }
  function record(s) { return db.machines['s:' + s.serial]; }
  async function arm() {
    if (!enabled || stopped || held) return;
    if (!expectedSerial || expectedSerial === '0') throw new Error('expected_serial_required');
    if (db.pending !== null) throw new Error('unresolved_write_intent');
    var token = generation, s = await snapshot();
    if (!s.safe) throw new Error('enable_only_while_idle');
    activeKey = s.key; activeTitle = s.title;
    var m = record(s);
    if (!m) m = db.machines['s:' + s.serial] = { baseline: s.value, expected: s.value, highWater: -1, consumed: [], programs: {}, overrides: {} };
    if (m.expected !== s.value && m.overrides[manualKey(s.title)] !== undefined) throw new Error('external_change_detected');
    if (m.expected !== s.value) m.baseline = s.value;
    m.expected = s.value;
    await fenceHistory(m);
    await save();
    var final = await snapshot();
    if (stopped || token !== generation || final.key !== s.key || final.value !== s.value || !final.safe) throw new Error('startup_context_changed');
    ready = true;
    note('armed_for_new_shots', { serial: s.serial, current: s.value, queuedWriteProtection: 'best_effort_only' });
    if (m.overrides[manualKey(s.title)] !== undefined) await activate(token);
  }
  async function fenceHistory(m) {
    var history = await get('/shots?limit=1&offset=0&order=desc');
    var items = Array.isArray(history) ? history : history.items;
    if (!Array.isArray(items)) throw new Error('history_unavailable');
    if (items.length) m.highWater = Math.max(m.highWater, order(items[0].timestamp));
  }
  async function check(s, token, p) {
    if (!alive(token) || s.key !== p.key || s.serial !== p.serial) {
      pending = null; note('stale_context'); return false;
    }
    var m = record(s);
    if (m.expected !== s.value) {
      if (m.overrides[manualKey(s.title)] === undefined) { m.baseline = s.value; m.expected = s.value; }
      hold('external_change_detected'); await save(); return false;
    }
    return true;
  }
  async function apply() {
    var p = pending;
    if (!p || !alive(p.token)) return;
    var s = await snapshot();
    if (!await check(s, p.token, p)) return;
    if (!s.safe) { note('deferred_busy', { shotId: p.shotId }); return; }
    if (p.kind === 'learning' ? Math.abs(Math.round(p.target * 1000) - Math.round(s.value * 1000)) < 10 : p.target === s.value) {
      pending = null; note('no_write_needed', { target: p.target, current: s.value, kind: p.kind }); return;
    }
    var command = Math.round(p.target * 1000) / 1000;
    if (!grid(command)) throw new Error('invalid_command');
    db.pending = { serial: p.serial, key: p.key, shotId: p.shotId, expected: s.value, command: command, kind: p.kind };
    await save();
    // Best effort only: no host-side execution-time compare-and-set exists yet.
    var final = await snapshot();
    if (!await check(final, p.token, p) || !final.safe) {
      db.pending = null; await save();
      if (!final.safe && alive(p.token)) note('deferred_busy', { shotId: p.shotId });
      return;
    }
    if (!alive(p.token)) { db.pending = null; await save(); return; }
    pending = null; // Consume this authorization before dispatch; state events cannot resend it.
    var response = await fetch('http://localhost:8080/api/v1/machine/calibration', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowMultiplier: command })
    });
    if (response.ok === false || response.status >= 400) throw new Error('write_outcome_unresolved');
    var verified = await snapshot();
    if (!alive(p.token) || verified.key !== p.key || verified.serial !== p.serial || verified.value !== command || !verified.safe) throw new Error('write_verification_failed');
    var m = record(verified);
    m.expected = command;
    if (p.kind === 'learning' || p.kind === 'recall') {
      var program = m.programs[p.key] || { target: p.target, applied: null };
      program.applied = command; m.programs[p.key] = program;
    }
    var durableIntent = db.pending;
    db.pending = null;
    try { await save(); } catch (error) { db.pending = durableIntent; throw error; }
    note('applied_verified', { shotId: p.shotId, kind: p.kind, target: p.target, previous: s.value, applied: command });
  }
  async function inspect(id, token) {
    if (!alive(token)) return;
    var full = await get('/shots?ids=' + encodeURIComponent(id) + '&order=desc');
    if (!Array.isArray(full) || full.length !== 1 || String(full[0].id) !== id) throw new Error('shot_unavailable');
    var shot = full[0], machine = shot.workflow && shot.workflow.machine;
    if (!machine || machine.provenanceStatus !== 'captured' || String(machine.serialNumber) !== expectedSerial || machine.model !== boundModel) {
      note('wrong_shot_machine', { shotId: id }); return;
    }
    if (!grid(machine.flowCalibration)) { note('unsupported_historical_multiplier', { shotId: id }); return; }
    var programKey = key(shot.workflow.profile), stamp = order(shot.timestamp);
    var m = db.machines['s:' + expectedSerial];
    if (m.consumed.indexOf(id) >= 0 || stamp <= m.highWater) { note('old_or_duplicate_shot', { shotId: id }); return; }
    // shortcut: trial IDs grow monotonically; retain replay protection when compacting for long-term use.
    m.highWater = stamp; m.consumed.push(id);
    if (m.overrides[manualKey(shot.workflow.profile.title)] !== undefined) {
      await save(); note('manual_shot_ignored', { shotId: id, profileKey: programKey }); return;
    }
    var fit = experimentalFitFlow(shot);
    if (!alive(token)) return;
    if (fit.fitted) m.programs[programKey] = { target: fit.multiplier,
      applied: m.programs[programKey] ? m.programs[programKey].applied : null };
    await save();
    note(fit.fitted ? 'new_target' : 'no_fit', { shotId: id, shotTimestamp: shot.timestamp,
      historicalMultiplier: machine.flowCalibration, fit: fit });
    if (!fit.fitted || !alive(token) || activeKey !== programKey) return;
    pending = { token: token, serial: expectedSerial, key: programKey, target: fit.multiplier, shotId: id, kind: 'learning' };
    await apply();
  }
  async function activate(token) {
    if (!alive(token)) return;
    var s = await snapshot();
    if (!await check(s, token, { key: activeKey, serial: expectedSerial })) return;
    var m = record(s), saved = m.programs[s.key], manual = m.overrides[manualKey(s.title)];
    pending = { token: token, serial: s.serial, key: s.key, target: manual !== undefined ? manual : saved && saved.applied !== null ? saved.applied : m.baseline,
      shotId: null, kind: manual !== undefined ? 'manual' : saved && saved.applied !== null ? 'recall' : 'baseline' };
    await apply();
  }
  function json(request, code, body) {
    return { requestId: request.requestId, status: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
  }
  function modeRequest(request) {
    if (request.method !== 'POST') return json(request, 405, { error: 'post_required' });
    var body;
    try { body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body; } catch (error) { return json(request, 400, { error: 'invalid_request' }); }
    if (!body || ['auto', 'manual'].indexOf(body.mode) < 0 || (body.mode === 'manual' && !grid(body.value))) return json(request, 400, { error: 'invalid_mode_or_multiplier' });
    if (!canSetMode()) return json(request, 409, { error: 'controls_unavailable' });
    if (body.context !== context() || body.profileKey !== activeKey) return json(request, 409, { error: 'stale_context' });
    controlBusy = true;
    var result = { saved: false }, code = 200;
    return serialized(async function () {
      var token = generation, s = await snapshot();
      if (!alive(token) || body.context !== context() || body.profileKey !== activeKey || s.key !== activeKey) {
        code = 409; result = { error: 'stale_context' }; return;
      }
      if (!s.safe) { code = 409; result = { error: 'machine_busy' }; return; }
      if (!await check(s, token, { key: activeKey, serial: expectedSerial })) return;
      var m = record(s), manual = body.mode === 'manual' ? Math.round(body.value * 1000) / 1000 : undefined;
      if (m.overrides[manualKey(s.title)] === manual) {
        if (manual !== undefined && pending) await activate(token);
        code = pending ? 202 : 200; result = { saved: true, profile: s.title, mode: body.mode, waiting: code === 202 }; return;
      }
      // Only shots newer than this explicit mode change may teach Auto again.
      var previousWater = m.highWater;
      await fenceHistory(m);
      if (!alive(token) || body.context !== context() || s.key !== activeKey) {
        m.highWater = previousWater; code = 409; result = { error: 'stale_context' }; return;
      }
      generation++; token = generation; pending = null;
      if (manual === undefined) delete m.overrides[manualKey(s.title)]; else m.overrides[manualKey(s.title)] = manual;
      await save();
      note('profile_mode_saved', { profile: s.title, profileKey: s.key, mode: body.mode, multiplier: manual === undefined ? null : manual });
      if (alive(token) && activeKey === s.key) await activate(token);
      code = pending || activeKey !== s.key ? 202 : 200;
      result = { saved: true, profile: s.title, mode: body.mode, waiting: code === 202 };
    }).then(function () { return json(request, held ? 503 : code, held ? { error: held, uncertain: true } : result); })
      .finally(function () { controlBusy = false; ui.changed(); });
  }
  function status() {
    var m = db.machines['s:' + expectedSerial], manual = m && m.overrides ? m.overrides[manualKey(activeTitle)] : undefined;
    return { plugin: { id: ID, version: VERSION }, enabled: enabled, ready: ready, stopped: stopped,
      canSetMode: canSetMode(), context: context(),
      profile: activeKey ? { key: activeKey, title: activeTitle, mode: manual === undefined ? 'auto' : 'manual', manualValue: manual === undefined ? null : manual } : null,
      calibrationWritesAllowed: enabled && ready && !stopped && !held, expectedSerial: expectedSerial,
      fitMethod: 'fixed_zero_lag_v2', gain: 1, perShotCap: null, bounds: [0.35, 2], deadband: 0.01,
      queuedWriteProtection: 'best_effort_only', persistentManualOverride: true,
      held: held, pending: pending, unresolvedIntent: db.pending, machines: db.machines, decisions: decisions };
  }
  function stop() {
    ui.stop();
    stopped = true; ready = false; generation++; pending = null;
    if (waiting) { clearTimeout(waiting.timer); var reject = waiting.reject; waiting = null; reject(new Error('unloaded')); }
  }
  return {
    id: ID, version: VERSION,
    onLoad: function (settings) {
      stopped = false; enabled = !!settings && settings.Enabled === true;
      expectedSerial = settings && typeof settings.ExpectedSerial === 'string' ? settings.ExpectedSerial.trim() : '';
      try { host.storage({ type: 'read', key: 'state', namespace: ID }); }
      catch (error) { hold('storage_read_failed'); }
    },
    onUnload: stop,
    onEvent: function (event) {
      if (!event || stopped) return;
      if (event.name === 'storageWrite') {
        if (waiting && event.payload && event.payload.writeToken === waiting.token) {
          clearTimeout(waiting.timer); var resolve = waiting.resolve; waiting = null; resolve();
        }
        return;
      }
      if (event.name === 'storageRead' && event.payload && event.payload.key === 'state' && !hydrated) {
        hydrated = true;
        return serialized(async function () {
          db = event.payload.value == null ? empty() : validate(event.payload.value);
          await arm();
        });
      }
      if (event.name === 'shutdown') { stop(); return; }
      if (!enabled || !ready || held) return;
      if (event.name === 'workflowUpdated') {
        var next;
        try { next = key(event.payload && event.payload.profile); } catch (error) { generation++; hold('invalid_program'); return; }
        if (next !== activeKey) {
          generation++; activeKey = next; activeTitle = event.payload.profile.title; pending = null;
          ui.changed('profile_changed');
          var token = generation;
          return serialized(function () { return activate(token); });
        }
      }
      if (event.name === 'shotStored' && event.payload && event.payload.id != null) {
        var id = String(event.payload.id), epoch = generation;
        return serialized(function () { return inspect(id, epoch); });
      }
      if ((event.name === 'stateUpdate' || event.name === 'workflowUpdated') && pending && !retryQueued && Date.now() - lastRetry >= 500) {
        retryQueued = true; lastRetry = Date.now();
        return serialized(apply).finally(function () { retryQueued = false; });
      }
    },
    __httpRequestHandler: function (request) {
      if (request.endpoint === 'mode') return modeRequest(request);
      var display = ui.handle(request);
      if (display) return display;
      return { requestId: request.requestId, status: request.endpoint === 'status' ? 200 : 404,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify(request.endpoint === 'status' ? status() : { error: 'not_found' }) };
    }
  };
}
