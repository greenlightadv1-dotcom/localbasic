-- =============================================================================
-- LOCAL BASIC — receipt settings (0101): access, validation, tenant isolation
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_a uuid; org_a uuid; br_a uuid; br_a2 uuid;
  u_b uuid; org_b uuid; br_b uuid;
  u_cash uuid; m uuid; r_role uuid;
  r record; refused boolean; bad text; n int;
begin
  insert into auth.users (email) values ('rc34a@test.local') returning id into u_a;
  insert into auth.users (email) values ('rc34b@test.local') returning id into u_b;
  insert into auth.users (email) values ('rc34c@test.local') returning id into u_cash;
  perform auth.login_as(u_a);
  select out_organization_id, out_branch_id into org_a, br_a from public.provision_workspace('RC34 Alpha', 'rc34alpha', 'restaurant');
  perform auth.login_as(u_b);
  select out_organization_id, out_branch_id into org_b, br_b from public.provision_workspace('RC34 Beta', 'rc34beta', 'restaurant');
  perform auth.as_admin();
  insert into public.branches (organization_id, slug, name, address, phone)
  values (org_a, 'second', 'فرع المعادي', '9 شارع 9، المعادي', '0225550000') returning id into br_a2;

  -- A cashier at Alpha's second branch only.
  insert into public.organization_members (organization_id, user_id, status, all_branches, joined_at)
  values (org_a, u_cash, 'active', false, now()) returning id into m;
  insert into public.member_branches (member_id, branch_id) values (m, br_a2);
  select id into r_role from public.roles where organization_id = org_a and key = 'cashier';
  insert into public.user_roles (member_id, role_id, branch_id) values (m, r_role, br_a2);

  -- ---- owner: empty, save, read back -------------------------------------
  perform auth.login_as(u_a);
  select * into r from public.restaurant_receipt_settings_get(org_a, br_a2);
  assert r.out_legal_name is null and r.out_branch_name = 'فرع المعادي'
     and r.out_branch_default_address = '9 شارع 9، المعادي', 'defaults come from the branch';

  perform public.restaurant_receipt_settings_save(org_a, br_a2,
    '  شركة ألفا للمطاعم  ', '12345', '123-456-789',
    E'أهلًا بكم\r\nمفتوح يوميًا', 'شكرًا لزيارتكم', 'ألفا - المعادي', 'المعادي، القاهرة', '+20 2 2555 0000');
  select * into r from public.restaurant_receipt_settings_get(org_a, br_a2);
  assert r.out_legal_name = 'شركة ألفا للمطاعم', 'trimmed legal name';
  assert r.out_commercial_registration = '12345' and r.out_tax_id = '123-456-789', 'numbers saved';
  assert r.out_header_note = E'أهلًا بكم\nمفتوح يوميًا', 'CR stripped, newline kept';
  assert r.out_branch_display_name = 'ألفا - المعادي' and r.out_branch_phone = '+20 2 2555 0000', 'branch fields';

  -- Branch fields are per branch: the main branch has none of them.
  select * into r from public.restaurant_receipt_settings_get(org_a, br_a);
  assert r.out_branch_display_name is null and r.out_legal_name = 'شركة ألفا للمطاعم', 'org fields shared, branch fields not';

  -- Empty strings clear a field.
  perform public.restaurant_receipt_settings_save(org_a, br_a, 'شركة ألفا للمطاعم', '', '', '', '', '', '', '');
  select * into r from public.restaurant_receipt_settings_get(org_a, br_a);
  assert r.out_tax_id is null and r.out_commercial_registration is null, 'cleared';

  select count(*) into n from public.audit_logs where organization_id = org_a and action = 'restaurant.receipt_settings.updated';
  assert n = 2, format('every save audited, got %s', n);

  -- ---- validation: each bad value is refused ------------------------------
  foreach bad in array array[
    format('select public.restaurant_receipt_settings_save(%L, %L, %L, null, null, null, null, null, null, null)', org_a, br_a, repeat('x', 121)),
    format('select public.restaurant_receipt_settings_save(%L, %L, %L, null, null, null, null, null, null, null)', org_a, br_a, E'line\nbreak'),
    format('select public.restaurant_receipt_settings_save(%L, %L, %L, null, null, null, null, null, null, null)', org_a, br_a, E'abc\u202Edcba'),
    format('select public.restaurant_receipt_settings_save(%L, %L, null, %L, null, null, null, null, null, null)', org_a, br_a, '<script>'),
    format('select public.restaurant_receipt_settings_save(%L, %L, null, null, %L, null, null, null, null, null)', org_a, br_a, '123;drop'),
    format('select public.restaurant_receipt_settings_save(%L, %L, null, null, null, %L, null, null, null, null)', org_a, br_a, E'1\n2\n3\n4\n5'),
    format('select public.restaurant_receipt_settings_save(%L, %L, null, null, null, null, %L, null, null, null)', org_a, br_a, repeat('y', 301)),
    format('select public.restaurant_receipt_settings_save(%L, %L, null, null, null, null, %L, null, null, null)', org_a, br_a, E'tab\there'),
    format('select public.restaurant_receipt_settings_save(%L, %L, null, null, null, null, null, null, null, %L)', org_a, br_a, '0100 <b>'),
    format('select public.restaurant_receipt_settings_save(%L, %L, null, null, null, null, null, null, %L, null)', org_a, br_a, repeat('z', 201))
  ] loop
    refused := false;
    begin execute bad;
    exception when sqlstate '22023' then refused := true; end;
    assert refused, format('must be refused: %s', left(bad, 160));
  end loop;

  -- The column constraints hold even for a direct write (as the table owner).
  perform auth.as_admin();
  refused := false;
  begin update public.restaurant_receipt_settings set tax_id = '<img src=x>' where organization_id = org_a;
  exception when check_violation then refused := true; end;
  assert refused, 'CHECK constraint refuses bad text on any path';

  -- ---- tenant isolation ---------------------------------------------------
  -- Owner A naming Beta's branch under Alpha's org: not found, nothing written.
  perform auth.login_as(u_a);
  refused := false;
  begin perform public.restaurant_receipt_settings_save(org_a, br_b, 'x', null, null, null, null, 'hijack', null, null);
  exception when check_violation then refused := true; end;
  assert refused, 'a branch of another store must be refused';
  refused := false;
  begin perform * from public.restaurant_receipt_settings_get(org_a, br_b);
  exception when check_violation then refused := true; end;
  assert refused, 'reading another store''s branch must be refused';

  -- Owner B cannot read or write Alpha at all.
  perform auth.login_as(u_b);
  foreach bad in array array[
    format('select * from public.restaurant_receipt_settings_get(%L, %L)', org_a, br_a),
    format('select public.restaurant_receipt_settings_save(%L, %L, %L, null, null, null, null, null, null, null)', org_a, br_a, 'stolen'),
    format('select * from public.restaurant_receipt_header(%L, %L)', org_a, br_a)
  ] loop
    refused := false;
    begin execute bad;
    exception when insufficient_privilege then refused := true; end;
    assert refused, format('outsider must be refused: %s', left(bad, 120));
  end loop;

  -- ---- the cashier: may print at their branch, may not edit or read elsewhere
  perform auth.login_as(u_cash);
  select * into r from public.restaurant_receipt_header(org_a, br_a2);
  assert r.out_legal_name = 'شركة ألفا للمطاعم' and r.out_branch_display_name = 'ألفا - المعادي', 'cashier reads header for own branch';
  foreach bad in array array[
    format('select * from public.restaurant_receipt_header(%L, %L)', org_a, br_a),
    format('select * from public.restaurant_receipt_settings_get(%L, %L)', org_a, br_a2),
    format('select public.restaurant_receipt_settings_save(%L, %L, %L, null, null, null, null, null, null, null)', org_a, br_a2, 'changed')
  ] loop
    refused := false;
    begin execute bad;
    exception when insufficient_privilege then refused := true; end;
    assert refused, format('cashier must be refused: %s', left(bad, 120));
  end loop;

  -- ---- anonymous: nothing -------------------------------------------------
  perform auth.logout();
  foreach bad in array array[
    'select 1 from public.restaurant_receipt_settings',
    'select 1 from public.restaurant_branch_receipt_settings',
    format('select * from public.restaurant_receipt_header(%L, %L)', org_a, br_a),
    format('select * from public.restaurant_receipt_settings_get(%L, %L)', org_a, br_a)
  ] loop
    refused := false;
    begin execute bad;
    exception when insufficient_privilege then refused := true; end;
    assert refused, format('anon must be refused: %s', bad);
  end loop;

  perform auth.as_admin();
  -- Nothing leaked into Beta.
  assert not exists (select 1 from public.restaurant_receipt_settings where organization_id = org_b), 'beta untouched';
  assert not exists (select 1 from public.restaurant_branch_receipt_settings where branch_id = br_b), 'beta branch untouched';
  raise notice 'receipt settings OK';
end $$;
