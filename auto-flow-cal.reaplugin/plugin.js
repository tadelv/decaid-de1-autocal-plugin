function createPlugin(host) {
  "use strict";

  var PLUGIN_ID = "decaid.autoflowcal";
  var VERSION = "1.0.0";
  var API_BASE = "http://localhost:8080";
  var STORAGE_KEY = "state";

  var ALLOWED_MODELS = ["DE1", "DE1Plus", "DE1Pro", "DE1XL", "DE1Cafe", "DE1XXL", "DE1XXXL"];
  var SAFE_STATES = ["idle", "heating", "preheating", "sleeping"];

  var MIN_PRESSURE = 2.0;
  var MIN_MACHINE_FLOW = 0.5;
  var MIN_SCALE_WEIGHT = 5.0;
  var MIN_WEIGHT_FLOW = 0.3;
  var MAX_PRESSURE_SLOPE = 0.35;
  var MAX_MACHINE_FLOW_SLOPE = 0.35;
  var MAX_WEIGHT_FLOW_SLOPE = 0.35;
  var MAX_MACHINE_GAP = 0.5;
  var MAX_SCALE_GAP = 1.0;
  var MIN_REGION_DURATION = 3.0;
  var AGREEMENT_LIMIT = 0.10;
  var DEADBAND = 0.01;
  var RESOLUTION = 0.001;
  var OWNERSHIP_EPSILON = 0.0015;

  var state = {
    storageReady: false,
    activeProfileCanonical: null,
    activeProfileTitle: null,
    generation: 0,
    historyRevision: 0,
    lastEvaluatedHistoryRevision: -1,
    pendingWorkflow: null
  };

  var settings = {
    Enabled: true,
    Damping: 0.5,
    MaxAdjustment: 0.1,
    MinimumMultiplier: 0.35,
    MaximumMultiplier: 2.0,
    DryRun: false
  };

  var persistentState = { version: 1, machines: {} };

  function finite(value) {
    return typeof value === "number" && isFinite(value);
  }

  function positive(value) {
    return finite(value) && value > 0;
  }

  function hasOwn(object, key) {
    return object != null && Object.prototype.hasOwnProperty.call(object, key);
  }

  function isAllowedModel(model) {
    for (var i = 0; i < ALLOWED_MODELS.length; i++) {
      if (ALLOWED_MODELS[i] === model) return true;
    }
    return false;
  }

  function isSafeState(value) {
    if (value && typeof value === "object") value = value.state;
    for (var i = 0; i < SAFE_STATES.length; i++) {
      if (SAFE_STATES[i] === value) return true;
    }
    return false;
  }

  function usableSerial(serial) {
    return serial !== null && serial !== undefined && serial !== "" && serial !== "0" && serial !== 0;
  }

  function eligibleSerial(info) {
    if (!info || !isAllowedModel(info.model)) return null;
    return usableSerial(info.serialNumber) ? info.serialNumber : null;
  }

  function canonicalize(value) {
    if (Array.isArray(value)) {
      return "[" + value.map(canonicalize).join(",") + "]";
    }
    if (value && typeof value === "object") {
      return "{" + Object.keys(value).sort().map(function (key) {
        return JSON.stringify(key) + ":" + canonicalize(value[key]);
      }).join(",") + "}";
    }
    return JSON.stringify(value);
  }

  function timestampSeconds(value) {
    var number;
    if (typeof value === "number") {
      number = value;
    } else if (typeof value === "string") {
      if (value.trim() === "") return null;
      number = Number(value);
      if (!finite(number)) number = Date.parse(value) / 1000;
    } else {
      return null;
    }
    if (!finite(number)) return null;
    if (Math.abs(number) > 100000000000) number = number / 1000;
    return finite(number) ? number : null;
  }

  function machineFromMeasurement(measurement) {
    if (!measurement || typeof measurement !== "object") return null;
    var machine = measurement.machine && typeof measurement.machine === "object" ? measurement.machine : measurement;
    if (machine.timestamp === undefined && measurement.timestamp !== undefined) {
      machine = {
        timestamp: measurement.timestamp,
        state: machine.state,
        pressure: machine.pressure,
        flow: machine.flow
      };
    }
    return machine;
  }

  function scaleFromMeasurement(measurement) {
    if (!measurement || typeof measurement !== "object") return null;
    if (measurement.scale && typeof measurement.scale === "object") return measurement.scale;
    if (measurement.timestamp !== undefined &&
        (measurement.weight !== undefined || measurement.weightFlow !== undefined)) return measurement;
    return null;
  }

  function normalizedMachineSamples(measurements) {
    var result = [];
    if (!Array.isArray(measurements)) return result;
    for (var i = 0; i < measurements.length; i++) {
      var machine = machineFromMeasurement(measurements[i]);
      if (!machine) continue;
      var timestamp = timestampSeconds(machine.timestamp);
      if (timestamp === null) continue;
      result.push({
        timestamp: timestamp,
        state: machine.state,
        pressure: machine.pressure,
        flow: machine.flow
      });
    }
    return result;
  }

  function dedupeScaleByTimestamp(measurements) {
    var result = [];
    if (!Array.isArray(measurements)) return result;
    for (var i = 0; i < measurements.length; i++) {
      var raw = scaleFromMeasurement(measurements[i]);
      if (!raw) continue;
      var timestamp = timestampSeconds(raw.timestamp);
      if (timestamp === null) continue;
      var duplicate = false;
      for (var j = 0; j < result.length; j++) {
        if (result[j].timestamp === timestamp) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) {
        result.push({
          timestamp: timestamp,
          weight: raw.weight,
          weightFlow: raw.weightFlow
        });
      }
    }
    result.sort(function (a, b) { return a.timestamp - b.timestamp; });
    return result;
  }

  function stateIsEspresso(value) {
    return value === "espresso" || (value && value.state === "espresso");
  }

  function buildMachineFlatIntervals(input) {
    var machine = normalizedMachineSamples(input);
    var edges = [];
    for (var i = 0; i + 1 < machine.length; i++) {
      var a = machine[i];
      var b = machine[i + 1];
      if (!stateIsEspresso(a.state) || !stateIsEspresso(b.state)) continue;
      if (!finite(a.pressure) || !finite(b.pressure) || !finite(a.flow) || !finite(b.flow)) continue;
      if (a.pressure < MIN_PRESSURE || b.pressure < MIN_PRESSURE) continue;
      if (a.flow < MIN_MACHINE_FLOW || b.flow < MIN_MACHINE_FLOW) continue;
      var dt = b.timestamp - a.timestamp;
      if (!(dt > 0) || dt > MAX_MACHINE_GAP) continue;
      if (Math.abs((b.pressure - a.pressure) / dt) > MAX_PRESSURE_SLOPE) continue;
      if (Math.abs((b.flow - a.flow) / dt) > MAX_MACHINE_FLOW_SLOPE) continue;
      edges.push({ start: a.timestamp, end: b.timestamp });
    }
    return mergeIntervals(edges);
  }

  function normalizedScaleSamples(input) {
    if (!Array.isArray(input)) return [];
    var wrapped = [];
    for (var i = 0; i < input.length; i++) {
      var value = input[i];
      if (value && value.scale) wrapped.push(value);
      else if (value) wrapped.push({ scale: value });
    }
    return dedupeScaleByTimestamp(wrapped);
  }

  function buildScaleFlatIntervals(input) {
    var scale = normalizedScaleSamples(input);
    var edges = [];
    for (var i = 0; i + 1 < scale.length; i++) {
      var a = scale[i];
      var b = scale[i + 1];
      if (!finite(a.weight) || !finite(b.weight) || !finite(a.weightFlow) || !finite(b.weightFlow)) continue;
      if (a.weight < MIN_SCALE_WEIGHT || b.weight < MIN_SCALE_WEIGHT) continue;
      if (a.weightFlow < MIN_WEIGHT_FLOW || b.weightFlow < MIN_WEIGHT_FLOW) continue;
      var dt = b.timestamp - a.timestamp;
      if (!(dt > 0) || dt > MAX_SCALE_GAP) continue;
      if (Math.abs((b.weightFlow - a.weightFlow) / dt) > MAX_WEIGHT_FLOW_SLOPE) continue;
      edges.push({ start: a.timestamp, end: b.timestamp });
    }
    return mergeIntervals(edges);
  }

  function mergeIntervals(edges) {
    if (edges.length === 0) return [];
    var intervals = [{ start: edges[0].start, end: edges[0].end }];
    for (var i = 1; i < edges.length; i++) {
      var last = intervals[intervals.length - 1];
      if (edges[i].start === last.end) last.end = edges[i].end;
      else intervals.push({ start: edges[i].start, end: edges[i].end });
    }
    return intervals;
  }

  function intersectIntervals(machineIntervals, scaleIntervals) {
    var regions = [];
    for (var i = 0; i < machineIntervals.length; i++) {
      for (var j = 0; j < scaleIntervals.length; j++) {
        var start = Math.max(machineIntervals[i].start, scaleIntervals[j].start);
        var end = Math.min(machineIntervals[i].end, scaleIntervals[j].end);
        if (end - start >= MIN_REGION_DURATION) regions.push({ start: start, end: end });
      }
    }
    regions.sort(function (a, b) { return a.start - b.start; });
    return regions;
  }

  function interpolateLinear(samples, time, key) {
    if (!Array.isArray(samples) || samples.length === 0 || !finite(time)) return null;
    for (var i = 0; i + 1 < samples.length; i++) {
      var a = samples[i];
      var b = samples[i + 1];
      if (!finite(a.timestamp) || !finite(b.timestamp) || b.timestamp <= a.timestamp) continue;
      if (time < a.timestamp || time > b.timestamp) continue;
      if (!finite(a[key]) || !finite(b[key])) return null;
      var fraction = (time - a.timestamp) / (b.timestamp - a.timestamp);
      return a[key] + fraction * (b[key] - a[key]);
    }
    if (samples.length === 1 && time === samples[0].timestamp && finite(samples[0][key])) return samples[0][key];
    return null;
  }

  function integrateTrapezoidal(input, start, end, oldMultiplier) {
    var machine = normalizedMachineSamples(input);
    if (!(end > start) || !positive(oldMultiplier)) return NaN;
    var total = 0;
    var covered = 0;
    for (var i = 0; i + 1 < machine.length; i++) {
      var a = machine[i];
      var b = machine[i + 1];
      if (b.timestamp <= a.timestamp || !finite(a.flow) || !finite(b.flow)) continue;
      var left = Math.max(start, a.timestamp);
      var right = Math.min(end, b.timestamp);
      if (right <= left) continue;
      var leftFlow = interpolateLinear([a, b], left, "flow");
      var rightFlow = interpolateLinear([a, b], right, "flow");
      if (!finite(leftFlow) || !finite(rightFlow)) return NaN;
      total += (right - left) * ((leftFlow / oldMultiplier) + (rightFlow / oldMultiplier)) / 2;
      covered += right - left;
    }
    if (covered < end - start - 0.0000001) return NaN;
    return total;
  }

  function estimateShot(shot) {
    if (!shot || !shot.workflow || !shot.workflow.machine || !Array.isArray(shot.measurements)) {
      return { accepted: false, reason: "invalid_shot_estimate" };
    }
    var oldMultiplier = shot.workflow.machine.flowCalibration;
    if (!positive(oldMultiplier)) return { accepted: false, reason: "missing_historical_multiplier" };

    var scale = dedupeScaleByTimestamp(shot.measurements);
    if (scale.length < 2) return { accepted: false, reason: "no_scale_data" };

    var machineIntervals = buildMachineFlatIntervals(shot.measurements);
    var scaleIntervals = buildScaleFlatIntervals(scale);
    var regions = intersectIntervals(machineIntervals, scaleIntervals).filter(function (region) {
      return region.end - region.start >= MIN_REGION_DURATION;
    });
    if (regions.length === 0) return { accepted: false, reason: "insufficient_stable_region" };

    var totalBaseVolume = 0;
    var totalWeightGain = 0;
    var machine = normalizedMachineSamples(shot.measurements);
    for (var i = 0; i < regions.length; i++) {
      var region = regions[i];
      var baseVolume = integrateTrapezoidal(machine, region.start, region.end, oldMultiplier);
      var startWeight = interpolateLinear(scale, region.start, "weight");
      var endWeight = interpolateLinear(scale, region.end, "weight");
      var weightGain = endWeight === null || startWeight === null ? NaN : endWeight - startWeight;
      if (!positive(baseVolume) || !positive(weightGain)) {
        return { accepted: false, reason: "invalid_shot_estimate" };
      }
      totalBaseVolume += baseVolume;
      totalWeightGain += weightGain;
    }

    var multiplier = totalWeightGain / totalBaseVolume;
    if (!positive(multiplier) || multiplier < settings.MinimumMultiplier || multiplier > settings.MaximumMultiplier) {
      return { accepted: false, reason: "invalid_shot_estimate" };
    }
    return {
      accepted: true,
      multiplier: multiplier,
      regionCount: regions.length,
      totalBaseVolume: totalBaseVolume,
      totalWeightGain: totalWeightGain
    };
  }

  function defaults() {
    return {
      Enabled: true,
      Damping: 0.5,
      MaxAdjustment: 0.1,
      MinimumMultiplier: 0.35,
      MaximumMultiplier: 2.0,
      DryRun: false
    };
  }

  function applySettings(input) {
    var next = defaults();
    if (input && input.Enabled === false) next.Enabled = false;
    if (input && finite(input.Damping) && input.Damping >= 0) next.Damping = input.Damping;
    if (input && finite(input.MaxAdjustment) && input.MaxAdjustment >= 0) next.MaxAdjustment = input.MaxAdjustment;
    var minimum = input && finite(input.MinimumMultiplier) && input.MinimumMultiplier > 0 ? input.MinimumMultiplier : next.MinimumMultiplier;
    var maximum = input && finite(input.MaximumMultiplier) && input.MaximumMultiplier > 0 ? input.MaximumMultiplier : next.MaximumMultiplier;
    if (minimum <= maximum) {
      next.MinimumMultiplier = minimum;
      next.MaximumMultiplier = maximum;
    }
    if (input && input.DryRun === true) next.DryRun = true;
    settings = next;
  }

  function emptyPersistentState() {
    return { version: 1, machines: {} };
  }

  function validPersistentState(value) {
    return value && value.version === 1 && value.machines && typeof value.machines === "object" && !Array.isArray(value.machines);
  }

  function hydrate(value) {
    persistentState = validPersistentState(value) ? value : emptyPersistentState();
    state.storageReady = true;
  }

  function machineRecord(serial) {
    var record = persistentState.machines[serial];
    if (!record || typeof record !== "object") {
      record = {
        baselineMultiplier: null,
        lastPluginAppliedMultiplier: null,
        ownsCurrentMultiplier: false
      };
      persistentState.machines[serial] = record;
    }
    return record;
  }

  async function savePersistentState() {
    try {
      await host.storage({ type: "write", key: STORAGE_KEY, namespace: PLUGIN_ID, data: persistentState });
      return true;
    } catch (error) {
      return false;
    }
  }

  async function apiGet(path) {
    var response = await fetch(API_BASE + path);
    if (response.ok === false || (typeof response.status === "number" && response.status >= 400)) {
      throw new Error("GET failed");
    }
    return await response.json();
  }

  async function apiPost(path, body) {
    var response = await fetch(API_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (response.ok === false || (typeof response.status === "number" && response.status >= 400)) {
      throw new Error("POST failed");
    }
  }

  function baseDecision(title, action, reason) {
    var result = {
      action: action,
      profile: JSON.stringify(title === undefined ? "" : title)
    };
    if (reason) result.reason = reason;
    return result;
  }

  function addFields(result, fields) {
    for (var key in fields) {
      if (hasOwn(fields, key) && fields[key] !== undefined) result[key] = fields[key];
    }
    return result;
  }

  function logDecision(result) {
    var parts = ["[auto-flow-cal]"];
    for (var key in result) {
      if (hasOwn(result, key)) parts.push(key + "=" + result[key]);
    }
    host.log(parts.join(" "));
  }

  function metadataReason(shot, profileCanonical, serial) {
    if (!shot || !shot.workflow || !shot.workflow.machine) return "profile_mismatch";
    var workflow = shot.workflow;
    var machine = workflow.machine;
    if (canonicalize(workflow.profile) !== profileCanonical) return "profile_mismatch";
    if (machine.provenanceStatus !== "captured") return "uncaptured_machine_provenance";
    if (!isAllowedModel(machine.model) || machine.serialNumber !== serial) return "different_machine";
    if (!positive(machine.flowCalibration)) return "missing_historical_multiplier";
    return null;
  }

  function currentProfile(workflow) {
    return workflow && workflow.profile ? workflow.profile : {};
  }

  async function restoreBaseline(serial, record, context) {
    if (!positive(record.baselineMultiplier)) return { ok: false, reason: "no_baseline" };
    if (!currentGeneration(context)) return { ok: false, reason: "profile_changed_during_analysis" };
    if (settings.DryRun) return { ok: true, dryRun: true };

    var machineState;
    try {
      machineState = await apiGet("/api/v1/machine/state");
    } catch (error) {
      return { ok: false, reason: "machine_busy" };
    }
    if (!machineState || !isSafeState(machineState.state)) return { ok: false, reason: "machine_busy" };

    var info;
    try {
      info = await apiGet("/api/v1/machine/info");
    } catch (error) {
      return { ok: false, reason: "machine_changed_during_analysis" };
    }
    if (eligibleSerial(info) !== serial) return { ok: false, reason: "machine_changed_during_analysis" };
    if (!currentGeneration(context)) return { ok: false, reason: "profile_changed_during_analysis" };

    try {
      await apiPost("/api/v1/machine/calibration", { flowMultiplier: record.baselineMultiplier });
    } catch (error) {
      return { ok: false, reason: "calibration_write_failed" };
    }

    var verified;
    try {
      verified = await apiGet("/api/v1/machine/calibration");
    } catch (error) {
      return { ok: false, reason: "calibration_verify_failed" };
    }
    if (!verified || !positive(verified.flowMultiplier)) return { ok: false, reason: "calibration_verify_failed" };

    var oldOwns = record.ownsCurrentMultiplier;
    var oldApplied = record.lastPluginAppliedMultiplier;
    record.ownsCurrentMultiplier = false;
    record.lastPluginAppliedMultiplier = null;
    if (!(await savePersistentState())) {
      record.ownsCurrentMultiplier = oldOwns;
      record.lastPluginAppliedMultiplier = oldApplied;
      return { ok: false, reason: "calibration_verify_failed" };
    }
    return { ok: true, verified: verified.flowMultiplier };
  }

  function currentGeneration(context) {
    return context.generation === state.generation && context.profileCanonical === state.activeProfileCanonical;
  }

  async function evidenceFailure(title, reason, shotId, serial, record, context) {
    var result;
    if (settings.DryRun) {
      result = baseDecision(title, "dry_run", reason);
    } else if (record && record.ownsCurrentMultiplier) {
      var restored = await restoreBaseline(serial, record, context);
      if (restored.ok) {
        result = baseDecision(title, "restore", reason);
        if (restored.verified !== undefined) result.baseline = restored.verified.toFixed(3);
      } else {
        result = baseDecision(title, "skip", restored.reason);
      }
    } else {
      result = baseDecision(title, "skip", reason);
    }
    if (shotId !== undefined) result.shotId = shotId;
    return result;
  }

  async function evaluateInner(workflow, context) {
    var profile = currentProfile(workflow);
    var title = profile.title;
    var machineInfo;
    try {
      machineInfo = await apiGet("/api/v1/machine/info");
    } catch (error) {
      return baseDecision(title, "skip", "no_machine");
    }

    var serial = eligibleSerial(machineInfo);
    if (!isAllowedModel(machineInfo && machineInfo.model)) return baseDecision(title, "skip", "non_de1_machine");
    if (!serial) return baseDecision(title, "skip", "machine_identity_unavailable");

    var calibration;
    try {
      calibration = await apiGet("/api/v1/machine/calibration");
    } catch (error) {
      return baseDecision(title, "skip", "calibration_read_failed");
    }
    var currentMultiplier = calibration && calibration.flowMultiplier;
    if (!positive(currentMultiplier)) return baseDecision(title, "skip", "calibration_read_failed");

    var record = machineRecord(serial);
    if (record.ownsCurrentMultiplier && positive(record.lastPluginAppliedMultiplier) &&
        Math.abs(currentMultiplier - record.lastPluginAppliedMultiplier) > OWNERSHIP_EPSILON) {
      record.baselineMultiplier = currentMultiplier;
      record.lastPluginAppliedMultiplier = null;
      record.ownsCurrentMultiplier = false;
      await savePersistentState();
      return baseDecision(title, "skip", "external_override");
    }

    if (!positive(record.baselineMultiplier)) {
      record.baselineMultiplier = currentMultiplier;
      if (!(await savePersistentState())) return baseDecision(title, "skip", "calibration_read_failed");
    }

    var summaries;
    try {
      summaries = await apiGet("/api/v1/shots?profileTitle=" + encodeURIComponent(title === undefined ? "" : title) + "&limit=2&offset=0&order=desc");
    } catch (error) {
      return baseDecision(title, "skip", "history_fetch_failed");
    }
    if (!Array.isArray(summaries)) return baseDecision(title, "skip", "history_fetch_failed");
    context.evidenceRead = true;
    if (summaries.length !== 2) return await evidenceFailure(title, "insufficient_history", undefined, serial, record, context);

    for (var i = 0; i < 2; i++) {
      var summaryReason = metadataReason(summaries[i], context.profileCanonical, serial);
      if (summaryReason) return await evidenceFailure(title, summaryReason, summaries[i] && summaries[i].id, serial, record, context);
      if (!summaries[i] || summaries[i].id === undefined || summaries[i].id === null) {
        context.evidenceRead = false;
        return baseDecision(title, "skip", "history_fetch_failed");
      }
    }

    var id1 = summaries[0].id;
    var id2 = summaries[1].id;
    if (String(id1) === String(id2)) {
      context.evidenceRead = false;
      return baseDecision(title, "skip", "history_fetch_failed");
    }
    var fullShots;
    try {
      fullShots = await apiGet("/api/v1/shots?ids=" + encodeURIComponent(id1) + "&ids=" + encodeURIComponent(id2) + "&order=desc");
    } catch (error) {
      context.evidenceRead = false;
      return baseDecision(title, "skip", "shot_fetch_failed");
    }
    if (!Array.isArray(fullShots) || fullShots.length !== 2) {
      context.evidenceRead = false;
      return baseDecision(title, "skip", "shot_fetch_failed");
    }

    var requested = {};
    requested[String(id1)] = 1;
    requested[String(id2)] = (requested[String(id2)] || 0) + 1;
    var returned = {};
    for (var j = 0; j < fullShots.length; j++) {
      if (!fullShots[j] || fullShots[j].id === undefined || fullShots[j].id === null) return baseDecision(title, "skip", "shot_fetch_failed");
      var returnedId = String(fullShots[j].id);
      returned[returnedId] = (returned[returnedId] || 0) + 1;
    }
    for (var requestedId in requested) {
      if (!hasOwn(returned, requestedId) || returned[requestedId] !== requested[requestedId]) {
        return baseDecision(title, "skip", "shot_fetch_failed");
      }
    }
    context.evidenceRead = true;

    var shotById = {};
    for (var k = 0; k < fullShots.length; k++) shotById[String(fullShots[k].id)] = fullShots[k];
    var shots = [shotById[String(id1)], shotById[String(id2)]];
    for (var m = 0; m < shots.length; m++) {
      var fullReason = metadataReason(shots[m], context.profileCanonical, serial);
      if (fullReason) return await evidenceFailure(title, fullReason, shots[m] && shots[m].id, serial, record, context);
    }

    var estimates = [estimateShot(shots[0]), estimateShot(shots[1])];
    for (var n = 0; n < estimates.length; n++) {
      if (!estimates[n].accepted) {
        return await evidenceFailure(title, estimates[n].reason, shots[n].id, serial, record, context);
      }
    }

    var c1 = estimates[0].multiplier;
    var c2 = estimates[1].multiplier;
    var estimate = (c1 + c2) / 2;
    if (!positive(estimate) || Math.abs(c1 - c2) / estimate > AGREEMENT_LIMIT) {
      return addFields(baseDecision(title, "skip", "shots_disagree"), {
        shotIds: String(shots[0].id) + "," + String(shots[1].id),
        shot1: c1.toFixed(3), shot2: c2.toFixed(3)
      });
    }

    if (Math.abs(estimate - currentMultiplier) < DEADBAND) {
      return addFields(baseDecision(title, "skip", "deadband"), {
        shotIds: String(shots[0].id) + "," + String(shots[1].id),
        shot1Regions: estimates[0].regionCount, shot2Regions: estimates[1].regionCount,
        shot1: c1.toFixed(3), shot2: c2.toFixed(3), estimate: estimate.toFixed(3), current: currentMultiplier.toFixed(3)
      });
    }

    var correction = (estimate - currentMultiplier) * settings.Damping;
    if (correction > settings.MaxAdjustment) correction = settings.MaxAdjustment;
    if (correction < -settings.MaxAdjustment) correction = -settings.MaxAdjustment;
    var target = currentMultiplier + correction;
    if (target < settings.MinimumMultiplier) target = settings.MinimumMultiplier;
    if (target > settings.MaximumMultiplier) target = settings.MaximumMultiplier;
    target = Math.round(target / RESOLUTION) * RESOLUTION;
    if (Math.abs(target - currentMultiplier) <= OWNERSHIP_EPSILON) {
      return addFields(baseDecision(title, "skip", "deadband"), {
        shotIds: String(shots[0].id) + "," + String(shots[1].id),
        shot1Regions: estimates[0].regionCount, shot2Regions: estimates[1].regionCount,
        shot1: c1.toFixed(3), shot2: c2.toFixed(3), estimate: estimate.toFixed(3), current: currentMultiplier.toFixed(3)
      });
    }

    if (!currentGeneration(context)) return baseDecision(title, "skip", "profile_changed_during_analysis");

    var machineState;
    try {
      machineState = await apiGet("/api/v1/machine/state");
    } catch (error) {
      return baseDecision(title, "skip", "machine_busy");
    }
    if (!machineState || !isSafeState(machineState.state)) return baseDecision(title, "skip", "machine_busy");
    if (!currentGeneration(context)) return baseDecision(title, "skip", "profile_changed_during_analysis");

    var finalInfo;
    try {
      finalInfo = await apiGet("/api/v1/machine/info");
    } catch (error) {
      return baseDecision(title, "skip", "machine_changed_during_analysis");
    }
    if (!isAllowedModel(finalInfo && finalInfo.model) || eligibleSerial(finalInfo) !== serial) {
      return baseDecision(title, "skip", "machine_changed_during_analysis");
    }
    if (!currentGeneration(context)) return baseDecision(title, "skip", "profile_changed_during_analysis");

    var common = {
      machineModel: finalInfo.model,
      machineSerial: serial,
      shotIds: String(shots[0].id) + "," + String(shots[1].id),
      shot1Regions: estimates[0].regionCount,
      shot2Regions: estimates[1].regionCount,
      shot1: c1.toFixed(3),
      shot2: c2.toFixed(3),
      estimate: estimate.toFixed(3),
      current: currentMultiplier.toFixed(3),
      target: target.toFixed(3)
    };
    if (settings.DryRun) return addFields(baseDecision(title, "dry_run", "dry_run"), common);

    try {
      await apiPost("/api/v1/machine/calibration", { flowMultiplier: target });
    } catch (error) {
      return addFields(baseDecision(title, "skip", "calibration_write_failed"), common);
    }

    var verified;
    try {
      verified = await apiGet("/api/v1/machine/calibration");
    } catch (error) {
      return addFields(baseDecision(title, "skip", "calibration_verify_failed"), common);
    }
    if (!verified || !positive(verified.flowMultiplier)) {
      return addFields(baseDecision(title, "skip", "calibration_verify_failed"), common);
    }

    var oldApplied = record.lastPluginAppliedMultiplier;
    var oldOwns = record.ownsCurrentMultiplier;
    record.lastPluginAppliedMultiplier = verified.flowMultiplier;
    record.ownsCurrentMultiplier = true;
    if (!(await savePersistentState())) {
      record.lastPluginAppliedMultiplier = oldApplied;
      record.ownsCurrentMultiplier = oldOwns;
      return addFields(baseDecision(title, "skip", "calibration_verify_failed"), common);
    }
    common.target = verified.flowMultiplier.toFixed(3);
    return addFields(baseDecision(title, "apply"), common);
  }

  async function evaluate(workflow) {
    var context = {
      generation: ++state.generation,
      profileCanonical: canonicalize(workflow && workflow.profile),
      historyRevision: state.historyRevision,
      evidenceRead: false
    };
    var title = currentProfile(workflow).title;
    var result;
    try {
      if (!settings.Enabled) {
        result = baseDecision(title, "skip", "disabled");
        context.evidenceRead = true;
      } else {
        result = await evaluateInner(workflow, context);
      }
    } catch (error) {
      result = baseDecision(title, "skip", "history_fetch_failed");
    }

    if (context.evidenceRead && context.generation === state.generation && context.profileCanonical === state.activeProfileCanonical) {
      state.lastEvaluatedHistoryRevision = context.historyRevision;
    }
    logDecision(result || baseDecision(title, "skip", "history_fetch_failed"));
  }

  async function handleWorkflowUpdated(workflow) {
    var profileCanonical = canonicalize(workflow && workflow.profile);
    var changed = profileCanonical !== state.activeProfileCanonical;
    var dirty = state.historyRevision > state.lastEvaluatedHistoryRevision;
    if (!changed && !dirty) return;
    state.activeProfileCanonical = profileCanonical;
    state.activeProfileTitle = currentProfile(workflow).title;
    await evaluate(workflow || {});
  }

  async function finishHydration(value) {
    if (state.storageReady) return;
    hydrate(value);
    if (state.pendingWorkflow) {
      var workflow = state.pendingWorkflow;
      state.pendingWorkflow = null;
      await handleWorkflowUpdated(workflow);
    }
  }

  async function onLoad(pluginSettings) {
    applySettings(pluginSettings);
    state.storageReady = false;
    state.pendingWorkflow = null;
    try {
      var read = host.storage({ type: "read", key: STORAGE_KEY, namespace: PLUGIN_ID });
      if (read && typeof read.catch === "function") read.catch(function () {});
    } catch (error) {
      // Keep the plugin unevaluated when its persistent state cannot hydrate.
    }
  }

  async function onEvent(event) {
    if (!event) return;
    if (event.name === "storageRead") {
      if (event.payload && event.payload.key === STORAGE_KEY) await finishHydration(event.payload.value);
      return;
    }
    if (event.name === "workflowUpdated") {
      if (!state.storageReady) {
        state.pendingWorkflow = event.payload || {};
        return;
      }
      await handleWorkflowUpdated(event.payload || {});
      return;
    }
    if (event.name === "shotStored") {
      state.historyRevision++;
      return;
    }
    if (event.name === "shutdown") {
      state.generation++;
      if (state.storageReady) await savePersistentState();
    }
  }

  async function onUnload() {
    state.generation++;
    if (state.storageReady) await savePersistentState();
  }

  return {
    id: PLUGIN_ID,
    version: VERSION,
    onLoad: onLoad,
    onUnload: onUnload,
    onEvent: onEvent,
    __test: {
      canonicalize: canonicalize,
      timestampSeconds: timestampSeconds,
      dedupeScaleByTimestamp: dedupeScaleByTimestamp,
      mergeIntervals: mergeIntervals,
      buildMachineFlatIntervals: buildMachineFlatIntervals,
      buildScaleFlatIntervals: buildScaleFlatIntervals,
      intersectIntervals: intersectIntervals,
      interpolateLinear: interpolateLinear,
      integrateTrapezoidal: integrateTrapezoidal,
      estimateShot: estimateShot,
      isEligibleDE1: function (info) { return eligibleSerial(info); }
    }
  };
}
