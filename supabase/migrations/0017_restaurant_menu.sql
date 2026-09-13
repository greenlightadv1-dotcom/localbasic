-- =============================================================================
-- LOCAL BASIC — 0017 Restaurant menu
-- categories, products, variants, modifier groups, modifiers
--
-- Menu content is organization-wide; availability is per branch, so one branch
-- can run out of a dish without hiding it everywhere. The QR keeps working
-- across every menu change because the link resolves the menu at scan time
-- rather than encoding it.
-- =============================================================================

create table public.restaurant_categories (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 120),
  description      text,
  image_url        text,
  sort_order       int not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id)
);
create index restaurant_categories_org_idx
  on public.restaurant_categories(organization_id, sort_order);
create trigger restaurant_categories_touch before update on public.restaurant_categories
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- products (menu items)
-- ---------------------------------------------------------------------------
create table public.restaurant_products (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  category_id      uuid references public.restaurant_categories(id) on delete set null,
  name             text not null check (length(trim(name)) between 1 and 200),
  description      text,
  image_url        text,
  tax_rate_bp      int not null default 0 check (tax_rate_bp between 0 and 10000),
  -- Minutes the kitchen typically needs; shown on the kitchen display.
  prep_minutes     int not null default 0 check (prep_minutes between 0 and 600),
  sort_order       int not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id),
  deleted_at       timestamptz
);
create index restaurant_products_org_idx
  on public.restaurant_products(organization_id, sort_order) where deleted_at is null;
create index restaurant_products_category_idx on public.restaurant_products(category_id);
create trigger restaurant_products_touch before update on public.restaurant_products
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- variants — the priced unit. A dish with no sizes gets one "default" variant,
-- so ordering, pricing and reporting have exactly one shape to handle.
-- ---------------------------------------------------------------------------
create table public.restaurant_variants (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  product_id       uuid not null references public.restaurant_products(id) on delete cascade,
  name             text not null default 'default',
  price_cents      bigint not null check (price_cents >= 0),
  sort_order       int not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index restaurant_variants_product_idx on public.restaurant_variants(product_id);
create trigger restaurant_variants_touch before update on public.restaurant_variants
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- modifier groups and modifiers (add-ons, options)
--
-- min_select / max_select drive both the customer UI and server-side
-- validation: a group with min 1 max 1 is a required choice (size, doneness),
-- min 0 max n is optional extras.
-- ---------------------------------------------------------------------------
create table public.restaurant_modifier_groups (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  product_id       uuid not null references public.restaurant_products(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 120),
  min_select       int not null default 0 check (min_select >= 0),
  max_select       int not null default 1 check (max_select >= 1),
  sort_order       int not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint modifier_group_range check (max_select >= min_select)
);
create index restaurant_modifier_groups_product_idx
  on public.restaurant_modifier_groups(product_id, sort_order);
create trigger restaurant_modifier_groups_touch before update
  on public.restaurant_modifier_groups
  for each row execute function app.touch_updated_at();

create table public.restaurant_modifiers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  group_id         uuid not null references public.restaurant_modifier_groups(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 120),
  -- Added to the line price. Zero for a free choice such as "no ice".
  price_cents      bigint not null default 0 check (price_cents >= 0),
  sort_order       int not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index restaurant_modifiers_group_idx
  on public.restaurant_modifiers(group_id, sort_order);
create trigger restaurant_modifiers_touch before update on public.restaurant_modifiers
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Per-branch availability.
--
-- Absence of a row means available: a new branch inherits the whole menu, and
-- only an explicit "86'd" row takes a dish off that branch's menu.
-- ---------------------------------------------------------------------------
create table public.restaurant_branch_availability (
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  variant_id       uuid not null references public.restaurant_variants(id) on delete cascade,
  is_available     boolean not null default true,
  unavailable_note text,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references public.profiles(id),
  primary key (branch_id, variant_id)
);
create index restaurant_availability_org_idx
  on public.restaurant_branch_availability(organization_id, branch_id);

-- ---------------------------------------------------------------------------
-- Tenancy guards for the menu tree.
-- ---------------------------------------------------------------------------
create or replace function app.check_menu_tenancy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if tg_table_name = 'restaurant_variants'
     or tg_table_name = 'restaurant_modifier_groups' then
    select organization_id into v_org
      from public.restaurant_products where id = new.product_id;
  elsif tg_table_name = 'restaurant_modifiers' then
    select organization_id into v_org
      from public.restaurant_modifier_groups where id = new.group_id;
  end if;

  if v_org is distinct from new.organization_id then
    raise exception '% row does not match its parent organization', tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger restaurant_variants_tenancy
  before insert or update on public.restaurant_variants
  for each row execute function app.check_menu_tenancy();
create trigger restaurant_modifier_groups_tenancy
  before insert or update on public.restaurant_modifier_groups
  for each row execute function app.check_menu_tenancy();
create trigger restaurant_modifiers_tenancy
  before insert or update on public.restaurant_modifiers
  for each row execute function app.check_menu_tenancy();
