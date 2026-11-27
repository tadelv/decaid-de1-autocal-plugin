# Historical comparison: full versus damped updates

**Result: historical shots work for this comparison; no new shots are required.** The user approved comparing these rules without applying calibration. This is offline diagnostic replay, not authorization for a live rule or an installation.

## Sample and method

- **42 distinct full shots:** the saved newest-40 capture from p85pro plus the first two observer trial shots. Capture timestamps span **2026-10-20 through 2026-11-25 12:33 device-local time**. This is not the tablet's full history or its latest complete capture; later stalled/low-flow trial records are not in these raw exports.
- All recorded the same captured DE1 identity and actual calibration **1.130**. Each fit uses that shot's recorded multiplier; proposed replay values never replace historical metadata.
- Sort chronologically, deduplicate shot IDs, and keep separate trackers for machine + canonical profile title/version/steps. The fit-bearing sample covers **8 distinct extraction programs**; matching titles alone do not merge changed programs.
- Use the **unchanged `fixed_zero_lag_v1` fitter** for both rules. Each program starts from its first fitted shot's recorded multiplier. This is a declared counterfactual seed, not a live activation or restoration test.
- Compare **50% gain / 0.100 cap** with **100% gain / no per-shot cap**. Both keep range **0.35–2.0**, resolution **0.001**, and command deadband **0.010**. Proposed commands feed only the next simulated command state, never the recorded shot measurements. No commands are sent.

## Results

**33/42 shots fitted.** Six lacked sufficient final-step evidence under the current fitter; three lacked scale data. Five fitted shots carry timing-sensitivity warnings; neither rule silently rejects them.

Illustrative outputs, rounded to machine resolution:

| Program / point in its sequence | New estimate | Damped proposed value | Full proposed value |
|---|---:|---:|---:|
| Extractamundo Dos!, first fitted observation | 0.781 | 1.030 | 0.781 |
| Best practice (light roast), first fitted observation | 0.876 | 1.030 | 0.876 |
| Cremina&Gusto, first recent trial shot after its older history | 1.189 | 1.170 | 1.189 |
| Cremina&Gusto, following recent trial shot | 1.182 | 1.170 | 1.189 |

The last full proposal stays 1.189 because its difference from 1.182 is below the retained 0.010 write deadband. The underlying full tracker still becomes 1.182376.

Full updates propose changes larger than 0.100 on **13 of the 33 fitted observations**, including first movements from the per-program seed. The largest is **1.130 → 0.781** (change −0.349). That fit has only **3 seconds** of supported evidence and a timing-sensitivity warning. Another same-program sequence moves **0.738 → 1.061**, showing that full updates also follow large reversals immediately. These movements may reflect changed setup, measurement effects or both; this replay cannot establish which.

**Interpretation:** the cap does materially slow following the latest estimate. Full gain removes that delay, but also follows large reversals. Closer agreement with the same shot's fitted target is true by construction—not independent proof of more accurate calibration.

## Limits and next step

Recorded shots cannot reveal what would have happened if a proposed multiplier had actually been applied, especially under flow control. They cannot establish physical convergence, safe host writes, taste or the ideal gain.

The current fitter still trims primary evidence to support all diagnostic lags. Both rules deliberately receive identical inputs here, rather than mixing an estimator change into a gain comparison. The known short-trace restriction remains unresolved and acceptance counts are provisional. A revised zero-lag-only eligibility implementation requires its own versioned replay.

The hostname `p85pro.home` did not resolve during this run, so no fresh tablet exports were obtained. Existing private raw captures were reused without modification. No live tracker state, plugin configuration, calibration or machine state was written.

**Next:** review the large full-update proposals before choosing a live gain. Live installation and guarded automatic application remain separate work requiring acceptance.

## Reproduce and checks

```sh
node tools/replay-update-rules.js \
  /Users/vid/development/research/autocal-p85pro/recent-shots.json \
  .pi/observer-build/live-trial-shots.json
npm test
```

Replay output is saved locally at `.pi/update-rule-replay/comparison.json`; raw shot/profile metadata remains outside tracked files. The helper has no network or machine-write interface. Tests cover gain/cap/deadband, bounds, sorting, duplicate/conflicting exports, program isolation, provenance, failed fits, unsupported seeds and ambiguous timestamps. **98 tests pass**, including five new replay tests.

Input SHA-256:

- `recent-shots.json`: `4fd91fecb4af88a1ce315edf45bfd7e661aa2963fc385ae3b918b22bb739df40`
- `live-trial-shots.json`: `e6c7513cf2fa19e6b68fa81e3ddaf98cbfa44dc252c4d738a555eb6b4359e0e3`
