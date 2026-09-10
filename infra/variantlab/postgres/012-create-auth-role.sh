#!/bin/sh
set -eu
: "${VARIANTLAB_AUTH_DB_PASSWORD:?VARIANTLAB_AUTH_DB_PASSWORD is required}"
psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=auth_password="$VARIANTLAB_AUTH_DB_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE variantlab_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
  :'auth_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'variantlab_auth') \gexec
SQL
