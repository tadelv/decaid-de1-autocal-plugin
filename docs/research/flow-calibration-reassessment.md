# Flow calibration reassessment

Research date: 2026-11-24. Research only; no plugin behavior, machine settings, forum posts or GitHub issues changed.

## Recommendation

Add a plugin-declared `tile-line` under Streamline's Brew tile for visibility, but first make its value truthful after writes. Separately revise automatic eligibility around robust pressure-stable observations rather than requiring three individually flat traces on every adjacent sample. Do not remove scale/identity/write-verification safeguards, calibrate during extraction, or infer pump calibration from whole-shot beverage yield.

### Source revisions and evidence limits

- Plugin: `30ee4f315d5eefd75846394bf135690c58df3404`, manifest 1.4.0.
- Streamline upstream main: `41fd5094bbe63a3132305db769461aa020478419` (fresh shallow clone at `/Users/vid/development/research/autocal-streamline`). This supersedes the older `d28da12` snapshot in `STREAMLINE_INTEGRATION.md`.
- DE1App: `7e94ef3c7c68a9b9ae7d188e08e3ee3776780489`; GFC: `ecb87822594a28d980334049b5c2e3603a6cf56e`, materialized at the DE1App gitlink pin rather than silently reading its newest release. Independent report: [de1app-calibration-research.md](de1app-calibration-research.md).
- Historical Atuin thread **3bdd68da** already found poor real-shot eligibility: at the then-proposed 2.5 s window only 1/6 real profile pairs qualified; even 1.5 s still gave 1/6 pairs. These are historical measurements, not a fresh replay of this version. The current window is 2.0 s.
- Initial checks: production estimator synthetic probes, Streamline parser validation, `npm test`, and `npm run check`. Follow-up with the supplied tablet address captured and replayed 40 real shots: [p85pro-shot-replay.md](p85pro-shot-replay.md). No machine writes, browser rendering or installed skin compatibility test was performed.

## 1. Forum: what was actually settled

Read the complete plugin thread **11889**, including all **16 comments**, with `dcamp message 11889 all=1`:
https://decentespresso.com/dcamp/general-forum/auto-flow-calibration-plugin-for-decaid

| Status | Point | Evidence |
|---|---|---|
| Maintainer acknowledgement | Current auto-calibration rules still need tuning. | Vid, comment 180720. |
| Explicit agreement | A known manual per-profile override is useful; users should not spoil several Filter3 brews while automation learns an already-known value such as 2.0. | Oleg 180864; Vid agrees 180865. |
| Explicit agreement | Do not automatically apply a shared profile author's machine-specific calibration on another machine. Keep calibration local; descriptions/documentation can advise the recipient to check it. | Vid 180865, Oleg 180867, Vid agrees 180899. This is product agreement, not an implemented storage schema. |
| Confirmed limitation | Automatic gravimetric calibration cannot work without a connected scale. Filter3 can also retain water upstream of the scale; its beverage output is not an immediate measure of pump input. | JK 180868; Vid confirms scale requirement 180899. A manual override remains a separate path. |
| Open request | Show the current multiplier in Streamline, and make switching Filter3/allongé visibly restore the appropriate calibration. | ChinY 180952, latest comment, paraphrased from Chinese. No maintainer resolution follows it in the 16-comment thread. |

The terminology confusion is real: comments 180823–180836 distinguish the app-side weight/volume adjustment from the real machine flow multiplier. Do not label both simply “Flow calibration”. The user's question whether calibration is only cosmetic for pressure profiles was not conclusively answered in this thread; pressure programs can still have flow limits and volume exits.

### Related complete discussions

- **4868**, 33 replies: https://decentespresso.com/dcamp/problems/flow-calibration-multiplier-for-different-flow-speeds
  - Damian **59634 / 59644**: changing pressure retains/releases water, so input volume-flow and output mass-flow are comparable at constant pressure; scale bounce calls for averaging. This supports a pressure-stability requirement, not a requirement that both flow derivatives independently remain below a fixed limit on every edge.
  - John **59626 / 59638–59640** supports profile-specific calibration and describes high-flow/high-pressure regimes as troublesome. Multipoint tables, changing calibration during a shot, and calibration profiles in later comments are **proposals**, not evidence of a shipped automatic controller.
- **1791**, 76 replies: https://decentespresso.com/dcamp/most-popular-topics/graphical-flow-calibrator-app-extension
  - Damian **19062** explicitly answers “Is there an option to auto calibrate?” with **“No”**. Automatic profile-load application is not automatic learning.
  - **19051 / 19077**: selecting a profile loads its saved calibration, otherwise the default; history carries the multiplier used for that shot. **19075**: resetting per-profile entries does not reset the global default.
  - **19083 / 19084**: a user with no flat spots is told to visually estimate the curve alignment. That human judgement does not establish a safe automatic threshold.
- **7543**, 29 replies: https://decentespresso.com/dcamp/most-popular-topics/calibrating-flow-with-dsx-plugin
  - The original DSx_flow_check gives a suggestion from a selected historical shot's trailing samples, with manual application. **98482** discusses averaging noisy scales and operating near the normal extraction regime. **98490** describes last-20-point averaging; earlier text mentions 10/configurable samples—version/context matters.
  - A dedicated constant-flow/pressure water procedure with a simulator basket is not proof arbitrary coffee shots are eligible.
- **4306**, 48 replies, title “Damian's Flow Calibration - App extension”, slug `damian-s-flow-calibration-app-extension` (read through the authenticated API): the dedicated DPx procedure explicitly recommends scale filtering; **53276** warns about Lunar gaps/noise. **53304** calls this plugin discontinued in favor of GFC and again explains constant-pressure comparison. Do not confuse it with GFC or DSx_flow_check.

## 2. Streamline: supported UI, no fork required

Current source supports plugin-declared additions to existing tiles, **not an arbitrary new dashboard tile**:

- `src/modules/plugin-surfaces.js:742–746`: discovery requires a loaded plugin declaring an HTTP `skin` endpoint.
- `src/modules/plugin-surfaces.js:606–619`: validates `tile-line` / `tile-hint`, text, tile, active styling and action. `tile: "temperature"` is Brew.
- `docs/plugin-surfaces.md:25–47,177–193`: line text limit 40 characters; a hint is 24. Reads on load, minute polling, focus/visibility, and optional websocket pushes; request budget 2 s.
- `src/modules/plugin-surfaces-ui.js:655–703`: first plugin wins a tile slot; a tile-mode on Brew suppresses its tile-line. A `tile-hint` is an alternative slot, not an automatic fallback. Header and shot-strip are globally scarce slots; avoid claiming them for a static calibration number.

Recommended answer (tested with upstream `parseSkinAnswer`; retained exactly one surface and overlay action):

```json
{
  "version": 1,
  "surfaces": [{
    "id": "flow-cal", "kind": "tile-line", "tile": "temperature",
    "text": "Flow cal ×0.985 · Auto", "active": true,
    "action": {"type": "open", "view": "record", "presentation": "overlay", "fit": true}
  }],
  "live": {"endpoint": "changed"}
}
```

The plugin already has a read-only `ui` page with the embedding protocol. Add `skin` to its manifest/handler; add a `changed` websocket and `emit` permission if immediate updates are wanted. Push `{"what":"skin"}` after a decision/verified change; this avoids an unnecessary workflow re-read. Permission changes need the normal Decaid approval path. Without push the minute poll remains usable, but is too stale to confidently explain a profile switch.

### Truthful state is a prerequisite

`plugin.js:605` assigns `state.lastSeenMultiplier` **before** any write. Its other assignment only clears it (`:551`); `statusDocument():954` exposes it as `currentMultiplier`. A verified apply updates the ownership record (`:796–805`), not that cache. Restoration also does not refresh that cache.

Consequently a line copied directly from `/status.machine.currentMultiplier` can show the **previous** number immediately after a successful write—even if `skin` is polled repeatedly. Update observed/applied state after verified writes/restores and reconcile external changes before calling it current. The existing UI page reads the calibration endpoint live, but `/status` is deliberately memory-only. Simply switching to `lastPluginAppliedMultiplier` also fails for baseline/manual/external values.

Display separate concepts: verified machine multiplier, source (Auto / Manual / Baseline), pending/dry-run state, and the last skip reason in the overlay. Stale/disconnected/unknown must not look like confirmed Auto. No known machine value is a reason to display `—`, not to invent 1.000; a known baseline is still displayable even without a learned result. The plugin should remain the calibration writer; the skin only displays and opens its page.

Do not reuse Streamline's similarly named profile calibration implementation: `src/modules/flow-calibration.js:25–31` owns `weightFlowMultiplier` / `volumeFlowMultiplier`, app-side sequencer settings. These are not `calFlowEst` / `/api/v1/machine/calibration.flowMultiplier`. The current upstream note `docs/calibration-endpoints.md:95–127` confirms this gap and the need for read-back verification.

## 3. Why the current plugin can do nothing

| Mechanism | Current evidence | Consequence / proposed change |
|---|---|---|
| Per-edge triple flatness | `plugin.js:195–259`: pressure >=2 bar, machine flow >=0.5 ml/s, scale >=5 g, scale flow >=0.3 g/s; all three derivative limits 0.35; machine gaps <=0.5 s, scale gaps <=1 s; >=2 s uninterrupted intersection. | A single noisy derivative breaks the region. Evaluate robust pressure-stable windows with cumulative weight gain, sufficient signal, continuity and lag/settling handling. Flow need not be mathematically constant if integration matches changing output under steady pressure. Validate this before relaxing production policy. |
| Exactly two newest shots | `:628–641,694–708`: both latest title matches must pass metadata, estimator, then <=10% agreement. | One bad/no-scale/newly-edited shot masks older usable evidence. Consider a bounded recent history scan, filtered by machine + extraction program, and retain accepted evidence with freshness/confidence. The exact pool size and thresholds require real-shot replay; no claim that one shot is universally sufficient. |
| No immediate shot-driven evaluation | `:836–843,882–884`: shotStored increments revision only; workflowUpdated does the evaluation. | Continuous learning is not guaranteed merely because shots are stored. Schedule safe evaluation after persistence and when idle; handle event ordering, busy deferral and deduplication. Repeated identical evidence must not repeatedly advance damping. |
| No saved per-program result | `:375–403`: persistent state only stores machine baseline/ownership, not learned or manual per-profile values; `:719–725` damps toward an estimate from the current machine value. | Re-selecting a profile does not directly restore its saved learned value as requested. Separate learning new evidence from selecting/applying an already accepted local calibration. Key by machine and program identity, not portable profile metadata. |
| Evidence failure can reset a good value | `:558–572`: if owned, an eligibility failure can restore baseline. | Even the same profile's one bad new shot can lose its working override. Proposed behavior: retain a still-valid accepted calibration for that machine/program; return to baseline only when that profile has no valid local value or the user explicitly resets it. Manual overrides take precedence. |

### Reproducible strictness probe

`docs/research/autocal-estimator-probe.cjs` runs the **unmodified production estimator**, not an alternate implementation:

| Synthetic observation, 250 ms sampling for 10 s | Verdict |
|---|---|
| 9 bar, steady 2 ml/s, multiplier 0.9 | Accepts 0.900 |
| Same accurate cumulative weights, weightFlow alternating by only +/-0.05 g/s | Rejects `insufficient_stable_region` |
| Constant 9 bar, matched machine/scale flows ramping at 0.4 ml/s² | Rejects `insufficient_stable_region` |
| Steady matched data at 1.5 bar | Rejects `insufficient_stable_region` |

The jitter causes adjacent flow changes of 0.1/0.25 = **0.4 g/s²**, just beyond the 0.35 gate, although cumulative mass is exact. This proves sensitivity to the extra derivative channel; it does not establish the prevalence of that noise on real scales. The low-pressure probe proves intentional exclusion, not that arbitrary low-pressure brewing is safe to auto-calibrate. Filter retention and lack of scale remain disqualifiers.

## 4. Smallest safe next implementation scope (proposal, not accepted specification)

1. **Visibility:** verified multiplier cache + Brew surface + overlay reason/source; parser tests and stale/manual/disconnected/dry-run states.
2. **Lifecycle and local selection:** safe post-shot scheduling, evidence deduplication, machine/program-keyed accepted results, baseline fallback, manual override precedence and no automatic transfer with shared profiles.
3. **Estimator:** replay a representative real-shot corpus before choosing thresholds. Compare current acceptance, robust window acceptance, estimate error and false acceptance; cover noisy scales, rising/declining pressure, variable flows, low-pressure espresso, short shots, scale lag/dropouts/tare, profile edits and mixed-machine history. Preserve historical multiplier normalization, idle-only single-writer application, bounded updates, serial checks and verified read-back.

Do not just lower `MIN_PRESSURE` or shorten `MIN_REGION_DURATION` again. The existing `node tools/why-skip.js --decaid <URL> --json` is the read-only first evidence collection tool; it already exposes per-gate rejection counts and pressure sweeps.

## 5. Independent DE1App findings

The separate researcher inspected core DE1App and its pinned Graphical Flow Calibrator. Full source-backed report: [de1app-calibration-research.md](de1app-calibration-research.md).

- **GFC learns nothing automatically.** Users adjust the displayed multiplier by 0.01; the graph is rescaled as `newMultiplier * historicalFlow / historicalMultiplier` (`GFC plugin.tcl:263–295`). Saving is explicit. Selecting a profile automatically recalls its saved value or the default (`:468–484`).
- Flat pressure is UI advice (`:109`), not enforced numeric eligibility. GFC has no two-shot vote, continuous-three-trace flatness test, scale-weight floor or machine serial provenance test in its adjustment/save path. The human makes the suitability judgement. Do not transfer its permissiveness directly into unattended code.
- Profile overrides live in local application settings, keyed by profile title (`:304–341`), not embedded in the extraction program. This matches the forum's local/manual direction but is weaker identity than the automatic plugin should use.
- DE1App's dedicated flow-calibration profile includes 1–9 bar plateaus and explicitly asks for a connected scale and 0.3 mm simulator basket (`de1plus/profiles/flow_calibration.tcl:1,37–38`). A 9 bar pressure-calibration procedure is not a universal flow-calibration pressure floor.
- Scale flow is already estimated from weight history (default window 11 samples, `de1plus/device_scale.tcl:612–636,699–701,810–820`); tare clears estimator history. Historical graph traces are not independent ideal noiseless signals. GFC's 0.35–2.00 button bounds differ from the standard screen's 0.13–2.00 slider; bounds are UI policies, not proof of firmware limits.

Scope: this establishes the inspected core/GFC behavior, not every DE1App extension or historical version. The DSx/DPx observations above are separately attributed to their forum discussions. No hardware measurements were supplied by the researcher.
