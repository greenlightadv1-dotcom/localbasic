-- =============================================================================
-- LOCAL BASIC — 0115 Clinic calendar reads
--
-- The three reads the appointments screen needs, as SECURITY DEFINER
-- functions with the permission check at the top:
--
--   clinic_workspace       this branch's clinic setup in one call: mode,
--                          settings, doctors, rooms, services, weekly shifts.
--   clinic_calendar        appointments in a date range with patient,
--                          procedure lines and the visit invoice. Without
--                          clinic.appointment.read a doctor sees their own.
--   clinic_patient_search  by phone (normalised), name or file number.
--
-- Read-only. The visit invoice is returned with the appointment so the front
-- desk can see what is due without holding invoice.read.
-- =============================================================================

create or replace function public.clinic_workspace(p_org uuid, p_branch uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_set public.clinic_settings;
  v_me  uuid;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.clinic_staff(p_org) then raise exception 'not permitted' using errcode = '42501'; end if;
  if not exists (select 1 from public.branches where id = p_branch and organization_id = p_org and deleted_at is null) then
    raise exception 'فرع غير صالح' using errcode = 'check_violation';
  end if;
  v_set := app.clinic_settings_of(p_org);
  v_me := app.clinic_my_doctor(p_org);

  return jsonb_build_object(
    'branch_module', app.branch_module(p_branch),
    'timezone', (select timezone from public.organizations where id = p_org),
    'my_doctor_id', v_me,
    'settings', jsonb_build_object(
      'opens_at', to_char(v_set.opens_at, 'HH24:MI'), 'closes_at', to_char(v_set.closes_at, 'HH24:MI'),
      'work_days', to_jsonb(v_set.work_days), 'slot_minutes', v_set.slot_minutes, 'enforce_shifts', v_set.enforce_shifts),
    'doctors', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'display_name', d.display_name, 'specialty', d.specialty, 'color', d.color,
               'consultation_fee_cents', d.consultation_fee_cents, 'is_me', d.id = v_me)
             order by d.display_name)
        from public.clinic_doctors d
       where d.organization_id = p_org and d.is_active and d.deleted_at is null), '[]'::jsonb),
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'kind', r.kind) order by r.name)
        from public.clinic_rooms r
       where r.branch_id = p_branch and r.is_active), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'name', s.name, 'category', s.category, 'price_cents', s.price_cents,
               'duration_minutes', s.duration_minutes)
             order by s.category nulls last, s.name)
        from public.clinic_services s
       where s.organization_id = p_org and s.is_active and s.deleted_at is null), '[]'::jsonb),
    'shifts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', sh.id, 'doctor_id', sh.doctor_id, 'room_id', sh.room_id, 'weekday', sh.weekday,
               'starts_at', to_char(sh.starts_at, 'HH24:MI'), 'ends_at', to_char(sh.ends_at, 'HH24:MI'),
               'slot_minutes', sh.slot_minutes)
             order by sh.weekday, sh.starts_at)
        from public.clinic_doctor_shifts sh
       where sh.branch_id = p_branch
         and (sh.valid_to is null or sh.valid_to >= current_date)), '[]'::jsonb));
end;
$$;

create or replace function public.clinic_calendar(p_org uuid, p_branch uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_all      boolean;
  v_me       uuid;
  v_patients boolean;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  v_all := app.has_branch_permission(p_org, p_branch, 'clinic.appointment.read');
  v_me := app.clinic_my_doctor(p_org);
  if not v_all and v_me is null then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_to <= p_from or p_to - p_from > interval '32 days' then
    raise exception 'نطاق التاريخ غير صالح' using errcode = '22023';
  end if;
  v_patients := app.has_permission(p_org, 'clinic.patient.read');

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'doctor_id', a.doctor_id, 'room_id', a.room_id,
             'starts_at', a.starts_at, 'ends_at', a.ends_at, 'status', a.status, 'source', a.source,
             'reason', a.reason, 'checked_in_at', a.checked_in_at, 'session_started_at', a.session_started_at,
             'completed_at', a.completed_at, 'cancel_reason', a.cancel_reason,
             'patient', jsonb_build_object(
               'id', p.id, 'full_name', p.full_name, 'file_number', p.file_number,
               'phone', case when v_patients then p.phone end,
               'allergies', case when v_patients then p.allergies end),
             'services', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'line_id', l.id, 'service_id', l.service_id, 'name', s.name, 'doctor_id', l.doctor_id,
                        'quantity', l.quantity, 'unit_price_cents', l.unit_price_cents, 'discount_cents', l.discount_cents,
                        'consumed', l.supplies_consumed_at is not null)
                      order by l.created_at)
                 from public.clinic_appointment_services l
                 join public.clinic_services s on s.id = l.service_id
                where l.appointment_id = a.id), '[]'::jsonb),
             'invoice', case when i.id is null then null else jsonb_build_object(
               'id', i.id, 'number', i.number, 'total_cents', i.total_cents, 'paid_cents', i.paid_cents, 'status', i.status) end)
           order by a.starts_at)
      from public.clinic_appointments a
      join public.clinic_patients p on p.id = a.patient_id
      left join public.invoices i on i.id = a.invoice_id
     where a.organization_id = p_org and a.branch_id = p_branch
       and a.starts_at < p_to and a.ends_at > p_from
       and (v_all or a.doctor_id = v_me)), '[]'::jsonb);
end;
$$;

create or replace function public.clinic_patient_search(p_org uuid, p_query text)
returns table (id uuid, file_number text, full_name text, phone text, gender text,
               date_of_birth date, allergies text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_q   text := trim(coalesce(p_query, ''));
  v_key text;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'clinic.patient.read') then raise exception 'not permitted' using errcode = '42501'; end if;
  if length(v_q) < 2 then return; end if;
  v_key := case when v_q ~ '^[+0-9 ()-]{7,}$' then app.phone_key(v_q) end;

  return query
    select p.id, p.file_number, p.full_name, p.phone, p.gender, p.date_of_birth, p.allergies
      from public.clinic_patients p
     where p.organization_id = p_org and p.deleted_at is null
       and (   (v_key is not null and p.phone_key = v_key)
            or (v_key is null and (p.full_name ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%'
                                   or upper(p.file_number) = upper(v_q))))
     order by p.full_name
     limit 20;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.clinic_workspace(uuid, uuid)',
    'public.clinic_calendar(uuid, uuid, timestamptz, timestamptz)',
    'public.clinic_patient_search(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
