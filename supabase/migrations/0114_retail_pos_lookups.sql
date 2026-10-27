-- =============================================================================
-- LOCAL BASIC — 0114 Retail POS lookups
--
-- Two reads the retail till needs and no existing function answers for a
-- cashier:
--
--   retail_customer_lookup  a phone number → the matching customers with their
--                           store-credit balance and loyalty points (the shared
--                           0095/0107 programme), so the till can attach a
--                           customer and offer credit.
--   retail_receipt_lookup   a receipt number → its lines, what has already come
--                           back, and the per-unit refund value, priced exactly
--                           as retail_process_return (0112) will price it.
--
-- Both are read-only SECURITY DEFINER functions with the permission check at
-- the top, like every other entry point here.
-- =============================================================================

create or replace function public.retail_customer_lookup(p_org uuid, p_phone text)
returns table (customer_id uuid, name text, phone text, store_credit_cents bigint,
               loyalty_points int, loyalty_enabled boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_key     text := app.phone_key(coalesce(p_phone, ''));
  v_enabled boolean;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'retail.pos.use') then raise exception 'not permitted' using errcode = '42501'; end if;
  if length(coalesce(v_key, '')) < 7 then return; end if;

  select coalesce((select s.enabled from public.restaurant_loyalty_settings s where s.organization_id = p_org), false)
    into v_enabled;

  return query
    select c.id, c.name, c.phone,
           app.retail_store_credit_balance(p_org, c.id),
           case when v_enabled then (select lp.out_balance from app.loyalty_points(p_org, v_key) lp) else 0 end,
           v_enabled
      from public.customers c
     where c.organization_id = p_org and c.deleted_at is null and c.phone is not null
       and app.phone_key(c.phone) = v_key
     order by c.created_at
     limit 5;
end;
$$;

create or replace function public.retail_receipt_lookup(p_org uuid, p_branch uuid, p_number text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_inv   record;
  v_ratio numeric;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.return.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select i.id, i.number, i.issued_at, i.total_cents, i.paid_cents, i.status, i.customer_id,
         c.name as customer_name, c.phone as customer_phone
    into v_inv
    from public.invoices i
    left join public.customers c on c.id = i.customer_id
   where i.organization_id = p_org and i.branch_id = p_branch and i.voided_at is null
     and i.source = 'pos' and upper(i.number) = upper(trim(coalesce(p_number, '')))
   limit 1;
  if v_inv.id is null then return null; end if;

  -- Same sharing of invoice-level discounts as retail_process_return.
  select case when coalesce(sum(total_cents), 0) > 0 then least(v_inv.total_cents::numeric / sum(total_cents), 1) else 1 end
    into v_ratio from public.invoice_items where invoice_id = v_inv.id;

  return jsonb_build_object(
    'invoice_id', v_inv.id, 'number', v_inv.number, 'issued_at', v_inv.issued_at,
    'total_cents', v_inv.total_cents, 'paid_cents', v_inv.paid_cents, 'status', v_inv.status,
    'customer', case when v_inv.customer_id is null then null
                     else jsonb_build_object('id', v_inv.customer_id, 'name', v_inv.customer_name, 'phone', v_inv.customer_phone) end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'variant_id', ii.ref_id, 'description', ii.description, 'quantity', ii.quantity,
               'returned', coalesce((select sum(m.quantity_delta) from public.retail_stock_movements m
                                      where m.ref_type = 'invoice' and m.ref_id = v_inv.id
                                        and m.variant_id = ii.ref_id and m.reason = 'return'), 0),
               'unit_refund_cents', round(ii.total_cents * v_ratio / ii.quantity)::bigint)
             order by ii.position)
        from public.invoice_items ii
       where ii.invoice_id = v_inv.id and ii.ref_type = 'retail_variant'), '[]'::jsonb));
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.retail_customer_lookup(uuid, text)',
    'public.retail_receipt_lookup(uuid, uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
