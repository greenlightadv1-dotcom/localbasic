#!/usr/bin/env bash
# Applies every migration to a throwaway PostgreSQL database and runs the SQL
# test suite against it. Used locally and in CI.
#
#   PGPORT=5433 PGHOST=/tmp ./supabase/tests/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
DB="${TEST_DB:-localbasic_test}"
PSQL=(psql -h "${PGHOST:-/tmp}" -p "${PGPORT:-5433}" -U "${PGUSER:-postgres}" -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" -d postgres -c "drop database if exists ${DB};"
"${PSQL[@]}" -d postgres -c "create database ${DB};"

echo "→ harness"
"${PSQL[@]}" -d "$DB" -f "$HERE/harness.sql"

for f in "$ROOT"/migrations/*.sql; do
  echo "→ migration $(basename "$f")"
  "${PSQL[@]}" -d "$DB" -f "$f"
done

for f in "$HERE"/[0-9]*.sql; do
  echo "→ test $(basename "$f")"
  "${PSQL[@]}" -d "$DB" -f "$f"
done

echo "ALL DATABASE TESTS PASSED"
