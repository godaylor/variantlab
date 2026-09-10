INSERT INTO campaign_revisions (tenant_id, campaign_id, revision, snapshot_sha256, snapshot)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (tenant_id, campaign_id, revision) DO UPDATE
SET snapshot_sha256 = EXCLUDED.snapshot_sha256,
    snapshot = COALESCE(campaign_revisions.snapshot, EXCLUDED.snapshot)
WHERE COALESCE(campaign_revisions.snapshot_sha256, campaign_revisions.snapshot_hash) = EXCLUDED.snapshot_sha256
  AND (campaign_revisions.snapshot IS NULL OR campaign_revisions.snapshot = EXCLUDED.snapshot)
RETURNING revision
