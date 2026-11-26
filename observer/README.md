# Flow Calibration Observer — tablet trial

**Observe only. No calibration-write path.** This is a separate plugin, not a replacement release of the automatic calibration writer.

## Current update: 0.1.1, fixed zero lag

Updated on the tablet with operator approval on 2026-11-25. The primary multiplier now always fits the **unshifted final-step curves** (`fitMethod: fixed_zero_lag_v1`, `lagSeconds: 0`). Lag search remains in `lagDiagnostics` only and cannot select the primary multiplier. For a controlled comparison, the fitting blocks still use the original common-support window across the diagnostic lag grid.

The same two live Cremina&Gusto shots were replayed in Decaid: **1.189328** and **1.182376**, about **0.59% apart**. Calibration remained **1.130**, and the original writer stayed disabled. All four legacy records were preserved; the page labels their method separately. Shot deduplication now uses shot ID plus fit method, so a method change re-analyzes the latest two shots without deleting earlier evidence. New records also include observer version.

**93/93 tests passed** before updating. Added checks prove that a diagnostic lag cannot change the primary multiplier and that upgrading preserves legacy records while re-fitting recent shots. Live status/UI checks confirm version 0.1.1, zero-lag results, legacy preservation, no pending/error state, and no calibration writes. Upgrade snapshots/payload/read-backs are in ignored `.pi/observer-zero-lag-build/`.

The next fresh saved shot will be recorded with the new method; no extra shot was created by the agent.

## Initial installed trial (0.1.0)

Installed with operator approval on `p85pro.home:8080`, 2026-11-25:

- `auto-flow-cal-observer.reaplugin` **0.1.0**, loaded and auto-load enabled.
- Original `auto-flow-cal.reaplugin` **1.4.0** remains installed, with original source/settings intact, but **disabled and auto-load disabled** so it cannot adjust calibration during the trial.
- Calibration verified **1.130 before installation, after installation, and after observer reload**.
- Live Android/Decaid runtime reproduced the captured estimates **1.007655** and **0.980438**, including the first shot's timing-sensitive warning. Both stored records survived unloading/reloading the observer without duplication.
- No machine calibration POST, workflow change, synthetic shot creation or machine start/warmup command was issued. Fresh-shot delivery is covered in mocked-host tests; a new human-pulled shot is the remaining live event check.

Open:

http://p85pro.home:8080/api/v1/plugins/auto-flow-cal-observer.reaplugin/ui

Or Streamline **Settings → Extensions → Flow Calibration Observer → Open**.

JSON diagnostics:

http://p85pro.home:8080/api/v1/plugins/auto-flow-cal-observer.reaplugin/status

The page refreshes every five seconds. Pull 2–3 normal shots with the connected scale and inspect the newest observations. Charts and actual calibration will **not** change in this trial. The candidate multiplier, recorded final step index, lag, warning flags, observed machine multiplier and full fitting diagnostics are recorded for comparison. A missing/unusable observation is reported, not replaced with a guessed value.

## Behavior and safety boundary

- `shotStored` queues the exact stored shot ID and analyzes it without waiting for a profile/workflow change. Startup seeds the two newest historical shots; known IDs are deduplicated.
- Same-machine captured provenance and a traditional DE1 model are required before fitting. Each shot is analyzed against its own recorded final step/program; no value is applied to any active profile.
- Last 20 observations persist in the observer's own plugin-storage namespace. The original plugin's storage is untouched. Read failures are reported in `lastError`; an event can be retried if it arrives again after a failed fetch.
- The only machine requests are **GET** `/machine/info` and `/machine/calibration`. History reads are GET `/shots`. A runtime path allowlist limits those requests. Status/UI endpoints only render memory; there is no apply/reset/settings write endpoint.
- Only the pure timestamp/scale/interpolation helpers are extracted from production source; **the old writer is not bundled**. The exact experimental fitter factory is shared with offline tools, avoiding a second algorithm copy. The builder removes `Array.at(-1)` calls for embedded-runtime compatibility.
- The fit is still experimental, including on aborted/short recordings. Diagnostics and warning flags are not calibrated confidence probabilities or an authorization to modify the machine.

## Build and tests

```sh
npm run build:observer
node --test test/observer.test.js
npm test
```

The generated standalone package and API upload payload live under ignored `.pi/observer-build/`:

- `auto-flow-cal-observer.reaplugin/{manifest.json,plugin.js}`
- `source.json` for `PUT /api/v1/plugins/auto-flow-cal-observer.reaplugin/source`

Source templates are `observer/manifest.json` and `observer/plugin.js`. The experimental fitter remains `tools/experimental-flow-fit.js`. The normal release workflow still packages only the original writer; this trial was **not published to GitHub or released**.

**91/91 tests passed** before installation. Observer tests enforce GET-only requests, exact parity with all four offline fixtures, shot-event analysis/deduplication, queued hydration, saved records, startup history, unknown-machine rejection, escaped UI, endpoint read-only behavior, and read-failure/unload handling.

The install snapshot, prior settings/source metadata, generated payload and live read-backs are under `.pi/observer-build/` (`trial-before.json`, `trial-after.json`, `live-status.json`, `reloaded-status.json`, `final-calibration.json`, `final-plugins.json`). No unrelated plugin settings were changed.

## End the trial

Disable **Flow Calibration Observer** from Extensions to stop recording. Leave the original writer disabled while deciding the next calibration policy. Re-enabling **Auto Flow Calibration** deliberately restores the old automatic-write behavior; do not do that merely to close the observer page. The original multiplier was never changed, so there is no calibration value to restore.
