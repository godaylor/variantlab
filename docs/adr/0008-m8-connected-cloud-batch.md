# ADR-0008: M8 connected cloud batch runtime

- Status: Accepted
- Date: 2026-09-03
- Decision owner: project owner
- Scope: Milestone 8 only

## Context

M8 adds a connected execution mode to the local-first VariantLab studio. The
connected mode must keep Postgres as durable truth, use Redis only for dispatch
and progress fan-out, store immutable media and artifacts in S3-compatible
storage, and continue render work after the browser closes. The existing
upstream Compose project, network, ports, database volume and OpenCut
attribution are not migration targets and must remain untouched.

## Decision

VariantLab M8 uses a separate, isolated Docker Compose project with these host
ports:

| Service | Host port | Container port |
|---|---:|---:|
| Web / same-origin BFF | 32200 | 3000 |
| Rust Axum control plane | 32201 | 8080 |
| PostgreSQL | 32210 | 5432 |
| Redis Streams | 32211 | 6379 |
| MinIO S3 API | 32212 | 9000 |
| MinIO console | 32213 | 9001 |

Amendment accepted by the owner on 2026-09-08: the complete external allocation
is 32200–32299 (additional services 32220–32239, tests 32240–32269, release
verification 32270–32289). This supersedes 13100/18080/15432/16379/19000/19001.
Published ports bind to 127.0.0.1. Existing Compose, network and volume identities
remain unchanged. Windows IPv4/IPv6 excluded ranges and listening sockets were
checked before use; no conflict existed in the allocated range.

The Rust backend uses Axum and SQLx. Postgres owns tenants, campaign revisions,
assets, upload sessions, batches, jobs, attempts, outbox events and artifacts.
Redis Streams transports job identity only. MinIO is the local S3-compatible
adapter and uses new VariantLab-specific volumes. Workers use leases and
at-least-once delivery; artifact commit and job keys are idempotent.

The native worker produces only VP9/Opus WebM through a pinned FFmpeg build
configured without GPL, non-free, H.264 or AAC components. The worker image,
build configuration, FFmpeg license receipt and SBOM are release artifacts.
No other codec is enabled by fallback.

Node.js is pinned to 22.15.1 at repository level and Bun remains pinned to
1.2.18. The global Node installation is never installed, changed or selected by
project automation.

All Compose container, network and volume names are VariantLab-specific. The
existing `opencut-network`, `postgres_data` and other legacy volumes are not
read, renamed, migrated, overwritten or deleted. Any future data transfer must
be designed as a separate staged import with verification and explicit owner
approval.

## Security and privacy consequences

- Next.js remains a thin same-origin streaming BFF; authorization and tenant
  checks remain in Rust.
- Every tenant-owned database row carries `tenant_id`; SQLx transactions set
  tenant context and Postgres RLS provides defense in depth.
- Browser uploads are explicit, resumable and content-hash verified.
- Artifact links are short-lived and scoped; raw signed URLs, filenames, media,
  transcript and creative copy are excluded from logs and telemetry.
- Workers have bounded scratch space and deny arbitrary network access.

## Alternatives rejected

- Reusing the upstream Compose project: rejected because it shares legacy
  ports, network and volume identity.
- Redis as canonical job storage: rejected because stream loss must be
  recoverable from Postgres/outbox.
- GPL/non-free FFmpeg or H.264/AAC: rejected for M8 because no legal approval
  exists for those distribution choices.
- Browser-only continuation: rejected because it cannot truthfully continue
  after the tab closes.

## Verification

M8 must prove multipart interruption/resume, worker lease recovery, duplicate
delivery idempotency, Redis stream loss recovery from Postgres, cross-tenant
denial including RLS, signed-link expiry, SSE batching, security headers and a
browser close/reopen flow. Compose readiness must check Postgres, Redis and
MinIO rather than returning a static success response.
