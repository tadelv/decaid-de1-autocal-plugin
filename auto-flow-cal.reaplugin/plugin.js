var FLOW_CAL_METADATA = {"id":"auto-flow-cal.reaplugin","version":"2.0.0"};
function createMeasurementHelpers() {
  var ALLOWED_MODELS = ["DE1", "DE1Plus", "DE1Pro", "DE1XL", "DE1Cafe", "DE1XXL", "DE1XXXL"];
  function finite(value) {
    return typeof value === "number" && isFinite(value);
  }
  function isAllowedModel(model) {
    for (var i = 0; i < ALLOWED_MODELS.length; i++) {
      if (ALLOWED_MODELS[i] === model) return true;
    }
    return false;
  }
  function usableSerial(serial) {
    return serial !== null && serial !== undefined && serial !== "" && serial !== "0" && serial !== 0;
  }
  function eligibleSerial(info) {
    if (!info || !isAllowedModel(info.model)) return null;
    return usableSerial(info.serialNumber) ? info.serialNumber : null;
  }
  function canonicalize(value) {
    if (Array.isArray(value)) {
      return "[" + value.map(canonicalize).join(",") + "]";
    }
    if (value && typeof value === "object") {
      return "{" + Object.keys(value).sort().map(function (key) {
        return JSON.stringify(key) + ":" + canonicalize(value[key]);
      }).join(",") + "}";
    }
    return JSON.stringify(value);
  }
  function timestampSeconds(value) {
    var number;
    if (typeof value === "number") {
      number = value;
    } else if (typeof value === "string") {
      if (value.trim() === "") return null;
      number = Number(value);
      if (!finite(number)) number = Date.parse(value) / 1000;
    } else {
      return null;
    }
    if (!finite(number)) return null;
    if (Math.abs(number) > 100000000000) number = number / 1000;
    return finite(number) ? number : null;
  }
  function scaleFromMeasurement(measurement) {
    if (!measurement || typeof measurement !== "object") return null;
    if (measurement.scale && typeof measurement.scale === "object") return measurement.scale;
    if (measurement.timestamp !== undefined &&
        (measurement.weight !== undefined || measurement.weightFlow !== undefined)) return measurement;
    return null;
  }
  function dedupeScaleByTimestamp(measurements) {
    var result = [];
    if (!Array.isArray(measurements)) return result;
    for (var i = 0; i < measurements.length; i++) {
      var raw = scaleFromMeasurement(measurements[i]);
      if (!raw) continue;
      var timestamp = timestampSeconds(raw.timestamp);
      if (timestamp === null) continue;
      var duplicate = false;
      for (var j = 0; j < result.length; j++) {
        if (result[j].timestamp === timestamp) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) {
        result.push({
          timestamp: timestamp,
          weight: raw.weight,
          weightFlow: raw.weightFlow
        });
      }
    }
    result.sort(function (a, b) { return a.timestamp - b.timestamp; });
    return result;
  }
  function interpolateLinear(samples, time, key) {
    if (!Array.isArray(samples) || samples.length === 0 || !finite(time)) return null;
    for (var i = 0; i + 1 < samples.length; i++) {
      var a = samples[i];
      var b = samples[i + 1];
      if (!finite(a.timestamp) || !finite(b.timestamp) || b.timestamp <= a.timestamp) continue;
      if (time < a.timestamp || time > b.timestamp) continue;
      if (!finite(a[key]) || !finite(b[key])) return null;
      var fraction = (time - a.timestamp) / (b.timestamp - a.timestamp);
      return a[key] + fraction * (b[key] - a[key]);
    }
    if (samples.length === 1 && time === samples[0].timestamp && finite(samples[0][key])) return samples[0][key];
    return null;
  }
  return { canonicalize: canonicalize, timestampSeconds: timestampSeconds, dedupeScaleByTimestamp: dedupeScaleByTimestamp, interpolateLinear: interpolateLinear, isEligibleDE1: eligibleSerial };
}
function createExperimentalFlowFitter(helpers, options = {}) {
const zeroOnly = options.primaryZeroOnly === true;
const method = zeroOnly ? 'fixed_zero_lag_v2' : 'fixed_zero_lag_v1';
const LAGS = [-0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];
const finite = Number.isFinite;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function at(samples, time, field, maxGap) {
  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i], b = samples[i + 1];
    if (time < a.timestamp || time > b.timestamp) continue;
    if (b.timestamp - a.timestamp > maxGap || b.timestamp <= a.timestamp) return null;
    return helpers.interpolateLinear([a, b], time, field);
  }
  return null;
}

function curve(samples, start, end, field, maxGap) {
  const points = [{ timestamp: start, [field]: at(samples, start, field, maxGap) },
    ...samples.filter(s => s.timestamp > start && s.timestamp < end),
    { timestamp: end, [field]: at(samples, end, field, maxGap) }];
  if (points.some(s => !finite(s[field]))) return null;
  let integral = 0;
  for (let i = 1; i < points.length; i++) {
    const dt = points[i].timestamp - points[i - 1].timestamp;
    if (!(dt > 0) || dt > maxGap) return null;
    integral += dt * (points[i][field] + points[i - 1][field]) / 2;
  }
  return integral / (end - start);
}

function regression(rows) {
  let weights = rows.map(r => r.weight);
  let multiplier;
  const delta = Math.max(0.2, median(rows.map(r => r.y)) * 0.1);
  for (let iteration = 0; iteration < 12; iteration++) {
    multiplier = rows.reduce((sum, r, i) => sum + weights[i] * r.x * r.y, 0) /
      rows.reduce((sum, r, i) => sum + weights[i] * r.x * r.x, 0);
    weights = rows.map(r => r.weight * Math.min(1, delta / Math.max(1e-9, Math.abs(r.y - multiplier * r.x))));
  }
  const loss = m => rows.reduce((sum, r) => {
    const error = Math.abs(r.y - m * r.x);
    return sum + r.weight * (error <= delta ? error * error / 2 : delta * (error - delta / 2));
  }, 0) / rows.reduce((sum, r) => sum + r.weight * r.y * r.y, 0);
  const rmse = m => Math.sqrt(rows.reduce((sum, r) => sum + r.weight * (r.y - m * r.x) ** 2, 0) /
    rows.reduce((sum, r) => sum + r.weight, 0));
  return { multiplier, loss: loss(multiplier), rmse };
}

function fitFlow(shot) {
  const historical = shot?.workflow?.machine?.flowCalibration;
  const fail = reason => ({ fitted: false, fitMethod: method, reason });
  if (!finite(historical) || historical <= 0) return fail('missing_historical_multiplier');
  const measurements = Array.isArray(shot?.measurements) ? shot.measurements : [];
  const scale = helpers.dedupeScaleByTimestamp(measurements)
    .filter(s => finite(s.weight) && finite(s.weightFlow));
  if (scale.length < 3) return fail('no_scale_data');
  const machine = measurements.map(m => m.machine).filter(Boolean).map(m => ({
    ...m, timestamp: helpers.timestampSeconds(m.timestamp),
  }));
  if (machine.some((m, i) => !finite(m.timestamp) || (i > 0 && m.timestamp <= machine[i - 1].timestamp))) {
    return fail('invalid_machine_timestamps');
  }
  const espresso = m => m.state === 'espresso' || m.state?.state === 'espresso';
  // Use the last recorded extraction step, not the highest frame number or whole shot.
  let last = machine.length - 1;
  while (last >= 0 && !espresso(machine[last])) last--;
  if (last < 0 || !Number.isInteger(machine[last].profileFrame)) return fail('last_step_unknown');
  const frame = machine[last].profileFrame;
  let first = last;
  while (first > 0 && espresso(machine[first - 1]) && machine[first - 1].profileFrame === frame) first--;
  const step = machine.slice(first, last + 1);
  if (step.length < 3 || step.some(m => !finite(m.flow) || !finite(m.pressure))) return fail('insufficient_last_step');

  const blocks = [];
  for (let start = step[0].timestamp; start + 1 <= step[step.length - 1].timestamp; start += 0.5) {
    const end = start + 1;
    const flow = curve(step, start, end, 'flow', 0.5);
    if (!(flow >= 0.3)) continue;
    const pressure = [at(step, start, 'pressure', 0.5),
      ...step.filter(m => m.timestamp > start && m.timestamp < end).map(m => m.pressure),
      at(step, end, 'pressure', 0.5)];
    if (pressure.some(p => !finite(p))) continue;
    const range = Math.max(...pressure) - Math.min(...pressure);
    const ys = LAGS.map(lag => {
      // Do not borrow another step's output just to improve the fit.
      if (start + lag < step[0].timestamp || end + lag > step[step.length - 1].timestamp) return null;
      const weightStart = at(scale, start + lag, 'weight', 1);
      const weightEnd = at(scale, end + lag, 'weight', 1);
      const y = curve(scale, start + lag, end + lag, 'weightFlow', 1);
      if (!(weightStart >= 5) || !(weightEnd > weightStart) || !(y >= 0.3)) return null;
      return y;
    });
    // V2 primary support must not depend on optional lag diagnostics.
    if (zeroOnly ? ys[2] === null : ys.some(y => y === null)) continue;
    blocks.push({ start, end, x: flow / historical, weight: 1 / (1 + (range / 0.5) ** 2), ys });
  }
  const duration = blocks.length ? blocks[blocks.length - 1].end - blocks[0].start : 0;
  const coverage = blocks.reduce((sum, b, i) => sum + (i && b.start < blocks[i - 1].end ? b.end - blocks[i - 1].end : 1), 0);
  if (blocks.length < 3 || coverage < 2) return fail('insufficient_last_step_evidence');
  const diagnosticBlocks = blocks.filter(b => b.ys.every(y => y !== null));
  const diagnosticCoverage = diagnosticBlocks.reduce((sum, b, i) => sum +
    (i && b.start < diagnosticBlocks[i - 1].end ? b.end - diagnosticBlocks[i - 1].end : 1), 0);
  const fits = diagnosticBlocks.length >= 3 && diagnosticCoverage >= 2 ? LAGS.map((lag, index) => ({ lag,
    ...regression(diagnosticBlocks.map(b => ({ ...b, y: b.ys[index] }))),
  })) : [];
  fits.sort((a, b) => (a.loss + Math.abs(a.lag) * 1e-6) - (b.loss + Math.abs(b.lag) * 1e-6));
  const flowVariation = (Math.max(...blocks.map(b => b.x)) - Math.min(...blocks.map(b => b.x))) /
    median(blocks.map(b => b.x));
  // Match the displayed curves; a per-shot lag must not change calibration.
  const best = zeroOnly ? { lag: 0, ...regression(blocks.map(b => ({ ...b, y: b.ys[2] }))) }
    : fits.find(f => f.lag === 0);
  const diagnosticBest = flowVariation < 0.1 ? fits.find(f => f.lag === 0) : fits[0];
  if (!finite(best.multiplier) || best.multiplier < 0.35 || best.multiplier > 2) return fail('out_of_range');
  const multipliers = fits.map(f => f.multiplier);
  const warnings = [];
  if (zeroOnly && !diagnosticBest) warnings.push('lag_diagnostics_unavailable');
  if (multipliers.length && (Math.max(...multipliers) - Math.min(...multipliers)) / best.multiplier > 0.1) warnings.push('timing_sensitive');
  if (best.loss > 0.02) warnings.push('high_residual');
  const meanPressureWeight = blocks.reduce((sum, b) => sum + b.weight, 0) / blocks.length;
  if (meanPressureWeight < 0.5) warnings.push('pressure_transitions_dominate');
  return { fitted: true, experimental: true, fitMethod: method, profileFrame: frame, meanPressureWeight,
    multiplier: best.multiplier, lagSeconds: best.lag, blocks: blocks.length,
    windowStart: blocks[0].start - machine[0].timestamp,
    windowEnd: blocks[blocks.length - 1].end - machine[0].timestamp,
    spanSeconds: duration, coverageSeconds: coverage,
    rmseBefore: best.rmse(historical), rmseAfter: best.rmse(best.multiplier),
    normalizedHuberLoss: best.loss,
    multiplierRangeAcrossLags: multipliers.length ? [Math.min(...multipliers), Math.max(...multipliers)] : null,
    lagDiagnostics: { available: !!diagnosticBest, identifiable: !!diagnosticBest && flowVariation >= 0.1,
      bestLagSeconds: diagnosticBest ? diagnosticBest.lag : null, bestMultiplier: diagnosticBest ? diagnosticBest.multiplier : null,
      rmseAfter: diagnosticBest ? diagnosticBest.rmse(diagnosticBest.multiplier) : null,
      atSearchBoundary: !!diagnosticBest && (diagnosticBest.lag === LAGS[0] || diagnosticBest.lag === LAGS[LAGS.length - 1]) }, warnings };
}

return fitFlow;
}
var experimentalFitFlow = createExperimentalFlowFitter(createMeasurementHelpers(), {"primaryZeroOnly":true});
function createFlowCalibrationUI(host, read, state, pin, models) {
  'use strict';
  var cache = { value: null, readAt: null, error: null }, revision = 0, closed = false, inflight = null, pushed = null;
  var open = { type: 'open', view: 'calibration', presentation: 'overlay', fit: true, closeOnShot: true };
  function number(n) { return typeof n === 'number' && isFinite(n) && n > 0; }
  function matches(info) {
    return info && models.indexOf(info.model) >= 0 && pin() && String(info.serialNumber) === pin();
  }
  function pauseMessage(reason) {
    var messages = {
      wrong_machine: 'Connect the DE1 selected in the plugin settings before continuing.',
      expected_serial_required: 'Enter your DE1 serial number in the plugin settings first.',
      external_change_detected: 'The value was changed outside this plugin. Check it before continuing.',
      enable_only_while_idle: 'Wait until your machine is idle before enabling calibration.',
      startup_context_changed: 'The machine or profile changed during setup. Check both before continuing.',
      unsupported_live_multiplier: 'The machine value is outside the supported range.',
      unresolved_write_intent: 'The last change was not confirmed. Check the machine value before trying again.',
      write_outcome_unresolved: 'The last change was not confirmed. Check the machine value before trying again.',
      write_verification_failed: 'The last change could not be checked on the machine. Do not retry yet.'
    };
    if (typeof messages[reason] === 'string') return messages[reason];
    if (String(reason).indexOf('read_failed:') === 0) return 'The machine could not be read. Check its connection.';
    if (String(reason).indexOf('storage_') === 0 || reason === 'invalid_saved_state') return 'The saved settings could not be safely loaded or saved. Check the support code below.';
    return 'Calibration needs attention. Check the support code below before continuing.';
  }
  function resultMessage(reason) {
    var messages = {
      armed_for_new_shots: 'Ready for your next shot.', applied_verified: 'The new value was checked on the machine.',
      no_write_needed: 'The value is close enough; no change was needed.', new_target: 'A new value was estimated from the last shot.',
      no_fit: 'Not enough usable shot data to suggest a new value.', manual_shot_ignored: 'Manual mode kept your chosen value.',
      profile_mode_saved: 'Your choice was saved for this profile.', deferred_busy: 'Waiting until the machine is idle.',
      old_or_duplicate_shot: 'An already processed shot was ignored.', wrong_shot_machine: 'The shot did not identify the selected machine.'
    };
    return typeof messages[reason] === 'string' ? messages[reason] : reason ? 'See the support code for more information.' : 'No recent update.';
  }
  function warningMessage(reason) {
    var messages = {
      lag_diagnostics_unavailable: 'Not enough data to compare flow timing.', timing_sensitive: 'Flow timing may affect the estimate.',
      high_residual: 'The flow measurements do not match closely.', pressure_transitions_dominate: 'Pressure changes may affect the estimate.'
    };
    return typeof messages[reason] === 'string' ? messages[reason] : 'Additional check: ' + String(reason).replace(/_/g, ' ');
  }
  function model() {
    var s = state(), decisions = s.decisions || [];
    var fitted = decisions.find(function (d) { return d.reason === 'new_target' && d.fit && d.fit.fitted; });
    var applied = decisions.find(function (d) { return d.reason === 'applied_verified'; });
    var profile = s.profile || null, manual = profile && profile.mode === 'manual';
    var mode = s.held ? 'Calibration paused' : s.stopped ? 'Calibration stopped' : !s.enabled ? 'Calibration is off'
      : !s.ready ? 'Connecting to your machine…' : s.unresolvedIntent ? 'Checking the last change…'
      : s.pending ? (manual ? 'Manual ×' + profile.manualValue.toFixed(3) + ' saved — not applied yet' : 'Waiting for the machine to be idle')
      : manual ? 'Manual — keep ×' + profile.manualValue.toFixed(3) : 'Automatic — adjusts after usable shots';
    var unavailable = cache.error;
    var value = unavailable ? null : cache.value;
    var machine = s.machines && s.machines['s:' + pin()];
    var outside = number(value) && machine && number(machine.expected) ? Math.abs(value - machine.expected) > 0.0015 : false;
    var warnings = fitted && Array.isArray(fitted.fit.warnings) ? fitted.fit.warnings : [];
    var help = !pin() ? 'Enter your DE1 serial number in the plugin settings first.'
      : !s.enabled ? 'Turn on Enable calibration changes in the plugin settings to edit values.'
      : s.held ? 'Check the pause message before changing calibration.'
      : !s.ready || s.stopped ? 'Wait until the machine is connected and calibration is ready.'
      : unavailable || !number(value) ? 'Check the machine connection, then tap Check again.'
      : !s.canSetMode ? 'Wait for the current change to finish.'
      : 'Auto restores the saved automatic or starting value, then uses new shots.';
    var notice = unavailable ? (unavailable === 'target_not_configured' ? 'Enter your DE1 serial number in the plugin settings first.'
      : unavailable === 'wrong_machine' || unavailable === 'machine_changed' ? 'Connect the DE1 selected in the plugin settings, then tap Check again.'
      : 'Cannot read the selected DE1. Check its connection, then tap Check again.')
      : s.held ? pauseMessage(s.held) : outside ? 'The value on your machine was changed outside this plugin.' : '';
    return { value: value, readAt: cache.readAt, error: unavailable, mode: mode, controlsHelp: help, notice: notice,
      profile: profile, context: s.context || null, canSetMode: s.canSetMode === true && !unavailable && number(value),
      automatic: !!s.enabled && !!s.ready && !s.stopped && !s.held && !manual,
      outsideUpdater: outside,
      lastTarget: fitted ? fitted.fit.multiplier : null, coverage: fitted ? fitted.fit.coverageSeconds : null,
      shotId: fitted ? fitted.shotId : null, warnings: warnings, warningText: warnings.map(warningMessage),
      lastApplied: applied ? applied.applied : null, appliedAt: applied ? applied.at : null,
      latestResult: decisions.length ? decisions[0].reason : null,
      resultText: resultMessage(decisions.length ? decisions[0].reason : null),
      supportCode: unavailable || s.held || (decisions.length ? decisions[0].reason : null) };
  }
  function changed(reason) {
    if (closed) return;
    if (reason === 'wrong_machine' || reason === 'unsupported_live_multiplier' || String(reason).indexOf('read_failed:/machine/') === 0) {
      cache = { value: null, readAt: cache.readAt, error: reason }; revision++;
    }
    try {
      var m = model();
      var signature = JSON.stringify([m.value, m.error, m.mode, m.lastTarget, m.lastApplied, m.profile, m.canSetMode]);
      if (signature === pushed) return;
      pushed = signature; host.emit('changed', { what: 'skin' });
    } catch (error) { /* A missing display/push capability must never stop calibration. */ }
  }
  function observe(info, value, readAt) {
    if (closed || !matches(info) || !number(value)) return;
    cache = { value: value, readAt: readAt || new Date().toISOString(), error: null };
    revision++; changed();
  }
  function refresh() {
    if (closed) return Promise.resolve(model());
    if (inflight) return inflight;
    var token = revision;
    inflight = (async function () {
      if (!pin()) throw new Error('target_not_configured');
      var before = await read('/machine/info');
      if (!matches(before)) throw new Error('wrong_machine');
      var calibration = await read('/machine/calibration');
      var readAt = new Date().toISOString();
      var after = await read('/machine/info');
      if (!matches(after) || before.model !== after.model || String(before.serialNumber) !== String(after.serialNumber)) throw new Error('machine_changed');
      if (!number(calibration.flowMultiplier)) throw new Error('invalid_reading');
      if (!closed && token === revision) observe(after, calibration.flowMultiplier, readAt);
    })().catch(function (error) {
      if (!closed && token === revision) {
        cache = { value: null, readAt: cache.readAt, error: String(error.message || error) };
        revision++; changed();
      }
    }).then(function () { return model(); }).finally(function () { inflight = null; });
    return inflight;
  }
  function skin() {
    var m = model();
    return { version: 1, surfaces: [{ id: 'flow-calibration', kind: 'tile-line', tile: 'temperature',
      text: number(m.value) ? (m.profile && m.profile.mode === 'manual' ? 'M×' : '×') + m.value.toFixed(3) : 'Cal —', size: 'medium',
      title: ('Flow calibration. Last checked: ' + (m.readAt ? String(m.readAt).replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'not checked yet') + '. Tap for details.').slice(0, 80),
      active: m.automatic && number(m.value), action: open }], live: { endpoint: 'changed' }, settingsOpen: open };
  }
  function json(request, status, data) {
    return { requestId: request.requestId, status: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(data) };
  }
  function frameAncestors(request) {
    var headers = request.headers || {}, source = '';
    Object.keys(headers).forEach(function (key) {
      if (key.toLowerCase() === 'origin' || (!source && key.toLowerCase() === 'referer')) {
        source = Array.isArray(headers[key]) ? headers[key][0] : headers[key];
      }
    });
    var match = String(source).match(/^(https?:\/\/[A-Za-z0-9.\-\[\]:]+)(?:\/|$)/);
    return match ? "frame-ancestors 'self' " + match[1] : "frame-ancestors 'self'";
  }
  function scriptJson(data) { return JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
  function page(request) {
    var dark = request.query && request.query.theme === 'dark';
    var returnTo = request.query && request.query.returnTo;
    if (typeof returnTo !== 'string' || !/^https?:\/\//i.test(returnTo)) returnTo = '';
    var colors = dark ? '--bg:#1f2328;--fg:#f2f2f2;--muted:#aab3bd;--line:#434950;--button:#30363e'
      : '--bg:#fff;--fg:#121212;--muted:#59636e;--line:#dce1e6;--button:#eef0f2';
    return { requestId: request.requestId, status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': frameAncestors(request) },
      body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flow calibration</title>' +
        '<style>html,body{margin:0;background:transparent;font-family:Inter,system-ui,sans-serif}' +
        '.card{' + colors + ';box-sizing:border-box;width:440px;max-width:100vw;max-height:100vh;overflow:auto;padding:20px;background:var(--bg);color:var(--fg);border-radius:16px;box-shadow:0 8px 32px #0004}' +
        'h1{font-size:24px;margin:0 0 6px;line-height:1.2}.muted{color:var(--muted);font-size:15px;line-height:1.45;margin:0}.value{font-size:56px;line-height:1.15;font-weight:700;letter-spacing:-2px;margin:12px 0 0;font-variant-numeric:tabular-nums}' +
        '#mode{margin:12px 0;font-size:17px;font-weight:600}dl{margin:0}dl>div{display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-top:1px solid var(--line);font-size:17px}dt{color:var(--muted)}dd{margin:0;text-align:right;overflow-wrap:anywhere;min-width:0}' +
        'form{margin:12px 0}label{display:block;font-size:15px;margin-bottom:8px}.controls{display:grid;grid-template-columns:64px minmax(75px,1fr) minmax(100px,1.4fr);gap:8px}input{min-width:0;width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);padding:8px;font:18px Inter,system-ui,sans-serif}button:disabled,input:disabled{opacity:.55;cursor:default}#action-message:empty{display:none}#action-message{margin-top:8px}' +
        '#message{margin-top:8px}#message:empty{display:none}details{margin-top:8px}summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-size:16px}summary::before{content:"›";font-size:22px;margin-right:8px}details[open]>summary::before{transform:rotate(90deg)}footer{margin-top:12px}nav{display:flex;gap:12px;margin-top:14px;position:sticky;bottom:0;background:var(--bg);padding-top:8px}button{flex:1;min-height:48px;padding:10px;border:0;border-radius:12px;background:var(--button);color:var(--fg);font:600 17px Inter,system-ui,sans-serif;cursor:pointer}button:focus-visible{outline:3px solid currentColor;outline-offset:3px}</style></head><body>' +
        '<section class="card" id="card" aria-labelledby="heading"><h1 id="heading">Flow calibration</h1><p class="muted">Flow multiplier on your machine</p><p class="muted" id="profile-title"></p>' +
        '<div class="value" id="value">—</div><p class="muted" id="read-time">Checking your machine…</p><p id="mode" role="status" aria-live="polite"></p>' +
        '<form id="override-form"><label for="manual-value">Manual value (0.350–2.000)</label><div class="controls"><button type="button" id="use-auto">Auto</button><input id="manual-value" type="text" inputmode="decimal" autocomplete="off" maxlength="8" aria-label="Manual value, 0.350 to 2.000"><button type="submit" id="set-manual">Use manual</button></div></form>' +
        '<p class="muted" id="control-help">Auto restores the saved automatic or starting value, then uses new shots.</p><p class="muted" id="action-message" role="status" aria-live="polite"></p>' +
        '<details id="fit-details"><summary>More details</summary><dl><div><dt>Last suggested value</dt><dd id="target">—</dd></div><div><dt>Last value set</dt><dd id="applied">—</dd></div><div><dt>Shot data used</dt><dd id="coverage">—</dd></div><div><dt>Shot</dt><dd id="shot">—</dd></div><div><dt>Data notes</dt><dd id="warnings">—</dd></div><div><dt>Last update</dt><dd id="result">—</dd></div><div><dt>Support code</dt><dd id="support-code">—</dd></div></dl>' +
        '<footer class="muted">This changes the machine’s flow estimate, not the profile’s flow target. Trial version: wait for a change to finish before starting another shot. A change already sent to the machine cannot be cancelled. Manual values follow profile names, even after recipe edits. Profiles with the same name share a value; renamed profiles need a new choice.</footer></details>' +
        '<p class="muted" id="message"></p>' +
        '<nav><button type="button" id="refresh">Check again</button><button type="button" id="close">Close</button></nav></section>' +
        '<script>(' + pageClient.toString() + ')(' + scriptJson(model()) + ',' + scriptJson(returnTo) + ');</script></body></html>' };
  }
  function pageClient(initial, returnTo) {
    var stopped = false, busy = false, controller = null, interval = null, changing = false, dirty = false, edit = null, latest = null, mustRefresh = false;
    function text(id, value) { var el = document.getElementById(id); if (el.textContent !== value) el.textContent = value; }
    function multiplier(n) { return typeof n === 'number' && isFinite(n) && n > 0 ? '×' + n.toFixed(3) : '—'; }
    function post(message) { if (window.parent !== window) window.parent.postMessage(message, '*'); }
    function size() { if (stopped) return; var card = document.getElementById('card'), box = card.getBoundingClientRect(); post({ type: 'streamline:size', width: Math.ceil(box.width), height: Math.ceil(card.scrollHeight || box.height) }); }
    function buttons() {
      var allowed = latest && latest.canSetMode && !changing && !mustRefresh;
      document.getElementById('refresh').disabled = changing;
      document.getElementById('manual-value').disabled = !allowed;
      document.getElementById('set-manual').disabled = !allowed || busy;
      document.getElementById('use-auto').disabled = !allowed || busy || latest.profile.mode === 'auto';
    }
    function paint(m) {
      latest = m;
      text('profile-title', m.profile ? 'Profile: ' + m.profile.title : 'No profile available yet');
      if (dirty && edit && m.profile && (edit.profileKey !== m.profile.key || edit.context !== m.context)) {
        mustRefresh = true; text('action-message', 'This page is out of date. Tap Check again before saving.');
      }
      if (!dirty) document.getElementById('manual-value').value = typeof (m.profile && m.profile.manualValue) === 'number' ? m.profile.manualValue.toFixed(3) : typeof m.value === 'number' ? m.value.toFixed(3) : '';
      text('control-help', m.controlsHelp || 'Auto restores the saved automatic or starting value, then uses new shots.');
      buttons();
      text('value', multiplier(m.value));
      text('read-time', m.error ? 'Cannot read the machine' : m.readAt ? 'Checked at ' + new Date(m.readAt).toLocaleTimeString() : 'No value read yet');
      text('mode', m.mode); text('target', multiplier(m.lastTarget)); text('applied', multiplier(m.lastApplied));
      text('coverage', typeof m.coverage === 'number' ? m.coverage.toFixed(1) + ' seconds' : '—');
      text('shot', m.shotId ? String(m.shotId).slice(0, 8) : '—');
      text('warnings', (m.warningText || []).length ? m.warningText.join(' ') : 'No extra notes.');
      text('result', m.resultText || 'No recent update.');
      text('support-code', m.supportCode || '—');
      text('message', m.notice || '');
      size();
    }
    async function refresh() {
      if (stopped || busy || changing || document.hidden) return;
      busy = true; buttons(); controller = new AbortController();
      var active = controller;
      var timeout = setTimeout(function () { active.abort(); }, 8000);
      try {
        var url = new URL(window.location.href); url.pathname = url.pathname.replace(/\/ui\/?$/, '/view'); url.search = '';
        var response = await fetch(url.href, { method: 'GET', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('unavailable');
        var next = await response.json(); if (!stopped) paint(next);
      } catch (error) {
        if (!stopped) { mustRefresh = true; buttons(); text('value', '—'); text('read-time', 'Cannot read the machine'); text('message', 'Check the machine connection, then tap Check again.'); text('action-message', 'Tap Check again before changing a value.'); size(); }
      } finally { clearTimeout(timeout); busy = false; controller = null; if (!stopped) buttons(); }
    }
    async function changeMode(mode) {
      if (stopped || changing || busy || mustRefresh || !latest || !latest.canSetMode) return;
      var value, raw = document.getElementById('manual-value').value.trim();
      if (mode === 'manual') {
        value = Number(raw.replace(',', '.'));
        if (!/^(?:\d+(?:[.,]\d{1,3})?|[.,]\d{1,3})$/.test(raw) || !isFinite(value) || value < 0.35 || value > 2) {
          text('action-message', 'Enter a value from 0.350 to 2.000, with no more than three decimal places.'); size(); return;
        }
      }
      var bound = edit || { profileKey: latest.profile.key, context: latest.context };
      changing = true; buttons(); text('action-message', 'Saving your choice…'); size();
      var command = new AbortController(), timeout = setTimeout(function () { command.abort(); }, 30000);
      var failureText = 'The change could not be confirmed. Tap Check again and review any pause message before retrying.';
      try {
        var url = new URL(window.location.href); url.pathname = url.pathname.replace(/\/ui\/?$/, '/mode'); url.search = '';
        var response = await fetch(url.href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: command.signal,
          body: JSON.stringify({ mode: mode, value: value, profileKey: bound.profileKey, context: bound.context }) });
        if (response.status === 409) failureText = 'This page is out of date or the machine is busy. Tap Check again.';
        var result = await response.json();
        if (!response.ok || result.saved !== true || typeof result.profile !== 'string') throw new Error('change_not_confirmed');
        if (!stopped) {
          dirty = false; edit = null; changing = false;
          document.getElementById('manual-value').blur(); document.getElementById('card').scrollTop = 0;
          text('action-message', result.waiting ? 'Saved for ' + result.profile + '. Not applied to the machine yet.'
            : mode === 'manual' ? 'Manual ×' + value.toFixed(3) + ' saved for ' + result.profile + '.' : 'Automatic calibration selected for ' + result.profile + '.');
          await refresh();
        }
      } catch (error) {
        if (!stopped) { mustRefresh = true; text('action-message', failureText); }
      } finally { clearTimeout(timeout); changing = false; if (!stopped) { buttons(); size(); } }
    }
    function cleanup() { if (stopped) return; stopped = true; clearInterval(interval); if (controller) controller.abort(); window.removeEventListener('resize', size); document.removeEventListener('visibilitychange', visible); document.getElementById('fit-details').removeEventListener('toggle', size); }
    function visible() { if (!document.hidden) refresh(); }
    document.getElementById('manual-value').addEventListener('input', function () {
      if (!dirty && latest && latest.profile) edit = { profileKey: latest.profile.key, context: latest.context };
      dirty = true;
    });
    document.getElementById('override-form').addEventListener('submit', function (event) { event.preventDefault(); return changeMode('manual'); });
    document.getElementById('use-auto').addEventListener('click', function () { return changeMode('auto'); });
    document.getElementById('refresh').addEventListener('click', function () {
      if (changing) return;
      dirty = false; edit = null; mustRefresh = false; text('action-message', ''); return refresh();
    });
    document.getElementById('close').addEventListener('click', function () {
      cleanup();
      if (window.parent !== window) post({ type: 'streamline:close' });
      else if (returnTo) window.location.assign(returnTo);
      else window.history.back();
    });
    document.getElementById('fit-details').addEventListener('toggle', size);
    window.addEventListener('resize', size); window.addEventListener('pagehide', cleanup, { once: true });
    document.addEventListener('visibilitychange', visible);
    post({ type: 'streamline:ready' }); paint(initial); refresh(); interval = setInterval(refresh, 5000);
  }
  return {
    observe: observe, changed: changed,
    stop: function () { closed = true; revision++; },
    handle: function (request) {
      if (['skin', 'ui', 'view'].indexOf(request.endpoint) < 0) return null;
      if (request.method && request.method !== 'GET') return json(request, 405, { error: 'read_only' });
      if (request.endpoint === 'skin') return json(request, 200, skin());
      if (request.endpoint === 'ui') return page(request);
      return refresh().then(function (m) { return json(request, 200, m); });
    }
  };
}

function createPlugin(host) {
  'use strict';
  var ID = FLOW_CAL_METADATA.id, VERSION = FLOW_CAL_METADATA.version, STORAGE_KEY = 'calibration-v2';
  var canonicalize = createMeasurementHelpers().canonicalize;
  var models = ['DE1', 'DE1Plus', 'DE1Pro', 'DE1XL', 'DE1Cafe', 'DE1XXL', 'DE1XXXL'];
  var enabled = false, expectedSerial = '', boundModel = null, stopped = true, ready = false, hydrated = false, held = null;
  var generation = 0, activeKey = null, activeTitle = null, pending = null, waiting = null, retryQueued = false, lastRetry = 0, controlBusy = false;
  var chain = Promise.resolve(), decisions = [], db = empty();
  var session = Date.now().toString(36) + '-' + Math.random().toString(36), revision = 0;
  var ui = createFlowCalibrationUI(host, get, status, function () { return expectedSerial; }, models);

  // Fresh versioned storage leaves the legacy 1.x state untouched; no migration is attempted.
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
      try { host.storage({ type: 'write', key: STORAGE_KEY, namespace: ID, data: JSON.parse(JSON.stringify(db)) }); }
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
