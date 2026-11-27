# Auto Flow Calibration — Decaid plugin

**2.0.0 is an upgrade of the existing plugin, not a new plugin.** Its ID remains **`auto-flow-cal.reaplugin`**, so Decaid can update the original installation. The operator approved release after checking the UI and a normal shot on p85pro; calibration still requires supervised use. The operator-approved p85pro replacement is verified: **2.0.0 loaded and ready, temporary updater removed, multiplier unchanged at 0.835**.

It brings the displayed scale weight-flow and machine water-flow lines closer by adjusting the machine's estimation multiplier between shots. Calibration can affect flow-controlled extraction, not only the chart. Keep testing supervised.

## What changed from 1.4.0

- One usable new shot can supply an absolute multiplier from its final recorded extraction step. The two-shot agreement and simultaneous-flat-pressure/flow requirements are gone; usable changed-dose/grind and short-shot evidence can count.
- Full update gain, no per-shot movement cap. Overall bounds remain **0.350–2.000**, resolution **0.001** and automatic-learning deadband **0.010**. Zero-lag fitting determines the primary result; lag diagnostics cannot veto otherwise usable zero-lag evidence.
- The multiplier appears under **Brew**. Tap it for the light/dark overlay and per-profile **Manual/Auto** controls; Settings → Extensions also has an Open action.
- The original manifest now declares the display/push and machine-state capabilities: `emit`, `events.machine`, HTTP `status/skin/ui/view/mode`, and the `changed` WebSocket.

## Manual and Auto

**Manual** keeps a chosen multiplier for that named profile and DE1, across shots, recipe edits, profile changes and restart. Manual shots do not train automatic estimates. **Auto** recalls the current recipe's verified automatic value, or the starting baseline, and learns from subsequent usable shots.

Manual choices currently use the exact profile title per DE1. Same-named profiles share a choice; renaming requires choosing again. Automatic estimates use the exact title/version/steps. [Issue #1](https://github.com/tadelv/decaid-de1-autocal-plugin/issues/1) tracks stronger profile matching.

## Installation and settings

[Decaid installation instructions](https://decentespresso.com/docs/how_to_install_skins_or_plugins_on_decaid). Use the release's **`auto-flow-cal-v2.0.0.zip`**, or the checked-in `auto-flow-cal.reaplugin/` directory. It contains the complete built plugin; copying `src/plugin.js` alone does not work. The normal public GitHub installation route uses the latest published release.

| Setting | Fresh default | Meaning |
|---|---|---|
| Enable calibration changes | Off | Allow automatic and manual changes on the selected DE1 |
| DE1 serial number | Empty | Exact machine pin; blank prevents changes |

Only traditional DE1 models are supported, never Bengle. The host must acknowledge matching `storageWrite` events and provide `events.machine` / `stateUpdate`. Missing identity, storage acknowledgement, scale evidence or valid measurements fails closed.

**No old-settings migration is provided, as requested by the sole operator.** The v2 ledger uses the new `calibration-v2` key in the original plugin namespace. The old 1.x `state` entry is left untouched; temporary `-updater` state is not imported. Configure the serial and enable explicitly. Existing old settings are not a substitute for the new serial pin. First arming adopts the current live multiplier and fences existing shot history without a calibration command.

Do not run the temporary **`auto-flow-cal-updater.reaplugin`** alongside the original plugin. Its separate identity was only a testing arrangement and is not the release product. During a supervised replacement, disable it first; remove it only after the original-ID plugin is verified ready. Keep state backups. A source-only downgrade is not a safe rollback.

## Safety limits

**Queued-write protection is best-effort, not atomic.** A shot start or outside edit can race the final read and execution of a queued command. Host execution-time guards remain deferred. Do not start a shot, switch machines/profiles or edit calibration while an update is pending. Wait for a terminal result before the next shot.

External edits pause application. Ambiguous dispatch/read-back/storage outcomes retain an unresolved intent and hold further writes; never clear that intent or blindly retry. Disable/unload stops new dispatch but cannot cancel an already submitted command and does not restore calibration. The consumed-ID ledger is intended for limited supervised use; long-term compaction remains deferred.

On Android, closing the keyboard can leave the overlay too small until scrolled. The operator accepted this workaround for the first version. [UI behavior and validation](docs/UI.md).

## Read-only inspection

```text
GET /api/v1/plugins/auto-flow-cal.reaplugin/status
GET /api/v1/plugins/auto-flow-cal.reaplugin/skin
GET /api/v1/plugins/auto-flow-cal.reaplugin/ui
GET /api/v1/plugins/auto-flow-cal.reaplugin/view
```

`status` reads memory only. `view` independently reads the selected machine; `skin` and `ui` render cached data and declarations. None applies/reset/enables calibration. Only explicit POST `mode` selects Manual/Auto, with master-enable, serial, context, idle and persistence checks.

## Development

```sh
npm run build                       # refresh checked-in installable plugin from src/
npm test                            # current behavior plus frozen 1.4 characterization
npm run check                       # syntax and exact generated-source consistency
node tools/build-plugin.js .pi/build # separate source.json + installable directory
npm run fit:offline -- --v2          # current zero-lag fitter, offline sanitized fixtures
```

`src/plugin.js`, `src/ui.js` and `src/measurement-helpers.js` are bundled with the shared fitting core by `tools/build-plugin.js`. Runtime ID/version come from the original manifest. No runtime build or npm dependencies are needed on the tablet.

Current controller and UI tests run against the real compiled bundle. Frozen 1.4 code lives under `test/legacy/` only, with explicitly named legacy tests and `tools/legacy-why-skip.js` for historical diagnostics; it is not bundled. Sanitized real-shot fixtures contain no machine identity or personal shot metadata. The separate historical [observer](observer/README.md) remains research tooling, not a second calibration writer.

Release tags must match the manifest (`v2.0.0`). The workflow prepares **drafts only**; publication requires operator approval. [Release notes and remaining test gate](docs/RELEASE-2.0.0.md). [Recorded supervised-trial evidence](docs/trial-results.md).

The earlier Design and Implementation Plan describe 1.x and remain historical references. The current behavior and limitations are documented here, in the UI notes and regression tests.
