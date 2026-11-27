# dcamp: calibration while dialing in

Research pass following the live short/low-flow shot. Scope: public forum discussions only, through the authenticated dcamp API; no forum posts, plugin changes, installations or calibration writes.

## Answer

**Yes: the premise and nearly the exact workflow have already been discussed.** The evidence supports treating profile identity as a useful context, not a guarantee that flow/pressure conditions remain unchanged. A usable shot should not be discarded merely because grind, dose, basket, yield or taste differs from an earlier shot.

Continuous calibration following dial-in is a reasonable policy direction. Forum statements do not prove convergence of our particular estimator/controller, nor justify ignoring missing scale evidence, pressure/storage effects or unsafe writes.

## 1. Near-exact proposal: same profile, selected bean/dose/grind

Thread **4868**, “Flow calibration multiplier for different flow speeds”; Problems board; **33 replies read with `all=1`**.

https://decentespresso.com/dcamp/problems/flow-calibration-multiplier-for-different-flow-speeds

**Mike Tomasco, comment 59635:**

> a user would just need to run the profile a few times with the selected bean/dose/grind for the DE to develop a modified flow calibration matched to that profile/bean.

https://decentespresso.com/dcamp/problems/flow-calibration-multiplier-for-different-flow-speeds/59635

Context matters: Mike is proposing an extension to existing work, including possible multipoint/formula calibration. This is **an explicit proposal**, not evidence that DE1App shipped automatic adaptation with that behavior.

**Mike, comment 59642:** grind, dose and first-shot effects can change a profile's timing; he suggests using move-on conditions rather than an absolute time vector. This supports our final-recorded-step window instead of assuming a fixed wall-clock slice identifies the same phase in every shot. It does not by itself validate our window selection or a new algorithm.

**Damian, comment 59620:** the farther the operating point moves from where calibration was performed, the larger the error can become. **John, 59638:** calibration accuracy differs across high/low pressure and flow regimes. **John, 59649:** proposes machine-specific flow/pressure lookup tables from historical shots, explicitly an idea, not a deployed result.

## 2. App author reports automatic convergence over repeated shots

Thread **11703**, “Decenza 2.0 — Recipes”; Most Popular Topics; **199 replies read with `all=1`**. Opening-post author and relevant commenter are both **Jeff H**.

https://decentespresso.com/dcamp/most-popular-topics/decenza-2-0-recipes

**Jeff H, comment 177377:**

> The auto flow calibration is per profile and bean. there is a global calibration that is used until a per profile one is figured out. Take a few shots to figure it out.

https://decentespresso.com/dcamp/most-popular-topics/decenza-2-0-recipes/177377

**Jeff, 177418:** says the global value is adjusted after every shot and improvements help future profile calibration; he favors automatic convergence rather than additional manual settings. This is **first-party author testimony about his app**, not a source-code audit or independent verification of convergence.

**Counterpoint — ShawnPD, 177417:** reports that switching between very different flow rates can require multiple poor shots while calibration catches up and asks for a per-profile starting value. Jeff declines the additional UI complexity. Therefore there is not unanimous agreement that users should always wait through several shots; retain the previously agreed manual-override escape route.

The per-profile-and-bean description also does not establish that we must create separate storage keys for every grind setting, dose and basket. That would be a new product decision, not a requirement established by these comments.

## 3. Same profile and dose, changed grind: different observed errors

Thread **7614**, “Flow estimation accuracy vs. puck resistance”; General Forum; **16 replies read with `all=1`**.

https://decentespresso.com/dcamp/general-forum/flow-estimation-accuracy-vs-puck-resistance

The opening post reports dialing a new grinder/bean with the same Default profile and 18 g dose, obtaining dramatically different output errors for coarse, choked and dialed-in pucks. **Joe D, 100312** points out preinfusion/headspace accounting and possible time-limit confounds, so those initial whole-shot volume discrepancies must not be treated as pure flow-calibration error.

**Marty, comment 100315**, follows up after controlling the time-limit issue: a choked grind reports 25 ml but yields about 15 g, whereas a more reasonable grind reports/yields approximately 48 ml/g. He explicitly discusses the occasional bad result during dial-in of a new bean or dose.

https://decentespresso.com/dcamp/general-forum/flow-estimation-accuracy-vs-puck-resistance/100315

This is user-reported operating-point evidence, not a controlled calibration benchmark. It nevertheless directly challenges the assumption that an unchanged profile implies interchangeable flow evidence.

## 4. Basket/dose evidence, and its limit

Thread **11295**, “10g basket calibration and flow issues”; Problems; **9 replies read with `all=1`**.

https://decentespresso.com/dcamp/problems/10g-basket-calibration-and-flow-issues

**Shinguk Kwon, 170131:** changing the amount of coffee changes flow, pressure and extraction behavior. **Henry, 170132:** dose, grind, roast, bean and age affect actual extraction flow; nominal basket dose is only a reference. Later comments describe needing a different grind/pressure recipe for a 10 g basket.

This establishes **changed hydraulic conditions**, not by itself that every basket requires a different firmware multiplier. Combined with operating-point-dependent estimation error discussed above, it supports keeping those shots as evidence rather than rejecting them solely for changed preparation.

## Additional context

**Damian, 11717**, thread **1097**, “Flow calibration questions for Decent Espresso” (General Forum; 3 replies read in full): recommends calibrating near the expected pour operating point. He distinguishes pressure-controlled shots, where calibration may primarily change the plotted reading when no flow constraint is active, from flow control. Do not promise that a machine multiplier is always cosmetic.

https://decentespresso.com/dcamp/general-forum/flow-calibration-questions-for-decent-espresso/11717

**Tony P, 20100**, in “How to embed Visualizer graphs in forum posts”, advises dialing the extraction first and adjusting calibration for the profile types used. This is community advice, not a demonstrated adaptive algorithm. Read as a complete individual comment through `dcamp comment 20100`.

## Implications for our plugin — recommendation, not an installed change

1. **Use the newest usable final-step observation.** A short, manual-ended, low-flow or poor-tasting shot is not automatically invalid. Require measurements capable of supporting a fit, not a successful-tasting recipe or target yield.
2. **Track the recent operating conditions rather than demand agreement with old ones.** The old writer's hard two-newest-shot <=10% agreement rule can block adaptation precisely while someone changes grind/dose/basket. Our latest low-flow shot's 1.333 estimate should remain evidence alongside the earlier approximately 1.186 estimates.
3. **Move gradually between shots.** Recency-weighted, damped and bounded updates can follow a settled dial-in without retaining every old shot's influence forever. Do not change calibration while a shot runs. The exact recency/damping policy still requires tests; forum support is not proof it will converge.
4. **Keep trust and write safeguards separate from agreement.** Same machine/local program context, valid scale data, continuity, historical-multiplier normalization, stale-analysis protection and verified idle-only writes remain necessary. Disagreement should be reported as a confidence/context-change signal, not treated as proof either observation is bad.
5. **Keep it simple.** Do not require users to register basket/dose/grind combinations just to get calibration. A local adaptive profile value can follow their current setup; explicit manual override remains useful for known settings and non-gravimetric use.

For flow-controlled steps or flow-based exits, changing calibration changes the delivered shot as well as its graph. This creates feedback with grind adjustments; modest updates and prospective verification are still required. A fixed setup may settle toward a suitable multiplier, but not necessarily toward a universally correct constant across all pressures and flows.

## Search / evidence boundaries

Queries included `calibration grind`, `calibration basket`, `calibration dose`, and `flow calibration basket`; private ping/chat results were excluded. Full thread captures remain under ignored `.pi/dcamp-dialin/`. Sources are forum discussions and app-author reports; no Decenza implementation was inspected in this pass, and no claim of community consensus or proven convergence is made.

Current deployment is unchanged: observer 0.1.1 remains observe-only; original automatic writer remains disabled. This research does not authorize or enable machine writes.
