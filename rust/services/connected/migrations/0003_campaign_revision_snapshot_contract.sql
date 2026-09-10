-- Forward-only compatibility bridge. The legacy manifest is NOT a StudioState.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE campaign_revisions
    ADD COLUMN snapshot_sha256 text,
    ADD COLUMN snapshot jsonb;

UPDATE campaign_revisions SET snapshot_sha256 = snapshot_hash;

ALTER TABLE campaign_revisions
    ALTER COLUMN snapshot_hash DROP NOT NULL,
    ALTER COLUMN render_manifest DROP NOT NULL,
    ADD CONSTRAINT campaign_revisions_snapshot_sha256_check
        CHECK (snapshot_sha256 IS NULL OR length(snapshot_sha256) = 64),
    ADD CONSTRAINT campaign_revisions_snapshot_object_check
        CHECK (snapshot IS NULL OR jsonb_typeof(snapshot) = 'object'),
    ADD CONSTRAINT campaign_revisions_snapshot_pair_check
        CHECK (
            (snapshot_hash IS NOT NULL AND render_manifest IS NOT NULL)
            OR (snapshot_sha256 IS NOT NULL AND snapshot IS NOT NULL)
        ),
    ADD CONSTRAINT campaign_revisions_snapshot_hash_agreement_check
        CHECK (snapshot_hash IS NULL OR snapshot_sha256 IS NULL OR snapshot_hash = snapshot_sha256);
