Resolve the three policy blockers below before implementation acceptance.

## Review

**Correct:** The draft retains usable changed-setup/low-flow evidence, removes hard two-shot agreement, and distinguishes learned targets from verified settings. The section 4 arithmetic is correct. Research claims are appropriately limited; prospective convergence remains unproven.

### 1. P1 — Client-side checks cannot guarantee manual precedence or idle-only writes

**Anchors:** `docs/research/adaptive-update-policy-draft.md:97,104–108`.

**Counterexample:** The final GET confirms idle state and calibration `1.130`. A manual actor changes calibration—or a shot starts—before the queued POST executes. The command can overwrite the manual value or execute during extraction despite all prescribed checks passing.

The documented API sends only `flowMultiplier` through a queued device-write path; no atomic preconditions are specified (`Automatic Per-Profile DE1 Flow Calibration Plugin — Design.md:1276–1293`).

**Expected outcome:** Reject stale commands at execution time, not merely detect them afterward.

**Minimal repair:** Make host-side execution-time identity/state/expected-calibration guards an explicit prerequisite for these guarantees. Otherwise describe the protection as best-effort, document the remaining race, and require separate acceptance of that limitation before automatic trials. Add a mocked interleaving between final GET and command execution.

### 2. P1 — The command formula can violate its own bounds

**Anchors:** `docs/research/adaptive-update-policy-draft.md:58–64,128`.

**Counterexample:** With `A = 1.130`, `maximumMultiplier = 1.2296`, and target `1.2296`, the formula rounds the clamped result to `1.230`, exceeding the configured maximum.

**Expected outcome:** Every command satisfies range, physical delta and machine resolution simultaneously.

**Minimal repair:** Define the feasible grid interval using the ceiling of the lower bound and floor of the upper bound at resolution `0.001`. Select the nearest target within that interval; hold visibly if it is empty. Apply deadband afterward using stable decimal/grid comparisons. Specify this example’s expected command as `1.229`.

### 3. P1 — First-use baseline fallback has no defined capped-transition outcome

**Anchors:** `docs/research/adaptive-update-policy-draft.md:41,94–96,124`.

**Counterexample:** Baseline is `1.130`; another program leaves verified calibration at `1.500`. Selecting a new program permits only a capped move to `1.400`. Baseline restoration is incomplete, yet section 3 requires a verified pre-shot tracking seed and section 6 prohibits treating failed restoration as successful.

The draft does not say whether the next usable shot trains from `1.400`, remains diagnostic, or authorizes another baseline-restoration command.

**Expected outcome:** One deterministic initialization and next-shot behavior, without silently inheriting another program’s target or introducing a polling staircase.

**Minimal repair:** Add an explicit pending-baseline state and acceptance example. Define whether partial verified restoration permits learning from the actual pre-shot value, or holds learning until baseline is reached; specify the permitted trigger for further restoration.

## Proposal completeness versus human acceptance

- **Proposal completeness:** Blocked by the three protocol ambiguities/contradictions above.
- **Human acceptance:** Gain/cap/deadband, manual-override prerequisite, and estimator safeguards remain legitimate maintainer decisions—not evidence that this draft is accepted.
- **Scope:** Read-only source review; no edits, network access, or test execution. Oracle tooling was unavailable, so this is independent reviewer advice only.
- **Merge verdict:** **BLOCK implementation acceptance**, not continued documentation/research.

NEEDS REVISION