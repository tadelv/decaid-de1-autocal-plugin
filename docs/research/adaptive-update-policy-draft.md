# Draft: follow dial-in with bounded per-profile calibration

**Status: EXPERIMENTAL — installed and armed for an approved supervised trial.** This document does not supersede the existing normative Design.md until a maintainer accepts the replacement sections. The installed observer remains observe-only; the old automatic writer remains disabled. No machine actions are authorized by this draft.

**Approved experiment:** compare the original 50% gain / 0.100-cap rule with **100% gain / no per-shot cap** using offline historical replay and shadow proposals. Both retain overall bounds and the 0.010 write deadband. This approves comparison, not either rule as the live default, installation, or calibration writes. [Initial historical comparison](historical-update-rule-comparison.md).

**Accepted build direction:** **100% gain with no per-shot cap** for a supervised live trial, retaining overall bounds, measurement eligibility and write deadband. The user explicitly deferred host queued-write guards, persistent manual override and Streamline UI to the next session. The opt-in [trial implementation](../../updater/README.md) is built separately and defaults to writes off. It is now installed and armed after explicit target-specific operator approval; startup was verified with calibration unchanged, and the first live update subsequently verified **1.130 → 0.956**. The operator reports much closer chart alignment on the follow-up pulled at 0.956; broader convergence remains unestablished. See the [trial record](../../updater/trial-results.md). The conservative rule below remains a comparison baseline, not the selected trial rule.

## Original conservative proposal (comparison baseline)

Learn from **each newest usable final-step observation**, not an agreeing pair of supposedly equivalent shots. Maintain one local tracking value per machine and extraction program. Move it halfway toward the newest absolute fitted multiplier, with a maximum change of 0.100 per observation. Recent shots naturally displace old conditions. Basket, dose, bean and grind changes do not invalidate an otherwise usable observation, and no additional setup registration is required. New-evidence writes are independently capped; recalling an already verified local value is a separate authority, not new learning. Automatic application requires execution-time host guards that the current API does not provide; until then, this rule may run only in observe/shadow mode.

## 1. Goal, limits and evidence

The goal is approximate alignment of the displayed **unshifted** weight-flow and water-flow curves during the final recorded extraction step. It is not a claim of absolute pump/volume metrology, a taste score, or an instruction to correct the whole-shot yield.

User decisions: pressure/flow need not be flat; a short, stalled or manually ended shot may still have useful final-step evidence; changing basket/dose/grind can change the suitable multiplier even with the same profile; calibration should follow the current dial-in rather than wait for two shots to agree.

Primary sources and caveats: [dcamp research](dcamp-calibration-dial-in.md). Mike Tomasco explicitly proposed repeated selected bean/dose/grind learning; Decenza's author reports automatic per-profile/bean learning. These support the direction, **not our proposed gains or a convergence guarantee**.

Observed on one machine: two Cremina&Gusto shots fitted at zero lag give **1.189328** and **1.182376**. A later low-flow/short shot gives **1.333283** from 24 seconds of usable evidence. The intervening stalled shot yielded no fit. The lower-flow shot must remain evidence rather than be discarded because it differs from the other two. Actual calibration stayed **1.130** throughout the trial.

Non-goals: within-shot changes, automatic pressure/temperature calibration, per-basket/grind databases, shared-profile calibration transfer, automatic optimization of scale lag, cross-machine learning, new UI frameworks, or enabling writes in the current observer.

## 2. Eligibility: measurements, not recipe success

Use final-step **zero-lag** fitting as the proposed measurement seam; do not silently reintroduce the old triple-flat estimator. Identify the final **recorded contiguous espresso step**, not a fixed wall-clock interval or highest frame number. Missing frame identity or insufficient scale/flow/time coverage yields no candidate.

**Required change before adopting the experimental fitter:** installed observer 0.1.1 still requires support at every optional diagnostic lag before retaining a block. That is a carryover restriction, not a safety requirement endorsed here. Determine primary eligibility and multiplier from **zero-lag support only**. Lag diagnostics may use their own common-supported subset, or return unavailable, but must not remove primary evidence, choose its multiplier or change its window. A continuous 3 s trace at 6 bar, machine flow 2 ml/s, weight `10 + 1.8t` and weight-flow 1.8 must be eligible at zero lag even when the diagnostic grid lacks enough support. Label this changed estimator version explicitly; do not silently reuse cached 0.1.1 results.

Hard requirements retained:

- Allowlisted traditional DE1, usable serial and captured same-machine provenance. A candidate is absolute only after normalizing the water-flow history by the multiplier actually recorded for that shot.
- Finite usable machine/scale measurements, sufficient continuity and positive supported evidence, and a fitted multiplier within the configured operational range. Existing fitter coverage/signal defaults remain experimental and need negative-path tests; this policy does not remove them merely to improve acceptance counts.
- A correctly identified local extraction program and stored-shot identity. Current identity is canonical title + version + steps; dose/yield/context/notes are not part of it.
- No learning from a failed fit. No substitute estimate from scale-free data, target weight, total beverage yield or older unrelated profiles.

**Not rejection reasons by themselves:** changed basket/bean/dose/grind, missed target weight, `machineEnded`, manual stop, high/low flow, pressure variation, disagreement with history, or poor taste. A truly no-output stall will often fail measurement eligibility; there is no separate quality classifier.

Warnings remain visible but do not silently become a new agreement gate. Numerical eligibility does not prove physical accuracy. Lag diagnostics never select the primary candidate or move the displayed scale trace. Strong residuals/pressure transitions must remain reviewable; this draft proposes fixed gain for all fitted observations rather than inventing an unvalidated probability-to-gain mapping.

## 3. The update rule — one damped tracker, not two filters

For local key **K = (machine serial, extraction-program identity)**:

- `c`: the newest usable shot's **absolute** fitted multiplier.
- `L`: the previous local tracking value in the current authority epoch. Seed it only by the enable/manual-edit/activation transitions in section 6; do not let a historical shot, stale saved target or arbitrary live read choose a different seed.
- `R`: the last **verified applied** value for that local key, if any. `R` is not the same as an unverified or deferred `L`; only `R` may be recalled automatically as a known profile value.
- Proposed defaults: `alpha = 0.5`, `maxStep = 0.100`, range `[0.35, 2.0]`, machine resolution `0.001`, write deadband `0.010`. These reuse the writer's existing operational defaults but remain maintainer decisions, not calibrated optima.

```text
change = clamp(alpha * (c - L), -maxStep, +maxStep)
Lnext = clamp(L + change, minimumMultiplier, maximumMultiplier)
```

Persist `Lnext` with enough precision to avoid rounding every observation. This recursion is the recency weighting; **do not additionally average the last two shots, require 10% agreement, or damp a second time when applying**. With an unchanged absolute candidate and no binding cap, the previous error halves per usable shot. This is an algebraic property, not proof the physical closed loop converges while grind/calibration affect delivered flow.

An observation with no fit changes neither `L` nor creates a new machine-command authorization. It does not erase a working value or trigger baseline restoration on the same program. An already valid deferred command from a prior usable observation may still execute after the machine becomes safe, but must retain its original evidence ID, current epoch and context checks; the failed fit does not create an extra command.

### Separate final machine command

For a **new-evidence application**, read verified live multiplier `A` and calculate a command on the feasible machine grid, not by rounding after clamping:

```text
resolution = 0.001
lo = max(minimumMultiplier, A - maxStep)
hi = min(maximumMultiplier, A + maxStep)
qlo = ceil(lo / resolution)
qhi = floor(hi / resolution)
if qlo > qhi: hold(no_representable_command)
command = resolution * clamp(round(Lnext / resolution), qlo, qhi)
```

Use stable decimal/grid arithmetic so binary rounding cannot expand the allowed interval. Apply the deadband **after** selecting a feasible command. If `abs(command - A) < 0.010`, make no POST but retain `Lnext` and consume that observation exactly once. A held/empty interval likewise creates no POST. Example: with maximum `1.2296`, a target of `1.2296` yields at most **1.229**, never 1.230. With `A=0.3504` and cap `0.0004`, command 0.351 is forbidden even though naive round-after-clamp would produce it.

This cap limits a physical **learning** write; it is not a second damping filter. `Lnext` can remain ahead of `A` after deferred learning. Report the learned target, verified `A` and saved `R` separately. Exact verified-value recall/baseline restoration is defined in section 6 and is not subject to this per-observation learning cap.

## 4. Worked example — counterfactual only

Starting from `L = A = 1.130`, process the real observed absolute candidates in order. Assume every permitted write verifies before the next shot and no profile/manual changes occur:

| New observation | Local tracker after it | Rounded machine command |
|---|---:|---:|
| 1.189328 | approximately 1.15966376 | 1.160 |
| 1.182376 | approximately 1.17101992 | 1.171 |
| No fit (stalled record) | unchanged | no new command |
| 1.333283 (low-flow record) | approximately 1.25215144 | 1.252 |
| Another hypothetical 1.333283 | approximately 1.29271720 | 1.293 |

There is no disagreement veto on the low-flow observation. If the user returns to the former operating conditions, subsequent usable observations move the tracker back. Rapidly alternating setups can produce a compromise/lagging value; this minimal policy does not promise an ideal value for every alternating setup.

Tracker values use the full-precision captured candidates; candidate labels are rounded for readability. These are arithmetic replay examples, **not actual proposed machine writes** and not simulated espresso outcomes. The original recorded shots were all pulled at 1.130; applying new values could change later measurements, especially with flow control/flow exits.

## 5. Learning order, deduplication and enabling

- `shotStored` is the primary trigger. Read the exact persisted shot, serialize evaluation per machine, update only its own key and schedule application only after it is safe. A workflow event is not required to learn a saved shot.
- Only genuinely new post-enable observations train the tracker. Startup/history seeding and re-analysis under a new estimator version are **diagnostic replay**, not new training events or permission to apply another correction.
- Persist the consumed shot/order marker atomically with each `Lnext`; repeated events, page reads, polling, profile reloads and metadata edits must not count again. Store capture ordering and shot ID; late older shots are diagnostics only, never roll state backwards. Equal/ambiguous capture ordering requires an explicit logged hold rather than an assumed second observation.
- Switching the active workflow during analysis does not change which program the shot belongs to. Learning may finish for that shot's local key, but no command may be applied to a different active machine/program.
- Enable/manual-edit/activation precedence is specified by section 6, not whichever saved value loads first. Diagnostic replay never acquires live authority merely by toggling a switch.

## 6. Activation, baseline and manual precedence

One local tracker per key follows the **most recent setup used with that program**. Basket/dose/grind metadata may be shown, but does not fragment or gate it. A durable authority epoch distinguishes fresh authorized observations from earlier manual/enable/activation contexts. All automatic transitions below depend on section 7's host guard; without it they are shadow proposals only.

### Deterministic authority transitions

| Trigger | Tracking origin and machine action |
|---|---|
| Enable/re-enable automation | Reconcile a fresh live `A`; start a new epoch, invalidate older pending application, and set active `L=A`. No immediate recall or learning correction; require a fresh post-enable shot. A saved `L=1.25` cannot override live `A=1.13` just because it loaded first. Existing verified saved values for other keys remain available for a later explicit selection. |
| External/manual edit detected | Manual authority wins: new epoch, cancel old pending work, adopt verified live value as baseline and active `L`, drop automatic ownership. No immediate corrective write. New learning requires a fresh post-edit shot, unless a persistent manual override remains active. |
| Explicit selection of a different known local program | Recall its **last verified applied `R`**, not an unapplied/diagnostic tracking target. After exact read-back, seed active `L=R`; cancel pending work from the previous context. No EMA step or new learning token. |
| Explicit selection with no verified local value | Restore the saved machine baseline **exactly**; after successful read-back, seed active `L` from that baseline. Never seed from another program's override. |
| Active persistent per-profile manual override | Explicit local override has precedence; apply its authorized representable value with guarded verification. Fits remain diagnostic. Clearing the override starts a new live-authority epoch; old diagnostics do not train it. |

**Proposed recall decision, awaiting maintainer acceptance:** exact verified local recall and baseline restoration are not capped/damped as new learning. Example: switching from a verified 1.800 program to a previously verified 0.800 program requests **0.800 once**, not 1.700 followed by repeated unsuitable shots. Identity, local provenance, manual precedence, range, machine resolution, idle/execution-time checks and read-back still apply. Unknown, nonrepresentable, out-of-range or unverified saved values cannot use this authority.

This also resolves first-use fallback deterministically: with baseline **1.130**, live **1.500** left by another program, and no saved value for the newly selected program, propose **1.130 directly**. If that restoration does not verify, hold activation/application and keep subsequent shots diagnostic; do not seed a learner from a partially restored 1.400. Report `baseline_not_verified` rather than creating a polling staircase. A fresh explicit activation is the retry opportunity after the fault is resolved.

No activation is implied by a repeated identical workflow message, page refresh, reconnect or poll. A pending unverified `L` must not become exact-recall authority through profile toggling. Only a verified learning write updates `R`; sub-deadband learned changes remain in `L` while that context stays active. On explicit later reactivation, verified authority wins over an old unapplied target.

If an external/manual live value lies outside automatic-learning bounds, preserve it and hold automatic tracking/application visibly. Do **not** clamp it into range or overwrite it by fallback. It can still be displayed and analyzed diagnostically. If live authority is unavailable or a prior write is unresolved, hold until reconciliation; do not guess the seed.

A no-fit shot creates no new update/application and does not erase a working value. Imported/shared profiles never bring another user's machine calibration. Manual-override UI/storage is not currently implemented; whether it must ship before automatic trials remains a maintainer decision.

## 7. Writes, failures and restart safety

### Host-side safety dependency — current API is insufficient

**Supervised-trial exception:** the user explicitly accepted building the live path with this queued-write gap deferred. The separate trial build uses best-effort checks and reports the limitation; it is not an unattended release and does not claim the execution-time guarantees described below. Target identity and installation/enablement still require supervised preflight. See the [trial runbook](../../updater/README.md).

The current documented command (`Design.md`, section 26) sends only `flowMultiplier` through a queued device-write path. Inspected local `reaprime/lib/src/services/webserver/de1handler.dart:615–639` parses that value and calls `updateMachineCalibration`; it does not receive expected serial, workflow generation, idle state or calibration preconditions.

A GET confirming idle/1.130 followed by a POST is **not atomic**: a shot can start or a manual actor can change calibration between those operations. Read-back can discover the wrong outcome but cannot prevent the overwrite. The existing API cannot justify a guarantee of no mid-shot/stale/manual-overwriting writes.

**Prerequisite for unattended automatic application:** the host must provide a conditional operation that rechecks expected machine identity, active program/authority epoch, safe state and expected current multiplier at actual dispatch in the serialized control path. Host-managed shot starts/manual writes must share that ordering authority. Reject a stale command rather than knowingly execute it and diagnose afterward. The exact API/host contract is a separate dependency, not implemented by this document.

Device buttons, delayed state reports and out-of-band controllers may still race host observations. The host protocol must state those limits explicitly; execution-time host checks are necessary, not a claim of firmware-level atomicity. Until the guarded contract and residual limitations are reviewed/accepted, do not certify unattended automatic operation. The maintainer has now explicitly chosen a best-effort **supervised** trial as noted above; that exception does not resolve the host race.

### Application and durable outcomes

Additionally require fresh plugin-side identity/program/generation/manual checks, one serialized command, and GET verification against the exact requested grid value rather than a 202 response. Learning writes use section 3's cap/grid/deadband; known recall/restoration uses section 6's separate authority. In either case, claim ownership and update saved `R` only after verification.

Persist a pending intent associated with the consumed observation or explicit activation, authority epoch and expected live state before dispatch. Persist consumed observation plus `Lnext` atomically; a crash between learning/POST/verification must not replay the learning update. Startup reconciles outstanding intent by reads only; **never blindly resend**. An ambiguous outcome holds application visibly until explicitly resolved; equal numbers alone need not establish which actor wrote them.

Busy/disconnected/changed context means no dispatch. Retain only the latest valid deferred target for a context, not one future write per queued event. The one command allowed when it becomes safe remains attributed to its original authorization; repeated polls cannot repeatedly step toward the tracker. Persistence failure causes no write. POST/read-back failure does not falsely mark a target applied, owned or safe to restore later.

On unload/disable, cancel pending application and issue no calibration command. Verified ownership records remain distinguishable from pending/unverified intent; a fitted number alone confers no machine authority.

## 8. Observable acceptance scenarios

| Case | Required outcome |
|---|---|
| First usable new shot | One bounded update; no need for a second shot/history pair. |
| 1.189328, 1.182376, failed fit, 1.333283 | Counterfactual tracker/command sequence matches section 4; low-flow input is retained despite disagreement. |
| Repeated fixed candidate | Tracker approaches it; no claim that this proves physical convergence. |
| Basket/dose/grind changes under one program | New valid evidence updates the same key without registration, reset or automatic rejection. |
| Alternating old/new conditions | Bounded movement toward newest evidence; visible disagreement, no stable-value promise. |
| Missing scale, unknown final step, unsupported zero-lag gaps or invalid historical multiplier | No tracking change or new command; preserve a valid existing value. |
| Continuous 3 s zero-lag trace, diagnostic lag grid under-supported | Primary fit remains eligible; lag diagnostics may be unavailable. |
| Duplicate event, observer replay, restart, page read or metadata-only edit | No second learning update or extra write token. |
| Inactive/changed program or switched machine | Never apply the finished analysis to the wrong live context. |
| Known profile recall versus no-value profile | One exact verified local recall versus exact verified baseline fallback; no new learning on selection and no partial-baseline seed. |
| Re-enable with saved L=1.25 and live A=1.13 | Active origin becomes 1.13; no immediate recall/correction; only new-epoch shots learn. |
| External value outside configured automatic range | Preserve it, cancel stale work, hold automation; no silent clamp or restoration. |
| Manual edit or shot start after final GET but before host dispatch | Host execution-time preconditions reject it; current unguarded API fails this scenario and must not be certified safe. |
| Busy/deferred target | Latest target only, applied once when safe; no polling staircase. |
| Persistence failure, crash at write boundaries, POST failure or incorrect read-back | No duplicate learning, no blind retry and no false verified/ownership status. |
| Sub-deadband changes, non-grid bound or cap edge | Learning retained; feasible grid intersection before deadband; maximum 1.2296 never becomes 1.230; empty grid interval holds. |

Before enabling writes: unit-test the pure update rule and authority transitions; separate zero-lag eligibility from optional diagnostics; establish the guarded host contract and test interleavings/crash boundaries; replay captured sequences; then run **shadow proposed next-command** on the tablet without applying. Only a separately approved supervised automatic trial may establish behavior under physically changing calibration. The current command API still cannot justify unattended safety guarantees; supervised trials use the explicit exception in section 7.

## 9. Compatibility and open acceptance decisions

This proposal intentionally replaces the old Design.md sections on simultaneous triple flatness, exactly two newest shots, 10% agreement, evidence-failure restoration, and workflow-only triggering. It preserves machine identity, scale requirement, normalization, bounds, safe-state checks and verified ownership principles. Existing state contains machine baseline/ownership but no per-program tracking value or durable consumed-observation ledger; a migration is required, not an in-place assumption that old observer records are learning state.

Maintainer decisions before implementation acceptance:

1. Historical comparison is complete; **100% gain / no per-shot cap** is selected for the supervised live path. It is not a measured optimum; prospective physical response remains unverified.
2. Exact verified local recall/baseline authority is included in the separate trial build; persistent per-profile manual override UI is explicitly deferred. The separate trial was subsequently installed after explicit target-specific operator approval; this does not establish unattended safety.
3. Zero-lag eligibility is isolated in the trial's v2 fitter. A reviewed execution-time guard contract remains required before unattended operation. The supervised best-effort exception is explicit, not a resolved safety gap.

No issue, PR, release, observer update or machine write is part of this drafting task.

## Independent advice and revision ledger

Both requested agents completed successfully: [oracle advice](adaptive-policy-oracle-review.md) and [reviewer advice](adaptive-policy-reviewer-review.md). Their reports refer to the **initial draft**, before the revisions below; the original verdicts were NEEDS REVISION. Advice does not constitute maintainer acceptance, and no second independent review of this revised document is claimed.

| Review finding | Disposition in this revision |
|---|---|
| Single capped EMA is the minimal reasonable recency tracker | Retained in section 3; no second rolling average or damping. Gain remains proposed. |
| Capped recall wastes shots; enable/manual/baseline seeds conflict | Sections 3/6 distinguish unverified L from verified R, explicit authority epochs, exact verified recall and exact baseline fallback. Failed fallback holds; an external out-of-range value is preserved. Exact recall remains a human acceptance decision. |
| Optional lag diagnostics still reject zero-lag evidence in current fitter | Section 2 explicitly requires independent zero-lag support and a 3 s regression scenario before adoption. Current observer code was not changed. |
| Rounding after clamp violates bounds/cap | Section 3 now selects within the feasible integer grid before deadband; independent arithmetic checks cover the concrete counterexamples. |
| GET-then-POST cannot guarantee manual/idle precedence at dispatch | Section 7 makes the host execution-time guard a prerequisite, states out-of-band limitations, and keeps automatic application blocked under the existing API. |

**Validation performed:** the counterfactual command sequence was recomputed independently; 10,000 generated decimal-grid cases checked feasible bounds/caps and empty-grid holds; the oracle's 3 s diagnostic-support rejection was reproduced against the unchanged experimental fitter. These checks validate draft arithmetic and expose a current limitation, not physical convergence or host execution safety. No code fix, host guard or hardware write was exercised in this drafting task.

**Draft outcome:** the update-rule proposal and its deferred authority/safety decisions are explicit. It is ready for maintainer discussion, **not an accepted implementation specification or permission to enable writes**. A complete tracking formula is not a completed hardware-control protocol. The approved next stage is comparison in offline replay/shadow mode, reporting proposed commands without applying them. Initial bounded historical replay is complete; a live tablet shadow-tracker installation is not part of that offline result.
