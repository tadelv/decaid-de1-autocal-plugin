const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildPlugin } = require('../tools/build-plugin');

// Compiled controller plus the actual generated page client, sharing one simulated host.
const payload = buildPlugin();
const serial = 'trial-de1';
const filter = { title: 'Filter3', version: '1', steps: [{ name: 'pour', flow: 2 }] };
const dflow = { title: 'D-Flow / Step-down', version: '1', steps: [{ name: 'pour', pressure: 6 }] };

function shot(id, multiplier, second) {
  return { id, timestamp: `2026-11-26T12:00:${String(second).padStart(2, '0')}.000001`,
    workflow: { profile: structuredClone(filter), machine: { model: 'DE1Pro', serialNumber: serial, provenanceStatus: 'captured', flowCalibration: 1.13 } },
    measurements: Array.from({ length: 41 }, (_, i) => {
      const t = i / 4;
      return { machine: { timestamp: t, state: { state: 'espresso' }, profileFrame: 0, pressure: 6, flow: 2 * 1.13 },
        scale: { timestamp: t, weight: 10 + 2 * multiplier * t, weightFlow: 2 * multiplier } };
    }) };
}

function runtime(saved) {
  let plugin, stored = saved;
  const posts = [], writes = [], storage = { attempts: 0, fail: false, ack: true };
  const h = { current: 1, state: 'idle', workflow: { profile: structuredClone(filter) }, machine: { model: 'DE1Pro', serialNumber: serial },
    shots: [], history: [{ timestamp: '2026-11-26T12:00:00.000000' }], posts, writes, storage, ackHook: null, onGet: null,
    stored: () => structuredClone(stored) };
  plugin = vm.runInNewContext(payload.plugin + '\ncreatePlugin', {
    setTimeout: (fn, delay) => setTimeout(fn, Math.min(delay, 5)), clearTimeout,
    fetch: async (url, init = {}) => {
      const target = new URL(url), path = target.pathname, query = target.searchParams;
      // A transport hook so a test can act while a controller read is genuinely in flight.
      if (h.onGet) await h.onGet(path);
      let body;
      if (path === '/api/v1/machine/info') body = h.machine;
      else if (path === '/api/v1/workflow') body = h.workflow;
      else if (path === '/api/v1/machine/state') body = { state: { state: h.state } };
      else if (path === '/api/v1/machine/calibration') {
        if (init.method === 'POST') { posts.push(JSON.parse(init.body)); h.current = JSON.parse(init.body).flowMultiplier; }
        body = { flowMultiplier: h.current };
      } else if (path === '/api/v1/shots') {
        body = query.has('ids') ? h.shots.filter(item => item.id === query.get('ids')) : { items: h.history };
      } else throw new Error('unexpected route ' + url);
      return { ok: true, status: 200, json: async () => structuredClone(body) };
    },
  })({ log() {}, storage(command) {
    if (command.type !== 'write') return;
    storage.attempts++;
    if (storage.fail) throw new Error('disk failure');
    stored = structuredClone(command.data); writes.push(stored);
    if (storage.ack) queueMicrotask(() => {
      plugin.onEvent({ name: 'storageWrite', payload: structuredClone(stored) });
      // Runs after the acknowledgement and before the request continues, so a real-world change can land in that window.
      if (h.ackHook) h.ackHook();
    });
  } });
  h.plugin = plugin;
  h.status = () => JSON.parse(plugin.__httpRequestHandler({ endpoint: 'status' }).body);
  h.handle = async request => await plugin.__httpRequestHandler(request);
  h.event = async (name, payload = {}) => await plugin.onEvent({ name, payload });
  h.mode = async (mode, value) => {
    const s = h.status();
    return await h.handle({ endpoint: 'mode', method: 'POST', body: { mode, value, profileKey: s.profile && s.profile.key, context: s.context } });
  };
  h.start = async () => {
    plugin.onLoad({ Enabled: true, ExpectedSerial: serial });
    await plugin.onEvent({ name: 'storageRead', payload: { key: 'calibration-v2', value: stored } });
  };
  return h;
}

function open(h) {
  const html = h.plugin.__httpRequestHandler({ endpoint: 'ui', method: 'GET', query: {}, headers: {} }).body;
  const elements = {};
  for (const match of html.matchAll(/id="([^"]+)"/g)) {
    const element = { textContent: '', value: '', listeners: {}, blur() {}, addEventListener(type, fn) { this.listeners[type] = fn; },
      removeEventListener(type) { delete this.listeners[type]; }, getBoundingClientRect() { return { width: 440, height: 570 }; } };
    Object.defineProperty(element, 'innerHTML', { set() { throw new Error('Never inject remote HTML'); } });
    elements[match[1]] = element;
  }
  const page = { commands: [], recoveries: [], requests: [] };
  const document = { hidden: false, getElementById: id => elements[id], addEventListener() {}, removeEventListener() {} };
  const window = { parent: { postMessage() {} }, location: { href: 'http://tablet:8080/api/v1/plugins/test/ui?embed=1' },
    addEventListener() {}, removeEventListener() {}, history: { back() {} } };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document, window, URL, AbortController,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 2, clearInterval() {},
    fetch: async (url, init = {}) => {
      const endpoint = new URL(url).pathname.split('/').pop(), body = init.body ? JSON.parse(init.body) : undefined;
      page.requests.push(endpoint);
      if (init.method === 'POST') page[endpoint === 'recover' ? 'recoveries' : 'commands'].push(body);
      const answer = await h.plugin.__httpRequestHandler({ endpoint, method: init.method || 'GET', body, query: {}, headers: {} });
      return { ok: answer.status < 400, status: answer.status, json: async () => JSON.parse(answer.body) };
    },
  });
  return Object.assign(page, { elements });
}

test('the generated page starts Automatic from the live value without a calibration command and keeps Manual', async () => {
  const h = runtime(null); h.current = 1; await h.start();
  assert.equal(h.posts.length, 0, 'arming adopts the live value without a command');
  const page = open(h); await new Promise(resolve => setImmediate(resolve));
  const e = page.elements, key = h.status().profile.key;
  assert.equal(e.value.textContent, '×1.000');
  assert.match(e.mode.textContent, /Automatic/);
  assert.match(e['control-help'].textContent, /Auto starts from the value your machine shows now/);
  assert.equal(e['use-auto'].disabled, false, 'an explicit Automatic restart stays available');
  assert.equal(e['manual-value'].value, '1.000');
  const context = h.status().context;
  await e['use-auto'].listeners.click();
  assert.deepEqual(page.commands, [{ mode: 'auto', profileKey: key, context }], 'no unsaved form text is sent');
  assert.equal(h.posts.length, 0, 'an explicit Auto start must not send a calibration command');
  assert.equal(h.status().profile.mode, 'auto');
  assert.deepEqual(h.stored().machines['s:' + serial].programs[key], { target: 1, applied: 1 });
  assert.match(e['action-message'].textContent, /Automatic selected for Filter3\. It starts from ×1\.000; no change was sent\./);

  // An explicit Manual choice still applies through the guarded dispatch path.
  e['manual-value'].value = '2'; e['manual-value'].listeners.input();
  const beforeManual = h.status().context;
  await e['override-form'].listeners.submit({ preventDefault() {} });
  assert.deepEqual(page.commands[1], { mode: 'manual', value: 2, profileKey: key, context: beforeManual });
  assert.deepEqual(h.posts.map(p => p.flowMultiplier), [2]);
  assert.equal(h.current, 2); assert.equal(h.status().profile.mode, 'manual');
  assert.match(e.mode.textContent, /Manual — keep ×2\.000/);

  // The machine now reads 1.000, changed outside this plugin: Automatic starts there and keeps Manual 2.000.
  h.current = 1;
  await e.refresh.listeners.click();
  assert.equal(e.value.textContent, '×1.000');
  // An unsaved draft in the Manual form is not a saved Manual choice: it is never sent, saved or remembered.
  e['manual-value'].value = '1.500'; e['manual-value'].listeners.input();
  const draftContext = h.status().context;
  await e['use-auto'].listeners.click();
  assert.deepEqual(page.commands[2], { mode: 'auto', profileKey: key, context: draftContext }, 'a typed draft is not sent with Automatic');
  assert.equal(h.posts.length, 1, 'Automatic still sends nothing');
  assert.equal(h.status().profile.mode, 'auto'); assert.equal(h.status().profile.manualValue, null);
  assert.equal(h.status().profile.rememberedManual, 2);
  assert.equal(e['manual-value'].value, '2.000', 'the saved Manual value is offered again, not the draft and not the live value');
  assert.equal(h.stored().machines['s:' + serial].manual['t:Filter3'], 2, 'the draft never replaced the remembered Manual value');
  assert.equal(e.value.textContent, '×1.000', 'the live value is unchanged');
  assert.match(e['control-help'].textContent, /Saved Manual ×2\.000 is kept/);
  assert.match(e['action-message'].textContent, /It starts from ×1\.000; no change was sent\./);

  // Selecting Manual with that offered value reapplies it; typing alone never did.
  await e['override-form'].listeners.submit({ preventDefault() {} });
  assert.deepEqual(h.posts.map(p => p.flowMultiplier), [2, 2]);
  assert.equal(h.current, 2); assert.equal(h.status().profile.mode, 'manual');
  assert.equal(h.status().profile.manualValue, 2);
  assert.equal(h.status().profile.rememberedManual, 2);
});

test('a restart keeps the remembered Manual under Automatic and only genuinely new shots teach it', async () => {
  const seed = runtime(null); seed.current = 1; await seed.start();
  assert.equal((await seed.mode('manual', 2)).status, 200); assert.equal(seed.current, 2);
  seed.current = 1; // afterwards the DE1 reads 1.000
  seed.history = [{ timestamp: '2026-11-26T12:00:04.000000' }]; // recorded before the explicit start
  assert.equal((await seed.mode('auto')).status, 200);
  const saved = seed.stored();
  const h = runtime(saved); h.current = 1; h.history = [{ timestamp: '2026-11-26T12:00:04.000000' }];
  await h.start();
  assert.equal(h.status().held, null); assert.equal(h.status().profile.mode, 'auto');
  assert.equal(h.status().profile.manualValue, null); assert.equal(h.status().profile.rememberedManual, 2);
  assert.equal(h.posts.length, 0);
  const page = open(h); await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.elements['manual-value'].value, '2.000');
  assert.equal(page.elements.value.textContent, '×1.000');

  h.shots.push(shot('late', .7, 3));
  await h.event('shotStored', { id: 'late' });
  assert.equal(h.posts.length, 0); assert.equal(h.current, 1, 'a shot that predates the start cannot teach Automatic');
  const fresh = shot('fresh', 1.6);
  fresh.timestamp = new Date(h.stored().machines['s:' + serial].recoveryCutoff + 60000).toISOString();
  h.shots.push(fresh);
  await h.event('shotStored', { id: 'fresh' });
  assert.equal(h.posts.length, 1); assert.ok(h.current > 1.5, 'a genuinely new shot still learns');
  const learned = h.current;

  // Profile switches keep their existing recall; the remembered Manual never seeds Automatic.
  h.workflow = { profile: structuredClone(dflow) }; await h.event('workflowUpdated');
  assert.equal(h.status().profile.mode, 'auto'); assert.equal(h.current, 1);
  h.workflow = { profile: structuredClone(filter) }; await h.event('workflowUpdated');
  assert.equal(h.status().profile.mode, 'auto'); assert.equal(h.current, learned);
  assert.equal(h.status().profile.rememberedManual, 2);
});

test('an unacknowledged Auto start claims no success and a reload reads the committed state honestly', async () => {
  const h = runtime(null); h.current = 1; await h.start();
  assert.equal((await h.mode('manual', 2)).status, 200); assert.equal(h.current, 2);
  h.current = 1;
  h.storage.ack = false;
  const response = await h.mode('auto');
  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(response.body), { error: 'storage_ack_timeout', uncertain: true });
  assert.equal(h.status().held, 'storage_ack_timeout');
  assert.equal(h.posts.length, 1, 'no calibration command is sent on an unacknowledged start');
  await h.event('storageWrite', h.stored()); // a late acknowledgement cannot revive the failed request
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.status().held, 'storage_ack_timeout'); assert.equal(h.posts.length, 1);
  const committed = h.stored(), record = committed.machines['s:' + serial];
  assert.equal(record.expected, 1); assert.deepEqual(record.manual, { 't:Filter3': 2 });
  const reload = runtime(committed); reload.current = 1; await reload.start();
  assert.equal(reload.status().held, null); assert.equal(reload.status().profile.mode, 'auto');
  assert.equal(reload.status().profile.rememberedManual, 2); assert.equal(reload.posts.length, 0);
});

test('the page never reports an Automatic start that changed while it was being acknowledged', async () => {
  const h = runtime(null); h.current = 1; await h.start();
  const page = open(h); await new Promise(resolve => setImmediate(resolve));
  const posts = h.posts.length;
  h.ackHook = () => { h.current = 1.5; }; // the machine moves on inside the acknowledgement window
  await page.elements['use-auto'].listeners.click();
  assert.equal(h.current, 1.5);
  assert.equal(h.posts.length, posts, 'a failed start sends no calibration command');
  assert.doesNotMatch(page.elements['action-message'].textContent, /Automatic selected|starts from/);
  assert.match(page.elements['action-message'].textContent, /out of date or the machine is busy/);
  // The committed record is read back honestly by a reload: no confirmed start from the stale reading.
  const reload = runtime(h.stored()); reload.current = 1.5; await reload.start();
  assert.equal(reload.status().held, null); assert.equal(reload.status().profile.mode, 'auto');
  assert.equal(reload.stored().machines['s:' + serial].expected, 1.5); assert.equal(reload.posts.length, 0);
});

// The committed write is not proof of the start either: the controller itself can be gone before, or while,
// the confirmation read it answers. These two use the transport hook rather than the acknowledgement window.
test('an unload during the confirmation read cannot report a successful Automatic start', async () => {
  const h = runtime(null); h.current = 1; await h.start();
  assert.equal(h.posts.length, 0);
  const writesBefore = h.writes.length;
  let armed = true;
  // The first machine read after this request's own committed write is its post-acknowledgement confirmation read.
  h.onGet = path => {
    if (!armed || h.writes.length === writesBefore || path !== '/api/v1/machine/info') return;
    armed = false; h.plugin.onUnload();
  };
  const response = await h.mode('auto');
  const reasons = h.status().decisions.map(decision => decision.reason);
  assert.equal(h.posts.length, 0, 'an unloaded controller sends no calibration command');
  assert.equal(response.status, 409, 'an unconfirmed start is not a success: ' + response.body);
  assert.deepEqual(JSON.parse(response.body), { error: 'stale_context' });
  assert.ok(!reasons.includes('auto_started_from_current'), 'no success decision after unload: ' + reasons.join(','));
  assert.ok(reasons.includes('auto_start_not_confirmed'), 'the unconfirmed start is recorded: ' + reasons.join(','));
});

test('a profile round trip during the confirmation read cannot report a successful Automatic start', async () => {
  const h = runtime(null); h.current = 1; await h.start();
  const writesBefore = h.writes.length;
  let armed = true;
  // The workflow leaves this profile and comes back while the confirmation read is in flight, so the reading it
  // returns still shows the same profile key and the same value, yet this start is no longer the operator's choice.
  h.onGet = async path => {
    if (!armed || h.writes.length === writesBefore || path !== '/api/v1/machine/info') return;
    armed = false;
    h.workflow = { profile: structuredClone(dflow) };
    h.plugin.onEvent({ name: 'workflowUpdated' });
    await new Promise(resolve => setImmediate(resolve));
    h.workflow = { profile: structuredClone(filter) };
    h.plugin.onEvent({ name: 'workflowUpdated' });
    await new Promise(resolve => setImmediate(resolve));
  };
  const response = await h.mode('auto');
  const reasons = h.status().decisions.map(decision => decision.reason);
  assert.equal(h.posts.length, 0, 'an unconfirmed start sends no calibration command');
  assert.equal(response.status, 409, 'an unconfirmed start is not a success: ' + response.body);
  assert.deepEqual(JSON.parse(response.body), { error: 'stale_context' });
  assert.ok(!reasons.includes('auto_started_from_current'), 'no success decision after the round trip: ' + reasons.join(','));
  assert.ok(reasons.includes('auto_start_not_confirmed'), 'the unconfirmed start is recorded: ' + reasons.join(','));
});
