# Automatic starts from the value your machine shows

**Auto Flow Calibration 2.0.3** changes what selecting **Auto** means. It now always starts learning from the **current machine multiplier** and never writes a calibration command to do it. A saved **Manual** value is kept separately and no longer seeds Automatic.

- **Auto starts from the live value.** If your machine shows **×1.000** and a Manual value of **2.000** is saved, selecting Auto starts at **×1.000** and sends **nothing** to the machine. If the machine shows ×2.000, Auto starts at ×2.000; no default value is invented.
- **A saved Manual value is remembered, not applied.** Manual **2.000** stays visible and is still offered in the Manual field while the card shows the live ×1.000 in Automatic. Selecting **Use manual** applies it again through the same guarded path as before. Typing in the Manual field never saves it, and selecting Auto never overwrites the remembered Manual value.
- **Learning carries on from new shots.** A genuinely new usable shot after the explicit Auto start can adjust the value as before. Shots that were recorded before that start — including ones whose event arrived late — cannot teach it.
- **Profile switches are unchanged.** Returning to a profile still recalls its last effective Automatic calibration or its active Manual choice, exactly as in 2.0.2. The remembered Manual value of an Automatic profile is not used for that recall.
- **2.0.2 recovery, guards and consent are unchanged.** An unresolved change still pauses the plugin and still needs **Check again** and an explicit confirmation; selecting Auto neither clears that pause nor approves the old expected value. A confirmed Manual reload now also updates the remembered Manual value, while an Automatic reload leaves it alone.
- **No new permission or storage key.** Same plugin ID `auto-flow-cal.reaplugin`, storage `calibration-v2`, schema version 2, endpoints and bounds.

**Still supervised:** the host's queued-write protection remains best-effort and is not atomic. Starting Automatic sends nothing, but learning and Manual choices still write under their existing guards. Do not start a shot, switch profiles or edit calibration while an update is pending.

<details>
<summary>Technical details — request contract, persistence and validation</summary>

## The reported case

2.0.2 works for the operator: a saved Manual value applies on a profile switch, and Automatic recalled an old value of 2.000 before any shot. The request was to keep Automatic starting at 1.000 while Manual 2.000 stayed available. Local acceptance record only; it is not a GitHub issue and nothing was published.

The final agreed rule is **Automatic always starts from the current machine multiplier**. An earlier "manual value first" idea was withdrawn: a remembered Manual 2.000 must never seed Automatic when the machine reads 1.000. Unsaved text in the Manual field is not a saved choice and cannot seed anything.

## What `POST …/mode` with `mode: "auto"` now does

- The request contract is unchanged: `POST /api/v1/plugins/auto-flow-cal.reaplugin/mode` with `{ "mode": "auto", "profileKey": "p:…", "context": "…" }`. A `value` field is ignored for Automatic, so form text can never become the starting value.
- The selection re-reads the pinned machine after settling queued workflow checks, then rebases **only** the selected profile's record (`programs[profileKey] = { target: live, applied: live }`) and the expected machine value to the freshly read multiplier. The machine baseline, other profiles, shot history and recovery audit data are untouched; the existing monotonic shot-exclusion fence is advanced to exclude pre-start shots.
- It sends **no** calibration command and performs no recall or activation. The response is `{ "saved": true, "profile": "…", "mode": "auto", "value": 1, "calibrationCommandSent": false }`. A stale page that still calls the old Auto path gets the same new behavior, so no caller can silently recall 2.000 while the page promises the unchanged live value.
- Shot history is fenced at the start exactly like an explicit mode change, so a shot whose stored event arrives later cannot teach the new starting point. A genuinely new shot still learns and applies under the existing guards.
- Explicit Automatic selection is now allowed **while already Automatic** (the UI no longer disables the button in that state); the backend no longer treats it as a no-op. Every other control condition — master enable, serial pin, hydrated valid ledger, ready and not paused state, idle machine, fresh context, no pending or in-flight work — is unchanged.

## Remembered Manual versus active Manual

The active Manual choice is still the `overrides["t:<title>"]` entry; its presence is what `profile.mode === "manual"` and `profile.manualValue` report. The remembered value is the new optional per-machine map `manual["t:<title>"]`:

- A saved or applied Manual choice writes both maps. Selecting Automatic deletes only the active override, so the remembered value survives mode changes, reads, hydration/restart and profile switches.
- A valid active override is always what the profile remembers, so hydration synchronizes it into the optional map. That also covers a map written by an earlier 2.0.3 start and then preserved untouched across a 2.0.2 round trip, where it may lack that entry or still hold an older one: the latest saved Manual choice is kept instead of being forgotten by a later Automatic selection. Memories without an active override are inactive and stay exactly as stored.
- Loading a 2.0.2 ledger without the new map derives it from the existing overrides, so an active Manual value is never lost and no schema migration or new key is introduced. Malformed entries (non-`t:` keys, blank titles, non-grid or out-of-range values) are validated before that synchronization and fail closed as `invalid_saved_state`, exactly like corrupt overrides, and never authorize a write.
- `status`/`view` keep `manualValue` as the active-mode value (null while Automatic) and expose `rememberedManual` additively for the page.
- A confirmed **Manual** reload (2.0.2) now also replaces the remembered value; a confirmed **Automatic** reload leaves it in place.

## Guards that did not change

Mode selection still cannot bypass stopped, disabled, unhydrated, invalid-ledger, unpinned, wrong-model, unsafe-state, busy, bounds, grid, acknowledgement, concurrency or stale-context checks. An unresolved calibration intent still holds the plugin: Automatic is refused with `409` and the intent is retained, because the existing recovery and its explicit settled confirmation remain the only way to clear it. Read-only polling gained nothing, and a Manual request still refuses to overwrite a value that changed outside the plugin (`503` with `external_change_detected`). Only an explicit Automatic selection treats a healthy expected-versus-live difference as the operator's decision to start from the live reading — it stores that reading and sends nothing back.

## Validation and limits

Automated tests only — no tablet, phone, emulator, ESP32, DE1, scale, BLE, firmware or native-storage work was performed for this release, and no hardware proof is claimed.

Coverage added in this version exercises the compiled bundle and the actual generated page client with a simulated DOM, transport and storage: Auto from live 1.000 despite an older Automatic 2.000, machine baseline and remembered Manual 2.000; a non-default live value with no Manual; the live value never changing to a recalled value; the remembered Manual staying visible, offered, retained across restart and reapplied by an explicit Manual choice; unsaved form text ignored; an explicit Automatic restart while already Automatic; new-shot learning versus a delayed pre-start shot; persistence failure and a lost acknowledgement; external expected-versus-live adoption only on explicit Automatic with no pending work; and unchanged guarded Manual, profile recall and recovery behavior. `test/plugin.test.js`, `test/calibration-ui.test.js`, `test/recovery-flow.test.js` and `test/auto-mode-flow.test.js` cover it against the generated page. The full local suite passes, including the optional real Streamline parser contract when that checkout is supplied; CI skips that optional case without it.

**Not validated:** physical machines, native Android storage durability and whether a host-queued command actually finished. An unacknowledged Automatic start claims no success even when the write afterwards proves to have landed; a reload then reads the committed record and reports it honestly. Queued-write protection remains best-effort: the plugin's reads and the host's command execution are not atomic, and no queue-cancellation or atomic-completion guarantee is added. No release, tag, zip upload, installation or publication is part of this work.

</details>
