function createPlugin(host) {
  'use strict';
  var ID = 'auto-flow-cal-observer.reaplugin';
  var VERSION = '0.1.1';
  var FIT_METHOD = 'fixed_zero_lag_v1';
  var records = [], queue = [], ready = false, running = false, stopped = false, lastError = null;
  var models = ['DE1', 'DE1Plus', 'DE1Pro', 'DE1XL', 'DE1Cafe', 'DE1XXL', 'DE1XXXL'];

  async function get(path) {
    if (!/^\/api\/v1\/(machine\/(info|calibration)|shots\?[^\s]*)$/.test(path)) throw new Error('read_not_allowed');
    var response = await fetch('http://localhost:8080' + path, { method: 'GET' });
    if (response.ok === false || response.status >= 400) throw new Error('read_failed');
    return await response.json();
  }

  function known(id) { return records.some(function (r) { return r.shotId === id && r.fitMethod === FIT_METHOD; }); }

  async function inspect(id) {
    if (known(id)) return;
    var info = await get('/api/v1/machine/info');
    var full = await get('/api/v1/shots?ids=' + encodeURIComponent(id) + '&order=desc');
    if (!Array.isArray(full) || full.length !== 1 || String(full[0].id) !== id) throw new Error('shot_not_available');
    var shot = full[0], machine = shot.workflow && shot.workflow.machine;
    var profile = shot.workflow && shot.workflow.profile;
    var result;
    if (models.indexOf(info.model) < 0 || !info.serialNumber || String(info.serialNumber) === '0') {
      result = { fitted: false, reason: 'ineligible_machine' };
    } else if (!machine || machine.provenanceStatus !== 'captured' || String(machine.serialNumber) !== String(info.serialNumber) || models.indexOf(machine.model) < 0) {
      result = { fitted: false, reason: 'different_or_unknown_machine' };
    } else {
      result = experimentalFitFlow(shot);
    }
    var calibration = await get('/api/v1/machine/calibration');
    if (stopped) return;
    var record = { shotId: id, recordedAt: new Date().toISOString(), shotTimestamp: shot.timestamp || null,
      profile: profile && profile.title || null, stopReason: shot.stopReason || null,
      historicalMultiplier: machine && machine.flowCalibration || null,
      observedMachineMultiplier: calibration.flowMultiplier, mode: 'observe_only',
      observerVersion: VERSION, fitMethod: FIT_METHOD, fit: result };
    records.unshift(record);
    records = records.slice(0, 20);
    host.log('[flow-observer] ' + JSON.stringify(record));
    try {
      await host.storage({ type: 'write', key: 'records', namespace: ID, data: { version: 1, records: records } });
      lastError = null;
    } catch (error) { lastError = 'storage_write_failed'; }
  }

  async function drain() {
    if (!ready || running || stopped) return;
    running = true;
    try {
      while (queue.length && !stopped) {
        var id = queue.shift();
        try { await inspect(id); }
        catch (error) { lastError = String(error.message || error); host.log('[flow-observer] shot=' + id + ' error=' + lastError); }
      }
    } finally { running = false; }
  }

  function enqueue(id) {
    if (id === undefined || id === null || String(id) === '') return;
    id = String(id);
    if (!known(id) && queue.indexOf(id) < 0) queue.push(id);
  }

  async function seed() {
    try {
      var history = await get('/api/v1/shots?limit=2&offset=0&order=desc');
      var items = Array.isArray(history) ? history : history.items;
      if (!Array.isArray(items)) throw new Error('history_unavailable');
      items.slice().reverse().forEach(function (s) { enqueue(s.id); });
    } catch (error) { lastError = String(error.message || error); }
    await drain();
  }

  function status() {
    return { schemaVersion: 1, plugin: { id: ID, version: VERSION }, mode: 'observe_only', fitMethod: FIT_METHOD,
      calibrationWritesAllowed: false, storageReady: ready, analyzing: running, pending: queue.length,
      lastError: lastError, records: records };
  }

  function escape(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function page() {
    var rows = records.map(function (r) {
      var fit = r.fit || {};
      var cells = [r.shotTimestamp || r.recordedAt, r.profile, r.shotId, r.fitMethod || 'legacy lag-optimized',
        fit.fitted ? Number(fit.multiplier).toFixed(3) : fit.reason,
        fit.profileFrame, fit.lagSeconds, (fit.warnings || []).join(', '), r.observedMachineMultiplier];
      return '<tr>' + cells.map(function (c) { return '<td>' + escape(c) + '</td>'; }).join('') + '</tr>';
    }).join('');
    return '<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<meta http-equiv="refresh" content="5"><title>Flow Calibration Observer</title>' +
      '<style>body{font:16px system-ui;padding:1rem;background:#181818;color:#eee}table{border-collapse:collapse}td,th{padding:.6rem;border:1px solid #666;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>' +
      '<h1>Flow Calibration Observer</h1><p><strong>OBSERVE ONLY — machine calibration is never changed.</strong></p>' +
      '<p>Candidate values are experimental, not applied. Zero-lag fit of the final recorded step; lag search is diagnostic only. Legacy results remain labeled separately. Refreshes every 5 seconds; last 20 observations persist.</p>' +
      '<p>' + escape(lastError || (ready ? 'Ready for shots' : 'Loading saved observations')) + '</p>' +
      '<button onclick="history.back()">Back</button><div style="overflow:auto"><table><thead><tr>' +
      ['Shot time', 'Profile', 'Shot ID', 'Fit method', 'Candidate multiplier', 'Step index', 'Applied lag (s)', 'Warnings', 'Observed machine multiplier'].map(function (s) { return '<th>' + s + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div><details><summary>Full diagnostic records</summary><pre>' + escape(JSON.stringify(status(), null, 2)) + '</pre></details></html>';
  }

  return {
    id: ID, version: VERSION,
    onLoad: function () {
      stopped = false;
      host.storage({ type: 'read', key: 'records', namespace: ID });
    },
    onUnload: function () { stopped = true; },
    onEvent: async function (event) {
      if (stopped || !event) return;
      if (event.name === 'storageRead' && event.payload && event.payload.key === 'records' && !ready) {
        var saved = event.payload.value;
        if (saved && saved.version === 1 && Array.isArray(saved.records)) records = saved.records.filter(function (r) { return r && typeof r.shotId === 'string'; }).slice(0, 20);
        ready = true;
        await seed();
      } else if (event.name === 'shotStored') {
        enqueue(event.payload && event.payload.id);
        await drain();
      }
    },
    __httpRequestHandler: function (request) {
      var ui = request.endpoint === 'ui';
      var ok = ui || request.endpoint === 'status';
      return { requestId: request.requestId, status: ok ? 200 : 404,
        headers: { 'Content-Type': ui ? 'text/html; charset=utf-8' : 'application/json' },
        body: ui ? page() : JSON.stringify(ok ? status() : { error: 'not_found' }) };
    }
  };
}
