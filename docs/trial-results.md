# Supervised calibration trials — installation and replacement

**Current:** the original **`auto-flow-cal.reaplugin` 2.0.0** is installed and ready on p85pro. The temporary `-updater` plugin is removed; calibration stayed **0.835**. The earlier sections below are historical trial evidence, not instructions to reinstall that separate plugin. See the final section for the original-ID replacement.

2026-11-26. Operator explicitly approved installation and enabling on the verified physical DE1Pro, with the host queued-write gap deferred. The serial is pinned in settings; raw identity, address and shot captures remain in ignored local artifacts.

## Initial 0.2.0 installation state

| Item | Result |
|---|---|
| Trial updater | `auto-flow-cal-updater.reaplugin` **0.2.0**, loaded, Enabled true, exact target serial pinned |
| Legacy automatic writer | **1.4.0**, unloaded, autoload false |
| Observe-only plugin | **0.1.1**, loaded and unchanged |
| Calibration before / after arming | **1.130 / 1.130** |
| Runtime | ready true, hold null, pending null, unresolved intent null |
| Learning / application at activation | zero consumed shots, no applied decisions; only `armed_for_new_shots` |

The updater was first installed and loaded with its calibration policy **disabled**. Runtime version, disabled state, serial pin and unchanged calibration were checked before enabling its policy. Arming completed with a matching native host storage acknowledgement.

The operator pulled another shot during preflight, before installation. The final history read and runtime high-water marker confirm that this already-saved shot is fenced out of live learning. It was not applied retroactively. The earlier offline estimate for a preceding Baseline shot likewise was not installed as a calibration value.

## First post-enable shot — update verified

The next saved **Baseline • Ultra Low Contact Dos Bengelitos** shot recorded historical calibration **1.130**. Its final-step v2 fit used **5.5 seconds** of supported evidence, with no numerical warning flags.

| Observation | Value |
|---|---:|
| Absolute fitted target | 0.955631 |
| Rounded command | **0.956** |
| Independently read actual calibration | **0.956** |
| Change from previous setting | **−0.174** |

The runtime reported one `applied_verified` decision for that shot. It remains ready, with no hold, deferred work or unresolved intent. The change exceeded the old 0.100 cap and completed in one update. This confirms live application/read-back, **not** physical accuracy or convergence. The saved shot's original graph remains recorded at 1.130; the new multiplier affects subsequent shots.

Private evidence: `.pi/updater-trial/check-<shot-id>.json` contains the exact persisted shot, updater status and independent calibration read.

## Second post-enable shot — capture chain and update verified

The next Baseline shot correctly recorded historical calibration **0.956**, matching the preceding verified machine setting. It belongs to the same tracked extraction program. The fitter used **4.5 seconds** of final-step evidence, with no numerical warning flags, and produced target **0.881344**. The updater applied **0.881**, independently read back from the machine.

The durable ledger contains exactly two consumed live shots and one tracked program, with expected/applied value 0.881. There is no hold, pending work or unresolved intent. Calibration history is now **1.130 → 0.956 → 0.881**.

This verifies that an applied multiplier reaches the following shot's captured metadata and is used for subsequent normalization. The relative fitted adjustment decreased from approximately −15.4% to −7.8% on the respective shots. That is encouraging but not a controlled comparison: their evidence windows and extraction conditions are not identical, and it does not prove physical accuracy or convergence.

### Operator visual feedback

The operator reports that the weight-flow and water-flow lines on the second shot look **much closer than before**. That shot was pulled at **0.956**. This is direct qualitative evidence for the stated chart-alignment goal. The subsequently applied **0.881** has not yet been assessed in another shot; no extra shot solely for testing or updater change is requested.

## Scope and next observation

Full gain, no per-shot cap; overall bounds, resolution, deadband and measurement eligibility remain. No direct machine-calibration command was issued during deployment, and the updater made no startup calibration write. Its calibration-write/read-back path has now succeeded twice, including one verified next-shot metadata transition. Closer chart alignment at 0.956 is now operator-confirmed; broad convergence across changing conditions is not established.

Next: a later normal shot on the unchanged program should record **0.881**, unless a profile/manual change intervenes. Observe its actual chart alignment without changing the updater. Inspect each terminal decision and calibration before another shot. Same-profile follow-up is a verification scenario, not a new eligibility restriction on future learning.

Queued-write protection remains **best-effort**, not atomic. Per-profile manual override and Streamline UI were subsequently deployed in 0.4.0, as recorded below. Keep the trial supervised, avoid concurrent calibration edits and wait for a terminal decision before the next shot.

The trial is enabled with autoload true. Disable it at the end of supervised testing; disabling does not restore calibration or cancel an already dispatched command. No unrelated plugin configuration, shot history or existing app data was reset.

## Later operator feedback and staged UI

The operator reports another saved p85pro shot whose weight-flow/water-flow lines **almost completely align**. During the subsequent manual-UI work, hostname status retrieval failed and the last provided IP returned `EHOSTUNREACH`, so this pass did not independently retrieve that shot, its captured coefficient or the following applied value. The earlier 0.881-unassessed note above describes the state before this feedback, not a retraction of the operator's observation.

0.4.0 adds persistent per-profile Manual/Auto controls. Controller/browser regressions and M50Mini light/dark fixture interaction passed; the fixture's 2.000 was **not a real-machine calibration write**. No p85pro update was made during UI development; the later explicitly approved deployment is recorded below.

## Third post-enable shot and 0.4.0 upgrade — verified

On the operator's later **deploy** instruction, the known curl client reached the approved host and rechecked target identity and safe between-shot state. The still-running 0.2.0 ledger showed the third Baseline shot recorded **0.881**, fitted **0.834666**, and completed an `applied_verified` update to **0.835**. Support was **8.0 seconds**, with no fit warnings. A fresh independent calibration API read confirmed **0.835**, accounting for the operator's latest reported shot. The historical progression is **1.130 → 0.956 → 0.881 → 0.835**; the next shot at 0.835 is not yet observed here.

Before replacement, the live schema-1 ledger, configuration, status, workflow and plugin metadata were saved. A single source PUT upgraded the loaded updater to **0.4.0** while preserving Enabled true, the existing serial pin and autoload true. After reload:

| Check | Result |
|---|---|
| Runtime | 0.4.0, ready true; no hold, pending work or unresolved intent |
| Calibration before / after | **0.835 / 0.835** |
| Persistence | Schema **1 → 2**, all **three** consumed IDs and saved automatic values preserved |
| Manual choices | New override maps empty; no simulated M50 value transferred |
| Other plugins / startup | Legacy writer still unloaded/autoload false; other metadata unchanged; only `armed_for_new_shots` |

The current profile remained unchanged. Read-only live `view`, `skin` and `ui` endpoints returned the correct 0.835 Auto value and current UI, without changing the ledger. The helper's mutation allowlist contained only updater source replacement and updater disable for a verified failed rollout; it contained **no calibration or mode write route**. The deployment performed no startup training, direct calibration command or manual test write.

The machine was sleeping safely between shots and was not woken by the deployment. All three coordinating lanes were explicitly released afterward. The M50 preview was left untouched for the operator. **Manual hardware changes still need separate approval/testing**; the queued-write gap and accepted keyboard-resize limitation remain. See [current UI and remaining validation](UI.md).

## Private evidence

Initial installation evidence: `.pi/updater-build/` (ignored).

- `installed-source-copy.json`: exact submitted payload (local plugin-source SHA-256 `beaf350e9e5483f78bd9d01c5fb12227a68fc992f8366aa17408b313421e0e46`). The API accepted the upload and reported the expected runtime version; no remote source-byte retrieval endpoint was used.
- `existing-plugin-backup.json`, `install-disabled-before.json`, `installed-disabled.json`: preflight settings and disabled-stage evidence.
- `enable-before.json`, `activation-confirmed.json`, `final-live-state.json`: activation and independent final reads.
- `install-live-trial.cjs`: initial-install helper only; do not run it against an already-enabled deployment.

0.4.0 rollout evidence: `.pi/updater-rollout/2026-11-26T19-40-26-723Z/`. `before.json` contains the exact live raw ledger and state; `previous-submitted-source.json` preserves the known earlier source payload (not newly retrieved remote bytes), `candidate.json` the submitted 0.4.0 payload, and `verified.json` the migration/configuration/read-only UI and unchanged-calibration checks. `backup-notes.json` records source hashes and provenance. The new bounded helper is `.pi/updater-rollout/upgrade.cjs`.

## Original-ID 2.0.0 replacement — verified 2026-11-27

The operator clarified that this work must upgrade the original plugin, waived settings migration and explicitly requested removal of the temporary updater from p85pro. Fresh identity and between-shot/sleeping-state checks passed; the active coordinating lane acknowledged hands-off and was explicitly released after verification.

The live original 1.4.0 state, temporary 0.4.0 state/configuration/status, known submitted source, workflow, plugin metadata and actual calibration were backed up first. The original `calibration-v2` key was confirmed unused. The temporary updater was disabled, the original plugin source replaced with **2.0.0**, its serial/enable settings configured deliberately and its runtime enabled. Only after it was independently verified ready was the temporary updater uninstalled.

| Check | Result |
|---|---|
| Product / identity | **Auto Flow Calibration 2.0.0**, original `auto-flow-cal.reaplugin` |
| Runtime / ownership | Loaded, ready, enabled, pinned; autoload true; temporary updater absent |
| Actual multiplier | **0.835 before and after**, no startup or direct calibration command |
| Persistence | New `calibration-v2` baseline/expected **0.835**; empty consumed/program/manual maps; old history fenced; original legacy `state` untouched |
| Other state | Active profile and all unrelated plugin metadata/loaded/autoload flags unchanged; no hold/pending/unresolved intent |

The real `view`, `skin` and `ui` returned the correct Auto value and editable-ready controls. Reading them left the new ledger unchanged. No manual value was sent. Earlier three-shot learning records and preferences were **backed up, not migrated**, as requested. No app reset, profile change, firmware change, machine wake or M50 operation was performed. Real manual/profile-switch/restart validation and publication remain separate gates.

Ignored evidence: `.pi/original-v2-rollout/2026-11-27T06-33-40-429Z/` (`before.json`, `candidate.json`, known previous source copies, disable/source/settings/enable/removal responses, `original-ready-before-removal.json`, `verified.json`, `live-ui.html`). The helper is `.pi/original-v2-rollout/install.cjs`; its allowlist contains only the two named plugins' management routes, never calibration, workflow or KV mutation routes. Do not rerun a partially completed install blindly.
