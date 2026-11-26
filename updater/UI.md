# Per-profile calibration UI — 0.4.0

**Installed and ready on p85pro for the operator-approved supervised trial.** The 0.2.0 → 0.4.0 upgrade preserved the actual **0.835** multiplier, all three consumed-shot records, saved automatic values and configuration. This adds persistent Manual/Auto selection; it is not an unattended release. No agent-driven manual test value has been written to the real machine.

## Use

1. Select the desired profile and tap the multiplier under **Brew**.
2. Enter a value such as **2.000** and tap **Use manual**. The accepted range is **0.350–2.000**, at most three decimal places. This changes the machine's estimation multiplier, not a flow target in mL/s.
3. Tap **Auto** to restore that recipe's last verified automatic value, or the machine baseline if none exists. Only subsequent new shots can teach it again.

Manual shots cannot change the saved multiplier or contaminate the saved automatic estimate. Selecting another profile recalls its own selection; returning restores the manual value. The setting survives restart. Dose, grind, version and recipe-step edits do not silently return a named profile to Auto.

**Accepted temporary matching:** Decaid does have content-based profile IDs. Its profile hash changes when hash-relevant recipe content changes; metadata has separate hashes. Current workflow JSON embeds profile content, not the selected record's hash/parent metadata (`Profile.toJson`). For this trial the operator accepted matching the exact **profile title on the pinned DE1**. [Follow-up #1](https://github.com/tadelv/decaid-de1-autocal-plugin/issues/1) investigates content hashes, record associations, lineage and safe migration rather than treating a content hash as an immutable identity. Same-named profiles share the override; renaming requires a new selection. Automatic evidence remains scoped to the exact title/version/steps extraction program, so a changed recipe does not inherit stale learned authority. The limitation is also disclosed under More details.

## Display

The Brew `tile-line` is compact: `×0.881` for Auto or `M×2.000` for Manual. This is the **last-read machine value**, never the desired override or fitted target. If a saved manual value awaits safe application, the card says it is waiting and keeps the observed value separate. The tooltip/card identify the last-read time; an external actor can change calibration after that observation.

The light/dark overlay identifies the active profile, shows the current reading and mode, and offers Auto, a manual-value field and **Use manual**. Fit estimates, last applied value, evidence, warnings and trial limitations are collapsed under **More details**. **Check again**/Close remain available when details expand. Successful submission blurs the input and returns the card to the top.

The wording pass replaces write/fit/guard terminology with short descriptions: **Flow multiplier on your machine**, **Manual — keep ×2.000**, **Check again** and **More details**. Pauses explain what to check; uncertain requests say the change was not confirmed and never claim it failed without changing the machine. Raw identifiers remain under **Support code** for troubleshooting, not in the main status. Automatic/start-value restoration, idle waits and same-name sharing remain explicit.

The page uses Streamline ready/size/close messages, fitted overlay presentation and close-on-shot. Text-node rendering and escaped embedded JSON prevent remote strings becoming HTML. Framing permits self plus the sanitized requesting skin origin. No Streamline fork or new dependency is required.

## Read/write boundaries

| Endpoint | Behavior |
|---|---|
| `status` | Memory-only controller status, active profile, mode and current edit-context token |
| `skin` | Memory-only surface and Settings Open action |
| `ui` | Immediate HTML from memory; opening cannot change calibration |
| `view` | Read-only fresh `machine/info → machine/calibration → machine/info`, verifying the pinned identity |
| `mode` | **POST only**: explicit Manual/Auto selection for the displayed profile/context |
| `changed` | Existing WebSocket transport; emits only `{what:"skin"}` |

`skin`, `ui` and `view` reject non-GET methods. Their reads never evaluate shots, write storage, alter baseline/expected ownership, clear a hold or authorize a machine command. UI refresh displays an outside edit without silently adopting it. Late reads cannot overwrite newer writer observations; failed identity/read checks clear the display.

The open card polls every five seconds, without overlapping reads, and cleans up on exit. A closed card adds no machine polling. Writer observations and ordinary Streamline push/minute/focus updates refresh the cached line.

`mode` accepts a numeric grid-aligned value, profile-program key and edit-context token from the displayed model. The token protects against stale edits; it is not authentication. It serializes with controller work, checks fresh pinned identity/program/state/ownership, acknowledges persistence before dispatch, and reuses the existing intent/write/read-back path. Busy initial requests, stale profiles/tokens, concurrent edits, disabled/unready/held actors and invalid values cannot authorize a write. A successful preference save can outlive a later profile change or busy transition, but cannot write to that other context. Its application waits for the appropriate safe activation.

The browser binds a draft to its original context; polling cannot silently rebind an edited value to another profile. Failed/uncertain submissions are not automatically retried and require explicit refresh before further editing. Closing the window is **not** cancellation of an already accepted command.

## Safety and persistence

The master **Enable calibration changes** setting remains off by default and controls both Manual and Auto writes. The UI cannot enable it or configure the serial pin. Controls require a ready, verified actor. Unresolved command outcomes stay held, including across restart; neither Auto nor Manual clears an intent. An external edit conflicting with an active saved manual value is not overwritten on restart.

**The host execution-time queued-write gap remains:** the last GET checks and later POST are not atomic. A new shot or external actor can intervene after the final check. This candidate does not solve that race. Do not start another shot or edit calibration while application is pending, and do not use this trial unattended.

Persistence is upgraded to **schema 2**. Existing schema-1 baselines, expected values, automatic records, consumed IDs/order and unresolved intent are preserved; each machine gains a separate title-keyed override map. The preserved 0.2/0.3 bundles were explicitly checked in a sandbox: both reject schema 2 before making any machine request, instead of silently ignoring Manual (`.pi/updater-manual-build/downgrade-check.json`). Back up source/settings/status/ledger before rollout. Do not attempt a blind source-only downgrade or erase an unresolved intent to make rollback load.

On a first upgrade without a saved manual setting, arming performs no calibration write. Later startup can restore an already-authorized active manual setting if its previous observed value still matches; a conflicting external value or unresolved intent blocks it.

## Build and verification

```sh
npm test
npm run check
npm run build:updater -- .pi/updater-manual-build
```

Supply `STREAMLINE_SOURCE=/path/to/streamline-js` to include the real parser contract check. Without it only that check is explicitly skipped; ordinary tests need neither a hidden path nor network access.

**153 tests pass** with the real Streamline parser at `41fd509`. Coverage includes profile switching/restart, recipe/dose/grind edits, manual-only profiles, explicit 1.000, independent automatic records, Auto history fencing, stale/concurrent forms, storage failures, late profile/unload events, external edits and ambiguous writes. Existing estimator/controller regressions remain intact. The explicit-1.000 check also retains the earlier calibration-parity lesson surfaced in Atuin thread `cc04a6a5`: 1.000 is a real manual value, not an Auto sentinel.

### Native M50Mini fixture validation

Native **Streamline 0.2.34** passed in light and dark: actual Android touch/keyboard entry of **2.000**, Manual display, return to Auto/0.881, disclosure and close. The initial card was **440 × 512 CSS pixels**, with all four buttons visible and no horizontal overflow. Android `adb screenrecord` captured the interaction. The automated run needed to wait for stable, on-screen controls after keyboard dismissal. A later operator check confirmed that the overlay can remain incorrectly sized until scrolled; this is a real preview layout limitation, not established as merely test-harness timing. Its cause is not yet diagnosed and no sizing fix was introduced.

Private artifacts: `.pi/ui-validation/m50-manual-{light,dark}-fixed-2.png`, `m50-manual-results.json`, `m50-manual-interaction.mp4`, `manual-cleanup.json` and `manual-dashboard-restored.json`.

The separately identified preview used in-memory fixture values and no machine callback, storage or calibration writer. Thus **no real machine was set to 2.000**; actual persistence/write safety is covered by controller regressions, not claimed as a hardware manual-write result. The preview, owned device recording and transports were removed afterward. Existing seven plugins, including version/source metadata, matched the fresh baseline. No APK, app reset or global theme change occurred. All three local lanes acknowledged the resource window and its explicit release; mesh discovery returned no peers, with local host verified as artemis.

The later wording-only pass is covered by model/browser regressions, including pause/error guidance and unchanged raw support fields. The operator subsequently requested installation for review: the latest-wording fixture preview is now **left installed and open on the M50Mini**, initially showing simulated Manual ×2.000 with the normal skin theme. Updated native light/dark captures (`m50-wording-light-manual.png`, `m50-wording-dark-manual.png`) confirm **Use manual**, **Check again**, **More details**, all four visible buttons and no horizontal overflow. This capture used the preview's own form/handler, not a real machine write. The other seven plugins match the fresh baseline, owned transports are removed, and the operator has the tablet for inspection. Evidence: `wording-capture-results.json` and `wording-review-handoff.json`. Do not remove the preview until the operator finishes reviewing it. No controller or matching behavior changed in the wording pass. Profile-hash research also builds on captured thread `20c33717`, checked against the current Decaid source linked from issue #1.

### Operator acceptance and known layout limitation

The operator tried the latest preview and approved it as good enough for the first version. After hiding the keyboard, the overlay did not resize correctly until they scrolled. **Deferred, non-blocking for this supervised first version:** correct resizing after keyboard dismissal. Scrolling is the observed workaround; neither an automatic-resize fix nor its cause has been verified. This UI acceptance alone did not authorize rollout. The operator subsequently gave an explicit **deploy** instruction; agent-driven manual test writes still require separate approval.

The earlier 0.3 read-only pass is preserved in `m50-ui-results.json` and its screenshots/video. During that earlier window, shot-upload/source metadata drift was recorded in `cleanup.json` and left alone; its cause was not established. The new manual-validation window had **no metadata drift**.

## Live rollout — verified 2026-11-26

After the operator explicitly approved deployment, hostname/Node-fetch access initially failed. The established curl deployment client reached the last operator-provided address and independently confirmed the approved DE1Pro identity. No network configuration was changed.

Preflight verified the machine between shots, ready 0.2.0 runtime, matching **0.835** calibration/expected value, no held/pending/unresolved work and the legacy writer disabled. The third saved shot's existing runtime record supplied target **0.834666** from captured **0.881**, followed by verified application of **0.835**; the current machine read agreed.

The exact live schema-1 ledger, settings/status, workflow and plugin metadata were backed up along with the known previously submitted source and new candidate. The API has no remote source-byte retrieval route; the old source backup is explicitly identified as the preserved earlier submission, not a newly fetched byte-for-byte image.

A single source PUT installed 0.4.0 without an enable/settings reset. Verification confirmed schema **2**, unchanged baseline/expected/programs/high-water/three consumed IDs, empty manual override maps, preserved Enabled/serial/autoload settings and unchanged other plugins. Only `armed_for_new_shots` occurred after reload: no startup learning or application. Independent calibration reads stayed **0.835**. Read-only live `view`, `skin` and `ui` returned the correct Auto value, editable-ready state and current non-preview UI; those reads did not alter the ledger.

Private evidence: `.pi/updater-rollout/2026-11-26T19-40-26-723Z/` (`before.json`, `previous-submitted-source.json`, `candidate.json`, `backup-notes.json`, `source-response.json`, `verified.json`, `live-ui.html`). The bounded helper is `.pi/updater-rollout/upgrade.cjs`; never repeat a started source submission blindly or run the first-install helper against this already-enabled trial. All three local lanes were explicitly released after verification. M50 operator preview remains untouched.

Remaining validation: the operator should check the actual p85pro overlay, then approve any agent-driven manual hardware test separately. Manual profile switching/restart/return-to-Auto have regression and fixture coverage, not a real manual-write result yet. Wait for terminal confirmation before another shot. The host queued-write gap and keyboard-resize workaround remain as documented above.
