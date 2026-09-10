-- Existing Better Auth/Drizzle contract; no campaign/media data is rewritten.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'variantlab_auth') THEN
    CREATE ROLE variantlab_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

CREATE TABLE users (
  id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false, image text,
  created_at timestamp NOT NULL, updated_at timestamp NOT NULL
);
CREATE TABLE sessions (
  id text PRIMARY KEY, expires_at timestamp NOT NULL, token text NOT NULL UNIQUE,
  created_at timestamp NOT NULL, updated_at timestamp NOT NULL,
  ip_address text, user_agent text, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE TABLE accounts (
  id text PRIMARY KEY, account_id text NOT NULL, provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token text, refresh_token text, id_token text,
  access_token_expires_at timestamp, refresh_token_expires_at timestamp,
  scope text, password text, created_at timestamp NOT NULL, updated_at timestamp NOT NULL,
  UNIQUE (provider_id, account_id)
);
CREATE INDEX accounts_user_idx ON accounts(user_id);
CREATE TABLE verifications (
  id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
  expires_at timestamp NOT NULL, created_at timestamp, updated_at timestamp
);
CREATE INDEX verifications_identifier_idx ON verifications(identifier);
CREATE TABLE rate_limits (
  id text PRIMARY KEY, key text NOT NULL UNIQUE, count integer NOT NULL,
  last_request bigint NOT NULL
);

GRANT USAGE ON SCHEMA public TO variantlab_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, accounts, verifications, rate_limits TO variantlab_auth;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE verifications FORCE ROW LEVEL SECURITY;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits FORCE ROW LEVEL SECURITY;
-- Only the server-side authentication adapter may access identity tables.
-- Native API/workers cannot read password hashes or sessions; the BFF auth role
-- cannot read or write campaign, job, tenant or media tables.
CREATE POLICY users_auth ON users TO variantlab_auth USING (true) WITH CHECK (true);
CREATE POLICY sessions_auth ON sessions TO variantlab_auth USING (true) WITH CHECK (true);
CREATE POLICY accounts_auth ON accounts TO variantlab_auth USING (true) WITH CHECK (true);
CREATE POLICY verifications_auth ON verifications TO variantlab_auth USING (true) WITH CHECK (true);
CREATE POLICY rate_limits_auth ON rate_limits TO variantlab_auth USING (true) WITH CHECK (true);
