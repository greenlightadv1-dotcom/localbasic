-- =============================================================================
-- LOCAL BASIC — 0011 Retail catalog
-- categories, products, variants, suppliers
--
-- Vertical tables are prefixed and additive. Nothing here duplicates a Core
-- concept: customers, invoices, payments and treasury all stay in Core and are
-- used by the retail services.
-- =============================================================================

create table public.retail_categories (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  parent_id        uuid references public.retail_categories(id) on delete set null,
  name             text not null check (length(trim(name)) between 1 and 120),
  sort_order       int not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id)
);
create index retail_categories_org_idx on public.retail_categories(organization_id);
create trigger retail_categories_touch before update on public.retail_categories
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- suppliers
-- ---------------------------------------------------------------------------
create table public.retail_suppliers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 160),
  phone            text,
  email            citext,
  address          text,
  tax_id           text,
  notes            text,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id)
);
create index retail_suppliers_org_idx on public.retail_suppliers(organization_id);
create trigger retail_suppliers_touch before update on public.retail_suppliers
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- products — the catalog entry. A product always has at least one variant;
-- a product with no options gets a single "default" variant, so pricing,
-- stock and sales have exactly one shape to deal with everywhere.
-- ---------------------------------------------------------------------------
create table public.retail_products (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  category_id      uuid references public.retail_categories(id) on delete set null,
  name             text not null check (length(trim(name)) between 1 and 200),
  description      text,
  image_url        text,
  -- Sold by the piece, or by weight/length (allows fractional quantities).
  unit             text not null default 'piece'
                   check (unit in ('piece','kg','gram','litre','metre','box','pack')),
  tax_rate_bp      int not null default 0 check (tax_rate_bp between 0 and 10000),
  is_active        boolean not null default true,
  -- Whether the online storefront may show it. POS availability is separate,
  -- so a shop can sell something in store without listing it publicly.
  is_online        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id),
  deleted_at       timestamptz
);
create index retail_products_org_idx
  on public.retail_products(organization_id) where deleted_at is null;
create index retail_products_category_idx on public.retail_products(category_id);
-- Trigram-free prefix search on name, good enough for the POS search box.
create index retail_products_name_idx on public.retail_products(organization_id, name);
create trigger retail_products_touch before update on public.retail_products
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- variants — what actually carries SKU, barcode, price and stock
-- ---------------------------------------------------------------------------
create table public.retail_variants (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  product_id       uuid not null references public.retail_products(id) on delete cascade,
  name             text not null default 'default',
  sku              text,
  barcode          text,
  -- Selling price and cost, both in minor units. The client never supplies
  -- either: the POS and the storefront read them back from here at sale time.
  price_cents      bigint not null check (price_cents >= 0),
  cost_cents       bigint not null default 0 check (cost_cents >= 0),
  -- Attributes such as {"size":"L","color":"أحمر"}
  options          jsonb not null default '{}'::jsonb,
  -- Warn when stock falls to or below this level.
  reorder_point    numeric(14,3) not null default 0 check (reorder_point >= 0),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
-- SKU and barcode are unique per organization, not globally: two tenants may
-- legitimately use the same barcode for the same physical product.
create unique index retail_variants_sku_unique
  on public.retail_variants(organization_id, sku)
  where sku is not null and deleted_at is null;
create unique index retail_variants_barcode_unique
  on public.retail_variants(organization_id, barcode)
  where barcode is not null and deleted_at is null;
create index retail_variants_product_idx on public.retail_variants(product_id);
create trigger retail_variants_touch before update on public.retail_variants
  for each row execute function app.touch_updated_at();

-- A variant must belong to the same organization as its product.
create or replace function app.check_variant_tenancy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.retail_products where id = new.product_id;
  if v_org is distinct from new.organization_id then
    raise exception 'variant organization does not match its product'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger retail_variants_tenancy_check
  before insert or update on public.retail_variants
  for each row execute function app.check_variant_tenancy();
