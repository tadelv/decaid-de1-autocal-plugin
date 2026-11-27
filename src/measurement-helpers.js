// Measurement helpers shared by the bundled plugin, observer and offline diagnostics.
function createMeasurementHelpers() {
  var ALLOWED_MODELS = ["DE1", "DE1Plus", "DE1Pro", "DE1XL", "DE1Cafe", "DE1XXL", "DE1XXXL"];
  function finite(value) {
    return typeof value === "number" && isFinite(value);
  }
  function isAllowedModel(model) {
    for (var i = 0; i < ALLOWED_MODELS.length; i++) {
      if (ALLOWED_MODELS[i] === model) return true;
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
  function scaleFromMeasurement(measurement) {
    if (!measurement || typeof measurement !== "object") return null;
    if (measurement.scale && typeof measurement.scale === "object") return measurement.scale;
    if (measurement.timestamp !== undefined &&
        (measurement.weight !== undefined || measurement.weightFlow !== undefined)) return measurement;
    return null;
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
  return { canonicalize: canonicalize, timestampSeconds: timestampSeconds, dedupeScaleByTimestamp: dedupeScaleByTimestamp, interpolateLinear: interpolateLinear, isEligibleDE1: eligibleSerial };
}
module.exports = { createMeasurementHelpers };
