#!/usr/bin/env bash
# Builds the LOCAL development database: schema from the committed migrations,
# then the Arabic restaurant demo data. Destroys and recreates every time.
#
#   ./scripts/dev-db.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${DEV_DB:-localbasic_dev}"
export PATH="/usr/lib/postgresql/16/bin:$PATH"
PSQL=(psql -h "${PGHOST:-/tmp}" -p "${PGPORT:-5433}" -U "${PGUSER:-postgres}" -v ON_ERROR_STOP=1 -q)

echo "→ recreating $DB"
"${PSQL[@]}" -d postgres -c "drop database if exists ${DB};"
"${PSQL[@]}" -d postgres -c "create database ${DB};"

echo "→ platform shim (auth schema, roles) — Supabase provides this in real deployments"
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/tests/harness.sql"

for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "→ $(basename "$f")"
  "${PSQL[@]}" -d "$DB" -f "$f"
done

echo "→ demo data"
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/seed/restaurant_demo.sql"

echo
echo "Local database ready: $DB"
"${PSQL[@]}" -d "$DB" -tAc "
  select '  ' || (select count(*) from restaurant_products) || ' menu items, '
              || (select count(*) from restaurant_tables) || ' tables, '
              || (select count(*) from restaurant_orders) || ' orders, '
              || (select count(*) from organization_members) || ' staff';"
