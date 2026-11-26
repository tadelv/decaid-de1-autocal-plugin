# Flow Calibration updater 0.4.0 — supervised trial

**Draft only. Do not publish before the operator's planned 2026-11-27 testing and explicit release approval.** Keep this marked as a prerelease and do not replace the legacy plugin's Latest release.

## What changes

- Automatically bring the displayed weight-flow and water-flow lines closer using usable evidence from the final extraction step. No requirement for two agreeing shots or flat pressure/flow; usable changed-dose/grind and short-shot evidence can count.
- Apply the newest usable absolute estimate directly: 100% gain, no per-shot movement cap. Overall multiplier bounds remain 0.350–2.000, resolution 0.001 and learning deadband 0.010. Zero-lag fitting determines the primary result; lag exploration is diagnostic only.
- Show the actual last-read multiplier under Brew, with a light/dark overlay and a Settings Open action. Read-only UI endpoints do not change calibration.
- Choose Manual or Auto per named profile and DE1. Manual holds the chosen multiplier; Auto recalls the recipe's verified automatic value or baseline and learns from subsequent shots. Existing master enable, machine pinning, idle checks, persistence acknowledgement and write verification remain enforced.

## Separate from legacy 1.4.0

This is **`auto-flow-cal-updater.reaplugin`**, not an automatic upgrade of **`auto-flow-cal.reaplugin` 1.4.0**. Its version numbering is separate. The release tag is `v0.4.0`, matching the new manifest as Decaid requires. The archive contains only the compiled updater directory, manifest and plugin code; no observer, legacy writer, local ledger, identity pin, raw shots or device configuration is bundled.

Keep the older automatic writer disabled. Fresh installation defaults to calibration changes **off** and an empty serial pin. Before enabling, explicitly verify the intended DE1, keep it between shots, preserve its data and set the correct serial. The host must acknowledge matching storage writes and provide machine-state events. A draft cannot be installed through the normal public GitHub release route.

Upgrading a previous updater migrates persistence from schema 1 to 2 while keeping its ledger and adding manual-choice maps. **Back up the ledger first. Older updater source cannot safely read schema 2; source-only downgrade is not a rollback.**

## Evidence so far

- Local regression suite: **153 passing** with the optional real Streamline parser checkout supplied. Without that optional checkout, the parser integration case is explicitly skipped; other tests need no dependencies or network.
- M50Mini fixture: light/dark rendering, text entry, Manual/Auto transitions and native overlay interaction checked. Fixture values were simulated, not real manual calibration commands.
- Approved physical-DE1 trial: three automatic applications verified, **1.130 → 0.956 → 0.881 → 0.835**. The operator reports closer chart alignment. This is not proof of general convergence or physical flow accuracy.
- Source-only live 0.2.0 → 0.4.0 upgrade: configuration, three consumed-shot records and saved automatic values retained; actual calibration stayed **0.835**. Real read-only UI endpoints returned the correct value. No startup application or manual test value was written.

## Remaining operator test gate

No agent-driven hardware action is authorized by this checklist; obtain fresh permission before such tests.

1. Check the real p85pro Brew value and overlay against the independently read multiplier; check useful error/status wording.
2. Between shots, select an intended profile and manual multiplier. Confirm the actual read-back and terminal result; no repeated command or silent reversion.
3. After each prior operation finishes, switch profiles away/back and restart Decaid. Check the intended manual choice persists and other profiles retain their own choices. Stop on conflicting outside edits or an unresolved intent.
4. Return to Auto. Confirm the expected verified automatic value/baseline and that only a subsequent usable shot trains; wait for its terminal result before another shot.
5. Record the results and obtain explicit release approval. The already accepted keyboard-resize workaround does not block this first trial version; new unsafe or incorrect behavior does.

## Known limits

- **Supervised only:** host-side queued-write preconditions are not atomic. A shot start or outside edit can race the final check and actual command. Do not start a shot, edit calibration or switch machines while an update is pending. Disabling cannot cancel an already submitted command and does not restore calibration.
- Manual choices use the exact profile title per DE1. Same-named profiles share a choice; rename requires selecting it again. Improved content-hash/record/lineage matching is tracked in [issue #1](https://github.com/tadelv/decaid-de1-autocal-plugin/issues/1).
- On Android, closing the keyboard can leave the overlay too small until it is scrolled. The operator accepted this workaround for the first version.
- Real manual hardware writes and real-device manual restart/profile-switch behavior still await the operator test gate. Never clear an ambiguous write intent or blindly resend it.

See [the updater runbook](README.md), [UI behavior](UI.md) and [trial evidence](trial-results.md).
