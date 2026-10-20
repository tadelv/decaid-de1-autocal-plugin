# Streamline integration: where the applied calibration can show up

Research note on `decentespresso/streamline-js` at `d28da12` (v0.2.17 plus the
`feat/shot-companion-plugin` merge). Read from the repo itself:

| Source | What it settles |
|---|---|
| `docs/plugin-surfaces.md` | the declarative surface system, every kind, limits, actions |
| `docs/plugin-settings-ui.md` | the generated Extensions page, `hidden` settings, the `ui` **Open** link |
| `docs/calibration-endpoints.md` | what the skin already does about calibration, and the flow-multiplier gap |
| `src/modules/plugin-surfaces.js` | `parseSkinAnswer`, `callableEndpoint`, `liveEndpoint` — the validation the skin actually applies |
| `plugins/shot-companion.reaplugin/` | the reference plugin: `header-button`, `ui` overlay, `shot-strip`, `tile-hint`, `live` socket |
| `test/shot-companion-plugin.test.mjs` | the harness pattern: fake host + fake Decaid, every answer through `parseSkinAnswer` |

## TL;DR

- A plugin reaches the Streamline dashboard in four ways: the **settings form**
  generated from `manifest.settings` (no code), a **`skin` http endpoint**
  returning declarative surfaces, a **`ui` http endpoint** serving its own page
  (page navigation or an iframe overlay), and a **`websocket` endpoint** named by
  `live`, which makes the skin re-read `skin` on a push.
- No plugin JavaScript runs in the skin. The skin renders validated data with
  `textContent` and calls fixed actions. **It never writes calibration**, so this
  plugin stays the only writer and every safety rule (evidence, ownership,
  verification) still lives here.
- This plugin now answers `GET /api/v1/plugins/auto-flow-cal.reaplugin/status`
  (`schemaVersion: 1`, memory-only) and serves its record as a page from
  `GET .../ui` (v1.4.0). That page is the integration that needs no skin work at
  all: Streamline's Extensions screen gives it an **Open** button, and the same
  HTML is already overlay-ready (`?embed=1&theme=…` → `streamline:ready|size|close`).
- The remaining surfaces below are the dashboard-side additions; the smallest
  useful one is a `tile-line` under **Brew** that opens the page as an overlay.

## What the plugin can already say

| `/status` field | Meaning | What a skin could do |
|---|---|---|
| `machine.currentMultiplier` | multiplier read at the last evaluation | the number under Brew |
| `machine.calibration.baselineMultiplier` | pre-plugin value, per serial | "factory/other value X" in the page |
| `machine.calibration.lastPluginAppliedMultiplier` | last value the plugin wrote and verified | "applied 0.985" |
| `machine.calibration.ownsCurrentMultiplier` | current value is the plugin's | `active: true` on the line; a "restore" button |
| `profile.activeTitle` | profile of the last evaluation | which profile the numbers belong to |
| `evaluation.lastDecision` | `action` (`apply` / `dryRun` / `restore` / `skip`) + `reason` | why nothing happened; dry-run target |
| `evaluation.lastEvaluatedAt` | when | "5 min ago" |
| `evaluation.historyRevision` vs `lastEvaluatedHistoryRevision` | shot arrived, not yet evaluated | a "pending" hint |
| `plugin.enabled` / `dryRun` / `settings` | runtime config | mirror the switches in the page |

Everything above is from memory: `/status` makes no Decaid API call and mutates
nothing, which is exactly the discipline `skin` needs (2 s budget, must work with
the machine off).

## How the skin's plugin UI works

- **Discovery** — the skin lists plugins from `GET /api/v1/plugins` and reads
  `GET /api/v1/plugins/{id}/skin`. An answer that fails validation drops surfaces
  individually; an unknown `kind` is ignored rather than failing.
- **When it reads** — dashboard load, every minute, on focus/visibility (throttled
  to once per 2 s), and ~300 ms after any message on the plugin's `live` socket.
- **Surfaces** — at most 16 per plugin; one `header-button`, `screensaver-button`,
  `ratio-action`, `shot-strip`, `tile-hint`, `tile-line`, `tile-sync` per tile, up
  to three `tile-mode` per tile. Conflicting slots go to the plugin earlier in
  Decaid's list. Text caps: `tile-hint` 24, `tile-line`/`text` 40, `title` 80;
  ids are `[A-Za-z0-9_-]{1,40}`.
- **Actions** — `open` (the plugin's `ui` page, `page` or `overlay`), `call` (POST
  to a declared http endpoint), `set`/`step`/`stepsize` (tile values the skin owns).
  A `call` endpoint must be declared in `manifest.api` and may not be named
  `skin`, `settings`, `enable`, `disable`, `source`, `update`, `install`.
- **Settings page** — Streamline renders `manifest.settings` into an Extensions
  page with an enable switch and version/update status; an http `ui` endpoint adds
  an **Open** button carrying `returnTo`. A setting marked `"hidden": true` moves
  to the plugin's own UI, but its declaration must stay or Decaid discards the
  stored value.
- **Pages** — a `ui` response is rendered as a normal plugin page, or in a
  sandboxed iframe dialog (`presentation: "overlay"`, optional `fit` sizing,
  `size: "full"`, `closeOnShot`). Overlay pages post `streamline:ready`, optionally
  `streamline:size` / `streamline:numpad`, and `streamline:close`.

## Candidate integration points

| # | Surface | What it would show | Cost | Verdict |
|---|---|---|---|---|
| 1 | `tile-line` on `temperature` | `×0.985 own` under **Brew**, `active: true` while owned, `open` → the 1.4.0 page as an overlay | one `skin` handler, no new permission (already has `api`) | **next** |
| 2 | `ui` page (overlay, `fit`) | the whole record: profile, current/baseline/applied, ownership, last decision + reason, dry-run target, settings; optional "restore baseline" | **done in 1.4.0**: inline HTML in `plugin.js`, no new permission, live reads | **built** |
| 3 | `tile-hint` on `temperature` | last correction, e.g. `+0.05` (24 chars, pill under the value) | trivial | alternative to 1 if a pill reads better than a line |
| 4 | `menu-item` on `shot-history` | "Flow calibration" → overlay with `?shotId=`, estimating *that* shot from its measurements (preview only, never a write) | needs a `ui` page that runs `estimateShot` on a fetched shot | later, high diagnostic value |
| 5 | `menu-item` on `profile` | "Why no calibration?" — the last `skip` reason for this program | shows the *last* decision, not an arbitrary profile's, so it can mislead | later, with careful wording |
| 6 | `header-button` | entry point to the page | only **one** is drawn across all plugins and `shot-companion` claims it | no |
| 7 | `shot-strip` cell | a fixed-text cell during a shot | one strip across all plugins; our value does not move during a shot | no |
| 8 | `screensaver-button` | — | needs an `open` page to be useful; wakes nothing | no |
| 9 | `ratio-action`, `tile-sync`, `keepRatio`, `stepsize`, `telemetry-label` | — | all about dose/yield/grind/temperature setpoints | not applicable |

Example `skin` answer for #1 + #2 + #4:

```json
{
  "version": 1,
  "surfaces": [
    { "id": "cal", "kind": "tile-line", "tile": "temperature", "text": "×0.985 own", "active": true,
      "action": { "type": "open", "view": "record", "presentation": "overlay", "fit": true } },
    { "id": "why", "kind": "menu-item", "menu": "shot-history", "label": "Flow calibration",
      "action": { "type": "open", "view": "shot", "presentation": "overlay", "fit": true } }
  ],
  "live": { "endpoint": "changed" }
}
```

### Do not merge two different knobs

Streamline already edits calibration, and it is **not this one**:

- this plugin writes the machine-global `calFlowEst` multiplier through
  `POST /api/v1/machine/calibration` (`docs/calibration-endpoints.md` §3);
- Streamline's **Flow Estimation** page edits app-side, per-profile
  `weightFlowMultiplier` / `volumeFlowMultiplier` through `POST /api/v1/settings`
  (`src/modules/flow-calibration.js`), which are different numbers with different
  semantics.

A surface that shows one while the user thinks it is the other is worse than no
surface. Label the plugin's line for what it is (a machine flow multiplier), and
never let a page write app settings. Also note the POST above answers 202 for
*any* JSON body and ignores unknown keys — our existing verify-by-`GET` after the
write is what makes a write trustworthy, and any new writer must do the same.

## The one real gap: no push

Surfaces refresh on a minute poll unless the answer declares
`"live": { "endpoint": "changed" }` and the plugin holds a `websocket` endpoint
of that name (permission `emit`). Our value changes exactly when an evaluation
completes — a profile change or a new shot — which is precisely when the
dashboard should follow. Without push the line can lag up to a minute.

That is the only extra permission (`emit`) and the only extra manifest entry the
whole integration needs beyond `skin`/`ui`.

## Manifest and handler sketch

`status` and `ui` are implemented in 1.4.0. The `skin` endpoint and the push
socket below are the next step, not yet in the plugin:

```json
{
  "permissions": ["log", "api", "emit", "pluginStorage", "events.workflow", "events.shots"],
  "api": [
    { "id": "status", "type": "http", "data": {} },
    { "id": "ui", "type": "http", "data": {} },
    { "id": "skin", "type": "http", "data": {} },
    { "id": "changed", "type": "websocket", "data": {} }
  ]
}
```

```js
__httpRequestHandler: function (request) {
  if (request.endpoint === "status") return jsonResponse(request, 200, statusDocument());
  if (request.endpoint === "ui") return servePage(request);
  if (request.endpoint === "skin") {
    var doc = statusDocument();
    return jsonResponse(request, 200, {
      version: 1,
      surfaces: [calibrationLine(doc)],
      live: { endpoint: "changed" }
    });
  }
  return jsonResponse(request, 404, { error: "not_found" });
}
```

`calibrationLine` reads `doc.machine` only: `serial === null` → `surface: []` (no
line, so a Bengle or a machine-less Decaid shows nothing); otherwise
`"×" + doc.machine.currentMultiplier.toFixed(3)` plus `" own"` when
`ownsCurrentMultiplier`, `active` on the same condition.

## Constraints to keep in mind

- `skin` must answer inside ~2 s and must not depend on the machine: keep it on
  the memory-only status path (no `fetch`).
- The status route only exists while the plugin is loaded: a disabled plugin
  answers `404 {"error":"plugin with <id> not loaded"}` (verified on a running
  Decaid). Treat any 404 as "this plugin has nothing to say".
- Surfaces are per plugin and per tile slot; `shot-companion` holds grind, dose and
  drink, so Brew is the free tile.
- The `ui` page is served by Decaid with `X-Frame-Options: SAMEORIGIN`; when the
  skin runs from another origin (a dev server on `:8044` against Decaid on
  `:8080`) the `ui` response needs
  `Content-Security-Policy: frame-ancestors 'self' <skin origin>`.
- A `ui` page that writes must respect the same preconditions as an evaluation
  (machine idle, eligible serial, single writer) and should emit `{"what":"skin"}`
  before closing so the dashboard follows immediately.
- `/status` is unauthenticated on Decaid's localhost API: it exposes machine
  serials and calibration on the LAN. Acceptable for a tablet; say so in the UI.
- Test the skin answers with Streamline's own parser, as
  `test/shot-companion-plugin.test.mjs` does, so a surface the skin would drop
  fails in CI instead of disappearing on the tablet.

## Open questions

1. **Live vs last-read multiplier.** Showing the machine's *live* multiplier would
   need a Decaid read inside `skin` (costs the 2 s budget, fails with the machine
   off). The proposal above shows the last-read value and uses `active` to mean
   "this is the plugin's". Good enough, or worth a cached background refresh?
2. **A "restore baseline" button.** `restoreBaseline()` already enforces idle
   machine, identity and verification. A `call` endpoint would be ~10 lines, but a
   failed call only gets a short toast, so the page would have to re-read `/status`
   to show the outcome.
3. **Who displays it long-term.** If Streamline ever ships a native flow-multiplier
   control, this plugin should remain the policy and the skin the display — the
   `status` shape is the contract either way.
