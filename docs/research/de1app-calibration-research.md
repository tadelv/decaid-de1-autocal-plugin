# DE1App flow-calibration research

## Conclusion

**The inspected DE1App implementation does not automatically infer flow calibration from historical shots.** Graphical Flow Calibrator (GFC) provides **manual graphical adjustment**, followed by **automatic recall of a saved multiplier when selecting a profile**.

Consequently, the comparison plugin’s two-shot agreement, continuous simultaneous-flat regions, numeric slope limits, minimum pressure/weight/flow, and machine-provenance checks are **additional automatic-estimation policies—not requirements inherited from GFC**. This supports questioning their restrictiveness, but does not establish that removing them would make unattended calibration safe.

## Sources and revisions

Paths below use these roots:

- **DE1:** `/Users/vid/development/repos/de1app`, HEAD `7e94ef3c7c68a9b9ae7d188e08e3ee3776780489`.
- **GFC:** `/Users/vid/development/research/autocal-gfc`, HEAD `ecb87822594a28d980334049b5c2e3603a6cf56e`. Supervisor supplied this materialization as DE1App’s exact submodule pin; its detached HEAD independently matches.
- **Plugin:** `/Users/vid/development/work/decaid-de1-autocal-plugin`, HEAD `30ee4f315d5eefd75846394bf135690c58df3404`.

HEADs were read from Git metadata; working-tree cleanliness was not verified. Local development instructions were read; no repository-local `AGENTS.md` was found. No files were modified.

## What DE1App actually does

### Algorithm and eligibility

| Topic | Primary-source behavior |
|---|---|
| Calibration calculation | User changes the displayed multiplier by **0.01**. GFC redraws historical machine flow as `displayed_multiplier × historical_flow / historical_multiplier`. It does not calculate an optimal multiplier or select extraction regions. **GFC `plugin.tcl:263–295`**. |
| Pressure requirement | UI advice: **“It is best to adjust flow rate data for where the pressure curve is flat.”** This is guidance, not an enforced numeric eligibility test. **GFC `plugin.tcl:109`**. |
| Flow requirements | Graph shows machine flow and scale-derived flow for visual comparison; adjustment loops simply rescale machine flow. No enforced flat-machine-flow or flat-scale-flow requirement. **GFC `plugin.tcl:67–69`, `plugin.tcl:263–295`**. |
| Timing requirements | No minimum stable-region duration or timestamp-gap eligibility rule in GFC’s adjustment/save paths. **GFC `plugin.tcl:263–341`**. |
| Minimum observations | No two-shot minimum or agreement test. The user can adjust using one displayed historical graph. History navigation exposes the newest **seven shots overall**, not two shots filtered to the current profile. **GFC `plugin.tcl:122–141`, `plugin.tcl:153–223`**. |
| Identity | Saved overrides are keyed by **profile title**, not serialized program, machine model, or machine serial. **GFC `plugin.tcl:304–341`, `plugin.tcl:468–484`**. |
| Bounds | GFC’s increment/decrement controls stop at **2.00** and **0.35**, respectively. These are UI-control bounds, not a separate validation layer in the save functions. **GFC `plugin.tcl:267–295`, `plugin.tcl:297–323`**. |

**Important distinction:** GFC’s permissiveness is paired with a human choosing where the curves should agree. It is not evidence that arbitrary shot regions are suitable for automatic estimation.

### Scale and tare handling

- The dedicated flow-calibration test profile explicitly instructs the user to connect a Bluetooth scale, use a **0.3 mm puck-simulator basket**, change the calibration value, and repeat until the blue and brown lines follow each other. Its programmed pressure plateaus run from **1 to 9 bar**—so the separate “9 bar” pressure-calibration procedure is not a universal flow-calibration eligibility floor. **DE1 `de1plus/profiles/flow_calibration.tcl:1`, `:37–38`**.
- GFC loads recorded `espresso_flow_weight` alongside pressure and machine flow. It does **not** inspect scale connection, tare success, minimum accumulated weight, or scale provenance before permitting adjustment/save. **GFC `plugin.tcl:144–150`, `:183–223`, `:297–341`**.
- Ordinary DE1App scale processing supplies those graph values. It derives flow from weight history, with a default finite-difference estimator; the default estimation window is **11 samples**. This is a **scale signal-processing window**, not an 11-observation calibration requirement. **DE1 `de1plus/device_scale.tcl:612–636`, `:699–701`, `:810–820`**.
- A confirmed tare clears scale estimator history. During pre-flow preparation, nonzero reported mass above the default **0.04 g** threshold triggers tare in configured auto-tare states; tare requests have a **1000 ms** holdoff. None of these is a GFC shot-acceptance test. **DE1 `de1plus/device_scale.tcl:72–85`, `:286–292`, `:322–341`, `:737–744`**.
- Scale values can be doubled for “two cups, one on scale”; graph flow therefore need not equal the unadjusted physical scale reading. **DE1 `de1plus/device_scale.tcl:219–252`**.
- Graph capture appends the current scale-flow estimate against espresso elapsed time during machine updates. GFC compares these stored vectors; it does not reconstruct independent machine/scale timestamp overlap or optimize a timing offset. **DE1 `de1plus/gui.tcl:3389–3425`, `:3438–3453`**.

### Global versus profile values, application, persistence, display

- GFC maintains a default multiplier and a title/value list of profile overrides in application settings. These are not calibration fields embedded in the extraction profile program. **GFC `plugin.tcl:4–9`, `:304–341`; DE1 `de1plus/vars.tcl:3304–3306`**.
- **Explicit save:** tapping default/profile stores the displayed multiplier, calls `save_settings`, and writes it to the machine. No damping, multi-shot averaging, or acceptance vote occurs. **GFC `plugin.tcl:297–341`**.
- **Automatic recall:** profile selection applies the matching title’s override; otherwise it restores the default when necessary. It displays a popup announcing the selected multiplier. **GFC `plugin.tcl:468–484`**.
- The multiplier is machine-global in application: the write targets register **`80383C`**, encoded as integer `1000 × multiplier`. **DE1 `de1plus/de1_comms.tcl:1353–1366`**.
- `save_settings` writes the application settings array to the settings file. **DE1 `de1plus/utils.tcl:1285–1304`**.
- Startup normally sends the tablet’s multiplier. The special default string **`1.000`** instead requests the machine’s existing value, avoiding overwriting it after settings recreation. **DE1 `de1plus/bluetooth.tcl:2364–2378`**.
- GFC displays **default**, **profile**, and **showing** values, plus profile/date and the comparison graph. The standard calibration screen displays `x multiplier`; its separate slider spans **0.13–2.00**, unlike GFC’s 0.35 floor. **GFC `plugin.tcl:75–88`; DE1 `de1plus/skins/default/de1_skin_settings.tcl:2380`, `:2414`**.
- Subtle implementation caveat: opening GFC assigns the **current** multiplier to its stored default variable. Thus “default” is not an entirely immutable baseline. **GFC `plugin.tcl:455–464`**.

## Comparison: current automatic plugin

All citations here refer to `auto-flow-cal.reaplugin/plugin.js`.

| Additional plugin policy | Implementation |
|---|---|
| Exact DE1-model allowlist and usable serial | `:9`, `:80–87` |
| Historical profile program identity | Title + version + steps—not every descriptive/target field. `:100–105` |
| Captured machine provenance and historical multiplier | `:477–485` |
| Only newest two shots; no older replacement | `:626–642` |
| Machine flatness | Both interval endpoints: espresso state, pressure ≥ **2 bar**, machine flow ≥ **0.5**; gap ≤ **0.5 s**; absolute pressure and flow slopes ≤ **0.35 units/s**. `:193–212` |
| Scale flatness | Endpoint weight ≥ **5 g**, weight flow ≥ **0.3 g/s**; gap ≤ **1 s**; absolute weight-flow slope ≤ **0.35 g/s²**. `:226–240` |
| Continuous overlap | At least **2 seconds** of intersecting accepted machine/scale intervals. `:251–263`, `:313–318` |
| Actual estimate | Sum scale weight gains divided by integrated machine flow after removing each shot’s historical multiplier. `:285–345` |
| Two-shot agreement | Relative difference ≤ **10%**, then arithmetic mean of the two estimates. `:694–710` |
| Bounded update | Default damping **0.5**, maximum absolute adjustment **0.1**, multiplier **0.35–2**, deadband **0.01**, resolution **0.001**. `:22–24`, `:42–48`, `:712–734` |
| Trigger and write safety | Workflow update evaluates changed program or dirty history; `shotStored` only marks history dirty. Safe-state and identity rechecks precede writes. `:737–755`, `:836–845`, `:874–884` |

**Most consequential difference:** the plugin requires **both newest shots** to contain qualifying simultaneous-flat regions. GFC has neither requirement. Its flat-pressure advice does not imply all three curves must satisfy per-adjacent-sample slope thresholds.

## Pressure/temperature calibration is separate

DE1App also has a calibration command accepting *reported* and *measured* values, with separate targets for flow, pressure, and temperature. That mechanism must not be confused with GFC’s flow-estimation multiplier register. **DE1 `de1plus/de1_comms.tcl:1628–1659` versus `:1363–1366`**.

Likewise, heater warmup/test flow settings and steam flow-rate controls are not historical espresso-flow calibration eligibility rules. **DE1 `de1plus/skins/default/de1_skin_settings.tcl:2276–2282`, `:2429`**.

## Prior Atuin context and uncertainties

The supervisor supplied prior Atuin thread **`3bdd68da`**: reported experiments found sparse usable pairs even after shortening stability windows; the current source confirms the later **2-second / 0.35-slope / 2-bar** constants. Those historical counts were **not independently retrieved or reproduced**, so they should not be treated as fresh measurements.

Residual risks:

- This establishes the behavior of the inspected core and pinned GFC—not every historical DE1App release or unmaterialized third-party plugin.
- No runtime, hardware, firmware-persistence, or quantitative acceptance-rate testing was performed.
- Source comparison alone cannot determine safe replacement thresholds. The clearest candidates for empirical investigation are the **two-newest-only selection** and **continuous three-signal flatness requirement**, rather than scale evidence itself.