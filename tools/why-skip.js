#!/usr/bin/env node
// Why did a profile not calibrate?
//
// Pulls the newest shots of a profile from a running Decaid, asks the plugin's
// own estimator for the verdict, and then shows which of the flat-region
// thresholds threw the evidence away. The thresholds are read out of plugin.js,
// so this cannot drift from the code it explains.
//
//   node tools/why-skip.js --decaid http://m50mini.home:8080
//   node tools/why-skip.js --decaid http://de1-tablet:8080 --profile "Baseline ULC" --limit 3
//   node tools/why-skip.js --decaid http://… --json > evidence.json
//
// Read-only: three GETs, no writes, nothing persisted.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PACKAGE = path.join(__dirname, "..", "auto-flow-cal.reaplugin");
const SOURCE = fs.readFileSync(path.join(PACKAGE, "plugin.js"), "utf8");

// The estimator itself is the authority; the constants are only for explaining it.
const CONSTANTS = {};
for (const match of SOURCE.matchAll(/^  var ([A-Z][A-Z0-9_]+) = (-?[\d.]+);$/gm)) {
  CONSTANTS[match[1]] = Number(match[2]);
}
const C = CONSTANTS;
const REQUIRED = [
  "MIN_PRESSURE", "MIN_MACHINE_FLOW", "MIN_SCALE_WEIGHT", "MIN_WEIGHT_FLOW",
  "MAX_PRESSURE_SLOPE", "MAX_MACHINE_FLOW_SLOPE", "MAX_WEIGHT_FLOW_SLOPE",
  "MAX_MACHINE_GAP", "MAX_SCALE_GAP", "MIN_REGION_DURATION",
];
for (const name of REQUIRED) {
  if (typeof C[name] !== "number") {
    console.error(`could not read ${name} from plugin.js`);
    process.exit(2);
  }
}
const PRESSURE_SWEEP = [C.MIN_PRESSURE, 1.5, 1.0, 0.5].filter(
  (value, index, all) => all.indexOf(value) === index,
);

function args(argv) {
  const options = { decaid: "http://localhost:8080", profile: null, limit: 2, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[++i];
    if (argv[i] === "--decaid") options.decaid = next().replace(/\/+$/, "");
    else if (argv[i] === "--profile") options.profile = next();
    else if (argv[i] === "--limit") options.limit = Number(next());
    else if (argv[i] === "--json") options.json = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: why-skip.js --decaid <url> [--profile <title>] [--limit n] [--json]");
      process.exit(0);
    } else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return options;
}

async function getJson(base, route) {
  const response = await fetch(base + "/api/v1" + route);
  if (!response.ok) throw new Error(`GET ${route} -> ${response.status}`);
  return response.json();
}

// ---- what the plugin itself says -------------------------------------------

function loadEstimator() {
  const plugin = vm.runInNewContext(`${SOURCE}\ncreatePlugin`)({
    log() {},
    storage() {},
  });
  return plugin.__test.estimateShot;
}

// ---- independent interval maths, so a rejection can be named ----------------

function seconds(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const number = Number(value);
  if (Number.isFinite(number)) return Math.abs(number) > 1e11 ? number / 1000 : number;
  const parsed = Date.parse(value) / 1000;
  return Number.isFinite(parsed) ? parsed : null;
}

const isEspresso = value => value === "espresso" || (value && value.state === "espresso");
const finite = value => typeof value === "number" && Number.isFinite(value);

function machineSamples(measurements) {
  const out = [];
  for (const item of measurements || []) {
    const machine = item && item.machine ? item.machine : item;
    if (!machine) continue;
    const timestamp = seconds(machine.timestamp);
    if (timestamp === null) continue;
    out.push({ timestamp, state: machine.state, pressure: machine.pressure, flow: machine.flow });
  }
  return out;
}

function scaleSamples(measurements) {
  const byTime = new Map();
  for (const item of measurements || []) {
    const scale = item && item.scale ? item.scale : (item && item.weight !== undefined ? item : null);
    if (!scale) continue;
    const timestamp = seconds(scale.timestamp);
    if (timestamp === null || byTime.has(timestamp)) continue;
    byTime.set(timestamp, { timestamp, weight: scale.weight, weightFlow: scale.weightFlow });
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}

// Mirrors buildMachineFlatIntervals, but records *why* an edge was dropped.
function machineEdges(samples, { minPressure = C.MIN_PRESSURE, minFlow = C.MIN_MACHINE_FLOW } = {}) {
  const edges = [];
  const rejected = {};
  const drop = reason => { rejected[reason] = (rejected[reason] || 0) + 1; };
  for (let i = 0; i + 1 < samples.length; i += 1) {
    const a = samples[i];
    const b = samples[i + 1];
    if (!isEspresso(a.state) || !isEspresso(b.state)) { drop("not espresso"); continue; }
    if (!finite(a.pressure) || !finite(b.pressure) || !finite(a.flow) || !finite(b.flow)) { drop("missing pressure/flow"); continue; }
    if (a.pressure < minPressure || b.pressure < minPressure) { drop(`pressure < ${minPressure}`); continue; }
    if (a.flow < minFlow || b.flow < minFlow) { drop(`flow < ${minFlow}`); continue; }
    const dt = b.timestamp - a.timestamp;
    if (!(dt > 0) || dt > C.MAX_MACHINE_GAP) { drop(`gap > ${C.MAX_MACHINE_GAP}s`); continue; }
    if (Math.abs((b.pressure - a.pressure) / dt) > C.MAX_PRESSURE_SLOPE) { drop(`pressure slope > ${C.MAX_PRESSURE_SLOPE}/s`); continue; }
    if (Math.abs((b.flow - a.flow) / dt) > C.MAX_MACHINE_FLOW_SLOPE) { drop(`flow slope > ${C.MAX_MACHINE_FLOW_SLOPE}/s`); continue; }
    edges.push({ start: a.timestamp, end: b.timestamp });
  }
  return { edges, rejected };
}

function scaleEdges(samples) {
  const edges = [];
  const rejected = {};
  const drop = reason => { rejected[reason] = (rejected[reason] || 0) + 1; };
  for (let i = 0; i + 1 < samples.length; i += 1) {
    const a = samples[i];
    const b = samples[i + 1];
    if (!finite(a.weight) || !finite(b.weight) || !finite(a.weightFlow) || !finite(b.weightFlow)) { drop("missing weight/weightFlow"); continue; }
    if (a.weight < C.MIN_SCALE_WEIGHT || b.weight < C.MIN_SCALE_WEIGHT) { drop(`weight < ${C.MIN_SCALE_WEIGHT}g`); continue; }
    if (a.weightFlow < C.MIN_WEIGHT_FLOW || b.weightFlow < C.MIN_WEIGHT_FLOW) { drop(`weightFlow < ${C.MIN_WEIGHT_FLOW}g/s`); continue; }
    const dt = b.timestamp - a.timestamp;
    if (!(dt > 0) || dt > C.MAX_SCALE_GAP) { drop(`gap > ${C.MAX_SCALE_GAP}s`); continue; }
    if (Math.abs((b.weightFlow - a.weightFlow) / dt) > C.MAX_WEIGHT_FLOW_SLOPE) { drop(`weightFlow slope > ${C.MAX_WEIGHT_FLOW_SLOPE}/s`); continue; }
    edges.push({ start: a.timestamp, end: b.timestamp });
  }
  return { edges, rejected };
}

function merge(edges) {
  const merged = [];
  for (const edge of edges) {
    const last = merged[merged.length - 1];
    if (last && edge.start === last.end) last.end = edge.end;
    else merged.push({ ...edge });
  }
  return merged;
}

function bestOverlap(machine, scale) {
  let best = 0;
  for (const m of merge(machine)) {
    for (const s of merge(scale)) {
      best = Math.max(best, Math.min(m.end, s.end) - Math.max(m.start, s.start));
    }
  }
  return best;
}

function span(samples, key) {
  const values = samples.map(s => s[key]).filter(finite);
  if (values.length === 0) return null;
  return [Math.min(...values), Math.max(...values)];
}

function fmt(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function range(pair, unit, digits = 2) {
  return pair ? `${fmt(pair[0], digits)}–${fmt(pair[1], digits)} ${unit}` : "—";
}

function reportRejected(rejected) {
  const entries = Object.entries(rejected).sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? "none" : entries.map(([reason, count]) => `${reason}: ${count}`).join(", ");
}

// ---- one shot --------------------------------------------------------------

function inspectShot(estimate, shot) {
  const measurements = Array.isArray(shot.measurements) ? shot.measurements : [];
  const machine = machineSamples(measurements);
  const scale = scaleSamples(measurements);
  const espresso = machine.filter(sample => isEspresso(sample.state));
  const machineResult = machineEdges(machine);
  const scaleResult = scaleEdges(scale);
  const overlap = bestOverlap(machineResult.edges, scaleResult.edges);

  const sweep = PRESSURE_SWEEP.map(minPressure => {
    const relaxed = machineEdges(machine, { minPressure });
    const best = bestOverlap(relaxed.edges, scaleResult.edges);
    return {
      minPressure,
      machineEdges: relaxed.edges.length,
      bestOverlapSeconds: Number(best.toFixed(2)),
      wouldCalibrate: best >= C.MIN_REGION_DURATION,
    };
  });

  return {
    id: shot.id,
    timestamp: shot.timestamp || shot.createdAt || null,
    durationSeconds: measurements.length > 1 ? Number((seconds(measurements[measurements.length - 1].timestamp || (measurements[measurements.length - 1].machine || {}).timestamp) - seconds(measurements[0].timestamp || (measurements[0].machine || {}).timestamp)).toFixed(1)) : null,
    verdict: estimate,
    machine: {
      samples: machine.length,
      espressoSamples: espresso.length,
      pressure: span(espresso, "pressure"),
      flow: span(espresso, "flow"),
      flatEdges: machineResult.edges.length,
      longestFlatSeconds: Number(merge(machineResult.edges).reduce((longest, edge) => Math.max(longest, edge.end - edge.start), 0).toFixed(2)),
      rejected: machineResult.rejected,
    },
    scale: {
      samples: scale.length,
      weight: span(scale, "weight"),
      weightFlow: span(scale, "weightFlow"),
      flatEdges: scaleResult.edges.length,
      longestFlatSeconds: Number(merge(scaleResult.edges).reduce((longest, edge) => Math.max(longest, edge.end - edge.start), 0).toFixed(2)),
      rejected: scaleResult.rejected,
    },
    overlapSeconds: Number(overlap.toFixed(2)),
    requiredSeconds: C.MIN_REGION_DURATION,
    pressureSweep: sweep,
  };
}

function printShot(shot) {
  const when = shot.timestamp ? new Date(shot.timestamp).toLocaleString() : "—";
  console.log(`\nshot ${String(shot.id).slice(0, 8)}  ${when}  ${shot.durationSeconds ?? "—"} s`);
  console.log(`  plugin verdict      ${shot.verdict.accepted ? `accepted ×${fmt(shot.verdict.multiplier, 3)}` : shot.verdict.reason}`);
  console.log(`  machine (espresso)  ${shot.machine.espressoSamples}/${shot.machine.samples} samples · pressure ${range(shot.machine.pressure, "bar", 1)} · flow ${range(shot.machine.flow, "ml/s", 1)}`);
  console.log(`  machine flat region ${shot.machine.flatEdges} edges, longest ${shot.machine.longestFlatSeconds} s`);
  if (Object.keys(shot.machine.rejected).length) console.log(`    rejected by       ${reportRejected(shot.machine.rejected)}`);
  console.log(`  scale               ${shot.scale.samples} samples · weight ${range(shot.scale.weight, "g", 1)} · weightFlow ${range(shot.scale.weightFlow, "g/s")}`);
  console.log(`  scale flat region   ${shot.scale.flatEdges} edges, longest ${shot.scale.longestFlatSeconds} s`);
  if (Object.keys(shot.scale.rejected).length) console.log(`    rejected by       ${reportRejected(shot.scale.rejected)}`);
  console.log(`  overlap             ${shot.overlapSeconds} s of the ${shot.requiredSeconds} s required`);
  const better = shot.pressureSweep.filter(step => step.wouldCalibrate).map(step => step.minPressure);
  if (!shot.verdict.accepted && better.length) {
    console.log(`  pressure sweep      MIN_PRESSURE ${better[0]} would give ${shot.pressureSweep.find(s => s.minPressure === better[0]).bestOverlapSeconds} s of overlap`);
  } else if (!shot.verdict.accepted) {
    console.log("  pressure sweep      lowering MIN_PRESSURE alone would not fix this shot");
  }
}

// ---- main ------------------------------------------------------------------

(async () => {
  const options = args(process.argv.slice(2));
  let profileTitle = options.profile;
  if (profileTitle === null) {
    const workflow = await getJson(options.decaid, "/workflow");
    profileTitle = workflow && workflow.profile ? workflow.profile.title : null;
    if (profileTitle === null || profileTitle === undefined) {
      console.error("no active profile; pass --profile <title>");
      process.exit(1);
    }
  }

  const history = await getJson(
    options.decaid,
    `/shots?profileTitle=${encodeURIComponent(profileTitle)}&limit=${options.limit}&offset=0&order=desc`,
  );
  const items = Array.isArray(history) ? history : history.items || [];
  if (items.length === 0) {
    console.error(`no shots recorded for profile "${profileTitle}"`);
    process.exit(1);
  }

  const ids = items.map(item => item.id).filter(id => id !== undefined && id !== null);
  const query = ids.map(id => `ids=${encodeURIComponent(id)}`).join("&");
  const full = await getJson(options.decaid, `/shots?${query}&order=desc`);
  const byId = new Map((Array.isArray(full) ? full : []).map(shot => [String(shot.id), shot]));
  const estimate = loadEstimator();

  const shots = ids
    .map(id => byId.get(String(id)))
    .filter(Boolean)
    .map(shot => inspectShot(estimate(shot), shot));

  if (options.json) {
    console.log(JSON.stringify({ decaid: options.decaid, profile: profileTitle, thresholds: C, shots }, null, 2));
    return;
  }

  console.log(`Decaid   ${options.decaid}`);
  console.log(`Profile  ${profileTitle}  (${shots.length} shot${shots.length === 1 ? "" : "s"}, newest first)`);
  console.log(`Limits   pressure ≥ ${C.MIN_PRESSURE} bar · flow ≥ ${C.MIN_MACHINE_FLOW} ml/s · weight ≥ ${C.MIN_SCALE_WEIGHT} g · weightFlow ≥ ${C.MIN_WEIGHT_FLOW} g/s`);
  console.log(`         slopes ≤ ${C.MAX_PRESSURE_SLOPE} bar/s, ${C.MAX_MACHINE_FLOW_SLOPE} ml/s², ${C.MAX_WEIGHT_FLOW_SLOPE} g/s² · gaps ≤ ${C.MAX_MACHINE_GAP}/${C.MAX_SCALE_GAP} s · region ≥ ${C.MIN_REGION_DURATION} s`);
  shots.forEach(printShot);
})().catch(error => {
  console.error(`failed: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
