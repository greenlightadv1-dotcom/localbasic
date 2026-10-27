-- =============================================================================
-- LOCAL BASIC — clinic calendar reads (0115): workspace, calendar range with
-- lines and invoice, doctor-only view, patient search
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_doc uuid; u_rec uuid; u_other uuid;
  org uuid; br uuid; org_b uuid; br_b uuid; m uuid; m_doc uuid;
  doc uuid; doc2 uuid; svc uuid; pat uuid; appt uuid; d date; t timestamptz; j jsonb; refused boolean; n int;
begin
  insert into auth.users (email) values ('c47-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('c47-doc@test.local')   returning id into u_doc;
  insert into auth.users (email) values ('c47-rec@test.local')   returning id into u_rec;
  insert into auth.users (email) values ('c47-other@test.local') returning id into u_other;
  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br from public.provision_workspace('C47 Clinic', 'c47clinic', 'medical');
  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b from public.provision_workspace('C47 Other', 'c47other', 'medical');

  perform auth.as_admin();
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_doc, 'active', true, now()) returning id into m_doc;
  insert into public.user_roles (member_id, role_id) select m_doc, id from public.roles where organization_id = org and key = 'doctor';
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_rec, 'active', true, now()) returning id into m;
  insert into public.user_roles (member_id, role_id) select m, id from public.roles where organization_id = org and key = 'receptionist';

  perform auth.login_as(u_owner);
  doc := public.clinic_doctor_save(org, null, jsonb_build_object('display_name', 'د. علا', 'member_id', m_doc, 'branch_id', br));
  doc2 := public.clinic_doctor_save(org, null, jsonb_build_object('display_name', 'د. باسم', 'branch_id', br));
  svc := public.clinic_service_save(org, null, jsonb_build_object('name', 'كشف أطفال', 'price_cents', 30000, 'duration_minutes', 20));

  -- ---- workspace ------------------------------------------------------------------
  perform auth.login_as(u_rec);
  j := public.clinic_workspace(org, br);
  assert j ->> 'branch_module' = 'medical', 'branch mode';
  assert jsonb_array_length(j -> 'doctors') = 2 and jsonb_array_length(j -> 'rooms') = 2, 'doctors and rooms';
  assert jsonb_array_length(j -> 'shifts') = 12, 'default shifts for both doctors, got ' || jsonb_array_length(j -> 'shifts');
  assert j -> 'settings' ->> 'opens_at' = '09:00', 'settings as HH:MI';
  assert (select count(*) from jsonb_array_elements(j -> 'services') s where s ->> 'name' = 'كشف أطفال') = 1, 'services';

  -- ---- patients and calendar --------------------------------------------------------
  pat := public.clinic_patient_save(org, br, null, jsonb_build_object('full_name', 'ليلى حسن', 'phone', '01066666666', 'allergies', 'لاتكس'));
  assert (select count(*) from public.clinic_patient_search(org, '+20 106 666 6666')) = 1, 'search by phone';
  assert (select count(*) from public.clinic_patient_search(org, 'ليلى')) = 1, 'search by name';
  assert (select count(*) from public.clinic_patient_search(org, (select file_number from public.clinic_patients where id = pat))) = 1, 'search by file number';
  assert (select count(*) from public.clinic_patient_search(org, '%')) = 0, 'wildcards are not a search';

  d := (now() at time zone 'Africa/Cairo')::date + 1;
  if extract(dow from d) = 5 then d := d + 1; end if;
  t := (d + time '11:00') at time zone 'Africa/Cairo';
  appt := public.clinic_appointment_book(org, br, pat, doc, t, array[svc]);
  perform public.clinic_appointment_book(org, br, pat, doc2, t, array[svc]);

  j := public.clinic_calendar(org, br, t - interval '1 hour', t + interval '1 day');
  assert jsonb_array_length(j) = 2, 'reception sees both doctors';
  assert (j -> 0 -> 'patient' ->> 'allergies') = 'لاتكس', 'allergies for staff with patient.read';
  assert jsonb_array_length(j -> 0 -> 'services') = 1 and (j -> 0 ->> 'invoice') is null, 'lines, no invoice yet';
  perform public.clinic_visit_invoice(org, appt);
  j := public.clinic_calendar(org, br, t - interval '1 hour', t + interval '1 day');
  assert (select (a -> 'invoice' ->> 'total_cents')::bigint from jsonb_array_elements(j) a where a ->> 'id' = appt::text) = 30000,
         'invoice rides with the appointment';

  refused := false;
  begin perform public.clinic_calendar(org, br, t, t + interval '40 days'); exception when invalid_parameter_value then refused := true; end;
  assert refused, 'range is bounded';

  -- A doctor without appointment.read sees only their own.
  perform auth.as_admin();
  delete from public.role_permissions rp using public.roles ro
   where rp.role_id = ro.id and ro.organization_id = org and ro.key = 'doctor' and rp.permission_key = 'clinic.appointment.read';
  perform auth.login_as(u_doc);
  j := public.clinic_calendar(org, br, t - interval '1 hour', t + interval '1 day');
  assert jsonb_array_length(j) = 1 and (j -> 0 ->> 'doctor_id')::uuid = doc, 'a doctor sees their own calendar';

  perform auth.login_as(u_other);
  refused := false;
  begin perform public.clinic_workspace(org, br); exception when insufficient_privilege then refused := true; end;
  assert refused, 'another org cannot read the workspace';
  refused := false;
  begin perform public.clinic_calendar(org, br, t, t + interval '1 day'); exception when insufficient_privilege then refused := true; end;
  assert refused, 'or the calendar';

  raise notice 'CLINIC CALENDAR READS: all assertions passed';
end $$;
