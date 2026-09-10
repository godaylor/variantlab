BEGIN;
INSERT INTO tenants(id,name) VALUES ('receipt-fixture','fixture');
INSERT INTO upload_sessions(tenant_id,id,campaign_id,asset_hash,object_key,provider_upload_id,total_bytes,part_size_bytes,state,expires_at)
VALUES ('receipt-fixture','00000000-0000-0000-0000-000000000006','fixture',repeat('a',64),'fixture','fixture',12,8388608,'uploading',now()+interval '1 hour');
EXECUTE persist_part('receipt-fixture','00000000-0000-0000-0000-000000000006','{"part_number":1,"etag":"one","byte_length":6,"sha256":"fixture"}');
EXECUTE persist_part('receipt-fixture','00000000-0000-0000-0000-000000000006','{"part_number":2,"etag":"two","byte_length":6,"sha256":"fixture"}');
DO $$ BEGIN
 IF (SELECT jsonb_array_length(completed_parts) FROM upload_sessions WHERE tenant_id='receipt-fixture')<>2 THEN RAISE EXCEPTION 'parallel receipt writers must not lose previous parts'; END IF;
END $$;
EXECUTE persist_part('receipt-fixture','00000000-0000-0000-0000-000000000006','{"part_number":1,"etag":"retry","byte_length":6,"sha256":"fixture"}');
DO $$ BEGIN
 IF (SELECT jsonb_array_length(completed_parts) FROM upload_sessions WHERE tenant_id='receipt-fixture')<>2 THEN RAISE EXCEPTION 'retry must replace one part, not append a duplicate'; END IF;
END $$;
ROLLBACK;
SELECT 'Atomic multipart receipts and retry: PASS';
