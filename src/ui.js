function createFlowCalibrationUI(host, read, state, pin, models) {
  'use strict';
  var cache = { value: null, readAt: null, error: null }, revision = 0, closed = false, inflight = null, pushed = null;
  var open = { type: 'open', view: 'calibration', presentation: 'overlay', fit: true, closeOnShot: true };
  function number(n) { return typeof n === 'number' && isFinite(n) && n > 0; }
  function fixed(n) { return typeof n === 'number' && isFinite(n) ? '×' + n.toFixed(3) : '—'; }
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
      unresolved_write_intent: 'The last change remains paused. Tap Check again to review recovery; do not resend it.',
      write_outcome_unresolved: 'The last change remains paused. Tap Check again to review recovery; do not resend it.',
      write_verification_failed: 'The last change could not be checked on the machine. Do not retry yet; tap Check again to review recovery.'
    };
    if (typeof messages[reason] === 'string') return messages[reason];
    if (String(reason).indexOf('read_failed:') === 0) return 'The machine could not be read. Check its connection.';
    if (String(reason).indexOf('storage_') === 0 || reason === 'invalid_saved_state') return 'The saved settings could not be safely loaded or saved. Check the support code below.';
    return 'Calibration needs attention. Check the support code below before continuing.';
  }
  function resultMessage(reason) {
    var messages = {
      recovered_manual: 'The checked value was kept in Manual. No new calibration change was sent.',
      recovered_auto: 'The checked value was kept in Automatic as the new starting value. No new calibration change was sent.',
      auto_started_from_current: 'Automatic starts from the current machine value. No new calibration change was sent.',
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
  function recoveryMessage(r) {
    if (!r) return '';
    if (r.available) return 'Paused request ' + fixed(r.command) + '; the machine now reads ' + fixed(r.value) + '. ' +
      (r.mode === 'manual' ? 'This keeps the profile in Manual and saves the current value as its manual value.'
        : 'This keeps the profile in Automatic and uses the current value as its new starting value.') +
      ' Confirm only after checking that the previous change has finished; no calibration command is sent.';
    var messages = { recovery_profile_mismatch: 'Select the profile of the paused change, then tap Check again.',
      machine_busy: 'Wait until the machine is idle, then tap Check again.', recovery_busy: 'Wait for the current operation to finish, then tap Check again.',
      wrong_machine: 'Connect the selected DE1 before reviewing recovery.' };
    return typeof messages[r.reason] === 'string' ? messages[r.reason] : 'Recovery is not available. Check the machine connection and support code; do not reset saved state.';
  }
  function model() {
    var s = state(), decisions = s.decisions || [];
    var fitted = decisions.find(function (d) { return d.reason === 'new_target' && d.fit && d.fit.fitted; });
    var applied = decisions.find(function (d) { return d.reason === 'applied_verified'; });
    var profile = s.profile || null, manual = profile && profile.mode === 'manual';
    var remembered = profile && typeof profile.rememberedManual === 'number' ? profile.rememberedManual : null;
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
      : 'Auto starts from the value your machine shows now, then uses new shots.' +
        (!manual && remembered !== null ? ' Saved Manual ×' + remembered.toFixed(3) + ' is kept for when you choose it.' : '');
    var notice = unavailable ? (unavailable === 'target_not_configured' ? 'Enter your DE1 serial number in the plugin settings first.'
      : unavailable === 'wrong_machine' || unavailable === 'machine_changed' ? 'Connect the DE1 selected in the plugin settings, then tap Check again.'
      : 'Cannot read the selected DE1. Check its connection, then tap Check again.')
      : s.held ? pauseMessage(s.held) : outside ? 'The value on your machine was changed outside this plugin.' : '';
    return { value: value, readAt: cache.readAt, error: unavailable, mode: mode, controlsHelp: help, notice: notice,
      recovery: s.recovery || null, recoveryText: recoveryMessage(s.recovery), verificationFailure: s.verificationFailure || null,
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
        'form{margin:12px 0}label{display:block;font-size:15px;margin-bottom:8px}.controls{display:grid;grid-template-columns:64px minmax(75px,1fr) minmax(100px,1.4fr);gap:8px}input{min-width:0;width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);padding:8px;font:18px Inter,system-ui,sans-serif}button:disabled,input:disabled{opacity:.55;cursor:default}#action-message:empty{display:none}#action-message{margin-top:8px}#recovery-panel{border:1px solid var(--line);border-radius:12px;padding:12px;margin-top:12px}#recovery-confirm{width:auto;margin-right:8px}#recovery-panel[hidden]{display:none}' +
        '#message{margin-top:8px}#message:empty{display:none}details{margin-top:8px}summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-size:16px}summary::before{content:"›";font-size:22px;margin-right:8px}details[open]>summary::before{transform:rotate(90deg)}footer{margin-top:12px}nav{display:flex;gap:12px;margin-top:14px;position:sticky;bottom:0;background:var(--bg);padding-top:8px}button{flex:1;min-height:48px;padding:10px;border:0;border-radius:12px;background:var(--button);color:var(--fg);font:600 17px Inter,system-ui,sans-serif;cursor:pointer}button:focus-visible{outline:3px solid currentColor;outline-offset:3px}</style></head><body>' +
        '<section class="card" id="card" aria-labelledby="heading"><h1 id="heading">Flow calibration</h1><p class="muted">Flow multiplier on your machine</p><p class="muted" id="profile-title"></p>' +
        '<div class="value" id="value">—</div><p class="muted" id="read-time">Checking your machine…</p><p id="mode" role="status" aria-live="polite"></p>' +
        '<form id="override-form"><label for="manual-value">Manual value (0.350–2.000)</label><div class="controls"><button type="button" id="use-auto">Auto</button><input id="manual-value" type="text" inputmode="decimal" autocomplete="off" maxlength="8" aria-label="Manual value, 0.350 to 2.000"><button type="submit" id="set-manual">Use manual</button></div></form>' +
        '<p class="muted" id="control-help">Auto starts from the value your machine shows now, then uses new shots.</p><p class="muted" id="action-message" role="status" aria-live="polite"></p>' +
        '<section id="recovery-panel" hidden aria-labelledby="recovery-heading"><h2 id="recovery-heading">Review the paused change</h2><p id="recovery-summary"></p><p id="recovery-values"></p><label><input id="recovery-confirm" type="checkbox"> I checked this machine and value, and the previous change has finished.</label><button type="button" id="recover" disabled>Keep current value</button></section>' +
        '<details id="fit-details"><summary>More details</summary><dl><div><dt>Verification checks</dt><dd id="verification">—</dd></div><div><dt>Last suggested value</dt><dd id="target">—</dd></div><div><dt>Last value set</dt><dd id="applied">—</dd></div><div><dt>Shot data used</dt><dd id="coverage">—</dd></div><div><dt>Shot</dt><dd id="shot">—</dd></div><div><dt>Data notes</dt><dd id="warnings">—</dd></div><div><dt>Last update</dt><dd id="result">—</dd></div><div><dt>Support code</dt><dd id="support-code">—</dd></div></dl>' +
        '<footer class="muted">This changes the machine’s flow estimate, not the profile’s flow target. Trial version: wait for a change to finish before starting another shot. A change already sent to the machine cannot be cancelled; Check again can keep a paused change’s current value in that profile’s own Auto or Manual mode without sending a calibration command. Manual values follow profile names, even after recipe edits. Profiles with the same name share a value; renamed profiles need a new choice.</footer></details>' +
        '<p class="muted" id="message"></p>' +
        '<nav><button type="button" id="refresh">Check again</button><button type="button" id="close">Close</button></nav></section>' +
        '<script>(' + pageClient.toString() + ')(' + scriptJson(model()) + ',' + scriptJson(returnTo) + ');</script></body></html>' };
  }
  function pageClient(initial, returnTo) {
    var stopped = false, busy = false, controller = null, interval = null, changing = false, dirty = false, edit = null, latest = null, mustRefresh = false, recoveryConsent = null;
    function text(id, value) { var el = document.getElementById(id); if (el.textContent !== value) el.textContent = value; }
    function multiplier(n) { return typeof n === 'number' && isFinite(n) && n > 0 ? '×' + n.toFixed(3) : '—'; }
    function post(message) { if (window.parent !== window) window.parent.postMessage(message, '*'); }
    function size() { if (stopped) return; var card = document.getElementById('card'), box = card.getBoundingClientRect(); post({ type: 'streamline:size', width: Math.ceil(box.width), height: Math.ceil(card.scrollHeight || box.height) }); }
    function buttons() {
      var allowed = latest && latest.canSetMode && !changing && !mustRefresh;
      document.getElementById('refresh').disabled = changing;
      document.getElementById('manual-value').disabled = !allowed;
      document.getElementById('set-manual').disabled = !allowed || busy;
      document.getElementById('use-auto').disabled = !allowed || busy;
      document.getElementById('recover').disabled = changing || busy || mustRefresh || !recoveryConsent || !latest || !latest.recovery || !latest.recovery.available;
    }
    function paint(m) {
      var previous = latest && latest.recovery, next = m.recovery;
      // Consent belongs to one exact reviewed request: context, profile, mode, value, paused command and pending intent.
      if (!previous || !next || previous.context !== next.context || previous.profileKey !== next.profileKey || previous.value !== next.value ||
          previous.mode !== next.mode || previous.command !== next.command || previous.intent !== next.intent || !next.available) {
        recoveryConsent = null; document.getElementById('recovery-confirm').checked = false;
      }
      latest = m;
      document.getElementById('recovery-panel').hidden = !next;
      document.getElementById('recovery-confirm').disabled = !next || !next.available || changing;
      text('recovery-summary', next ? (next.model || '') + (next.serial ? ' · ' + next.serial : '') +
        (next.profileTitle ? ' · ' + next.profileTitle : '') + ' — ' + (m.recoveryText || 'Review the paused change before continuing.') : '');
      text('recovery-values', next && typeof next.mode === 'string'
        ? 'Mode: ' + (next.mode === 'manual' ? 'Manual' : 'Automatic') + ' · paused request ' + multiplier(next.command) +
          ' · current machine value ' + multiplier(next.value) : '');
      text('recover', next && typeof next.value === 'number' && typeof next.mode === 'string'
        ? 'Keep ' + multiplier(next.value) + ' in ' + (next.mode === 'manual' ? 'Manual' : 'Automatic') : 'Keep current value');
      text('verification', m.verificationFailure && Array.isArray(m.verificationFailure.reasons) ? m.verificationFailure.reasons.join(', ') : '—');
      text('profile-title', m.profile ? 'Profile: ' + m.profile.title : 'No profile available yet');
      if (dirty && edit && m.profile && (edit.profileKey !== m.profile.key || edit.context !== m.context)) {
        mustRefresh = true; text('action-message', 'This page is out of date. Tap Check again before saving.');
      }
      if (!dirty) document.getElementById('manual-value').value = typeof (m.profile && m.profile.manualValue) === 'number' ? m.profile.manualValue.toFixed(3)
        : typeof (m.profile && m.profile.rememberedManual) === 'number' ? m.profile.rememberedManual.toFixed(3)
        : typeof m.value === 'number' ? m.value.toFixed(3) : '';
      text('control-help', m.controlsHelp || 'Auto starts from the value your machine shows now, then uses new shots.');
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
            : mode === 'manual' ? 'Manual ×' + value.toFixed(3) + ' saved for ' + result.profile + '.'
            : 'Automatic selected for ' + result.profile + '. ' +
              (typeof result.value === 'number' ? 'It starts from ' + multiplier(result.value) : 'It starts from the current machine value') +
              '; no change was sent.');
          await refresh();
        }
      } catch (error) {
        if (!stopped) { mustRefresh = true; text('action-message', failureText); }
      } finally { clearTimeout(timeout); changing = false; if (!stopped) { buttons(); size(); } }
    }
    async function recoverCurrent() {
      if (stopped || changing || busy || mustRefresh || !recoveryConsent || !latest || !latest.recovery || !latest.recovery.available) return;
      var bound = recoveryConsent; changing = true; buttons(); text('action-message', 'Saving the checked value…');
      var command = new AbortController(), timeout = setTimeout(function () { command.abort(); }, 30000);
      try {
        var url = new URL(window.location.href); url.pathname = url.pathname.replace(/\/ui\/?$/, '/recover'); url.search = '';
        var response = await fetch(url.href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: command.signal,
          body: JSON.stringify({ context: bound.context, profileKey: bound.profileKey, value: bound.value, confirmSettled: true, action: 'reload_current' }) });
        var result = await response.json();
        if (!response.ok || result.saved !== true || result.calibrationCommandSent !== false) throw new Error('recovery_not_confirmed');
        if (!stopped) {
          dirty = false; edit = null; recoveryConsent = null; changing = false;
          document.getElementById('recovery-confirm').checked = false;
          text('action-message', 'Kept ' + multiplier(result.value) + ' in ' + (result.mode === 'manual' ? 'Manual' : 'Automatic') +
            ' for ' + result.profile + '. No new calibration change was sent.');
          await refresh();
        }
      } catch (error) {
        if (!stopped) { mustRefresh = true; recoveryConsent = null; document.getElementById('recovery-confirm').checked = false;
          text('action-message', 'Recovery was not confirmed. Tap Check again; do not repeat it blindly.'); }
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
    document.getElementById('recovery-confirm').addEventListener('change', function () {
      var r = latest && latest.recovery;
      recoveryConsent = document.getElementById('recovery-confirm').checked && r && r.available ? { context: r.context, profileKey: r.profileKey, value: r.value } : null;
      buttons();
    });
    document.getElementById('recover').addEventListener('click', recoverCurrent);
    document.getElementById('refresh').addEventListener('click', function () {
      if (changing) return;
      dirty = false; edit = null; recoveryConsent = null; document.getElementById('recovery-confirm').checked = false;
      mustRefresh = false; text('action-message', ''); return refresh();
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
    observe: observe, changed: changed, model: model,
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
