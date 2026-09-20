#!/usr/bin/env bash
# =============================================================================
# LOCAL BASIC — restaurant payment concurrency test
#
# Two cashiers press "take payment" on the same order at the same moment.
# Exactly one payment must be recorded, against exactly one invoice.
#
# Before 0054 this produced a double payment. restaurant_pay_order() read the
# order and summed its payments without locking anything, so under READ
# COMMITTED neither transaction could see the other's uncommitted rows and both
# concluded the order was unpaid:
#
#     completed_payments = 2    total_taken = 20000
#     invoices           = 2    order_total  = 10000
#
# Proving this needs two real connections, so it lives in a shell script beside
# the inventory concurrency test rather than in the SQL suite.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${TEST_DB:-localbasic_test}"
PSQL=(psql -h "${PGHOST:-/tmp}" -p "${PGPORT:-5433}" -U "${PGUSER:-postgres}" -d "$DB" -tAX -v ON_ERROR_STOP=1)

echo "→ payment concurrency fixture"
"${PSQL[@]}" >/dev/null <<'SQL'
do $$
declare u uuid; org uuid; br uuid; cat uuid; prod uuid; var uuid; ord uuid; tot bigint;
begin
  insert into auth.users (email) values ('paycon@test.local') returning id into u;
  perform auth.login_as(u);
  select out_organization_id, out_branch_id into org, br
    from public.provision_workspace('مطعم التزامن', 'payconc', 'restaurant');

  insert into public.restaurant_categories (organization_id, name)
  values (org, 'مشروبات') returning id into cat;
  insert into public.restaurant_products (organization_id, category_id, name, is_active)
  values (org, cat, 'لاتيه', true) returning id into prod;
  insert into public.restaurant_variants (organization_id, product_id, name, price_cents, is_active)
  values (org, prod, 'default', 10000, true) returning id into var;

  -- One takeaway order of exactly 10000, ready to be paid.
  select out_order_id, out_total_cents into ord, tot
  from public.restaurant_create_order(
    org, br, ('[{"variant_id":"' || var || '","quantity":1}]')::jsonb,
    null, 'takeaway', 'cashier');
end $$;
SQL

read -r ORG ORD USR TOT <<<"$(
  "${PSQL[@]}" -c "
    select o.organization_id, o.id, org.owner_user_id, o.total_cents
    from restaurant_orders o
    join organizations org on org.id = o.organization_id
    where org.slug = 'payconc';" | tr '|' ' '
)"
echo "   order=$ORD total=$TOT"

pay_sql() {
  cat <<SQL
begin;
select set_config('request.jwt.claims', '{"sub":"$USR","role":"authenticated"}', true);
select set_config('role', 'authenticated', true);
select out_paid_cents from restaurant_pay_order('$ORG', '$ORD', 'cash', $TOT, 0);
select pg_sleep($1);
commit;
SQL
}

echo "→ two cashiers taking payment for the same order at once"
# Session A holds its transaction open for two seconds before committing.
pay_sql 2 | "${PSQL[@]}" >/tmp/lb-pay-a.log 2>&1 &
A_PID=$!
sleep 0.4
# Session B arrives while A is still open. With the lock it blocks, then finds
# the order already paid; without it, it takes the money a second time.
pay_sql 0 | "${PSQL[@]}" >/tmp/lb-pay-b.log 2>&1 && B_OK=1 || B_OK=0
wait $A_PID && A_OK=1 || A_OK=0

echo "   session A ok=$A_OK   session B ok=$B_OK"

if [ "$A_OK" -ne 1 ]; then
  echo "FAIL: the first payment did not succeed"; cat /tmp/lb-pay-a.log; exit 1
fi
if ! grep -q "already paid in full" /tmp/lb-pay-b.log; then
  echo "FAIL: the second payment was not refused as already paid:"
  cat /tmp/lb-pay-b.log; exit 1
fi

# The financial outcome is the real assertion. psql's exit status is not:
# it can report success for a transaction whose statement raised.
PAYMENTS="$("${PSQL[@]}" -c "
  select count(*) from payments p
  join invoices i on i.id = p.invoice_id
  join organizations o on o.id = i.organization_id
  where o.slug = 'payconc' and p.status = 'completed';")"
TAKEN="$("${PSQL[@]}" -c "
  select coalesce(sum(p.amount_cents), 0) from payments p
  join invoices i on i.id = p.invoice_id
  join organizations o on o.id = i.organization_id
  where o.slug = 'payconc' and p.status = 'completed';")"
INVOICES="$("${PSQL[@]}" -c "
  select count(*) from invoices i
  join organizations o on o.id = i.organization_id
  where o.slug = 'payconc';")"

echo "   payments=$PAYMENTS taken=$TAKEN invoices=$INVOICES (expected 1 / $TOT / 1)"

[ "$PAYMENTS" = "1" ] || { echo "FAIL: expected exactly 1 payment, got $PAYMENTS — the order was paid twice"; exit 1; }
[ "$TAKEN" = "$TOT" ]  || { echo "FAIL: expected $TOT taken, got $TAKEN"; exit 1; }
[ "$INVOICES" = "1" ] || { echo "FAIL: expected exactly 1 invoice, got $INVOICES"; exit 1; }

echo "RESTAURANT PAYMENT CONCURRENCY: passed — one payment, one invoice, no double charge"
