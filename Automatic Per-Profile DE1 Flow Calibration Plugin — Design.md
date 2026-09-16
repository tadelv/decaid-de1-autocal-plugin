# Automatic Per-Profile DE1 Flow Calibration Plugin

## Status

Implementation-ready design for a Decaid plugin that automatically adjusts the connected DE1's flow-estimation multiplier when the active espresso profile changes.

The plugin owns calibration policy. Decaid remains responsible for workflow lifecycle events, shot persistence, machine identity, measurement capture, and the existing flow-calibration endpoint.

The implementation must follow the behavior defined here. Thresholds identified as v1 constants are not invitations to introduce alternate estimation algorithms.

---

# 1. Goals

The plugin shall:

1. React to Decaid workflow/profile changes.
2. Operate only on traditional DE1-family machines.
3. Never adjust Bengle or another non-DE1 machine.
4. Examine only the two latest shot-history records returned for the current profile title.
5. Require both records to represent the exact same serialized profile.
6. Require both records to come from the same physical DE1 currently connected.
7. Require both records to contain the flow multiplier active when the shot was recorded.
8. Require usable scale data in both historical shots.
9. Analyse only continuous extraction regions where:
   - pressure is sufficiently stable;
   - DE1-reported flow is sufficiently flat;
   - scale-derived weight flow is sufficiently flat;
   - machine and scale data overlap continuously.
10. Derive one calibration estimate from all qualifying regions of each shot.
11. Require the two shot-level estimates to agree before making a change.
12. Apply a bounded, damped correction through Decaid's existing calibration endpoint.
13. Keep machine-global calibration from leaking accidentally between profiles.
14. Fail closed whenever evidence, scale data, machine identity, API state, or shot quality is uncertain.
15. Keep history access intentionally small until Decaid provides more efficient profile-aware history search.

The plugin does not attempt to calibrate DE1 flow from first principles. Its purpose is the same practical one as the DE1app Graphical Flow Calibrator: align machine-estimated flow with gravimetric flow observed during previous extractions.

---

# 2. Non-goals

The first implementation shall not:

- support Bengle;
- support arbitrary future machine implementations;
- scan deep shot history;
- paginate shot history;
- search backwards when one of the two latest records is unusable;
- calibrate immediately after a shot;
- calibrate without scale data;
- infer gravimetric flow from machine data;
- substitute DE1 integrated volume for scale measurements;
- alter calibration during an espresso shot or other active machine operation;
- use bean, grinder, dose, yield, or workflow-context information to identify a profile;
- use machine learning;
- fit long-term adaptive models;
- smooth or rewrite historical measurement data;
- fit an arbitrary machine-to-scale timing offset;
- select a visually convenient region by heuristic;
- automatically restore calibration during plugin shutdown;
- infer missing historical machine identity or flow calibration.

---

# 3. Required permissions

The manifest shall request:

```json
{
  "permissions": [
    "log",
    "api",
    "pluginStorage",
    "events.workflow",
    "events.shots"
  ]
}
```

Responsibilities:

- `events.workflow`
  - primary calibration trigger;
- `events.shots`
  - `shotStored` marks history as changed;
- `api`
  - calls Decaid's localhost REST API;
- `pluginStorage`
  - stores per-machine baseline/ownership state;
- `log`
  - records calibration decisions.

`events.machine` is not required in v1.

If there is no usable DE1 connected when a workflow event is processed, the plugin does not poll or wait for a later machine connection. It evaluates again on the next relevant `workflowUpdated`.

---

# 4. Exact DE1 eligibility

Before reading history, call:

```text
GET /api/v1/machine/info
```

`MachineInfo` exposes `version`, `model`, `serialNumber`, `GHC`, and `extra`; `/api/v1/machine/info` returns that public representation.  

For v1, the machine is eligible only when `model` is exactly one of:

```text
DE1
DE1Plus
DE1Pro
DE1XL
DE1Cafe
DE1XXL
DE1XXXL
```

These names come from Decaid's canonical `DecentMachineModel` enum. `Bengle` and `Unknown` are separate values. 

The following are explicitly ineligible:

```text
Unknown
Bengle
anything else
```

Do not implement:

```javascript
model.startsWith("DE1")
```

or another heuristic.

The current machine must additionally have a usable `serialNumber`.

Treat these as unavailable:

```text
null
undefined
""
"0"
```

If model or serial identity is unavailable, stop before accessing history.

The same DE1 model/serial check is repeated immediately before the calibration write.

---

# 5. Scale data is mandatory

Automatic calibration requires gravimetric evidence.

This is a hard functional requirement, not merely a quality preference.

A historical shot without usable scale data cannot contribute any calibration estimate.

Decaid stores each measurement as a machine snapshot plus an optional scale snapshot. A scale snapshot contains independent timestamp, weight, and `weightFlow` values.  

Therefore:

```text
machine data only
    != calibration evidence

machine flow + integrated DE1 volume
    != calibration evidence

machine flow + usable scale weight/weightFlow
    == potential calibration evidence
```

Both of the two historical shots must contain sufficient scale data to form at least one qualifying simultaneous-flat region.

If either shot does not:

```text
no_scale_data
```

and no new calibration estimate may be applied.

Do not search for an older replacement shot.

## 5.1 Baseline restoration exception

If insufficient/missing scale evidence is encountered while the machine currently holds a multiplier that this plugin previously installed for another profile, the plugin may restore its saved machine baseline.

That restoration is allowed because it removes a plugin-owned profile-specific override.

It must not be interpreted as calibration derived from a scaleless shot.

---

# 6. Profile identity

For v1, "same profile" means:

> the complete normalized `workflow.profile` JSON returned by Decaid is structurally identical.

Do not decide which profile fields are "semantically meaningful."

Do not strip:

- title;
- author;
- notes;
- version;
- targets;
- temperatures;
- steps;
- limiters;
- any other serialized profile field.

The current Profile model serializes those fields directly. 

This is intentionally conservative.

## 6.1 Canonical representation

Object key ordering must not affect equality.

Canonicalize recursively:

```javascript
function canonicalize(value) {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }

  if (value && typeof value === "object") {
    return "{" +
      Object.keys(value)
        .sort()
        .map(
          key => JSON.stringify(key) + ":" + canonicalize(value[key])
        )
        .join(",") +
      "}";
  }

  return JSON.stringify(value);
}
```

Array order is preserved.

The canonical JSON string is used directly for equality.

Do not introduce a hashing dependency solely for profile matching.

Workflow ID is not part of profile identity.

Workflow context is not part of profile identity.

---

# 7. Persistent plugin state

Persist one versioned object:

```json
{
  "version": 1,
  "machines": {
    "<serialNumber>": {
      "baselineMultiplier": 1.0,
      "lastPluginAppliedMultiplier": 0.94,
      "ownsCurrentMultiplier": true
    }
  }
}
```

No per-profile learned multiplier needs to be persisted.

Shot history remains the source of calibration evidence.

## 7.1 Storage hydration

On `onLoad`:

1. mark persistent state as not ready;
2. issue one plugin-storage read;
3. retain the most recent workflow event received while storage is loading;
4. do not perform calibration writes before storage hydration completes;
5. after storage is ready, process the retained workflow if one exists.

Decaid's plugin host provides asynchronous namespaced storage reads/writes through `host.storage`. 

Malformed or unknown-version stored state must be ignored and replaced with an empty v1 state.

---

# 8. Runtime state

Minimum runtime state:

```javascript
{
  storageReady: false,

  activeProfileCanonical: null,
  activeProfileTitle: null,

  generation: 0,

  historyRevision: 0,
  lastEvaluatedHistoryRevision: -1,

  pendingWorkflow: null
}
```

`generation` protects against stale asynchronous work.

`historyRevision` protects against losing a `shotStored` event that occurs while analysis is in progress.

---

# 9. Event semantics

## 9.1 `workflowUpdated`

For every event:

1. canonicalize `payload.profile`;
2. determine whether the profile differs from `activeProfileCanonical`;
3. determine whether shot history has changed since the last successful evidence read.

Run calibration evaluation when:

```text
profile changed
OR
historyRevision > lastEvaluatedHistoryRevision
```

Otherwise ignore the event.

A switch:

```text
A -> B -> A
```

therefore evaluates A again.

A repeated A event with no new history does not.

## 9.2 `shotStored`

Decaid broadcasts `shotStored` only after a shot has finished persisting and includes its ID. 

`shotStored` performs no REST call and does not alter calibration.

It only performs:

```javascript
historyRevision++;
```

The next relevant `workflowUpdated` consumes the new evidence.

Thus:

```text
load A
  -> calibrate from previous shots

pull A
  -> shotStored
  -> no calibration change

reload A or later return to A
  -> new history is considered
```

If `shotStored` occurs during analysis, the evaluation retains the history revision with which it began.

On completion:

```javascript
lastEvaluatedHistoryRevision = capturedRevision;
```

not the newest current revision.

A shot stored during analysis therefore remains dirty.

## 9.3 `shotUpdated`

Ignore `shotUpdated` in v1.

Shot measurements cannot be edited by the normal shot update endpoint, so annotation edits must not trigger calibration work. 

---

# 10. Generation and race protection

Every processed workflow evaluation receives:

```javascript
const myGeneration = ++state.generation;
```

Before any machine write, require:

```javascript
myGeneration === state.generation
```

and:

```javascript
state.activeProfileCanonical === expectedProfileCanonical
```

If another profile has arrived, abandon the old calculation.

Never allow:

```text
analyse A
switch to B
A finishes
write A multiplier to B
```

---

# 11. History access contract

History access is intentionally bounded.

## 11.1 List request

Make exactly one filtered list request:

```text
GET /api/v1/shots
    ?profileTitle=<URL-encoded exact profile title>
    &limit=2
    &offset=0
    &order=desc
```

Decaid's handler accepts those fields, clamps `limit` to 1–100, returns measurement-free summaries, and uses descending timestamp ordering unless `order=asc` is explicitly requested. 

The underlying database query orders descending by timestamp for this case. 

The plugin nevertheless specifies:

```text
order=desc
```

explicitly.

Do not:

- request more than two;
- paginate;
- retry with a larger limit;
- fall back to unfiltered history.

## 11.2 Summary validation

Exactly two summaries are required.

If fewer than two:

```text
insufficient_history
```

and stop.

Both summaries must satisfy:

```text
canonicalize(shot.workflow.profile)
    == current profile canonical representation

shot.workflow.machine.provenanceStatus
    == "captured"

shot.workflow.machine.model
    is an allowed DE1 model

shot.workflow.machine.serialNumber
    == currently connected DE1 serial

shot.workflow.machine.flowCalibration
    is finite and > 0
```

`WorkflowMachine` explicitly stores provenance status, historical flow calibration, serial, model and firmware version. 

If either summary fails, stop.

There is no search for shot #3.

## 11.3 Full measurement fetch

Only after both summaries pass, fetch exactly those two complete shots.

Preferred current form:

```text
GET /api/v1/shots?ids=<id1>&ids=<id2>&order=desc
```

The exact-ID path returns full `ShotRecord.toJson()` records including measurements. 

Do not include `profileTitle` on this request.

Verify that exactly the two requested IDs were returned.

Then revalidate profile identity, DE1 identity and historical multiplier against the full records.

---

# 12. Historical multiplier normalization

For a historical shot:

```text
Cold = shot.workflow.machine.flowCalibration
```

and recorded machine flow:

```text
Fm(t)
```

the underlying unscaled estimate is:

```text
Fbase(t) = Fm(t) / Cold
```

The desired calibration is a multiplier `C` such that:

```text
C × Fbase(t)
```

matches gravimetric flow.

Every shot must therefore be normalized by its own recorded flow multiplier before it contributes evidence.

Never directly compare raw DE1 flow from shots recorded under different multipliers.

---

# 13. Flat-region definition

The plugin analyses only regions where **all three relevant curves are simultaneously stable**:

```text
pressure
DE1 machine flow
scale weight flow
```

A flat-pressure region whose machine flow is changing is not usable.

A flat machine-flow region whose weight flow is still rising or falling significantly is not usable.

A stable machine trace without continuous scale data is not usable.

The estimator works from the intersection of independently continuous machine-flat and scale-flat intervals.

---

# 14. Machine-flat intervals

Treat each adjacent machine-sample pair:

```text
A -> B
```

as one candidate machine edge.

Let:

```text
dt = B.timestamp - A.timestamp
```

in seconds.

The edge is eligible only when:

```text
0 < dt <= 0.500 s
```

and **both** A and B satisfy:

```text
state.state == "espresso"

pressure >= 2.0 bar

flow >= 0.5 ml/s

all relevant numeric fields finite
```

Then calculate:

```text
pressureSlope =
    (B.pressure - A.pressure) / dt

machineFlowSlope =
    (B.flow - A.flow) / dt
```

Require:

```text
abs(pressureSlope) <= 0.35 bar/s

abs(machineFlowSlope) <= 0.35 ml/s²
```

No smoothing is performed first.

The stored DE1 machine flow values are used exactly as recorded.

Consecutive eligible edges sharing endpoints are merged into one machine-flat interval.

Any failed edge ends the interval.

---

# 15. Scale-flat intervals

Scale snapshots may appear repeatedly alongside several faster machine samples because shot records attach the latest sufficiently fresh scale value to machine snapshots. Decaid itself discards a scale sample from shot capture when it is disconnected, belongs to the wrong connection generation, or is at least two seconds stale. 

For calibration, the plugin applies a stricter continuity requirement.

## 15.1 Deduplication

Before scale analysis, extract all non-null scale snapshots and deduplicate them by:

```text
scale.timestamp
```

Multiple recorded occurrences of the same scale timestamp represent one scale observation.

Sort unique observations chronologically.

If fewer than two distinct scale timestamps exist in the shot:

```text
no_scale_data
```

## 15.2 Pair eligibility

For each adjacent distinct scale pair:

```text
A -> B
```

calculate:

```text
dt = B.timestamp - A.timestamp
```

The scale edge is eligible only when:

```text
0 < dt <= 1.000 s
```

and both endpoints satisfy:

```text
weight >= 5.0 g

weightFlow >= 0.3 g/s

weight finite

weightFlow finite
```

Then calculate:

```text
weightFlowSlope =
    (B.weightFlow - A.weightFlow) / dt
```

Require:

```text
abs(weightFlowSlope) <= 0.35 g/s²
```

No additional smoothing is performed.

Use Decaid's recorded `weightFlow` directly.

Consecutive eligible edges sharing endpoints are merged into one scale-flat interval.

Any failed edge ends the interval.

---

# 16. Simultaneous-flat regions

The final usable regions are the time intersections between:

```text
machine-flat intervals
AND
scale-flat intervals
```

For every overlapping pair:

```text
start = max(machineStart, scaleStart)
end   = min(machineEnd, scaleEnd)
```

Keep it only when:

```text
end - start >= 3.0 seconds
```

These resulting intervals are the **only** data analysed for flow calibration.

They are disjoint after interval merging.

Use **all** qualifying simultaneous-flat regions.

Do not select only the longest one.

Do not rank regions by:

- pressure;
- flow rate;
- duration;
- profile frame;
- visual quality;
- extraction phase.

If there are no qualifying simultaneous-flat regions:

```text
insufficient_stable_region
```

Reject the shot.

---

# 17. Boundary interpolation

A simultaneous-flat interval boundary may fall between recorded samples.

For each interval:

```text
[Tstart, Tend]
```

linearly interpolate as necessary.

For machine data, interpolate:

```text
machine.flow
```

at `Tstart` and `Tend`.

For scale data, interpolate:

```text
scale.weight
```

at `Tstart` and `Tend`.

Interpolation is permitted only between two surrounding samples that already belong to the corresponding flat interval.

No extrapolation is allowed.

No interpolation is required for `weightFlow` when computing the multiplier; `weightFlow` is used to determine interval flatness.

---

# 18. Per-region calibration evidence

For each simultaneous-flat region `r`:

```text
[Tstart, Tend]
```

with historical flow multiplier:

```text
Cold
```

calculate normalized machine flow:

```text
Fbase(t) = machine.flow(t) / Cold
```

Integrate it with trapezoidal integration over actual machine timestamps:

```text
baseVolume_r =
    integral(Tstart..Tend) Fbase(t) dt
```

Require:

```text
baseVolume_r > 0
```

and finite.

Calculate gravimetric output:

```text
weightGain_r =
    weight(Tend) - weight(Tstart)
```

Require:

```text
weightGain_r > 0
```

and finite.

Do not integrate `weightFlow` to obtain output weight.

The stored weight-flow signal is used only as the independent flatness requirement.

This avoids treating repeated or filtered flow estimates as the primary gravimetric quantity.

---

# 19. Per-shot estimate across all flat regions

If a shot contains qualifying simultaneous-flat regions:

```text
R1, R2, ... Rn
```

calculate:

```text
totalBaseVolume =
    sum(baseVolume_r)

totalWeightGain =
    sum(weightGain_r)
```

Then:

```text
Cshot =
    totalWeightGain / totalBaseVolume
```

This is intentionally equivalent to weighting each region by the amount of normalized DE1 flow evidence it contains.

Do not:

- average region ratios equally;
- choose the visually best region;
- choose only the longest region;
- fit a regression across non-flat shot portions.

Require `Cshot` to be:

- finite;
- positive;
- within the configured automatic multiplier range.

An out-of-range shot estimate is rejected.

Do not clamp an invalid shot estimate into validity.

---

# 20. Why both flow signals must be flat

The plugin is trying to estimate a multiplicative relationship:

```text
gravimetric flow
≈
flowMultiplier × DE1 base flow
```

That relationship is safest to estimate during quasi-steady extraction.

During rapid transitions:

```text
DE1 flow rises first
scale response lags
puck retention changes
scale filtering contributes phase delay
```

A ratio measured there can describe transient dynamics rather than calibration.

Therefore the v1 estimator deliberately ignores transition regions even when they contain substantial volume.

A longer convergence time is preferred over calibrating from dynamically mismatched signals.

---

# 21. Combining exactly two shots

Both latest shots must independently produce valid:

```text
C1
C2
```

## 21.1 Agreement requirement

Calculate:

```text
mean = (C1 + C2) / 2

relativeDifference =
    abs(C1 - C2) / mean
```

Require:

```text
relativeDifference <= 0.10
```

Otherwise:

```text
shots_disagree
```

and make no calibration change.

## 21.2 Profile estimate

When they agree:

```text
Cestimated = (C1 + C2) / 2
```

Use the arithmetic mean.

Do not weight one shot more heavily because it contains more flat-region data.

Region evidence is weighted within each shot, but the two historical shots receive equal final influence.

---

# 22. Baseline and ownership model

DE1 flow calibration is machine-global while plugin behavior is profile-specific.

Each DE1 serial therefore stores:

```text
baselineMultiplier
lastPluginAppliedMultiplier
ownsCurrentMultiplier
```

## 22.1 First observation

If no persisted state exists:

```text
baselineMultiplier = current flowMultiplier
lastPluginAppliedMultiplier = null
ownsCurrentMultiplier = false
```

Persist before the first automatic write.

## 22.2 After a plugin write

After successful POST and verification GET:

```text
lastPluginAppliedMultiplier = verified value
ownsCurrentMultiplier = true
```

## 22.3 External/manual override

At the start of every evaluation:

```text
GET /api/v1/machine/calibration
```

If ownership is true but:

```text
abs(
  currentMultiplier - lastPluginAppliedMultiplier
) > 0.0015
```

then another actor changed calibration.

Treat current value as a manual/external override:

```text
baselineMultiplier = currentMultiplier
lastPluginAppliedMultiplier = null
ownsCurrentMultiplier = false
```

Persist and abort this evaluation.

Do not immediately overwrite the override.

## 22.4 Insufficient evidence or missing scale data

When current history cannot produce two trustworthy estimates:

```text
if ownsCurrentMultiplier:
    restore baselineMultiplier
else:
    do nothing
```

This includes:

```text
insufficient_history
profile_mismatch
different_machine
missing_historical_multiplier
no_scale_data
insufficient_stable_region
invalid_shot_estimate
```

Baseline restoration removes a plugin-owned multiplier left over from another profile.

It is not a calibration estimate derived from missing evidence.

After verified restoration:

```text
ownsCurrentMultiplier = false
lastPluginAppliedMultiplier = null
```

If restoration fails, retain ownership state.

---

# 23. Calculating the applied correction

Let:

```text
Ccurrent
Cestimated
```

## 23.1 Deadband

If:

```text
abs(Cestimated - Ccurrent) < 0.01
```

do nothing.

## 23.2 Damping

Default:

```text
D = 0.5
```

Calculate:

```text
dampedCorrection =
    (Cestimated - Ccurrent) × D
```

## 23.3 Maximum actual adjustment

Default:

```text
MaxAdjustment = 0.10
```

Calculate:

```text
appliedCorrection =
    clamp(
      dampedCorrection,
      -MaxAdjustment,
      +MaxAdjustment
    )
```

Then:

```text
target =
    Ccurrent + appliedCorrection
```

`MaxAdjustment` describes the actual maximum write delta.

## 23.4 Operational range

Clamp to:

```text
MinimumMultiplier .. MaximumMultiplier
```

Default:

```text
0.35 .. 2.0
```

The underlying DE1 `calFlowEst` register itself has a broader encoded supported range of 0.13–2.0. 

The plugin's 0.35 lower bound is intentionally more conservative.

## 23.5 Resolution

Round target to:

```text
0.001
```

before POST.

If rounded target equals current within:

```text
0.0015
```

do not write.

---

# 24. Machine-state safety

Immediately before POST:

```text
GET /api/v1/machine/state
```

Accepted states:

```text
idle
heating
preheating
sleeping
```

Any other state:

```text
machine_busy
```

and abort.

There is:

- no retry loop;
- no polling;
- no timer waiting for idle.

A later workflow event may try again.

---

# 25. Final identity check

Immediately before POST:

```text
GET /api/v1/machine/info
```

Require:

```text
model still in explicit DE1 allowlist

AND

serialNumber == serial captured at evaluation start
```

Otherwise:

```text
machine_changed_during_analysis
```

and abort.

---

# 26. Calibration write

Use Decaid's existing API:

```text
POST /api/v1/machine/calibration
Content-Type: application/json
```

Body:

```json
{
  "flowMultiplier": 0.943
}
```

The route writes `flowMultiplier` through the queued DE1 device-write path. 

After successful POST:

```text
GET /api/v1/machine/calibration
```

and treat the returned multiplier as authoritative.

Only after successful verification may ownership state change.

---

# 27. Failure semantics

Every API, storage, parsing, or evidence failure is fail-closed.

Unless baseline restoration is explicitly required:

```text
failure => no machine write
```

A failure must not:

- fabricate scale evidence;
- infer gravimetric output from DE1 volume;
- use stale machine identity;
- advance baseline incorrectly;
- clear ownership incorrectly;
- search additional history;
- substitute cached shot measurements;
- retry indefinitely.

There is no automatic retry loop in v1.

A later workflow event may retry.

---

# 28. History revision completion

An evaluation captures:

```text
capturedHistoryRevision
```

Once the filtered history list has been read successfully, that evidence revision may ultimately be marked:

```text
lastEvaluatedHistoryRevision =
    capturedHistoryRevision
```

even when the evidence results in:

```text
insufficient_history
profile_mismatch
different_machine
missing_historical_multiplier
no_scale_data
insufficient_stable_region
shots_disagree
deadband
```

Those are valid evaluations of current evidence.

Do not advance it after transport, API or parsing failures that prevented evidence from being read.

---

# 29. Plugin unload and shutdown

`onUnload` and `shutdown` must not change machine calibration.

Persist plugin state if needed and invalidate current asynchronous work:

```javascript
state.generation++;
```

The last successfully written DE1 multiplier remains active.

Baseline restoration is performed only through normal active-plugin lifecycle logic.

---

# 30. Settings

Suggested v1 settings:

```json
{
  "Enabled": {
    "type": "boolean",
    "label": "Automatic flow calibration",
    "default": true,
    "description": "Automatically calibrate DE1 flow from the two latest matching gravimetric shots."
  },

  "Damping": {
    "type": "number",
    "label": "Adjustment damping",
    "default": 0.5,
    "description": "Fraction of the calculated calibration error applied per profile evaluation."
  },

  "MaxAdjustment": {
    "type": "number",
    "label": "Maximum adjustment",
    "default": 0.1,
    "description": "Maximum multiplier change automatic calibration may apply in one evaluation."
  },

  "MinimumMultiplier": {
    "type": "number",
    "label": "Minimum multiplier",
    "default": 0.35,
    "description": "Lowest multiplier automatic calibration may use."
  },

  "MaximumMultiplier": {
    "type": "number",
    "label": "Maximum multiplier",
    "default": 2.0,
    "description": "Highest multiplier automatic calibration may use."
  },

  "DryRun": {
    "type": "boolean",
    "label": "Dry run",
    "default": false,
    "description": "Calculate and log decisions without changing DE1 calibration."
  }
}
```

The following are **implementation constants**, not settings:

```text
history depth                     = 2
required accepted shots           = 2

minimum pressure                  = 2.0 bar
minimum machine flow              = 0.5 ml/s
minimum scale weight              = 5.0 g
minimum weight flow               = 0.3 g/s

maximum pressure slope            = 0.35 bar/s
maximum machine-flow slope        = 0.35 ml/s²
maximum weight-flow slope         = 0.35 g/s²

maximum machine sample gap        = 500 ms
maximum distinct scale sample gap = 1000 ms
minimum simultaneous-flat region  = 3.0 s

maximum two-shot disagreement     = 10%
deadband                          = 0.01
```

Changing these constants requires an intentional plugin revision and corresponding regression tests.

---

# 31. Dry-run behavior

`DryRun=true` performs the complete decision process:

- DE1 validation;
- calibration read;
- two-record history request;
- full-shot request;
- scale-data validation;
- machine-flat construction;
- scale-flat construction;
- simultaneous-region intersection;
- per-shot estimation;
- two-shot agreement;
- state check;
- final DE1 identity check;
- target calculation.

It stops before POST.

Dry run must not:

- set ownership;
- change `lastPluginAppliedMultiplier`;
- pretend the target was applied.

It may establish the baseline for a previously unseen machine.

---

# 32. Logging

Every processed evaluation produces one final structured decision log.

Applied example:

```text
[auto-flow-cal]
action=apply
profile="Adaptive 9 bar"
machineModel=DE1Pro
machineSerial=12345
shotIds=a,b
shot1Regions=2
shot2Regions=1
shot1=0.932
shot2=0.946
estimate=0.939
current=0.900
target=0.920
```

No-scale example:

```text
[auto-flow-cal]
action=skip
profile="Adaptive 9 bar"
reason=no_scale_data
shotId=a
```

No-flat-overlap example:

```text
[auto-flow-cal]
action=skip
profile="Adaptive 9 bar"
reason=insufficient_stable_region
shotId=b
```

Defined reasons should include:

```text
disabled
no_machine
non_de1_machine
machine_identity_unavailable
insufficient_history
profile_mismatch
uncaptured_machine_provenance
different_machine
missing_historical_multiplier
history_fetch_failed
shot_fetch_failed
no_scale_data
insufficient_stable_region
invalid_shot_estimate
shots_disagree
deadband
external_override
machine_busy
profile_changed_during_analysis
machine_changed_during_analysis
calibration_write_failed
calibration_verify_failed
dry_run
```

Do not emit per-sample logs at normal logging levels.

---

# 33. Normative evaluation sequence

```text
workflowUpdated
    │
    ├─ storage ready?
    │    └─ no -> retain latest workflow
    │
    ├─ profile changed OR history dirty?
    │    └─ no -> stop
    │
    ├─ increment generation
    ├─ capture historyRevision
    │
    ├─ GET machine/info
    ├─ exact DE1 allowlist match?
    │    └─ no -> stop before history
    ├─ usable serial?
    │    └─ no -> stop before history
    │
    ├─ GET machine/calibration
    ├─ detect external override
    │
    ├─ establish baseline if required
    │
    ├─ GET latest 2 shots by profileTitle
    ├─ exactly 2?
    │    └─ no -> restore baseline if owned; stop
    │
    ├─ validate both summaries
    ├─ both valid?
    │    └─ no -> restore baseline if owned; stop
    │
    ├─ batch-fetch exactly those 2 full shots
    ├─ revalidate metadata
    │
    ├─ each shot has distinct scale data?
    │    └─ no -> restore baseline if owned; stop
    │
    ├─ for shot 1:
    │    ├─ build machine-flat intervals
    │    ├─ build scale-flat intervals
    │    ├─ intersect them
    │    ├─ keep every overlap >= 3 s
    │    ├─ integrate normalized machine flow
    │    ├─ measure scale weight gain
    │    └─ produce C1
    │
    ├─ same for shot 2 -> C2
    │
    ├─ both estimates valid?
    │    └─ no -> restore baseline if owned; stop
    │
    ├─ C1/C2 agree within 10%?
    │    └─ no -> no new calibration
    │
    ├─ estimated = arithmetic mean
    ├─ deadband
    ├─ damping
    ├─ maximum actual adjustment
    ├─ range clamp
    ├─ round to 0.001
    │
    ├─ generation/profile still current?
    │    └─ no -> stop
    │
    ├─ GET machine/state
    ├─ safe state?
    │    └─ no -> stop
    │
    ├─ GET machine/info
    ├─ same eligible DE1?
    │    └─ no -> stop
    │
    ├─ DryRun?
    │    └─ yes -> log and stop
    │
    ├─ POST machine/calibration
    ├─ GET machine/calibration
    ├─ persist verified ownership
    └─ log result
```

---

# 34. Estimator pseudocode

```javascript
function estimateShot(shot) {
  const oldMultiplier =
    shot.workflow.machine.flowCalibration;

  const machine =
    shot.measurements.map(x => x.machine);

  const scale =
    dedupeScaleByTimestamp(
      shot.measurements
        .map(x => x.scale)
        .filter(x => x != null)
    );

  if (scale.length < 2) {
    return reject("no_scale_data");
  }

  const machineIntervals =
    buildMachineFlatIntervals(machine);

  const scaleIntervals =
    buildScaleFlatIntervals(scale);

  const regions =
    intersectIntervals(
      machineIntervals,
      scaleIntervals
    ).filter(
      region => duration(region) >= 3.0
    );

  if (regions.length === 0) {
    return reject("insufficient_stable_region");
  }

  let totalBaseVolume = 0;
  let totalWeightGain = 0;

  for (const region of regions) {
    const baseVolume =
      integrateTrapezoidal(
        machine,
        region.start,
        region.end,
        sample => sample.flow / oldMultiplier
      );

    const startWeight =
      interpolateScaleWeight(
        scale,
        region.start
      );

    const endWeight =
      interpolateScaleWeight(
        scale,
        region.end
      );

    const weightGain =
      endWeight - startWeight;

    if (
      !Number.isFinite(baseVolume) ||
      baseVolume <= 0 ||
      !Number.isFinite(weightGain) ||
      weightGain <= 0
    ) {
      return reject("invalid_shot_estimate");
    }

    totalBaseVolume += baseVolume;
    totalWeightGain += weightGain;
  }

  const multiplier =
    totalWeightGain / totalBaseVolume;

  if (
    !Number.isFinite(multiplier) ||
    multiplier < settings.MinimumMultiplier ||
    multiplier > settings.MaximumMultiplier
  ) {
    return reject("invalid_shot_estimate");
  }

  return {
    accepted: true,
    multiplier,
    regionCount: regions.length,
    totalBaseVolume,
    totalWeightGain
  };
}
```

---

# 35. Required estimator tests

Pure estimator tests must cover:

1. historical multiplier normalization;
2. irregular machine sampling;
3. trapezoidal integration;
4. scale snapshot deduplication;
5. repeated scale snapshot does not increase evidence;
6. shot with no scale data is rejected;
7. shot with only one distinct scale timestamp is rejected;
8. pressure below minimum;
9. machine flow below minimum;
10. scale weight below minimum;
11. weight flow below minimum;
12. pressure slope above limit;
13. machine-flow slope above limit;
14. weight-flow slope above limit;
15. flat pressure but changing machine flow rejected;
16. flat machine flow but changing weight flow rejected;
17. flat machine flow and weight flow but changing pressure rejected;
18. machine timestamp reversal;
19. machine gap >500 ms splits interval;
20. scale gap >1000 ms splits interval;
21. overlap shorter than 3 seconds rejected;
22. multiple disjoint simultaneous-flat regions all contribute;
23. transition region between two flat regions does not contribute;
24. machine-flow interpolation at interval boundary;
25. scale-weight interpolation at interval boundary;
26. invalid/negative regional weight gain;
27. invalid base volume;
28. shot estimate below automatic range;
29. shot estimate above automatic range.

Synthetic normalization test:

```text
actual desired multiplier = 0.90

shot A:
  historical multiplier = 0.75

shot B:
  historical multiplier = 1.10

both must independently reconstruct approximately 0.90
```

Flatness fixture:

```text
0-5 s:
  machine flow rising
  weight flow rising
  -> excluded

5-12 s:
  pressure flat
  machine flow flat
  weight flow flat
  -> included

12-15 s:
  machine flow flat
  weight flow falling
  -> excluded

15-21 s:
  pressure flat
  machine flow flat
  weight flow flat
  -> included
```

The shot estimate must use exactly:

```text
5-12 s
+
15-21 s
```

and nothing else.

---

# 36. Required plugin tests

Integration tests must verify:

1. `Unknown` machine => no history request;
2. `Bengle` => no history request;
3. arbitrary future model => no history request;
4. each accepted traditional DE1 model passes;
5. serial `"0"` => no history request;
6. history request uses `limit=2`;
7. history request uses `order=desc`;
8. no pagination;
9. no fallback history search;
10. one history item => no calibration;
11. invalid first item + valid second => no shot #3;
12. same title but different exact profile => rejection;
13. different DE1 serial => rejection;
14. non-captured provenance => rejection;
15. missing historical multiplier => rejection;
16. full records fetched only after both summaries pass;
17. exactly two full records fetched;
18. either shot lacks scale data => no new calibration;
19. either shot has scale but no simultaneous-flat region => no new calibration;
20. both shots valid and agreeing => estimate;
21. two shots disagree >10% => no new calibration;
22. damping precedes maximum-adjustment cap;
23. target rounds to 0.001;
24. external manual override becomes new baseline;
25. external override is not replaced during same cycle;
26. missing-scale profile restores plugin-owned baseline;
27. missing-scale profile does not alter externally owned calibration;
28. baseline restoration clears ownership only after verification;
29. A -> B race cannot apply A calibration to B;
30. DE1 A -> DE1 B replacement aborts;
31. DE1 -> Bengle replacement aborts;
32. `shotStored` performs no REST call;
33. `shotStored` dirties history;
34. `shotStored` during analysis is not lost;
35. same-profile event without dirty history performs no query;
36. same-profile event after `shotStored` performs query;
37. machine busy => no POST and no retry timer;
38. REST failure => no fallback write;
39. DryRun => full analysis but no POST;
40. unload/shutdown => no calibration write.

---

# 37. Hardware acceptance

Initial real-machine validation must use:

```text
DryRun = true
```

For representative profiles:

1. select a profile;
2. inspect its two latest shots;
3. verify both contain valid scale data;
4. inspect machine-flow and weight-flow curves manually;
5. identify the visually flat overlapping sections;
6. verify the plugin selected those same regions;
7. compare the plugin's per-shot multiplier with a manually reasonable GFC value;
8. confirm transition regions were excluded;
9. pull another shot;
10. reload or leave-and-return to the profile;
11. verify the newest two shots are now used;
12. verify gradual convergence rather than oscillation.

Explicitly test:

```text
DE1 -> Bengle
Bengle -> DE1
DE1 A -> DE1 B
DE1 + no scale history
DE1 + partially missing scale history
```

No calibration may cross machine identity or be inferred without gravimetric evidence.

---

# 38. Recommended future Decaid API improvement

The current implementation must use:

```text
profileTitle + exact local profile comparison
```

because history does not yet expose a directly queryable canonical profile identity.

A future Decaid improvement should expose a stable content-derived profile ID and allow:

```text
GET /api/v1/shots
    ?profileId=<canonical-id>
    &limit=2
    &order=desc
```

Until that exists, do not compensate by scanning deeper history.

---

# 39. Implementation principle

A calibration decision in v1 must always be explainable as:

> The active machine was explicitly identified as this DE1. The two newest history entries returned for this exact profile were both captured on this same DE1 under known historical flow multipliers. Both shots contained genuine scale data. Within each shot, only continuous periods where pressure, DE1 flow and scale-derived weight flow were simultaneously stable were analysed. Transition regions and scaleless regions were ignored. After undoing each shot's historical flow multiplier, the gravimetric weight increase across those stable regions produced two compatible multiplier estimates. Their arithmetic mean produced the profile estimate, and a bounded damped correction was applied while the same DE1 and profile were still active.

If that statement cannot be made truthfully, the plugin does not derive or apply a new flow calibration.