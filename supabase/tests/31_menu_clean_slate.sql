-- =============================================================================
-- LOCAL BASIC — menu clean slate (0098)
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u_a uuid; org_a uuid; u_b uuid; org_b uuid;
  c1 uuid; c2 uuid; cb uuid; r record; n int; refused boolean;
begin
  insert into auth.users (email) values ('m31a@test.local') returning id into u_a;
  insert into auth.users (email) values ('m31b@test.local') returning id into u_b;
  perform auth.login_as(u_a);
  select out_organization_id into org_a from public.provision_workspace('M31 Alpha', 'm31alpha', 'restaurant');
  perform auth.login_as(u_b);
  select out_organization_id into org_b from public.provision_workspace('M31 Beta', 'm31beta', 'restaurant');
  perform auth.as_admin();

  insert into public.restaurant_categories (organization_id, name) values (org_a, 'ساخن') returning id into c1;
  insert into public.restaurant_categories (organization_id, name) values (org_a, 'بارد') returning id into c2;
  insert into public.restaurant_categories (organization_id, name) values (org_b, 'غريب') returning id into cb;
  insert into public.restaurant_products (organization_id, category_id, name) values
    (org_a, c1, 'قهوة'), (org_a, c2, 'عصير'), (org_b, cb, 'منتج الغير');

  -- Another tenant cannot touch it.
  perform auth.login_as(u_b);
  refused := false;
  begin perform public.restaurant_category_delete(org_a, c1);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'cross-tenant category delete must be refused';
  refused := false;
  begin perform public.restaurant_menu_reset(org_a);
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'cross-tenant menu reset must be refused';

  -- Deleting one category leaves its products, uncategorised.
  perform auth.login_as(u_a);
  assert public.restaurant_category_delete(org_a, c1) = 1, 'category deleted';
  perform auth.as_admin();
  select count(*) into n from public.restaurant_products where organization_id = org_a and deleted_at is null and category_id is null;
  assert n = 1, 'product kept, uncategorised';

  -- Reset keeps categories on request.
  perform auth.login_as(u_a);
  select * into r from public.restaurant_menu_reset(org_a, true);
  assert r.out_products_removed = 2 and r.out_categories_removed = 0, 'reset keeping categories';
  select * into r from public.restaurant_menu_reset(org_a);
  assert r.out_products_removed = 0 and r.out_categories_removed = 1, 'second reset drops remaining category';

  perform auth.as_admin();
  select count(*) into n from public.restaurant_products where organization_id = org_a and deleted_at is null;
  assert n = 0, 'no live products';
  select count(*) into n from public.restaurant_products where organization_id = org_b and deleted_at is null;
  assert n = 1, 'other tenant untouched';
  select count(*) into n from public.restaurant_categories where organization_id = org_b;
  assert n = 1, 'other tenant category untouched';
  select count(*) into n from public.audit_logs where organization_id = org_a and action in ('restaurant.menu.reset', 'restaurant.category.delete');
  assert n = 3, format('audit rows, got %s', n);

  raise notice 'menu clean slate OK';
end $$;
