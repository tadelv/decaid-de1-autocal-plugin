function createPlugin(host) {
  'use strict';
  var ID = FLOW_CAL_METADATA.id, VERSION = FLOW_CAL_METADATA.version, STORAGE_KEY = 'calibration-v2';
  var canonicalize = createMeasurementHelpers().canonicalize;
  var models = ['DE1', 'DE1Plus', 'DE1Pro', 'DE1XL', 'DE1Cafe', 'DE1XXL', 'DE1XXXL'];
  var enabled = false, expectedSerial = '', boundModel = null, stopped = true, ready = false, hydrated = false, held = null;
  var generation = 0, activeKey = null, activeTitle = null, pending = null, waiting = null, retryQueued = false, lastRetry = 0, controlBusy = false;
  var chain = Promise.resolve(), decisions = [], db = empty();
  var workflowCheck = null, workflowRevision = 0, recovering = false, recovery = null;
  var consentEpoch = 0, observed = null, consentedMode = null;
  var session = Date.now().toString(36) + '-' + Math.random().toString(36), revision = 0;
  var ui = createFlowCalibrationUI(host, get, status, function () { return expectedSerial; }, models);

  // Fresh versioned storage leaves the legacy 1.x state untouched; no migration is attempted.
  function empty() { return { version: 2, machines: {}, pending: null }; }
  function context() { return session + ':' + generation + ':' + revision; }
  function intentId(p) {
    return !p ? 'none' : [p.serial, p.model === undefined ? '' : p.model, p.key,
      p.shotId === null || p.shotId === undefined ? '' : String(p.shotId), p.expected, p.command, p.kind].join('|');
  }
  // A reviewed value may only be confirmed while nothing meaningful changed, even if a value comes back later.
  // Storage revisions are excluded so the plugin's own staged write cannot invalidate its pending confirmation.
  function reviewContext() { return session + ':' + generation + '#' + consentEpoch; }
  function observeReview(s) {
    var next = [s.serial, s.model, s.value, s.state, s.key, held === null ? '' : held, intentId(db.pending)].join('|');
    if (next === observed) return;
    observed = next; consentEpoch++;
  }
  function canSetMode() { return alive(generation) && !!activeTitle && !!activeTitle.trim() && !waiting && !db.pending && !controlBusy && !workflowCheck; }
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
    host.log('[auto-flow-cal] ' + JSON.stringify(result));
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
  function save(value) {
    if (stopped) return Promise.reject(new Error('unloaded'));
    var data = value || db;
    data.writeToken = session + ':' + (++revision);
    // storage() returns void. Only the host's matching storageWrite event proves acknowledgement.
    return new Promise(function (resolve, reject) {
      var token = data.writeToken;
      var timer = setTimeout(function () {
        if (waiting && waiting.token === token) { waiting = null; reject(new Error('storage_ack_timeout')); }
      }, 10000);
      waiting = { token: token, resolve: resolve, reject: reject, timer: timer };
      try { host.storage({ type: 'write', key: STORAGE_KEY, namespace: ID, data: JSON.parse(JSON.stringify(data)) }); }
      catch (error) { clearTimeout(timer); waiting = null; reject(new Error('storage_write_failed')); }
    });
  }
  function validIntent(value) {
    return value && typeof value === 'object' && typeof value.serial === 'string' && value.serial !== '' && value.serial !== '0' &&
      typeof value.key === 'string' && value.key.indexOf('p:') === 0 && grid(value.expected) && grid(value.command) &&
      ['learning', 'manual', 'baseline', 'recall'].indexOf(value.kind) >= 0 &&
      (value.model === undefined || models.indexOf(value.model) >= 0) &&
      // The controller records a shot name or no shot at all, so any other shape is unreadable, not provenance.
      (value.shotId === undefined || value.shotId === null || typeof value.shotId === 'string');
  }
  // Intent identity is compared field by field. The persisted marker joins its fields with a separator that a
  // profile key or shot id may itself contain, so two different intents can share one marker string.
  // A shot id is a name or the absence of one: an omitted field and null both mean "no shot", while an empty
  // name is still a recorded name and no value is ever coerced into matching another.
  function sameIntent(a, b) {
    function shot(value) { return value === null || value === undefined ? null : value; }
    return !!a && !!b && a.serial === b.serial && (a.model === undefined ? '' : a.model) === (b.model === undefined ? '' : b.model) &&
      a.key === b.key && shot(a.shotId) === shot(b.shotId) && a.expected === b.expected && a.command === b.command && a.kind === b.kind;
  }
  // A retried reload reuses the original intent and the profile state that the failed preparation recorded.
  // That reuse is only safe while the record still reads back as this same attempt, including the original
  // intent itself: a grid-valid but different command, expected value, kind, key or shot id must never replace it.
  function auditProblem(audit, intent) {
    function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
    function stamp(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && isFinite(Date.parse(value)); }
    var original = audit.previousIntent, replaced = audit.previous;
    if (!validIntent(original) || !sameIntent(original, intent)) return 'previousIntent';
    if (!object(replaced) || !grid(replaced.expected) || !grid(replaced.baseline)) return 'previous';
    if (replaced.program !== null && (!object(replaced.program) || !range(replaced.program.target) ||
        (replaced.program.applied !== null && !grid(replaced.program.applied)))) return 'previous.program';
    if (replaced.override !== null && !grid(replaced.override)) return 'previous.override';
    if (!Number.isInteger(audit.attempts) || audit.attempts < 1) return 'attempts';
    if (!stamp(audit.firstAt)) return 'firstAt';
    return null;
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
      if (m.recoveryCutoff !== undefined && (typeof m.recoveryCutoff !== 'number' || !isFinite(m.recoveryCutoff))) throw new Error('invalid_saved_state');
      if (value.version === 1 && m.overrides === undefined) m.overrides = {};
      if (!m.overrides || typeof m.overrides !== 'object' || Array.isArray(m.overrides) ||
          Object.keys(m.overrides).some(function (p) { return p.indexOf('t:') !== 0 || !p.slice(2).trim() || !grid(m.overrides[p]); })) throw new Error('invalid_saved_state');
      // 2.0.2 kept a Manual choice only as an active override; that value is also what the profile remembers.
      if (m.manual === undefined) m.manual = Object.assign({}, m.overrides);
      if (!m.manual || typeof m.manual !== 'object' || Array.isArray(m.manual) ||
          Object.keys(m.manual).some(function (p) { return p.indexOf('t:') !== 0 || !p.slice(2).trim() || !grid(m.manual[p]); })) throw new Error('invalid_saved_state');
    });
    if (value.pending !== null && (!validIntent(value.pending) || !value.machines['s:' + value.pending.serial])) throw new Error('invalid_saved_state');
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
    var seen = { serial: String(info.serialNumber), model: info.model, key: key(workflow.profile), title: workflow.profile.title,
      state: machineState.state && machineState.state.state,
      safe: safe(machineState.state), value: Math.round(calibration.flowMultiplier * 1000) / 1000 };
    ui.observe(info, calibration.flowMultiplier);
    observeReview(seen);
    return seen;
  }
  function record(s) { return db.machines['s:' + s.serial]; }
  function syncProfile(s) {
    if (s.key === activeKey) return false;
    generation++; activeKey = s.key; activeTitle = s.title; pending = null; recovery = null;
    ui.changed('profile_changed'); return true;
  }
  async function settleWorkflow() {
    while (workflowCheck) { var current = workflowCheck; await current; if (workflowCheck === current) break; }
  }
  function workflowUpdated() {
    // Events invalidate cached knowledge; only the current REST workflow selects the profile.
    var rev = ++workflowRevision, authorize = ready && !held && !recovering;
    var check = (async function () {
      var w = await get('/workflow');
      if (stopped || rev !== workflowRevision) return null;
      return { changed: syncProfile({ key: key(w.profile), title: w.profile.title }), token: generation };
    })().catch(function (error) { if (!stopped && rev === workflowRevision) hold(String(error.message || error)); return null; });
    workflowCheck = check;
    check.then(function () { if (workflowCheck === check) { workflowCheck = null; ui.changed(); } });
    return check.then(function (result) {
      if (!result || !authorize || !alive(result.token)) return;
      if (result.changed) return serialized(function () { return activate(result.token); });
      if (pending && !retryQueued && Date.now() - lastRetry >= 500) {
        retryQueued = true; lastRetry = Date.now();
        return serialized(apply).finally(function () { retryQueued = false; });
      }
    });
  }
  async function arm() {
    if (!enabled || stopped || held) return;
    if (!expectedSerial || expectedSerial === '0') throw new Error('expected_serial_required');
    if (db.pending !== null) throw new Error('unresolved_write_intent');
    var token = generation, s = await snapshot();
    if (!s.safe) throw new Error('enable_only_while_idle');
    activeKey = s.key; activeTitle = s.title;
    var m = record(s);
    if (!m) m = db.machines['s:' + s.serial] = { baseline: s.value, expected: s.value, highWater: -1, consumed: [], programs: {}, overrides: {}, manual: {} };
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
    db.pending = { serial: p.serial, model: s.model, key: p.key, shotId: p.shotId, expected: s.value, command: command, kind: p.kind };
    await save();
    // Best effort only: no host-side execution-time compare-and-set exists yet.
    await settleWorkflow();
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
    await settleWorkflow();
    var verified = await snapshot(), reasons = [];
    if (!alive(p.token)) reasons.push('controller_context_changed');
    if (verified.key !== p.key) reasons.push('profile_changed');
    if (verified.serial !== p.serial) reasons.push('machine_changed');
    if (verified.value !== command) reasons.push('value_mismatch');
    if (!verified.safe) reasons.push('machine_busy');
    if (reasons.length) {
      db.pending.verification = { reasons: reasons, expected: { profileKey: p.key, value: command, serial: p.serial },
        observed: { profileKey: verified.key, profileTitle: verified.title, value: verified.value, serial: verified.serial, state: verified.state } };
      await save();
      throw new Error('write_verification_failed');
    }
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
    if (m.consumed.indexOf(id) >= 0 || stamp <= m.highWater || (typeof m.recoveryCutoff === 'number' && stamp <= m.recoveryCutoff)) {
      note('old_or_duplicate_shot', { shotId: id }); return;
    }
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
      var m = record(s), manual = body.mode === 'manual' ? Math.round(body.value * 1000) / 1000 : undefined;
      if (manual !== undefined) {
        // A Manual choice may still not overwrite a value the machine changed outside this plugin.
        if (!await check(s, token, { key: activeKey, serial: expectedSerial })) return;
        if (m.overrides[manualKey(s.title)] === manual) {
          if (pending) await activate(token);
          code = pending ? 202 : 200; result = { saved: true, profile: s.title, mode: body.mode, waiting: code === 202 }; return;
        }
      } else {
        // Starting Automatic is the operator's fresh choice to use the live reading, so queued workflow checks are
        // settled first and the starting value is read again; nothing is recalled and nothing is sent.
        await settleWorkflow();
        s = await snapshot();
        if (!alive(token) || body.context !== context() || s.key !== activeKey || s.serial !== expectedSerial) {
          code = 409; result = { error: 'stale_context' }; return;
        }
        if (!s.safe) { code = 409; result = { error: 'machine_busy' }; return; }
        m = record(s);
      }
      // Only shots newer than this explicit mode change may teach Auto again.
      var previousWater = m.highWater;
      await fenceHistory(m);
      if (!alive(token) || body.context !== context() || s.key !== activeKey) {
        m.highWater = previousWater; code = 409; result = { error: 'stale_context' }; return;
      }
      generation++; token = generation; pending = null;
      if (manual === undefined) {
        // Rebase only this profile's automatic record and the expected machine value to the live multiplier. An older
        // automatic value, the machine baseline and the remembered Manual value are never used as the starting point;
        // the remembered Manual value is kept for an explicit later choice.
        delete m.overrides[manualKey(s.title)];
        m.expected = s.value;
        m.programs[s.key] = { target: s.value, applied: s.value };
        // Reuse the existing monotonic exclusion fence: a shot recorded before this explicit start must not teach it,
        // even when the history was empty and the latest history entry is older than that delayed shot.
        m.recoveryCutoff = Math.max(typeof m.recoveryCutoff === 'number' ? m.recoveryCutoff : -Infinity, Date.now());
      } else {
        m.overrides[manualKey(s.title)] = manual; m.manual[manualKey(s.title)] = manual;
      }
      await save();
      if (manual === undefined) {
        // The stored acknowledgement proves the write, not the reading it was based on: a value, profile, machine or
        // control change that lands in the acknowledgement window is never reported as a successful start. The
        // acknowledged record is left exactly as written (there is no atomic rollback); a reload rebases a machine
        // that moved on, and an explicit retry reads the live value again.
        var after = alive(token) ? await snapshot() : null, unconfirmed = null;
        // The controller can be unloaded, or the workflow can move on and back, while that read is in flight: the
        // reading alone never proves the live value it returns is still this operator's explicit Automatic choice.
        if (!after || !alive(token) || after.key !== activeKey || after.key !== s.key) unconfirmed = 'stale_context';
        else if (!after.safe) unconfirmed = 'machine_busy';
        else if (after.value !== s.value) unconfirmed = 'stale_context';
        if (unconfirmed) {
          code = 409; result = { error: unconfirmed };
          note('auto_start_not_confirmed', { profile: s.title, profileKey: s.key, value: s.value,
            observed: after ? after.value : null, state: after ? after.state : null, error: unconfirmed, calibrationCommandSent: false });
          return;
        }
        note('auto_started_from_current', { profile: s.title, profileKey: s.key, value: s.value, calibrationCommandSent: false });
        result = { saved: true, profile: s.title, mode: 'auto', value: s.value, calibrationCommandSent: false };
        return;
      }
      note('profile_mode_saved', { profile: s.title, profileKey: s.key, mode: body.mode, multiplier: manual });
      if (alive(token) && activeKey === s.key) await activate(token);
      code = pending || activeKey !== s.key ? 202 : 200;
      result = { saved: true, profile: s.title, mode: body.mode, waiting: code === 202 };
    }).then(function () { return json(request, held ? 503 : code, held ? { error: held, uncertain: true } : result); })
      .finally(function () { controlBusy = false; ui.changed(); });
  }
  async function reviewRecovery(request) {
    recovery = null;
    if (enabled && !stopped && hydrated && held && db.pending) {
      try {
        await settleWorkflow();
        var s = await snapshot(); syncProfile(s);
        var intent = db.pending, m = record(s), manual = m && m.overrides ? m.overrides[manualKey(s.title)] : undefined;
        var mode = manual === undefined ? 'auto' : 'manual';
        // A differing read-back is no longer a blocking reason: the explicit reload request accepts it.
        var reason = !validIntent(intent) ? 'invalid_saved_state'
          : recovering || controlBusy || waiting ? 'recovery_busy'
          : intent.serial !== s.serial || (intent.model && intent.model !== s.model) ? 'wrong_machine'
          : !s.safe ? 'machine_busy'
          : intent.key !== s.key ? 'recovery_profile_mismatch' : null;
        // A review is mode-bound: a profile mode change ends the earlier confirmation, even when nothing
        // else in the observed machine state moved and even if the change came from a partial recovery.
        if (consentedMode !== null && consentedMode !== mode) consentEpoch++;
        consentedMode = mode;
        recovery = { available: !reason, reason: reason, action: 'reload_current', context: reviewContext(), profileKey: s.key, profileTitle: s.title,
          serial: s.serial, model: s.model, value: s.value, command: intent.command, intent: intentId(intent),
          mode: mode,
          requiresSettledConfirmation: true };
      } catch (error) {
        var code = String(error.message || error); consentEpoch++; ui.changed(code);
        recovery = { available: false, reason: code };
      }
    }
    return json(request, 200, ui.model());
  }
  function recoverRequest(request) {
    if (request.method !== 'POST') return json(request, 405, { error: 'post_required' });
    var body;
    try { body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body; } catch (error) { return json(request, 400, { error: 'invalid_request' }); }
    if (!body || body.confirmSettled !== true || !grid(body.value)) return json(request, 400, { error: 'explicit_recovery_confirmation_required' });
    // Only an explicit discriminator may accept a read-back that differs from the paused command.
    var reload = body.action === 'reload_current';
    if (body.action !== undefined && !reload) return json(request, 400, { error: 'unsupported_recovery_action' });
    if (!enabled || stopped || !hydrated || !held || !validIntent(db.pending) || !recovery || !recovery.available ||
        controlBusy || recovering || waiting || workflowCheck) return json(request, 409, { error: 'recovery_unavailable' });
    if (body.context !== reviewContext() || body.context !== recovery.context || body.profileKey !== recovery.profileKey || body.value !== recovery.value) return json(request, 409, { error: 'stale_context' });
    var reviewed = recovery;
    controlBusy = true; recovering = true;
    var code = 200, result = { saved: false };
    return serialized(async function () {
      var originalIntent = db.pending, token = generation, intent = intentId(originalIntent);
      function matches(s) {
        // The old matching-only authority still requires the read-back to equal the paused command.
        return !stopped && enabled && generation === token && body.context === reviewContext() && s.safe && s.serial === originalIntent.serial &&
          (!originalIntent.model || s.model === originalIntent.model) && s.key === body.profileKey && s.key === originalIntent.key &&
          s.value === body.value && (reload || s.value === originalIntent.command);
      }
      await settleWorkflow();
      var s = await snapshot();
      if (!matches(s)) { code = 409; result = { error: 'recovery_context_changed' }; return; }
      var current = record(s), manualNow = current && current.overrides ? current.overrides[manualKey(s.title)] : undefined;
      var mode = manualNow === undefined ? 'auto' : 'manual';
      if (reload && mode !== reviewed.mode) { code = 409; result = { error: 'recovery_context_changed' }; return; }
      if (!reload) mode = 'manual';
      var prepared = JSON.parse(JSON.stringify(db)), m = prepared.machines['s:' + s.serial];
      // An explicit retry of the same retained intent must not overwrite what the first attempt replaced, and a
      // reload record that survived only in part is still that same attempt: it is validated, never discarded.
      var audit = reload && db.lastRecovery && db.lastRecovery.authority === 'operator_confirmed_reload_current' ? db.lastRecovery : null;
      // A finished reload is history: it is never lent to a later pause, even one repeating its intent exactly.
      if (audit && audit.status === 'completed') audit = null;
      var same = !!audit && (audit.intent === intent ||
        (validIntent(audit.previousIntent) && sameIntent(audit.previousIntent, originalIntent)));
      // That same record must still read back as the prepared attempt the retry is meant to resume.
      var partial = !same ? null : audit.status !== 'prepared' ? 'status' : audit.intent !== intent ? 'intent' : null;
      if (partial) { code = 409; result = { error: 'invalid_recovery_audit', field: partial }; return; }
      var prior = same ? audit : null;
      // Provenance that cannot be read back is never reused and never replaced by rebuilt values.
      var unreadable = prior ? auditProblem(prior, originalIntent) : null;
      if (unreadable) { code = 409; result = { error: 'invalid_recovery_audit', field: unreadable }; return; }
      // Audit the selected profile state this reload replaces, not only the old intent.
      var previous = !reload ? null : prior ? prior.previous : { expected: m.expected, baseline: m.baseline,
        program: m.programs[s.key] === undefined ? null : JSON.parse(JSON.stringify(m.programs[s.key])),
        override: m.overrides[manualKey(s.title)] === undefined ? null : m.overrides[manualKey(s.title)] };
      await fenceHistory(m);
      // Keep an earlier cutoff: a rewound host clock must not widen the pre-recovery shot exclusion.
      var cutoff = Math.max(typeof m.recoveryCutoff === 'number' ? m.recoveryCutoff : -Infinity, Date.now()), at = new Date().toISOString();
      var final = await snapshot();
      if (!matches(final)) { code = 409; result = { error: 'recovery_context_changed' }; return; }
      // The operator accepts ONLY the freshly read value; the old command is never treated as verified.
      m.expected = s.value;
      if (reload) {
        // Delayed pre-recovery shots must not teach Auto, even when history is otherwise empty.
        m.recoveryCutoff = cutoff;
        if (mode === 'manual') { m.overrides[manualKey(s.title)] = s.value; m.manual[manualKey(s.title)] = s.value; }
        else m.programs[s.key] = { target: s.value, applied: s.value };
      } else { m.overrides[manualKey(s.title)] = s.value; m.manual[manualKey(s.title)] = s.value; }
      prepared.lastRecovery = reload ? { previousIntent: prior ? prior.previousIntent : JSON.parse(JSON.stringify(originalIntent)),
        authority: 'operator_confirmed_reload_current', status: 'prepared', intent: intent, attempts: prior ? prior.attempts + 1 : 1,
        firstAt: prior ? prior.firstAt : at,
        mode: mode, serial: s.serial, profileKey: s.key, profileTitle: s.title, value: s.value, command: originalIntent.command,
        previous: previous, cutoff: cutoff, confirmedSettled: true, calibrationCommandSent: false, at: at }
        : { previousIntent: JSON.parse(JSON.stringify(originalIntent)), authority: 'operator_confirmed_manual',
          serial: s.serial, profileKey: s.key, value: s.value, confirmedSettled: true, at: at };
      // Keep the old intent durable until preparation and another context check acknowledge safely.
      await save(prepared); db = prepared;
      final = await snapshot();
      if (!matches(final)) { code = 409; result = { error: 'recovery_context_changed' }; return; }
      var completed = JSON.parse(JSON.stringify(prepared)); completed.pending = null;
      // A finished reload is not a pending attempt: a later pause can never inherit its snapshot.
      if (completed.lastRecovery) completed.lastRecovery.status = 'completed';
      await save(completed);
      if (!matches(await snapshot())) {
        await save(prepared); db = prepared;
        code = 409; result = { error: 'recovery_context_changed' }; return;
      }
      db = completed; pending = null; recovery = null; activeKey = s.key; activeTitle = s.title;
      ready = true; held = null; generation++;
      note(reload ? 'recovered_' + mode : 'recovered_manual', { profile: s.title, value: s.value, mode: mode,
        command: originalIntent.command, calibrationCommandSent: false });
      result = { saved: true, profile: s.title, mode: mode, value: s.value, command: originalIntent.command, calibrationCommandSent: false };
    }).then(function () { return json(request, code === 200 && held ? 503 : code, code === 200 && held ? { error: held, uncertain: true } : result); })
      .finally(function () { controlBusy = false; recovering = false; ui.changed(); });
  }
  function status() {
    var m = db.machines['s:' + expectedSerial], manual = m && m.overrides ? m.overrides[manualKey(activeTitle)] : undefined;
    var remembered = m && m.manual ? m.manual[manualKey(activeTitle)] : undefined;
    return { plugin: { id: ID, version: VERSION }, enabled: enabled, ready: ready, stopped: stopped,
      canSetMode: canSetMode(), context: context(),
      profile: activeKey ? { key: activeKey, title: activeTitle, mode: manual === undefined ? 'auto' : 'manual',
        manualValue: manual === undefined ? null : manual, rememberedManual: remembered === undefined ? null : remembered } : null,
      calibrationWritesAllowed: enabled && ready && !stopped && !held, expectedSerial: expectedSerial,
      fitMethod: 'fixed_zero_lag_v2', gain: 1, perShotCap: null, bounds: [0.35, 2], deadband: 0.01,
      queuedWriteProtection: 'best_effort_only', persistentManualOverride: true,
      held: held, pending: pending, unresolvedIntent: db.pending, recovery: recovery,
      verificationFailure: db.pending && db.pending.verification || null, machines: db.machines, decisions: decisions };
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
      try { host.storage({ type: 'read', key: STORAGE_KEY, namespace: ID }); }
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
      if (event.name === 'storageRead' && event.payload && event.payload.key === STORAGE_KEY && !hydrated) {
        hydrated = true;
        return serialized(async function () {
          db = event.payload.value == null ? empty() : validate(event.payload.value);
          await arm();
        });
      }
      if (event.name === 'shutdown') { stop(); return; }
      if (event.name === 'workflowUpdated' && enabled && hydrated && !stopped) return workflowUpdated();
      if (!enabled || !ready || held) return;
      if (event.name === 'shotStored' && event.payload && event.payload.id != null) {
        var id = String(event.payload.id), epoch = generation;
        return serialized(function () { return inspect(id, epoch); });
      }
      if (event.name === 'stateUpdate' && pending && !retryQueued && Date.now() - lastRetry >= 500) {
        retryQueued = true; lastRetry = Date.now();
        return serialized(apply).finally(function () { retryQueued = false; });
      }
    },
    __httpRequestHandler: function (request) {
      if (request.endpoint === 'mode') return modeRequest(request);
      if (request.endpoint === 'recover') return recoverRequest(request);
      if (request.endpoint === 'view' && (!request.method || request.method === 'GET') && held && db.pending) return reviewRecovery(request);
      var display = ui.handle(request);
      if (display) return display;
      return { requestId: request.requestId, status: request.endpoint === 'status' ? 200 : 404,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify(request.endpoint === 'status' ? status() : { error: 'not_found' }) };
    }
  };
}
