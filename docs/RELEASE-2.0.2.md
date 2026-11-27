# Keeping the value your machine reports

**Auto Flow Calibration 2.0.2** changes what **Check again** can do for a paused change. It now keeps the value the machine reports **in the profile's own mode** — Automatic stays Automatic, Manual stays Manual — and it still sends **no calibration command**.

- **A different reading is no longer a dead end.** The panel shows the multiplier that was requested and the value on the machine now. If you have checked that the previous change has finished, you can keep the current value even when those numbers differ.
- **Automatic profiles stay Automatic.** The checked value becomes that profile's new starting point. Nothing is recalled, no old value is re-sent, and the earlier attempt is not relabelled as verified. Only a genuinely new shot can adjust Auto again.
- **Manual profiles stay Manual.** The checked value replaces that profile's saved manual value, and its learned automatic value is kept for a later explicit Auto.
- **Everything else stays put.** Other profiles (such as a second profile in Manual 1.000), machine values, learned values and shot history are preserved. No ledger reset and no new permission.
- **The confirmation is deliberate.** Recovery is only offered for the same pinned machine, original profile and a safe between-shot state, after an explicit review. Confirm only when you have established that the previous operation finished.

**Still supervised:** a matching number — or a different one — cannot prove that an earlier queued command finished, and clearing the paused record cannot cancel a command already sent. If you cannot establish that it finished, leave the plugin disabled.

<details>
<summary>Technical details — request contract, persistence and validation</summary>

## The reported case

A 2.0.1 user updated, selected a profile, and tapped **Check again** with an original saved command of **2.000** while the machine read back **1.000**. 2.0.1 only offered recovery when the read-back equalled the command, so the pause could not be cleared without losing the value he wanted to keep. 2.0.2 adds an explicit, mode-preserving reload request for exactly that state. This file is the local acceptance record; it was not published as a GitHub issue, comment or forum reply.

## Request contract and backward compatibility

`POST /api/v1/plugins/auto-flow-cal.reaplugin/recover` now accepts an explicit discriminator:

```json
{ "context": "…", "profileKey": "p:…", "value": 1.000, "confirmSettled": true, "action": "reload_current" }
```

- Only `action: "reload_current"` accepts a read-back that differs from the paused command. Any other non-empty action is rejected with `400 unsupported_recovery_action`.
- A request **without** the discriminator keeps the 2.0.1 matching-only behavior: it can only adopt a read-back equal to the paused command, and it creates a Manual choice. A mismatch fails clearly (`409`) and the pause and saved request remain. An older page therefore cannot silently authorize a changed value, and it cannot report success while the controller keeps another mode.
- `value` must still equal the freshly read value; there is no free-form target. `0.350–2.000` and the `0.001` grid, the pinned supported serial/model, the original exact profile key, a safe between-shot state, master enable, a hydrated valid ledger and an explicit settled-operation confirmation all remain mandatory.
- No new endpoint, permission, dependency, storage key or schema migration: plugin ID `auto-flow-cal.reaplugin`, manifest `2.0.2`, storage `calibration-v2`.

## What a successful reload writes

The review (`GET …/view` while paused) reports the profile's mode, the paused command and the current read-back. The commit re-reads identity, profile, state and value, stages the update with the old intent retained, re-checks the same values, then persists the completion:

- Automatic: the profile's record becomes its new starting point (`target`/`applied` set to the checked value) and the machine expected value follows. No manual choice is created and no command is sent. A recovery-time cutoff is stored, so a pre-recovery shot delivered late is excluded even when there is no earlier saved history to fence against. A genuinely new shot can still learn.
- Manual: the named manual value and expected machine value are updated; the learned automatic record is untouched.
- Audit: `lastRecovery` keeps the original intent, the mode, the paused command, the accepted value and the previous selected-profile state (expected, baseline, program, override) under authority `operator_confirmed_reload_current`. The earlier failed attempt is never recorded as a verified automatic application.
- Retry: the preparation write keeps the old intent durable and marks the audit as `prepared`. If the completion fails, or a preparation acknowledgement is lost after the write landed, an explicit retry of that same retained intent reuses the first attempt's replaced-profile snapshot, original intent and cutoff (`attempts: 2`), so no attempt can overwrite the provenance it is auditing. Once the reload completes the audit is marked `completed`, so a later, even byte-identical, pause is audited from the current record instead of inheriting an old snapshot.
- Failure: persistence failures and missing acknowledgements retain the pause and the saved request, never report success and are never retried automatically. A storage acknowledgement timeout may follow a real durable write, so a reload handles both the retained-intent state and the fully committed state; both hydrate without dispatching a calibration command. A late acknowledgement arriving after the timeout is ignored.

## Consent is bound to one exact review

The recovery review reports a context that advances whenever something meaningful changes: machine identity, the read value, the machine state, the profile, the mode, the pending intent or the pause reason. A confirmation is only accepted for the exact review it was taken from, so a value that goes away and comes back — or a machine that becomes busy and idle again — does not restore an earlier confirmation; **Check again** is required again. Unchanged polling keeps the same context, so a normal confirmation still works. The epoch is not a defence against a change that happens and returns entirely between two reads; the host's reads and command execution are not atomic.

An optional persisted `recoveryCutoff` (host clock, used to exclude pre-recovery shots) is validated as a finite number on load, and a repeat reload keeps the later of the stored and current value, so a host clock that jumps backwards cannot widen an existing exclusion.

## Validation and limits

Automated tests only — no tablet, phone, emulator, ESP32, DE1, scale, BLE, firmware or native-storage work was performed for this release, and no hardware proof is claimed. The operator's original event timeline is not reproduced.

Coverage added in this version exercises the compiled plugin and the generated page client with simulated DOM, transport and storage: the reported Automatic 1.000-with-paused-2.000 flow, the Manual equivalent, mode preservation across hydration/restart, zero calibration commands during recovery and on reload, audit/previous-record retention including faulted-and-retried preparations, preservation of the other profile's Manual 1.000, delayed pre-recovery shot rejection against a controlled cutoff, new-shot Automatic behavior, stale/old-client rejection, stale-consent rejection after value and busy round-trips, unchanged-poll consent, typed-target rejection, invalid identities/states/value ranges/cutoffs, storage failures, missing and late acknowledgements and consent invalidation with no automatic retry. The full local suite passes, including the optional real Streamline parser contract when that checkout is supplied; CI skips that optional case without it.

**Not validated:** physical machines, Android durability and whether a host-queued command actually finished. The host's queued-write protection remains best-effort: the plugin's checks and the host command execution are not atomic. Native Android storage durability is also untested here. The pre-recovery cutoff is derived from the host clock at recovery time, and a repeat reload keeps the later stored value, so a large host/machine clock difference could delay the next Automatic learning; it only ever skips learning, never approves a command. No release, tag, zip upload, installation or publication is part of this work.

</details>
