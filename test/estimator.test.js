const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'auto-flow-cal.reaplugin', 'plugin.js'), 'utf8');

function loadEstimator(settings) {
  const context = { fetch: async () => ({ ok: true, json: async () => ({}) }) };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.createPlugin = createPlugin;`, context);
  return context.createPlugin({ log() {}, storage() { return Promise.resolve(); } }).__test;
}

const estimator = loadEstimator();

function iso(seconds) {
  return new Date(Math.round(seconds * 1000)).toISOString();
}

function machine(timestamp, flow, pressure = 9, state = { state: 'espresso', substate: 'pouring' }) {
  return { machine: { timestamp, state, pressure, flow } };
}

function makeShot({
  oldMultiplier = 1,
  desired = 0.9,
  machineTimes = Array.from({ length: 9 }, (_, i) => i * 0.5),
  scaleTimes = machineTimes,
  flow = () => 2,
  pressure = () => 9,
  state = () => ({ state: 'espresso', substate: 'pouring' }),
  scaleWeight = t => 5 + desired * 2 * t,
  weightFlow = () => desired * 2,
  withScale = true,
} = {}) {
  const measurements = machineTimes.map(t => machine(iso(t), oldMultiplier * flow(t), pressure(t), state(t)));
  if (withScale) {
    for (const timestamp of scaleTimes) {
      measurements.push({ scale: {
        timestamp: iso(timestamp),
        weight: scaleWeight(timestamp),
        weightFlow: weightFlow(timestamp),
      } });
    }
  }
  return {
    workflow: { profile: { title: 'Profile' }, machine: { flowCalibration: oldMultiplier } },
    measurements,
  };
}

function expectRejected(options, reason) {
  const result = estimator.estimateShot(makeShot(options));
  assert.equal(result.accepted, false);
  assert.equal(result.reason, reason);
}

test('normalizes each shot by its historical multiplier', () => {
  for (const oldMultiplier of [0.75, 1.1]) {
    const result = estimator.estimateShot(makeShot({ oldMultiplier, desired: 0.9 }));
    assert.equal(result.accepted, true);
    assert.ok(Math.abs(result.multiplier - 0.9) < 1e-12);
  }
});

test('uses irregular machine timestamps and trapezoidal integration', () => {
  const times = [0, 0.3, 0.8, 1.2, 1.7, 2.0, 2.5, 2.9, 3.4, 3.8];
  const result = estimator.estimateShot(makeShot({ machineTimes: times, scaleTimes: times }));
  assert.equal(result.accepted, true);
  assert.ok(Math.abs(result.totalBaseVolume - 7.6) < 1e-12);
  assert.ok(Math.abs(result.multiplier - 0.9) < 1e-12);

  const integrated = estimator.integrateTrapezoidal(
    [machine(0, 1), machine(0.25, 3), machine(1, 3)], 0, 1, 1,
  );
  assert.equal(integrated, 2.75);
});

test('rejects a base volume whose window is not covered by machine samples', () => {
  const samples = [machine(0, 2), machine(1, 2), machine(2, 2)];
  assert.equal(estimator.integrateTrapezoidal(samples, 0, 2, 1), 4);
  assert.ok(Number.isNaN(estimator.integrateTrapezoidal(samples, 0, 3, 1)));
  assert.ok(Number.isNaN(estimator.integrateTrapezoidal(samples, -1, 1, 1)));
});

test('deduplicates scale timestamps and repeated observations do not add evidence', () => {
  const base = makeShot();
  const duplicate = makeShot();
  duplicate.measurements.push(
    { scale: { timestamp: 1, weight: 999, weightFlow: 999 } },
    { scale: { timestamp: 2, weight: 999, weightFlow: 999 } },
  );
  const first = estimator.estimateShot(base);
  const second = estimator.estimateShot(duplicate);
  assert.equal(estimator.dedupeScaleByTimestamp(duplicate.measurements).length, 9);
  assert.deepEqual(
    { multiplier: second.multiplier, totalBaseVolume: second.totalBaseVolume, totalWeightGain: second.totalWeightGain },
    { multiplier: first.multiplier, totalBaseVolume: first.totalBaseVolume, totalWeightGain: first.totalWeightGain },
  );
});

test('requires at least two usable scale observations', () => {
  expectRejected({ withScale: false }, 'no_scale_data');
  expectRejected({ scaleTimes: [0] }, 'no_scale_data');
});

test('rejects every required minimum and flatness violation', () => {
  const cases = [
    ['pressure below minimum', { pressure: () => 1.9 }, 'insufficient_stable_region'],
    ['machine flow below minimum', { flow: () => 0.49 }, 'insufficient_stable_region'],
    ['scale weight below minimum', { scaleWeight: () => 4.99 }, 'insufficient_stable_region'],
    ['weight flow below minimum', { weightFlow: () => 0.29 }, 'insufficient_stable_region'],
    ['pressure slope above limit', { pressure: t => 9 + 0.4 * t }, 'insufficient_stable_region'],
    ['machine-flow slope above limit', { flow: t => 2 + 0.4 * t }, 'insufficient_stable_region'],
    ['weight-flow slope above limit', { weightFlow: t => 1 + 0.4 * t }, 'insufficient_stable_region'],
    ['flat pressure but changing machine flow', { flow: t => 2 + 0.4 * t }, 'insufficient_stable_region'],
    ['flat machine flow but changing weight flow', { weightFlow: t => 1 + 0.4 * t }, 'insufficient_stable_region'],
    ['flat machine and weight flow but changing pressure', { pressure: t => 9 + 0.4 * t }, 'insufficient_stable_region'],
  ];
  for (const [name, options, reason] of cases) {
    assert.doesNotThrow(() => expectRejected(options, reason), name);
  }
});

test('rejects timestamp reversal and gaps that break continuity', () => {
  expectRejected({ machineTimes: [0, 0.5, 0.2, 0.7, 1.2, 1.7, 2.2, 2.7] }, 'insufficient_stable_region');
  expectRejected({ machineTimes: [0, 0.5, 1, 1.6, 2.1, 2.6, 3.1, 3.6] }, 'insufficient_stable_region');
  expectRejected({
    machineTimes: Array.from({ length: 9 }, (_, i) => i * 0.5),
    scaleTimes: [0, 0.5, 1, 2.1, 2.6, 3.1, 3.6, 4],
  }, 'insufficient_stable_region');
});

test('rejects an overlap shorter than three seconds', () => {
  expectRejected({
    machineTimes: Array.from({ length: 6 }, (_, i) => i * 0.5),
    scaleTimes: Array.from({ length: 6 }, (_, i) => i * 0.5),
  }, 'insufficient_stable_region');

  const exactlyThree = makeShot({
    machineTimes: Array.from({ length: 7 }, (_, i) => i * 0.5),
    scaleTimes: Array.from({ length: 7 }, (_, i) => i * 0.5),
  });
  assert.equal(estimator.estimateShot(exactlyThree).accepted, true);
});

test('uses every disjoint flat region and ignores transition regions', () => {
  const shot = makeShot({
    oldMultiplier: 1,
    desired: 0.9,
    machineTimes: Array.from({ length: 43 }, (_, i) => i * 0.5),
    scaleTimes: Array.from({ length: 43 }, (_, i) => i * 0.5),
    flow: t => t < 5 ? (0.5 + 0.5 * t) : 2,
    weightFlow: t => t < 5 ? 0.3 + 0.6 * t : (t < 15 ? (t <= 12 ? 1.8 : 1.8 - 0.6 * (t - 12)) : 1.8),
  });
  const result = estimator.estimateShot(shot);
  assert.equal(result.accepted, true);
  assert.equal(result.regionCount, 2);
  assert.ok(Math.abs(result.totalBaseVolume - 26) < 1e-12);
  assert.ok(Math.abs(result.totalWeightGain - 23.4) < 1e-12);
  assert.ok(Math.abs(result.multiplier - 0.9) < 1e-12);
});

test('interpolates machine flow and scale weight at region boundaries', () => {
  const machineSamples = [machine(0.25, 2), machine(0.75, 2), machine(1.25, 2), machine(1.75, 2), machine(2.25, 2), machine(2.75, 2), machine(3.25, 2), machine(3.75, 2), machine(4.25, 2)];
  assert.equal(estimator.interpolateLinear(machineSamples.map(x => x.machine), 1, 'flow'), 2);

  const scaleSamples = [
    { timestamp: 0, weight: 5, weightFlow: 1.8 },
    { timestamp: 1, weight: 6.8, weightFlow: 1.8 },
    { timestamp: 2, weight: 8.6, weightFlow: 1.8 },
    { timestamp: 3, weight: 10.4, weightFlow: 1.8 },
    { timestamp: 4, weight: 12.2, weightFlow: 1.8 },
  ];
  assert.equal(estimator.interpolateLinear(scaleSamples, 0.5, 'weight'), 5.9);

  const result = estimator.estimateShot(makeShot({
    machineTimes: [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75, 4.25],
    scaleTimes: [0, 1, 2, 3, 4],
    scaleWeight: t => 5 + 0.9 * 2 * t,
  }));
  assert.equal(result.accepted, true);
  assert.ok(Math.abs(result.multiplier - 0.9) < 1e-12);
});

test('rejects invalid regional weight gain and base volume', () => {
  // Zero weight gain is invalid.
  expectRejected({ scaleWeight: () => 5 }, 'invalid_shot_estimate');
  // Negative weight gain is invalid too (the scale reports losing weight while
  // every sample stays above the minimum weight).
  expectRejected({ scaleWeight: t => 10 - 0.5 * t }, 'invalid_shot_estimate');
  expectRejected({ flow: () => 0 }, 'insufficient_stable_region');
  const invalidMultiplier = makeShot({ oldMultiplier: 0 });
  const result = estimator.estimateShot(invalidMultiplier);
  assert.equal(result.reason, 'missing_historical_multiplier');
  assert.ok(Number.isNaN(estimator.integrateTrapezoidal([machine(0, 2), machine(1, 2)], 0, 1, 0)));

  // The base-volume guard in estimateShot is unreachable through estimateShot:
  // every region is bounded by machine-flat intervals, which are built from
  // adjacent machine samples, so the integration window is always covered.
  // The guard's precondition is therefore covered on the helper instead.
  const samples = [machine(0, 2), machine(1, 2), machine(2, 2)];
  assert.equal(estimator.integrateTrapezoidal(samples, 0, 2, 1), 4);
  assert.ok(Number.isNaN(estimator.integrateTrapezoidal(samples, 0, 3, 1)));
});

test('rejects shot estimates outside the configured automatic range', () => {
  expectRejected({ desired: 0.2 }, 'invalid_shot_estimate');
  expectRejected({ desired: 2.1 }, 'invalid_shot_estimate');
});
