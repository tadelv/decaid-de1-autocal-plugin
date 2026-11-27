const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildPlugin } = require('../tools/build-plugin');

// Compiled controller plus the actual generated page client, sharing one simulated host.
const payload = buildPlugin();
const serial = 'trial-de1';
const filter = { title: 'Filter3', version: '1', steps: [{ name: 'pour', flow: 2 }] };
const dflow = { title: 'D-Flow / Step-down', version: '1', steps: [{ name: 'pour', pressure: 6 }] };

function runtime(saved) {
  let plugin, stored = saved;
  const posts = [], writes = [];
  const h = { current: 1, state: 'idle', workflow: { profile: structuredClone(filter) }, machine: { model: 'DE1Pro', serialNumber: serial },
    history: [{ timestamp: '2026-11-26T12:00:00.000000' }], posts, writes, stored: () => structuredClone(stored) };
  plugin = vm.runInNewContext(payload.plugin + '\ncreatePlugin', {
    setTimeout, clearTimeout,
    fetch: async (url, init = {}) => {
      const path = new URL(url).pathname;
      let body;
      if (path === '/api/v1/machine/info') body = h.machine;
      else if (path === '/api/v1/workflow') body = h.workflow;
      else if (path === '/api/v1/machine/state') body = { state: { state: h.state } };
      else if (path === '/api/v1/machine/calibration') {
        if (init.method === 'POST') { posts.push(JSON.parse(init.body)); h.current = JSON.parse(init.body).flowMultiplier; }
        body = { flowMultiplier: h.current };
      } else if (path === '/api/v1/shots') body = { items: h.history };
      else throw new Error('unexpected route ' + url);
      return { ok: true, status: 200, json: async () => structuredClone(body) };
    },
  })({ log() {}, storage(command) {
    if (command.type !== 'write') return;
    stored = structuredClone(command.data); writes.push(stored);
    queueMicrotask(() => plugin.onEvent({ name: 'storageWrite', payload: structuredClone(stored) }));
  } });
  h.plugin = plugin;
  h.status = () => JSON.parse(plugin.__httpRequestHandler({ endpoint: 'status' }).body);
  h.handle = async request => await plugin.__httpRequestHandler(request);
  h.event = async name => await plugin.onEvent({ name, payload: {} });
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

// Oleg's report: the paused command was 2.000, the read-back is now 1.000, the other profile is Manual 1.000.
async function seed(mode) {
  const seed = runtime(null);
  seed.current = 2; await seed.start();
  const filterKey = seed.status().profile.key;
  seed.workflow = { profile: structuredClone(dflow) }; await seed.event('workflowUpdated');
  assert.equal((await seed.mode('manual', 1)).status, 200);
  if (mode === 'manual') {
    seed.workflow = { profile: structuredClone(filter) }; await seed.event('workflowUpdated');
    assert.equal((await seed.mode('manual', 2)).status, 200);
  }
  const saved = seed.stored(), record = saved.machines['s:' + serial];
  record.programs[filterKey] = mode === 'manual' ? { target: 1.35, applied: 1.13 } : { target: 2, applied: 2 };
  saved.pending = { serial, model: 'DE1Pro', key: filterKey, shotId: null, expected: 2, command: 2, kind: 'learning' };
  return { saved, filterKey };
}

async function held(mode) {
  const { saved } = await seed(mode), h = runtime(saved);
  h.current = 1; h.workflow = { profile: structuredClone(filter) }; await h.start();
  assert.ok(h.status().held, 'a saved intent must hold the controller');
  assert.equal(h.posts.length, 0);
  return h;
}

function open(h) {
  const html = h.plugin.__httpRequestHandler({ endpoint: 'ui', method: 'GET', query: {}, headers: {} }).body;
  const elements = {};
  for (const match of html.matchAll(/id="([^"]+)"/g)) {
    const element = { textContent: '', listeners: {}, blur() {}, addEventListener(type, fn) { this.listeners[type] = fn; },
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

test('the generated page commits an Automatic reload through the compiled controller with zero commands', async () => {
  const h = await held('auto'), page = open(h);
  await new Promise(resolve => setImmediate(resolve));
  const e = page.elements;
  assert.equal(e['recovery-panel'].hidden, false);
  assert.match(e['recovery-summary'].textContent, /Filter3/);
  assert.match(e['recovery-values'].textContent, /Mode: Automatic · paused request ×2\.000 · current machine value ×1\.000/);
  assert.equal(e.recover.textContent, 'Keep ×1.000 in Automatic'); assert.equal(e.recover.disabled, true);
  await e.recover.listeners.click(); assert.equal(page.recoveries.length, 0);
  e['recovery-confirm'].checked = true; e['recovery-confirm'].listeners.change();
  await e.recover.listeners.click();
  assert.equal(page.recoveries.length, 1); assert.equal(page.recoveries[0].action, 'reload_current');
  assert.equal(page.recoveries[0].confirmSettled, true); assert.equal(page.recoveries[0].value, 1);
  assert.equal(h.status().held, null); assert.equal(h.status().profile.mode, 'auto');
  assert.equal(h.posts.length, 0, 'recovery must never send a calibration command');
  assert.equal(h.stored().machines['s:' + serial].expected, 1);
  assert.equal(h.stored().lastRecovery.authority, 'operator_confirmed_reload_current');
  assert.match(e['action-message'].textContent, /Kept ×1\.000 in Automatic for Filter3\. No new calibration change was sent\./);
  assert.match(e.mode.textContent, /Automatic/); assert.equal(e['recovery-panel'].hidden, true);
  const restart = runtime(h.stored()); restart.current = 1; restart.workflow = { profile: structuredClone(filter) };
  await restart.start();
  assert.equal(restart.status().held, null); assert.equal(restart.status().profile.mode, 'auto'); assert.equal(restart.posts.length, 0);
});

test('the generated page keeps a Manual profile in Manual and adopts only the read-back', async () => {
  const h = await held('manual'), page = open(h);
  await new Promise(resolve => setImmediate(resolve));
  const e = page.elements;
  assert.match(e['recovery-values'].textContent, /Mode: Manual · paused request ×2\.000 · current machine value ×1\.000/);
  assert.equal(e.recover.textContent, 'Keep ×1.000 in Manual');
  e['recovery-confirm'].checked = true; e['recovery-confirm'].listeners.change();
  await e.recover.listeners.click();
  assert.equal(page.recoveries[0].action, 'reload_current'); assert.equal(page.recoveries[0].value, 1);
  assert.equal(h.status().held, null); assert.equal(h.status().profile.mode, 'manual');
  assert.equal(h.status().profile.manualValue, 1); assert.equal(h.posts.length, 0);
  const m = h.stored().machines['s:' + serial];
  assert.equal(m.overrides['t:Filter3'], 1); assert.equal(m.overrides['t:' + dflow.title], 1);
  assert.deepEqual(m.programs[Object.keys(m.programs)[0]], { target: 1.35, applied: 1.13 });
  assert.match(e['action-message'].textContent, /Kept ×1\.000 in Manual for Filter3/);
});

test('a stale page request without the reload discriminator cannot accept the differing read-back', async () => {
  const h = await held('auto');
  const review = JSON.parse((await h.handle({ endpoint: 'view', method: 'GET' })).body).recovery, before = h.stored();
  const response = await h.handle({ endpoint: 'recover', method: 'POST',
    body: { context: review.context, profileKey: review.profileKey, value: review.value, confirmSettled: true } });
  assert.equal(response.status, 409);
  assert.deepEqual(h.stored(), before); assert.equal(h.posts.length, 0);
  assert.ok(h.status().held); assert.ok(h.status().unresolvedIntent);
});
