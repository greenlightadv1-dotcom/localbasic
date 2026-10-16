-- =============================================================================
-- LOCAL BASIC — cashier fraud prevention, risk scoring and audit controls
-- =============================================================================
-- RISK EVENTS (restaurant_cashier_risk_logs, append-only). Five behaviours an
-- owner wants to see, each worth points against the person who did it:
--
--   void_after_print      4   an order cancelled after its bill/receipt was printed
--   discount_over_limit   3   a manual discount past the person's daily cap
--   drawer_kick_no_sale   2   the cash drawer opened with no sale
--   refund_processed      2   any refund (amount kept)
--   reprint_receipt       1   a receipt/bill printed a second time or more
--
-- RISK PROFILES (restaurant_cashier_risk_profiles), one per (organization,
-- user) — a person, not a branch: the same cashier working two branches has
-- one score. public.fn_log_cashier_risk() adds every event's points and flags
-- the profile at 10. Only a manager with restaurant.audit.risk_reset can clear
-- a score, re-entering their own approval PIN, never their own score.
--
-- DAILY LIMITS. Each profile may carry a daily refund cap and a daily manual
-- discount cap (null = no cap). Going past either needs a manager's PIN
-- (approval actions refund.daily_limit / discount.daily_limit) for the excess.
--
-- PRINT TRACKING. restaurant_orders.print_count is moved only by
-- restaurant_order_print_track() (a direct update is refused);
-- is_voided_after_print is set only by the order trigger when a printed order
-- is cancelled.
--
-- RESTAURANT REFUNDS. restaurant_refund_payment() refunds part or all of a
-- restaurant invoice (payment.refund), out of the branch's default treasury
-- account, with the daily cap and a risk event.
--
-- LB403 now carries the action and amount in its HINT ("action:amount") so a
-- screen that may meet two different PIN gates in one save asks for the right one.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
insert into public.permissions (key, group_key, module_key, description, is_elevated) values
  ('restaurant.audit.risk_view',  'restaurant', 'restaurant', 'View cashier risk scores and the fraud-prevention log', true),
  ('restaurant.audit.risk_reset', 'restaurant', 'restaurant', 'Reset cashier risk scores and set daily refund/discount limits', true)
on conflict (key) do update
  set description = excluded.description, group_key = excluded.group_key, module_key = excluded.module_key;

with grants(role_key, permission_key) as (values
  ('manager', 'restaurant.audit.risk_view'), ('manager', 'restaurant.audit.risk_reset'),
  ('admin',   'restaurant.audit.risk_view'), ('admin',   'restaurant.audit.risk_reset')
)
insert into public.role_permissions (role_id, permission_key)
select r.id, g.permission_key
  from grants g
  join public.roles r on r.organization_id is null and r.key = g.role_key
                     and (r.module_key is null or r.module_key = 'restaurant')
on conflict do nothing;

-- Existing organizations: their copies of those templates (same module), and owners.
insert into public.role_permissions (role_id, permission_key)
select org_role.id, tp.permission_key
  from public.roles org_role
  join public.roles tpl on tpl.organization_id is null and tpl.is_system and tpl.key = org_role.key
                       and tpl.module_key is not distinct from org_role.module_key
  join public.role_permissions tp on tp.role_id = tpl.id
 where org_role.organization_id is not null
   and tp.permission_key in ('restaurant.audit.risk_view', 'restaurant.audit.risk_reset')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r cross join public.permissions p
 where r.is_owner and r.organization_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Approvals: two new gates, and LB403 says which one it is.
-- ---------------------------------------------------------------------------
create or replace function app.approval_actions()
returns text[] language sql immutable set search_path = '' as $$
  select array['order.cancel', 'order.discount', 'inventory.adjust', 'inventory.resolve',
               'table.merge', 'check.split',
               'driver.payout', 'driver.shortage', 'driver.adjust',
               'account.adjust', 'account.overlimit', 'loyalty.adjust',
               'refund.daily_limit', 'discount.daily_limit'];
$$;

alter table public.approval_grants drop constraint approval_grants_action_check;
alter table public.approval_grants add constraint approval_grants_action_check
  check (action = any (app.approval_actions()));

create or replace function app.require_approval(
  p_org uuid, p_branch uuid, p_action text, p_subject uuid, p_amount numeric default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_by uuid;
begin
  if app.has_branch_permission(p_org, p_branch, 'approval.grant') then
    return auth.uid();
  end if;
  v_by := app.consume_approval(p_org, p_branch, p_action, p_subject, p_amount);
  if v_by is null then
    raise exception 'هذا الإجراء يحتاج موافقة المدير' using errcode = 'LB403',
      hint = p_action || ':' || coalesce(p_amount::bigint::text, '');
  end if;
  return v_by;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.restaurant_cashier_risk_profiles (
  organization_id             uuid not null references public.organizations(id) on delete cascade,
  user_id                     uuid not null references auth.users(id) on delete cascade,
  accumulated_risk_points     int not null default 0 check (accumulated_risk_points >= 0),
  is_flagged                  boolean not null default false,
  flagged_at                  timestamptz,
  -- null = no daily cap.
  daily_refund_limit_cents    bigint check (daily_refund_limit_cents is null or daily_refund_limit_cents >= 0),
  daily_discount_limit_cents  bigint check (daily_discount_limit_cents is null or daily_discount_limit_cents >= 0),
  -- Today's running totals (the organization's local day), rolled on first use each day.
  tally_day                   date,
  refund_today_cents          bigint not null default 0,
  discount_today_cents        bigint not null default 0,
  last_reset_at               timestamptz,
  last_reset_by               uuid references auth.users(id),
  last_reset_note             text check (length(last_reset_note) <= 300),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index restaurant_cashier_risk_profiles_flagged_idx
  on public.restaurant_cashier_risk_profiles(organization_id, is_flagged, accumulated_risk_points desc);

create table public.restaurant_cashier_risk_logs (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid references public.branches(id) on delete set null,
  user_id          uuid not null references auth.users(id) on delete cascade,
  event_type       text not null check (event_type in
                     ('void_after_print', 'drawer_kick_no_sale', 'reprint_receipt', 'discount_over_limit', 'refund_processed')),
  points           smallint not null check (points between 0 and 100),
  order_id         uuid references public.restaurant_orders(id) on delete set null,
  invoice_id       uuid references public.invoices(id) on delete set null,
  amount_cents     bigint,
  reason           text check (length(reason) <= 300),
  approved_by      uuid,
  details          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index restaurant_cashier_risk_logs_user_idx on public.restaurant_cashier_risk_logs(organization_id, user_id, created_at desc);
create index restaurant_cashier_risk_logs_branch_idx on public.restaurant_cashier_risk_logs(branch_id, created_at desc);
create index restaurant_cashier_risk_logs_order_idx on public.restaurant_cashier_risk_logs(order_id) where order_id is not null;

alter table public.restaurant_orders
  add column print_count smallint not null default 0 check (print_count >= 0),
  add column is_voided_after_print boolean not null default false,
  -- When each kind of document was first printed: a second print of the same
  -- kind is the reprint (a pre-bill and then the paid receipt are not).
  add column bill_printed_at timestamptz,
  add column receipt_printed_at timestamptz;

-- ---------------------------------------------------------------------------
-- Scoring
-- ---------------------------------------------------------------------------
create or replace function app.risk_event_points(p_event text)
returns smallint language sql immutable set search_path = '' as $$
  select (case p_event
            when 'void_after_print' then 4 when 'discount_over_limit' then 3
            when 'drawer_kick_no_sale' then 2 when 'refund_processed' then 2
            when 'reprint_receipt' then 1 else 0 end)::smallint;
$$;

create or replace function app.risk_flag_threshold()
returns int language sql immutable set search_path = '' as $$ select 10 $$;

create or replace function app.risk_log_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = old.organization_id) then
    return old;  -- the organization is being removed
  end if;
  raise exception 'the cashier risk log is append-only' using errcode = 'check_violation';
end;
$$;
create trigger restaurant_cashier_risk_logs_no_update before update or delete on public.restaurant_cashier_risk_logs
  for each row execute function app.risk_log_immutable();

-- Every event adds its points to the person's profile; 10 or more flags them.
create or replace function public.fn_log_cashier_risk()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v public.restaurant_cashier_risk_profiles%rowtype;
begin
  insert into public.restaurant_cashier_risk_profiles (organization_id, user_id)
  values (new.organization_id, new.user_id)
  on conflict (organization_id, user_id) do nothing;

  update public.restaurant_cashier_risk_profiles
     set accumulated_risk_points = accumulated_risk_points + new.points, updated_at = now()
   where organization_id = new.organization_id and user_id = new.user_id
  returning * into v;

  if not v.is_flagged and v.accumulated_risk_points >= app.risk_flag_threshold() then
    update public.restaurant_cashier_risk_profiles set is_flagged = true, flagged_at = now()
     where organization_id = new.organization_id and user_id = new.user_id;
    insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
    values (new.organization_id, new.branch_id, new.user_id, 'restaurant.cashier.flagged', 'user', new.user_id::text,
            jsonb_build_object('points', v.accumulated_risk_points, 'last_event', new.event_type, 'log_id', new.id));
  end if;
  return new;
end;
$$;
create trigger restaurant_cashier_risk_logs_score after insert on public.restaurant_cashier_risk_logs
  for each row execute function public.fn_log_cashier_risk();

create or replace function app.log_cashier_risk(
  p_org uuid, p_branch uuid, p_user uuid, p_event text, p_order uuid, p_invoice uuid,
  p_amount bigint, p_reason text, p_approved_by uuid, p_details jsonb default '{}'::jsonb
) returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if p_user is null then return null; end if;
  insert into public.restaurant_cashier_risk_logs
    (organization_id, branch_id, user_id, event_type, points, order_id, invoice_id, amount_cents, reason, approved_by, details)
  values (p_org, p_branch, p_user, p_event, app.risk_event_points(p_event), p_order, p_invoice, p_amount,
          left(nullif(trim(coalesce(p_reason, '')), ''), 300), p_approved_by, coalesce(p_details, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

-- The person's profile, locked, with today's tallies rolled to the
-- organization's local day.
create or replace function app.risk_profile_today(p_org uuid, p_user uuid)
returns public.restaurant_cashier_risk_profiles language plpgsql security definer set search_path = '' as $$
declare
  v public.restaurant_cashier_risk_profiles%rowtype;
  v_today date := (now() at time zone coalesce(nullif((select timezone from public.organizations where id = p_org), ''), 'Africa/Cairo'))::date;
begin
  insert into public.restaurant_cashier_risk_profiles (organization_id, user_id)
  values (p_org, p_user) on conflict (organization_id, user_id) do nothing;
  select * into v from public.restaurant_cashier_risk_profiles
   where organization_id = p_org and user_id = p_user for update;
  if v.tally_day is distinct from v_today then
    update public.restaurant_cashier_risk_profiles
       set tally_day = v_today, refund_today_cents = 0, discount_today_cents = 0
     where organization_id = p_org and user_id = p_user
    returning * into v;
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- The order trigger: print counter guard, void-after-print, daily discount cap
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_orders_risk()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_coupons bigint;
  v_excess  bigint;
  v_over    bigint;
  v_by      uuid;
  p         public.restaurant_cashier_risk_profiles%rowtype;
begin
  if tg_op = 'INSERT' then
    new.print_count := 0;
    new.is_voided_after_print := false;
    new.bill_printed_at := null;
    new.receipt_printed_at := null;
    return new;
  end if;

  if (new.print_count is distinct from old.print_count
      or new.bill_printed_at is distinct from old.bill_printed_at
      or new.receipt_printed_at is distinct from old.receipt_printed_at)
     and coalesce(current_setting('app.print_track', true), '') <> 'on' then
    raise exception 'عدد مرات الطباعة يسجله النظام فقط' using errcode = '42501';
  end if;
  if new.is_voided_after_print is distinct from old.is_voided_after_print then
    raise exception 'علامة الإلغاء بعد الطباعة يسجلها النظام فقط' using errcode = '42501';
  end if;

  -- A printed bill that never becomes a sale.
  if new.status = 'cancelled' and old.status <> 'cancelled' and old.print_count > 0 then
    new.is_voided_after_print := true;
    perform app.log_cashier_risk(new.organization_id, new.branch_id, auth.uid(), 'void_after_print', new.id, new.invoice_id,
                                 old.total_cents, new.cancel_reason, null,
                                 jsonb_build_object('print_count', old.print_count, 'from_status', old.status));
  end if;

  -- The manual part of a discount increase (coupons and promotions are not manual).
  if auth.uid() is not null and coalesce(new.discount_cents, 0) > coalesce(old.discount_cents, 0) then
    select coalesce(sum(value_cents), 0) into v_coupons from public.restaurant_loyalty_coupons
     where redeemed_order_id = new.id and status = 'redeemed';
    v_coupons := v_coupons + coalesce((select sum(amount_cents) from public.restaurant_order_promotions where order_id = new.id), 0);
    v_excess := coalesce(new.discount_cents, 0) - greatest(coalesce(old.discount_cents, 0), v_coupons);
    if v_excess > 0 then
      p := app.risk_profile_today(new.organization_id, auth.uid());
      if p.daily_discount_limit_cents is not null and p.discount_today_cents + v_excess > p.daily_discount_limit_cents then
        v_over := p.discount_today_cents + v_excess - p.daily_discount_limit_cents;
        v_by := app.require_approval(new.organization_id, new.branch_id, 'discount.daily_limit', new.id, v_over);
        perform app.log_cashier_risk(new.organization_id, new.branch_id, auth.uid(), 'discount_over_limit', new.id, new.invoice_id,
                                     v_excess, null, v_by,
                                     jsonb_build_object('over_by', v_over, 'limit', p.daily_discount_limit_cents,
                                                        'today_before', p.discount_today_cents));
      end if;
      update public.restaurant_cashier_risk_profiles
         set discount_today_cents = discount_today_cents + v_excess, updated_at = now()
       where organization_id = new.organization_id and user_id = auth.uid();
    end if;
  end if;
  return new;
end;
$$;
create trigger restaurant_orders_risk before insert or update on public.restaurant_orders
  for each row execute function app.restaurant_orders_risk();

-- ---------------------------------------------------------------------------
-- Functions the till calls
-- ---------------------------------------------------------------------------

-- A bill (open order) or receipt (its invoice) went to the printer. The second
-- print onwards is a reprint. Returns the new count.
create or replace function public.restaurant_order_print_track(p_org uuid, p_order uuid, p_invoice uuid, p_kind text default 'receipt')
returns int language plpgsql security definer set search_path = '' as $$
declare
  o     record;
  v_on  constant text := 'on';
  v_cnt int;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_kind not in ('bill', 'receipt') then raise exception 'نوع الطباعة غير معروف' using errcode = '22023'; end if;
  select id, branch_id, print_count, invoice_id, bill_printed_at, receipt_printed_at into o from public.restaurant_orders
   where organization_id = p_org
     and ((p_order is not null and id = p_order) or (p_order is null and p_invoice is not null and invoice_id = p_invoice))
   for update;
  if o.id is null then
    -- A receipt for an invoice with no restaurant order (e.g. a Core invoice): nothing to count.
    if p_order is null then return 0; end if;
    raise exception 'الطلب غير موجود' using errcode = 'check_violation';
  end if;
  if not (app.has_branch_permission(p_org, o.branch_id, 'restaurant.pos.use')
          or app.has_branch_permission(p_org, o.branch_id, 'restaurant.service.use')
          or app.has_branch_permission(p_org, o.branch_id, 'invoice.read')) then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  perform set_config('app.print_track', v_on, true);
  update public.restaurant_orders
     set print_count = least(print_count + 1, 32000),
         bill_printed_at = case when p_kind = 'bill' then coalesce(bill_printed_at, now()) else bill_printed_at end,
         receipt_printed_at = case when p_kind = 'receipt' then coalesce(receipt_printed_at, now()) else receipt_printed_at end
   where id = o.id
  returning print_count into v_cnt;
  perform set_config('app.print_track', '', true);

  if (p_kind = 'bill' and o.bill_printed_at is not null) or (p_kind = 'receipt' and o.receipt_printed_at is not null) then
    perform app.log_cashier_risk(p_org, o.branch_id, auth.uid(), 'reprint_receipt', o.id, o.invoice_id, null, null, null,
                                 jsonb_build_object('print_count', v_cnt, 'kind', p_kind));
  end if;
  return v_cnt;
end;
$$;

-- "No sale": the drawer opened without a sale. Always recorded with a reason.
create or replace function public.restaurant_drawer_open(p_org uuid, p_branch uuid, p_reason text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_branch_permission(p_org, p_branch, 'restaurant.pos.use') then raise exception 'not permitted' using errcode = '42501'; end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'اكتب سبب فتح الدرج' using errcode = '22023'; end if;
  perform app.rate_limit('rl_drawer_open', auth.uid()::text, 30, 3600);
  v_id := app.log_cashier_risk(p_org, p_branch, auth.uid(), 'drawer_kick_no_sale', null, null, null, p_reason, null);
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'restaurant.drawer.no_sale', 'branch', p_branch::text, jsonb_build_object('reason', trim(p_reason)));
  return v_id;
end;
$$;

-- Refund part or all of what was paid on a restaurant invoice.
create or replace function public.restaurant_refund_payment(
  p_org uuid, p_invoice uuid, p_amount bigint, p_method text, p_reason text
) returns table (out_payment_id uuid, out_refund_cents bigint, out_paid_cents bigint)
language plpgsql security definer set search_path = '' as $$
declare
  i          record;
  v_orig     uuid;
  v_account  uuid;
  v_payment  uuid;
  v_by       uuid;
  v_over     bigint;
  p          public.restaurant_cashier_risk_profiles%rowtype;
  v_order    uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select inv.id, inv.branch_id, inv.paid_cents, inv.voided_at, o.currency into i
    from public.invoices inv join public.organizations o on o.id = inv.organization_id
   where inv.id = p_invoice and inv.organization_id = p_org
   for update of inv;
  if i.id is null or i.voided_at is not null then raise exception 'الفاتورة غير موجودة' using errcode = 'check_violation'; end if;
  if not app.has_branch_permission(p_org, i.branch_id, 'payment.refund') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_method not in ('cash', 'card', 'transfer', 'wallet', 'other') then raise exception 'طريقة الدفع غير معروفة' using errcode = '22023'; end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then raise exception 'اكتب سبب الاسترداد' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'مبلغ الاسترداد غير صالح' using errcode = '22023'; end if;
  if p_amount > i.paid_cents then raise exception 'المبلغ أكبر من المدفوع على الفاتورة' using errcode = 'check_violation'; end if;

  select id into v_orig from public.payments
   where invoice_id = p_invoice and kind = 'payment' and status = 'completed'
   order by created_at desc limit 1;
  if v_orig is null then raise exception 'لا يوجد دفع على هذه الفاتورة' using errcode = 'check_violation'; end if;

  p := app.risk_profile_today(p_org, auth.uid());
  if p.daily_refund_limit_cents is not null and p.refund_today_cents + p_amount > p.daily_refund_limit_cents then
    v_over := p.refund_today_cents + p_amount - p.daily_refund_limit_cents;
    v_by := app.require_approval(p_org, i.branch_id, 'refund.daily_limit', p_invoice, v_over);
  end if;

  select id into v_account from public.treasury_accounts
   where branch_id = i.branch_id and is_active and is_default limit 1;

  insert into public.payments
    (organization_id, branch_id, invoice_id, kind, method, amount_cents, currency,
     status, treasury_account_id, refund_of_id, reference, created_by)
  values (p_org, i.branch_id, p_invoice, 'refund', p_method, -p_amount, i.currency,
          'completed', v_account, v_orig, left(trim(p_reason), 200), auth.uid())
  returning id into v_payment;

  if v_account is not null then
    insert into public.treasury_transactions
      (organization_id, branch_id, account_id, direction, amount_cents, currency, category, reason, ref_type, ref_id, created_by)
    values (p_org, i.branch_id, v_account, 'out', p_amount, i.currency, 'refund', left(trim(p_reason), 200), 'invoice', p_invoice, auth.uid());
  end if;

  update public.restaurant_cashier_risk_profiles
     set refund_today_cents = refund_today_cents + p_amount, updated_at = now()
   where organization_id = p_org and user_id = auth.uid();

  select id into v_order from public.restaurant_orders where invoice_id = p_invoice limit 1;
  perform app.log_cashier_risk(p_org, i.branch_id, auth.uid(), 'refund_processed', v_order, p_invoice, p_amount, p_reason, v_by,
                               jsonb_build_object('method', p_method, 'over_limit_by', v_over));
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, i.branch_id, auth.uid(), 'restaurant.refund.completed', 'invoice', p_invoice::text,
          jsonb_build_object('refund_cents', p_amount, 'method', p_method, 'reason', trim(p_reason), 'approved_by', v_by));

  return query select v_payment, p_amount, (select paid_cents from public.invoices where id = p_invoice);
end;
$$;

-- ---------------------------------------------------------------------------
-- Manager functions
-- ---------------------------------------------------------------------------

-- Clearing a score: restaurant.audit.risk_reset, the manager's own approval
-- PIN re-entered (same lockout as approvals), never one's own score.
-- Returns null on success or the reason (a wrong PIN returns, not raises,
-- so the failed attempt is kept).
create or replace function public.restaurant_risk_reset(p_org uuid, p_user uuid, p_pin text, p_note text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_member uuid;
  v_pin    public.member_approval_pins%rowtype;
  v_before public.restaurant_cashier_risk_profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'restaurant.audit.risk_reset') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'لا يمكنك تصفير نقاطك بنفسك' using errcode = '42501'; end if;
  if nullif(trim(coalesce(p_note, '')), '') is null then raise exception 'اكتب سبب التصفير' using errcode = '22023'; end if;
  perform app.rate_limit('rl_approval_try', auth.uid()::text, 20, 600);

  select id into v_member from public.organization_members
   where organization_id = p_org and user_id = auth.uid() and status = 'active';
  select * into v_pin from public.member_approval_pins where member_id = v_member for update;
  if v_pin.member_id is null then raise exception 'عيّن رمز الموافقة الخاص بك أولًا' using errcode = 'check_violation'; end if;
  if v_pin.locked_until is not null and v_pin.locked_until > now() then
    return 'تم إيقاف الرمز مؤقتًا بعد محاولات خاطئة. حاول بعد 15 دقيقة.';
  end if;
  if not app.pin_matches(coalesce(p_pin, ''), v_pin.pin_hash) then
    update public.member_approval_pins
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
     where member_id = v_member;
    insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
    values (p_org, auth.uid(), 'approval.pin_failed', 'organization_member', v_member::text, jsonb_build_object('action', 'risk.reset', 'subject_id', p_user));
    return 'الرمز غير صحيح';
  end if;
  update public.member_approval_pins set failed_attempts = 0, locked_until = null where member_id = v_member;

  select * into v_before from public.restaurant_cashier_risk_profiles where organization_id = p_org and user_id = p_user for update;
  if v_before.user_id is null then raise exception 'لا يوجد سجل مخاطر لهذا الموظف' using errcode = 'check_violation'; end if;
  update public.restaurant_cashier_risk_profiles
     set accumulated_risk_points = 0, is_flagged = false, flagged_at = null,
         last_reset_at = now(), last_reset_by = auth.uid(), last_reset_note = left(trim(p_note), 300), updated_at = now()
   where organization_id = p_org and user_id = p_user;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, before, after)
  values (p_org, auth.uid(), 'restaurant.cashier.risk_reset', 'user', p_user::text,
          jsonb_build_object('points', v_before.accumulated_risk_points, 'flagged', v_before.is_flagged),
          jsonb_build_object('note', trim(p_note)));
  return null;
end;
$$;

create or replace function public.restaurant_risk_set_limits(p_org uuid, p_user uuid, p_refund_limit bigint, p_discount_limit bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_before public.restaurant_cashier_risk_profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'restaurant.audit.risk_reset') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'لا يمكنك تعديل حدودك بنفسك' using errcode = '42501'; end if;
  if not exists (select 1 from public.organization_members where organization_id = p_org and user_id = p_user) then
    raise exception 'الموظف غير موجود' using errcode = 'check_violation';
  end if;
  if coalesce(p_refund_limit, 0) < 0 or coalesce(p_discount_limit, 0) < 0 then raise exception 'الحد غير صالح' using errcode = '22023'; end if;
  insert into public.restaurant_cashier_risk_profiles (organization_id, user_id) values (p_org, p_user)
  on conflict (organization_id, user_id) do nothing;
  select * into v_before from public.restaurant_cashier_risk_profiles where organization_id = p_org and user_id = p_user for update;
  update public.restaurant_cashier_risk_profiles
     set daily_refund_limit_cents = p_refund_limit, daily_discount_limit_cents = p_discount_limit, updated_at = now()
   where organization_id = p_org and user_id = p_user;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, before, after)
  values (p_org, auth.uid(), 'restaurant.cashier.limits_set', 'user', p_user::text,
          jsonb_build_object('refund', v_before.daily_refund_limit_cents, 'discount', v_before.daily_discount_limit_cents),
          jsonb_build_object('refund', p_refund_limit, 'discount', p_discount_limit));
end;
$$;

-- One row per staff member with a profile or an event in the window.
create or replace function public.restaurant_risk_dashboard(p_org uuid, p_from timestamptz, p_to timestamptz)
returns table (
  out_user_id uuid, out_name text, out_points int, out_flagged boolean, out_flagged_at timestamptz,
  out_void_after_print int, out_drawer_no_sale int, out_reprints int, out_discount_over int, out_refunds int,
  out_refund_cents bigint, out_discount_over_cents bigint, out_window_points int,
  out_refund_limit_cents bigint, out_discount_limit_cents bigint, out_last_event_at timestamptz,
  out_last_reset_at timestamptz
) language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'restaurant.audit.risk_view') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'الفترة غير صالحة' using errcode = '22023';
  end if;
  return query
  with ev as (
    select l.user_id,
           count(*) filter (where l.event_type = 'void_after_print')::int as voids,
           count(*) filter (where l.event_type = 'drawer_kick_no_sale')::int as drawers,
           count(*) filter (where l.event_type = 'reprint_receipt')::int as reprints,
           count(*) filter (where l.event_type = 'discount_over_limit')::int as discounts,
           count(*) filter (where l.event_type = 'refund_processed')::int as refunds,
           coalesce(sum(l.amount_cents) filter (where l.event_type = 'refund_processed'), 0)::bigint as refund_cents,
           coalesce(sum(l.amount_cents) filter (where l.event_type = 'discount_over_limit'), 0)::bigint as discount_cents,
           sum(l.points)::int as pts,
           max(l.created_at) as last_at
      from public.restaurant_cashier_risk_logs l
     where l.organization_id = p_org and l.created_at >= p_from and l.created_at < p_to
     group by l.user_id
  ), people as (
    select user_id from ev
    union
    select user_id from public.restaurant_cashier_risk_profiles where organization_id = p_org
  )
  select pp.user_id,
         coalesce(nullif(pr.full_name, ''), pr.username, 'موظف'),
         coalesce(rp.accumulated_risk_points, 0), coalesce(rp.is_flagged, false), rp.flagged_at,
         coalesce(ev.voids, 0), coalesce(ev.drawers, 0), coalesce(ev.reprints, 0), coalesce(ev.discounts, 0), coalesce(ev.refunds, 0),
         coalesce(ev.refund_cents, 0), coalesce(ev.discount_cents, 0), coalesce(ev.pts, 0),
         rp.daily_refund_limit_cents, rp.daily_discount_limit_cents, ev.last_at, rp.last_reset_at
    from people pp
    left join ev on ev.user_id = pp.user_id
    left join public.restaurant_cashier_risk_profiles rp on rp.organization_id = p_org and rp.user_id = pp.user_id
    left join public.profiles pr on pr.id = pp.user_id
   order by coalesce(rp.is_flagged, false) desc, coalesce(rp.accumulated_risk_points, 0) desc, coalesce(ev.pts, 0) desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS: reads only; every write is one of the functions above.
-- ---------------------------------------------------------------------------
alter table public.restaurant_cashier_risk_profiles enable row level security;
alter table public.restaurant_cashier_risk_profiles force row level security;
alter table public.restaurant_cashier_risk_logs enable row level security;
alter table public.restaurant_cashier_risk_logs force row level security;

-- A person sees their own profile; a risk viewer sees everyone in an
-- organization they are an active member of. Organization-level: the
-- profile has no branch.
create policy risk_profiles_select on public.restaurant_cashier_risk_profiles for select to authenticated
  using (
    user_id = auth.uid()
    or (exists (select 1 from public.organization_members m
                 where m.organization_id = restaurant_cashier_risk_profiles.organization_id
                   and m.user_id = auth.uid() and m.status = 'active')
        and app.has_permission(organization_id, 'restaurant.audit.risk_view'))
  );

create policy risk_logs_select on public.restaurant_cashier_risk_logs for select to authenticated
  using (
    user_id = auth.uid()
    or (branch_id is not null and app.has_branch_permission(organization_id, branch_id, 'restaurant.audit.risk_view'))
    or (branch_id is null and app.has_permission(organization_id, 'restaurant.audit.risk_view'))
  );

grant select on public.restaurant_cashier_risk_profiles to authenticated;
grant select on public.restaurant_cashier_risk_logs to authenticated;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'app.approval_actions()', 'app.require_approval(uuid, uuid, text, uuid, numeric)',
    'app.risk_event_points(text)', 'app.risk_flag_threshold()', 'app.risk_log_immutable()',
    'app.log_cashier_risk(uuid, uuid, uuid, text, uuid, uuid, bigint, text, uuid, jsonb)',
    'app.risk_profile_today(uuid, uuid)', 'app.restaurant_orders_risk()',
    'public.fn_log_cashier_risk()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;

  foreach f in array array[
    'public.restaurant_order_print_track(uuid, uuid, uuid, text)',
    'public.restaurant_drawer_open(uuid, uuid, text)',
    'public.restaurant_refund_payment(uuid, uuid, bigint, text, text)',
    'public.restaurant_risk_reset(uuid, uuid, text, text)',
    'public.restaurant_risk_set_limits(uuid, uuid, bigint, bigint)',
    'public.restaurant_risk_dashboard(uuid, timestamptz, timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
