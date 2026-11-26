# p85pro read-only calibration investigation

Date: 2026-11-24. Address: `http://p85pro.home:8080`.

## Result

The plugin's live decision agrees with offline replay: the active profile is rejected for `insufficient_stable_region`. This is an estimator eligibility problem, not missing historical multipliers, a wrong machine, a disabled plugin or dry-run mode in the inspected snapshot.

- Installed plugin reports **1.4.0**, enabled, dryRun false, storage ready.
- Connected machine reports **DE1Pro**, firmware **1362**.
- Machine multiplier is **1.130** before and after inspection; the plugin records the same baseline, no owned override, and no last plugin-applied multiplier.
- Last observed decision: skip `insufficient_stable_region`, shot `4b49289b-299d-4341-a53c-b7b9a9b4c1eb`.
- Active profile: **Baseline • Ultra Low Contact Dos Bengelitos**. Its two newest shots have matching current extraction programs, matching machine serial and historical calibration 1.130. Four of its seven historical shots have different programs; they must not silently become evidence for the current program.

Only GET requests were used. No profile selection, reload, calibration/settings write or machine command was issued. Offline scenarios altered constants only in isolated Node VM instances, not in plugin files or on the tablet.

## Active-profile evidence

The title-filtered history query returned seven shots. All seven fail the unmodified local production estimator (`30ee4f3`, version 1.4.0). Installed source bytes were not fetched or hash-compared; the matching version and live decision corroborate this replay, not prove byte identity.

| Shot prefix | Best simultaneous region | Current-program match | Production result |
|---|---:|---|---|
| `4b49289b` | 1.22 s | yes | insufficient_stable_region |
| `78dc80ca` | 0.45 s | yes | insufficient_stable_region |
| `d3413bb6` | 0.59 s | yes | insufficient_stable_region |
| `6eb70f57` | 0.25 s | no | insufficient_stable_region |
| `803166d8` | 0.72 s | no | insufficient_stable_region |
| `ba1a5e9a` | 0 s | no | insufficient_stable_region |
| `5da809ec` | 0 s | no | insufficient_stable_region |

The required duration is 2 s. Lowering only the pressure floor (the diagnostic sweeps 2, 1.5, 1, 0.5 bar) rescues none of these seven.

### The two newest shots show two different problems

1. **Newest (`4b49289b`):** a 24.1 s record, but only about **4.73 s after scale weight reaches 5 g**. Machine flatness lasts up to 2.52 s, scale flatness only 1.22 s. The scale derivative requirement fragments the short useful tail. Pressure also rises substantially during the early output, so it would be unsafe to integrate that entire tail indiscriminately.
2. **Previous (`78dc80ca`):** the pressure is about **5.92–6.14 bar over the last roughly 6 s** (after its initial rise), yet adjacent-sample derivative tests fragment it. For example 5.94 → 6.07 bar over about 0.27 s is approximately 0.48 bar/s, exceeding the 0.35 limit despite a visually near-level plateau. Machine flow changes and scale-flow settling impose additional cuts. Best current machine-flat interval is only 0.50 s; scale-flat interval 2.21 s; intersection 0.45 s.

This supports testing window-level pressure stability/noise tolerance and scale lag/settling. It does **not** establish a correct replacement multiplier or justify changing calibration during these shots.

## Latest-40-shot sensitivity replay

Read the newest **40 of 1009** recorded shots, spanning seven profile titles. All 40 captured the same DE1 serial and a historical multiplier of 1.130. This is a recent convenience sample, not a representative full-history benchmark.

The following are **single-shot estimator acceptance counts**, not full-policy apply counts, accuracy scores or safe production settings:

| Offline scenario | All recent shots | Active title's seven shots |
|---|---:|---:|
| Unchanged production estimator | **7/40** | **0/7** |
| Only pressure floor 2 → 0.5 bar | 11/40 | 0/7 |
| Only minimum duration 2 → 1 s | 11/40 | 1/7 |
| Effectively disable both flow-slope gates; keep pressure rules | 17/40 | 3/7 |
| Previous scenario plus 0.5 bar pressure floor | 28/40 | 5/7 |

“Disable” was simulated with slope limits of 1,000,000, solely to isolate which gates are restrictive. These relaxed scenarios were **not** applied and are **not** recommendations. Increasing acceptance alone cannot establish accuracy; some extra accepts may be unsafe. In particular the second-newest active shot remains ineligible even in the broadest scenario, due to pressure-edge fragmentation. Three of the other newly accepted active-title shots have a different extraction program.

### Production behavior by profile title

| Title | Individual accepts |
|---|---:|
| Baseline • Ultra Low Contact Dos Bengelitos | 0/7 |
| Baseline • Ultra Low Contact Dos | 3/22 |
| Cremina&Gusto | 3/3 |
| Best practice (light roast) | 1/3 |
| Soup 58 / Extractamundo Dos! | 0/1 each |
| Cal8brate SB | 0/3; **no_scale_data**, not a flatness failure |

Of the seven profile titles in the sample, only **Cremina&Gusto** has two newest shots that individually pass, have matching programs and agree within 10% (estimates 1.1438 and 1.0419; relative difference **9.33%**). This is a pair-evidence diagnostic, not a simulated machine write or a claim that every other policy precondition holds for selecting that profile.

The other Baseline title has older accepted observations but its second-newest shot fails. Merely scanning further back will not fix the active program's current zero-acceptance problem under the existing estimator.

## Recommended next step

The approved **offline regression fixture/replay suite** is now implemented: `npm run test:replay`, with [fixture documentation](../../test/fixtures/real-shots/README.md). It uses anonymized copies of the two newest active-program shots plus accepted and missing-scale controls, characterizes the existing failures, and reports 27 independent window-boundary/timing combinations per rejected shot. No production thresholds were changed.

Next, use this suite before modifying the estimator. Compare a window-level pressure-stability rule and lag-aware cumulative-weight integration with current behavior; report estimate sensitivity to window boundaries and timing offsets, not just acceptance. Keep wrong-machine/program exclusion, scale evidence, idle-only application, deduplication, manual override precedence, bounds and read-back verification.

Do not simply deploy the permissive scenarios above or shorten the window again. The pressure-floor-only experiment disproves that as a sufficient solution for the active profile.

## Evidence and reproduction

Raw shot exports contain personal shot/profile metadata and machine identity. They remain outside the repository at:

`/Users/vid/development/research/autocal-p85pro/`

- `response-1.json`: active workflow; `response-2.json`: title-filtered summaries; `response-3.json`: seven full shots.
- `recent-history.json`, `recent-shots.json`: bounded newest-40 capture.
- `replay-results.json`: per-scenario decisions and candidate estimates.
- `plugin-status.json`: observed live plugin status.
- `inspect.cjs`, `replay.cjs`, `summarize.cjs`: local research helpers. `inspect` and `replay` perform bounded GETs and refresh the exports; `summarize` is fully offline. These are local capture/research tools, not production code.

SHA-256:

- `recent-shots.json`: `4fd91fecb4af88a1ce315edf45bfd7e661aa2963fc385ae3b918b22bb739df40`
- `replay-results.json`: `c0e64c8b3c44c2b3142045324be0e6677389c6aca341de1d90c9d56283d63658`

The existing `tools/why-skip.js` was run without source changes. Node's direct fetch returned `EHOSTUNREACH` while curl succeeded to the same resolved address. `inspect.cjs` therefore supplies a restricted GET-only curl-backed fetch adapter to the existing diagnostic; it captures responses and leaves estimation logic unchanged. The cause of this process-specific network restriction was not investigated further.
