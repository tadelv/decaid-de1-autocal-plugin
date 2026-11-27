# Experimental last-step flow alignment

**Current-method update:** this document records the original lag-optimized experiment. Observer **0.1.1** and `npm run fit:offline` now use **fixed-zero-lag primary fitting**; lag search is diagnostic only. See [current trial documentation](../../observer/README.md) and [two live shots](../../observer/trial-results.md). The original preview below is historical and does not display the 0.1.1 candidates.

Status: **offline experiment, not a plugin release**. No changes to production `plugin.js`, its manifest, the installed tablet plugin, or machine settings.

## Run / inspect

```sh
npm run fit:offline
node --test test/flow-fit.test.js
open docs/research/flow-fit-preview.html
```

The first command uses the four anonymized fixtures. Optional positional JSON files may hold one shot or an array of shots; no HTTP requests are made. The static chart preview embeds anonymized observations only, needs no server and makes no network requests. It was generated from the current fixture results; browser rendering has not been independently verified.

Implementation: `tools/experimental-flow-fit.js`. Tests: `test/flow-fit.test.js`. Production remains on its original estimator, and all earlier characterization tests still pass.

## Objective and final-step scope

Fit **one machine-estimation multiplier** that brings the chart's water-flow and scale weight-flow curves closer over the **final recorded extraction step**, matching the user's usual visual calibration workflow. Do not fit preinfusion, bloom or arbitrary entire-shot yield.

The step is the last contiguous run of the final espresso sample's `profileFrame`, not the highest numbered frame or the last step declared in the profile. Trailing non-espresso snapshots are ignored. Missing step identity returns `last_step_unknown`, with no whole-shot fallback. A truncated/aborted recording can end on an earlier-than-intended step; this experiment does not distinguish intentional completion from abort or yet consult stop reason. It must not become an automatic writer without that policy decision.

The numeric step index has been restored to the anonymized fixtures from the original capture. No profile content or machine identity has been restored. Step identity is only as reliable as Decaid's recorded frame index.

## Method

1. Construct 1 s averaged flow observations at 0.5 s spacing, **inside that last step only**. Remove each shot's recorded multiplier from machine flow. This uses the actual scale `weightFlow` chart channel rather than requiring its derivative to be flat. Repeated scale timestamps are deduplicated with production helpers.
2. Test scale lag from **-0.5 to +1 s**, in 0.25 s increments. Positive lag means compare machine flow at time t with scale flow later at t+lag. Keep identical supported blocks across every lag so a lag cannot win by dropping inconvenient observations. Do not borrow another step's output or extrapolate. At most 0.5 s machine gaps / 1 s scale gaps; scale mass must be >=5 g and increasing across each block; both average flows >=0.3. Require at least 2 s of covered observations, not 2 s of flat curves.
3. Down-weight pressure transitions continuously with `1 / (1 + (pressureRange / 0.5 bar)^2)`. There is **no minimum pressure gate**, no flat-flow gate and no pressure-derivative gate. The 0.5 bar scale is experimental, not calibrated from a ground-truth corpus.
4. Fit a through-origin weighted robust regression `weightFlow ~= multiplier * uncalibratedMachineFlow`, using 12 Huber-reweighted iterations. Huber delta is max(0.2, 10% of median weight flow). Search lag using normalized Huber loss, breaking nearly tied fits toward zero lag. If machine-flow variation is <10%, lag is not identifiable enough to fit: use **zero lag**, flag it, and still provide a multiplier.
5. Return diagnostics, not permission to write: selected frame/window, effective coverage, fitted multiplier, lag, residuals, multiplier spread across all tested lags and caution flags. Out-of-range estimates outside 0.35–2 fail rather than clamp.

Overlapping blocks are correlated; their count is not an independent sample count. This is an exploratory fit, not a probability model or calibrated confidence interval. Requiring common support across all lag candidates deliberately loses some data near step boundaries; six of the 40 captures lack enough supported last-step evidence under these choices.

## Results on the anonymized controls

| Fixture | Current estimator | Experimental multiplier | Lag | Weighted flow RMSE, before → after |
|---|---|---:|---:|---:|
| Short output tail | rejects | **1.008** | +0.75 s | 0.916 → 0.178 |
| Noisy pressure plateau | rejects | **0.980** | 0 s | 0.776 → 0.093 |
| Previously accepted control | 1.144 | **1.159** | +0.5 s | 0.070 → 0.052 |
| Missing scale | rejects | no fit | — | — |

All three original historical multipliers were **1.130**. The first two fitted multipliers differ by approximately **2.74%** of their mean, versus production's existing 10% two-shot agreement limit. This does not simulate or authorize a write.

The short-tail estimate varies **0.886–1.010** across the tested lags and is flagged `timing_sensitive`. Its lower mismatch at a fitted lag is not proof that 1.008 is the physical calibration. The noisy plateau's lag sensitivity is much smaller: **0.971–0.983**. Real shots have no independently measured correct multiplier.

RMSE is pressure-weighted, over the common fitted blocks, using the selected lag. “Before” uses historical 1.130 at that **same lag**; improvement is not inflated by comparing a shifted candidate against an unshifted baseline. The curves are 1 s averaged for fitting but the preview draws raw samples. Do not expect every raw point or the entire last step to overlap. The preview includes the raw scale line and a distinctly dashed lag-shifted scale line; it does not silently move the recorded chart.

## Bounded newest-40 replay

On the previously captured 40-shot sample:

- Production estimator: **7/40 individual accepts**.
- Experimental fitter: **31/40 diagnostic fits**; **7/7** for the active profile title (not all seven share the current extraction program).
- Remaining captures: **6 insufficient last-step evidence**, **3 no scale data**.
- Warnings overlap: **24 weakly identified lag** (zero lag used), **5 timing-sensitive**, **2 lag-search boundary**. Only four fits have no warning.

A weakly identified lag is expected on a stable final step and is **not automatically a failed multiplier estimate**. Making every warning a hard rejection would recreate the current excessive strictness. Conversely, ignoring timing sensitivity or a boundary lag could conceal a bad fit. Translating these diagnostics into write policy is deliberately left open.

The broader source export and replay JSONL stay outside the repo at `/Users/vid/development/research/autocal-p85pro/`. This sample is not a representative accuracy benchmark and includes different program versions. The offline fitter has no machine/program eligibility check, two-shot vote, damping, write verification or persistence; those remain responsibilities of the plugin's policy layer when integration is explicitly accepted.

## Verification and next gate

**81/81 tests pass**, including 13 experimental tests: known synthetic multiplier/lag recovery with changing flow; a scale-flow spike and slow pressure ramp; historical normalization; flat-flow zero-lag fallback; final-step isolation; numeric frame ordering/trailing idle samples; real controls; missing calibration/scale; timestamp reversal/gaps; backwards mass and out-of-range estimates. Production syntax, candidate syntax and diff whitespace checks pass. Production files were confirmed unchanged.

The next tablet build should first expose this candidate as **observe-only/dry-run** beside the existing decision, including window, multiplier, lag and flags. Compare several new shots before allowing this estimator to write. Separate work still needed before an automatic build: decide abort/completion policy, handle short/ambiguous last steps and tare/lag behavior, validate policy-level wiring and make the applied-value display truthful. No release, installation or machine write was attempted in this experiment.
