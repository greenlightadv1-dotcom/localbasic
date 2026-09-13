-- =============================================================================
-- LOCAL BASIC — 0015 Retail returns
--
-- A return never edits the original sale. It writes:
--   * a linked negative payment (kind = 'refund', refund_of_id set)
--   * positive stock movements putting the goods back
--   * a treasury withdrawal
-- so the original invoice and payment remain exactly as they were recorded.
--
-- Over-returning is impossible: each line is capped at what was sold minus
-- what has already come back.
-- =============================================================================

create or replace function public.retail_create_return(
  p_org       uuid,
  p_branch    uuid,
  p_invoice   uuid,
  -- [{"variant_id":"...","quantity":1}, ...]
  p_items     jsonb,
  p_method    text default 'cash',
  p_reason    text default null
)
returns table (
  out_refund_cents bigint,
  out_payment_id   uuid
)
language plpgsql security definer set search_path = '' as $$
declare
  v_user      uuid := auth.uid();
  v_currency  char(3);
  v_item      jsonb;
  v_line      record;
  v_qty       numeric(14,3);
  v_sold      numeric(14,3);
  v_returned  numeric(14,3);
  v_unit_ref  bigint;
  v_refund    bigint := 0;
  v_orig_pay  uuid;
  v_payment   uuid;
  v_account   uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if not app.has_branch_permission(p_org, p_branch, 'payment.refund') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select o.currency into v_currency
    from public.invoices i
    join public.organizations o on o.id = i.organization_id
   where i.id = p_invoice
     and i.organization_id = p_org
     and i.branch_id = p_branch
     and i.voided_at is null;
  if v_currency is null then
    raise exception 'invoice not found in this branch' using errcode = 'check_violation';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'a return needs at least one item' using errcode = 'check_violation';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select ii.ref_id, ii.quantity, ii.total_cents
      into v_line
      from public.invoice_items ii
     where ii.invoice_id = p_invoice
       and ii.ref_type = 'retail_variant'
       and ii.ref_id = (v_item ->> 'variant_id')::uuid;

    if v_line.ref_id is null then
      raise exception 'item was not on this invoice' using errcode = 'check_violation';
    end if;

    v_qty  := coalesce((v_item ->> 'quantity')::numeric, 0);
    v_sold := v_line.quantity;
    if v_qty <= 0 then
      raise exception 'return quantity must be positive' using errcode = 'check_violation';
    end if;

    -- How much of this line has already been returned against this invoice.
    select coalesce(sum(m.quantity_delta), 0) into v_returned
      from public.retail_stock_movements m
     where m.ref_type = 'invoice' and m.ref_id = p_invoice
       and m.variant_id = v_line.ref_id and m.reason = 'return';

    if v_qty + v_returned > v_sold then
      raise exception 'cannot return more than was sold' using errcode = 'check_violation';
    end if;

    -- Refund at the price actually charged on this invoice, including its
    -- share of tax and discount — not at the current catalogue price.
    v_unit_ref := round(v_line.total_cents::numeric / v_sold);
    v_refund   := v_refund + round(v_unit_ref * v_qty);

    insert into public.retail_stock_movements
      (organization_id, branch_id, variant_id, quantity_delta, reason,
       ref_type, ref_id, note, created_by)
    values
      (p_org, p_branch, v_line.ref_id, v_qty, 'return', 'invoice', p_invoice, p_reason, v_user);
  end loop;

  if v_refund <= 0 then
    raise exception 'nothing to refund' using errcode = 'check_violation';
  end if;

  -- Link the refund to the original payment so the two are traceable together.
  select id into v_orig_pay from public.payments
   where invoice_id = p_invoice and kind = 'payment' and status = 'completed'
   order by created_at limit 1;
  if v_orig_pay is null then
    raise exception 'the original sale was never paid' using errcode = 'check_violation';
  end if;

  select id into v_account from public.treasury_accounts
   where branch_id = p_branch and is_active and is_default limit 1;

  insert into public.payments
    (organization_id, branch_id, invoice_id, kind, method, amount_cents, currency,
     status, treasury_account_id, refund_of_id, reference, created_by)
  values
    (p_org, p_branch, p_invoice, 'refund', p_method, -v_refund, v_currency,
     'completed', v_account, v_orig_pay, p_reason, v_user)
  returning id into v_payment;

  if v_account is not null then
    insert into public.treasury_transactions
      (organization_id, branch_id, account_id, direction, amount_cents, currency,
       category, reason, ref_type, ref_id, created_by)
    values
      (p_org, p_branch, v_account, 'out', v_refund, v_currency,
       'refund', coalesce(p_reason, 'مرتجع'), 'invoice', p_invoice, v_user);
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values
    (p_org, p_branch, v_user, 'retail.return.completed', 'invoice', p_invoice::text,
     jsonb_build_object('refund_cents', v_refund, 'reason', p_reason));

  return query select v_refund, v_payment;
end;
$$;

grant execute on function public.retail_create_return(uuid, uuid, uuid, jsonb, text, text)
to authenticated;
