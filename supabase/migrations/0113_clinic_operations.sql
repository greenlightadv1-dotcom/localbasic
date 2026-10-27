-- =============================================================================
-- LOCAL BASIC — 0113 Clinic operations
--
-- The functions behind 0111's clinic tables.
--
--   1. Settings & bootstrap  clinic_settings (hours, working days, slot size,
--                            shift enforcement, prescription link lifetime) and
--                            app.bootstrap_medical: a new clinic workspace starts
--                            with settings, two rooms and two services.
--   2. Setup RPCs            rooms, doctors (with default shifts from the
--                            settings), weekly shifts, services and their supplies.
--   3. Calendar              booking now checks the doctor's shift (and takes the
--                            shift's room); reschedule; free slots. Double booking
--                            is still refused by 0111's trigger with LB409.
--   4. Visit lines           add / remove procedures until the visit is billed.
--   5. Prescriptions         issue (RX- number, opaque expiring token), cancel,
--                            share (rotate the token for a fresh WhatsApp link),
--                            and the anonymous read the link opens.
--   6. Billing               completion now also issues the visit invoice
--                            (supplies and commission already happen there);
--                            the cashier can invoice early and take payment.
--   7. Commissions           summary per doctor and payout through the treasury.
-- =============================================================================

-- =============================================================================
-- 1. Settings and bootstrap
-- =============================================================================
create table public.clinic_settings (
  organization_id        uuid primary key references public.organizations(id) on delete cascade,
  opens_at               time not null default '09:00',
  closes_at              time not null default '21:00',
  -- 0 = Sunday … 6 = Saturday. Default: Saturday to Thursday.
  work_days              smallint[] not null default '{0,1,2,3,4,6}',
  slot_minutes           smallint not null default 15 check (slot_minutes between 5 and 240),
  enforce_shifts         boolean not null default true,
  prescription_link_days smallint not null default 30 check (prescription_link_days between 1 and 365),
  updated_by             uuid references public.profiles(id),
  updated_at             timestamptz not null default now(),
  constraint clinic_settings_hours check (closes_at > opens_at),
  constraint clinic_settings_days check (work_days <@ '{0,1,2,3,4,5,6}'::smallint[] and cardinality(work_days) between 1 and 7)
);
alter table public.clinic_settings enable row level security;
alter table public.clinic_settings force row level security;
revoke all on public.clinic_settings from public, anon, authenticated;
grant select on public.clinic_settings to authenticated;
create policy clinic_settings_select on public.clinic_settings
  for select to authenticated using (app.clinic_staff(organization_id));

create or replace function app.clinic_settings_of(p_org uuid)
returns public.clinic_settings language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select s from public.clinic_settings s where s.organization_id = p_org),
    row(p_org, '09:00', '21:00', '{0,1,2,3,4,6}', 15, true, 30, null, now())::public.clinic_settings);
$$;

-- Picked up by provision_workspace (0024/0031) for module 'medical'.
create or replace function app.bootstrap_medical(p_org uuid, p_branch uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.clinic_settings (organization_id) values (p_org) on conflict do nothing;
  insert into public.clinic_rooms (organization_id, branch_id, name, kind) values
    (p_org, p_branch, 'عيادة 1', 'consultation'),
    (p_org, p_branch, 'غرفة الإجراءات', 'procedure')
  on conflict do nothing;
  -- Prices start at zero on purpose: the clinic sets its own before billing.
  insert into public.clinic_services (organization_id, name, category, price_cents, duration_minutes)
  select p_org, s.name, 'كشف', 0, s.mins
    from (values ('كشف', 20), ('متابعة', 15)) as s(name, mins)
   where not exists (select 1 from public.clinic_services c
                      where c.organization_id = p_org and lower(trim(c.name)) = lower(s.name) and c.deleted_at is null);
end;
$$;

-- Existing clinics get the same starting point.
select app.bootstrap_medical(o.id, b.id)
  from public.organizations o
  join lateral (select id from public.branches where organization_id = o.id and deleted_at is null
                 order by created_at limit 1) b on true
 where o.primary_module = 'medical'
   and not exists (select 1 from public.clinic_settings s where s.organization_id = o.id);

-- =============================================================================
-- 2. Setup
-- =============================================================================
create or replace function app.clinic_require(p_org uuid, p_branch uuid, p_perm text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if (p_branch is null and not app.has_permission(p_org, p_perm))
     or (p_branch is not null and not app.has_branch_permission(p_org, p_branch, p_perm)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.clinic_settings_save(p_org uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.clinic_require(p_org, null, 'clinic.doctor.manage');
  insert into public.clinic_settings as s
    (organization_id, opens_at, closes_at, work_days, slot_minutes, enforce_shifts, prescription_link_days, updated_by, updated_at)
  values (p_org,
          coalesce((p_data ->> 'opens_at')::time, '09:00'), coalesce((p_data ->> 'closes_at')::time, '21:00'),
          coalesce((select array_agg(d::smallint order by d::smallint) from jsonb_array_elements_text(p_data -> 'work_days') d),
                   '{0,1,2,3,4,6}'),
          coalesce((p_data ->> 'slot_minutes')::smallint, 15), coalesce((p_data ->> 'enforce_shifts')::boolean, true),
          coalesce((p_data ->> 'prescription_link_days')::smallint, 30), auth.uid(), now())
  on conflict (organization_id) do update set
    opens_at = excluded.opens_at, closes_at = excluded.closes_at, work_days = excluded.work_days,
    slot_minutes = excluded.slot_minutes, enforce_shifts = excluded.enforce_shifts,
    prescription_link_days = excluded.prescription_link_days, updated_by = excluded.updated_by, updated_at = now();
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, auth.uid(), 'clinic.settings.updated', 'organization', p_org::text, p_data);
end;
$$;

create or replace function public.clinic_room_save(
  p_org uuid, p_branch uuid, p_id uuid, p_name text, p_kind text default 'consultation', p_active boolean default true
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app.clinic_require(p_org, p_branch, 'clinic.doctor.manage');
  if not exists (select 1 from public.branches where id = p_branch and organization_id = p_org and deleted_at is null) then
    raise exception 'فرع غير صالح' using errcode = 'check_violation';
  end if;
  if p_id is null then
    insert into public.clinic_rooms (organization_id, branch_id, name, kind, is_active)
    values (p_org, p_branch, trim(p_name), coalesce(p_kind, 'consultation'), coalesce(p_active, true))
    returning id into v_id;
  else
    update public.clinic_rooms set name = trim(p_name), kind = coalesce(p_kind, kind), is_active = coalesce(p_active, is_active)
     where id = p_id and organization_id = p_org and branch_id = p_branch
    returning id into v_id;
    if v_id is null then raise exception 'الغرفة غير موجودة' using errcode = 'P0002'; end if;
  end if;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'clinic.room.saved', 'clinic_room', v_id::text, jsonb_build_object('name', trim(p_name)));
  return v_id;
end;
$$;

-- Replaces a doctor's weekly shifts in one branch. A doctor cannot be in two
-- places at once: shifts may not overlap on the same weekday in any branch.
create or replace function public.clinic_doctor_set_shifts(p_org uuid, p_doctor uuid, p_branch uuid, p_shifts jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  perform app.clinic_require(p_org, p_branch, 'clinic.doctor.manage');
  if not exists (select 1 from public.clinic_doctors where id = p_doctor and organization_id = p_org and deleted_at is null) then
    raise exception 'الطبيب غير موجود' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.branches where id = p_branch and organization_id = p_org and deleted_at is null) then
    raise exception 'فرع غير صالح' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(coalesce(p_shifts, '[]')) <> 'array' or jsonb_array_length(coalesce(p_shifts, '[]')) > 50 then
    raise exception 'جدول غير صالح' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_shifts, '[]')) e
              where nullif(e ->> 'room_id', '') is not null
                and not exists (select 1 from public.clinic_rooms r where r.id = (e ->> 'room_id')::uuid and r.branch_id = p_branch)) then
    raise exception 'الغرفة لا تتبع هذا الفرع' using errcode = 'check_violation';
  end if;

  delete from public.clinic_doctor_shifts where doctor_id = p_doctor and branch_id = p_branch;
  insert into public.clinic_doctor_shifts (organization_id, branch_id, doctor_id, room_id, weekday, starts_at, ends_at, slot_minutes)
  select p_org, p_branch, p_doctor, nullif(e ->> 'room_id', '')::uuid, (e ->> 'weekday')::smallint,
         (e ->> 'starts_at')::time, (e ->> 'ends_at')::time, coalesce((e ->> 'slot_minutes')::smallint, 15)
    from jsonb_array_elements(coalesce(p_shifts, '[]')) e;
  get diagnostics v_n = row_count;

  if exists (select 1 from public.clinic_doctor_shifts a join public.clinic_doctor_shifts b
               on a.doctor_id = b.doctor_id and a.weekday = b.weekday and a.id < b.id
              where a.doctor_id = p_doctor and a.starts_at < b.ends_at and b.starts_at < a.ends_at) then
    raise exception 'مواعيد الطبيب متداخلة' using errcode = 'LB409';
  end if;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'clinic.doctor.shifts_set', 'clinic_doctor', p_doctor::text, jsonb_build_object('shifts', v_n));
  return v_n;
end;
$$;

-- Create or edit a doctor. On create with p_data.branch_id, the doctor gets
-- default shifts: every working day, clinic hours.
create or replace function public.clinic_doctor_save(p_org uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id     uuid;
  v_member uuid := nullif(p_data ->> 'member_id', '')::uuid;
  v_branch uuid := nullif(p_data ->> 'branch_id', '')::uuid;
  v_set    public.clinic_settings;
begin
  perform app.clinic_require(p_org, null, 'clinic.doctor.manage');
  if v_member is not null and not exists (
       select 1 from public.organization_members where id = v_member and organization_id = p_org) then
    raise exception 'العضو لا يتبع هذه المؤسسة' using errcode = 'check_violation';
  end if;

  if p_id is null then
    insert into public.clinic_doctors
      (organization_id, member_id, display_name, specialty, license_number, phone, consultation_fee_cents,
       commission_mode, commission_percent, commission_fixed_cents, color)
    values (p_org, v_member, trim(p_data ->> 'display_name'), nullif(trim(p_data ->> 'specialty'), ''),
            nullif(trim(p_data ->> 'license_number'), ''), nullif(trim(p_data ->> 'phone'), ''),
            coalesce((p_data ->> 'consultation_fee_cents')::bigint, 0), coalesce(p_data ->> 'commission_mode', 'none'),
            (p_data ->> 'commission_percent')::numeric, (p_data ->> 'commission_fixed_cents')::bigint,
            nullif(p_data ->> 'color', ''))
    returning id into v_id;

    if v_branch is not null then
      v_set := app.clinic_settings_of(p_org);
      perform public.clinic_doctor_set_shifts(p_org, v_id, v_branch,
        (select jsonb_agg(jsonb_build_object('weekday', d, 'starts_at', v_set.opens_at, 'ends_at', v_set.closes_at,
                                             'slot_minutes', v_set.slot_minutes))
           from unnest(v_set.work_days) d));
    end if;
  else
    update public.clinic_doctors set
      member_id = v_member, display_name = trim(p_data ->> 'display_name'),
      specialty = nullif(trim(p_data ->> 'specialty'), ''), license_number = nullif(trim(p_data ->> 'license_number'), ''),
      phone = nullif(trim(p_data ->> 'phone'), ''),
      consultation_fee_cents = coalesce((p_data ->> 'consultation_fee_cents')::bigint, consultation_fee_cents),
      commission_mode = coalesce(p_data ->> 'commission_mode', commission_mode),
      commission_percent = (p_data ->> 'commission_percent')::numeric,
      commission_fixed_cents = (p_data ->> 'commission_fixed_cents')::bigint,
      color = nullif(p_data ->> 'color', ''),
      is_active = coalesce((p_data ->> 'is_active')::boolean, is_active)
     where id = p_id and organization_id = p_org and deleted_at is null
    returning id into v_id;
    if v_id is null then raise exception 'الطبيب غير موجود' using errcode = 'P0002'; end if;
  end if;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, auth.uid(), case when p_id is null then 'clinic.doctor.created' else 'clinic.doctor.updated' end,
          'clinic_doctor', v_id::text,
          jsonb_build_object('name', trim(p_data ->> 'display_name'), 'commission_mode', p_data ->> 'commission_mode',
                             'commission_percent', p_data ->> 'commission_percent'));
  return v_id;
end;
$$;

-- Create or edit a procedure and replace its supply list ([{item_id, qty}]).
create or replace function public.clinic_service_save(p_org uuid, p_id uuid, p_data jsonb, p_supplies jsonb default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app.clinic_require(p_org, null, 'clinic.service.manage');
  if p_id is null then
    insert into public.clinic_services
      (organization_id, name, code, category, price_cents, duration_minutes,
       commission_mode, commission_percent, commission_fixed_cents)
    values (p_org, trim(p_data ->> 'name'), nullif(trim(p_data ->> 'code'), ''), nullif(trim(p_data ->> 'category'), ''),
            coalesce((p_data ->> 'price_cents')::bigint, 0), coalesce((p_data ->> 'duration_minutes')::smallint, 15),
            nullif(p_data ->> 'commission_mode', ''), (p_data ->> 'commission_percent')::numeric,
            (p_data ->> 'commission_fixed_cents')::bigint)
    returning id into v_id;
  else
    update public.clinic_services set
      name = trim(p_data ->> 'name'), code = nullif(trim(p_data ->> 'code'), ''),
      category = nullif(trim(p_data ->> 'category'), ''),
      price_cents = coalesce((p_data ->> 'price_cents')::bigint, price_cents),
      duration_minutes = coalesce((p_data ->> 'duration_minutes')::smallint, duration_minutes),
      commission_mode = nullif(p_data ->> 'commission_mode', ''),
      commission_percent = (p_data ->> 'commission_percent')::numeric,
      commission_fixed_cents = (p_data ->> 'commission_fixed_cents')::bigint,
      is_active = coalesce((p_data ->> 'is_active')::boolean, is_active)
     where id = p_id and organization_id = p_org and deleted_at is null
    returning id into v_id;
    if v_id is null then raise exception 'الخدمة غير موجودة' using errcode = 'P0002'; end if;
  end if;

  if p_supplies is not null then
    if exists (select 1 from jsonb_array_elements(p_supplies) e
                where not exists (select 1 from public.inventory_items i
                                   where i.id = (e ->> 'item_id')::uuid and i.organization_id = p_org)) then
      raise exception 'خامة غير معروفة' using errcode = 'check_violation';
    end if;
    delete from public.clinic_service_supplies where service_id = v_id;
    insert into public.clinic_service_supplies (organization_id, service_id, item_id, qty)
    select p_org, v_id, (e ->> 'item_id')::uuid, sum((e ->> 'qty')::numeric)
      from jsonb_array_elements(p_supplies) e group by (e ->> 'item_id')::uuid;
  end if;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, auth.uid(), case when p_id is null then 'clinic.service.created' else 'clinic.service.updated' end,
          'clinic_service', v_id::text,
          jsonb_build_object('name', trim(p_data ->> 'name'), 'price_cents', p_data ->> 'price_cents',
                             'supplies', jsonb_array_length(coalesce(p_supplies, '[]'))));
  return v_id;
end;
$$;

-- =============================================================================
-- 3. Calendar
-- =============================================================================

-- The shift that covers [p_start, p_end) for this doctor in this branch, in
-- the organization's local time. Returns its room. Raises when none covers it
-- and the clinic enforces shifts.
create or replace function app.clinic_shift_room(p_org uuid, p_branch uuid, p_doctor uuid, p_start timestamptz, p_end timestamptz)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz    text;
  v_ls    timestamp;
  v_le    timestamp;
  v_shift record;
begin
  select timezone into v_tz from public.organizations where id = p_org;
  v_ls := p_start at time zone v_tz;
  v_le := p_end at time zone v_tz;
  select s.id, s.room_id into v_shift from public.clinic_doctor_shifts s
   where s.doctor_id = p_doctor and s.branch_id = p_branch
     and s.weekday = extract(dow from v_ls)::smallint
     and v_le::date = v_ls::date
     and s.starts_at <= v_ls::time and s.ends_at >= v_le::time
     and (s.valid_from is null or s.valid_from <= v_ls::date)
     and (s.valid_to is null or s.valid_to >= v_ls::date)
   order by s.starts_at limit 1;
  if v_shift.id is null and (app.clinic_settings_of(p_org)).enforce_shifts then
    raise exception 'الموعد خارج مواعيد عمل الطبيب' using errcode = '22023';
  end if;
  return v_shift.room_id;
end;
$$;

create or replace function public.clinic_appointment_book(
  p_org uuid, p_branch uuid, p_patient uuid, p_doctor uuid, p_starts_at timestamptz,
  p_services uuid[] default '{}', p_duration_minutes integer default null, p_room uuid default null,
  p_reason text default null, p_source text default 'staff'
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id   uuid;
  v_mins integer;
  v_room uuid;
begin
  perform app.clinic_require(p_org, p_branch, 'clinic.appointment.manage');
  if coalesce(app.branch_module(p_branch), '') <> 'medical' then
    raise exception 'هذا الفرع لا يعمل كعيادة' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(coalesce(p_services, '{}')) sid
              where not exists (select 1 from public.clinic_services s
                                 where s.id = sid and s.organization_id = p_org and s.is_active and s.deleted_at is null)) then
    raise exception 'خدمة غير معروفة' using errcode = '22023';
  end if;
  if not exists (select 1 from public.clinic_doctors d
                  where d.id = p_doctor and d.organization_id = p_org and d.is_active and d.deleted_at is null) then
    raise exception 'الطبيب غير متاح' using errcode = 'check_violation';
  end if;
  perform app.rate_limit('rl_clinic_book', auth.uid()::text, 600, 3600);

  select coalesce(p_duration_minutes, nullif(sum(s.duration_minutes), 0), (app.clinic_settings_of(p_org)).slot_minutes)
    into v_mins
    from public.clinic_services s where s.id = any (coalesce(p_services, '{}'));
  if v_mins not between 5 and 720 then raise exception 'مدة غير صالحة' using errcode = '22023'; end if;

  v_room := app.clinic_shift_room(p_org, p_branch, p_doctor, p_starts_at, p_starts_at + make_interval(mins => v_mins));

  insert into public.clinic_appointments
    (organization_id, branch_id, patient_id, doctor_id, room_id, starts_at, ends_at, source, reason, booked_by)
  values (p_org, p_branch, p_patient, p_doctor, coalesce(p_room, v_room), p_starts_at,
          p_starts_at + make_interval(mins => v_mins), coalesce(p_source, 'staff'),
          nullif(left(trim(coalesce(p_reason, '')), 300), ''), auth.uid())
  returning id into v_id;

  insert into public.clinic_appointment_services (organization_id, appointment_id, service_id, doctor_id, unit_price_cents)
  select p_org, v_id, s.id, p_doctor, s.price_cents
    from unnest(coalesce(p_services, '{}')) with ordinality u(sid, ord)
    join public.clinic_services s on s.id = u.sid
   order by u.ord;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'clinic.appointment.booked', 'clinic_appointment', v_id::text,
          jsonb_build_object('doctor', p_doctor, 'starts_at', p_starts_at, 'minutes', v_mins));
  return v_id;
end;
$$;

-- Move a booked or checked-in visit. Duration is kept unless given.
create or replace function public.clinic_appointment_reschedule(
  p_org uuid, p_appointment uuid, p_starts_at timestamptz, p_doctor uuid default null,
  p_room uuid default null, p_duration_minutes integer default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v      record;
  v_doc  uuid;
  v_end  timestamptz;
  v_room uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v from public.clinic_appointments where id = p_appointment and organization_id = p_org for update;
  if v.id is null then raise exception 'الموعد غير موجود' using errcode = 'P0002'; end if;
  perform app.clinic_require(p_org, v.branch_id, 'clinic.appointment.manage');
  if v.status not in ('booked', 'checked_in') then
    raise exception 'لا يمكن تعديل موعد بدأ أو انتهى' using errcode = 'check_violation';
  end if;
  v_doc := coalesce(p_doctor, v.doctor_id);
  v_end := p_starts_at + coalesce(make_interval(mins => p_duration_minutes), v.ends_at - v.starts_at);
  v_room := app.clinic_shift_room(p_org, v.branch_id, v_doc, p_starts_at, v_end);

  update public.clinic_appointments
     set starts_at = p_starts_at, ends_at = v_end, doctor_id = v_doc,
         room_id = coalesce(p_room, case when p_doctor is null then room_id end, v_room)
   where id = p_appointment;
  if p_doctor is not null then
    update public.clinic_appointment_services set doctor_id = p_doctor
     where appointment_id = p_appointment and doctor_id = v.doctor_id;
  end if;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, before, after)
  values (p_org, v.branch_id, auth.uid(), 'clinic.appointment.rescheduled', 'clinic_appointment', p_appointment::text,
          jsonb_build_object('starts_at', v.starts_at, 'doctor', v.doctor_id),
          jsonb_build_object('starts_at', p_starts_at, 'doctor', v_doc));
end;
$$;

-- Free slots for one doctor on one local date: shift slots minus active visits.
create or replace function public.clinic_available_slots(p_org uuid, p_branch uuid, p_doctor uuid, p_date date)
returns table (starts_at timestamptz, ends_at timestamptz, room_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text;
begin
  perform app.clinic_require(p_org, p_branch, 'clinic.appointment.read');
  select timezone into v_tz from public.organizations where id = p_org;
  return query
    with slots as (
      select (t at time zone v_tz) as s,
             (t at time zone v_tz) + make_interval(mins => sh.slot_minutes) as e,
             sh.room_id as room
        from public.clinic_doctor_shifts sh
        cross join lateral generate_series(p_date + sh.starts_at, p_date + sh.ends_at - make_interval(mins => sh.slot_minutes),
                                           make_interval(mins => sh.slot_minutes)) t
       where sh.doctor_id = p_doctor and sh.branch_id = p_branch
         and sh.weekday = extract(dow from p_date)::smallint
         and (sh.valid_from is null or sh.valid_from <= p_date)
         and (sh.valid_to is null or sh.valid_to >= p_date)
    )
    select sl.s, sl.e, sl.room from slots sl
     where sl.s > now()
       and not exists (select 1 from public.clinic_appointments a
                        where a.doctor_id = p_doctor and a.status in ('booked', 'checked_in', 'in_session')
                          and tstzrange(a.starts_at, a.ends_at) && tstzrange(sl.s, sl.e))
     order by sl.s;
end;
$$;

-- =============================================================================
-- 4. Visit lines
-- =============================================================================
create or replace function public.clinic_appointment_add_service(
  p_org uuid, p_appointment uuid, p_service uuid, p_quantity integer default 1, p_doctor uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v     record;
  v_svc record;
  v_id  uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v from public.clinic_appointments where id = p_appointment and organization_id = p_org for update;
  if v.id is null then raise exception 'الموعد غير موجود' using errcode = 'P0002'; end if;
  if not (app.has_branch_permission(p_org, v.branch_id, 'clinic.appointment.manage')
          or app.has_branch_permission(p_org, v.branch_id, 'clinic.emr.write')) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v.status not in ('booked', 'checked_in', 'in_session') or v.invoice_id is not null then
    raise exception 'لا يمكن إضافة خدمات بعد إصدار الفاتورة أو إنهاء الزيارة' using errcode = 'check_violation';
  end if;
  select * into v_svc from public.clinic_services
   where id = p_service and organization_id = p_org and is_active and deleted_at is null;
  if v_svc.id is null then raise exception 'خدمة غير معروفة' using errcode = '22023'; end if;
  if p_doctor is not null and not exists (
       select 1 from public.clinic_doctors where id = p_doctor and organization_id = p_org and deleted_at is null) then
    raise exception 'الطبيب غير موجود' using errcode = 'check_violation';
  end if;

  insert into public.clinic_appointment_services (organization_id, appointment_id, service_id, doctor_id, quantity, unit_price_cents)
  values (p_org, p_appointment, p_service, coalesce(p_doctor, v.doctor_id), coalesce(p_quantity, 1), v_svc.price_cents)
  returning id into v_id;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v.branch_id, auth.uid(), 'clinic.visit.service_added', 'clinic_appointment', p_appointment::text,
          jsonb_build_object('service', p_service, 'quantity', coalesce(p_quantity, 1)));
  return v_id;
end;
$$;

create or replace function public.clinic_appointment_remove_service(p_org uuid, p_line uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select l.id, l.service_id, a.id as appointment_id, a.branch_id, a.status, a.invoice_id
    into v
    from public.clinic_appointment_services l join public.clinic_appointments a on a.id = l.appointment_id
   where l.id = p_line and l.organization_id = p_org
   for update of a;
  if v.id is null then raise exception 'السطر غير موجود' using errcode = 'P0002'; end if;
  if not (app.has_branch_permission(p_org, v.branch_id, 'clinic.appointment.manage')
          or app.has_branch_permission(p_org, v.branch_id, 'clinic.emr.write')) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v.status not in ('booked', 'checked_in', 'in_session') or v.invoice_id is not null then
    raise exception 'لا يمكن حذف خدمات بعد إصدار الفاتورة أو إنهاء الزيارة' using errcode = 'check_violation';
  end if;
  delete from public.clinic_appointment_services where id = p_line;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v.branch_id, auth.uid(), 'clinic.visit.service_removed', 'clinic_appointment', v.appointment_id::text,
          jsonb_build_object('service', v.service_id));
end;
$$;

-- =============================================================================
-- 5. Prescriptions
-- =============================================================================
create or replace function public.clinic_prescription_issue(
  p_org uuid, p_patient uuid, p_items jsonb, p_appointment uuid default null, p_notes text default null
) returns table (out_id uuid, out_number text, out_token text, out_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
  v_doctor uuid := app.clinic_my_doctor(p_org);
  v_rx     public.clinic_prescriptions;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if v_doctor is null then raise exception 'إصدار الروشتة للأطباء فقط' using errcode = '42501'; end if;
  if not exists (select 1 from public.clinic_patients where id = p_patient and organization_id = p_org and deleted_at is null) then
    raise exception 'المريض غير موجود' using errcode = 'P0002';
  end if;
  if p_appointment is not null then
    select branch_id into v_branch from public.clinic_appointments
     where id = p_appointment and organization_id = p_org and patient_id = p_patient;
    if v_branch is null then raise exception 'الموعد لا يخص هذا المريض' using errcode = '22023'; end if;
  else
    select branch_id into v_branch from public.clinic_patients where id = p_patient;
  end if;
  perform app.clinic_require(p_org, v_branch, 'clinic.prescription.write');
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 30 then
    raise exception 'الروشتة تحتاج دواءً واحدًا على الأقل' using errcode = '22023';
  end if;
  perform app.rate_limit('rl_clinic_rx', auth.uid()::text, 300, 3600);

  insert into public.clinic_prescriptions
    (organization_id, branch_id, patient_id, appointment_id, doctor_id, number, notes, token_expires_at, issued_by)
  values (p_org, v_branch, p_patient, p_appointment, v_doctor,
          'RX-' || app.next_document_number(p_org, v_branch, 'clinic_prescription'),
          nullif(left(trim(coalesce(p_notes, '')), 2000), ''),
          now() + make_interval(days => (app.clinic_settings_of(p_org)).prescription_link_days), auth.uid())
  returning * into v_rx;

  insert into public.clinic_prescription_items
    (organization_id, prescription_id, position, drug_name, strength, dosage_form, dose, route, frequency, duration, instructions)
  select p_org, v_rx.id, (ord - 1)::smallint, trim(e ->> 'drug_name'), nullif(trim(e ->> 'strength'), ''),
         nullif(trim(e ->> 'dosage_form'), ''), nullif(trim(e ->> 'dose'), ''), nullif(trim(e ->> 'route'), ''),
         nullif(trim(e ->> 'frequency'), ''), nullif(trim(e ->> 'duration'), ''), nullif(trim(e ->> 'instructions'), '')
    from jsonb_array_elements(p_items) with ordinality as x(e, ord);

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v_branch, auth.uid(), 'clinic.prescription.issued', 'clinic_patient', p_patient::text,
          jsonb_build_object('prescription', v_rx.id, 'number', v_rx.number, 'items', jsonb_array_length(p_items)));
  return query select v_rx.id, v_rx.number, v_rx.public_token, v_rx.token_expires_at;
end;
$$;

create or replace function public.clinic_prescription_cancel(p_org uuid, p_prescription uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.clinic_prescriptions;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v from public.clinic_prescriptions where id = p_prescription and organization_id = p_org for update;
  if v.id is null then raise exception 'الروشتة غير موجودة' using errcode = 'P0002'; end if;
  perform app.clinic_require(p_org, v.branch_id, 'clinic.prescription.write');
  if v.doctor_id is distinct from app.clinic_my_doctor(p_org) and not app.has_permission(p_org, 'clinic.doctor.manage') then
    raise exception 'لا يلغي الروشتة إلا الطبيب الذي أصدرها' using errcode = '42501';
  end if;
  if v.status = 'cancelled' then return; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'سبب الإلغاء مطلوب' using errcode = '22023'; end if;
  -- The token is replaced too, so an old WhatsApp link stops resolving at once.
  update public.clinic_prescriptions
     set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
         cancel_reason = left(trim(p_reason), 300), public_token = app.new_public_token(), token_expires_at = now()
   where id = p_prescription;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v.branch_id, auth.uid(), 'clinic.prescription.cancelled', 'clinic_patient', v.patient_id::text,
          jsonb_build_object('prescription', p_prescription, 'number', v.number));
end;
$$;

-- A fresh link: new token, new expiry. Returns what the WhatsApp button needs.
create or replace function public.clinic_prescription_share(p_org uuid, p_prescription uuid)
returns table (out_token text, out_expires_at timestamptz, out_patient_phone text, out_number text)
language plpgsql security definer set search_path = '' as $$
declare
  v       public.clinic_prescriptions;
  v_phone text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v from public.clinic_prescriptions where id = p_prescription and organization_id = p_org for update;
  if v.id is null then raise exception 'الروشتة غير موجودة' using errcode = 'P0002'; end if;
  perform app.clinic_require(p_org, v.branch_id, 'clinic.prescription.write');
  if v.status <> 'issued' then raise exception 'الروشتة ملغاة' using errcode = 'check_violation'; end if;
  perform app.rate_limit('rl_clinic_rx_share', auth.uid()::text, 120, 3600);
  update public.clinic_prescriptions
     set public_token = app.new_public_token(),
         token_expires_at = now() + make_interval(days => (app.clinic_settings_of(p_org)).prescription_link_days)
   where id = p_prescription
  returning * into v;
  select phone into v_phone from public.clinic_patients where id = v.patient_id;
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v.branch_id, auth.uid(), 'clinic.prescription.shared', 'clinic_patient', v.patient_id::text,
          jsonb_build_object('prescription', p_prescription));
  return query select v.public_token, v.token_expires_at, v_phone, v.number;
end;
$$;

-- What the printable / WhatsApp link shows. Anonymous: the token is the key,
-- and only an issued, unexpired prescription answers.
create or replace function public.clinic_prescription_public(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if p_token is null or length(p_token) not between 20 and 64 then return null; end if;
  perform app.rate_limit('rl_clinic_rx_public', left(p_token, 64), 60, 600);
  select jsonb_build_object(
           'number', rx.number, 'issued_at', rx.issued_at, 'expires_at', rx.token_expires_at, 'notes', rx.notes,
           'clinic', o.name, 'branch', b.name, 'branch_phone', b.phone, 'branch_address', b.address,
           'doctor', d.display_name, 'specialty', d.specialty, 'license', d.license_number,
           'patient', p.full_name, 'file_number', p.file_number,
           'age', case when p.date_of_birth is not null then extract(year from age(p.date_of_birth))::int end,
           'items', coalesce((select jsonb_agg(jsonb_build_object(
                       'drug_name', i.drug_name, 'strength', i.strength, 'dosage_form', i.dosage_form, 'dose', i.dose,
                       'route', i.route, 'frequency', i.frequency, 'duration', i.duration, 'instructions', i.instructions)
                       order by i.position)
                       from public.clinic_prescription_items i where i.prescription_id = rx.id), '[]'::jsonb))
    into v
    from public.clinic_prescriptions rx
    join public.organizations o on o.id = rx.organization_id
    join public.branches b on b.id = rx.branch_id
    join public.clinic_doctors d on d.id = rx.doctor_id
    join public.clinic_patients p on p.id = rx.patient_id
   where rx.public_token = p_token and rx.status = 'issued' and rx.token_expires_at > now();
  return v;
end;
$$;

-- =============================================================================
-- 6. Billing
-- =============================================================================

-- The patient's customer record, created (or matched by phone) on first bill.
create or replace function app.clinic_patient_customer(p_patient uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  p   record;
  v_c uuid;
begin
  select * into p from public.clinic_patients where id = p_patient for update;
  if p.customer_id is not null then return p.customer_id; end if;
  if p.phone is not null then
    select id into v_c from public.customers
     where organization_id = p.organization_id and phone = p.phone and deleted_at is null limit 1;
  end if;
  if v_c is null then
    insert into public.customers (organization_id, branch_id, name, phone, created_by)
    values (p.organization_id, p.branch_id, p.full_name, p.phone, auth.uid())
    returning id into v_c;
  end if;
  update public.clinic_patients set customer_id = v_c where id = p_patient;
  return v_c;
end;
$$;

-- The visit invoice, from its procedure lines. Medical services carry no tax.
create or replace function app.clinic_issue_invoice(p_appointment uuid, p_discount_cents bigint default 0)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v        record;
  v_inv    uuid;
  v_number text;
  v_sub    bigint;
  v_disc   bigint;
  v_cur    char(3);
begin
  select * into v from public.clinic_appointments where id = p_appointment for update;
  if v.invoice_id is not null then return v.invoice_id; end if;
  if not exists (select 1 from public.clinic_appointment_services where appointment_id = p_appointment) then
    return null;
  end if;
  select currency into v_cur from public.organizations where id = v.organization_id;

  v_number := app.next_document_number(v.organization_id, v.branch_id, 'invoice');
  insert into public.invoices
    (organization_id, branch_id, number, customer_id, status, source, currency, notes, issued_at, created_by)
  values (v.organization_id, v.branch_id, v_number, app.clinic_patient_customer(v.patient_id), 'draft', 'medical',
          v_cur, 'زيارة عيادة', now(), auth.uid())
  returning id into v_inv;

  insert into public.invoice_items
    (invoice_id, organization_id, ref_type, ref_id, description, quantity, unit_price_cents, discount_cents,
     tax_rate_bp, total_cents, position)
  select v_inv, v.organization_id, 'medical_service', l.service_id,
         s.name || ' — ' || d.display_name, l.quantity, l.unit_price_cents, l.discount_cents, 0,
         l.quantity * l.unit_price_cents - l.discount_cents,
         row_number() over (order by l.created_at)
    from public.clinic_appointment_services l
    join public.clinic_services s on s.id = l.service_id
    join public.clinic_doctors d on d.id = l.doctor_id
   where l.appointment_id = p_appointment;

  select coalesce(sum(quantity * unit_price_cents), 0), coalesce(sum(discount_cents), 0)
    into v_sub, v_disc
    from public.clinic_appointment_services where appointment_id = p_appointment;
  v_disc := least(v_disc + greatest(coalesce(p_discount_cents, 0), 0), v_sub);

  update public.invoices
     set subtotal_cents = v_sub, discount_cents = v_disc, tax_cents = 0, total_cents = v_sub - v_disc, status = 'issued'
   where id = v_inv;
  update public.clinic_appointments set invoice_id = v_inv where id = p_appointment;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (v.organization_id, v.branch_id, auth.uid(), 'clinic.visit.invoiced', 'invoice', v_inv::text,
          jsonb_build_object('number', v_number, 'appointment', p_appointment, 'total_cents', v_sub - v_disc));
  return v_inv;
end;
$$;

-- Completion (0111) now also issues the invoice for the cashier.
create or replace function app.clinic_appointment_after()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    perform app.clinic_complete_appointment(new.id);
    perform app.clinic_issue_invoice(new.id);
  end if;
  return null;
end;
$$;

-- Invoice a visit before it completes (pay at check-in). A discount needs the
-- manager PIN gate 'order.discount', like every other till.
create or replace function public.clinic_visit_invoice(p_org uuid, p_appointment uuid, p_discount_cents bigint default 0)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v from public.clinic_appointments where id = p_appointment and organization_id = p_org;
  if v.id is null then raise exception 'الموعد غير موجود' using errcode = 'P0002'; end if;
  perform app.clinic_require(p_org, v.branch_id, 'clinic.billing.use');
  if v.status in ('cancelled', 'no_show') then raise exception 'الزيارة ملغاة' using errcode = 'check_violation'; end if;
  if v.invoice_id is not null then
    if coalesce(p_discount_cents, 0) > 0 then raise exception 'الفاتورة صادرة بالفعل' using errcode = 'check_violation'; end if;
    return v.invoice_id;
  end if;
  if coalesce(p_discount_cents, 0) < 0 then raise exception 'قيمة غير صالحة' using errcode = '22023'; end if;
  if coalesce(p_discount_cents, 0) > 0 then
    perform app.require_approval(p_org, v.branch_id, 'order.discount', p_appointment, p_discount_cents);
  end if;
  v.invoice_id := app.clinic_issue_invoice(p_appointment, p_discount_cents);
  if v.invoice_id is null then raise exception 'لا توجد خدمات على الزيارة' using errcode = 'check_violation'; end if;
  return v.invoice_id;
end;
$$;

-- Take payment for a visit at the clinic cashier.
create or replace function public.clinic_visit_pay(
  p_org uuid, p_appointment uuid, p_method text, p_tendered_cents bigint
) returns table (out_invoice_id uuid, out_invoice_number text, out_total_cents bigint,
                 out_paid_cents bigint, out_change_cents bigint, out_due_cents bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v       record;
  i       record;
  v_inv   uuid;
  v_pay   bigint;
  v_acct  uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  select * into v from public.clinic_appointments where id = p_appointment and organization_id = p_org for update;
  if v.id is null then raise exception 'الموعد غير موجود' using errcode = 'P0002'; end if;
  perform app.clinic_require(p_org, v.branch_id, 'clinic.billing.use');
  if p_method not in ('cash', 'card', 'transfer', 'wallet', 'online', 'other') then
    raise exception 'طريقة دفع غير معروفة' using errcode = '22023';
  end if;
  if coalesce(p_tendered_cents, 0) <= 0 then raise exception 'المبلغ المدفوع مطلوب' using errcode = '22023'; end if;
  if v.status in ('cancelled', 'no_show') then raise exception 'الزيارة ملغاة' using errcode = 'check_violation'; end if;

  v_inv := coalesce(v.invoice_id, app.clinic_issue_invoice(p_appointment));
  if v_inv is null then raise exception 'لا توجد خدمات على الزيارة' using errcode = 'check_violation'; end if;
  select * into i from public.invoices where id = v_inv for update;
  if i.total_cents - i.paid_cents <= 0 then raise exception 'الفاتورة مدفوعة بالكامل' using errcode = 'check_violation'; end if;

  v_pay := least(p_tendered_cents, i.total_cents - i.paid_cents);
  select id into v_acct from public.treasury_accounts where branch_id = v.branch_id and is_active and is_default limit 1;
  insert into public.payments
    (organization_id, branch_id, invoice_id, customer_id, kind, method, amount_cents, currency, status, treasury_account_id, created_by)
  values (p_org, v.branch_id, v_inv, i.customer_id, 'payment', p_method, v_pay, i.currency, 'completed', v_acct, auth.uid());
  if v_acct is not null then
    insert into public.treasury_transactions
      (organization_id, branch_id, account_id, direction, amount_cents, currency, category, reason, ref_type, ref_id, created_by)
    values (p_org, v.branch_id, v_acct, 'in', v_pay, i.currency, 'clinic', 'زيارة ' || i.number, 'invoice', v_inv, auth.uid());
  end if;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, v.branch_id, auth.uid(), 'clinic.visit.paid', 'invoice', v_inv::text,
          jsonb_build_object('amount_cents', v_pay, 'method', p_method, 'appointment', p_appointment));
  return query select v_inv, i.number, i.total_cents, i.paid_cents + v_pay,
                      greatest(p_tendered_cents - v_pay, 0), i.total_cents - i.paid_cents - v_pay;
end;
$$;

-- =============================================================================
-- 7. Commissions
-- =============================================================================
create or replace function public.clinic_commission_summary(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_doctor uuid default null
) returns table (doctor_id uuid, doctor_name text, lines int, base_cents bigint,
                 commission_cents bigint, unpaid_cents bigint)
language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := app.clinic_my_doctor(p_org);
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'clinic.commission.read') then
    if v_me is null or (p_doctor is not null and p_doctor <> v_me) then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    p_doctor := v_me;
  end if;
  return query
    select d.id, d.display_name, count(c.id)::int, coalesce(sum(c.base_cents), 0)::bigint,
           coalesce(sum(c.commission_cents), 0)::bigint,
           coalesce(sum(c.commission_cents) filter (where c.paid_at is null), 0)::bigint
      from public.clinic_doctor_commissions c
      join public.clinic_doctors d on d.id = c.doctor_id
     where c.organization_id = p_org and c.created_at >= p_from and c.created_at < p_to
       and (p_doctor is null or c.doctor_id = p_doctor)
     group by d.id, d.display_name
     order by 5 desc;
end;
$$;

-- Pay out a doctor's unpaid commissions in one branch, up to p_until.
create or replace function public.clinic_commission_pay(
  p_org uuid, p_branch uuid, p_doctor uuid, p_until timestamptz default now()
) returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_total bigint;
  v_acct  uuid;
  v_cur   char(3);
  v_name  text;
begin
  perform app.clinic_require(p_org, p_branch, 'clinic.commission.read');
  perform app.clinic_require(p_org, p_branch, 'treasury.create');
  select display_name into v_name from public.clinic_doctors where id = p_doctor and organization_id = p_org;
  if v_name is null then raise exception 'الطبيب غير موجود' using errcode = 'P0002'; end if;
  if app.clinic_my_doctor(p_org) = p_doctor then
    raise exception 'لا يصرف الطبيب عمولته لنفسه' using errcode = '42501';
  end if;

  with paid as (
    update public.clinic_doctor_commissions set paid_at = now()
     where organization_id = p_org and branch_id = p_branch and doctor_id = p_doctor
       and paid_at is null and created_at <= p_until
    returning commission_cents
  )
  select coalesce(sum(commission_cents), 0) into v_total from paid;
  if v_total = 0 then return 0; end if;

  select currency into v_cur from public.organizations where id = p_org;
  select id into v_acct from public.treasury_accounts where branch_id = p_branch and is_active and is_default limit 1;
  if v_acct is null then raise exception 'لا توجد خزينة افتراضية للفرع' using errcode = 'check_violation'; end if;
  insert into public.treasury_transactions
    (organization_id, branch_id, account_id, direction, amount_cents, currency, category, reason, ref_type, ref_id, created_by)
  values (p_org, p_branch, v_acct, 'out', v_total, v_cur, 'commission', 'عمولة ' || v_name, 'clinic_doctor', p_doctor, auth.uid());
  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, auth.uid(), 'clinic.commission.paid', 'clinic_doctor', p_doctor::text,
          jsonb_build_object('amount_cents', v_total, 'until', p_until));
  return v_total;
end;
$$;

-- =============================================================================
-- 8. Grants
-- =============================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'app.clinic_settings_of(uuid)', 'app.bootstrap_medical(uuid, uuid)', 'app.clinic_require(uuid, uuid, text)',
    'app.clinic_shift_room(uuid, uuid, uuid, timestamptz, timestamptz)', 'app.clinic_patient_customer(uuid)',
    'app.clinic_issue_invoice(uuid, bigint)', 'app.clinic_appointment_after()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;

  foreach f in array array[
    'public.clinic_settings_save(uuid, jsonb)',
    'public.clinic_room_save(uuid, uuid, uuid, text, text, boolean)',
    'public.clinic_doctor_set_shifts(uuid, uuid, uuid, jsonb)',
    'public.clinic_doctor_save(uuid, uuid, jsonb)',
    'public.clinic_service_save(uuid, uuid, jsonb, jsonb)',
    'public.clinic_appointment_book(uuid, uuid, uuid, uuid, timestamptz, uuid[], integer, uuid, text, text)',
    'public.clinic_appointment_reschedule(uuid, uuid, timestamptz, uuid, uuid, integer)',
    'public.clinic_available_slots(uuid, uuid, uuid, date)',
    'public.clinic_appointment_add_service(uuid, uuid, uuid, integer, uuid)',
    'public.clinic_appointment_remove_service(uuid, uuid)',
    'public.clinic_prescription_issue(uuid, uuid, jsonb, uuid, text)',
    'public.clinic_prescription_cancel(uuid, uuid, text)',
    'public.clinic_prescription_share(uuid, uuid)',
    'public.clinic_visit_invoice(uuid, uuid, bigint)',
    'public.clinic_visit_pay(uuid, uuid, text, bigint)',
    'public.clinic_commission_summary(uuid, timestamptz, timestamptz, uuid)',
    'public.clinic_commission_pay(uuid, uuid, uuid, timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  -- The prescription link: the one anonymous entry point this module adds.
  revoke all on function public.clinic_prescription_public(text) from public;
  grant execute on function public.clinic_prescription_public(text) to anon, authenticated;
end $$;
