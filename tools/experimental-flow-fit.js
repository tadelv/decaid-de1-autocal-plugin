// Shared fitting core. Historical observer/replay retain v1; Auto Flow Calibration 2.x uses v2.
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('../src/measurement-helpers').createMeasurementHelpers();
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
  for (let start = step[0].timestamp; start + 1 <= step.at(-1).timestamp; start += 0.5) {
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
      if (start + lag < step[0].timestamp || end + lag > step.at(-1).timestamp) return null;
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
  const duration = blocks.length ? blocks.at(-1).end - blocks[0].start : 0;
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
    windowEnd: blocks.at(-1).end - machine[0].timestamp,
    spanSeconds: duration, coverageSeconds: coverage,
    rmseBefore: best.rmse(historical), rmseAfter: best.rmse(best.multiplier),
    normalizedHuberLoss: best.loss,
    multiplierRangeAcrossLags: multipliers.length ? [Math.min(...multipliers), Math.max(...multipliers)] : null,
    lagDiagnostics: { available: !!diagnosticBest, identifiable: !!diagnosticBest && flowVariation >= 0.1,
      bestLagSeconds: diagnosticBest ? diagnosticBest.lag : null, bestMultiplier: diagnosticBest ? diagnosticBest.multiplier : null,
      rmseAfter: diagnosticBest ? diagnosticBest.rmse(diagnosticBest.multiplier) : null,
      atSearchBoundary: !!diagnosticBest && (diagnosticBest.lag === LAGS[0] || diagnosticBest.lag === LAGS.at(-1)) }, warnings };
}

return fitFlow;
}

const fitFlow = createExperimentalFlowFitter(helpers);
const fitFlowZeroLag = createExperimentalFlowFitter(helpers, { primaryZeroOnly: true });
module.exports = { fitFlow, fitFlowZeroLag, createExperimentalFlowFitter };

if (require.main === module) {
  const zeroOnly = process.argv.includes('--v2');
  const files = process.argv.slice(2).filter(value => value !== '--v2');
  const inputs = files.length ? files : ['short-output-tail', 'noisy-pressure-plateau', 'accepted-control', 'missing-scale-control']
    .map(name => path.join(__dirname, '../test/fixtures/real-shots', `${name}.json`));
  for (const file of inputs) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const shot of Array.isArray(value) ? value : [value]) {
      console.log(JSON.stringify({ id: shot.id, ...(zeroOnly ? fitFlowZeroLag(shot) : fitFlow(shot)) }));
    }
  }
}
