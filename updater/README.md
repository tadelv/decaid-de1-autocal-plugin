# Full-update calibrator — supervised trial

**0.4.0 is installed, enabled and ready for the operator-approved supervised trial on p85pro. Not an unattended release.** Initial 0.2.0 arming left calibration at **1.130**; the later 0.4.0 upgrade left the then-current **0.835** unchanged. Target pinning, storage acknowledgement and ledger preservation are verified. [Trial record](trial-results.md).

The live `auto-flow-cal-updater.reaplugin` now includes the [Brew-tile multiplier and per-profile Manual/Auto controls](UI.md). Read-only live UI endpoints were verified after the upgrade; real manual test writes remain untested. It neither replaces nor enables the legacy writer or observe-only plugin. Keep the legacy writer disabled throughout the trial.

## Behavior

- Each genuinely new usable saved shot supplies the next **absolute multiplier directly**: 100% gain, **no per-shot movement cap**. Overall bounds remain **0.35–2.0**, machine resolution **0.001**, and learning-write deadband **0.010**. Short yield, changed dose/grind, pressure variation and disagreement are not independent rejection reasons.
- Uses versioned **`fixed_zero_lag_v2`** final-step fitting. Primary evidence needs only zero-lag support. Optional lag diagnostics use their own common-supported subset and may be unavailable without rejecting the primary fit. Their warnings remain visible, not an extra agreement gate. V1 observer/offline comparison behavior is retained separately.
- New evidence is keyed to captured machine identity and canonical profile title/version/steps. Targets are persisted before application; only an exact successful read-back establishes a saved applied value. Selecting a different program recalls its verified value, or restores this machine's baseline if none exists, without the old learning cap. An unapplied estimate cannot become recall authority by toggling profiles. A failed fit does not erase a working value or request restoration.
- New dispatch checks serial/model, active program/generation, current calibration and between-shot state. Detected external calibration edits pause automatic operation. Busy work retains only the latest authorized target; machine-state events can retry its preconditions, **not repeatedly POST or step toward it**.
- Storage writes require the host's matching `storageWrite` acknowledgement. Consumed IDs/order, fitted targets and pre-dispatch intent are durable. Duplicates, older shots, startup history and diagnostic replay cannot train again. A failed/ambiguous POST, read-back or final storage commit holds further application; restart never blindly resends an unresolved intent.

Program `target` in status is the last fitted estimate; it is not an independent write authorization. `applied` is the saved verified setting. The current runtime `pending` record authorizes a deferred attempt. In 0.4.0, an explicit persistent manual selection also authorizes restoration on safe activation of that named profile.

### Manual/Auto behavior

Set **Manual ×2.000** for a profile to keep its multiplier fixed across shots, profile switches and restart. Other profiles retain independent choices. Manual shots do not change saved automatic estimates. **Auto** restores the current recipe's last verified automatic value or baseline and learns only from subsequent shots. Accepted manual values use the existing 0.350–2.000 bounds and 0.001 resolution.

Current workflow JSON exposes no stable profile-record ID, so manual choices are keyed by exact profile title per DE1; same-named profiles share them, renaming needs a new selection, and recipe/dose/grind edits do not silently re-enable Auto. Automatic learning keeps its existing exact-program key. Name-based matching is accepted for the current trial; [issue #1](https://github.com/tadelv/decaid-de1-autocal-plugin/issues/1) tracks matching against Decaid's content-hash/record/lineage model. See [UI, persistence migration and rollout constraints](UI.md).

## Explicitly deferred

**The user accepted proceeding with a supervised trial while the host queued-write gap is deferred.** GET checks and the subsequent POST are not atomic. A shot or manual actor can change state after the last check but before the host executes the write. A regression test documents this interleaving; detecting it afterward does not prevent it.

Host execution-time guards remain deferred. Persistent per-profile override and its UI are installed in live 0.4.0, but real manual hardware writes still await an approved test. Existing outside edits are detected only through best-effort reads; that detection is distinct from an explicit saved Manual selection. Disable/unload prevents new dispatch but cannot cancel a command already submitted to the host. It does not restore calibration automatically.

Do not edit calibration, switch machines or start another shot while an update is pending. If a command outcome is unresolved, stop the trial and reconcile the host/machine outcome before resuming; do not clear the intent or blindly retry. The consumed-ID ledger grows with this limited trial; ordering-safe compaction is deferred before long-term deployment.

## Build

```sh
npm test
npm run check
npm run build:updater -- .pi/updater-manual-build
```

Generated artifacts (ignored by git):

- `.pi/updater-manual-build/source.json` — 0.4.0 install/source payload.
- `.pi/updater-manual-build/auto-flow-cal-updater.reaplugin/` — bundle and manifest.

0.4.0 migrates schema-1 state to schema 2, preserving previous records and adding a separate override map. Older writers fail closed on schema 2. Back up the live ledger before rollout; source-only downgrade is not a safe rollback.

The existing `.pi/updater-build/installed-source-copy.json` preserves the previously submitted 0.2.0 payload; do not overwrite it or reinstall it over the live schema-2 updater.

Requires a host that acknowledges storage writes by emitting `storageWrite` with the submitted state payload, including its `writeToken`, and exposes `events.machine` / `stateUpdate`. Missing acknowledgement fails closed before dispatch.

## Supervised trial preflight

1. Obtain the tablet's reachable address and confirm the current DE1 serial with the operator. Confirm authorization for calibration changes on that specific target; do not assume an emulator or a physical machine is interchangeable.
2. Confirm the original writer is disabled and the machine is idle. Inspect current calibration before installing; preserve existing app data.
3. Install the separate trial build with its default `Enabled: false`. Confirm status and target identity before opting in.
4. Set `ExpectedSerial` to the verified serial and explicitly set `Enabled: true`, then reload while idle. Initial arming adopts the verified current multiplier and fences old history without a calibration write when no manual selection is saved. On later startup a previously authorized active manual setting can be restored; conflicting outside edits or unresolved intents block it. Events arriving before arming are not live evidence.
5. Pull normal shots one at a time. Wait for `applied_verified`, `no_write_needed`, or an explicit hold before the next shot. Capture actual multiplier, fitted value, warnings and the next shot's recorded historical multiplier. Stop if behavior is unexpected. This is prospective validation, not proof of convergence from the historical replay.

The earlier 0.2.0 build adopted a detected outside value on reload; no version bypasses an unresolved write intent. Live 0.4.0 preserves a conflicting active manual selection's hold across restart. Its explicit POST `mode` control selects Manual or Auto; read-only endpoints cannot apply/reset/enable anything. The UI cannot bypass the master enable or serial pin.

Read-only status:

```text
GET /api/v1/plugins/auto-flow-cal-updater.reaplugin/status
```

It reports enabled/readiness/hold state, deferred work, unresolved intent, per-program estimates and verified values, plus the last 20 decisions. Reading status causes no API requests, evaluation, storage writes or calibration changes.

## Verification

The original live build passed **125 tests**, including 27 updater cases covering full updates, the zero-lag eligibility fix, captured fixtures, exact recall/baseline fallback, stale work, busy coalescing, duplicate/order/restart fencing, machine pinning, storage acknowledgement/failure boundaries and the known queued-write race. Syntax checks and bundle generation pass. The installed UI/manual build passes **153 tests**, including the real Streamline parser when its checkout is supplied; see [UI verification](UI.md).

Offline re-fitting of the same **42 cached p85pro shots** produced **34 v2 fits**, versus 33 with v1; five still lack final-step evidence and three lack scale data. The largest primary-estimate change on shots fitting both versions was approximately **0.043**, because v2 uses additional zero-lag-supported blocks. This is a new estimator version, not a silent replay of v1 candidates. Increased fit count does not establish accuracy. Private results are at `.pi/updater-validation/history-fits.json`.

The inspected local Decaid source captures `workflow.machine.flowCalibration` from the device cache (`de1_state_manager.dart::_captureMachineSnapshot`), and the device setter updates that cache to the effective multiplier after a successful write. The first follow-up shot did record **0.956**, matching the preceding verified update. This validates one installed-host capture transition, not all possible race cases.

The build itself performed no tablet writes. Subsequent operator-approved deployment installed the separate plugin, pinned the verified DE1 serial and enabled the trial. Startup/status/storage acknowledgement work on the installed host. No calibration write was triggered during installation/arming. The first two post-enable shots produced verified **1.130 → 0.956 → 0.881** updates, independently read from the machine. The second shot correctly recorded 0.956. The operator reports much closer flow-line alignment on the second shot, pulled at 0.956. The operator subsequently reported another saved shot with almost completely aligned chart lines. During the approved rollout, its runtime decision and the actual machine read confirmed **0.881 → 0.835**, with eight seconds of fit support and no warnings. The 0.4.0 upgrade preserved all three consumed-shot records and their automatic value; no startup calibration command or manual test write occurred. The read-only UI returned 0.835. This supports the observed progression, not a proof of broad convergence.

**The enabled trial autoloads on Decaid restart until disabled.** At the end of supervised testing, disable this plugin through Decaid's plugin settings or ask the supervising session to stop it. The management operation is `POST /api/v1/plugins/auto-flow-cal-updater.reaplugin/disable`. Disabling does not reset calibration, and cannot cancel a previously dispatched write.
