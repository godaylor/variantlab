-- Executed only in a newly created VariantLab fixture database.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM campaign_revisions
        WHERE campaign_id='legacy' AND snapshot_hash=repeat('a',64)
        AND snapshot_sha256=repeat('a',64) AND snapshot IS NULL
        AND render_manifest='{"schema_version":1,"unknown_future_field":{"keep":true}}'::jsonb)
    THEN RAISE EXCEPTION 'legacy data was altered or a snapshot was invented'; END IF;
END $$;

-- The runner prepares the exact SQL statement included by the production API.
EXECUTE persist_revision('fixture-a','legacy',1,repeat('a',64),'{"campaign":{"revision":1},"preserve_unknown":true}');
EXECUTE persist_revision('fixture-a','new',1,repeat('b',64),'{"campaign":{"revision":1}}');
EXECUTE persist_revision('fixture-a','new',1,repeat('b',64),'{"campaign":{"revision":1}}');
EXECUTE persist_revision('fixture-a','new',1,repeat('c',64),'{"campaign":{"revision":2}}');
EXECUTE persist_revision('fixture-a','new',1,repeat('b',64),'{"campaign":{"revision":2}}');

DO $$
BEGIN
    IF (SELECT count(*) FROM campaign_revisions) <> 2
        OR NOT EXISTS (SELECT 1 FROM campaign_revisions WHERE campaign_id='new'
            AND snapshot_sha256=repeat('b',64) AND snapshot='{"campaign":{"revision":1}}'::jsonb
            AND snapshot_hash IS NULL AND render_manifest IS NULL)
        OR NOT EXISTS (SELECT 1 FROM campaign_revisions WHERE campaign_id='legacy'
            AND snapshot IS NOT NULL AND render_manifest->'unknown_future_field'='{"keep":true}'::jsonb)
    THEN RAISE EXCEPTION 'revision immutability or legacy enrichment failed'; END IF;
    BEGIN
        INSERT INTO campaign_revisions (tenant_id,campaign_id,revision) VALUES ('fixture-a','new',2);
        RAISE EXCEPTION 'empty pair was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN
        INSERT INTO campaign_revisions (tenant_id,campaign_id,revision,snapshot_sha256,snapshot)
        VALUES ('fixture-a','new',2,'short','{}');
        RAISE EXCEPTION 'short hash was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN
        INSERT INTO campaign_revisions (tenant_id,campaign_id,revision,snapshot_sha256,snapshot)
        VALUES ('fixture-a','new',2,repeat('b',64),'[]');
        RAISE EXCEPTION 'array snapshot was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN
        INSERT INTO campaign_revisions (tenant_id,campaign_id,revision,snapshot_hash,render_manifest,snapshot_sha256,snapshot)
        VALUES ('fixture-a','new',2,repeat('a',64),'{}',repeat('b',64),'{}');
        RAISE EXCEPTION 'different hashes were accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN
        INSERT INTO render_batches (tenant_id,id,campaign_id,campaign_revision,requested_by)
        VALUES ('fixture-a','00000000-0000-0000-0000-000000000001','new',999,'fixture');
        RAISE EXCEPTION 'missing revision foreign key was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;

SET ROLE variantlab_app;
SELECT set_config('variantlab.tenant_id','fixture-b',false);
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM campaign_revisions) THEN RAISE EXCEPTION 'cross-tenant read'; END IF;
    BEGIN
        INSERT INTO campaign_revisions (tenant_id,campaign_id,revision,snapshot_sha256,snapshot)
        VALUES ('fixture-a','new',2,repeat('b',64),'{}');
        RAISE EXCEPTION 'cross-tenant write';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SELECT 'snapshot contract, legacy preservation, immutability, constraints, FK and RLS: PASS' AS result;
