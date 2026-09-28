# ADR 0015: Sites connected storage provider

Date: 2026-09-13. Status: accepted for implementation under the user's explicit
authorization to simplify infrastructure, retain the public editor, and create no paid resources.

The existing public editor is hosted by Sites. Its connected runtime supplies
dispatch-owned Sign in with ChatGPT, Cloudflare D1 and private R2 bindings. There
is no connected billing account or VPS for the existing native control plane.

Use these existing bindings for public campaign persistence and media backup.
The isolated `vl_*` D1 namespace is the canonical source of truth for this hosted
provider. This explicitly amends the Postgres-only deployment assumption in
ARCHITECTURE.md; it does not migrate, dual-write, or delete existing Postgres data.
The self-hosted Postgres/Redis/Rust service remains available with its original
native worker functionality. A future provider migration must be explicit,
checksum-verified and preserve the original copy.

Rust `edit-engine::plan_connected_sync` is shared between the native service and
the Sites WASM adapter. The Worker only authenticates, stores, streams and commits
its decision. D1 atomic batch preconditions serialize concurrent head changes;
immutable revisions, idempotency receipts, writer leases and recovered branches
retain the existing sync contract. Every query has an authenticated owner scope.
D1 does not provide Postgres RLS: prepared owner-scoped queries and negative
isolation tests are the provider's enforcement boundary.

Sites identity headers are trusted only behind Sites dispatch. No production
test login or client-supplied tenant override exists. Local workerd tests inject
identities directly into an isolated runtime, never a production auth route.
Requests that mutate state require the exact same Origin. Private downloads use
random, hashed, five-minute bearer capabilities; private originals are never
public bucket URLs. They contain no original filenames.

Uploads are explicit, resumable 8 MiB parts, at most 1 GiB per original, with a
2 GiB/account staging reservation and 200 upload-session allowance. R2 stores
immutable byte-verified originals; media compatibility/probing is rechecked by
the browser on restoration. Backup completion is not a claim that a native
FFmpeg probe has run. Invalid/incomplete bytes never receive an asset receipt.
These initial anti-abuse limits must be explained on quota errors; unused
staging cleanup and administrative quota tooling remain operational work.

The Worker runtime has no native FFmpeg process executor. Do not pretend a
queued job will run, use GitHub Actions as a production render farm, or expose a
local machine tunnel as durable cloud execution. Server render/review endpoints
return an explicit unavailable capability until a real worker is provisioned.
Existing browser export and self-hosted render features remain intact.

Validation evidence is recorded separately in PRODUCT_COMPLETION.md. A local
workerd pass is not evidence of public authentication or public deployment.
