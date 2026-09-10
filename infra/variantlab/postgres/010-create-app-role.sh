#!/bin/sh
set -eu

: "${VARIANTLAB_APP_DB_PASSWORD:?VARIANTLAB_APP_DB_PASSWORD is required}"

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$VARIANTLAB_APP_DB_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE variantlab_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'variantlab_app') \gexec
SQL
