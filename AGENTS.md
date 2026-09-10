# AGENTS.md

## Mission and current phase

This repository is transforming OpenCut Classic into **VariantLab**, a creative-operations studio that produces controlled advertising variants from one master timeline.

VariantLab is a working codename until trademark clearance. Do not use the OpenCut name or logo as the new product brand, imply endorsement, or remove the original attribution.

The current phase is **research, specification, and planning only**. Do not implement the transformation or modify application source until the user explicitly asks for implementation. The source documents are:

- docs/BASELINE_AUDIT.md — evidence-backed current state;
- docs/PRODUCT_OPTIONS.md — evaluated directions and decision;
- docs/TRANSFORMATION_SPEC.md — product contract;
- docs/ARCHITECTURE.md — target boundaries and invariants;
- PLAN.md — vertical delivery milestones.

Follow the user's latest instruction first, then product behavior in TRANSFORMATION_SPEC.md, architecture in ARCHITECTURE.md, and delivery order in PLAN.md. Do not silently resolve contradictions. Record one-way-door changes as ADRs.

## Architecture

All platform-agnostic business logic belongs in rust/. Each app under apps/ is a UI shell: it owns rendering, interaction and platform concerns, but never business logic. The UI framework is replaceable.

Do not perform a horizontal “rewrite everything in Rust.” Move a bounded rule inside a vertical user scenario, add native/WASM parity tests, connect UI through generated contracts, and remove the duplicate TypeScript rule in the same slice.

### rust/

Rust owns:

- versioned campaign, sequence, slot, variant, diagnostic and job models;
- timeline math, trim/split/move/ripple/snapping and rational media time;
- commands, validation, transactions, scoped history and inverse operations;
- variant inheritance, limits, resolution, invalidation and fingerprints;
- media, transcript, derivative, render and codec planning;
- sync envelopes, job state machines and deterministic errors.

rust/ contains no React components, hooks, DOM/browser framework imports or platform persistence calls. Native and WASM must produce the same snapshot hash for the same versioned input. IDs and wall-clock timestamps are command inputs, never created inside domain code. Sort unordered collections before hashing or serialization.

### apps/

Apps render Rust state and translate platform interaction into Rust commands. Logic is never duplicated between apps; UI may differ by platform.

- web/ — Next.js / React;
- desktop/ — GPUI.

Apps may own ephemeral focus, hover, viewport, panel layout, drag preview/ghost and platform capability state. They do not own canonical timeline, variant, save, render or job semantics.

### Connected backend

- Next.js routes are thin same-origin auth/BFF adapters, not a second domain layer.
- The Rust control plane owns authorization, commands, revisions, sync and jobs.
- Postgres is the canonical connected source of truth.
- Redis is dispatch, rate-limit, progress fan-out or cache; never the only project/job copy.
- Object storage holds immutable originals and derivatives, not authorization.
- Workers execute versioned capability contracts and never invent product rules.

## Variant model invariants

The v1 model is finite. Never generalize it into an arbitrary DAG, rules engine or automatic Cartesian product without an approved ADR and migration.

~~~text
Campaign
└── MasterSequence — exactly one
    ├── CreativeSet rows — default/master plus at most 11 alternatives
    └── DeliveryProfile columns — at most 24 explicitly created profiles
        └── Enabled VariantCell — at most 100 per campaign
~~~

Resolution order is fixed:

~~~text
MasterSequence
  → CreativeSet typed slot replacements
  → DeliveryProfile format/locale rules
  → VariantCell allowlisted layout exception
~~~

Required invariants:

- at most 12 CreativeSets, 6 format profiles, 12 locale profiles, 24 DeliveryProfiles and 100 cells;
- cell key (creative_set_id, delivery_profile_id) is unique;
- CreativeSet changes typed hook/product/headline/CTA/logo slots only;
- replacement cannot silently change timing and must satisfy type/fit policy;
- DeliveryProfile may change canvas, safe areas, locale, captions, font fallback and layout, but not timing, FPS or audio mix;
- cell exceptions are crop, transform and text-fit for named slots; at most 20 cells may be detached;
- referenced master slots require explicit remap/drop before deletion;
- no nested variants, multiple parents, cycles, custom axes or executable expressions;
- local render v1 is limited to 8 cells per batch; connected beta to 50.

Enforce limits in Rust commands and tests, not only by hiding UI.

## Editor and history invariants

- Every mutating command carries campaign and master-sequence identity, explicit typed scene and variant scope fields, and base revision. Use enum values such as Sequence versus Scene(id) and Master versus VariantCell(id); never omit scope or infer the active target.
- Undo/redo targets its recorded scope, never whichever scene or project is currently active.
- Switching campaign, scene or variant revalidates or clears stale selection and preview state.
- A continuous gesture uses transient preview state and commits one named transaction on pointer-up.
- Escape/pointer-cancel restores canonical state and creates no history entry.
- A no-op command creates no event, history entry, notification or autosave.
- Selection, focus, playback, scroll and panels are not domain history.
- History is bounded and coalesced. Durable undo uses versioned compensating transactions/checkpoints, not an unbounded global stack.
- Pointer, keyboard and command-palette paths issue the same Rust command.

The regression “edit scene A → switch to B → undo” is a permanent required gate.

## Persistence and recovery invariants

- Show “Saved locally” only after a durable journal receipt.
- A failed write keeps the campaign dirty, exposes retry and preserves unload protection.
- Use append-only versioned journal entries, checksum snapshots and bounded compaction.
- Recovery loads the last valid snapshot and replays only valid journal entries.
- Never migrate legacy OpenCut storage in place. Import to a new namespace, verify reopen/hash, and retain the old copy until the user explicitly removes it.
- Never dual-write legacy and VariantLab schemas.
- Media import uses staging, content probing, limits, streaming hash and atomic manifest commit. A broken asset must not appear successful.
- Treat editable campaign bundles as untrusted archives: validate schema, normalized paths, entry/expansion limits, hashes and provenance in staging before atomic import.
- Originals are immutable/content-addressed; thumbnails, proxies, waveforms, transcripts and exports are reproducible derivatives.
- Migrations are forward-versioned, fixture-tested and must not silently discard unknown fields.

## Media, preview and job invariants

- Preview and export consume immutable RenderManifest values from a fixed revision.
- Preview and export have separate instances, surfaces and caches. Do not share a mutable global compositor.
- Export never reads mutable live editor or DOM state.
- Large output uses streaming/chunked storage; do not hold the full export in one ArrayBuffer.
- Waveforms are multiresolution pyramids; do not repeatedly decode a complete long source on the main thread.
- Decode/frame/thumbnail caches are byte-bounded LRU caches with cancellation and memory-pressure behavior.
- Transfer or stream large buffers to workers; avoid implicit copies.
- Playback and interaction outrank proxies, transcription and thumbnails.
- Persisted jobs use queued/preparing/running/pausing/paused/cancelling/succeeded/failed/cancelled; retry creates a new attempt and returns the job to queued.
- Every background operation has typed phase progress, capability-aware cancel/pause/retry and an idempotency key where applicable.
- Local jobs may resume after reopening but must not claim to continue after the browser closes.
- Cloud jobs are durable in Postgres; Redis messages contain identity, not sole state.
- Worker delivery is at-least-once, so execution and artifact commit are idempotent.

## Web

### React

- Read components before using them. They may already apply classes, which affects what must be passed and how overrides work.
- Do not recreate Rust domain types manually. Consume generated, versioned contracts.
- Subscribe to the smallest entity revision needed. Do not subscribe every selector to every manager or deep-compare the full project.
- Keep frame-rate playhead/canvas updates out of React rendering. Use an imperative/rAF channel and publish coarse semantic state separately.
- Coalesce pointer moves to at most one domain preview calculation per animation frame.
- Virtualize timelines and variant grids while preserving stable IDs, focus, selection, hit testing and accessibility.
- Prefer pointer capture plus cancellable preview transactions over HTML5 DnD for timeline geometry.
- Do not introduce component-local business decisions. Extend the Rust command/validation contract.
- Avoid nested interactive elements, clickable SVGs/divs, unnamed icon buttons, hidden focus and fake ARIA controls.

### Accessibility and responsive behavior

- WCAG 2.2 AA is a golden-path release gate.
- Every drag-and-drop action has a keyboard/menu alternative.
- Timeline clips, tracks, handles, playhead and the matrix have documented keyboard models and visible focus.
- Expose toggle/selection/value state with semantic controls and accessible names.
- Do not encode provenance, diagnostics or job state by color alone.
- Respect reduced motion and 200% zoom; throttle live-region announcements.
- Full timeline editing is supported from 1024 px. Smaller viewports receive a deliberate review/approval mode, not a compressed broken editor.
- Use reactive container/media queries, not a one-time window.innerWidth check.

### Visual direction

The product language is a creative production control board. The signature experience is the synchronized Variant Prism/Preview Wall with functional registration guides and provenance. Avoid a generic dark SaaS reskin, decorative gradients, glassmorphism and excessive pill containers. Follow docs/TRANSFORMATION_SPEC.md, subject to contrast, font-license and bundle checks.

## Performance rules

Treat docs/ARCHITECTURE.md budgets as product contracts:

- pointer-to-paint p95 stays below one 60 Hz frame;
- Rust command apply p95 is below 8 ms on the reference corpus;
- timeline/matrix DOM, media caches and history are bounded;
- only visible preview-wall cells decode and at most one is full quality;
- main-thread long tasks and React commit time are captured in browser traces;
- every performance claim names the corpus, browser and reference hardware.

Do not improve speed by weakening correctness, recovery, accessibility or deterministic output.

## Security and privacy

- Treat media, SVG, subtitle, filename, template and transcript input as untrusted.
- Verify content type and enforce byte, duration, pixel, CPU/RAM/time limits.
- Never interpret captions, transcripts or naming templates as HTML or executable code.
- Local media is not uploaded without explicit user action and a visible destination/cost.
- Tenant ID and authorization apply to every connected row/object/job; include negative isolation tests and RLS defense in depth.
- Use short-lived scoped signed URLs. Do not log URLs, raw media, transcript/copy text or original filenames by default.
- Keep secrets server-side; provide CSRF protection and secure session cookies.
- Require CSP, HSTS, frame-ancestors and Permissions-Policy in connected deployments.
- Run native media workers with restricted network/filesystem and bounded resources.

## Licensing, attribution and provenance

- Never delete or replace the root MIT LICENSE or its OpenCut copyright notice.
- Preserve git/provenance history and add a visible About/Open Source attribution surface before release.
- The OpenCut code license does not grant rights to use the OpenCut name or logo as VariantLab branding.
- Maintain THIRD_PARTY_NOTICES, an SBOM and provenance for dependencies, fonts, ML models, stock media, music and templates.
- Resolve or replace SoundTouchJS LGPL obligations; record Mediabunny MPL obligations.
- Do not treat Freesound results as commercially safe without accurate license filtering and retained creator/license attribution.
- Pin model/font/tool revisions and licenses.
- Isolate codec/FFmpeg choices behind a provider contract. Do not ship GPL/non-free builds or assume H.264/AAC commercial rights without an approved legal ADR.

## Testing and verification

Each vertical slice includes:

- Rust unit/property/serialization tests;
- native/WASM deterministic contract tests;
- TypeScript component/interaction tests for web-owned behavior;
- browser E2E with repository-licensed media fixtures;
- keyboard-only and automated accessibility checks plus manual focus review;
- relevant storage/worker/codec/network/tenant failure injection;
- performance traces on the reference stress corpus;
- backward/forward storage fixtures and recovery.

Required CI gates may not use continue-on-error, placeholder echo tests, or silently update golden snapshots. Milestone 1 first normalizes the exact install/lint/test/build/cargo/E2E commands because the baseline is currently red.

## Working discipline

- Keep milestones vertical and demonstrable; follow PLAN.md unless an explicit replan is approved.
- Before editing, inspect components, domain rules, tests, generated contracts and the working tree.
- Preserve unrelated user changes; avoid broad opportunistic cleanup or dependency upgrades.
- Add a failing regression before fixing a proven data-loss/history/recovery bug.
- Do not leave permanent dual implementations behind a flag.
- Do not make destructive storage migrations or automatically delete legacy media.
- Update specs/ADRs when behavior or one-way-door architecture changes.
- Record evidence; never label static inspection as browser-verified.
- Do not close a milestone while a golden-path control is placeholder, disabled or pointer-only.

## Definition of done

A change is done only when:

1. its user-visible acceptance scenario works;
2. platform-agnostic behavior has one Rust source of truth;
3. persistence/history/render invariants hold under failure;
4. unit, contract, browser, accessibility and relevant performance gates pass;
5. security, license and provenance impact is documented;
6. no unrelated source or attribution was removed;
7. completion is evidenced, not inferred from static code alone.
