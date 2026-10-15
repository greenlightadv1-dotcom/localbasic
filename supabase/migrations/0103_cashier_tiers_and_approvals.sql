-- =============================================================================
-- 0103: cashier tiers, dining-zone scopes, manager PIN approvals, and the
-- inventory roles.
--
-- ROLES
--   main_cashier  (كاشير رئيسي)  every zone, every floor; can cancel, discount
--                                and approve sub-cashiers' sensitive actions
--                                with their own PIN (approval.grant).
--   cashier       (كاشير)        unchanged screens; may now REQUEST a
--                                cancellation or discount, which a manager or
--                                the main cashier authorises with a PIN.
--                                Optionally confined to dining zones.
--   storekeeper   (أمين المخزن)   the warehouse: stock in, issue, waste.
--   kitchen/barista               receive into their own station, request
--                                replenishment, record waste.
--
-- APPROVAL. A sensitive action by someone without approval.grant needs a
-- second person, present, who has it: they pick their name and type their
-- PIN on the same device. That creates a single-use grant, bound to the
-- action, the exact order (or item), the amount where there is one, and the
-- requesting user, valid for two minutes. The action consumes it in the same
-- transaction. Nobody can approve their own request; five wrong PINs lock
-- that PIN for 15 minutes.
--
-- WHERE IT IS ENFORCED. Not in the screens and not by re-writing the payment
-- and status functions: by triggers on restaurant_orders, so every path that
-- cancels or discounts an order — today's and any future one — goes through
-- the same check. Guest and system paths (no signed-in user) are untouched:
-- guests can only cancel before confirmation (0037) anyway.
--
--   cancel after the order reached its station (confirmed and later)
--   discount beyond the value of loyalty coupons redeemed on the order
--   manual stock adjustment, and resolving a disputed transfer (inventory)
--
-- ZONES. A cashier with a zone scope sees, edits and settles only orders on
-- tables in their sections (plus takeaway and/or online orders if allowed).
-- No scope row = unrestricted, so every existing member keeps working as
-- before. Enforced by a RESTRICTIVE select policy (ANDed with the existing
-- policies, which stay untouched) and by the same order trigger for writes.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permissions and roles
-- ---------------------------------------------------------------------------
insert into public.permissions (key, group_key, module_key, description, is_elevated) values
  ('approval.grant',         'restaurant', 'restaurant', 'Authorise sensitive actions of other staff with a PIN', true),
  ('restaurant.pos.oversee', 'restaurant', 'restaurant', 'Main cashier: every zone and floor', false)
on conflict (key) do update
  set description = excluded.description, group_key = excluded.group_key, module_key = excluded.module_key;

insert into public.roles (organization_id, key, name_ar, name_en, description, is_system, is_owner, module_key) values
  (null, 'main_cashier', 'كاشير رئيسي', 'Main cashier',
   'Every zone and floor; cancels, discounts and approves sub-cashiers with a PIN', true, false, 'restaurant'),
  (null, 'storekeeper', 'أمين المخزن', 'Storekeeper',
   'The warehouse: receives purchases, issues to the kitchen and bar, records waste', true, false, 'restaurant')
on conflict do nothing;

-- Template grants. main_cashier = cashier + the oversight keys.
insert into public.role_permissions (role_id, permission_key)
select mc.id, rp.permission_key
  from public.roles mc
  join public.roles c on c.organization_id is null and c.key = 'cashier' and c.module_key = 'restaurant'
  join public.role_permissions rp on rp.role_id = c.id
 where mc.organization_id is null and mc.key = 'main_cashier'
on conflict do nothing;

with grants(role_key, permission_key) as (values
  ('main_cashier', 'restaurant.order.cancel'), ('main_cashier', 'restaurant.pos.discount'),
  ('main_cashier', 'restaurant.pos.oversee'),  ('main_cashier', 'approval.grant'),
  -- Sub-cashiers may now ask; the trigger makes a manager PIN mandatory.
  ('cashier', 'restaurant.order.cancel'), ('cashier', 'restaurant.pos.discount'),
  ('storekeeper', 'restaurant.menu.read'), ('storekeeper', 'inventory.read'),
  ('storekeeper', 'inventory.manage'),     ('storekeeper', 'inventory.stock_in'),
  ('storekeeper', 'inventory.issue'),      ('storekeeper', 'inventory.waste'),
  ('storekeeper', 'inventory.adjust'),
  ('kitchen', 'inventory.read'), ('kitchen', 'inventory.receive'), ('kitchen', 'inventory.request'), ('kitchen', 'inventory.waste'),
  ('barista', 'inventory.read'), ('barista', 'inventory.receive'), ('barista', 'inventory.request'), ('barista', 'inventory.waste'),
  ('manager', 'inventory.read'), ('manager', 'inventory.manage'), ('manager', 'inventory.stock_in'),
  ('manager', 'inventory.issue'), ('manager', 'inventory.receive'), ('manager', 'inventory.request'),
  ('manager', 'inventory.waste'), ('manager', 'inventory.adjust'), ('manager', 'approval.grant'),
  ('manager', 'restaurant.pos.oversee'),
  ('admin', 'inventory.read'), ('admin', 'inventory.manage'), ('admin', 'inventory.stock_in'),
  ('admin', 'inventory.issue'), ('admin', 'inventory.receive'), ('admin', 'inventory.request'),
  ('admin', 'inventory.waste'), ('admin', 'inventory.adjust'), ('admin', 'approval.grant'),
  ('admin', 'restaurant.pos.oversee')
)
insert into public.role_permissions (role_id, permission_key)
select r.id, g.permission_key
  from grants g
  -- cashier and storekeeper also exist as RETAIL templates: only the restaurant ones (or shared ones).
  join public.roles r on r.organization_id is null and r.key = g.role_key
                     and (r.module_key is null or r.module_key = 'restaurant')
on conflict do nothing;

-- Existing organizations: copy the two new roles, then bring every org copy
-- of a system role in line with its template, and owners in line with the catalog.
insert into public.roles (organization_id, key, name_ar, name_en, description, is_system, is_owner, module_key)
select o.id, tpl.key, tpl.name_ar, tpl.name_en, tpl.description, true, false, tpl.module_key
  from public.organizations o
  join public.organization_modules om on om.organization_id = o.id and om.module_key = 'restaurant' and om.enabled
 cross join (select key, name_ar, name_en, description, module_key from public.roles
              where organization_id is null and key in ('main_cashier', 'storekeeper')) tpl
 where not exists (select 1 from public.roles e where e.organization_id = o.id and e.key = tpl.key)
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select org_role.id, tp.permission_key
  from public.roles org_role
  join public.roles tpl on tpl.organization_id is null and tpl.is_system and tpl.key = org_role.key
                       and tpl.module_key is not distinct from org_role.module_key
  join public.role_permissions tp on tp.role_id = tpl.id
 where org_role.organization_id is not null
   and org_role.key in ('main_cashier', 'storekeeper', 'cashier', 'kitchen', 'barista', 'manager', 'admin')
   and tp.permission_key in (select key from public.permissions
                              where key like 'inventory.%' or key in ('approval.grant', 'restaurant.pos.oversee',
                                                                     'restaurant.order.cancel', 'restaurant.pos.discount')
                                 or org_role.key in ('main_cashier', 'storekeeper'))
on conflict do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r cross join public.permissions p
 where r.is_owner and r.organization_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Permission check for ANOTHER user (the approver), mirroring
-- app.has_branch_permission (0003) exactly.
-- ---------------------------------------------------------------------------
create or replace function app.user_has_branch_permission(p_user uuid, p_org uuid, p_branch uuid, p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.organization_members m
      join public.user_roles ur on ur.member_id = m.id and (ur.branch_id is null or ur.branch_id = p_branch)
      join public.role_permissions rp on rp.role_id = ur.role_id and rp.permission_key = p_perm
     where m.organization_id = p_org and m.user_id = p_user and m.status = 'active'
       and (m.all_branches or exists (select 1 from public.member_branches mb
                                       where mb.member_id = m.id and mb.branch_id = p_branch)));
$$;

-- ---------------------------------------------------------------------------
-- PINs and grants
-- ---------------------------------------------------------------------------
create table public.member_approval_pins (
  member_id        uuid primary key references public.organization_members(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  pin_hash         text not null,
  failed_attempts  int not null default 0,
  locked_until     timestamptz,
  updated_at       timestamptz not null default now()
);

create table public.approval_grants (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  action           text not null check (action in ('order.cancel', 'order.discount', 'inventory.adjust', 'inventory.resolve')),
  subject_id       uuid not null,
  amount           numeric(14, 3),
  requested_by     uuid not null references auth.users(id),
  approved_by      uuid not null references auth.users(id),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '2 minutes',
  consumed_at      timestamptz,
  check (requested_by <> approved_by)
);
create index approval_grants_lookup_idx on public.approval_grants(requested_by, action, subject_id) where consumed_at is null;

alter table public.member_approval_pins enable row level security;
alter table public.member_approval_pins force row level security;
alter table public.approval_grants enable row level security;
alter table public.approval_grants force row level security;
revoke all on public.member_approval_pins from public, anon, authenticated;
revoke all on public.approval_grants from public, anon, authenticated;

-- pgcrypto lives in `extensions` on Supabase (and `public` locally): the two
-- helpers that touch it name both, and nothing else.
create or replace function app.pin_hash(p_pin text)
returns text language sql volatile security definer set search_path = extensions, public as $$
  select crypt(p_pin, gen_salt('bf', 8));
$$;
create or replace function app.pin_matches(p_pin text, p_hash text)
returns boolean language sql stable security definer set search_path = extensions, public as $$
  select p_hash is not null and crypt(p_pin, p_hash) = p_hash;
$$;

-- A manager sets (or changes) their own approval PIN.
create or replace function public.approval_set_pin(p_org uuid, p_pin text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_member uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'approval.grant') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'الرمز من 4 إلى 8 أرقام' using errcode = '22023';
  end if;
  if p_pin ~ '^(.)\1+$' or p_pin in ('1234', '12345', '123456', '1234567', '12345678', '4321', '0123') then
    raise exception 'اختر رمزًا أصعب من ذلك' using errcode = '22023';
  end if;
  select id into v_member from public.organization_members
   where organization_id = p_org and user_id = auth.uid() and status = 'active';
  insert into public.member_approval_pins (member_id, organization_id, pin_hash, failed_attempts, locked_until, updated_at)
  values (v_member, p_org, app.pin_hash(p_pin), 0, null, now())
  on conflict (member_id) do update set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, updated_at = now();
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id)
  values (p_org, auth.uid(), 'approval.pin_set', 'organization_member', v_member::text);
end;
$$;

create or replace function public.approval_pin_status(p_org uuid)
returns table (out_has_pin boolean, out_can_approve boolean)
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.member_approval_pins p
                   join public.organization_members m on m.id = p.member_id
                  where m.organization_id = p_org and m.user_id = auth.uid()),
         app.has_permission(p_org, 'approval.grant');
$$;

-- Who can approve here, right now (never the caller). Names only.
create or replace function public.approval_approvers(p_org uuid, p_branch uuid)
returns table (out_member_id uuid, out_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not exists (select 1 from public.organization_members where organization_id = p_org and user_id = auth.uid() and status = 'active') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return query
    select m.id, coalesce(nullif(trim(pr.full_name), ''), 'مدير')
      from public.organization_members m
      join public.member_approval_pins pin on pin.member_id = m.id
      left join public.profiles pr on pr.id = m.user_id
     where m.organization_id = p_org and m.status = 'active' and m.user_id <> auth.uid()
       and app.user_has_branch_permission(m.user_id, p_org, p_branch, 'approval.grant')
     order by 2;
end;
$$;

-- The approver types their PIN on the requester's device. Returns the grant
-- id, or an Arabic reason (wrong PIN / locked) — returned rather than raised,
-- so that the failed-attempt counter actually persists.
create or replace function public.approval_grant(
  p_org uuid, p_branch uuid, p_action text, p_subject uuid, p_amount numeric,
  p_approver_member uuid, p_pin text
) returns table (out_grant uuid, out_error text)
language plpgsql security definer set search_path = '' as $$
declare
  v_pin  public.member_approval_pins%rowtype;
  v_approver uuid;
  v_id   uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_action not in ('order.cancel', 'order.discount', 'inventory.adjust', 'inventory.resolve') then
    raise exception 'unknown action' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organization_members where organization_id = p_org and user_id = auth.uid() and status = 'active') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- At most 20 PIN attempts per requester per 10 minutes, whoever they try.
  perform app.rate_limit('rl_approval_try', auth.uid()::text, 20, 600);

  select p.* into v_pin from public.member_approval_pins p
    join public.organization_members m on m.id = p.member_id
   where p.member_id = p_approver_member and m.organization_id = p_org and m.status = 'active'
   for update of p;
  select m.user_id into v_approver from public.organization_members m where m.id = p_approver_member;

  if v_pin.member_id is null or v_approver is null
     or not app.user_has_branch_permission(v_approver, p_org, p_branch, 'approval.grant') then
    return query select null::uuid, 'هذا المستخدم لا يملك صلاحية الموافقة'::text; return;
  end if;
  if v_approver = auth.uid() then
    return query select null::uuid, 'لا يمكنك الموافقة على طلبك بنفسك'::text; return;
  end if;
  if v_pin.locked_until is not null and v_pin.locked_until > now() then
    return query select null::uuid, 'تم إيقاف الرمز مؤقتًا بعد محاولات خاطئة. حاول بعد 15 دقيقة.'::text; return;
  end if;

  if not app.pin_matches(coalesce(p_pin, ''), v_pin.pin_hash) then
    update public.member_approval_pins
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
     where member_id = v_pin.member_id;
    insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
    values (p_org, p_branch, auth.uid(), 'approval.pin_failed', 'organization_member', p_approver_member::text,
            jsonb_build_object('action', p_action, 'subject_id', p_subject));
    return query select null::uuid, 'الرمز غير صحيح'::text; return;
  end if;

  update public.member_approval_pins set failed_attempts = 0, locked_until = null where member_id = v_pin.member_id;
  insert into public.approval_grants (organization_id, branch_id, action, subject_id, amount, requested_by, approved_by)
  values (p_org, p_branch, p_action, p_subject, p_amount, auth.uid(), v_approver)
  returning id into v_id;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, v_approver, 'approval.granted', 'approval_grant', v_id::text,
          jsonb_build_object('action', p_action, 'subject_id', p_subject, 'amount', p_amount, 'requested_by', auth.uid()));
  return query select v_id, null::text;
end;
$$;

-- Takes (consumes) a matching grant for the current user. Returns the
-- approver, or null when there is none.
create or replace function app.consume_approval(
  p_org uuid, p_branch uuid, p_action text, p_subject uuid, p_amount numeric default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  select * into v from public.approval_grants
   where organization_id = p_org and branch_id = p_branch and requested_by = auth.uid()
     and action = p_action and subject_id = p_subject and consumed_at is null and expires_at > now()
     and (p_amount is null or amount >= p_amount)
   order by created_at desc limit 1
   for update;
  if v.id is null then return null; end if;
  update public.approval_grants set consumed_at = now() where id = v.id;
  return v.approved_by;
end;
$$;

-- "Allowed directly, or with a manager's PIN": raises LB403 when neither.
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
    raise exception 'هذا الإجراء يحتاج موافقة المدير' using errcode = 'LB403';
  end if;
  return v_by;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cashier zones
-- ---------------------------------------------------------------------------
create table public.member_cashier_zones (
  member_id        uuid primary key references public.organization_members(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  allow_takeaway   boolean not null default true,
  allow_online     boolean not null default false,
  updated_by       uuid references auth.users(id),
  updated_at       timestamptz not null default now()
);
create table public.member_cashier_zone_sections (
  member_id        uuid not null references public.member_cashier_zones(member_id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  section_id       uuid not null references public.restaurant_sections(id) on delete cascade,
  primary key (member_id, section_id)
);
alter table public.member_cashier_zones enable row level security;
alter table public.member_cashier_zones force row level security;
alter table public.member_cashier_zone_sections enable row level security;
alter table public.member_cashier_zone_sections force row level security;
revoke all on public.member_cashier_zones from public, anon, authenticated;
revoke all on public.member_cashier_zone_sections from public, anon, authenticated;

-- Is this order inside the current user's zone? True for anyone without a zone.
create or replace function app.order_in_my_zone(p_org uuid, p_table uuid, p_channel text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_zone public.member_cashier_zones%rowtype;
begin
  if auth.uid() is null then return true; end if;
  select z.* into v_zone from public.member_cashier_zones z
    join public.organization_members m on m.id = z.member_id
   where m.organization_id = p_org and m.user_id = auth.uid() and m.status = 'active';
  if v_zone.member_id is null then return true; end if;
  if p_table is null then
    return case when p_channel = 'online' then v_zone.allow_online else v_zone.allow_takeaway end;
  end if;
  return exists (select 1 from public.restaurant_tables t
                   join public.member_cashier_zone_sections s on s.section_id = t.section_id
                  where t.id = p_table and s.member_id = v_zone.member_id);
end;
$$;

create policy orders_zone_scope on public.restaurant_orders as restrictive for select to authenticated
  using (app.order_in_my_zone(organization_id, table_id, channel));
create policy order_items_zone_scope on public.restaurant_order_items as restrictive for select to authenticated
  using (exists (select 1 from public.restaurant_orders o where o.id = order_id));

create or replace function public.restaurant_cashier_zones(p_org uuid)
returns table (out_member_id uuid, out_name text, out_role text, out_restricted boolean,
               out_allow_takeaway boolean, out_allow_online boolean, out_sections uuid[])
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'member.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  return query
    select m.id, coalesce(nullif(trim(pr.full_name), ''), pr.email::text, '—'),
           (select string_agg(coalesce(r.name_ar, r.key), '، ') from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.member_id = m.id),
           z.member_id is not null, coalesce(z.allow_takeaway, true), coalesce(z.allow_online, false),
           coalesce((select array_agg(s.section_id) from public.member_cashier_zone_sections s where s.member_id = m.id), '{}')
      from public.organization_members m
      left join public.profiles pr on pr.id = m.user_id
      left join public.member_cashier_zones z on z.member_id = m.id
     where m.organization_id = p_org and m.status = 'active'
       and exists (select 1 from public.user_roles ur join public.role_permissions rp on rp.role_id = ur.role_id
                    where ur.member_id = m.id and rp.permission_key = 'restaurant.pos.use')
     order by 2;
end;
$$;

-- p_restricted = false removes the scope (back to every zone).
create or replace function public.restaurant_cashier_zone_save(
  p_org uuid, p_member uuid, p_restricted boolean, p_sections uuid[], p_allow_takeaway boolean, p_allow_online boolean
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'member.manage') then raise exception 'not permitted' using errcode = '42501'; end if;
  if not exists (select 1 from public.organization_members where id = p_member and organization_id = p_org) then
    raise exception 'الموظف غير موجود' using errcode = 'check_violation';
  end if;
  if not p_restricted then
    delete from public.member_cashier_zones where member_id = p_member;
  else
    if exists (select 1 from unnest(coalesce(p_sections, '{}')) s
                where not exists (select 1 from public.restaurant_sections rs where rs.id = s and rs.organization_id = p_org)) then
      raise exception 'منطقة غير موجودة' using errcode = 'check_violation';
    end if;
    insert into public.member_cashier_zones (member_id, organization_id, allow_takeaway, allow_online, updated_by, updated_at)
    values (p_member, p_org, coalesce(p_allow_takeaway, true), coalesce(p_allow_online, false), auth.uid(), now())
    on conflict (member_id) do update set allow_takeaway = excluded.allow_takeaway, allow_online = excluded.allow_online,
                                          updated_by = excluded.updated_by, updated_at = now();
    delete from public.member_cashier_zone_sections where member_id = p_member;
    insert into public.member_cashier_zone_sections (member_id, organization_id, section_id)
    select p_member, p_org, s from unnest(coalesce(p_sections, '{}')) s on conflict do nothing;
  end if;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, auth.uid(), 'restaurant.cashier_zone.saved', 'organization_member', p_member::text,
          jsonb_build_object('restricted', p_restricted, 'sections', p_sections,
                             'allow_takeaway', p_allow_takeaway, 'allow_online', p_allow_online));
end;
$$;

-- ---------------------------------------------------------------------------
-- The order guard: zones on every staff write, approvals on cancel/discount.
-- ---------------------------------------------------------------------------
create or replace function app.restaurant_order_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_by       uuid;
  v_coupons  bigint := 0;
  v_excess   bigint;
begin
  -- Guests and system jobs: their own functions carry their own rules.
  if auth.uid() is null then return new; end if;

  if not app.order_in_my_zone(new.organization_id, new.table_id, new.channel)
     or (tg_op = 'UPDATE' and not app.order_in_my_zone(old.organization_id, old.table_id, old.channel)) then
    raise exception 'هذا الطلب خارج منطقتك' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then return new; end if;

  -- Cancelling something the kitchen or bar already has.
  if new.status = 'cancelled' and old.status in ('confirmed', 'preparing', 'ready', 'served') then
    v_by := app.require_approval(new.organization_id, new.branch_id, 'order.cancel', new.id);
    insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
    values (new.organization_id, new.branch_id, auth.uid(), 'restaurant.order.cancel_approved', 'restaurant_order',
            new.id::text, jsonb_build_object('approved_by', v_by, 'from_status', old.status));
  end if;

  -- A discount beyond the loyalty coupons redeemed on this order.
  if coalesce(new.discount_cents, 0) > coalesce(old.discount_cents, 0) then
    if to_regclass('public.restaurant_loyalty_coupons') is not null then
      execute 'select coalesce(sum(value_cents), 0) from public.restaurant_loyalty_coupons
                where redeemed_order_id = $1 and status = ''redeemed'''
        into v_coupons using new.id;
    end if;
    v_excess := coalesce(new.discount_cents, 0) - greatest(coalesce(old.discount_cents, 0), v_coupons);
    if v_excess > 0 then
      v_by := app.require_approval(new.organization_id, new.branch_id, 'order.discount', new.id, v_excess);
      insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
      values (new.organization_id, new.branch_id, auth.uid(), 'restaurant.order.discount_approved', 'restaurant_order',
              new.id::text, jsonb_build_object('approved_by', v_by, 'discount_cents', new.discount_cents));
    end if;
  end if;
  return new;
end;
$$;

create trigger restaurant_orders_guard
  before insert or update on public.restaurant_orders
  for each row execute function app.restaurant_order_guard();

-- A second payment on an order never touches the order row, so the zone is
-- checked on the payment itself too.
create or replace function app.restaurant_payment_zone_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  if auth.uid() is null or new.invoice_id is null then return new; end if;
  select organization_id, table_id, channel into v from public.restaurant_orders where invoice_id = new.invoice_id;
  if v.organization_id is not null and not app.order_in_my_zone(v.organization_id, v.table_id, v.channel) then
    raise exception 'هذا الطلب خارج منطقتك' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger payments_restaurant_zone_guard
  before insert on public.payments
  for each row execute function app.restaurant_payment_zone_guard();

-- ---------------------------------------------------------------------------
-- Inventory actions that need a manager: manual adjustment, disputed transfers.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_adjust(
  p_org uuid, p_branch uuid, p_kind text, p_item uuid, p_delta numeric, p_note text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_loc uuid; v_by uuid;
begin
  perform app.inventory_require(p_org, p_branch, 'inventory.adjust');
  if p_kind not in ('warehouse', 'kitchen', 'bar') then raise exception 'موقع غير معروف' using errcode = '22023'; end if;
  perform app.inventory_item_check(p_org, p_item);
  if p_delta is null or p_delta = 0 or abs(p_delta) > 100000000 then raise exception 'الكمية غير صالحة' using errcode = '22023'; end if;
  if nullif(trim(coalesce(p_note, '')), '') is null then raise exception 'اكتب سبب التسوية' using errcode = '22023'; end if;
  v_by := app.require_approval(p_org, p_branch, 'inventory.adjust', p_item, abs(p_delta));
  v_loc := app.inventory_location(p_org, p_branch, p_kind);
  perform app.inventory_move(p_org, p_branch, v_loc, p_item, p_delta, 'adjustment', 'inventory_adjustment', null, left(p_note, 300), v_by);
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'inventory.adjusted', 'inventory_item', p_item::text,
          jsonb_build_object('kind', p_kind, 'delta', p_delta, 'note', p_note, 'approved_by', v_by));
end;
$$;

-- found: the short quantity turned up → it moves into the station.
-- lost:  it is a transit loss → written off as waste (transit_loss).
create or replace function public.inventory_transfer_resolve(p_org uuid, p_transfer uuid, p_outcome text)
returns void language plpgsql security definer set search_path = '' as $$
declare v record; v_line record; v_transit uuid; v_sink uuid; v_short numeric; v_by uuid; v_waste uuid;
begin
  select * into v from public.inventory_transfers where id = p_transfer and organization_id = p_org for update;
  if v.id is null then raise exception 'التحويل غير موجود' using errcode = 'check_violation'; end if;
  perform app.inventory_require(p_org, v.branch_id, 'inventory.adjust');
  if v.status <> 'disputed' then raise exception 'لا يوجد فرق مفتوح على هذا التحويل' using errcode = 'check_violation'; end if;
  if p_outcome not in ('found', 'lost') then raise exception 'قرار غير معروف' using errcode = '22023'; end if;
  v_by := app.require_approval(p_org, v.branch_id, 'inventory.resolve', p_transfer);
  v_transit := app.inventory_location(p_org, v.branch_id, 'transit');
  v_sink    := app.inventory_location(p_org, v.branch_id, 'waste');

  for v_line in select * from public.inventory_transfer_lines where transfer_id = p_transfer and received_qty < issued_qty loop
    v_short := v_line.issued_qty - v_line.received_qty;
    perform app.inventory_move(p_org, v.branch_id, v_transit, v_line.item_id, -v_short,
                               case when p_outcome = 'found' then 'dispute_found' else 'dispute_lost' end,
                               'inventory_transfer', p_transfer, null, v_by);
    if p_outcome = 'found' then
      perform app.inventory_move(p_org, v.branch_id, v.to_location_id, v_line.item_id, v_short, 'dispute_found',
                                 'inventory_transfer', p_transfer, null, v_by);
    else
      perform app.inventory_move(p_org, v.branch_id, v_sink, v_line.item_id, v_short, 'dispute_lost',
                                 'inventory_transfer', p_transfer, null, v_by);
      insert into public.inventory_waste (organization_id, branch_id, location_id, item_id, qty, cost_cents, reason, note, recorded_by, moved_stock)
      select p_org, v.branch_id, v_transit, v_line.item_id, v_short, v_short * i.avg_cost_cents, 'transit_loss', v.number, auth.uid(), true
        from public.inventory_items i where i.id = v_line.item_id
      returning id into v_waste;
    end if;
  end loop;

  update public.inventory_transfers set status = 'resolved', resolution = p_outcome, resolved_by = auth.uid(), resolved_at = now()
   where id = p_transfer;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v.branch_id, auth.uid(), 'inventory.transfer.resolved', 'inventory_transfer', p_transfer::text,
          jsonb_build_object('outcome', p_outcome, 'approved_by', v_by));
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'app.user_has_branch_permission(uuid, uuid, uuid, text)', 'app.pin_hash(text)', 'app.pin_matches(text, text)',
    'app.consume_approval(uuid, uuid, text, uuid, numeric)', 'app.require_approval(uuid, uuid, text, uuid, numeric)',
    'app.restaurant_order_guard()', 'app.restaurant_payment_zone_guard()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  -- The restrictive policies run as the reading user.
  revoke all on function app.order_in_my_zone(uuid, uuid, text) from public, anon;
  grant execute on function app.order_in_my_zone(uuid, uuid, text) to authenticated;

  foreach f in array array[
    'public.approval_set_pin(uuid, text)', 'public.approval_pin_status(uuid)',
    'public.approval_approvers(uuid, uuid)',
    'public.approval_grant(uuid, uuid, text, uuid, numeric, uuid, text)',
    'public.restaurant_cashier_zones(uuid)',
    'public.restaurant_cashier_zone_save(uuid, uuid, boolean, uuid[], boolean, boolean)',
    'public.inventory_adjust(uuid, uuid, text, uuid, numeric, text)',
    'public.inventory_transfer_resolve(uuid, uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
