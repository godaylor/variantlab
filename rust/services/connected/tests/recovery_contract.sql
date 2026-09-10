BEGIN;
INSERT INTO tenants(id,name) VALUES ('recovery-fixture','recovery');
INSERT INTO campaigns(tenant_id,id,name) VALUES ('recovery-fixture','campaign','fixture');
INSERT INTO campaign_revisions(tenant_id,campaign_id,revision,snapshot_sha256,snapshot)
VALUES ('recovery-fixture','campaign',1,repeat('e',64),'{}');
INSERT INTO render_batches(tenant_id,id,campaign_id,campaign_revision,requested_by)
VALUES ('recovery-fixture','00000000-0000-0000-0000-000000000005','campaign',1,'fixture');
INSERT INTO jobs(tenant_id,id,batch_id,cell_id,idempotency_key,spec,render_manifest,source_object_key,state,phase,lease_owner,lease_expires_at)
VALUES ('recovery-fixture','cancelled-worker','00000000-0000-0000-0000-000000000005','cell',repeat('1',64),'{}','{}','fixture','cancelling','rendering','dead',now()-interval '1 minute'),
('recovery-fixture','lost-worker','00000000-0000-0000-0000-000000000005','cell2',repeat('2',64),'{}','{}','fixture','running','rendering','dead',now()-interval '1 minute');
INSERT INTO job_attempts(tenant_id,job_id,attempt) VALUES ('recovery-fixture','cancelled-worker',1),('recovery-fixture','lost-worker',1);
SELECT variantlab_requeue_expired_jobs(20);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM jobs WHERE tenant_id='recovery-fixture' AND id='cancelled-worker' AND state='cancelled' AND attempt=1) THEN RAISE EXCEPTION 'cancelled worker must not be requeued'; END IF;
 IF NOT EXISTS(SELECT 1 FROM jobs WHERE tenant_id='recovery-fixture' AND id='lost-worker' AND state='queued' AND attempt=2) THEN RAISE EXCEPTION 'lost worker must get a new attempt'; END IF;
 IF EXISTS(SELECT 1 FROM job_attempts WHERE tenant_id='recovery-fixture' AND attempt=1 AND finished_at IS NULL) THEN RAISE EXCEPTION 'expired attempts must close'; END IF;
END $$;
UPDATE jobs SET updated_at=now()-interval '1 minute' WHERE tenant_id='recovery-fixture' AND id='lost-worker';
UPDATE outbox_events SET published_at=now()-interval '1 minute' WHERE tenant_id='recovery-fixture';
SELECT variantlab_requeue_expired_jobs(20);
DO $$ BEGIN
 IF (SELECT count(*) FROM outbox_events WHERE tenant_id='recovery-fixture' AND published_at IS NULL)<>1 THEN RAISE EXCEPTION 'durable queued job must republish after stream loss'; END IF;
END $$;
SELECT variantlab_requeue_expired_jobs(20);
DO $$ BEGIN
 IF (SELECT count(*) FROM outbox_events WHERE tenant_id='recovery-fixture')<>1 THEN RAISE EXCEPTION 'recovery must not duplicate outbox rows'; END IF;
END $$;
ROLLBACK;
SELECT 'Worker cancellation / lease retry / closed attempt history: PASS';
