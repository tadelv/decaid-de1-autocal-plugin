# First two live observe-only shots

**Update:** with user approval, observer **0.1.1** is now installed using fixed-zero-lag fitting. Live replays reproduced **1.189328** and **1.182376**, preserving all four old observations as separately labeled legacy results. Calibration remains **1.130**, with the original writer still disabled. The investigation below records the previous 0.1.0 behavior that motivated the change.

2026-11-25, p85pro.home:8080. Both human-pulled Cremina&Gusto shots arrived automatically through `shotStored`; no workflow toggle was needed. Full-shot reads confirmed the same machine and the same profile title/version/steps. Both stopped at target weight.

| Observation | First | Second |
|---|---:|---:|
| Shot prefix | `0a11b628` | `8c94abd0` |
| Historical / actual multiplier | 1.130 | 1.130 |
| Per-shot optimized candidate | 1.173301 | 1.143489 |
| Selected lag | 0.5 s | 1.0 s |
| Fitted final-step coverage | 18 s | 25 s |
| Pressure-weighted RMSE before → after | 0.095539 → 0.068819 | 0.071742 → 0.070505 |
| Cautions | none | lag at search boundary |

The candidates agree within **2.57%** of their mean. However, the second fit improves mismatch by only **1.72%** at its selected lag, versus **27.97%** for the first. Agreement alone does not justify enabling writes.

## Offline investigation of the boundary warning

No installed source or settings were changed for these probes.

Expanding the lag search to +2 s changes the second estimate to **1.112796 at 1.75 s**, while the first stays near **1.174424 at 0.5 s**. The wider search also trims one second from each fitted support window, so it is not a like-for-like error comparison. Crucially, the second suggested correction crosses from above to below the current 1.130. This is a lag/multiplier identifiability problem, not proof the scale physically has a 1.75 s delay. Do not simply widen the live lag limit.

Holding lag fixed while retaining each shot's original common-support blocks gives:

| Fixed lag, same for both shots | First multiplier | Second multiplier |
|---|---:|---:|
| 0 s — displayed, unshifted flow curves | **1.189328** | **1.182376** |
| 0.5 s | 1.173301 | 1.163087 |
| 1.0 s | 1.154038 | 1.143489 |

For fixed zero lag the difference is **0.59%** of the mean; fixed 0.5 s gives **0.87%**. This suggests that a simpler multiplier-only fit is more repeatable here than independently optimizing lag on each shot. It does not identify which absolute multiplier is physically correct. Pressure retention, scale smoothing and slow curve trends can all be absorbed by an apparent lag.

## Recommendation

For the stated goal—aligning the displayed last-step flow curves—evaluate a **zero-lag multiplier-only fit**, leaving lag exploration as a diagnostic rather than allowing it to change the candidate on every shot. Alternatively a separately established device-specific fixed delay could be used; these two coffee shots alone do not establish that delay.

Keep the observer observe-only and the machine at **1.130** until this policy is accepted and checked. No more human shots are required to reproduce this particular timing instability.

## Trial state at the original 0.1.0 investigation (before the update above)

- Original automatic writer remains disabled, including auto-load.
- Observer 0.1.0 remains enabled and unchanged; its current recommendations still use per-shot lag optimization.
- No machine writes. Actual calibration verified 1.130 after both shots.
- Local raw captures and offline analyses: ignored `.pi/observer-build/live-trial-shots.json`, `live-trial-analysis.json`, `live-fixed-lag-analysis.json`.
