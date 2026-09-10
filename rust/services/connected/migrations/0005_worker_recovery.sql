-- Forward-only repair. No row/volume deletion and no changes to applied files.
CREATE OR REPLACE FUNCTION variantlab_requeue_expired_jobs(requeue_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE candidate record; recovered integer := 0;
BEGIN
 FOR candidate IN
  SELECT tenant_id,id,attempt,state FROM public.jobs
  WHERE state IN ('preparing','running','cancelling') AND lease_expires_at < now()
  ORDER BY lease_expires_at,id FOR UPDATE SKIP LOCKED
  LIMIT LEAST(GREATEST(requeue_limit,1),100)
 LOOP
  UPDATE public.job_attempts SET finished_at=now(),
    failure=CASE WHEN candidate.state='cancelling' THEN NULL ELSE jsonb_build_object('code','worker_lease_expired','retryable',true) END
  WHERE tenant_id=candidate.tenant_id AND job_id=candidate.id AND attempt=candidate.attempt;
  IF candidate.state='cancelling' THEN
   UPDATE public.jobs SET state='cancelled',phase='complete',failure=NULL,
     lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
   WHERE tenant_id=candidate.tenant_id AND id=candidate.id;
  ELSE
   UPDATE public.jobs SET state='queued',phase='preflight',progress_milli=0,
     attempt=candidate.attempt+1,lease_owner=NULL,lease_expires_at=NULL,
     failure=jsonb_build_object('code','worker_lease_expired','retryable',true),updated_at=now()
   WHERE tenant_id=candidate.tenant_id AND id=candidate.id;
   INSERT INTO public.job_attempts(tenant_id,job_id,attempt)
   VALUES(candidate.tenant_id,candidate.id,candidate.attempt+1) ON CONFLICT DO NOTHING;
   INSERT INTO public.outbox_events(tenant_id,aggregate_id,event_type,payload)
   VALUES(candidate.tenant_id,candidate.id,'render_job_requeued_after_worker_loss',
     jsonb_build_object('tenant_id',candidate.tenant_id,'job_id',candidate.id));
  END IF;
  recovered := recovered+1;
 END LOOP;
 -- Redis is disposable: republish a bounded set of unclaimed durable jobs.
 -- Reuse an existing outbox row instead of growing a new event every poll.
 FOR candidate IN
  SELECT j.tenant_id,j.id FROM public.jobs j
  WHERE j.state='queued' AND j.updated_at < now()-interval '10 seconds'
   AND NOT EXISTS(SELECT 1 FROM public.outbox_events e WHERE e.tenant_id=j.tenant_id AND e.aggregate_id=j.id
     AND (e.published_at IS NULL OR e.published_at>now()-interval '10 seconds'))
  ORDER BY j.updated_at,j.id FOR UPDATE SKIP LOCKED
  LIMIT LEAST(GREATEST(requeue_limit,1),100)
 LOOP
  UPDATE public.outbox_events SET published_at=NULL,dispatch_owner=NULL,dispatch_lease_until=NULL,available_at=now()
  WHERE id=(SELECT max(id) FROM public.outbox_events WHERE tenant_id=candidate.tenant_id AND aggregate_id=candidate.id);
  IF NOT FOUND THEN
   INSERT INTO public.outbox_events(tenant_id,aggregate_id,event_type,payload)
   VALUES(candidate.tenant_id,candidate.id,'render_job_dispatch_recovered',
     jsonb_build_object('tenant_id',candidate.tenant_id,'job_id',candidate.id));
  END IF;
  recovered := recovered+1;
 END LOOP;
 RETURN recovered;
END $$;
REVOKE ALL ON FUNCTION variantlab_requeue_expired_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION variantlab_requeue_expired_jobs(integer) TO variantlab_dispatcher;
