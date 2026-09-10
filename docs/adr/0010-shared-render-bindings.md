# ADR-0010: explicit master bindings and shared render contract

- Status: Accepted by the project owner, 2026-09-08.
- Scope: targeted correction of shared Rust rendering, M7 export and M4 binding UI; other accepted milestones are not rewritten.

The inspected M8/M7 implementations stretched video without applying the declared crop. RenderManifest omitted resolved slot values; legacy Slot stored an entity label and style fingerprint, not executable geometry. Successful job status did not establish render parity.

The owner approved explicit clip bindings and text/logo placement in the master model and M4 UI, preservation of old projects/snapshots, and actionable diagnostics for old unbound slots. Never invent placement, replace placeholder assets, mutate a frozen job, or reinterpret render_manifest as a campaign snapshot.

Rust is the single source for resolved nodes, geometry, timing, fit and validation. Native and WASM consume the same versioned immutable contract. Platform adapters only decode/encode and draw that plan. Corrected engine output uses a new engine identity and idempotency key; existing artifacts and legacy snapshots remain intact. New optional model fields are absent on legacy serialization to preserve its hash. Binding edits are scoped, named, undoable master commands.

Every text/logo placement and media-to-clip binding is explicit user input. Missing binding, missing real asset or unavailable pinned font blocks export with a diagnostic; it is never silently omitted or replaced by a demonstration value. Fonts retain pinned bytes, revision, hash and full license receipt.

Required closure evidence: legacy round-trip/hash, binding scope/history/no-op, full resolved-node serialization, native/WASM geometry and raster parity, crop/text/logo/replacement rendered output, and affected M7 plus M8 browser failure gates. This ADR records authorization, not a GREEN verification claim.
