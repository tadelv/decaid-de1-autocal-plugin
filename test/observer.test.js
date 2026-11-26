const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildObserver } = require('../tools/build-observer');
const { fitFlow } = require('../tools/experimental-flow-fit');
const payload = buildObserver();

function shot(name = 'short-output-tail') {
  const value = JSON.parse(JSON.stringify(require(`./fixtures/real-shots/${name}.json`)));
  value.workflow.machine = { ...value.workflow.machine, provenanceStatus: 'captured', serialNumber: 'test-machine', model: 'DE1Pro' };
  value.workflow.profile = { title: 'Observer test <script>' };
  return value;
}

function harness({ shots = [shot()], history = [], saved, failRead = false } = {}) {
  const calls = [], writes = [], logs = [];
  const plugin = vm.runInNewContext(payload.plugin + '\ncreatePlugin', {
    fetch: async (url, options) => {
      assert.equal(options.method, 'GET', 'observer must never make a write request');
      calls.push(url);
      if (failRead) throw new Error('offline');
      const u = new URL(url);
      let body;
      if (u.pathname === '/api/v1/machine/info') body = { model: 'DE1Pro', serialNumber: 'test-machine' };
      else if (u.pathname === '/api/v1/machine/calibration') body = { flowMultiplier: 1.13 };
      else if (u.pathname === '/api/v1/shots') {
        body = u.searchParams.has('ids') ? shots.filter(s => String(s.id) === u.searchParams.get('ids')) : { items: history };
      } else throw new Error('unexpected path');
      return { ok: true, status: 200, json: async () => body };
    },
  })({ log(s) { logs.push(s); }, storage(command) { if (command.type === 'write') writes.push(command); } });
  return { plugin, calls, writes, logs,
    status: () => JSON.parse(plugin.__httpRequestHandler({ endpoint: 'status' }).body),
    async start() { plugin.onLoad({ DryRun: false, Enabled: true }); await plugin.onEvent({ name: 'storageRead', payload: { key: 'records', value: saved } }); },
    async store(id) { await plugin.onEvent({ name: 'shotStored', payload: { id } }); },
  };
}

test('observer build contains only pure estimator helpers, never the legacy writer', () => {
  assert.equal(payload.manifest.id, 'auto-flow-cal-observer.reaplugin');
  assert.ok(!/apiPost|method:\s*['"]POST|require\(|module\.exports/.test(payload.plugin));
  const h = harness();
  assert.equal(h.plugin.version, payload.manifest.version);
  assert.equal(h.status().calibrationWritesAllowed, false);
});

test('shotStored analyzes immediately without a workflow event, persists and deduplicates', async () => {
  const h = harness(); await h.start();
  await h.store('short-output-tail'); await h.store('short-output-tail');
  const status = h.status();
  assert.equal(status.records.length, 1);
  assert.equal(status.records[0].fit.fitted, true);
  assert.equal(status.records[0].mode, 'observe_only');
  assert.equal(status.records[0].fitMethod, 'fixed_zero_lag_v1');
  assert.equal(status.records[0].observerVersion, payload.manifest.version);
  assert.equal(status.records[0].fit.lagSeconds, 0);
  assert.equal(status.records[0].observedMachineMultiplier, 1.13);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].namespace, payload.manifest.id);
  assert.equal(status.lastError, null);
});

for (const name of ['short-output-tail', 'noisy-pressure-plateau', 'accepted-control', 'missing-scale-control']) {
  test(`bundled runtime matches offline fit for ${name}`, async () => {
    const input = shot(name), h = harness({ shots: [input] }); await h.start(); await h.store(input.id);
    const actual = h.status().records[0].fit, expected = fitFlow(input);
    assert.deepEqual(actual, expected);
  });
}

test('observer handles shots during hydration and resumes saved diagnostics without duplicates', async () => {
  const h = harness(); h.plugin.onLoad(); await h.store('short-output-tail');
  assert.equal(h.status().records.length, 0);
  await h.plugin.onEvent({ name: 'storageRead', payload: { key: 'records' } });
  const records = h.status().records;
  const restart = harness({ saved: { version: 1, records }, history: [shot()] });
  await restart.start();
  assert.equal(restart.status().records.length, 1);
  assert.equal(restart.writes.length, 0);
});

test('upgrade preserves legacy records but re-fits recent shots using the new method', async () => {
  const legacy = { shotId: 'short-output-tail', profile: 'Legacy profile', mode: 'observe_only',
    fit: { fitted: true, multiplier: 1.008, lagSeconds: 0.75, warnings: [] } };
  const h = harness({ saved: { version: 1, records: [legacy] }, history: [shot()] });
  await h.start();
  const records = h.status().records;
  assert.equal(records.length, 2);
  assert.deepEqual(records[1], legacy);
  assert.equal(records[0].shotId, legacy.shotId);
  assert.equal(records[0].fitMethod, 'fixed_zero_lag_v1');
  assert.equal(records[0].fit.lagSeconds, 0);
  const ui = h.plugin.__httpRequestHandler({ endpoint: 'ui' }).body;
  assert.ok(ui.includes('legacy lag-optimized'));
  assert.ok(ui.includes('fixed_zero_lag_v1'));
  await h.store(legacy.shotId);
  assert.equal(h.status().records.length, 2);
});

test('unknown-machine shots do not produce a fitted calibration', async () => {
  const input = shot(); input.workflow.machine.serialNumber = 'different';
  const h = harness({ shots: [input] }); await h.start(); await h.store(input.id);
  assert.equal(h.status().records[0].fit.reason, 'different_or_unknown_machine');
});

test('startup seeds recent history and UI is escaped; reading endpoints does not evaluate', async () => {
  const h = harness({ history: [shot()] }); await h.start();
  const before = h.calls.length;
  const page = h.plugin.__httpRequestHandler({ endpoint: 'ui' });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('Observer test &lt;script&gt;'));
  assert.ok(page.body.includes('OBSERVE ONLY'));
  assert.equal(h.status().records.length, 1);
  assert.equal(h.calls.length, before);
  assert.equal(h.plugin.__httpRequestHandler({ endpoint: 'apply' }).status, 404);
});

test('read failure reports an error and unloading stops further observation', async () => {
  const h = harness({ failRead: true }); await h.start();
  assert.equal(h.status().lastError, 'offline');
  h.plugin.onUnload(); const before = h.calls.length;
  await h.store('short-output-tail');
  assert.equal(h.calls.length, before);
});
