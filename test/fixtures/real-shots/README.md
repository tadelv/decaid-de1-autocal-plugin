# Real-shot estimator regression fixtures

Run `npm run test:replay` (also included in `npm test`). No network, tablet, environment variables, dependencies or original exports are needed.

These fixtures were captured read-only on 2026-11-24 for the [tablet investigation](../../../docs/research/p85pro-shot-replay.md). They exercise the same production `estimateShot` seam as `test/estimator.test.js`; the suite does not replace or relax the estimator.

| Fixture | Original capture prefix | Samples | Baseline observation |
|---|---|---:|---|
| `short-output-tail` | `4b49289b` | 98 | Rejects; longest simultaneous-flat overlap about 1.22 s |
| `noisy-pressure-plateau` | `78dc80ca` | 104 | Rejects; longest simultaneous-flat overlap about 0.45 s |
| `accepted-control` | `ae902068` | 209 | Accepts; multiplier 1.1438234, one region |
| `missing-scale-control` | `9faffceb` | 524 | Rejects `no_scale_data` |

## Sanitization

Only the shot label, historical `flowCalibration`, estimator-consumed machine/scale fields, and the numeric `profileFrame` step index remain. The step index was restored from the same captured exports for the offline last-step fitting experiment. Machine serial, profile and workflow content, beans, grinder, annotations, UUIDs and unrelated telemetry were removed. The public labels replace shot IDs.

All timestamps in each shot received the **same shift** to put the first machine sample at `2000-01-01T00:00:00.000Z`. Original microsecond timestamp strings were parsed to milliseconds, matching production `Date.parse` resolution, and re-emitted as UTC ISO strings. Relative timing, machine/scale offset, repeated scale observations, sample order, actual pressure, flow and weights are preserved. No resampling, smoothing or numeric rounding was applied to measured values. Small floating-point changes from epoch shifting are allowed by numerical tolerances.

The input export SHA-256 is recorded in the investigation note; raw exports stay outside the repository. Fixture-schema tests prevent accidental reintroduction of extra metadata. The repository's diagnostic exports are not needed to run CI.

## What these tests mean

The two rejection assertions are **characterization of the current limitation**, not a claim that the desired estimator must reject those shots forever. An intentional estimator revision must explicitly revisit those assertions after deciding which observations are safe; do not silently weaken or delete them just to turn a build green.

The accepted and no-scale controls prevent a blanket “accept everything” or “reject everything” implementation from passing. Derived cases also test missing historical calibration, a scale-data gap and historical-multiplier normalization.

The two diagnostic tests use manually selected windows, not automatic window selection:

- Short tail: 21.5–23.5 s after the first machine sample.
- Noisy plateau: 21.5–24.5 s after the first machine sample.

Each start boundary, end boundary and scale timestamp is independently shifted by -0.25, 0 and +0.25 s: **27 combinations per shot**. Production integration/interpolation helpers produce a printed nominal ratio and sensitivity range. The nominal ratios happen to be near 0.995, but **there is no independently measured correct calibration for these shots**. They are diagnostic ratios, not recommendations to change the machine from 1.130. Tests reject scale extrapolation and never use these windows to override the production eligibility verdict.

`npm run fit:offline` runs the separate, **experimental last-step curve fitter** on these same fixtures. Its synthetic and real-shot tests live in `test/flow-fit.test.js`; neither it nor its diagnostic estimates are loaded by the production plugin.

This suite covers estimator behavior only. Existing `test/plugin.test.js` covers event handling, metadata, machine identity and verified writes; this fixture suite does not add UI, post-shot scheduling, per-profile persistence, new eligibility rules or a production lag model.
