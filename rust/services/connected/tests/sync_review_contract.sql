BEGIN;
INSERT INTO sync_heads(tenant_id,campaign_id,revision,snapshot_sha256,snapshot) VALUES('fixture-a','new',0,repeat('d',64),'{}');
SET LOCAL ROLE variantlab_app;
SELECT set_config('variantlab.tenant_id','fixture-b',true);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_heads WHERE campaign_id='new') THEN RAISE EXCEPTION 'cross-tenant sync leak'; END IF;
 BEGIN
  INSERT INTO sync_heads(tenant_id,campaign_id,revision,snapshot_sha256,snapshot) VALUES('fixture-a','new',1,repeat('e',64),'{}');
  RAISE EXCEPTION 'cross-tenant write accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 IF (SELECT count(*) FROM pg_class WHERE relname IN ('sync_heads','sync_receipts','recovered_branches','review_links','review_decisions') AND relrowsecurity AND relforcerowsecurity) <> 5 THEN RAISE EXCEPTION 'missing forced RLS'; END IF;
 IF variantlab_review_tenant(repeat('0',64)) IS NOT NULL THEN RAISE EXCEPTION 'unknown review token accepted'; END IF;
END $$;
ROLLBACK;
SELECT 'M9 forced RLS, negative tenant read/write and unknown review token: PASS';
