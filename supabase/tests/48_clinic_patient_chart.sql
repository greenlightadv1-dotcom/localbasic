-- =============================================================================
-- LOCAL BASIC — clinic patient chart (0116): records, vitals, prescriptions
-- without tokens, visits with procedures and supplies, active visit, access
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_doc uuid; u_rec uuid; u_other uuid;
  org uuid; br uuid; org_b uuid; br_b uuid; m uuid; m_doc uuid;
  doc uuid; svc uuid; item uuid; pat uuid; appt uuid; d date; t timestamptz; j jsonb; refused boolean; tok text;
begin
  insert into auth.users (email) values ('c48-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('c48-doc@test.local')   returning id into u_doc;
  insert into auth.users (email) values ('c48-rec@test.local')   returning id into u_rec;
  insert into auth.users (email) values ('c48-other@test.local') returning id into u_other;
  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br from public.provision_workspace('C48 Clinic', 'c48clinic', 'medical');
  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b from public.provision_workspace('C48 Other', 'c48other', 'medical');

  perform auth.as_admin();
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_doc, 'active', true, now()) returning id into m_doc;
  insert into public.user_roles (member_id, role_id) select m_doc, id from public.roles where organization_id = org and key = 'doctor';
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org, u_rec, 'active', true, now()) returning id into m;
  insert into public.user_roles (member_id, role_id) select m, id from public.roles where organization_id = org and key = 'receptionist';
  update public.clinic_settings set enforce_shifts = false where organization_id = org;

  perform auth.login_as(u_owner);
  doc := public.clinic_doctor_save(org, null, jsonb_build_object('display_name', 'د. منى', 'member_id', m_doc));
  item := public.inventory_item_save(org, null, 'شاش معقم', 'pc');
  svc := public.clinic_service_save(org, null, jsonb_build_object('name', 'غيار جرح', 'price_cents', 15000),
                                    jsonb_build_array(jsonb_build_object('item_id', item, 'qty', 3)));
  pat := public.clinic_patient_save(org, br, null, jsonb_build_object('full_name', 'كريم سعيد', 'phone', '01088888888',
                                    'date_of_birth', '1985-03-02', 'chronic_conditions', 'سكري'));
  t := now() + interval '1 hour';
  appt := public.clinic_appointment_book(org, br, pat, doc, t, array[svc]);

  perform auth.login_as(u_doc);
  perform public.clinic_emr_add(org, pat, 'vitals', jsonb_build_object('pulse_bpm', 90, 'glucose_mg_dl', 180), appt);
  perform public.clinic_emr_add(org, pat, 'note', jsonb_build_object('body', 'ألم في القدم'), appt);
  select out_token into tok from public.clinic_prescription_issue(org, pat, '[{"drug_name":"ميتفورمين","strength":"500mg"}]'::jsonb, appt);

  j := public.clinic_patient_chart(org, pat);
  assert j -> 'patient' ->> 'chronic_conditions' = 'سكري' and (j -> 'patient' ->> 'age')::int >= 40, 'profile with age';
  assert jsonb_array_length(j -> 'records') = 2, 'records';
  assert (select count(*) from jsonb_array_elements(j -> 'records') r where (r ->> 'glucose_mg_dl')::int = 180) = 1, 'vitals values';
  assert jsonb_array_length(j -> 'prescriptions') = 1 and jsonb_array_length(j -> 'prescriptions' -> 0 -> 'items') = 1, 'prescriptions';
  assert not (j -> 'prescriptions' -> 0 ? 'public_token'), 'no share token in the chart';
  assert (j ->> 'active_visit_id')::uuid = appt, 'the booked visit is the active one';
  assert (j -> 'service_supplies' -> svc::text -> 0 ->> 'qty')::numeric = 3, 'supplies per service';
  assert jsonb_array_length(j -> 'visits' -> 0 -> 'services') = 1, 'visit procedures';
  assert public.clinic_patient_chart(org, gen_random_uuid()) is null, 'unknown patient';

  perform auth.login_as(u_rec);
  refused := false;
  begin perform public.clinic_patient_chart(org, pat); exception when insufficient_privilege then refused := true; end;
  assert refused, 'reception cannot open the chart';
  perform auth.login_as(u_other);
  refused := false;
  begin perform public.clinic_patient_chart(org, pat); exception when insufficient_privilege then refused := true; end;
  assert refused, 'another org cannot open the chart';

  perform auth.logout();
  assert public.clinic_prescription_public(tok) ->> 'timezone' = 'Africa/Cairo', 'the public prescription carries the clinic timezone';

  raise notice 'CLINIC PATIENT CHART: all assertions passed';
end $$;
