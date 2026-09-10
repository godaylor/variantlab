BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='variantlab_auth' AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole)) THEN
    RAISE EXCEPTION 'auth role has excessive privileges';
  END IF;
  IF has_table_privilege('variantlab_app','accounts','SELECT') OR has_table_privilege('variantlab_dispatcher','sessions','SELECT') THEN
    RAISE EXCEPTION 'render services can read auth secrets';
  END IF;
  IF has_table_privilege('variantlab_auth','campaign_revisions','SELECT') OR has_table_privilege('variantlab_auth','jobs','UPDATE') THEN
    RAISE EXCEPTION 'auth adapter can access domain rows';
  END IF;
END $$;
SET LOCAL ROLE variantlab_auth;
INSERT INTO users VALUES ('auth-fixture','Имя без перевода','auth-fixture@example.invalid',false,NULL,now(),now());
INSERT INTO accounts(id,account_id,provider_id,user_id,password,created_at,updated_at)
VALUES ('auth-account','auth-fixture','credential','auth-fixture','fixture-only-hash',now(),now());
INSERT INTO sessions(id,expires_at,token,created_at,updated_at,user_id)
VALUES ('auth-session',now()+interval '1 day','fixture-only-token',now(),now(),'auth-fixture');
INSERT INTO rate_limits VALUES ('auth-limit','fixture-key',1,1780000000000);
DO $$ BEGIN
  IF (SELECT count(*) FROM sessions WHERE user_id='auth-fixture') <> 1 THEN RAISE EXCEPTION 'auth role access failed'; END IF;
  BEGIN
    PERFORM * FROM media_assets;
    RAISE EXCEPTION 'auth role read media';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
DELETE FROM users WHERE id='auth-fixture';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM sessions WHERE user_id='auth-fixture') OR EXISTS (SELECT 1 FROM accounts WHERE user_id='auth-fixture') THEN
    RAISE EXCEPTION 'auth cascade contract failed';
  END IF;
END $$;
ROLLBACK;
SELECT 'Auth schema, RLS, least privilege and session FK fixtures: PASS';
