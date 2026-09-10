#!/bin/sh
set -eu

: "${VARIANTLAB_DISPATCHER_DB_PASSWORD:?VARIANTLAB_DISPATCHER_DB_PASSWORD is required}"

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=dispatcher_password="$VARIANTLAB_DISPATCHER_DB_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE variantlab_dispatcher LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L',
  :'dispatcher_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'variantlab_dispatcher') \gexec
SQL
