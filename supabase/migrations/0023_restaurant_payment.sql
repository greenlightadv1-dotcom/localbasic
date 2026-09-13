-- =============================================================================
-- LOCAL BASIC — 0023 Restaurant payment and receipts
--
-- Paying an order settles it through CORE: a Core invoice, a Core payment and
-- a Core treasury entry. There is no restaurant-specific money table.
--
-- The customer-facing document is a RECEIPT (إيصال). It is not represented as
-- an Egyptian tax invoice, and nothing here claims tax-authority approval. The
-- shape is ready for a future e-invoicing adapter to consume, and that adapter
-- is where any such claim would belong.
-- =============================================================================

create or replace function public.restaurant_pay_order(
  p_org             uuid,
  p_order           uuid,
  p_method          text default 'cash',
  p_tendered_cents  bigint default 0,
  p_discount_cents  bigint default 0
)
returns table (
  out_invoice_id     uuid,
  out_receipt_number text,
  out_total_cents    bigint,
  out_paid_cents     bigint,
  out_due_cents      bigint,
  out_change_cents   bigint
)
language plpgsql security definer set search_path = '' as $$
declare
  v_user     uuid := auth.uid();
  v_order    record;
  v_currency char(3);
  v_subtotal bigint;
  v_tax      bigint;
  v_discount bigint;
  v_total    bigint;
  v_invoice  uuid;
  v_number   text;
  v_already  bigint;
  v_due      bigint;
  v_apply    bigint;
  v_change   bigint;
  v_account  uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select o.id, o.branch_id, o.status, o.table_id, o.invoice_id, o.customer_id,
         o.number, o.currency, o.discount_cents
    into v_order
    from public.restaurant_orders o
   where o.id = p_order and o.organization_id = p_org;
  if v_order.id is null then
    raise exception 'order not found' using errcode = 'check_violation';
  end if;

  if not app.has_branch_permission(p_org, v_order.branch_id, 'restaurant.pos.use') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.has_branch_permission(p_org, v_order.branch_id, 'payment.create') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'a cancelled order cannot be paid' using errcode = 'check_violation';
  end if;

  v_currency := v_order.currency;
  v_discount := greatest(coalesce(p_discount_cents, 0), 0);

  -- A discount is a separate privilege from taking money.
  if v_discount > 0
     and not app.has_branch_permission(p_org, v_order.branch_id, 'restaurant.pos.discount') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  -- Totals are recomputed from the order's own lines every time, so a client
  -- cannot post a total, and a discount cannot be applied twice.
  select coalesce(sum(line_total_cents - round((line_total_cents * tax_rate_bp)::numeric
                                               / (10000 + tax_rate_bp))), 0),
         coalesce(sum(round((line_total_cents * tax_rate_bp)::numeric / (10000 + tax_rate_bp))), 0)
    into v_subtotal, v_tax
    from public.restaurant_order_items where order_id = p_order;

  v_total := v_subtotal + v_tax - v_discount;
  if v_total < 0 then
    raise exception 'discount exceeds the order total' using errcode = 'check_violation';
  end if;

  -- ---- the Core invoice (the receipt) --------------------------------------
  if v_order.invoice_id is null then
    v_number := app.next_document_number(p_org, v_order.branch_id, 'invoice');

    insert into public.invoices
      (organization_id, branch_id, number, customer_id, status, source, currency,
       subtotal_cents, discount_cents, tax_cents, total_cents, notes, issued_at, created_by)
    values
      (p_org, v_order.branch_id, v_number, v_order.customer_id, 'issued', 'restaurant',
       v_currency, v_subtotal, v_discount, v_tax, v_total,
       'طلب رقم ' || v_order.number, now(), v_user)
    returning id into v_invoice;

    insert into public.invoice_items
      (invoice_id, organization_id, ref_type, ref_id, description, quantity,
       unit_price_cents, discount_cents, tax_rate_bp, total_cents, position)
    select
      v_invoice, p_org, 'restaurant_variant', i.variant_id,
      i.product_name ||
        case when i.variant_name = 'default' then '' else ' — ' || i.variant_name end,
      i.quantity, i.unit_price_cents + i.modifiers_cents, 0, i.tax_rate_bp,
      i.line_total_cents, i.position
    from public.restaurant_order_items i
    where i.order_id = p_order;

    update public.restaurant_orders
       set invoice_id = v_invoice,
           discount_cents = v_discount,
           subtotal_cents = v_subtotal,
           tax_cents = v_tax,
           total_cents = v_total
     where id = p_order;
  else
    v_invoice := v_order.invoice_id;
    select number, total_cents into v_number, v_total
      from public.invoices where id = v_invoice;
  end if;

  -- ---- payment -------------------------------------------------------------
  select coalesce(sum(amount_cents), 0) into v_already
    from public.payments where invoice_id = v_invoice and status = 'completed';

  v_due := v_total - v_already;
  if v_due <= 0 then
    raise exception 'this order is already paid in full' using errcode = 'check_violation';
  end if;

  -- Partial payments are supported: whatever is tendered goes against the
  -- balance, and anything above it is change, never an overpayment.
  v_apply  := least(greatest(coalesce(p_tendered_cents, 0), 0), v_due);
  v_change := greatest(coalesce(p_tendered_cents, 0) - v_due, 0);

  if v_apply > 0 then
    select id into v_account from public.treasury_accounts
     where branch_id = v_order.branch_id and is_active and is_default limit 1;

    insert into public.payments
      (organization_id, branch_id, invoice_id, customer_id, kind, method,
       amount_cents, currency, status, treasury_account_id, reference, created_by)
    values
      (p_org, v_order.branch_id, v_invoice, v_order.customer_id, 'payment', p_method,
       v_apply, v_currency, 'completed', v_account, v_order.number, v_user);

    if v_account is not null then
      insert into public.treasury_transactions
        (organization_id, branch_id, account_id, direction, amount_cents, currency,
         category, reason, ref_type, ref_id, created_by)
      values
        (p_org, v_order.branch_id, v_account, 'in', v_apply, v_currency,
         'sale', 'طلب ' || v_order.number, 'invoice', v_invoice, v_user);
    end if;
  end if;

  v_due := v_total - (v_already + v_apply);

  -- The table is waiting on payment until the balance is clear.
  if v_order.table_id is not null and v_due > 0 then
    update public.restaurant_tables
       set status = 'waiting_payment'
     where id = v_order.table_id and status = 'occupied';
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, v_order.branch_id, v_user, 'restaurant.order.paid', 'restaurant_order',
     p_order::text,
     jsonb_build_object('invoice', v_invoice, 'method', p_method,
                        'amount_cents', v_apply, 'due_cents', v_due));

  return query select v_invoice, v_number, v_total, v_already + v_apply, v_due, v_change;
end;
$$;

grant execute on function public.restaurant_pay_order(uuid, uuid, text, bigint, bigint)
to authenticated;

-- ---------------------------------------------------------------------------
-- Table QR provisioning.
--
-- Creates the Core public link behind a table's QR, or rotates it. The printed
-- code carries only the token, so reassigning a sticker to another table is a
-- change of the link's target and nothing has to be reprinted.
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_issue_table_link(
  p_org uuid, p_table uuid, p_token text
)
returns table (out_link_id uuid, out_token text)
language plpgsql security definer set search_path = '' as $$
declare
  v_user   uuid := auth.uid();
  v_table  record;
  v_link   uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select id, branch_id, name, public_link_id into v_table
    from public.restaurant_tables
   where id = p_table and organization_id = p_org and deleted_at is null;
  if v_table.id is null then
    raise exception 'table not found' using errcode = 'check_violation';
  end if;

  if not app.has_branch_permission(p_org, v_table.branch_id, 'restaurant.table.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  -- Rotating retires the old token rather than deleting it, so a link that was
  -- printed somewhere stops working instead of silently pointing elsewhere.
  if v_table.public_link_id is not null then
    update public.public_links
       set is_active = false, revoked_at = now()
     where id = v_table.public_link_id;
  end if;

  insert into public.public_links
    (organization_id, branch_id, kind, token, target, label, created_by)
  values
    (p_org, v_table.branch_id, 'menu', p_token,
     jsonb_build_object('entity_type', 'restaurant_table', 'entity_id', p_table),
     'طاولة ' || v_table.name, v_user)
  returning id into v_link;

  insert into public.qr_codes
    (organization_id, branch_id, public_link_id, label, entity_type, entity_id, created_by)
  values
    (p_org, v_table.branch_id, v_link, 'طاولة ' || v_table.name,
     'restaurant_table', p_table, v_user);

  update public.restaurant_tables set public_link_id = v_link where id = p_table;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, v_table.branch_id, v_user, 'restaurant.table.qr_issued', 'restaurant_table',
     p_table::text, jsonb_build_object('link_id', v_link));

  return query select v_link, p_token;
end;
$$;

grant execute on function public.restaurant_issue_table_link(uuid, uuid, text) to authenticated;
