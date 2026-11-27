const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { buildPlugin } = require('../tools/build-plugin');

function harness() {
  const calls = [], pushes = [];
  const state = { enabled: true, ready: true, stopped: false, held: null, pending: null, unresolvedIntent: null,
    expectedSerial: 'target', canSetMode: true, context: 'epoch-1', profile: { key: 'filter3', title: 'Filter 3', mode: 'auto', manualValue: null }, machines: { 's:target': { expected: .881 } }, decisions: [
      { reason: 'new_target', shotId: 'last-shot', historicalMultiplier: .956,
        fit: { fitted: true, multiplier: .881344, coverageSeconds: 4.5, warnings: [] } },
      { reason: 'applied_verified', previous: .956, applied: .881, at: '2026-11-26T12:00:00Z' },
    ] };
  const h = { current: .881, info: { model: 'DE1Pro', serialNumber: 'target' }, state, calls, pushes, pin: 'target', fail: false, hook: null };
  const factory = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ui.js'), 'utf8') + '\ncreateFlowCalibrationUI');
  h.ui = factory({ emit(name, data) { pushes.push({ name, data: JSON.parse(JSON.stringify(data)) }); } }, async route => {
    calls.push(route); if (h.hook) await h.hook(route);
    if (h.fail) throw new Error('offline');
    return route === '/machine/info' ? structuredClone(h.info) : { flowMultiplier: h.current };
  }, () => state, () => h.pin, ['DE1Pro']);
  h.skin = () => JSON.parse(h.ui.handle({ endpoint: 'skin' }).body);
  h.model = async () => JSON.parse((await h.ui.handle({ endpoint: 'view' })).body);
  h.page = query => h.ui.handle({ endpoint: 'ui', query: query || {}, headers: {} });
  return h;
}

test('Brew line shows last-read machine value, never fitted target; skin/page do no I/O', () => {
  const h = harness();
  assert.equal(h.skin().surfaces[0].text, 'Cal —');
  assert.match(h.skin().surfaces[0].title, /Last checked: not checked yet/);
  h.ui.observe(h.info, 1.13);
  const surface = h.skin().surfaces[0];
  assert.equal(surface.kind, 'tile-line'); assert.equal(surface.tile, 'temperature');
  assert.equal(surface.text, '×1.130'); assert.equal(surface.size, 'medium');
  assert.equal(surface.action.type, 'open'); assert.equal(surface.action.closeOnShot, true);
  assert.equal(h.skin().live.endpoint, 'changed');
  h.page(); assert.equal(h.calls.length, 0);
  assert.ok(h.pushes.every(p => p.name === 'changed' && p.data.what === 'skin'));
});

test('fresh card reading uses only info/calibration/info, preserves controller state and exposes target separately', async () => {
  const h = harness(), before = JSON.stringify(h.state);
  h.current = .95; const m = await h.model();
  assert.deepEqual(h.calls, ['/machine/info', '/machine/calibration', '/machine/info']);
  assert.equal(m.value, .95); assert.equal(m.lastTarget, .881344);
  assert.equal(m.outsideUpdater, true);
  assert.equal(JSON.stringify(h.state), before);
  assert.match(h.skin().surfaces[0].text, /0\.950/);
});

test('failed reads and wrong/replaced machines cannot masquerade as current verified values', async () => {
  for (const change of [h => { h.fail = true; }, h => { h.info.serialNumber = 'other'; }, h => { h.info.model = 'Bengle'; }]) {
    const h = harness(); h.ui.observe(h.info, .881); change(h);
    const m = await h.model(); assert.equal(m.value, null); assert.ok(m.error);
    assert.equal(h.skin().surfaces[0].text, 'Cal —');
  }
  const h = harness(); let reads = 0;
  h.hook = route => { if (route === '/machine/info' && ++reads === 2) h.info.serialNumber = 'other'; };
  assert.equal((await h.model()).value, null);
});

test('manual value outside automatic bounds is displayed without clamping or changing automation', async () => {
  const h = harness(); h.current = .13;
  const m = await h.model(); assert.equal(m.value, .13); assert.equal(h.state.machines['s:target'].expected, .881);
});

test('late card read cannot overwrite a newer writer observation; unload ignores late completion', async () => {
  const h = harness(); let release;
  h.hook = async route => { if (route === '/machine/calibration') await new Promise(resolve => { release = resolve; }); };
  const request = h.model(); while (!release) await Promise.resolve();
  h.ui.observe(h.info, 1.2); release();
  assert.equal((await request).value, 1.2);
  const second = h.model(); release = null; while (!release) await Promise.resolve();
  const count = h.pushes.length; h.ui.stop(); release(); await second;
  assert.equal(h.pushes.length, count);
});

test('UI states distinguish off, pending and held; HTTP write methods have no effects', async () => {
  const h = harness();
  for (const endpoint of ['skin', 'ui', 'view']) {
    const response = await h.ui.handle({ endpoint, method: 'POST', body: { flowMultiplier: 2 } });
    assert.equal(response.status, 405);
  }
  assert.equal(h.calls.length, 0);
  h.state.enabled = false; assert.match((await h.model()).mode, /off/i);
  h.state.enabled = true; h.state.pending = {}; assert.match((await h.model()).mode, /waiting/i);
  h.state.held = 'external_change_detected'; assert.match((await h.model()).mode, /paused/i);
});

test('overlay is themed, escaped, responsive and offers explicit mode controls, with strict framing origin extraction', () => {
  const h = harness(); h.state.decisions[0].shotId = '</script><img onerror=evil()>';
  const response = h.ui.handle({ endpoint: 'ui', query: { theme: 'dark', returnTo: 'javascript:evil()' }, headers: { Referer: 'http://skin.home:8044/dashboard' } });
  assert.match(response.headers['Content-Security-Policy'], /frame-ancestors 'self' http:\/\/skin\.home:8044/);
  assert.equal((response.body.match(/<script>/g) || []).length, 1);
  assert.ok(!response.body.includes('</script><img'));
  assert.ok(!response.body.includes('javascript:evil()'));
  assert.match(response.body, /streamline:ready/); assert.match(response.body, /streamline:size/); assert.match(response.body, /streamline:close/);
  assert.match(response.body, /Use manual/); assert.match(response.body, /max-width/);
  assert.ok(response.body.includes("method: 'POST'"));
  assert.match(response.body, /0\.350–2\.000/);
});

function browser(h = harness()) {
  const html = h.page().body;
  const elements = {};
  for (const match of html.matchAll(/id="([^"]+)"/g)) {
    elements[match[1]] = { textContent: '', listeners: {}, blur() {}, addEventListener(type, fn) { this.listeners[type] = fn; }, removeEventListener(type) { delete this.listeners[type]; },
      getBoundingClientRect() { return { width: 440, height: 570 }; } };
    Object.defineProperty(elements[match[1]], 'innerHTML', { set() { throw new Error('Never inject remote HTML'); } });
  }
  const messages = [], events = {}, documentEvents = {}, timers = [];
  const b = { reads: 0, offline: false, cleared: false, failCommand: false, commands: [],
    model: { value: .75, mode: 'Auto', readAt: '2026-11-26T12:00:00Z',
      lastTarget: .76, lastApplied: .75, coverage: 4.5, shotId: '<img onerror=bad()>', warnings: ['timing_sensitive'],
      warningText: ['Flow timing may affect the estimate.'], resultText: 'The new value was checked on the machine.', supportCode: 'applied_verified',
      profile: { key: 'filter3', title: 'Filter 3', mode: 'auto', manualValue: null }, context: 'epoch-1', canSetMode: true } };
  const document = { hidden: false, getElementById: id => elements[id],
    addEventListener(type, fn) { documentEvents[type] = fn; }, removeEventListener(type) { delete documentEvents[type]; } };
  const window = { parent: { postMessage: m => messages.push(m) }, location: { href: 'http://tablet:8080/api/v1/plugins/test/ui?embed=1' },
    addEventListener(type, fn) { events[type] = fn; }, removeEventListener(type) { delete events[type]; }, history: { back() {} } };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document, window, URL, AbortController,
    setTimeout: () => 1, clearTimeout() {}, setInterval(fn) { timers.push(fn); return 2; }, clearInterval() { b.cleared = true; },
    fetch: async (url, init) => {
      b.reads++;
      const route = new URL(url).pathname;
      if (route.endsWith('/mode')) {
        assert.equal(init.method, 'POST'); assert.equal(init.headers['Content-Type'], 'application/json');
        const command = JSON.parse(init.body); b.commands.push(command);
        if (b.failCommand) throw new Error('Request not confirmed. Refresh before retrying.');
        if (b.commandStatus) return { ok: false, status: b.commandStatus, json: async () => ({ error: 'raw_backend_error_identifier' }) };
        b.model.profile = { ...b.model.profile, mode: command.mode, manualValue: command.mode === 'manual' ? command.value : null };
        b.model.value = command.mode === 'manual' ? command.value : .75;
        b.model.context = 'epoch-' + (b.commands.length + 1);
        return { ok: true, json: async () => ({ saved: true, profile: b.model.profile.title }) };
      }
      assert.equal(route, '/api/v1/plugins/test/view'); assert.equal(init.method, 'GET');
      if (b.offline) throw new Error('offline');
      return { ok: true, json: async () => structuredClone(b.model) };
    },
  });
  return Object.assign(b, { elements, messages, events, documentEvents, timers });
}

test('browser card signals ready/size, renders fresh values safely, clears failed reads and cleans up polling', async () => {
  const b = browser(), { elements, messages, events, documentEvents, timers } = b;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages[0].type, 'streamline:ready'); assert.ok(messages.some(m => m.type === 'streamline:size'));
  assert.equal(elements.value.textContent, '×0.750'); assert.equal(elements.warnings.textContent, 'Flow timing may affect the estimate.');
  b.offline = true; await elements.refresh.listeners.click();
  assert.equal(elements.value.textContent, '—'); assert.equal(elements['read-time'].textContent, 'Cannot read the machine');
  b.offline = false; await timers[0]();
  assert.equal(elements.value.textContent, '×0.750'); assert.equal(elements['set-manual'].disabled, true);
  assert.match(elements['action-message'].textContent, /Check again/);
  await elements.refresh.listeners.click(); assert.equal(elements['set-manual'].disabled, false);
  elements.close.listeners.click(); assert.equal(b.cleared, true); assert.equal(messages.at(-1).type, 'streamline:close');
  assert.equal(events.resize, undefined); assert.equal(documentEvents.visibilitychange, undefined);
  const previous = b.reads; await timers[0](); assert.equal(b.reads, previous);
});

test('manual state exposes the saved setting separately from the machine value and marks the Brew caption', async () => {
  const h = harness(); h.state.profile.mode = 'manual'; h.state.profile.manualValue = 2;
  const model = await h.model();
  assert.equal(model.value, .881); assert.equal(model.profile.manualValue, 2);
  assert.equal(model.mode, 'Manual — keep ×2.000'); assert.equal(model.automatic, false);
  assert.equal(h.skin().surfaces[0].text, 'M×0.881');
  h.state.pending = {}; assert.equal((await h.model()).mode, 'Manual ×2.000 saved — not applied yet');
});

test('browser submits explicit manual/Auto commands, validates decimals and keeps draft bound to its original context', async () => {
  const b = browser(), e = b.elements; await new Promise(resolve => setImmediate(resolve));
  assert.equal(e['use-auto'].disabled, true);
  for (const bad of ['2.001', '.349', '1.0001', 'invalid']) {
    e['manual-value'].value = bad; e['manual-value'].listeners.input();
    await e['override-form'].listeners.submit({ preventDefault() {} });
  }
  assert.equal(b.commands.length, 0); assert.match(e['action-message'].textContent, /three decimal/);
  e['manual-value'].value = '2,000'; e['manual-value'].listeners.input();
  await e['override-form'].listeners.submit({ preventDefault() {} });
  assert.deepEqual(b.commands[0], { mode: 'manual', value: 2, profileKey: 'filter3', context: 'epoch-1' });
  assert.equal(e.value.textContent, '×2.000'); assert.equal(e['use-auto'].disabled, false);
  await e['use-auto'].listeners.click();
  assert.deepEqual(b.commands[1], { mode: 'auto', profileKey: 'filter3', context: 'epoch-2' });
  assert.equal(e.value.textContent, '×0.750');

  e['manual-value'].value = '1.900'; e['manual-value'].listeners.input();
  b.model.profile = { key: 'other', title: 'Other profile', mode: 'auto', manualValue: null }; b.model.context = 'new-context';
  await b.timers[0]();
  assert.match(e['action-message'].textContent, /out of date/); assert.equal(e['set-manual'].disabled, true);
  await e['override-form'].listeners.submit({ preventDefault() {} }); assert.equal(b.commands.length, 2);
  await e.refresh.listeners.click(); assert.equal(e['set-manual'].disabled, false);
  assert.equal(e['manual-value'].value, '0.750');
});

test('failed browser mode request is never automatically retried and requires an explicit refresh', async () => {
  const b = browser(), e = b.elements; await new Promise(resolve => setImmediate(resolve));
  b.failCommand = true; e['manual-value'].value = '2'; e['manual-value'].listeners.input();
  await e['override-form'].listeners.submit({ preventDefault() {} });
  assert.equal(b.commands.length, 1); assert.equal(e['set-manual'].disabled, true);
  await b.timers[0](); assert.equal(b.commands.length, 1); assert.equal(e['set-manual'].disabled, true);
  await e.refresh.listeners.click(); assert.equal(e['set-manual'].disabled, false);
});

test('pause messages explain the action without showing internal codes as the main status', async () => {
  const h = harness();
  for (const [reason, message] of [
    ['external_change_detected', /changed outside this plugin/],
    ['wrong_machine', /Connect the DE1 selected/],
    ['storage_ack_timeout', /saved settings/],
    ['write_verification_failed', /Do not retry yet/],
    ['read_failed:/machine/info', /Check its connection/],
    ['constructor', /support code/],
  ]) {
    h.state.held = reason;
    const m = await h.model(); assert.equal(m.mode, 'Calibration paused');
    assert.match(m.notice, message); assert.equal(m.supportCode, reason);
    assert.ok(!m.mode.includes(reason));
  }
  h.state.held = null; h.state.enabled = false;
  assert.match((await h.model()).controlsHelp, /Enable calibration changes/);
});

test('unconfigured and wrong targets point to the right setting or machine', async () => {
  const missing = harness(); missing.pin = '';
  const first = await missing.model();
  assert.match(first.notice, /DE1 serial number/); assert.match(first.controlsHelp, /DE1 serial number/);
  assert.equal(first.canSetMode, false);
  const wrong = harness(); wrong.info.serialNumber = 'other';
  assert.match((await wrong.model()).notice, /Connect the DE1 selected in the plugin settings/);
});

test('shot diagnostics get plain-language explanations while raw identifiers remain available for support', async () => {
  const h = harness();
  h.state.decisions[0].fit.warnings = ['lag_diagnostics_unavailable', 'timing_sensitive', 'high_residual', 'pressure_transitions_dominate'];
  const m = await h.model();
  assert.equal(m.resultText, 'A new value was estimated from the last shot.');
  assert.deepEqual(m.warningText, ['Not enough data to compare flow timing.', 'Flow timing may affect the estimate.', 'The flow measurements do not match closely.', 'Pressure changes may affect the estimate.']);
  assert.deepEqual(m.warnings, h.state.decisions[0].fit.warnings);
  const html = h.page().body, settings = buildPlugin().manifest.settings;
  assert.equal(settings.Enabled.label, 'Enable calibration changes');
  assert.equal(settings.ExpectedSerial.label, 'DE1 serial number');
  for (const text of ['Flow multiplier on your machine', 'Manual value', 'Use manual', 'Check again', 'More details', 'Support code']) assert.ok(html.includes(text));
  for (const jargon of ['Machine estimation multiplier', 'supervised writes', 'queued-write protection', 'Fit &amp; trial details']) assert.ok(!html.includes(jargon));
});

test('browser command failures tell the user what to do without exposing backend error text', async () => {
  for (const status of [409, 503]) {
    const b = browser(), e = b.elements; await new Promise(resolve => setImmediate(resolve));
    b.commandStatus = status; e['manual-value'].value = '2'; e['manual-value'].listeners.input();
    await e['override-form'].listeners.submit({ preventDefault() {} });
    assert.match(e['action-message'].textContent, status === 409 ? /out of date or the machine is busy/ : /could not be confirmed/);
    assert.match(e['action-message'].textContent, /Check again/);
    assert.ok(!e['action-message'].textContent.includes('raw_backend_error_identifier'));
    assert.equal(e['set-manual'].disabled, true); assert.equal(b.commands.length, 1);
  }
});

test('surface survives the real Streamline parser', { skip: !process.env.STREAMLINE_SOURCE }, async () => {
  const parser = await import(pathToFileURL(path.join(process.env.STREAMLINE_SOURCE, 'src/modules/plugin-surfaces.js')));
  const h = harness(); h.ui.observe(h.info, .881);
  const raw = h.skin(), parsed = parser.parseSkinAnswer(raw), manifest = buildPlugin().manifest;
  assert.equal(parsed.surfaces.length, 1); assert.equal(parsed.surfaces[0].text, raw.surfaces[0].text);
  assert.equal(parsed.surfaces[0].action.presentation, 'overlay'); assert.equal(parsed.surfaces[0].action.fit, true);
  assert.equal(parsed.surfaces[0].action.closeOnShot, true);
  assert.equal(parsed.settingsOpen.presentation, 'overlay'); assert.equal(parser.liveEndpoint(manifest, parsed.live), 'changed');
});
