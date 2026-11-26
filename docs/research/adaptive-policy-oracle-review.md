**Revise recall authority and isolate zero-lag eligibility before accepting this draft.**

## Inherited decisions
- Draft only; no implementation, installation or calibration writes.
- Use usable final-step evidence despite changed basket/dose/grind, short yield or poor taste.
- Primary fit is fixed zero lag; disagreement is diagnostic, not an automatic veto.
- Preserve machine identity, scale evidence, manual precedence and verified between-shot writes.
- Known local profile/manual calibration should avoid repeated wasted brews.

## Diagnosis
The proposed single capped EMA is a reasonable minimal tracking rule:

```text
Lnext = L + clamp(0.5 × (candidate − L), −maxStep, +maxStep)
```

Keep it. It provides recency without requiring another rolling average. The draft correctly distinguishes algebraic convergence from unproven physical closed-loop convergence.

## Drift / contradiction check
1. **P1 — Capped recall conflicts with known-value restoration.**\
   Draft `:94–95` applies the learning-step cap to selecting an already calibrated profile. Switching from 1.8 to a saved 0.8 could require roughly ten activations/shots at unsuitable values. The supervisor confirmed this cap is **not accepted**.\
   **Repair:** separate new-evidence learning from verified local recall. Propose exact saved-value recall, guarded by identity, idle state, manual authority and valid restoration provenance. Make that one explicit maintainer decision.

2. **P1 — “Diagnostic-only lag” still controls primary eligibility.**\
   Draft `:23–34` adopts the existing fitter, but `tools/experimental-flow-fit.js:89–104` discards any block unsupported at **every diagnostic lag**.\
   **Confirmed reproduction:** a continuous 3-second trace at 6 bar, machine flow 2 ml/s, scale mass `10 + 1.8t` and weight-flow 1.8 returns `insufficient_last_step_evidence`, despite sufficient zero-lag coverage.\
   **Repair:** determine primary eligibility using zero-lag support alone. Optional lag diagnostics may report insufficient coverage without invalidating the primary fit. Explicitly revise this carryover rather than silently blessing it as necessary protection.

3. **P1 — Initialization and re-enabling have competing authorities.**\
   Draft `:41` seeds from pre-shot live calibration; `:88` starts re-enabled automation at live calibration; `:94–97` introduce baseline restoration, saved recall and manual resets. For saved `L=1.25`, live `A=1.13`, re-enabling can either reset or recall depending on which paragraph wins.\
   **Repair:** specify one transition: on enable/manual edit, reconcile live authority, set the active tracking origin and epoch, invalidate older pending application, and issue no learning correction until fresh evidence. Define separately how explicit later profile selection recalls saved values. If an external value lies outside automatic-learning bounds, preserve it and hold automation—do not silently clamp it.

4. **P2 — Round-after-clamp can exceed the promised cap.**\
   Draft `:58–64` permits non-grid settings but rounds after limiting the command. Example: `A=1.130`, `maxStep=0.1006`, target `1.2306` rounds to `1.231`, exceeding the cap.\
   **Repair:** compute the admissible integer grid first:

   ```text
   lo = max(minimum, A − maxStep)
   hi = min(maximum, A + maxStep)
   qlo = ceil(lo / resolution)
   qhi = floor(hi / resolution)
   command = resolution × clamp(round(Lnext / resolution), qlo, qhi)
   ```

   No command if the interval contains no representable value.

## Recommendation
Retain the one-filter tracking kernel and worked examples. Separate:
- **Learning:** bounded movement from fresh evidence.
- **Recall/restoration:** previously established local authority.
- **Application:** safe, deduplicated, verified machine action.

Do not add basket/grind registration or turn warning flags into replacement rejection gates.

## Risks
Gain 0.5 and the proposed bounds remain unvalidated defaults. Flow-control feedback, unresolved write outcomes and manual-epoch transitions still require prospective tests before enabling writes.

## Need from main agent
Record the maintainer decision on **exact verified recall versus capped recall**. The supervisor has confirmed capped recall must not be treated as accepted.

**Verdict: NEEDS REVISION, then maintainer acceptance.**

## Suggested execution prompt
No implementation handoff warranted. Revise the draft only; keep the observer unchanged and writes disabled.