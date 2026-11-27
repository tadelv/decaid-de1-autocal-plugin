# Auto Flow Calibration 2.0.0

**Operator-approved release for supervised use.** This upgrades the original **`auto-flow-cal.reaplugin`**; it is not a separate updater product. Calibration changes still require the precautions below; this release does not certify unattended operation.

## Changes

- Replace the overly restrictive two-shot/triple-flat estimator with usable final-step curve fitting from each new shot. Zero-lag evidence determines the multiplier; optional lag diagnostics do not control primary eligibility.
- Use the full absolute estimate, without a per-shot movement cap. Bounds remain 0.350–2.000, machine resolution 0.001 and automatic-learning deadband 0.010.
- Show the machine multiplier under Brew, with a light/dark overlay, Settings Open action and persistent per-profile Manual/Auto choices.
- Update the original manifest for Decaid's API/permission rules: original ID and name, version **2.0.0**, `emit`, `events.machine`, HTTP display/mode endpoints and the `changed` WebSocket.

## Upgrade and installation

Install **`auto-flow-cal-v2.0.0.zip`**. Its single plugin directory keeps the original ID, so Decaid's existing-plugin update identity check succeeds. The manifest version matches tag `v2.0.0`, above the previous 1.4.0 release. The archive contains only the manifest and fully compiled plugin, no local state, machine identity pin or raw shot exports.

The operator explicitly waived old-settings migration. Version 2 uses a fresh **`calibration-v2`** storage key; the old original-plugin `state` entry is preserved but unused. Temporary updater preferences/history are not imported. Pin the intended DE1 serial and enable deliberately; fresh defaults are off/empty. First arming adopts the live multiplier without a startup calibration write and fences old history from learning.

For the operator's existing test tablet, disable the temporary **`auto-flow-cal-updater.reaplugin`** before enabling the original-ID build. Remove the temporary plugin only after the original is verified ready. Never run both writers. State backups remain available; installing older source is not a safe rollback.

## Evidence

The preceding temporary trial verified three automatic applications **1.130 → 0.956 → 0.881 → 0.835** and operator-observed closer chart alignment. Its 0.4.0 UI and control implementation is consolidated here under the original identity, not replaced with another algorithm. The new versioned storage intentionally starts fresh.

Regression coverage includes the actual checked-in compiled package, runtime/manifest identity/version, Decaid permissions/endpoints, versioned-storage isolation, missing-pin protection, estimator fixtures, Manual/Auto behavior, stale/busy contexts, persistence acknowledgement, ambiguous outcomes and read-only UI. The real Streamline parser case is optional locally and skipped on CI without its checkout. Local validation passes **156 tests** with that checkout supplied; syntax and exact generated-source checks pass.

The explicitly approved p85pro replacement is verified: the temporary updater was disabled first, original-ID **2.0.0** loaded and armed on the pinned DE1 with the actual multiplier unchanged at **0.835**, and the temporary plugin was then removed. The original legacy `state` entry was unchanged, while `calibration-v2` started fresh with current 0.835 baseline, no imported automatic values/manual choices and old history fenced. Other plugins and the active profile were unchanged. Real read-only view/skin/UI checks passed; no startup application or manual test command was issued. This deployment result is not a real manual-write validation.

## Release approval and hardware test scope

On **2026-11-27**, the operator accepted the p85pro UI, pulled a normal shot, reported that it worked well and approved release. Independent read-only inspection confirmed that the original 2.0.0 runtime consumed that new shot once in Auto mode, with captured calibration **0.835** and a fitted target **0.827224** from **5 seconds** of final-step evidence, without warnings.

The rounded target differs from 0.835 by **0.008**, below the **0.010** automatic-learning deadband. The terminal result was **`no_write_needed`**: calibration correctly stayed **0.835**, with no hold, pending work or unresolved intent. This verifies processing and stable no-change behavior, not a new physical calibration write or universal convergence.

Real manual-value application and real-device Manual/profile-switch/restart behavior have not been independently confirmed. They retain regression/fixture coverage and remain follow-up validation; approval of this release is not a claim that those hardware scenarios passed. This document authorizes no additional agent-driven machine commands.

## Known limits

- **Supervised only:** host queued-write preconditions are not atomic. A shot start or outside edit can race final checks and execution. Do not change calibration or start another shot while an update is pending. Disable cannot cancel submitted commands or restore calibration.
- Manual matching uses the exact profile title per DE1. Same-named profiles share a choice; renaming needs a new selection. [Issue #1](https://github.com/tadelv/decaid-de1-autocal-plugin/issues/1) tracks stronger identity/lineage matching.
- Closing the Android keyboard can leave the overlay too small until scrolled; accepted for the first version.
- No automatic migration or downgrade recovery. Never clear an unresolved intent or blindly resend a command. Real manual hardware validation remains pending.

See [README](../README.md), [UI notes](UI.md) and [trial evidence](trial-results.md).
