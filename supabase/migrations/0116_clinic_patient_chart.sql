-- =============================================================================
-- LOCAL BASIC — 0116 Clinic patient chart
--
-- One read for the EMR screen: the patient's profile, medical records (vitals
-- included), prescriptions with their items, recent visits with procedures,
-- the consumables each procedure uses, and the visit open right now.
--
-- Requires clinic.emr.read: this is clinical content. Prescription share
-- tokens are never returned here; sharing mints a fresh one
-- (clinic_prescription_share) so a token only exists where it was sent.
-- =============================================================================

create or replace function public.clinic_patient_chart(p_org uuid, p_patient uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  p record;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if not app.has_permission(p_org, 'clinic.emr.read') then raise exception 'not permitted' using errcode = '42501'; end if;

  select * into p from public.clinic_patients where id = p_patient and organization_id = p_org and deleted_at is null;
  if p.id is null then return null; end if;

  return jsonb_build_object(
    'patient', jsonb_build_object(
      'id', p.id, 'branch_id', p.branch_id, 'file_number', p.file_number, 'full_name', p.full_name,
      'phone', p.phone, 'national_id', p.national_id, 'gender', p.gender, 'date_of_birth', p.date_of_birth,
      'age', case when p.date_of_birth is not null then extract(year from age(p.date_of_birth))::int end,
      'blood_type', p.blood_type, 'allergies', p.allergies, 'chronic_conditions', p.chronic_conditions,
      'emergency_contact_name', p.emergency_contact_name, 'emergency_contact_phone', p.emergency_contact_phone,
      'notes', p.notes, 'created_at', p.created_at),

    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'type', r.record_type, 'title', r.title, 'body', r.body, 'diagnosis_code', r.diagnosis_code,
               'temperature_c', r.temperature_c, 'pulse_bpm', r.pulse_bpm, 'systolic_mmhg', r.systolic_mmhg,
               'diastolic_mmhg', r.diastolic_mmhg, 'respiratory_rate', r.respiratory_rate, 'spo2_percent', r.spo2_percent,
               'weight_kg', r.weight_kg, 'height_cm', r.height_cm, 'glucose_mg_dl', r.glucose_mg_dl,
               'attachment_path', r.attachment_path, 'attachment_mime', r.attachment_mime, 'attachment_bytes', r.attachment_bytes,
               'amends_id', r.amends_id, 'appointment_id', r.appointment_id, 'doctor_id', r.doctor_id,
               'author', coalesce(pr.full_name, 'عضو الفريق'), 'created_at', r.created_at)
             order by r.created_at desc)
        from (select * from public.clinic_emr_records
               where patient_id = p_patient and organization_id = p_org
               order by created_at desc limit 300) r
        left join public.profiles pr on pr.id = r.author_id), '[]'::jsonb),

    'prescriptions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', rx.id, 'number', rx.number, 'status', rx.status, 'notes', rx.notes,
               'issued_at', rx.issued_at, 'expires_at', rx.token_expires_at, 'doctor_id', rx.doctor_id,
               'appointment_id', rx.appointment_id, 'cancel_reason', rx.cancel_reason,
               'items', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'drug_name', i.drug_name, 'strength', i.strength, 'dosage_form', i.dosage_form, 'dose', i.dose,
                          'route', i.route, 'frequency', i.frequency, 'duration', i.duration, 'instructions', i.instructions)
                        order by i.position)
                   from public.clinic_prescription_items i where i.prescription_id = rx.id), '[]'::jsonb))
             order by rx.issued_at desc)
        from (select * from public.clinic_prescriptions
               where patient_id = p_patient and organization_id = p_org
               order by issued_at desc limit 100) rx), '[]'::jsonb),

    'visits', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'branch_id', a.branch_id, 'doctor_id', a.doctor_id, 'starts_at', a.starts_at,
               'status', a.status, 'reason', a.reason,
               'services', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'line_id', l.id, 'service_id', l.service_id, 'name', s.name, 'quantity', l.quantity,
                          'unit_price_cents', l.unit_price_cents, 'discount_cents', l.discount_cents,
                          'consumed', l.supplies_consumed_at is not null)
                        order by l.created_at)
                   from public.clinic_appointment_services l
                   join public.clinic_services s on s.id = l.service_id
                  where l.appointment_id = a.id), '[]'::jsonb),
               'invoice', case when i.id is null then null else jsonb_build_object(
                 'number', i.number, 'total_cents', i.total_cents, 'paid_cents', i.paid_cents, 'status', i.status) end)
             order by a.starts_at desc)
        from (select * from public.clinic_appointments
               where patient_id = p_patient and organization_id = p_org
               order by starts_at desc limit 50) a
        left join public.invoices i on i.id = a.invoice_id), '[]'::jsonb),

    -- The visit to document now: in session first, then waiting, then booked today.
    'active_visit_id', (
      select a.id from public.clinic_appointments a
       where a.patient_id = p_patient and a.organization_id = p_org
         and a.status in ('in_session', 'checked_in', 'booked')
         and a.starts_at::date between current_date - 1 and current_date + 1
       order by case a.status when 'in_session' then 0 when 'checked_in' then 1 else 2 end, a.starts_at
       limit 1),

    'service_supplies', coalesce((
      select jsonb_object_agg(x.service_id, x.supplies)
        from (select ss.service_id,
                     jsonb_agg(jsonb_build_object('item_name', it.name, 'qty', ss.qty, 'unit', it.unit) order by it.name) as supplies
                from public.clinic_service_supplies ss
                join public.inventory_items it on it.id = ss.item_id
               where ss.organization_id = p_org
               group by ss.service_id) x), '{}'::jsonb));
end;
$$;

-- The public prescription read (0113) also returns the clinic's timezone, so
-- the printed date is the clinic's date, not the server's.
create or replace function public.clinic_prescription_public(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if p_token is null or length(p_token) not between 20 and 64 then return null; end if;
  perform app.rate_limit('rl_clinic_rx_public', left(p_token, 64), 60, 600);
  select jsonb_build_object(
           'number', rx.number, 'issued_at', rx.issued_at, 'expires_at', rx.token_expires_at, 'notes', rx.notes,
           'clinic', o.name, 'timezone', o.timezone, 'branch', b.name, 'branch_phone', b.phone, 'branch_address', b.address,
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
revoke all on function public.clinic_prescription_public(text) from public;
grant execute on function public.clinic_prescription_public(text) to anon, authenticated;

revoke all on function public.clinic_patient_chart(uuid, uuid) from public, anon;
grant execute on function public.clinic_patient_chart(uuid, uuid) to authenticated;
