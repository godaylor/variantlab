# ADR-0013: bounded command sync and immutable review capabilities

- Status: accepted for the authorized M9 release slice
- Date: 2026-09-10

Cloud continuity is explicit. Enabling sync durably stores an initial
checkpoint; later journal transactions append Rust commands atomically to an
IndexedDB outbox. One persisted request ID and command prefix survive a lost
response. Rust owns replay, outbox acknowledgement and recovery forking.
Acknowledgement removes only that prefix, preserving edits appended in flight.
The queue is bounded to 200 commands / 2 MiB. Overflow keeps the complete local
state and offers an explicit new recovery campaign, never silent truncation.

Postgres stores immutable revision checkpoints, sync heads, request receipts
and recovered branches under forced tenant RLS. A row lock serializes head
changes and a 30-second server-time writer lease prevents concurrent writers.
Divergence retains both states; no automatic merge or CRDT is introduced.
Continuing a branch uses new identity/history through Rust. Migrations are
additive; original migration files and legacy namespaces are retained.

Another device explicitly downloads missing originals through short-lived
URLs, verifies streamed SHA-256/size/probe in staging, and installs the
checkpoint only after durable media receipts. A pending local outbox blocks
replacement. A partially failed download remains retryable without claiming
that the campaign was installed.

Review capabilities bind an immutable revision/hash and existing rendered
artifacts. Tokens contain 256 random bits, are stored only as SHA-256, and
travel in a URL fragment then a same-origin POST body. Expiry is bounded to
seven days; UI links last 24 hours. Review grants no editor/upload access.
Server-side revocation, stale-revision rejection and idempotent decision audit
apply independently of disabled UI controls. The page is no-index/no-referrer.
Signed artifact URLs last 60 seconds, so revocation prevents new access while
an already-issued URL can remain usable until its short expiry.

No originals are uploaded by turning on metadata sync. The existing explicit
cloud-render upload flow displays destination/cost. Review uses immutable
rendered derivatives and does not load the editor or mutable campaign media.
