# ADR-0012: active overlay memory and worker-owned preview preparation

- Status: accepted within the authorized M8 release repair
- Date: 2026-09-10

The former lifetime limit of 32 overlay nodes rejected long caption tracks.
The renderer now limits simultaneously active overlays to 32 and their RGBA
cache to 64 MiB. Half-open start/end events enforce the limit in Rust. A
manifest has at most 10,000 slot nodes; this remains a finite input budget.

Native rendering streams one RGBA plane into FFmpeg through stdin instead of
opening one image input for every cue. Rust evicts inactive rasters, composes
the active set in deterministic order, and reuses an unchanged composite.
The full-canvas frame has a separate 64 MiB bound. Browser rendering rasterizes
only active nodes and releases inactive surfaces. No lifetime pixel cache or
full-output ArrayBuffer is introduced. Cancellation closes the pipe/child.

Preview Wall manifest preparation now runs in its WASM worker. Only visible
wall tiles decode, serially; at most 24 manifests and one full-quality tile.
The comparison set follows matrix selection/focus. Matrix scrolling changes
its virtual rows, never the comparison set or the worker lifetime. This is
ephemeral UI policy, with no new campaign rules or persisted variants.

Evidence: `caption-stress-20260910` samples native/browser raster hashes and
active bytes across 1,000 cues over 2,500 seconds. It is not a complete
41-minute encoded-video run. `m8-stream-parity-20260910` exercises the actual
native pipe and browser encode with moving video, text and PNG at MAE <5.

Originals, manifest schema, timing, limits on variant cells, and codec policy
are unchanged. Existing exports remain immutable.
