const test = require('node:test');
const assert = require('node:assert/strict');
const { replay, update } = require('../tools/replay-update-rules');
const fixture = require('./fixtures/real-shots/accepted-control.json');
function shot(id, time, title = 'program', calibration = 1.13) {
  return { ...structuredClone(fixture), id, timestamp: `2026-11-25T${time}`,
    workflow: { machine: { flowCalibration: calibration, provenanceStatus: 'captured', model: 'DE1Pro', serialNumber: 'test-machine' },
      profile: { title, version: '1', steps: [{ name: 'pour' }] } } };
}

test('full updates follow the candidate, conservative updates are capped; both keep deadband', () => {
  const state = { tracked: 1.13, proposed: 1.13 };
  assert.deepEqual(update(state, 1.43, false), { tracked: 1.23, proposed: 1.23 });
  assert.deepEqual(update(state, 1.43, true), { tracked: 1.43, proposed: 1.43 });
  assert.deepEqual(update(state, 1.135, true), { tracked: 1.135, proposed: 1.13 });
  assert.equal(update(state, 1.14, true).proposed, 1.14);
});

test('replay sorts captures, deduplicates, isolates program identity and leaves inputs unchanged', () => {
  const a = shot('a', '01:00:00'), b = shot('b', '02:00:00'), c = shot('c', '03:00:00', 'different');
  const input = [c, b, a, structuredClone(a)];
  const before = JSON.stringify(input), result = replay(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.uniqueShots, 3);
  assert.equal(result.duplicateExports, 1);
  assert.equal(result.fitted, 3);
  assert.equal(result.programsWithFits, 2);
  assert.deepEqual(result.rows.map(r => r.sequence), [1, 2, 1]);
  assert.deepEqual(result.rows.map(r => r.title), ['program', 'program', 'different']);
  assert.equal(result.rows[0].group, result.rows[1].group);
  assert.notEqual(result.rows[0].group, result.rows[2].group);
  assert.deepEqual(replay([a, b]).rows, result.rows.slice(0, 2));
});

test('provenance, historical seed and failed fits cannot train', () => {
  const a = shot('a', '01:00:00'), b = shot('b', '02:00:00');
  delete a.workflow.machine.provenanceStatus;
  b.measurements.forEach(m => delete m.scale);
  assert.deepEqual(replay([a, b]).skipped, { invalid_provenance_or_program: 1, no_scale_data: 1 });
  for (const calibration of [3, .3496, 1.1304]) {
    const unsupported = shot('unsupported', '03:00:00', 'unsupported', calibration);
    unsupported.measurements.forEach(m => { if (m.machine) m.machine.flow *= calibration / 1.13; });
    assert.equal(replay([unsupported]).skipped.unsupported_historical_seed, 1);
  }
});

test('missing IDs, timestamps, conflicting duplicate exports and ambiguous ordering fail visibly', () => {
  const a = shot('a', '01:00:00');
  assert.throws(() => replay([{ ...a, id: null }]), /identity/);
  assert.throws(() => replay([{ ...a, timestamp: 'bad' }]), /timestamp/);
  assert.throws(() => replay([a, { ...a, stopReason: 'different' }]), /Conflicting/);
  assert.throws(() => replay([a, { ...a, id: 'b' }]), /Ambiguous/);
  const failed = structuredClone(a);
  failed.measurements.forEach(m => delete m.scale);
  assert.throws(() => replay([failed, { ...a, id: 'b' }]), /Ambiguous/);
});

test('supported multiplier range and step bounds hold across the grid', () => {
  for (let a = 350; a <= 2000; a += 7) {
    for (let c = 350; c <= 2000; c += 29) {
      const state = { tracked: a / 1000, proposed: a / 1000 };
      for (const full of [true, false]) {
        const next = update(state, c / 1000, full);
        assert.ok(next.proposed >= .35 && next.proposed <= 2);
        if (!full) assert.ok(Math.abs(next.proposed - state.proposed) <= .100000000001);
      }
    }
  }
});
