# A clearer way out of a paused calibration

**Auto Flow Calibration 2.0.1** fixes a reproduced profile-switch failure and adds a guarded recovery action for matching unfinished changes from 2.0.0.

- **Old profile events no longer choose the wrong profile.** The plugin checks Decaid's current workflow instead of trusting a delayed event.
- **Check again now reviews the paused change.** It refreshes the actual profile, machine state and read-back—not just the number on screen.
- **Keep a checked value without sending it again.** If the machine, profile and value match the pending change, you can confirm the earlier operation has finished and keep that value in **Manual**. Other profiles retain their choices; choose Auto later if wanted.
- **Failures explain what did not match.** More details distinguishes a changed profile/context, different value and busy machine.

**Still supervised:** wait for the previous change to finish before confirming recovery or starting a shot. If you cannot establish that it finished, leave the plugin disabled. A matching number by itself is not permission to resume.

<details>
<summary>Technical details — recovery, limits and validation</summary>

## Recovery from the reported 2.0.0 state

Update the existing `auto-flow-cal.reaplugin` plugin normally. Keep the existing serial setting and `calibration-v2` ledger; do not delete state, reset the app or resend the failed command. If the plugin was disabled, enable it only while the machine is idle: its unresolved intent still prevents normal calibration dispatch.

1. Select the profile belonging to the paused change and open the plugin panel.
2. Tap **Check again**. This is read-only; it refreshes the current target/profile/state and reviews the saved intent.
3. Recovery is offered only for the pinned supported DE1, an idle/between-shot state, the intended profile, and a read-back equal to the saved command. A known recorded model must match too. A stale, busy, wrong-machine/profile or mismatching-value case stays paused.
4. Only after independently checking the value and establishing that the previous operation has finished, tick the confirmation and choose **Keep ×… in Manual**. If uncertain, leave the plugin disabled and contact support.
5. Recovery persists a new, operator-confirmed Manual choice for the current profile. It does not send a calibration command or falsely mark the old estimate as a verified automatic application. Other profile choices and automatic records are retained. Auto remains an explicit later choice.

The operator's confirmation is essential: the host still does not provide atomic execution-time preconditions or a command receipt proving that every queued operation has settled. This patch does not solve that host-side gap. It does not offer an unconditional reset/adopt-any-value shortcut.

## State and diagnostic changes

The plugin ID, storage key, schema version, serial pin, master enable, estimator and bounds remain unchanged. Old 2.0.0 intents without a model field can be reviewed; malformed intents fail closed. Newly created intents record the model and retain structured failed-check reasons with observed/expected context when verification fails.

Workflow events are invalidations: the controller reads the current workflow before changing its profile/generation. Older concurrent reads cannot replace newer context. Real changes still invalidate in-flight work and retain the safety hold. While paused, current-profile reporting can refresh without granting write authority.

The declared POST `recover` endpoint requires a fresh review context, exact profile/value, an explicit settled-operation confirmation and fresh repeated identity/state checks. Preparation retains the old intent through storage acknowledgement. Persistence/context failures retain the hold, and the browser never retries a failed recovery automatically. The last recovery retains the prior intent as an audit record with authority `operator_confirmed_manual`.

## Verification and limits

Regression coverage includes the reproduced delayed-event failure, a genuine mid-dispatch profile change, old-intent review, explicit recovery with zero calibration POSTs, preservation of other profile/manual/automatic records, stale requests, wrong machines/models/profiles/values, busy state, missing acknowledgement, preparation/final-commit failures and late context changes. Browser tests cover mandatory consent, consent invalidation and no automatic retry. A compiled-controller/actual-page-client integration check uses simulated DOM, transport and storage and verifies **zero calibration commands** during recovery.

All **168 local tests** pass with the optional real Streamline parser checkout supplied; CI skips that parser case when its checkout is absent. Syntax and generated-source consistency checks pass. The actual compiled controller and page client were also exercised in an isolated real Chrome browser in light and dark themes, using mocked hardware/storage: recovery required consent, retained the checked value in Manual and issued **zero calibration commands**.

On **M50Mini**, the actual compiled controller also ran in Decaid's existing Android debug installation (build `f382e08d`, as identified by the owning test lane). Android Chrome touch tests passed in light and dark: read-only review → explicit consent → Manual ×2.000, pending intent cleared, the other profile's Manual choice preserved and **zero calibration command attempts**. Machine responses and storage acknowledgements were simulated inside the plugin; this does not validate native on-disk ledger durability. Bluetooth stayed off throughout. Only the new owned test fixture was removed; existing plugins and the operator's preview/settings/state were checked unchanged. The app was stopped before restoring its original Bluetooth state.

**Not validated:** Streamline's embedded overlay could not be exercised in this offline, non-simulated debug environment; returning to the skin left an empty WebView. The Android UI check used Chrome against the native Decaid HTTP/plugin runtime instead. No customer device access, physical DE1 recovery, emulator connection or tablet calibration command was performed. The original customer's exact event timeline remains unconfirmed.

The host queued-write timing gap, exact-name manual matching and Android keyboard-resize workaround remain. Removal of manual serial entry/settings cleanup is separate future work in [#3](https://github.com/tadelv/decaid-de1-autocal-plugin/issues/3), not part of this hotfix. The report motivating the matching reproduction is [dcamp comment 181043](https://decentespresso.com/dcamp/general-forum/auto-flow-calibration-plugin-for-decaid/181043).

</details>
