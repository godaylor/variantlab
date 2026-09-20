# ADR 0016: D1 leases and a pull-based native render executor

Date: 2026-09-20. Status: implementation authorized by the user's request to
complete D1 → worker → artifacts without paid resources or product redesign.

Keep D1 authoritative for the Sites provider. Store immutable manifests, Rust
job snapshots, attempts, batch receipts and leases in a forward-only migration.
Do not introduce Redis or copy Sites campaign ownership into another database.
The original Postgres deployment remains an independent supported provider.

The existing Rust job contract validates the 50-cell connected batch limit and
owns all transitions. The Worker only authenticates, persists and dispatches.
Canonical manifests are rebuilt from the saved revision before accepting jobs.
Compare-and-swap generations arbitrate claims, cancellation, progress and commit.
An expired lease creates a new attempt; an expired cancellation becomes cancelled.
A late executor cannot commit into the new attempt. Repeated completion returns
the committed receipt. A repeated batch request returns its original batch.

The Linux executor pulls over outbound HTTPS. It needs no inbound port, database
credential, public local tunnel or access to other projects. One high-entropy
server-side service credential permits dispatch, plus a random hashed capability
scoped to the claimed owner/job/attempt. Browser cookies cannot invoke worker
routes. Original downloads are limited to hashes in the immutable manifest.
Python stdlib handles transport and invokes the same Rust native plan/execution
used by the existing Postgres worker. It introduces no second timeline/compositor.
Python is a Debian runtime package whose installed version belongs in the runtime
SBOM; its PSF license is provided under `/usr/share/doc/python3*/copyright`.
The pinned FFmpeg build and codec/license policy are unchanged.

Native inputs are streamed and checksum-verified, with the existing 1 GiB budget.
Artifacts use 8 MiB parts, at most 1 GiB each and 2 GiB reserved per owner.
R2 results remain private. Only complete byte length, SHA-256 and WebM signature
verification permits a lease-fenced successful commit. User downloads use the
existing five-minute private capability path. The native integration gate also
uses FFprobe to validate actual codec, geometry and decoded frame count.
The queue is capped at 100 unfinished jobs and 200 batches per owner. These are
operational admission quotas, not changes to the 50-cell batch contract.

No executor is inferred from a configured URL or secret. New jobs require a recent
authenticated worker heartbeat. An unavailable executor stays explicitly offline;
browser exports continue to describe their own lifetime correctly. Existing render
controls are reused when the service credential is configured. Render-backed
review links remain explicitly unavailable on Sites; this slice does not invent
or silently simulate review artifacts.

Hosting remains separate from transport correctness. A temporary local executor
can verify the public transport but is not a deployed cloud executor. Do not claim
the background-render release complete until a free remote executor has actually
run the golden path independently of this computer.
