# Auto Flow Calibration — Decaid plugin

**2.0.3 upgrades the existing plugin, not a new plugin.** Its ID remains **`auto-flow-cal.reaplugin`**, so Decaid can update the original installation. This [release](docs/RELEASE-2.0.3.md) makes **Auto** always start from the **current machine multiplier** without sending a calibration command, and keeps a saved **Manual** value separately so it no longer seeds Auto. It builds on the [2.0.2 recovery release](docs/RELEASE-2.0.2.md), whose mode-preserving **Check again** panel and the 2.0.1 delayed-profile-event fix are unchanged. Calibration still requires supervised use.

It brings the displayed scale weight-flow and machine water-flow lines closer by adjusting the machine's estimation multiplier between shots. Calibration can affect flow-controlled extraction, not only the chart. Keep testing supervised.

## What changed from 1.4.0

- One usable new shot can supply an absolute multiplier from its final recorded extraction step. The two-shot agreement and simultaneous-flat-pressure/flow requirements are gone; usable changed-dose/grind and short-shot evidence can count.
- Full update gain, no per-shot movement cap. Overall bounds remain **0.350–2.000**, resolution **0.001** and automatic-learning deadband **0.010**. Zero-lag fitting determines the primary result; lag diagnostics cannot veto otherwise usable zero-lag evidence.
- The multiplier appears under **Brew**. Tap it for the light/dark overlay and per-profile **Manual/Auto** controls; Settings → Extensions also has an Open action.
- The original manifest now declares the display/push and machine-state capabilities: `emit`, `events.machine`, HTTP `status/skin/ui/view/mode/recover`, and the `changed` WebSocket.

## Manual and Auto

**Manual** keeps a chosen multiplier for that named profile and DE1, across shots, recipe edits, profile changes and restart. Manual shots do not train automatic estimates. **Auto** starts from the multiplier the machine shows at that moment and learns from subsequent usable shots: selecting Auto sends no calibration command and recalls neither an older Automatic value, the machine baseline nor the saved Manual value. Auto can be selected again while already in Automatic to start from the current reading.

A saved Manual value is remembered independently of the current mode, so Manual **2.000** stays visible and offered while Automatic runs at **×1.000**, and **Use manual** applies it again through the guarded path. Unsaved text is never saved, and selecting Auto never overwrites the remembered value. Returning to a profile still recalls its last effective Automatic calibration or its active Manual choice.

Manual choices currently use the exact profile title per DE1. Same-named profiles share a choice; renaming requires choosing again. Automatic estimates use the exact title/version/steps. [Issue #1](https://github.com/tadelv/decaid-de1-autocal-plugin/issues/1) tracks stronger profile matching.

## Recovering a paused change (2.0.2, unchanged in 2.0.3)

When a change is paused, **Check again** reviews the current machine, profile, state and saved request. The panel shows the profile's mode, the multiplier that was requested and the value the machine reports now; they may differ. After independently confirming the previous change has finished, the operator can keep the current value as it is:

- **An Auto profile stays Auto.** The checked value becomes that profile's new starting point and expected machine value. Recovery itself sends **no calibration command**, does not recall the old requested value and does not mark the old attempt as verified. Only a genuinely new shot after recovery can teach Auto again; a delayed pre-recovery shot is excluded.
- **A Manual profile stays Manual.** Its saved manual value is replaced with the checked value, and its automatic record is kept for a later explicit Auto.

Other profiles, machine values and histories are preserved; the ledger is not reset. The confirmation is supervised policy, not proof that the host queue is empty: a matching number cannot prove an earlier queued command finished, and clearing the paused record cannot cancel a command already sent. Selecting Auto does not clear a paused change; recovery still requires its explicit confirmation.

## Installation and settings

[Decaid installation instructions](https://decentespresso.com/docs/how_to_install_skins_or_plugins_on_decaid). Use the release's **`auto-flow-cal-v2.0.3.zip`**, or the checked-in `auto-flow-cal.reaplugin/` directory. It contains the complete built plugin; copying `src/plugin.js` alone does not work. The normal public GitHub installation route uses the latest published release.

| Setting | Fresh default | Meaning |
|---|---|---|
| Enable calibration changes | Off | Allow automatic and manual changes on the selected DE1 |
| DE1 serial number | Empty | Exact machine pin; blank prevents changes |

Only traditional DE1 models are supported, never Bengle. The host must acknowledge matching `storageWrite` events and provide `events.machine` / `stateUpdate`. Missing identity, storage acknowledgement, scale evidence or valid measurements fails closed. A 2.0.2 ledger loads unchanged: the remembered Manual value is derived from its active Manual choice and is stored additively, with no new key or required schema change.

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

`status` reads memory only. `view` independently reads the selected machine; while an intent is held, it also reviews current workflow/state for recovery. `skin` and `ui` render cached data and declarations. These GETs never clear an intent or send calibration commands. Explicit POST `mode` selects Manual/Auto — Automatic rebases only that profile's starting value to the live reading and sends nothing, while Manual keeps its guarded application — and POST `recover` requires an operator-confirmed review and keeps the checked value in the profile's own mode without resending it. A differing read-back needs the explicit `action: 'reload_current'` discriminator; an older matching-only request without it keeps the 2.0.1 Manual behavior and fails clearly on a mismatch. Both preserve target, context, idle and persistence guards.

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

Release tags must match the manifest (`v2.0.3`). The workflow prepares **drafts only**; publication requires operator approval. [2.0.3 release notes and validation limits](docs/RELEASE-2.0.3.md); the [2.0.2 recovery notes](docs/RELEASE-2.0.2.md) and the earlier [2.0.1 hotfix notes](docs/RELEASE-2.0.1.md) remain historical. [Recorded supervised-trial evidence](docs/trial-results.md).

The earlier Design and Implementation Plan describe 1.x and remain historical references. The current behavior and limitations are documented here, in the UI notes and regression tests.
