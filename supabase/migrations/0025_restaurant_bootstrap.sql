-- =============================================================================
-- LOCAL BASIC — 0025 Restaurant bootstrap
--
-- Picked up by Core's module hook (0024) purely by name. A new restaurant
-- workspace arrives with a floor it can actually use: a dining area, six
-- tables, and a printable QR for each — so the owner can scan one within
-- seconds of signing up instead of configuring before seeing anything work.
-- =============================================================================

create or replace function app.bootstrap_restaurant(p_org uuid, p_branch uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_section uuid;
  v_table   uuid;
  v_link    uuid;
  i         int;
begin
  insert into public.settings (organization_id, branch_id, key, value)
  values (p_org, null, 'restaurant.public_ordering_enabled', 'true'::jsonb)
  on conflict do nothing;

  insert into public.restaurant_sections (organization_id, branch_id, name, sort_order)
  values (p_org, p_branch, 'الصالة', 0)
  returning id into v_section;

  for i in 1..6 loop
    insert into public.restaurant_tables
      (organization_id, branch_id, section_id, name, seats, status)
    values (p_org, p_branch, v_section, i::text, 4, 'available')
    returning id into v_table;

    insert into public.public_links
      (organization_id, branch_id, kind, token, target, label)
    values
      (p_org, p_branch, 'menu', app.new_public_token(),
       jsonb_build_object('entity_type', 'restaurant_table', 'entity_id', v_table),
       'طاولة ' || i::text)
    returning id into v_link;

    insert into public.qr_codes
      (organization_id, branch_id, public_link_id, label, entity_type, entity_id)
    values (p_org, p_branch, v_link, 'طاولة ' || i::text, 'restaurant_table', v_table);

    update public.restaurant_tables set public_link_id = v_link where id = v_table;
  end loop;
end;
$$;
