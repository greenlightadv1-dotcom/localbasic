-- =============================================================================
-- LOCAL BASIC — 0014 Retail sale
--
-- One function, one transaction: invoice → items → payment → stock movements
-- → treasury entry → audit. A sale that cannot complete leaves nothing behind.
--
-- SECURITY DEFINER with explicit authorization at the top rather than relying
-- on RLS, for two reasons:
--   * the permission set a cashier needs is precise (retail.pos.use,
--     invoice.create, payment.create) — going through RLS would force us to
--     hand every cashier invoice.update so the draft could be issued
--   * the checks are stated in one place and audited, instead of being spread
--     across five policies
-- Tenancy is therefore verified here explicitly, on every referenced row.
--
-- PRICES ARE NEVER TAKEN FROM THE CLIENT. The caller supplies variant ids and
-- quantities; unit prices and tax rates are read back from the database, and
-- every total is recomputed here.
-- =============================================================================

create or replace function public.retail_create_sale(
  p_org             uuid,
  p_branch          uuid,
  -- [{"variant_id": "...", "quantity": 2, "discount_cents": 0}, ...]
  p_items           jsonb,
  p_method          text,
  p_tendered_cents  bigint,
  p_customer_id     uuid default null,
  p_order_discount_cents bigint default 0,
  p_note            text default null
)
returns table (
  out_invoice_id     uuid,
  out_invoice_number text,
  out_total_cents    bigint,
  out_paid_cents     bigint,
  out_change_cents   bigint
)
language plpgsql security definer set search_path = '' as $$
declare
  v_user      uuid := auth.uid();
  v_currency  char(3);
  v_invoice   uuid;
  v_number    text;
  v_item      jsonb;
  v_variant   record;
  v_qty       numeric(14,3);
  v_line_disc bigint;
  v_gross     bigint;
  v_net       bigint;
  v_tax       bigint;
  v_subtotal  bigint := 0;
  v_discounts bigint := 0;
  v_tax_total bigint := 0;
  v_total     bigint;
  v_paid      bigint;
  v_change    bigint;
  v_account   uuid;
  v_position  int := 0;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  -- ---- authorization ------------------------------------------------------
  if not app.has_branch_permission(p_org, p_branch, 'retail.pos.use') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'invoice.create') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_tendered_cents > 0
     and not app.has_branch_permission(p_org, p_branch, 'payment.create') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- A manual discount is a separate privilege from operating the till.
  if coalesce(p_order_discount_cents, 0) > 0
     and not app.has_branch_permission(p_org, p_branch, 'retail.pos.discount') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  -- ---- tenancy ------------------------------------------------------------
  select o.currency into v_currency
    from public.organizations o
    join public.branches b on b.organization_id = o.id
   where o.id = p_org and b.id = p_branch and b.is_active and b.deleted_at is null;
  if v_currency is null then
    raise exception 'branch does not belong to organization' using errcode = 'check_violation';
  end if;

  if p_customer_id is not null and not exists (
    select 1 from public.customers c
     where c.id = p_customer_id and c.organization_id = p_org and c.deleted_at is null
  ) then
    raise exception 'customer does not belong to organization' using errcode = 'check_violation';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'a sale needs at least one item' using errcode = 'check_violation';
  end if;

  if p_method not in ('cash','card','transfer','wallet','online','other') then
    raise exception 'unknown payment method %', p_method using errcode = '22023';
  end if;

  -- ---- invoice shell ------------------------------------------------------
  v_number := app.next_document_number(p_org, p_branch, 'invoice');

  insert into public.invoices
    (organization_id, branch_id, number, customer_id, status, source, currency,
     subtotal_cents, discount_cents, tax_cents, total_cents, notes, issued_at, created_by)
  values
    (p_org, p_branch, v_number, p_customer_id, 'draft', 'pos', v_currency,
     0, 0, 0, 0, p_note, now(), v_user)
  returning id into v_invoice;

  -- ---- lines --------------------------------------------------------------
  for v_item in select * from jsonb_array_elements(p_items) loop
    select v.id, v.price_cents, v.name as variant_name, v.organization_id,
           pr.name as product_name, pr.tax_rate_bp
      into v_variant
      from public.retail_variants v
      join public.retail_products pr on pr.id = v.product_id
     where v.id = (v_item ->> 'variant_id')::uuid
       and v.organization_id = p_org
       and v.is_active and v.deleted_at is null;

    if v_variant.id is null then
      raise exception 'unknown or inactive variant' using errcode = 'check_violation';
    end if;

    v_qty := coalesce((v_item ->> 'quantity')::numeric, 0);
    if v_qty <= 0 then
      raise exception 'quantity must be positive' using errcode = 'check_violation';
    end if;

    v_line_disc := coalesce((v_item ->> 'discount_cents')::bigint, 0);
    if v_line_disc < 0 then
      raise exception 'discount cannot be negative' using errcode = 'check_violation';
    end if;
    if v_line_disc > 0
       and not app.has_branch_permission(p_org, p_branch, 'retail.pos.discount') then
      raise exception 'not permitted' using errcode = '42501';
    end if;

    -- Integer arithmetic throughout; the single rounding happens here.
    v_gross := round(v_variant.price_cents * v_qty);
    v_line_disc := least(v_line_disc, v_gross);
    v_net  := v_gross - v_line_disc;
    v_tax  := round((v_net * v_variant.tax_rate_bp)::numeric / 10000);

    v_subtotal  := v_subtotal + v_gross;
    v_discounts := v_discounts + v_line_disc;
    v_tax_total := v_tax_total + v_tax;
    v_position  := v_position + 1;

    insert into public.invoice_items
      (invoice_id, organization_id, ref_type, ref_id, description, quantity,
       unit_price_cents, discount_cents, tax_rate_bp, total_cents, position)
    values
      (v_invoice, p_org, 'retail_variant', v_variant.id,
       v_variant.product_name ||
         case when v_variant.variant_name = 'default' then '' else ' — ' || v_variant.variant_name end,
       v_qty, v_variant.price_cents, v_line_disc, v_variant.tax_rate_bp, v_net + v_tax, v_position);

    -- Stock leaves the branch. The trigger on this insert takes the row lock
    -- and rejects the whole sale if it would drive stock negative.
    insert into public.retail_stock_movements
      (organization_id, branch_id, variant_id, quantity_delta, reason,
       ref_type, ref_id, created_by)
    values
      (p_org, p_branch, v_variant.id, -v_qty, 'sale', 'invoice', v_invoice, v_user);
  end loop;

  -- ---- totals -------------------------------------------------------------
  -- Line discounts are applied before tax; an order-level discount is applied
  -- after, so it never changes the tax already charged per line.
  v_discounts := v_discounts + greatest(coalesce(p_order_discount_cents, 0), 0);
  v_total := v_subtotal - v_discounts + v_tax_total;
  if v_total < 0 then
    raise exception 'discount exceeds the value of the sale' using errcode = 'check_violation';
  end if;

  update public.invoices
     set subtotal_cents = v_subtotal,
         discount_cents = v_discounts,
         tax_cents      = v_tax_total,
         total_cents    = v_total,
         status         = 'issued'
   where id = v_invoice;

  -- ---- payment ------------------------------------------------------------
  -- Cash may be tendered above the total; the sale is recorded at its own
  -- value and the difference is change, never an overpayment on the ledger.
  v_paid   := least(greatest(coalesce(p_tendered_cents, 0), 0), v_total);
  v_change := greatest(coalesce(p_tendered_cents, 0) - v_total, 0);

  if v_paid > 0 then
    select id into v_account from public.treasury_accounts
     where branch_id = p_branch and is_active and is_default limit 1;

    insert into public.payments
      (organization_id, branch_id, invoice_id, customer_id, kind, method,
       amount_cents, currency, status, treasury_account_id, created_by)
    values
      (p_org, p_branch, v_invoice, p_customer_id, 'payment', p_method,
       v_paid, v_currency, 'completed', v_account, v_user);

    if v_account is not null then
      insert into public.treasury_transactions
        (organization_id, branch_id, account_id, direction, amount_cents, currency,
         category, reason, ref_type, ref_id, created_by)
      values
        (p_org, p_branch, v_account, 'in', v_paid, v_currency,
         'sale', 'بيع ' || v_number, 'invoice', v_invoice, v_user);
    end if;
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, p_branch, v_user, 'retail.sale.completed', 'invoice', v_invoice::text,
     jsonb_build_object('number', v_number, 'total_cents', v_total, 'paid_cents', v_paid));

  return query select v_invoice, v_number, v_total, v_paid, v_change;
end;
$$;

grant execute on function public.retail_create_sale(
  uuid, uuid, jsonb, text, bigint, uuid, bigint, text
) to authenticated;

-- A cashier must be able to put the takings in the till.
insert into public.role_permissions (role_id, permission_key)
select r.id, 'treasury.create'
from public.roles r
where r.key = 'cashier'
on conflict do nothing;
