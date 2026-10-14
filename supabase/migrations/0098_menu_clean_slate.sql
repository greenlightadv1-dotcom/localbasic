-- =============================================================================
-- 0098 — Clean slate for the menu
--
-- Products are soft-deleted (restaurant_products.deleted_at) and DELETE is
-- revoked from tenant roles on the menu tables, so there was no way to drop a
-- category or start a menu over. Both go through SECURITY DEFINER RPCs that
-- check restaurant.menu.manage and write an audit row. Past orders snapshot
-- product names and prices, so history is untouched.
-- =============================================================================

create or replace function public.restaurant_category_delete(p_org uuid, p_id uuid)
returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'restaurant.menu.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- Products in it stay (category_id is set null by the FK) and show as uncategorised.
  delete from public.restaurant_categories where organization_id = p_org and id = p_id;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
    values (p_org, auth.uid(), 'restaurant.category.delete', 'restaurant_category', p_id::text, '{}'::jsonb);
  end if;
  return v_n;
end;
$$;

create or replace function public.restaurant_menu_reset(p_org uuid, p_keep_categories boolean default false)
returns table (out_products_removed int, out_bundles_removed int, out_categories_removed int)
language plpgsql security definer set search_path = '' as $$
declare v_p int; v_b int; v_c int := 0;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'restaurant.menu.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  update public.restaurant_products
     set is_active = false, deleted_at = now()
   where organization_id = p_org and deleted_at is null;
  get diagnostics v_p = row_count;

  update public.restaurant_bundles
     set is_active = false, deleted_at = now()
   where organization_id = p_org and deleted_at is null;
  get diagnostics v_b = row_count;

  if not p_keep_categories then
    delete from public.restaurant_categories where organization_id = p_org;
    get diagnostics v_c = row_count;
  end if;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, auth.uid(), 'restaurant.menu.reset', 'organization', p_org::text,
          jsonb_build_object('products', v_p, 'bundles', v_b, 'categories', v_c,
                             'kept_categories', p_keep_categories));
  return query select v_p, v_b, v_c;
end;
$$;

revoke all on function public.restaurant_category_delete(uuid, uuid) from public, anon;
revoke all on function public.restaurant_menu_reset(uuid, boolean) from public, anon;
grant execute on function public.restaurant_category_delete(uuid, uuid) to authenticated;
grant execute on function public.restaurant_menu_reset(uuid, boolean) to authenticated;
