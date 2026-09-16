# Implementation plan

1. **Package contract**
   - Create `auto-flow-cal.reaplugin/manifest.json` with the exact permissions and v1 settings from the design.
   - Keep the runtime dependency-free and compatible with Decaid's sandboxed JavaScript API.

2. **Pure calibration logic**
   - Implement recursive profile canonicalization, timestamp parsing, flat-edge merging, interval intersection, boundary interpolation, trapezoidal machine-flow integration, and per-shot estimation.
   - Enforce every v1 threshold as a constant and reject incomplete/non-finite evidence.

3. **Plugin lifecycle and policy**
   - Hydrate versioned per-machine storage before evaluating retained workflow events.
   - Handle `workflowUpdated`, `shotStored`, `shutdown`, and unload generation invalidation exactly as designed.
   - Validate the connected DE1, bounded two-shot history, exact profile/machine provenance, two-shot agreement, ownership/baseline state, machine safety, final identity, and verified calibration writes.
   - Produce one structured decision log per processed evaluation.

4. **Deterministic verification**
   - Use Node's built-in test runner and VM sandbox; add no runtime or test dependencies.
   - Cover the estimator edge cases and plugin event/API/race/ownership behavior required by the design.
   - Validate the manifest/package shape and run syntax checks.

5. **Distribution**
   - Document installation, settings, dry-run hardware acceptance, and development commands.
   - Add CI for tests and a tag-triggered release workflow that checks tag/manifest version parity and attaches exactly one installable `.zip` containing one plugin root.

6. **Delivery**
   - Commit each phase independently, create a public GitHub repository, push `main`, tag `v1.0.0`, and push the tag so GitHub Actions can publish the release asset.
