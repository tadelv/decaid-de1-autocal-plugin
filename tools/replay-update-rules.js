// Offline diagnostic replay only: no network, plugin storage or machine commands.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fitFlow } = require('./experimental-flow-fit');
const helpers = require('../src/measurement-helpers').createMeasurementHelpers();
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function update(state, candidate, full) {
  const tracked = clamp(full ? candidate : state.tracked + clamp(0.5 * (candidate - state.tracked), -0.1, 0.1), 0.35, 2);
  const a = Math.round(state.proposed * 1000);
  const q = full ? Math.round(tracked * 1000)
    : clamp(Math.round(tracked * 1000), Math.max(350, a - 100), Math.min(2000, a + 100));
  return { tracked, proposed: Math.abs(q - a) < 10 ? a / 1000 : q / 1000 };
}

function replay(shots) {
  const seen = new Map();
  for (const shot of shots) {
    if (typeof shot.id !== 'string' || !shot.id) throw new Error('Missing shot identity');
    if (seen.has(shot.id) && JSON.stringify(seen.get(shot.id)) !== JSON.stringify(shot)) {
      throw new Error(`Conflicting exports for shot ${shot.id}`);
    }
    seen.set(shot.id, shot);
  }
  const ordered = [...seen.values()].map(shot => {
    // Naive device-local timestamps are compared on a common synthetic clock, not asserted to be UTC.
    const t = shot.timestamp;
    if (typeof t !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(t)) throw new Error('Invalid capture timestamp');
    const order = Date.parse(/[zZ]$|[+-]\d{2}:\d{2}$/.test(t) ? t : t + 'Z');
    if (!Number.isFinite(order)) throw new Error('Invalid capture timestamp');
    return { shot, order };
  }).sort((a, b) => a.order - b.order);
  const states = new Map(), orders = new Map(), rows = [], skipped = {};
  for (const { shot, order } of ordered) {
    const machine = shot.workflow?.machine;
    const profile = shot.workflow?.profile;
    if (machine?.provenanceStatus !== 'captured' || !helpers.isEligibleDE1(machine) ||
        typeof profile?.title !== 'string' || !Array.isArray(profile.steps)) {
      skipped.invalid_provenance_or_program = (skipped.invalid_provenance_or_program || 0) + 1;
      continue;
    }
    const key = helpers.canonicalize({ serial: machine.serialNumber, title: profile.title, version: profile.version, steps: profile.steps });
    let state = states.get(key);
    if (orders.get(key) === order) throw new Error('Ambiguous equal capture ordering within a program');
    orders.set(key, order);
    const fit = fitFlow(shot);
    if (!fit.fitted) {
      skipped[fit.reason] = (skipped[fit.reason] || 0) + 1;
      continue;
    }
    if (!state) {
      const seed = Math.round(machine.flowCalibration * 1000) / 1000;
      if (machine.flowCalibration < 0.35 || machine.flowCalibration > 2 ||
          Math.abs(seed - machine.flowCalibration) > 1e-9) {
        skipped.unsupported_historical_seed = (skipped.unsupported_historical_seed || 0) + 1;
        continue;
      }
      state = { title: profile.title, group: createHash('sha256').update(key).digest('hex').slice(0, 12),
        seed, conservative: { tracked: seed, proposed: seed }, full: { tracked: seed, proposed: seed } };
      states.set(key, state);
    }
    const before = { conservative: state.conservative.proposed, full: state.full.proposed };
    state.conservative = update(state.conservative, fit.multiplier, false);
    state.full = update(state.full, fit.multiplier, true);
    rows.push({ group: state.group, title: state.title, sequence: rows.filter(r => r.group === state.group).length + 1,
      historical: machine.flowCalibration, candidate: fit.multiplier, coverageSeconds: fit.coverageSeconds,
      warnings: fit.warnings, conservative: { ...state.conservative }, full: { ...state.full },
      conservativeJump: state.conservative.proposed - before.conservative, fullJump: state.full.proposed - before.full });
  }
  return { mode: 'offline_diagnostic_replay_only', fitMethod: 'fixed_zero_lag_v1_unchanged',
    uniqueShots: seen.size, duplicateExports: shots.length - seen.size, fitted: rows.length, skipped,
    programsWithFits: states.size, rows };
}

module.exports = { replay, update };
if (require.main === module) {
  if (process.argv.length < 3) throw new Error('Usage: node tools/replay-update-rules.js shot-export.json [...]');
  const shots = process.argv.slice(2).flatMap(file => {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(value)) throw new Error('Expected an array of full shots');
    return value;
  });
  console.log(JSON.stringify(replay(shots), null, 2));
}
