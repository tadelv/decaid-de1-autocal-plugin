const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../auto-flow-cal.reaplugin/plugin.js'), 'utf8');
const estimator = vm.runInNewContext(`${source}\ncreatePlugin`, {
  fetch() { throw new Error('Real-shot replay must not access the network'); },
})({
  log() {},
  storage() { throw new Error('Estimator replay must not access storage'); },
}).__test;

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/real-shots', `${name}.json`), 'utf8'));
}

function near(actual, expected, tolerance = 1e-6) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `expected ${actual} within ${tolerance} of ${expected}`);
}

for (const [name, longestOverlap] of [
  ['short-output-tail', 1.22],
  ['noisy-pressure-plateau', 0.45],
]) {
  test(`characterizes current rejection of real ${name}; not a desired acceptance rule`, () => {
    const shot = fixture(name);
    const result = estimator.estimateShot(shot);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'insufficient_stable_region');
    const machine = estimator.buildMachineFlatIntervals(shot.measurements);
    const scale = estimator.buildScaleFlatIntervals(shot.measurements);
    // intersectIntervals discards short regions, so measure raw pair overlap here.
    const longest = Math.max(0, ...machine.flatMap(a => scale.map(b =>
      Math.min(a.end, b.end) - Math.max(a.start, b.start))));
    near(longest, longestOverlap, 0.02);
  });
}

test('real accepted control retains its historical-multiplier-normalized estimate', () => {
  const result = estimator.estimateShot(fixture('accepted-control'));
  assert.equal(result.accepted, true);
  assert.equal(result.regionCount, 1);
  near(result.multiplier, 1.143823435666889);
  near(result.totalBaseVolume, 10.950926166355945);
  near(result.totalWeightGain, 12.52592599133569);
});

test('real missing-scale control cannot supply gravimetric evidence', () => {
  const result = estimator.estimateShot(fixture('missing-scale-control'));
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'no_scale_data');
});

test('real accepted trace fails closed without a historical multiplier or continuous scale evidence', () => {
  const noMultiplier = fixture('accepted-control');
  delete noMultiplier.workflow.machine.flowCalibration;
  assert.equal(estimator.estimateShot(noMultiplier).reason, 'missing_historical_multiplier');

  const gap = fixture('accepted-control');
  const scaleRows = gap.measurements.filter(m => m.scale);
  for (const row of scaleRows.slice(1, -1)) delete row.scale;
  const result = estimator.estimateShot(gap);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'insufficient_stable_region');
});

test('historical multiplier is used rather than a hard-coded current calibration', () => {
  const shot = fixture('accepted-control');
  shot.workflow.machine.flowCalibration /= 2;
  const result = estimator.estimateShot(shot);
  assert.equal(result.accepted, true);
  near(result.multiplier, 1.143823435666889 / 2);
});

function windowEstimate(shot, startSeconds, endSeconds, scaleOffset = 0) {
  const origin = estimator.timestampSeconds(shot.measurements[0].machine.timestamp);
  const start = origin + startSeconds;
  const end = origin + endSeconds;
  const scale = estimator.dedupeScaleByTimestamp(shot.measurements)
    .map(s => ({ ...s, timestamp: s.timestamp + scaleOffset }));
  const firstWeight = estimator.interpolateLinear(scale, start, 'weight');
  const lastWeight = estimator.interpolateLinear(scale, end, 'weight');
  assert.notEqual(firstWeight, null, 'window start must have scale coverage');
  assert.notEqual(lastWeight, null, 'window end must have scale coverage');
  const baseVolume = estimator.integrateTrapezoidal(shot.measurements, start, end,
    shot.workflow.machine.flowCalibration);
  assert.ok(baseVolume > 0);
  return (lastWeight - firstWeight) / baseVolume;
}

for (const [name, start, end] of [
  ['short-output-tail', 21.5, 23.5],
  ['noisy-pressure-plateau', 21.5, 24.5],
]) {
  test(`reports boundary and scale-timing sensitivity for real ${name} without accepting it`, t => {
    const shot = fixture(name);
    const values = [];
    for (const startShift of [-0.25, 0, 0.25]) {
      for (const endShift of [-0.25, 0, 0.25]) {
        for (const scaleOffset of [-0.25, 0, 0.25]) {
          values.push(windowEstimate(shot, start + startShift, end + endShift, scaleOffset));
        }
      }
    }
    assert.ok(values.every(x => Number.isFinite(x) && x > 0));
    assert.ok(Math.max(...values) - Math.min(...values) > 0.001,
      'real observations must retain their timing/boundary sensitivity');
    assert.equal(estimator.estimateShot(shot).accepted, false);
    t.diagnostic(JSON.stringify({ fixture: name, manualWindowSeconds: [start, end],
      boundaryShifts: [-0.25, 0, 0.25], scaleTimestampOffsets: [-0.25, 0, 0.25],
      nominal: windowEstimate(shot, start, end), minimum: Math.min(...values), maximum: Math.max(...values),
      warning: 'Diagnostic ratios only: no known-correct multiplier or automatic eligibility implied' }));
  });
}

test('window diagnostics refuse scale extrapolation beyond the recorded shot', () => {
  assert.throws(() => windowEstimate(fixture('short-output-tail'), 21.5, 30), /scale coverage/);
});

test('fixtures contain only estimator inputs with anonymized identifiers and dates', () => {
  const names = ['short-output-tail', 'noisy-pressure-plateau', 'accepted-control', 'missing-scale-control'];
  for (const name of names) {
    const shot = fixture(name);
    assert.equal(shot.id, name);
    assert.deepEqual(Object.keys(shot).sort(), ['id', 'measurements', 'workflow']);
    assert.deepEqual(Object.keys(shot.workflow), ['machine']);
    assert.deepEqual(Object.keys(shot.workflow.machine), ['flowCalibration']);
    for (const row of shot.measurements) {
      assert.ok(Object.keys(row).every(key => ['machine', 'scale'].includes(key)));
      for (const [kind, allowed] of [
        ['machine', ['timestamp', 'state', 'pressure', 'flow', 'profileFrame']],
        ['scale', ['timestamp', 'weight', 'weightFlow']],
      ]) {
        if (!row[kind]) continue;
        assert.deepEqual(Object.keys(row[kind]).sort(), [...allowed].sort());
        assert.ok(Math.abs(Date.parse(row[kind].timestamp) - Date.UTC(2000, 0, 1)) < 86400000);
      }
      assert.deepEqual(Object.keys(row.machine.state).sort(), ['state', 'substate']);
    }
  }
});
