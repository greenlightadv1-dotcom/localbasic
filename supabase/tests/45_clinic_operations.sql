-- =============================================================================
-- LOCAL BASIC — clinic operations (0113): bootstrap, doctors with default
-- shifts, shift-checked booking, slots, reschedule, visit lines, completion →
-- invoice + supplies + commission, cashier payment, prescriptions and their
-- public link, commission summary and payout
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_doc uuid; u_rec uuid; u_mgr uuid; u_other uuid;
  org uuid; br uuid; org_b uuid; br_b uuid; m uuid; m_doc uuid;
  doc uuid; svc uuid; item uuid; pat uuid; appt uuid; appt2 uuid; line uuid; inv uuid;
  d date; t timestamptz; r record; refused boolean; n int; tok text; tok2 text; j jsonb; b bigint;
begin
  insert into auth.users (email) values ('c45-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('c45-doc@test.local')   returning id into u_doc;
  insert into auth.users (email) values ('c45-rec@test.local')   returning id into u_rec;
  insert into auth.users (email) values ('c45-mgr@test.local')   returning id into u_mgr;
  insert into auth.users (email) values ('c45-other@test.local') returning id into u_other;
  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br from public.provision_workspace('C45 Clinic', 'c45clinic', 'medical');
  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b from public.provision_workspace('C45 Other', 'c45other', 'medical');

  perform auth.as_admin();
  assert exists (select 1 from public.clinic_settings where organization_id = org), 'bootstrap: settings';
  assert (select count(*) from public.clinic_rooms where organization_id = org) = 2, 'bootstrap: rooms';
  assert (select count(*) from public.clinic_services where organization_id = org) = 2, 'bootstrap: services';
  for r in select * from (values (u_doc, 'doctor'), (u_rec, 'receptionist'), (u_mgr, 'manager')) as x(u, kk) loop
    insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
    values (org, r.u, 'active', true, now()) returning id into m;
    insert into public.user_roles (member_id, role_id) select m, id from public.roles where organization_id = org and key = r.kk;
    if r.kk = 'doctor' then m_doc := m; end if;
  end loop;

  -- ---- setup ---------------------------------------------------------------------------
  perform auth.login_as(u_rec);
  refused := false;
  begin perform public.clinic_doctor_save(org, null, jsonb_build_object('display_name', 'x')); exception when insufficient_privilege then refused := true; end;
  assert refused, 'reception cannot manage doctors';

  perform auth.login_as(u_mgr);
  doc := public.clinic_doctor_save(org, null, jsonb_build_object(
    'display_name', 'د. كريم', 'specialty', 'أسنان', 'license_number', 'EG-123', 'member_id', m_doc,
    'commission_mode', 'percent', 'commission_percent', 20, 'branch_id', br));
  assert (select count(*) from public.clinic_doctor_shifts where doctor_id = doc) = 6, 'default shifts on every working day';
  refused := false;
  begin perform public.clinic_doctor_set_shifts(org, doc, br, jsonb_build_array(
    jsonb_build_object('weekday', 1, 'starts_at', '09:00', 'ends_at', '13:00'),
    jsonb_build_object('weekday', 1, 'starts_at', '12:00', 'ends_at', '16:00')));
  exception when sqlstate 'LB409' then refused := true; end;
  assert refused, 'overlapping shifts are refused';
  assert (select count(*) from public.clinic_doctor_shifts where doctor_id = doc) = 6, 'and the old shifts survive';

  perform auth.login_as(u_owner);
  item := public.inventory_item_save(org, null, 'مخدر موضعي', 'ml');
  perform auth.login_as(u_mgr);
  svc := public.clinic_service_save(org, null, jsonb_build_object('name', 'حشو عصب', 'price_cents', 50000, 'duration_minutes', 30),
                                    jsonb_build_array(jsonb_build_object('item_id', item, 'qty', 2)));
  assert (select qty from public.clinic_service_supplies where service_id = svc) = 2, 'supplies saved';

  perform auth.login_as(u_rec);
  pat := public.clinic_patient_save(org, br, null, jsonb_build_object('full_name', 'سامح فؤاد', 'phone', '01077777777',
                                                                      'date_of_birth', '1990-05-01'));

  -- ---- calendar --------------------------------------------------------------------------
  d := (now() at time zone 'Africa/Cairo')::date + 1;
  if extract(dow from d) = 5 then d := d + 1; end if;   -- Friday is off by default
  t := (d + time '10:00') at time zone 'Africa/Cairo';

  refused := false;
  begin perform public.clinic_appointment_book(org, br, pat, doc, (d + time '22:00') at time zone 'Africa/Cairo', array[svc]);
  exception when invalid_parameter_value then refused := true; end;
  assert refused, 'outside the doctor''s shift is refused';

  appt := public.clinic_appointment_book(org, br, pat, doc, t, array[svc]);
  select count(*) into n from public.clinic_available_slots(org, br, doc, d);
  assert n = 46, '48 slots minus the two a 30-minute visit covers, got ' || n;
  refused := false;
  begin perform public.clinic_appointment_book(org, br, pat, doc, t + interval '15 minutes', array[svc]);
  exception when sqlstate 'LB409' then refused := true; end;
  assert refused, 'double booking returns LB409';

  perform public.clinic_appointment_reschedule(org, appt, t + interval '1 hour');
  perform auth.as_admin();
  assert (select starts_at from public.clinic_appointments where id = appt) = t + interval '1 hour', 'rescheduled';
  assert (select ends_at - starts_at from public.clinic_appointments where id = appt) = interval '30 minutes', 'duration kept';
  perform auth.login_as(u_rec);
  appt2 := public.clinic_appointment_book(org, br, pat, doc, t, array[svc]);   -- the old slot is free again
  perform public.clinic_appointment_set_status(org, appt2, 'cancelled', 'تكرار');

  -- ---- visit -------------------------------------------------------------------------------
  line := public.clinic_appointment_add_service(org, appt, svc, 1);
  perform public.clinic_appointment_remove_service(org, line);
  perform public.clinic_appointment_set_status(org, appt, 'checked_in');
  perform auth.login_as(u_doc);
  perform public.clinic_appointment_set_status(org, appt, 'in_session');
  line := public.clinic_appointment_add_service(org, appt, svc, 1);
  perform public.clinic_appointment_set_status(org, appt, 'completed');

  perform auth.as_admin();
  select invoice_id into inv from public.clinic_appointments where id = appt;
  assert inv is not null, 'completion issues the visit invoice';
  assert (select total_cents from public.invoices where id = inv) = 100000 and (select source from public.invoices where id = inv) = 'medical',
         'invoice totals the procedures';
  assert (select c.phone from public.invoices i join public.customers c on c.id = i.customer_id where i.id = inv) = '01077777777',
         'the patient became a customer';
  assert (select sum(commission_cents) from public.clinic_doctor_commissions where appointment_id = appt) = 20000, 'commission 20%%';
  assert (select sum(qty) from public.inventory_movements where doc_id = appt and reason = 'consumption') = -4, 'supplies consumed';

  perform auth.login_as(u_doc);
  refused := false;
  begin perform public.clinic_appointment_add_service(org, appt, svc); exception when check_violation then refused := true; end;
  assert refused, 'no new lines after the visit is billed';

  perform auth.login_as(u_rec);
  select * into r from public.clinic_visit_pay(org, appt, 'cash', 30000);
  assert r.out_due_cents = 70000 and r.out_change_cents = 0, 'partial payment';
  select * into r from public.clinic_visit_pay(org, appt, 'cash', 75000);
  assert r.out_due_cents = 0 and r.out_change_cents = 5000, 'settled with change';
  perform auth.as_admin();
  assert (select status from public.invoices where id = inv) = 'paid', 'invoice paid';
  perform auth.login_as(u_rec);
  refused := false;
  begin perform public.clinic_visit_pay(org, appt, 'cash', 100); exception when check_violation then refused := true; end;
  assert refused, 'cannot overpay a settled visit';

  appt2 := public.clinic_appointment_book(org, br, pat, doc, t + interval '3 hours', array[svc]);
  refused := false;
  begin perform public.clinic_visit_invoice(org, appt2, 5000); exception when sqlstate 'LB403' then refused := true; end;
  assert refused, 'a visit discount needs the manager PIN';
  inv := public.clinic_visit_invoice(org, appt2);
  refused := false;
  begin perform public.clinic_appointment_add_service(org, appt2, svc); exception when check_violation then refused := true; end;
  assert refused, 'a pre-billed visit is closed for new lines';

  -- ---- prescriptions ------------------------------------------------------------------------
  refused := false;
  begin perform public.clinic_prescription_issue(org, pat, '[{"drug_name":"x"}]'::jsonb); exception when insufficient_privilege then refused := true; end;
  assert refused, 'only doctors issue prescriptions';

  perform auth.login_as(u_doc);
  select * into r from public.clinic_prescription_issue(org, pat, jsonb_build_array(
    jsonb_build_object('drug_name', 'أموكسيسيلين', 'strength', '500mg', 'frequency', 'كل 8 ساعات', 'duration', '5 أيام'),
    jsonb_build_object('drug_name', 'باراسيتامول', 'strength', '500mg', 'frequency', 'عند اللزوم')), appt, 'بعد الأكل');
  tok := r.out_token;
  assert r.out_number like 'RX-%' and length(tok) >= 30, 'numbered with an opaque token';
  assert r.out_expires_at > now() + interval '29 days', 'link valid for the configured days';

  perform auth.logout();
  j := public.clinic_prescription_public(tok);
  assert j ->> 'doctor' = 'د. كريم' and jsonb_array_length(j -> 'items') = 2 and j ->> 'patient' = 'سامح فؤاد',
         'the link shows the prescription';
  assert (j -> 'items' -> 0 ->> 'drug_name') = 'أموكسيسيلين', 'in order';
  assert public.clinic_prescription_public('not-a-real-token-at-all-000') is null, 'a wrong token shows nothing';

  perform auth.login_as(u_doc);
  select out_token into tok2 from public.clinic_prescription_share(org, r.out_id);
  perform auth.logout();
  assert public.clinic_prescription_public(tok) is null and public.clinic_prescription_public(tok2) is not null,
         'sharing rotates the link';
  perform auth.login_as(u_doc);
  perform public.clinic_prescription_cancel(org, r.out_id, 'جرعة خاطئة');
  perform auth.logout();
  assert public.clinic_prescription_public(tok2) is null, 'a cancelled prescription link dies';

  -- ---- commissions ------------------------------------------------------------------------------
  perform auth.login_as(u_doc);
  select * into r from public.clinic_commission_summary(org, now() - interval '1 day', now() + interval '1 day');
  assert r.doctor_id = doc and r.commission_cents = 20000 and r.unpaid_cents = 20000, 'the doctor sees their own';
  perform auth.login_as(u_rec);
  refused := false;
  begin perform public.clinic_commission_summary(org, now() - interval '1 day', now() + interval '1 day');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'reception sees no commissions';
  perform auth.login_as(u_mgr);
  b := public.clinic_commission_pay(org, br, doc);
  assert b = 20000, 'payout';
  assert public.clinic_commission_pay(org, br, doc) = 0, 'paid once';
  perform auth.as_admin();
  assert exists (select 1 from public.treasury_transactions where organization_id = org and category = 'commission'
                   and direction = 'out' and amount_cents = 20000), 'payout left the treasury';

  perform auth.login_as(u_other);
  refused := false;
  begin perform public.clinic_visit_pay(org, appt2, 'cash', 100); exception when insufficient_privilege or no_data_found then refused := true; end;
  assert refused, 'another org cannot bill this clinic';

  raise notice 'CLINIC OPERATIONS: all assertions passed';
end $$;
