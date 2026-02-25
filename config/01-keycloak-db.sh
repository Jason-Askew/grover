#!/bin/bash
# Create Keycloak database and user using the same password as POSTGRES_PASSWORD.
# Runs before 02-grover-init.sql (alphabetical order in docker-entrypoint-initdb.d).
set -e

KC_PASS="${POSTGRES_PASSWORD:-grover}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'keycloak') THEN
        CREATE USER keycloak WITH PASSWORD '${KC_PASS}';
      END IF;
    END
    \$\$;

    SELECT 'CREATE DATABASE keycloak'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'keycloak')\\gexec

    GRANT ALL PRIVILEGES ON DATABASE keycloak TO keycloak;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "keycloak" <<-EOSQL
    GRANT ALL ON SCHEMA public TO keycloak;
EOSQL
