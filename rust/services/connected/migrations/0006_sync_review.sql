-- Additive M9 state; applied migrations and legacy media are untouched.
CREATE TABLE sync_heads (
 tenant_id text NOT NULL, campaign_id text NOT NULL,
 revision integer NOT NULL CHECK(revision>=0), snapshot_sha256 text NOT NULL CHECK(length(snapshot_sha256)=64),
 snapshot jsonb NOT NULL, writer_device text, lease_until timestamptz,
 PRIMARY KEY(tenant_id,campaign_id), FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id)
);
CREATE TABLE sync_receipts (
 tenant_id text NOT NULL, campaign_id text NOT NULL, request_id uuid NOT NULL,
 request_sha256 text NOT NULL, receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,campaign_id,request_id), FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id)
);
CREATE TABLE recovered_branches (
 tenant_id text NOT NULL, campaign_id text NOT NULL, id uuid NOT NULL,
 base_revision integer NOT NULL, server_revision integer NOT NULL,
 snapshot_sha256 text NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,campaign_id) REFERENCES campaigns(tenant_id,id)
);
CREATE TABLE review_links (
 tenant_id text NOT NULL, id uuid NOT NULL, campaign_id text NOT NULL, revision integer NOT NULL,
 snapshot_sha256 text NOT NULL, token_sha256 text UNIQUE NOT NULL CHECK(length(token_sha256)=64),
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,campaign_id,revision) REFERENCES campaign_revisions(tenant_id,campaign_id,revision)
);
CREATE TABLE review_decisions (
 tenant_id text NOT NULL, review_id uuid NOT NULL, request_id uuid NOT NULL,
 decision text NOT NULL CHECK(decision IN ('approved','rejected')), snapshot_sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,review_id,request_id), FOREIGN KEY(tenant_id,review_id) REFERENCES review_links(tenant_id,id)
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['sync_heads','sync_receipts','recovered_branches','review_links','review_decisions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_policy ON %I USING (tenant_id=current_setting(''variantlab.tenant_id'',true)) WITH CHECK (tenant_id=current_setting(''variantlab.tenant_id'',true))',tab);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO variantlab_app',tab);
 END LOOP;
END $$;
-- A bearer hash can locate only its own tenant. All subsequent reads/writes use
-- forced tenant RLS and recheck expiry/revocation inside the same transaction.
CREATE FUNCTION variantlab_review_tenant(token_hash text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT tenant_id FROM public.review_links WHERE token_sha256=token_hash AND revoked_at IS NULL AND expires_at>now()
$$;
REVOKE ALL ON FUNCTION variantlab_review_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION variantlab_review_tenant(text) TO variantlab_app;
