#!/bin/sh
# Runs once, the first time the database volume is initialised (docker-entrypoint-initdb.d).
#
# Creates the ordinary role the APPLICATION connects as. PostgreSQL superusers and BYPASSRLS roles skip
# row-level security entirely, so the app must never use POSTGRES_USER. The app role creates (and therefore owns)
# the tables, and initDb() applies FORCE ROW LEVEL SECURITY so even the owner is subject to the tenant policies.
set -eu

: "${APP_DB_USER:?APP_DB_USER is required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 \
     -v app_user="$APP_DB_USER" \
     -v app_pass="$APP_DB_PASSWORD" \
     -v db_name="$POSTGRES_DB" \
     --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
CREATE ROLE :"app_user" WITH LOGIN PASSWORD :'app_pass'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Extensions need privileges the app role does not have; create them here so initDb's IF NOT EXISTS is a no-op.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO :"app_user";
GRANT USAGE, CREATE ON SCHEMA public TO :"app_user";
EOSQL

echo "Created application role '$APP_DB_USER' (NOSUPERUSER, NOBYPASSRLS)."
