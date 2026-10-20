# DE1 Auto Flow Calibration — Decaid plugin

Automatically adjusts a connected DE1's flow-estimation multiplier when the
active espresso profile changes, using only gravimetric evidence from the two
most recent shots recorded for that profile program.

The plugin is the calibration policy layer. Decaid keeps ownership of workflow
lifecycle events, shot persistence, machine identity, measurement capture and
the existing flow-calibration endpoint.

## What it does

On a workflow change (or after new history appears), the plugin:

1. Requires an eligible traditional DE1 (`DE1`, `DE1Plus`, `DE1Pro`, `DE1XL`,
   `DE1Cafe`, `DE1XXL`, `DE1XXXL`) with a usable serial number — never Bengle.
2. Reads the two newest shots whose profile title matches the active profile,
   and requires both to be the same extraction program (profile `version` and
   `steps`), captured on the same machine, with a usable recorded flow
   multiplier and scale data.
3. Finds the periods inside each shot where pressure, DE1 flow and scale weight
   flow are *all* simultaneously flat and continuous, and discards the rest.
4. Undoes each shot's historical multiplier, integrates the normalized machine
   flow over those flat regions, and divides the measured scale weight gain by
   that volume to get one multiplier per shot.
5. Requires the two shots to agree within 10%, then applies a damped,
   bounded, rounded correction through `POST /api/v1/machine/calibration` and
   verifies the result with a follow-up `GET`.

Every other outcome is fail-closed: no evidence, no write. Decisions are
reported as one structured `[auto-flow-cal]` log line per evaluation, using the
reasons from the design plus `calibration_read_failed` and `no_baseline` for
state the design leaves undefined, and the action `restore` for a verified
baseline restoration.

## Install

Requires a Decaid build whose plugin host exposes `events.workflow`,
`events.shots`, `api` and `pluginStorage` (permissions are declared in the
manifest).

Install from a GitHub release on the machine running Decaid:

```bash
curl -X POST http://localhost:8080/api/v1/plugins/install/github-release \
  -H 'content-type: application/json' \
  -d '{"repo": "OWNER/REPO"}'
```

Or copy `auto-flow-cal.reaplugin/` into Decaid's `plugins/` directory. To
develop without hardware, point a local Decaid at the directory and use
`PUT /api/v1/plugins/:id/source` plus a plugin reload to iterate.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Automatic flow calibration | on | Master enable. When off, no history is read. |
| Adjustment damping | 0.5 | Fraction of the measured error applied per evaluation. |
| Maximum adjustment | 0.1 | Hard cap on a single write's multiplier delta. |
| Minimum multiplier | 0.35 | Lower bound of the operational range. |
| Maximum multiplier | 2.0 | Upper bound of the operational range. |
| Dry run | off | Do the whole analysis, log the target, never write. |

## Status endpoint

The manifest declares one HTTP endpoint, `status`. It answers from memory — no
Decaid API call, no storage write, no state change — so it works with the
machine switched off and cannot race an evaluation:

```bash
curl -s http://localhost:8080/api/v1/plugins/auto-flow-cal.reaplugin/status
```

```json
{
  "schemaVersion": 1,
  "plugin": { "id": "auto-flow-cal.reaplugin", "version": "1.3.0",
    "enabled": true, "dryRun": false, "storageReady": true },
  "settings": { "Enabled": true, "Damping": 0.5, "MaxAdjustment": 0.1,
    "MinimumMultiplier": 0.35, "MaximumMultiplier": 2.0, "DryRun": false },
  "profile": { "activeTitle": "D-Flow / default" },
  "machine": { "serial": "12345", "model": "DE1Pro", "currentMultiplier": 0.8,
    "calibration": { "baselineMultiplier": 0.8, "lastPluginAppliedMultiplier": 0.85,
      "ownsCurrentMultiplier": true } },
  "machines": { "12345": { "baselineMultiplier": 0.8,
    "lastPluginAppliedMultiplier": 0.85, "ownsCurrentMultiplier": true } },
  "evaluation": { "historyRevision": 2, "lastEvaluatedHistoryRevision": 2,
    "lastEvaluatedAt": "2026-01-01T10:00:00.000Z",
    "lastDecision": { "action": "apply", "profile": "\"Profile\"", "estimate": "0.900",
      "current": "0.800", "target": "0.850" } }
}
```

- `machine` is the machine of the most recent evaluation; `machines` is every
  serial the plugin remembers. Both are `null`/empty before the first evaluation
  of an eligible DE1.
- `calibration` is the plugin's own baseline/ownership record, not a live read of
  the machine. `currentMultiplier` is the value the plugin read from the machine at
  the most recent evaluation; both only move when an evaluation runs, so a
  calibration changed by another app shows up after the next evaluation reports
  `external_override` and drops ownership.
- `evaluation.lastDecision` is the same structured record as the
  `[auto-flow-cal]` log line: `action` is `apply`, `dryRun`, `restore` or `skip`,
  with `reason` on anything but a successful write.
- `historyRevision > lastEvaluatedHistoryRevision` means a shot arrived that has
  not been evaluated yet (no profile change has followed it).
- Any other endpoint is answered with `404 {"error":"not_found"}`; the endpoint
  ignores method, body and query. (Decaid itself refuses an endpoint the manifest
  does not declare — `404 {"error":"endpoint <id> not available"}` — so that
  branch is defensive only.)
- The route exists only while the plugin is loaded: with the plugin disabled,
  `GET .../status` answers `404 {"error":"plugin with auto-flow-cal.reaplugin not
  loaded"}`. Skins must treat any 404 as "no status".

The shape is versioned (`schemaVersion`) because skins read it: see
[`STREAMLINE_INTEGRATION.md`](STREAMLINE_INTEGRATION.md).

## Baseline and ownership

DE1 flow calibration is machine-global, so the plugin remembers, per serial:

- `baselineMultiplier` — the value it found the first time it saw the machine;
- `lastPluginAppliedMultiplier` — the last value it wrote and verified;
- `ownsCurrentMultiplier` — whether the current value is the plugin's.

If the current multiplier moves away from `lastPluginAppliedMultiplier` by more
than `0.0015`, another actor changed calibration: the new value becomes the
baseline, ownership is dropped, and that evaluation stops without overwriting
it. When the active profile has no trustworthy evidence but the plugin owns the
current multiplier (left over from a different profile), it restores the
baseline — removing its own override, not inventing a calibration.

## Hardware acceptance

Validate on a real machine with **Dry run on** before enabling writes:

1. Select a profile and identify its two latest shots.
2. Confirm both shots have valid scale data.
3. Look at the machine-flow and weight-flow curves and note the visually flat
   overlapping sections.
4. Check the plugin selected the same regions and ignored the transitions.
5. Compare its per-shot multiplier against a reasonable manual graphical
   calibration value.
6. Pull another shot, reload the profile, and confirm the newest two shots are
   used and that the value converges instead of oscillating.

Also exercise DE1 → Bengle, Bengle → DE1, DE1 A → DE1 B, DE1 with no scale
history, and DE1 with partially missing scale history. No calibration may cross
machine identity or be applied without gravimetric evidence.

## Development

```bash
npm test    # manifest, estimator and plugin conformance suite (node --test, no dependencies)
npm run check
```

The tests load the production `plugin.js` into a `node:vm` sandbox with a mocked
host and `fetch`, and the fixtures mirror Decaid's real serialization (paginated
`{items,...}` history envelope, nested machine state, ISO-8601 timestamps), so
there is no duplicated logic to drift.

Releases: bump `version` in `auto-flow-cal.reaplugin/manifest.json`, tag
`vX.Y.Z` (the tag must match the manifest version), and the release workflow
attaches the single installable `.zip`.

## Design

`Automatic Per-Profile DE1 Flow Calibration Plugin — Design.md` is normative for
this implementation; `IMPLEMENTATION_PLAN.md` records how it was built.
