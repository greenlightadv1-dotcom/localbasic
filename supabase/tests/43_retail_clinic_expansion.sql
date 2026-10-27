-- =============================================================================
-- LOCAL BASIC — retail & clinic expansion (0111): branch mode, barcodes and
-- scale codes, store credit, transfer workflow, returns; clinic calendar,
-- EMR isolation, completion → supplies + commission, private records bucket
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_owner uuid; u_doc uuid; u_rec uuid; u_nurse uuid; u_mgr uuid; u_other uuid; u_shop uuid;
  org uuid; br uuid; org_b uuid; br_b uuid; shop uuid; shop_br uuid; shop_br2 uuid; m uuid; m_doc uuid;
  room uuid; doc uuid; svc uuid; item uuid; pat uuid; pat_b uuid; appt uuid; appt2 uuid; rec uuid;
  prod uuid; var uuid; cust uuid; inv uuid; tr uuid; r record; refused boolean; n int; q numeric;
  t0 timestamptz := date_trunc('day', now()) + interval '1 day 9 hours';
begin
  insert into auth.users (email) values ('c43-owner@test.local') returning id into u_owner;
  insert into auth.users (email) values ('c43-doc@test.local')   returning id into u_doc;
  insert into auth.users (email) values ('c43-rec@test.local')   returning id into u_rec;
  insert into auth.users (email) values ('c43-nurse@test.local') returning id into u_nurse;
  insert into auth.users (email) values ('c43-mgr@test.local')   returning id into u_mgr;
  insert into auth.users (email) values ('c43-other@test.local') returning id into u_other;
  insert into auth.users (email) values ('c43-shop@test.local')  returning id into u_shop;

  perform auth.login_as(u_owner);
  select out_organization_id, out_branch_id into org, br from public.provision_workspace('C43 Clinic', 'c43clinic', 'medical');
  perform auth.login_as(u_other);
  select out_organization_id, out_branch_id into org_b, br_b from public.provision_workspace('C43 Other', 'c43other', 'medical');
  perform auth.login_as(u_shop);
  select out_organization_id, out_branch_id into shop, shop_br from public.provision_workspace('C43 Shop', 'c43shop', 'retail');

  perform auth.as_admin();
  assert (select count(*) from public.roles where organization_id = org and key in ('doctor', 'nurse', 'receptionist')) = 3,
         'a medical workspace gets doctor, nurse and receptionist roles';
  for r in select * from (values (u_doc, 'doctor'), (u_rec, 'receptionist'), (u_nurse, 'nurse'), (u_mgr, 'manager')) as t(u, kk) loop
    insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
    values (org, r.u, 'active', true, now()) returning id into m;
    insert into public.user_roles (member_id, role_id) select m, id from public.roles where organization_id = org and key = r.kk;
    if r.kk = 'doctor' then m_doc := m; end if;
  end loop;
  assert not exists (select 1 from public.role_permissions rp join public.roles ro on ro.id = rp.role_id
                      where ro.organization_id = org and ro.key in ('manager', 'receptionist')
                        and rp.permission_key = 'clinic.emr.read'),
         'managers and reception never read charts';

  -- ---- branch mode -----------------------------------------------------------------
  assert app.branch_module(br) = 'medical' and app.branch_module(shop_br) = 'retail', 'branch mode defaults to the org module';
  perform auth.login_as(u_owner);
  refused := false;
  begin perform public.branch_set_module(org, br, 'retail'); exception when check_violation then refused := true; end;
  assert refused, 'a branch cannot switch to a module the org has not enabled';
  perform auth.login_as(u_rec);
  refused := false;
  begin perform public.branch_set_module(org, br, null); exception when insufficient_privilege then refused := true; end;
  assert refused, 'reception cannot change branch mode';

  -- ---- clinic setup ----------------------------------------------------------------
  perform auth.as_admin();
  insert into public.clinic_rooms (organization_id, branch_id, name, kind) values (org, br, 'غرفة 1', 'procedure') returning id into room;
  insert into public.clinic_doctors (organization_id, member_id, display_name, specialty, commission_mode, commission_percent)
  values (org, m_doc, 'د. سارة', 'جلدية', 'percent', 30) returning id into doc;
  insert into public.clinic_services (organization_id, name, price_cents, duration_minutes)
  values (org, 'جلسة تقشير', 40000, 30) returning id into svc;
  perform auth.login_as(u_owner);
  item := public.inventory_item_save(org, null, 'قفازات', 'pc');
  perform auth.as_admin();
  insert into public.clinic_service_supplies (organization_id, service_id, item_id, qty) values (org, svc, item, 2);

  -- ---- patients ----------------------------------------------------------------------
  perform auth.login_as(u_rec);
  pat := public.clinic_patient_save(org, br, null,
    jsonb_build_object('full_name', 'منى علي', 'phone', '+20 100 123 4567', 'gender', 'female', 'allergies', 'بنسلين'));
  perform auth.as_admin();
  assert (select file_number from public.clinic_patients where id = pat) = 'P-000001', 'file numbers are assigned';
  assert (select phone_key from public.clinic_patients where id = pat) = app.phone_key('01001234567'), 'phone is normalised';
  insert into public.clinic_patients (organization_id, branch_id, file_number, full_name)
  values (org_b, br_b, '', 'مريض آخر') returning id into pat_b;

  -- ---- booking -------------------------------------------------------------------------
  perform auth.login_as(u_rec);
  appt := public.clinic_appointment_book(org, br, pat, doc, t0, array[svc], null, room, 'متابعة');
  assert (select ends_at - starts_at from public.clinic_appointments where id = appt) = interval '30 minutes',
         'duration comes from the services';
  refused := false;
  begin perform public.clinic_appointment_book(org, br, pat, doc, t0 + interval '15 minutes', array[svc]);
  exception when sqlstate 'LB409' then refused := true; end;
  assert refused, 'a doctor cannot be double booked';
  appt2 := public.clinic_appointment_book(org, br, pat, doc, t0 + interval '30 minutes', array[svc], null, room);
  refused := false;
  begin perform public.clinic_appointment_book(org, br, pat_b, doc, t0 + interval '2 hours', array[svc]);
  exception when check_violation then refused := true; end;
  assert refused, 'a patient from another org cannot be booked';
  perform public.clinic_appointment_set_status(org, appt2, 'cancelled', 'اعتذر المريض');
  refused := false;
  begin perform public.clinic_appointment_set_status(org, appt2, 'checked_in'); exception when check_violation then refused := true; end;
  assert refused, 'a cancelled visit stays cancelled';

  perform auth.login_as(u_shop);
  refused := false;
  begin perform public.clinic_appointment_book(shop, shop_br, pat, doc, t0, array[]::uuid[]);
  exception when insufficient_privilege or invalid_parameter_value then refused := true; end;
  assert refused, 'a retail branch cannot book appointments';

  -- ---- visit flow ----------------------------------------------------------------------
  perform auth.login_as(u_rec);
  perform public.clinic_appointment_set_status(org, appt, 'checked_in');
  refused := false;
  begin perform public.clinic_appointment_set_status(org, appt, 'in_session'); exception when insufficient_privilege then refused := true; end;
  assert refused, 'reception cannot start a clinical session';

  perform auth.login_as(u_nurse);
  rec := public.clinic_emr_add(org, pat, 'vitals', jsonb_build_object('pulse_bpm', 78, 'systolic_mmhg', 120, 'diastolic_mmhg', 80), appt);
  refused := false;
  begin perform public.clinic_emr_add(org, pat, 'vitals', jsonb_build_object('pulse_bpm', 900), appt);
  exception when check_violation then refused := true; end;
  assert refused, 'impossible vitals are rejected';

  perform auth.login_as(u_doc);
  perform public.clinic_appointment_set_status(org, appt, 'in_session');
  perform public.clinic_emr_add(org, pat, 'diagnosis', jsonb_build_object('diagnosis_code', 'l70.0', 'body', 'حب شباب'), appt);
  refused := false;
  begin perform public.clinic_emr_add(org, pat, 'attachment', jsonb_build_object('attachment_path', org_b::text || '/' || pat::text || '/x.pdf'));
  exception when invalid_parameter_value then refused := true; end;
  assert refused, 'an attachment must live in this patient''s folder';
  perform public.clinic_appointment_set_status(org, appt, 'completed');

  perform auth.as_admin();
  assert (select status from public.clinic_appointments where id = appt) = 'completed', 'visit completed';
  select sum(mv.qty) into q from public.inventory_movements mv
    join public.inventory_locations l on l.id = mv.location_id
   where mv.doc_type = 'clinic_appointment' and mv.doc_id = appt and mv.reason = 'consumption' and l.kind = 'clinic';
  assert q = -2, 'completion consumes the procedure supplies from the clinic location, got ' || coalesce(q::text, 'null');
  assert (select commission_cents from public.clinic_doctor_commissions where appointment_id = appt) = 12000,
         'doctor commission accrues: 30%% of 40000';
  assert (select supplies_consumed_at is not null from public.clinic_appointment_services where appointment_id = appt),
         'the line is marked consumed';
  perform app.clinic_complete_appointment(appt);
  assert (select count(*) from public.inventory_movements where doc_id = appt) = 1, 'completion is idempotent';

  refused := false;
  begin update public.clinic_emr_records set body = 'x' where id = rec; exception when check_violation then refused := true; end;
  assert refused, 'medical records are append-only';

  -- ---- visibility ----------------------------------------------------------------------
  perform auth.login_as(u_rec);
  assert (select count(*) from public.clinic_emr_records) = 0, 'reception sees no charts';
  assert (select count(*) from public.clinic_patients) = 1, 'reception sees patient profiles';
  assert (select count(*) from public.clinic_doctor_commissions) = 0, 'reception sees no commissions';
  perform auth.login_as(u_mgr);
  assert (select count(*) from public.clinic_emr_records) = 0, 'managers see no charts';
  assert (select count(*) from public.clinic_doctor_commissions) = 1, 'managers see commissions';
  perform auth.login_as(u_doc);
  assert (select count(*) from public.clinic_emr_records where patient_id = pat) = 2, 'the doctor reads the chart';
  assert (select count(*) from public.clinic_doctor_commissions) = 1, 'the doctor sees their own commission';
  perform auth.login_as(u_other);
  assert (select count(*) from public.clinic_patients where organization_id = org) = 0, 'other orgs see no patients';
  assert (select count(*) from public.clinic_appointments where organization_id = org) = 0, 'or appointments';

  -- ---- private records bucket -----------------------------------------------------------
  perform auth.as_admin();
  assert (select not public from storage.buckets where id = 'clinic-records'), 'clinic-records is private';
  assert app.clinic_path_org('not-a-uuid/x/y.pdf') is null, 'a malformed path names no org';

  -- =========================================================================================
  -- RETAIL
  -- =========================================================================================
  insert into public.branches (organization_id, slug, name) values (shop, 'b2', 'فرع 2') returning id into shop_br2;
  insert into public.retail_products (organization_id, name, unit) values (shop, 'جبنة رومي', 'kg') returning id into prod;
  insert into public.retail_variants (organization_id, product_id, sku, barcode, price_cents, scale_code)
  values (shop, prod, 'CH-1', '6221000000017', 32000, '01234') returning id into var;
  insert into public.retail_barcodes (organization_id, variant_id, barcode, pack_qty, label) values (shop, var, 'BOX-12', 12, 'كرتونة');
  insert into public.retail_scale_formats (organization_id, name, prefix, code_digits, value_kind, value_decimals)
  values (shop, 'ميزان', '21', 5, 'weight', 3);

  refused := false;
  begin insert into public.retail_barcodes (organization_id, variant_id, barcode) values (shop, var, '6221000000017');
  exception when unique_violation then refused := true; end;
  assert refused, 'an alternate barcode cannot shadow a variant barcode';
  refused := false;
  begin insert into public.retail_barcodes (organization_id, variant_id, barcode) values (org, var, 'X-999');
  exception when check_violation then refused := true; end;
  assert refused, 'an alternate barcode cannot point across orgs';

  perform auth.login_as(u_shop);
  select * into r from public.retail_barcode_lookup(shop, '6221000000017');
  assert r.variant_id = var and r.matched_by = 'barcode' and r.quantity = 1, 'own barcode';
  select * into r from public.retail_barcode_lookup(shop, 'BOX-12');
  assert r.quantity = 12 and r.line_price_cents = 384000 and r.matched_by = 'alternate', 'carton scans as 12';
  -- 21 | 01234 | 01250 | 7  → 1.250 kg at 320.00/kg = 400.00
  select * into r from public.retail_barcode_lookup(shop, '2101234012507');
  assert r.variant_id = var and r.quantity = 1.25 and r.line_price_cents = 40000 and r.matched_by = 'scale',
         'scale barcode carries the weight, got ' || coalesce(r.quantity::text, 'null');
  assert not exists (select 1 from public.retail_barcode_lookup(shop, 'nope')), 'unknown code finds nothing';
  perform auth.login_as(u_other);
  refused := false;
  begin perform public.retail_barcode_lookup(shop, 'BOX-12'); exception when insufficient_privilege then refused := true; end;
  assert refused, 'lookup is scoped to members';

  -- ---- store credit -----------------------------------------------------------------------
  perform auth.as_admin();
  insert into public.customers (organization_id, name, phone) values (shop, 'عميل', '01099999999') returning id into cust;
  insert into public.retail_store_credits (organization_id, customer_id, kind, delta_cents, ref_type) values (shop, cust, 'issue', 5000, 'manual');
  insert into public.retail_store_credits (organization_id, customer_id, kind, delta_cents, ref_type) values (shop, cust, 'redeem', -3000, 'manual');
  assert app.retail_store_credit_balance(shop, cust) = 2000, 'store credit balance';
  refused := false;
  begin insert into public.retail_store_credits (organization_id, customer_id, kind, delta_cents) values (shop, cust, 'redeem', -2500);
  exception when check_violation then refused := true; end;
  assert refused, 'store credit never goes negative';
  refused := false;
  begin update public.retail_store_credits set delta_cents = 1 where customer_id = cust; exception when check_violation then refused := true; end;
  assert refused, 'store credit is append-only';

  -- ---- returns: cash back needs a manager --------------------------------------------------
  insert into public.invoices (organization_id, branch_id, number, currency, status, source)
  values (shop, shop_br, 'INV-T43', 'EGP', 'issued', 'pos') returning id into inv;
  refused := false;
  begin
    insert into public.retail_returns (organization_id, branch_id, number, original_invoice_id, resolution, refund_cents)
    values (shop, shop_br, 'RT-1', inv, 'cash', 1000);
  exception when check_violation then refused := true; end;
  assert refused, 'a cash refund without manager approval is refused';
  insert into public.retail_returns (organization_id, branch_id, number, original_invoice_id, customer_id, resolution, store_credit_cents)
  values (shop, shop_br, 'RT-2', inv, cust, 'store_credit', 1000);

  -- ---- transfer workflow ---------------------------------------------------------------------
  insert into public.retail_stock_transfers (organization_id, from_branch_id, to_branch_id, status, number, requested_at)
  values (shop, shop_br, shop_br2, 'requested', 'TR-000001', now()) returning id into tr;
  refused := false;
  begin update public.retail_stock_transfers set status = 'received' where id = tr; exception when check_violation then refused := true; end;
  assert refused, 'a requested transfer cannot jump to received';
  update public.retail_stock_transfers set status = 'approved', approved_at = now() where id = tr;
  update public.retail_stock_transfers set status = 'in_transit', dispatched_at = now() where id = tr;
  update public.retail_stock_transfers set status = 'received', received_at = now() where id = tr;
  assert (select status from public.retail_stock_transfers where id = tr) = 'received', 'transfer completes in order';
  assert (select count(*) from public.retail_stock_transfers where status <> 'received' and number is null) = 0,
         'legacy transfers read as received';

  -- ---- approval gate catalog -----------------------------------------------------------------
  assert 'retail.cashback' = any (app.approval_actions()), 'cash-back is a PIN gate';

  raise notice 'RETAIL & CLINIC EXPANSION: all assertions passed';
end $$;
