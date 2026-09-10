CREATE FUNCTION variantlab_requeue_expired_jobs(requeue_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate record;
  requeued integer := 0;
BEGIN
  FOR candidate IN
    SELECT tenant_id, id, attempt
    FROM public.jobs
    WHERE state IN ('preparing', 'running', 'cancelling')
      AND lease_expires_at < now()
    ORDER BY lease_expires_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(requeue_limit, 1), 100)
  LOOP
    UPDATE public.jobs
    SET state = 'queued', phase = 'preflight', progress_milli = 0,
        attempt = candidate.attempt + 1, lease_owner = NULL,
        lease_expires_at = NULL,
        failure = jsonb_build_object('code', 'worker_lease_expired', 'retryable', true),
        updated_at = now()
    WHERE tenant_id = candidate.tenant_id AND id = candidate.id;

    INSERT INTO public.job_attempts (tenant_id, job_id, attempt, failure)
    VALUES (
      candidate.tenant_id,
      candidate.id,
      candidate.attempt + 1,
      jsonb_build_object('code', 'worker_lease_expired', 'retryable', true)
    )
    ON CONFLICT DO NOTHING;

    INSERT INTO public.outbox_events (tenant_id, aggregate_id, event_type, payload)
    VALUES (
      candidate.tenant_id,
      candidate.id,
      'render_job_requeued_after_worker_loss',
      jsonb_build_object('tenant_id', candidate.tenant_id, 'job_id', candidate.id)
    );
    requeued := requeued + 1;
  END LOOP;
  RETURN requeued;
END;
$$;

REVOKE ALL ON FUNCTION variantlab_requeue_expired_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION variantlab_requeue_expired_jobs(integer) TO variantlab_dispatcher;
