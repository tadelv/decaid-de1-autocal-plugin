const test = require('node:test');
const assert = require('node:assert/strict');
const { fitFlow } = require('../tools/experimental-flow-fit');

function shot({ multiplier = 0.9, historical = 1.13, lag = 0, outlier = false, pressureRamp = false } = {}) {
  const flow = t => 2.5 + 0.8 * Math.sin(t * 1.4) + 0.3 * Math.sin(t * 0.3);
  return { workflow: { machine: { flowCalibration: historical } }, measurements:
    Array.from({ length: 81 }, (_, i) => {
      const t = i * 0.25;
      const delayed = t - lag;
      const weight = 10 + multiplier * (2.5 * t - 0.8 / 1.4 * Math.cos(delayed * 1.4) - Math.cos(delayed * 0.3));
      return {
        machine: { timestamp: t, state: { state: 'espresso' }, profileFrame: t < 10 ? 0 : 1, flow: historical * flow(t),
          pressure: pressureRamp ? 2 + 0.15 * t : 6 + 0.08 * Math.sin(t * 9) },
        scale: { timestamp: t, weight, weightFlow: multiplier * flow(delayed) + (outlier && i === 40 ? 12 : 0) },
      };
    }) };
}

test('zero-lag fit recovers a known multiplier for changing unshifted flow', () => {
  const result = fitFlow(shot());
  assert.equal(result.fitted, true);
  assert.equal(result.fitMethod, 'fixed_zero_lag_v1');
  assert.ok(Math.abs(result.multiplier - 0.9) < 0.015);
  assert.equal(result.lagSeconds, 0);
  assert.ok(result.rmseAfter < result.rmseBefore * 0.1);
});

test('fitted scale lag remains diagnostic and cannot select the primary multiplier', () => {
  const result = fitFlow(shot({ lag: 0.5 }));
  assert.equal(result.fitted, true);
  assert.equal(result.lagSeconds, 0);
  assert.equal(result.lagDiagnostics.bestLagSeconds, 0.5);
  assert.ok(Math.abs(result.lagDiagnostics.bestMultiplier - 0.9) < 0.015);
  assert.ok(Math.abs(result.multiplier - result.lagDiagnostics.bestMultiplier) > 0.001);
});

test('only the final contiguous extraction step contributes to the fit', () => {
  const input = shot();
  input.measurements.filter(m => m.machine.profileFrame === 0)
    .forEach(m => { m.scale.weightFlow *= 4; });
  const result = fitFlow(input);
  assert.equal(result.fitted, true);
  assert.equal(result.profileFrame, 1);
  assert.ok(result.windowStart >= 10);
  assert.ok(Math.abs(result.multiplier - 0.9) < 0.015);
  input.measurements.forEach(m => delete m.machine.profileFrame);
  assert.equal(fitFlow(input).reason, 'last_step_unknown');
});

test('final step selection ignores numeric ordering and trailing idle snapshots', () => {
  const input = shot();
  input.measurements.forEach(m => { m.machine.profileFrame = m.machine.timestamp < 10 ? 9 : 0; });
  input.measurements.push({ machine: { timestamp: 20.25, profileFrame: 99,
    state: { state: 'idle' }, flow: 0, pressure: 0 } });
  const result = fitFlow(input);
  assert.equal(result.fitted, true);
  assert.equal(result.profileFrame, 0);
  assert.ok(result.windowStart >= 10);
});

test('experimental fit rejects reversed machine timestamps and a last step with no useful flow', () => {
  const reversed = shot();
  reversed.measurements[20].machine.timestamp = 0;
  assert.equal(fitFlow(reversed).reason, 'invalid_machine_timestamps');
  const noFlow = shot();
  noFlow.measurements.filter(m => m.machine.profileFrame === 1).forEach(m => { m.machine.flow = 0; });
  assert.equal(fitFlow(noFlow).fitted, false);
});

test('experimental fit tolerates slow pressure changes and isolated scale-flow spikes', () => {
  const result = fitFlow(shot({ outlier: true, pressureRamp: true }));
  assert.equal(result.fitted, true);
  assert.ok(Math.abs(result.multiplier - 0.9) < 0.03);
});

test('experimental fit respects the historical multiplier', () => {
  const result = fitFlow(shot({ historical: 0.7, multiplier: 1.2 }));
  assert.equal(result.fitted, true);
  assert.ok(Math.abs(result.multiplier - 1.2) < 0.02);
});

test('experimental fit fails closed for missing scale, historical calibration and sparse scale timestamps', () => {
  const noScale = shot();
  noScale.measurements.forEach(m => delete m.scale);
  assert.equal(fitFlow(noScale).fitted, false);
  const missing = shot();
  delete missing.workflow.machine.flowCalibration;
  assert.equal(fitFlow(missing).reason, 'missing_historical_multiplier');
  const gap = shot();
  gap.measurements.forEach((m, i) => { if (i !== 0 && i !== 80) delete m.scale; });
  assert.equal(fitFlow(gap).fitted, false);
});

test('flat final-step flow uses zero lag rather than fitting timing to scale noise', () => {
  const input = shot();
  input.measurements.forEach(m => {
    m.machine.flow = 2 * 1.13;
    m.scale.weight = 10 + 1.8 * m.machine.timestamp;
    m.scale.weightFlow = 1.8 + 0.02 * Math.sin(m.machine.timestamp * 3);
  });
  const result = fitFlow(input);
  assert.equal(result.fitted, true);
  assert.equal(result.lagSeconds, 0);
  assert.equal(result.lagDiagnostics.identifiable, false);
  assert.ok(Math.abs(result.multiplier - 0.9) < 0.015);
});

for (const name of ['short-output-tail', 'noisy-pressure-plateau', 'accepted-control']) {
  test(`experimental last-step fit produces a diagnostic estimate for real ${name}`, () => {
    const input = require(`./fixtures/real-shots/${name}.json`);
    const before = JSON.stringify(input);
    const result = fitFlow(input);
    assert.equal(result.fitted, true);
    assert.equal(result.profileFrame, input.measurements.at(-1).machine.profileFrame);
    assert.ok(result.multiplier > 0.8 && result.multiplier < 1.3);
    assert.ok(result.rmseAfter < result.rmseBefore);
    assert.ok(result.coverageSeconds >= 2);
    assert.equal(JSON.stringify(input), before);
  });
}

test('real missing-scale control remains unfittable in the experiment', () => {
  const input = require('./fixtures/real-shots/missing-scale-control.json');
  assert.equal(fitFlow(input).reason, 'no_scale_data');
});

test('experimental fit rejects out-of-range corrections and mass that runs backwards', () => {
  assert.equal(fitFlow(shot({ multiplier: 3 })).fitted, false);
  const tare = shot();
  tare.measurements.forEach(m => { m.scale.weight = 40 - m.machine.timestamp; });
  assert.equal(fitFlow(tare).fitted, false);
});
