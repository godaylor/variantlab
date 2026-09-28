# Portfolio handoff — VariantLab

**Release status: incomplete connected production; do not present as a fully
released cloud SaaS.** This handoff records implemented functionality and the
remaining deployment boundary for Personal Portfolio №09.

- Name: VariantLab, working codename; final cleared brand is not chosen.
- Short description: create controlled advertising versions from one master video.
- User problem: avoid manually duplicating edits across formats, copy and creative
  alternatives while keeping exports consistent.
- GitHub: https://github.com/godaylor/variantlab
- Live editor + Sites connected backend: https://variantlab-creative-ops-demo.maxeemzhuparov.chatgpt.site
- Current connected evidence and remaining limits: [CONNECTED_SITES.md](docs/CONNECTED_SITES.md).

## Author's contribution

Product direction and finite variant model; Rust command/history/validation and
render contracts; local durable storage/recovery; typed slots and variant UI;
media pipeline and export integration; Rust control plane, durable jobs,
cross-device sync/review; accessibility, failure and performance gates; deployment
and provenance documentation. The project began from OpenCut, whose retained
editor/runtime/shell code must not be represented as original authorship.

## Main capabilities

1. Named campaigns with durable local save and reopen.
2. Master timeline with scoped edits and undo/redo.
3. Typed creative replacements and controlled format/locale variants.
4. Preview Wall, matrix selection and preflight diagnostics.
5. Real local video export (up to 8 cells) and campaign packages.
6. Implemented connected account, explicit upload and 50-cell background batches.
7. Implemented cross-device continuation, conflict recovery and immutable reviews.

Public auth, persistence and original backup now use Sites/D1/R2. Authenticated
public continuation verification is pending normal user sign-in; server render
and render-backed reviews still need an external executor. The self-hosted
50-cell implementation remains available and was verified in the preceding run.

## Stack and architecture

Rust + WASM/wasm-bindgen; Next.js 16, React 19, TypeScript, Tailwind; Better Auth,
Drizzle auth adapter, PostgreSQL/SQLx, Redis, MinIO/S3; IndexedDB/OPFS, Web Workers,
WebCodecs, Mediabunny and VP9/Opus FFmpeg provider; Bun, Docker Compose, Playwright,
axe, ESLint, GitHub Actions. GPUI desktop is not part of the delivered web scope.

Rust owns canonical commands, variants and immutable rendering contracts. Web
owns interaction and platform adapters. The same-origin BFF translates sessions
into signed identity; Rust services authorize/store revisions and durable jobs.
Postgres is canonical, Redis dispatches, and immutable assets live in S3 storage.

## Screenshots

- `docs/screenshots/first-run.png` — public first-run guidance and campaign naming.
- `docs/screenshots/campaign-workspace.png` — public saved campaign workspace.

## Licensing and production claims

MIT with original Copyright 2025–2026 OpenCut retained; THIRD_PARTY_NOTICES and
SBOM/source receipts document dependencies. No claim of complete independent
implementation or trademark clearance. No unverified stock imagery was added.

The public origin delivers device-local editing. Do not label local tests as
public connected verification. Exact completed tests and remaining requirements:
`docs/PRODUCT_COMPLETION.md`, `docs/PRODUCTION_DEPLOY.md`.

The public release was verified on 2026-09-11: campaign creation and durable
reopen, adaptive variants, accessibility and an actual downloaded video containing
authored text and PNG all passed in Chromium. A manual UI pass covered creation,
scene editing, format creation and the editable-project download. Public cloud
login/sync/render are explicitly unavailable until the connected host is deployed.
