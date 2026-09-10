# ADR-0009: campaign revision snapshot compatibility

- Status: Accepted
- Date: 2026-09-08
- Authority: owner approval of the diagnosed additive migration and verified local application

## Evidence

Applied migration 0001 defines `snapshot_hash` and `render_manifest`, both NOT NULL.
The M8 API writes `snapshot_sha256` and `snapshot`. These are different payload
contracts; a render manifest must never be treated as a complete StudioState.
SQLx uses runtime queries, so the mismatch was not detected by compilation.

## Decision

Keep applied migrations 0001 and 0002 byte-identical. Migration 0003 adds the two
new columns and backfills only the hash. Legacy values and unknown JSON fields
remain untouched. The deprecated columns become nullable; CHECK constraints
require a complete legacy or new pair, an object snapshot, a 64-character hash
and agreement when both hashes exist. PK, FK, grants and forced tenant RLS remain.

The API compares submitted snapshots to their Rust checksum and derived manifests.
The exact upsert in `src/revision_snapshot.sql` is exercised by database fixtures:
the same immutable snapshot is idempotent; a different hash or JSON snapshot for
the same revision returns no row and maps to HTTP 409. A matching legacy revision
can receive its first validated full snapshot without replacing its manifest.

## Local application receipt

`script/m8-database-preflight.mjs` verified a complete pg_dump/pg_restore round trip
and full-row checksums, then tested legacy and fresh databases. SQLx upgraded the
restored copy and passed a second no-op run before the local database was migrated.

Private receipt: `.variantlab-backups/20260908182628105/receipt.json` and
`application.json`. These files and the dump are excluded from Git and Docker
contexts. The project volume `variantlab-m8-postgres-data` was retained, and all
existing media/upload rows were identical after migration. No restore/drop/reset
was performed on the source database.
