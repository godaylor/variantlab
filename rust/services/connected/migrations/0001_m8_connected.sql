CREATE TABLE tenants (
    id text PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
    tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    actor_id text NOT NULL,
    role text NOT NULL CHECK (role IN ('owner', 'operator', 'reviewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, actor_id)
);

CREATE TABLE campaigns (
    tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id text NOT NULL,
    name text NOT NULL,
    head_revision integer NOT NULL DEFAULT 0 CHECK (head_revision >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id)
);

CREATE TABLE campaign_revisions (
    tenant_id text NOT NULL,
    campaign_id text NOT NULL,
    revision integer NOT NULL CHECK (revision >= 0),
    snapshot_hash text NOT NULL CHECK (length(snapshot_hash) = 64),
    render_manifest jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, campaign_id, revision),
    FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE media_assets (
    tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    asset_hash text NOT NULL CHECK (length(asset_hash) = 64),
    object_key text NOT NULL,
    byte_length bigint NOT NULL CHECK (byte_length >= 0),
    content_type text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, asset_hash),
    UNIQUE (tenant_id, object_key)
);

CREATE TABLE upload_sessions (
    tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id uuid NOT NULL,
    campaign_id text NOT NULL,
    asset_hash text NOT NULL CHECK (length(asset_hash) = 64),
    object_key text NOT NULL,
    provider_upload_id text NOT NULL,
    total_bytes bigint NOT NULL CHECK (total_bytes > 0),
    part_size_bytes bigint NOT NULL CHECK (part_size_bytes BETWEEN 5242880 AND 67108864),
    completed_parts jsonb NOT NULL DEFAULT '[]'::jsonb,
    state text NOT NULL CHECK (state IN ('uploading', 'completed', 'aborted')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id)
);
CREATE INDEX upload_sessions_resume_idx
    ON upload_sessions (tenant_id, campaign_id, asset_hash, state);

CREATE TABLE render_batches (
    tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id uuid NOT NULL,
    campaign_id text NOT NULL,
    campaign_revision integer NOT NULL,
    requested_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, campaign_id, campaign_revision)
        REFERENCES campaign_revisions(tenant_id, campaign_id, revision)
);

CREATE TABLE jobs (
    tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id text NOT NULL,
    batch_id uuid NOT NULL,
    cell_id text NOT NULL,
    idempotency_key text NOT NULL CHECK (length(idempotency_key) = 64),
    spec jsonb NOT NULL,
    render_manifest jsonb NOT NULL,
    source_object_key text NOT NULL,
    state text NOT NULL CHECK (state IN ('queued','preparing','running','pausing','paused','cancelling','succeeded','failed','cancelled')),
    phase text NOT NULL,
    progress_milli integer NOT NULL DEFAULT 0 CHECK (progress_milli BETWEEN 0 AND 1000),
    attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
    lease_owner text,
    lease_expires_at timestamptz,
    failure jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, batch_id) REFERENCES render_batches(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX jobs_batch_progress_idx ON jobs (tenant_id, batch_id, updated_at DESC);
CREATE INDEX jobs_lease_watchdog_idx ON jobs (state, lease_expires_at)
    WHERE state IN ('preparing', 'running', 'cancelling');

CREATE TABLE job_attempts (
    tenant_id text NOT NULL,
    job_id text NOT NULL,
    attempt integer NOT NULL CHECK (attempt > 0),
    worker_id text,
    started_at timestamptz,
    finished_at timestamptz,
    failure jsonb,
    PRIMARY KEY (tenant_id, job_id, attempt),
    FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE outbox_events (
    id bigserial PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    aggregate_id text NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    published_at timestamptz,
    dispatch_owner text,
    dispatch_lease_until timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_dispatch_idx ON outbox_events (available_at, id)
    WHERE published_at IS NULL;

CREATE TABLE export_artifacts (
    tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id uuid NOT NULL,
    job_id text NOT NULL,
    idempotency_key text NOT NULL,
    object_key text NOT NULL,
    sha256 text NOT NULL CHECK (length(sha256) = 64),
    byte_length bigint NOT NULL CHECK (byte_length >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id) ON DELETE CASCADE
);

GRANT SELECT, INSERT, UPDATE ON tenants, memberships, campaigns, campaign_revisions,
    media_assets, upload_sessions, render_batches, jobs, job_attempts,
    outbox_events, export_artifacts TO variantlab_app;
GRANT USAGE, SELECT ON SEQUENCE outbox_events_id_seq TO variantlab_app;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE render_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_artifacts ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;
ALTER TABLE upload_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE render_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE job_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE export_artifacts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_tenant_policy ON tenants
    USING (id = current_setting('variantlab.tenant_id', true))
    WITH CHECK (id = current_setting('variantlab.tenant_id', true));
CREATE POLICY memberships_tenant_policy ON memberships
    USING (tenant_id = current_setting('variantlab.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('variantlab.tenant_id', true));
CREATE POLICY campaigns_tenant_policy ON campaigns
    USING (tenant_id = current_setting('variantlab.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('variantlab.tenant_id', true));
CREATE POLICY campaign_revisions_tenant_policy ON campaign_revisions
    USING (tenant_id = current_setting('variantlab.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('variantlab.tenant_id', true));
CREATE POLICY media_assets_tenant_policy ON media_assets
    USING (tenant_id = current_setting('variantlab.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('variantlab.tenant_id', true));
CREATE POLICY upload_sessions_tenant_policy ON upload_sessions
    USING (tenant_id = current_setting('variantlab.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('variantlab.tenant_id', true));
CREATE POLICY render_batches_tenant_policy ON render_batches
    USING (tenant_id = current_setting('variantlab.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('variantlab.tenant_id', true));
CREATE POLICY jobs_tenant_policy ON jobs
    USING (tenant_id = current_setting('variantlab.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('variantlab.tenant_id', true));
CREATE POLICY job_attempts_tenant_policy ON job_attempts
    USING (tenant_id = current_setting('variantlab.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('variantlab.tenant_id', true));
CREATE POLICY outbox_events_tenant_policy ON outbox_events
    USING (tenant_id = current_setting('variantlab.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('variantlab.tenant_id', true));
CREATE POLICY export_artifacts_tenant_policy ON export_artifacts
    USING (tenant_id = current_setting('variantlab.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('variantlab.tenant_id', true));

CREATE FUNCTION variantlab_claim_outbox(claimant text, claim_limit integer)
RETURNS TABLE (event_id bigint, event_tenant_id text, aggregate_id text, payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.outbox_events AS event
  SET dispatch_owner = claimant,
      dispatch_lease_until = now() + interval '30 seconds',
      attempts = event.attempts + 1
  WHERE event.id IN (
    SELECT candidate.id
    FROM public.outbox_events AS candidate
    WHERE candidate.published_at IS NULL
      AND candidate.available_at <= now()
      AND (candidate.dispatch_lease_until IS NULL OR candidate.dispatch_lease_until < now())
    ORDER BY candidate.id
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(claim_limit, 1), 100)
  )
  RETURNING event.id, event.tenant_id, event.aggregate_id, event.payload;
END;
$$;

CREATE FUNCTION variantlab_mark_outbox_published(event_id bigint, claimant text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.outbox_events
  SET published_at = now(), dispatch_owner = NULL, dispatch_lease_until = NULL
  WHERE id = event_id
    AND dispatch_owner = claimant
    AND published_at IS NULL
  RETURNING true;
$$;

REVOKE ALL ON FUNCTION variantlab_claim_outbox(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION variantlab_mark_outbox_published(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION variantlab_claim_outbox(text, integer) TO variantlab_dispatcher;
GRANT EXECUTE ON FUNCTION variantlab_mark_outbox_published(bigint, text) TO variantlab_dispatcher;
