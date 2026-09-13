#!/usr/bin/env bash
# =============================================================================
# LOCAL BASIC — inventory concurrency test
#
# Two sessions try to sell the last unit at the same time. Exactly one must
# succeed; the other must be rejected. Proving this needs two real connections,
# so it lives in a shell script rather than the SQL suite.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${TEST_DB:-localbasic_test}"
PSQL=(psql -h "${PGHOST:-/tmp}" -p "${PGPORT:-5433}" -U "${PGUSER:-postgres}" -d "$DB" -tAX -v ON_ERROR_STOP=1)

echo "→ concurrency fixture"
read -r ORG BRANCH VARIANT <<<"$(
  "${PSQL[@]}" <<'SQL'
do $$
declare u uuid; o uuid; b uuid; p uuid; v uuid;
begin
  insert into auth.users (email) values ('conc@test.local') returning id into u;
  perform auth.login_as(u);
  select out_organization_id, out_branch_id into o, b
    from public.provision_workspace('Conc Store', 'concstore', 'retail', 'Main');
  perform auth.as_admin();
  perform auth.login_as(u);
  insert into public.retail_products (organization_id, name) values (o, 'Last Item') returning id into p;
  insert into public.retail_variants (organization_id, product_id, price_cents)
    values (o, p, 5000) returning id into v;
  -- Exactly one unit in stock.
  insert into public.retail_stock_movements
    (organization_id, branch_id, variant_id, quantity_delta, reason)
    values (o, b, v, 1, 'initial');
  perform auth.as_admin();
  create temp table conc_fixture as select o as org, b as branch, v as variant, u as usr;
end $$;
select org, branch, variant from conc_fixture;
SQL
)"

# The temp table died with that session; re-read the ids from the catalog.
read -r ORG BRANCH VARIANT USR <<<"$(
  "${PSQL[@]}" -c "
    select o.id, b.id, v.id, o.owner_user_id
    from organizations o
    join branches b on b.organization_id = o.id
    join retail_variants v on v.organization_id = o.id
    where o.slug = 'concstore';" | tr '|' ' '
)"
echo "   org=$ORG branch=$BRANCH variant=$VARIANT"

sell_sql() {
  cat <<SQL
begin;
select set_config('request.jwt.claims', '{"sub":"$USR","role":"authenticated"}', true);
select set_config('role', 'authenticated', true);
insert into retail_stock_movements (organization_id, branch_id, variant_id, quantity_delta, reason)
values ('$ORG', '$BRANCH', '$VARIANT', -1, 'sale');
select pg_sleep($1);
commit;
SQL
}

echo "→ two sessions selling the last unit at once"
# Session A holds the row lock for two seconds before committing.
sell_sql 2 | "${PSQL[@]}" >/tmp/lb-conc-a.log 2>&1 &
A_PID=$!
sleep 0.4
# Session B arrives while A still holds the lock; it must block, then fail.
sell_sql 0 | "${PSQL[@]}" >/tmp/lb-conc-b.log 2>&1 && B_OK=1 || B_OK=0
wait $A_PID && A_OK=1 || A_OK=0

echo "   session A ok=$A_OK   session B ok=$B_OK"

if [ "$A_OK" -ne 1 ]; then
  echo "FAIL: the first sale did not succeed"; cat /tmp/lb-conc-a.log; exit 1
fi
if [ "$B_OK" -ne 0 ]; then
  echo "FAIL: both sessions sold the same unit — inventory oversold"; exit 1
fi
if ! grep -q "retail_stock_non_negative" /tmp/lb-conc-b.log; then
  echo "FAIL: the second sale failed for the wrong reason:"; cat /tmp/lb-conc-b.log; exit 1
fi

FINAL="$("${PSQL[@]}" -c "select quantity from retail_stock_levels where variant_id='$VARIANT';")"
LEDGER="$("${PSQL[@]}" -c "select coalesce(sum(quantity_delta),0) from retail_stock_movements where variant_id='$VARIANT';")"
MOVES="$("${PSQL[@]}" -c "select count(*) from retail_stock_movements where variant_id='$VARIANT';")"

echo "   final stock=$FINAL ledger=$LEDGER movements=$MOVES"
[ "$FINAL" = "0.000" ] || { echo "FAIL: expected final stock 0.000, got $FINAL"; exit 1; }
[ "$LEDGER" = "0.000" ] || { echo "FAIL: ledger should sum to 0.000, got $LEDGER"; exit 1; }
[ "$MOVES" = "2" ] || { echo "FAIL: expected 2 movements (initial + one sale), got $MOVES"; exit 1; }

echo "INVENTORY CONCURRENCY: passed — exactly one sale committed, no oversell"
