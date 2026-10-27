-- =============================================================================
-- LOCAL BASIC — 0112 Retail operations: transfers, returns, promotions, reorder
--
-- The functions behind 0111's retail tables.
--
--   1. Transfers     request → approve/reject → dispatch → receive (partial
--                    receipt records the shortage), cancel. Stock leaves the
--                    source on dispatch and arrives at the destination on
--                    receipt, so goods in transit belong to neither shelf.
--   2. Promotions    app.retail_promotions_evaluate() prices a cart against the
--                    active promotions; retail_promotions_preview() shows it at
--                    the till; retail_checkout() applies it.
--   3. Checkout      retail_checkout(): the sale with promotions, store credit
--                    as a tender, and loyalty points. retail_create_sale stays
--                    as it was for existing callers.
--   4. Returns       retail_process_return(): receipt-based, per-line resellable
--                    or damaged, refunded as cash (manager PIN), card, store
--                    credit, or exchanged for new goods.
--   5. Store credit  retail_store_credit_adjust() (manager PIN) and a balance read.
--   6. Reorder       retail_reorder_suggestions() and retail_reorder_generate():
--                    draft purchase orders per preferred supplier.
--
-- Same shape as every money path here: SECURITY DEFINER, authorization and
-- tenancy checked at the top, prices read from the database, one transaction,
-- an audit line.
-- =============================================================================

-- =============================================================================
-- 1. Transfer workflow
-- =============================================================================
create or replace function app.retail_transfer_for_update(p_org uuid, p_transfer uuid)
returns public.retail_stock_transfers language plpgsql security definer set search_path = '' as $$
declare v public.retail_stock_transfers;
begin
  select * into v from public.retail_stock_transfers
   where id = p_transfer and organization_id = p_org for update;
  if v.id is null then raise exception 'التحويل غير موجود' using errcode = 'P0002'; end if;
  return v;
end;
$$;

create or replace function app.retail_transfer_audit(p_tr public.retail_stock_transfers, p_action text, p_extra jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_tr.organization_id, p_tr.from_branch_id, auth.uid(), p_action, 'retail_stock_transfer', p_tr.id::text,
          jsonb_build_object('number', p_tr.number, 'from_branch', p_tr.from_branch_id,
                             'to_branch', p_tr.to_branch_id) || coalesce(p_extra, '{}'));
$$;

-- The branch that needs stock asks the branch that has it.
create or replace function public.retail_transfer_request(
  p_org uuid, p_from_branch uuid, p_to_branch uuid, p_items jsonb, p_reason text default null
) returns table (out_transfer_id uuid, out_number text)
language plpgsql security definer set search_path = '' as $$
declare
  v_tr   public.retail_stock_transfers;
  v_item jsonb;
  v_qty  numeric(14,3);
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_from_branch = p_to_branch then
    raise exception 'المصدر والوجهة لا يمكن أن يكونا نفس الفرع' using errcode = 'check_violation';
  end if;
  if not app.has_branch_permission(p_org, p_to_branch, 'retail.inventory.transfer') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if (select count(*) from public.branches b
       where b.id in (p_from_branch, p_to_branch) and b.organization_id = p_org
         and b.is_active and b.deleted_at is null) <> 2 then
    raise exception 'فرع غير صالح' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 500 then
    raise exception 'التحويل يحتاج صنفًا واحدًا على الأقل' using errcode = 'check_violation';
  end if;

  insert into public.retail_stock_transfers
    (organization_id, from_branch_id, to_branch_id, status, number, reason, requested_at, created_by)
  values (p_org, p_from_branch, p_to_branch, 'requested',
          'TR-' || app.next_document_number(p_org, p_to_branch, 'retail_transfer'),
          nullif(left(trim(coalesce(p_reason, '')), 300), ''), now(), auth.uid())
  returning * into v_tr;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item ->> 'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'الكمية يجب أن تكون أكبر من صفر' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from public.retail_variants v
                    where v.id = (v_item ->> 'variant_id')::uuid and v.organization_id = p_org and v.deleted_at is null) then
      raise exception 'صنف غير صالح' using errcode = 'check_violation';
    end if;
    insert into public.retail_stock_transfer_lines (transfer_id, organization_id, variant_id, quantity)
    values (v_tr.id, p_org, (v_item ->> 'variant_id')::uuid, v_qty)
    on conflict (transfer_id, variant_id) do update set quantity = public.retail_stock_transfer_lines.quantity + excluded.quantity;
  end loop;

  perform app.retail_transfer_audit(v_tr, 'retail.transfer.requested', jsonb_build_object('lines', jsonb_array_length(p_items)));
  return query select v_tr.id, v_tr.number;
end;
$$;

-- The source branch's manager approves or rejects.
create or replace function public.retail_transfer_decide(
  p_org uuid, p_transfer uuid, p_approve boolean, p_note text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare v_tr public.retail_stock_transfers;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  v_tr := app.retail_transfer_for_update(p_org, p_transfer);
  if not app.has_branch_permission(p_org, v_tr.from_branch_id, 'retail.transfer.approve') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_tr.status <> 'requested' then
    raise exception 'التحويل ليس بانتظار الموافقة' using errcode = 'check_violation';
  end if;
  if not p_approve and coalesce(trim(p_note), '') = '' then
    raise exception 'سبب الرفض مطلوب' using errcode = '22023';
  end if;

  update public.retail_stock_transfers
     set status = case when p_approve then 'approved' else 'rejected' end,
         approved_by = auth.uid(), approved_at = now(),
         cancel_reason = case when p_approve then cancel_reason else left(trim(p_note), 300) end,
         note = coalesce(note, nullif(left(trim(coalesce(p_note, '')), 500), ''))
   where id = p_transfer
  returning * into v_tr;
  perform app.retail_transfer_audit(v_tr, case when p_approve then 'retail.transfer.approved' else 'retail.transfer.rejected' end);
end;
$$;

-- Goods leave the source. p_items may lower a line's quantity (short pick);
-- a line set to 0 is dropped. Lines not listed ship as approved.
create or replace function public.retail_transfer_dispatch(
  p_org uuid, p_transfer uuid, p_items jsonb default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_tr   public.retail_stock_transfers;
  v_item jsonb;
  v_line record;
  v_qty  numeric(14,3);
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  v_tr := app.retail_transfer_for_update(p_org, p_transfer);
  if not app.has_branch_permission(p_org, v_tr.from_branch_id, 'retail.inventory.transfer') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_tr.status <> 'approved' then
    raise exception 'يجب اعتماد التحويل قبل الشحن' using errcode = 'check_violation';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_qty := (v_item ->> 'quantity')::numeric;
    select * into v_line from public.retail_stock_transfer_lines
     where transfer_id = p_transfer and variant_id = (v_item ->> 'variant_id')::uuid;
    if v_line.id is null then raise exception 'الصنف ليس في التحويل' using errcode = 'check_violation'; end if;
    if v_qty is null or v_qty < 0 or v_qty > v_line.quantity then
      raise exception 'لا يمكن شحن أكثر من المطلوب' using errcode = 'check_violation';
    end if;
    if v_qty = 0 then
      delete from public.retail_stock_transfer_lines where id = v_line.id;
    else
      update public.retail_stock_transfer_lines set quantity = v_qty where id = v_line.id;
    end if;
  end loop;

  if not exists (select 1 from public.retail_stock_transfer_lines where transfer_id = p_transfer) then
    raise exception 'لا توجد أصناف للشحن' using errcode = 'check_violation';
  end if;

  -- 0012's trigger refuses to drive the source negative; the whole dispatch aborts.
  insert into public.retail_stock_movements
    (organization_id, branch_id, variant_id, quantity_delta, reason, ref_type, ref_id, created_by)
  select p_org, v_tr.from_branch_id, l.variant_id, -l.quantity, 'transfer_out', 'transfer', p_transfer, auth.uid()
    from public.retail_stock_transfer_lines l where l.transfer_id = p_transfer;

  update public.retail_stock_transfers
     set status = 'in_transit', dispatched_by = auth.uid(), dispatched_at = now()
   where id = p_transfer
  returning * into v_tr;
  perform app.retail_transfer_audit(v_tr, 'retail.transfer.dispatched');
end;
$$;

-- Goods arrive. p_items carries what was counted per line; unlisted lines are
-- received in full. A shortfall is recorded on the line and in the audit log:
-- it already left the source and never reached the destination.
create or replace function public.retail_transfer_receive(
  p_org uuid, p_transfer uuid, p_items jsonb default null, p_note text default null
) returns table (out_shortage_lines int, out_shortage_qty numeric)
language plpgsql security definer set search_path = '' as $$
declare
  v_tr     public.retail_stock_transfers;
  v_item   jsonb;
  v_line   record;
  v_qty    numeric(14,3);
  v_lines  int;
  v_short  numeric(14,3);
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  v_tr := app.retail_transfer_for_update(p_org, p_transfer);
  if not app.has_branch_permission(p_org, v_tr.to_branch_id, 'retail.inventory.transfer') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_tr.status <> 'in_transit' then
    raise exception 'التحويل لم يُشحن بعد' using errcode = 'check_violation';
  end if;
  if v_tr.dispatched_by = auth.uid() and not app.has_branch_permission(p_org, v_tr.to_branch_id, 'retail.transfer.approve') then
    raise exception 'لا يمكن لنفس الشخص الشحن والاستلام' using errcode = '42501';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_qty := (v_item ->> 'quantity_received')::numeric;
    select * into v_line from public.retail_stock_transfer_lines
     where transfer_id = p_transfer and variant_id = (v_item ->> 'variant_id')::uuid;
    if v_line.id is null then raise exception 'الصنف ليس في التحويل' using errcode = 'check_violation'; end if;
    if v_qty is null or v_qty < 0 or v_qty > v_line.quantity then
      raise exception 'الكمية المستلمة أكبر من المشحونة' using errcode = 'check_violation';
    end if;
    update public.retail_stock_transfer_lines set quantity_received = v_qty where id = v_line.id;
  end loop;
  update public.retail_stock_transfer_lines set quantity_received = quantity
   where transfer_id = p_transfer and quantity_received is null;

  insert into public.retail_stock_movements
    (organization_id, branch_id, variant_id, quantity_delta, reason, ref_type, ref_id, note, created_by)
  select p_org, v_tr.to_branch_id, l.variant_id, l.quantity_received, 'transfer_in', 'transfer', p_transfer,
         nullif(left(trim(coalesce(p_note, '')), 300), ''), auth.uid()
    from public.retail_stock_transfer_lines l
   where l.transfer_id = p_transfer and l.quantity_received > 0;

  select count(*) filter (where quantity_received < quantity), coalesce(sum(quantity - quantity_received), 0)
    into v_lines, v_short
    from public.retail_stock_transfer_lines where transfer_id = p_transfer;

  update public.retail_stock_transfers
     set status = 'received', received_by = auth.uid(), received_at = now()
   where id = p_transfer
  returning * into v_tr;
  perform app.retail_transfer_audit(v_tr, 'retail.transfer.received',
    jsonb_build_object('shortage_lines', v_lines, 'shortage_qty', v_short));
  return query select v_lines, v_short;
end;
$$;

create or replace function public.retail_transfer_cancel(p_org uuid, p_transfer uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_tr public.retail_stock_transfers;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  v_tr := app.retail_transfer_for_update(p_org, p_transfer);
  if not (app.has_branch_permission(p_org, v_tr.to_branch_id, 'retail.inventory.transfer')
          or app.has_branch_permission(p_org, v_tr.from_branch_id, 'retail.transfer.approve')) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_tr.status not in ('requested', 'approved') then
    raise exception 'لا يمكن إلغاء تحويل تم شحنه' using errcode = 'check_violation';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'سبب الإلغاء مطلوب' using errcode = '22023'; end if;
  update public.retail_stock_transfers
     set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), cancel_reason = left(trim(p_reason), 300)
   where id = p_transfer
  returning * into v_tr;
  perform app.retail_transfer_audit(v_tr, 'retail.transfer.cancelled');
end;
$$;

-- =============================================================================
-- 2. Promotions engine
-- =============================================================================

-- Prices a cart from the database. Input: [{variant_id, quantity}] (repeats
-- are merged). Output lines carry product, category and catalogue price.
create or replace function app.retail_cart_lines(p_org uuid, p_items jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'variant_id', v.id, 'product_id', p.id, 'category_id', p.category_id,
           'quantity', q.qty, 'unit_price_cents', v.price_cents,
           'gross_cents', round(v.price_cents * q.qty)::bigint)), '[]'::jsonb)
    into v
    from (select (e ->> 'variant_id')::uuid as variant_id, sum((e ->> 'quantity')::numeric) as qty
            from jsonb_array_elements(p_items) e group by 1) q
    join public.retail_variants v on v.id = q.variant_id and v.organization_id = p_org
                                 and v.is_active and v.deleted_at is null
    join public.retail_products p on p.id = v.product_id
   where q.qty > 0;
  return v;
end;
$$;

-- Every promotion that would apply to this cart, and the ones chosen.
-- Selection: highest priority first, then the biggest discount. A stackable
-- winner is joined by every other stackable candidate; a non-stackable winner
-- applies alone. The total never exceeds the cart's gross value.
create or replace function app.retail_promotions_evaluate(
  p_org uuid, p_branch uuid, p_lines jsonb, p_customer uuid, p_code text
) returns table (promotion_id uuid, name text, kind text, code text, discount_cents bigint,
                 points_multiplier numeric, applied boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  p        record;
  c        record;
  v_gross  bigint;
  v_elig   bigint;
  v_units  int;
  v_free   int;
  v_count  numeric;
  v_value  bigint;
  v_disc   bigint;
  v_cands  jsonb := '[]'::jsonb;
  v_top    jsonb;
  v_left   bigint;
  v_el     jsonb;
  v_qsum   numeric;
begin
  select coalesce(sum((l ->> 'gross_cents')::bigint), 0) into v_gross from jsonb_array_elements(p_lines) l;
  if v_gross <= 0 then return; end if;

  for p in
    select pr.* from public.retail_promotions pr
     where pr.organization_id = p_org and pr.is_active and pr.deleted_at is null
       and (pr.branch_id is null or pr.branch_id = p_branch)
       and (pr.starts_at is null or pr.starts_at <= now())
       and (pr.ends_at is null or pr.ends_at > now())
       and (pr.max_uses is null or pr.uses_count < pr.max_uses)
       and (pr.code is null or lower(pr.code::text) = lower(nullif(trim(coalesce(p_code, '')), '')))
       and (not pr.requires_customer or p_customer is not null)
       and v_gross >= pr.min_subtotal_cents
  loop
    if p.max_uses_per_customer is not null and (
         p_customer is null
         or (select count(*) from public.retail_sale_promotions s
              where s.promotion_id = p.id and s.customer_id = p_customer) >= p.max_uses_per_customer) then
      continue;
    end if;

    -- Eligible lines: those the promotion targets, or the whole cart.
    select coalesce(jsonb_agg(l), '[]'::jsonb) into v_el
      from jsonb_array_elements(p_lines) l
     where p.kind = 'bundle'
        or not exists (select 1 from public.retail_promotion_items i where i.promotion_id = p.id)
        or exists (select 1 from public.retail_promotion_items i
                    where i.promotion_id = p.id
                      and (i.variant_id = (l ->> 'variant_id')::uuid
                        or i.product_id = (l ->> 'product_id')::uuid
                        or i.category_id = nullif(l ->> 'category_id', '')::uuid));

    select coalesce(sum(gross_cents), 0) into v_elig from jsonb_to_recordset(v_el) as x(quantity numeric, gross_cents bigint);
    v_disc := 0;

    if p.kind = 'percent' then
      v_disc := round(v_elig * p.percent_off / 100);
    elsif p.kind = 'amount' then
      v_disc := least(p.amount_off_cents, v_elig);
    elsif p.kind = 'bogo' then
      select coalesce(sum(least(floor(quantity), 10000)), 0)::int into v_units from jsonb_to_recordset(v_el) as x(quantity numeric, gross_cents bigint);
      v_free := (v_units / (p.buy_qty + p.get_qty)) * p.get_qty;
      if v_free > 0 then
        -- The cheapest units are the free ones.
        select round(coalesce(sum(u.price), 0) * p.get_percent_off / 100) into v_disc
          from (select l.unit_price_cents as price
                  from jsonb_to_recordset(v_el) as l(variant_id uuid, product_id uuid, category_id uuid, quantity numeric, unit_price_cents bigint, gross_cents bigint), generate_series(1, least(floor(l.quantity), 10000)::int)
                 order by l.unit_price_cents asc
                 limit v_free) u;
      end if;
    elsif p.kind = 'bundle' then
      v_count := null; v_value := 0;
      for c in select * from public.retail_promotion_items i where i.promotion_id = p.id loop
        select coalesce(sum(l.quantity), 0), min(l.unit_price_cents)
          into v_qsum, v_disc
          from jsonb_to_recordset(v_el) as l(variant_id uuid, product_id uuid, category_id uuid, quantity numeric, unit_price_cents bigint, gross_cents bigint)
         where l.variant_id = c.variant_id or l.product_id = c.product_id or l.category_id = c.category_id;
        v_count := least(coalesce(v_count, floor(v_qsum / c.quantity)), floor(v_qsum / c.quantity));
        v_value := v_value + round(coalesce(v_disc, 0) * c.quantity);
      end loop;
      v_disc := case when coalesce(v_count, 0) > 0
                     then (v_count * greatest(v_value - p.bundle_price_cents, 0))::bigint else 0 end;
    end if;

    if p.max_discount_cents is not null then v_disc := least(v_disc, p.max_discount_cents); end if;
    if v_disc > 0 then
      v_cands := v_cands || jsonb_build_object(
        'id', p.id, 'name', p.name, 'kind', p.kind, 'code', p.code, 'discount', v_disc,
        'mult', p.points_multiplier, 'priority', p.priority, 'stackable', p.stackable);
    end if;
  end loop;

  if jsonb_array_length(v_cands) = 0 then return; end if;

  select c2 into v_top from jsonb_array_elements(v_cands) c2
   order by (c2 ->> 'priority')::int desc, (c2 ->> 'discount')::bigint desc limit 1;
  v_left := v_gross;

  return query
    with ranked as (
      select c2, (c2 ->> 'id')::uuid as id,
             (c2 ->> 'id') = (v_top ->> 'id')
             or ((v_top ->> 'stackable')::boolean and (c2 ->> 'stackable')::boolean) as chosen,
             row_number() over (order by (c2 ->> 'id') = (v_top ->> 'id') desc,
                                         (c2 ->> 'priority')::int desc, (c2 ->> 'discount')::bigint desc) as rn
        from jsonb_array_elements(v_cands) c2
    ),
    capped as (
      select r.*, (c2 ->> 'discount')::bigint as d,
             sum(case when chosen then (c2 ->> 'discount')::bigint else 0 end)
               over (order by rn rows between unbounded preceding and 1 preceding) as before
        from ranked r
    )
    select id, c2 ->> 'name', c2 ->> 'kind', c2 ->> 'code',
           (case when chosen then greatest(least(d, v_left - coalesce(before, 0)), 0) else d end)::bigint,
           (c2 ->> 'mult')::numeric, chosen and v_left - coalesce(before, 0) > 0
      from capped order by rn;
end;
$$;

-- What the till shows while the cart is open. Reads only.
create or replace function public.retail_promotions_preview(
  p_org uuid, p_branch uuid, p_items jsonb, p_customer uuid default null, p_code text default null
) returns table (promotion_id uuid, name text, kind text, code text, discount_cents bigint,
                 points_multiplier numeric, applied boolean)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.pos.use') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return query select * from app.retail_promotions_evaluate(p_org, p_branch, app.retail_cart_lines(p_org, p_items), p_customer, p_code);
end;
$$;

-- =============================================================================
-- 3. Checkout: promotions, store credit, loyalty
-- =============================================================================
create or replace function public.retail_checkout(
  p_org                  uuid,
  p_branch               uuid,
  -- [{"variant_id": "...", "quantity": 2, "discount_cents": 0}, ...]
  p_items                jsonb,
  p_method               text,
  p_tendered_cents       bigint,
  p_customer_id          uuid default null,
  p_promo_code           text default null,
  p_store_credit_cents   bigint default 0,
  p_order_discount_cents bigint default 0,
  p_note                 text default null
)
returns table (
  out_invoice_id         uuid,
  out_invoice_number     text,
  out_total_cents        bigint,
  out_promo_cents        bigint,
  out_store_credit_cents bigint,
  out_paid_cents         bigint,
  out_change_cents       bigint,
  out_points_earned      int
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
  v_promo     bigint := 0;
  v_mult      numeric := 1;
  v_total     bigint;
  v_credit    bigint := 0;
  v_paid      bigint;
  v_change    bigint;
  v_account   uuid;
  v_position  int := 0;
  v_lines     jsonb;
  v_pr        record;
  v_code_hit  boolean := false;
  v_phone     text;
  v_cpp       int;
  v_points    int := 0;
begin
  if v_user is null then raise exception 'authentication required' using errcode = '28000'; end if;

  if not app.has_branch_permission(p_org, p_branch, 'retail.pos.use')
     or not app.has_branch_permission(p_org, p_branch, 'invoice.create') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if (coalesce(p_tendered_cents, 0) > 0 or coalesce(p_store_credit_cents, 0) > 0)
     and not app.has_branch_permission(p_org, p_branch, 'payment.create') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if coalesce(p_order_discount_cents, 0) > 0
     and not app.has_branch_permission(p_org, p_branch, 'retail.pos.discount') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if coalesce(p_order_discount_cents, 0) < 0 or coalesce(p_store_credit_cents, 0) < 0 or coalesce(p_tendered_cents, 0) < 0 then
    raise exception 'قيمة سالبة غير مسموحة' using errcode = '22023';
  end if;

  select o.currency into v_currency
    from public.organizations o join public.branches b on b.organization_id = o.id
   where o.id = p_org and b.id = p_branch and b.is_active and b.deleted_at is null;
  if v_currency is null then
    raise exception 'branch does not belong to organization' using errcode = 'check_violation';
  end if;
  if p_customer_id is not null then
    select phone into v_phone from public.customers c
     where c.id = p_customer_id and c.organization_id = p_org and c.deleted_at is null;
    if not found then raise exception 'customer does not belong to organization' using errcode = 'check_violation'; end if;
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'a sale needs at least one item' using errcode = 'check_violation';
  end if;
  if p_method not in ('cash', 'card', 'transfer', 'wallet', 'online', 'other') then
    raise exception 'unknown payment method %', p_method using errcode = '22023';
  end if;

  v_number := app.next_document_number(p_org, p_branch, 'invoice');
  insert into public.invoices
    (organization_id, branch_id, number, customer_id, status, source, currency,
     subtotal_cents, discount_cents, tax_cents, total_cents, notes, issued_at, created_by)
  values (p_org, p_branch, v_number, p_customer_id, 'draft', 'pos', v_currency, 0, 0, 0, 0, p_note, now(), v_user)
  returning id into v_invoice;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select v.id, v.price_cents, v.name as variant_name, pr.name as product_name, pr.tax_rate_bp
      into v_variant
      from public.retail_variants v join public.retail_products pr on pr.id = v.product_id
     where v.id = (v_item ->> 'variant_id')::uuid and v.organization_id = p_org
       and v.is_active and v.deleted_at is null;
    if v_variant.id is null then raise exception 'unknown or inactive variant' using errcode = 'check_violation'; end if;

    v_qty := coalesce((v_item ->> 'quantity')::numeric, 0);
    if v_qty <= 0 then raise exception 'quantity must be positive' using errcode = 'check_violation'; end if;
    v_line_disc := coalesce((v_item ->> 'discount_cents')::bigint, 0);
    if v_line_disc < 0 then raise exception 'discount cannot be negative' using errcode = 'check_violation'; end if;
    if v_line_disc > 0 and not app.has_branch_permission(p_org, p_branch, 'retail.pos.discount') then
      raise exception 'not permitted' using errcode = '42501';
    end if;

    v_gross := round(v_variant.price_cents * v_qty);
    v_line_disc := least(v_line_disc, v_gross);
    v_net := v_gross - v_line_disc;
    v_tax := round((v_net * v_variant.tax_rate_bp)::numeric / 10000);
    v_subtotal := v_subtotal + v_gross;
    v_discounts := v_discounts + v_line_disc;
    v_tax_total := v_tax_total + v_tax;
    v_position := v_position + 1;

    insert into public.invoice_items
      (invoice_id, organization_id, ref_type, ref_id, description, quantity,
       unit_price_cents, discount_cents, tax_rate_bp, total_cents, position)
    values (v_invoice, p_org, 'retail_variant', v_variant.id,
            v_variant.product_name || case when v_variant.variant_name = 'default' then '' else ' — ' || v_variant.variant_name end,
            v_qty, v_variant.price_cents, v_line_disc, v_variant.tax_rate_bp, v_net + v_tax, v_position);

    insert into public.retail_stock_movements
      (organization_id, branch_id, variant_id, quantity_delta, reason, ref_type, ref_id, created_by)
    values (p_org, p_branch, v_variant.id, -v_qty, 'sale', 'invoice', v_invoice, v_user);
  end loop;

  -- ---- promotions: lock the candidates so limits hold under concurrency -----
  perform 1 from public.retail_promotions
   where organization_id = p_org and is_active and deleted_at is null order by id for update;
  v_lines := app.retail_cart_lines(p_org, p_items);
  for v_pr in select * from app.retail_promotions_evaluate(p_org, p_branch, v_lines, p_customer_id, p_promo_code) e
               where e.applied loop
    v_promo := v_promo + v_pr.discount_cents;
    v_mult := greatest(v_mult, v_pr.points_multiplier);
    v_code_hit := v_code_hit or v_pr.code is not null;
    insert into public.retail_sale_promotions
      (organization_id, branch_id, invoice_id, promotion_id, customer_id, code, discount_cents)
    values (p_org, p_branch, v_invoice, v_pr.promotion_id, p_customer_id, v_pr.code, v_pr.discount_cents);
    update public.retail_promotions set uses_count = uses_count + 1 where id = v_pr.promotion_id;
  end loop;
  if nullif(trim(coalesce(p_promo_code, '')), '') is not null and not v_code_hit then
    raise exception 'كود الخصم غير صالح أو لا ينطبق على هذه السلة' using errcode = '22023';
  end if;
  v_promo := least(v_promo, v_subtotal - v_discounts);

  -- Promotions and the order discount apply after tax, like 0014's order discount.
  v_discounts := v_discounts + v_promo + coalesce(p_order_discount_cents, 0);
  v_total := v_subtotal - v_discounts + v_tax_total;
  if v_total < 0 then raise exception 'discount exceeds the value of the sale' using errcode = 'check_violation'; end if;

  update public.invoices
     set subtotal_cents = v_subtotal, discount_cents = v_discounts, tax_cents = v_tax_total,
         total_cents = v_total, status = 'issued'
   where id = v_invoice;

  -- ---- tenders: store credit first, then cash/card ---------------------------
  v_credit := least(coalesce(p_store_credit_cents, 0), v_total);
  if v_credit > 0 then
    if p_customer_id is null then raise exception 'رصيد المتجر يحتاج عميلًا' using errcode = '22023'; end if;
    insert into public.retail_store_credits
      (organization_id, customer_id, branch_id, kind, delta_cents, ref_type, ref_id, created_by)
    values (p_org, p_customer_id, p_branch, 'redeem', -v_credit, 'invoice', v_invoice, v_user);
    -- Not cash: no treasury entry. The payment row keeps the invoice's paid state honest.
    insert into public.payments
      (organization_id, branch_id, invoice_id, customer_id, kind, method, amount_cents, currency,
       status, reference, created_by)
    values (p_org, p_branch, v_invoice, p_customer_id, 'payment', 'other', v_credit, v_currency,
            'completed', 'store_credit', v_user);
  end if;

  v_paid := least(coalesce(p_tendered_cents, 0), v_total - v_credit);
  v_change := greatest(coalesce(p_tendered_cents, 0) - (v_total - v_credit), 0);
  if v_paid > 0 then
    select id into v_account from public.treasury_accounts
     where branch_id = p_branch and is_active and is_default limit 1;
    insert into public.payments
      (organization_id, branch_id, invoice_id, customer_id, kind, method, amount_cents, currency,
       status, treasury_account_id, created_by)
    values (p_org, p_branch, v_invoice, p_customer_id, 'payment', p_method, v_paid, v_currency,
            'completed', v_account, v_user);
    if v_account is not null then
      insert into public.treasury_transactions
        (organization_id, branch_id, account_id, direction, amount_cents, currency, category, reason, ref_type, ref_id, created_by)
      values (p_org, p_branch, v_account, 'in', v_paid, v_currency, 'sale', 'بيع ' || v_number, 'invoice', v_invoice, v_user);
    end if;
  end if;

  -- ---- loyalty: the shared programme (0095), keyed by phone -----------------
  if v_phone is not null and length(app.phone_key(v_phone)) >= 7 then
    select cents_per_point into v_cpp from public.restaurant_loyalty_settings
     where organization_id = p_org and enabled;
    if v_cpp is not null then
      v_points := floor(v_total::numeric / v_cpp * v_mult)::int;
      if v_points > 0 then
        insert into public.restaurant_loyalty_adjustments (organization_id, phone_key, points, note, actor_id)
        values (p_org, app.phone_key(v_phone), least(v_points, 1000000), 'نقاط شراء ' || v_number, v_user);
      end if;
    end if;
  end if;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, v_user, 'retail.sale.completed', 'invoice', v_invoice::text,
          jsonb_build_object('number', v_number, 'total_cents', v_total, 'paid_cents', v_paid + v_credit,
                             'promo_cents', v_promo, 'store_credit_cents', v_credit, 'points', v_points));

  return query select v_invoice, v_number, v_total, v_promo, v_credit, v_paid, v_change, v_points;
end;
$$;

-- =============================================================================
-- 4. Returns and exchanges
-- =============================================================================
create or replace function public.retail_process_return(
  p_org                     uuid,
  p_branch                  uuid,
  p_invoice                 uuid,
  -- [{"variant_id": "...", "quantity": 1, "condition": "resellable"|"damaged", "note": "..."}]
  p_items                   jsonb,
  p_resolution              text,
  p_customer_id             uuid default null,
  p_reason                  text default null,
  -- exchange only: the new goods, as retail_checkout takes them
  p_exchange_items          jsonb default null,
  p_exchange_method         text default 'cash',
  p_exchange_tendered_cents bigint default 0
)
returns table (out_return_id uuid, out_number text, out_value_cents bigint,
               out_refund_cents bigint, out_store_credit_cents bigint, out_exchange_invoice_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_user      uuid := auth.uid();
  v_inv       record;
  v_customer  uuid;
  v_item      jsonb;
  v_line      record;
  v_qty       numeric(14,3);
  v_returned  numeric(14,3);
  v_unit      bigint;
  v_value     bigint := 0;
  v_approver  uuid;
  v_return    uuid;
  v_number    text;
  v_orig_pay  uuid;
  v_account   uuid;
  v_exchange  uuid;
  v_cond      text;
  v_ratio     numeric;
begin
  if v_user is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.return.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_resolution not in ('cash', 'card', 'store_credit', 'exchange') then
    raise exception 'طريقة رد غير معروفة' using errcode = '22023';
  end if;

  select i.id, i.customer_id, i.currency, i.total_cents into v_inv from public.invoices i
   where i.id = p_invoice and i.organization_id = p_org and i.branch_id = p_branch and i.voided_at is null;
  if v_inv.id is null then raise exception 'الفاتورة غير موجودة في هذا الفرع' using errcode = 'check_violation'; end if;
  -- Invoice-level discounts (promotions, order discount) are shared across the
  -- lines, so a refund never pays back more than the customer was charged.
  select case when coalesce(sum(total_cents), 0) > 0 then least(v_inv.total_cents::numeric / sum(total_cents), 1) else 1 end
    into v_ratio from public.invoice_items where invoice_id = p_invoice;

  v_customer := coalesce(p_customer_id, v_inv.customer_id);
  if v_customer is not null and not exists (
       select 1 from public.customers where id = v_customer and organization_id = p_org) then
    raise exception 'العميل لا يتبع هذه المؤسسة' using errcode = 'check_violation';
  end if;
  if p_resolution in ('store_credit', 'exchange') and v_customer is null then
    raise exception 'رصيد المتجر والاستبدال يحتاجان عميلًا' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'المرتجع يحتاج صنفًا واحدًا على الأقل' using errcode = 'check_violation';
  end if;

  -- Pass 1: validate and value every line at the price actually charged.
  for v_item in select * from jsonb_array_elements(p_items) loop
    select ii.ref_id, ii.quantity, ii.total_cents into v_line
      from public.invoice_items ii
     where ii.invoice_id = p_invoice and ii.ref_type = 'retail_variant' and ii.ref_id = (v_item ->> 'variant_id')::uuid;
    if v_line.ref_id is null then raise exception 'الصنف ليس على هذه الفاتورة' using errcode = 'check_violation'; end if;
    v_qty := coalesce((v_item ->> 'quantity')::numeric, 0);
    if v_qty <= 0 then raise exception 'كمية المرتجع يجب أن تكون أكبر من صفر' using errcode = 'check_violation'; end if;
    if coalesce(v_item ->> 'condition', 'resellable') not in ('resellable', 'damaged') then
      raise exception 'حالة صنف غير معروفة' using errcode = '22023';
    end if;
    select coalesce(sum(m.quantity_delta), 0) into v_returned from public.retail_stock_movements m
     where m.ref_type = 'invoice' and m.ref_id = p_invoice and m.variant_id = v_line.ref_id and m.reason = 'return';
    if v_qty + v_returned > v_line.quantity then
      raise exception 'لا يمكن إرجاع أكثر مما بيع' using errcode = 'check_violation';
    end if;
    v_value := v_value + round(round(v_line.total_cents * v_ratio / v_line.quantity) * v_qty);
  end loop;
  if v_value <= 0 then raise exception 'لا توجد قيمة للرد' using errcode = 'check_violation'; end if;

  -- Cash leaving the drawer always passes the manager PIN gate; a card
  -- refund needs payment.refund or the same PIN.
  if p_resolution = 'cash'
     or (p_resolution = 'card' and not app.has_branch_permission(p_org, p_branch, 'payment.refund')) then
    v_approver := app.require_approval(p_org, p_branch, 'retail.cashback', p_invoice, v_value);
  end if;

  v_number := 'RT-' || app.next_document_number(p_org, p_branch, 'retail_return');
  insert into public.retail_returns
    (organization_id, branch_id, number, original_invoice_id, customer_id, resolution,
     refund_cents, store_credit_cents, reason, cashback_approved_by, created_by)
  values (p_org, p_branch, v_number, p_invoice, v_customer, p_resolution,
          case when p_resolution in ('cash', 'card') then v_value else 0 end,
          case when p_resolution in ('store_credit', 'exchange') then v_value else 0 end,
          nullif(left(trim(coalesce(p_reason, '')), 300), ''), v_approver, v_user)
  returning id into v_return;

  -- Pass 2: lines and stock. Damaged goods come back and are written off, so
  -- the "already returned" count stays right and the shelf does not grow.
  for v_item in select * from jsonb_array_elements(p_items) loop
    select ii.ref_id, ii.quantity, ii.total_cents into v_line
      from public.invoice_items ii
     where ii.invoice_id = p_invoice and ii.ref_type = 'retail_variant' and ii.ref_id = (v_item ->> 'variant_id')::uuid;
    v_qty := (v_item ->> 'quantity')::numeric;
    v_cond := coalesce(v_item ->> 'condition', 'resellable');
    v_unit := round(v_line.total_cents * v_ratio / v_line.quantity);

    insert into public.retail_return_lines (organization_id, return_id, variant_id, quantity, unit_price_cents, condition, note)
    values (p_org, v_return, v_line.ref_id, v_qty, v_unit, v_cond, nullif(left(trim(coalesce(v_item ->> 'note', '')), 300), ''));

    insert into public.retail_stock_movements
      (organization_id, branch_id, variant_id, quantity_delta, reason, ref_type, ref_id, note, created_by)
    values (p_org, p_branch, v_line.ref_id, v_qty, 'return', 'invoice', p_invoice, v_number, v_user);
    if v_cond = 'damaged' then
      insert into public.retail_stock_movements
        (organization_id, branch_id, variant_id, quantity_delta, reason, ref_type, ref_id, note, created_by)
      values (p_org, p_branch, v_line.ref_id, -v_qty, 'damage', 'retail_return', v_return,
              coalesce(nullif(left(trim(coalesce(v_item ->> 'note', '')), 300), ''), 'تالف من مرتجع ' || v_number), v_user);
    end if;
  end loop;

  if p_resolution in ('cash', 'card') then
    select id into v_orig_pay from public.payments
     where invoice_id = p_invoice and kind = 'payment' and status = 'completed'
     order by created_at limit 1;
    if v_orig_pay is null then raise exception 'الفاتورة الأصلية غير مدفوعة' using errcode = 'check_violation'; end if;
    select id into v_account from public.treasury_accounts where branch_id = p_branch and is_active and is_default limit 1;
    insert into public.payments
      (organization_id, branch_id, invoice_id, customer_id, kind, method, amount_cents, currency,
       status, treasury_account_id, refund_of_id, reference, created_by)
    values (p_org, p_branch, p_invoice, v_customer, 'refund', p_resolution, -v_value, v_inv.currency,
            'completed', v_account, v_orig_pay, v_number, v_user);
    if v_account is not null then
      insert into public.treasury_transactions
        (organization_id, branch_id, account_id, direction, amount_cents, currency, category, reason, ref_type, ref_id, created_by)
      values (p_org, p_branch, v_account, 'out', v_value, v_inv.currency, 'refund', 'مرتجع ' || v_number, 'invoice', p_invoice, v_user);
    end if;
  else
    insert into public.retail_store_credits
      (organization_id, customer_id, branch_id, kind, delta_cents, ref_type, ref_id, note, created_by)
    values (p_org, v_customer, p_branch, 'issue', v_value, 'return', v_return, v_number, v_user);
  end if;

  if p_resolution = 'exchange' then
    if p_exchange_items is null or jsonb_array_length(p_exchange_items) = 0 then
      raise exception 'الاستبدال يحتاج أصنافًا جديدة' using errcode = '22023';
    end if;
    select c.out_invoice_id into v_exchange
      from public.retail_checkout(p_org, p_branch, p_exchange_items, coalesce(p_exchange_method, 'cash'),
                                  coalesce(p_exchange_tendered_cents, 0), v_customer, null, v_value, 0,
                                  'استبدال ' || v_number) c;
    update public.retail_returns set exchange_invoice_id = v_exchange where id = v_return;
  end if;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, v_user, 'retail.return.completed', 'retail_return', v_return::text,
          jsonb_build_object('number', v_number, 'invoice', p_invoice, 'resolution', p_resolution,
                             'value_cents', v_value, 'approved_by', v_approver, 'exchange_invoice', v_exchange));

  return query select v_return, v_number, v_value,
    case when p_resolution in ('cash', 'card') then v_value else 0::bigint end,
    case when p_resolution in ('store_credit', 'exchange') then v_value else 0::bigint end,
    v_exchange;
end;
$$;

-- =============================================================================
-- 5. Store credit
-- =============================================================================
create or replace function public.retail_store_credit_balance(p_org uuid, p_customer uuid)
returns bigint language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not (app.has_permission(p_org, 'retail.pos.use') or app.has_permission(p_org, 'retail.credit.manage')) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return app.retail_store_credit_balance(p_org, p_customer);
end;
$$;

-- Manual correction: needs retail.credit.manage AND a second person's PIN.
create or replace function public.retail_store_credit_adjust(
  p_org uuid, p_branch uuid, p_customer uuid, p_delta_cents bigint, p_note text
) returns bigint language plpgsql security definer set search_path = '' as $$
declare v_by uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.credit.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if coalesce(p_delta_cents, 0) = 0 or abs(p_delta_cents) > 100000000 then
    raise exception 'قيمة غير صالحة' using errcode = '22023';
  end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'سبب التعديل مطلوب' using errcode = '22023'; end if;
  v_by := app.require_approval(p_org, p_branch, 'retail.credit_adjust', p_customer, abs(p_delta_cents));
  insert into public.retail_store_credits
    (organization_id, customer_id, branch_id, kind, delta_cents, ref_type, note, created_by, approved_by)
  values (p_org, p_customer, p_branch, 'adjust', p_delta_cents, 'manual', left(trim(p_note), 300), auth.uid(), v_by);
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'retail.credit.adjusted', 'customer', p_customer::text,
          jsonb_build_object('delta_cents', p_delta_cents, 'approved_by', v_by, 'note', left(trim(p_note), 300)));
  return app.retail_store_credit_balance(p_org, p_customer);
end;
$$;

-- =============================================================================
-- 6. Auto-reorder
-- =============================================================================
-- Variants at or under their reorder point in this branch that are not
-- already on an open purchase order here.
create or replace function app.retail_reorder_candidates(p_org uuid, p_branch uuid)
returns table (variant_id uuid, product_name text, variant_name text, supplier_id uuid,
               on_hand numeric, reorder_point numeric, suggested_qty numeric, unit_cost_cents bigint)
language sql stable security definer set search_path = '' as $$
  select v.id, p.name, v.name, v.preferred_supplier_id,
         coalesce(l.quantity, 0), v.reorder_point,
         case when v.reorder_qty > 0 then v.reorder_qty
              else greatest(v.reorder_point * 2 - coalesce(l.quantity, 0), v.reorder_point) end,
         v.cost_cents
    from public.retail_variants v
    join public.retail_products p on p.id = v.product_id and p.is_active and p.deleted_at is null
    left join public.retail_stock_levels l on l.variant_id = v.id and l.branch_id = p_branch
   where v.organization_id = p_org and v.is_active and v.deleted_at is null
     and v.reorder_point > 0 and coalesce(l.quantity, 0) <= v.reorder_point
     and not exists (
       select 1 from public.retail_purchase_order_items i
         join public.retail_purchase_orders o on o.id = i.purchase_order_id
        where i.variant_id = v.id and o.branch_id = p_branch
          and o.status in ('draft', 'ordered', 'partially_received')
          and i.quantity_received < i.quantity_ordered)
   order by p.name, v.name;
$$;

create or replace function public.retail_reorder_suggestions(p_org uuid, p_branch uuid)
returns table (variant_id uuid, product_name text, variant_name text, supplier_id uuid,
               on_hand numeric, reorder_point numeric, suggested_qty numeric, unit_cost_cents bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.purchase.read') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return query select * from app.retail_reorder_candidates(p_org, p_branch);
end;
$$;

-- One draft purchase order per preferred supplier (lines with no preferred
-- supplier share one draft with no supplier, for the buyer to assign).
create or replace function public.retail_reorder_generate(p_org uuid, p_branch uuid)
returns table (out_order_id uuid, out_number text, out_supplier_id uuid, out_lines int)
language plpgsql security definer set search_path = '' as $$
declare
  v_currency char(3);
  g          record;
  v_order    uuid;
  v_number   text;
  v_n        int;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'retail.purchase.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  select o.currency into v_currency from public.organizations o join public.branches b on b.organization_id = o.id
   where o.id = p_org and b.id = p_branch and b.deleted_at is null;
  if v_currency is null then raise exception 'فرع غير صالح' using errcode = 'check_violation'; end if;

  perform pg_advisory_xact_lock(hashtextextended('retail_reorder:' || p_branch::text, 0));

  for g in select distinct c.supplier_id from app.retail_reorder_candidates(p_org, p_branch) c loop
    v_number := app.next_document_number(p_org, p_branch, 'purchase');
    insert into public.retail_purchase_orders
      (organization_id, branch_id, supplier_id, number, status, currency, notes, auto_generated, created_by)
    values (p_org, p_branch, g.supplier_id, v_number, 'draft', v_currency, 'طلب شراء تلقائي من حد إعادة الطلب', true, auth.uid())
    returning id into v_order;

    insert into public.retail_purchase_order_items
      (organization_id, purchase_order_id, variant_id, product_name, variant_name, quantity_ordered, unit_cost_cents, position)
    select p_org, v_order, r.variant_id, r.product_name, r.variant_name, r.suggested_qty, r.unit_cost_cents,
           row_number() over (order by r.product_name, r.variant_name)
      from app.retail_reorder_candidates(p_org, p_branch) r where r.supplier_id is not distinct from g.supplier_id;
    get diagnostics v_n = row_count;

    insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
    values (p_org, p_branch, auth.uid(), 'retail.purchase.created', 'retail_purchase_order', v_order::text,
            jsonb_build_object('number', v_number, 'supplier_id', g.supplier_id, 'lines', v_n, 'auto', true));
    out_order_id := v_order; out_number := v_number; out_supplier_id := g.supplier_id; out_lines := v_n;
    return next;
  end loop;
end;
$$;

-- =============================================================================
-- 7. Grants
-- =============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'app.retail_transfer_for_update(uuid, uuid)',
    'app.retail_transfer_audit(public.retail_stock_transfers, text, jsonb)',
    'app.retail_cart_lines(uuid, jsonb)',
    'app.retail_promotions_evaluate(uuid, uuid, jsonb, uuid, text)',
    'app.retail_reorder_candidates(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;

  foreach f in array array[
    'public.retail_transfer_request(uuid, uuid, uuid, jsonb, text)',
    'public.retail_transfer_decide(uuid, uuid, boolean, text)',
    'public.retail_transfer_dispatch(uuid, uuid, jsonb)',
    'public.retail_transfer_receive(uuid, uuid, jsonb, text)',
    'public.retail_transfer_cancel(uuid, uuid, text)',
    'public.retail_promotions_preview(uuid, uuid, jsonb, uuid, text)',
    'public.retail_checkout(uuid, uuid, jsonb, text, bigint, uuid, text, bigint, bigint, text)',
    'public.retail_process_return(uuid, uuid, uuid, jsonb, text, uuid, text, jsonb, text, bigint)',
    'public.retail_store_credit_balance(uuid, uuid)',
    'public.retail_store_credit_adjust(uuid, uuid, uuid, bigint, text)',
    'public.retail_reorder_suggestions(uuid, uuid)',
    'public.retail_reorder_generate(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
