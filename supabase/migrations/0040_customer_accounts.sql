-- =============================================================================
-- LOCAL BASIC — 0040 Customer accounts (D3)
--
-- An optional identity layer on top of the D1 ordering engine. Guests keep
-- ordering exactly as before; this adds nothing they must pass through.
--
-- The identity model, which every function below depends on:
--
--   auth.users          one global person, owned by Supabase Auth
--   public.profiles     their global profile (name, phone, locale)
--   public.customers    ONE ROW PER (person, organization)
--
-- The customer row is the tenant fence. The same person ordering from two
-- restaurants has two customer rows, and everything they accumulate —
-- orders, favourites, addresses — hangs off the row, never off the person.
-- Restaurant A therefore cannot express a query that reaches restaurant B's
-- data: there is no column to join on.
--
-- The browser never names an organization. Every function here takes the
-- public slug the customer is already looking at, resolves it through the
-- same gate D2 uses, and derives the customer row from auth.uid(). A forged
-- customer_id, user_id or organization_id has nowhere to enter.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Composite keys.
--
-- These exist so the tenant fence is a foreign key rather than a convention.
-- A favourite that points at another restaurant's product, or an address
-- filed under the wrong organization, is refused by the database itself —
-- no trigger, no policy, no application check involved.
-- ---------------------------------------------------------------------------
alter table public.customers
  add constraint customers_id_org_unique unique (id, organization_id);

alter table public.restaurant_products
  add constraint restaurant_products_id_org_unique unique (id, organization_id);

-- ---------------------------------------------------------------------------
-- 2. Customer preferences.
--
-- Two booleans on the existing customer row rather than a preferences engine.
--
-- HONESTY NOTE: no notification provider is connected. These record what the
-- customer wants; they do not promise delivery, and the UI says so.
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists marketing_opt_in     boolean not null default false,
  add column if not exists order_updates_opt_in boolean not null default true;

-- ---------------------------------------------------------------------------
-- 3. Saved delivery addresses.
--
-- SCOPE DECISION — these are organization-scoped, not global.
--
-- A global address book would mean one restaurant's checkout reading a row a
-- customer created at another restaurant, which is precisely the boundary the
-- rest of the system spends its effort enforcing. Scoping to the customer row
-- costs the customer one re-entry per restaurant and buys a model where
-- cross-tenant leakage is structurally impossible. For an MVP that is the
-- right trade.
--
-- No latitude/longitude: D3 adds no maps or GPS. The delivery row the kitchen
-- reads still carries those columns from D1 for a future stage.
-- ---------------------------------------------------------------------------
create table public.customer_addresses (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  customer_id      uuid not null references public.customers(id) on delete cascade,
  -- "البيت", "الشغل" — the customer's own word for the place.
  label            text not null check (length(trim(label)) between 1 and 60),
  recipient_name   text check (length(trim(recipient_name)) between 1 and 120),
  phone            text check (length(trim(phone)) between 6 and 32),
  city             text check (length(trim(city)) <= 120),
  area             text check (length(trim(area)) <= 120),
  address          text not null check (length(trim(address)) between 5 and 500),
  landmark         text check (length(trim(landmark)) <= 240),
  is_default       boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- The fence, as a key rather than a promise.
  constraint customer_addresses_customer_org_fk
    foreign key (customer_id, organization_id)
    references public.customers(id, organization_id) on delete cascade
);
create index customer_addresses_customer_idx
  on public.customer_addresses(customer_id, created_at desc);
-- At most one default per customer, enforced by the database rather than by
-- whichever code path happened to write last.
create unique index customer_addresses_one_default
  on public.customer_addresses(customer_id) where is_default;
create trigger customer_addresses_touch before update on public.customer_addresses
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Favourites.
--
-- A reference, never a copy: the product's name, price and availability are
-- read live from the menu, so a favourited product that is later withdrawn
-- simply stops appearing rather than leaving stale menu data behind.
-- ---------------------------------------------------------------------------
create table public.restaurant_customer_favorites (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  customer_id      uuid not null references public.customers(id) on delete cascade,
  product_id       uuid not null references public.restaurant_products(id) on delete cascade,
  created_at       timestamptz not null default now(),
  unique (customer_id, product_id),
  constraint restaurant_customer_favorites_customer_org_fk
    foreign key (customer_id, organization_id)
    references public.customers(id, organization_id) on delete cascade,
  -- The product must belong to the same restaurant as the customer row.
  constraint restaurant_customer_favorites_product_org_fk
    foreign key (product_id, organization_id)
    references public.restaurant_products(id, organization_id) on delete cascade
);
create index restaurant_customer_favorites_customer_idx
  on public.restaurant_customer_favorites(customer_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. RLS.
--
-- Enabled and forced, like every other table in `public`.
--
-- The policies are deliberately narrower than the application needs: they let
-- an authenticated person reach their OWN rows and nothing else. The account
-- pages do not rely on them — they go through the SECURITY DEFINER functions
-- below — so these are the second lock, not the first. There is no policy for
-- anon and no policy that mentions a permission, because neither staff nor the
-- public have any business in a customer's address book.
-- ---------------------------------------------------------------------------
alter table public.customer_addresses            enable row level security;
alter table public.restaurant_customer_favorites enable row level security;
alter table public.customer_addresses            force row level security;
alter table public.restaurant_customer_favorites force row level security;

-- Does this customer row belong to the caller? SECURITY DEFINER because
-- `customers` is itself behind RLS that only staff satisfy.
create or replace function app.customer_row_is_mine(p_customer uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.customers c
    where c.id = p_customer
      and c.user_id = auth.uid()
      and c.deleted_at is null
  ) and auth.uid() is not null;
$$;

revoke all on function app.customer_row_is_mine(uuid) from public, anon;
grant execute on function app.customer_row_is_mine(uuid) to authenticated;

create policy customer_addresses_own on public.customer_addresses
  for all to authenticated
  using (app.customer_row_is_mine(customer_id))
  with check (app.customer_row_is_mine(customer_id));

create policy restaurant_customer_favorites_own on public.restaurant_customer_favorites
  for all to authenticated
  using (app.customer_row_is_mine(customer_id))
  with check (app.customer_row_is_mine(customer_id));

-- Supabase's default grants are too generous to inherit; state them.
revoke all on public.customer_addresses            from anon;
revoke all on public.restaurant_customer_favorites from anon;
grant select, insert, update, delete on public.customer_addresses            to authenticated;
grant select, insert, delete         on public.restaurant_customer_favorites to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Resolving the caller's customer row.
--
-- `app.customer_row` reads; `app.customer_row_ensure` creates on first use.
-- Only ever called with an organization the caller has demonstrably reached
-- through a public slug — never with one they named.
-- ---------------------------------------------------------------------------
create or replace function app.customer_row(p_org uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select c.id from public.customers c
  where c.organization_id = p_org
    and c.user_id = auth.uid()
    and auth.uid() is not null
    and c.deleted_at is null
  limit 1;
$$;

create or replace function app.customer_row_ensure(
  p_org uuid, p_name text default null, p_phone text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_customer uuid;
  v_user     uuid := auth.uid();
  v_name     text;
  v_email    text;
begin
  if v_user is null then
    raise exception 'sign in required' using errcode = 'check_violation';
  end if;

  v_customer := app.customer_row(p_org);
  if v_customer is not null then
    return v_customer;
  end if;

  select coalesce(nullif(trim(coalesce(p_name, '')), ''), p.full_name, u.email, 'عميل'),
         u.email::text
    into v_name, v_email
  from auth.users u
  left join public.profiles p on p.id = u.id
  where u.id = v_user;

  -- The phone is written only when it is free. `customers` carries a unique
  -- index on (organization, phone), and a customer account must never be able
  -- to take over — or even detect — a walk-in record the restaurant created
  -- earlier with the same number. On collision the account simply keeps its
  -- phone on the profile instead.
  begin
    insert into public.customers (organization_id, name, phone, email, user_id)
    values (p_org, left(v_name, 160), nullif(trim(coalesce(p_phone, '')), ''),
            v_email, v_user)
    returning id into v_customer;
  exception when unique_violation then
    insert into public.customers (organization_id, name, phone, email, user_id)
    values (p_org, left(v_name, 160), null, v_email, v_user)
    returning id into v_customer;
  end;

  return v_customer;
end;
$$;

revoke all on function app.customer_row(uuid) from public, anon, authenticated;
revoke all on function app.customer_row_ensure(uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Profile and settings.
--
-- The email is read from auth.users for the caller's own id and is display
-- only. Changing it is an Auth operation, not a column write: overwriting
-- customers.email would change what the restaurant sees while leaving the
-- identity the person signs in with untouched, which is worse than refusing.
-- ---------------------------------------------------------------------------
create or replace function public.customer_account_profile(p_org_slug text)
returns table (
  full_name            text,
  email                text,
  phone                text,
  locale               text,
  marketing_opt_in     boolean,
  order_updates_opt_in boolean,
  has_account_here     boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_customer uuid;
begin
  if auth.uid() is null then
    return;
  end if;
  select w.org_id into v_org from app.restaurant_website_org(p_org_slug) w;
  if v_org is null then
    return;
  end if;

  v_customer := app.customer_row(v_org);

  return query
    select coalesce(c.name, p.full_name, ''),
           u.email::text,
           coalesce(c.phone, p.phone),
           p.locale,
           coalesce(c.marketing_opt_in, false),
           coalesce(c.order_updates_opt_in, true),
           v_customer is not null
    from auth.users u
    left join public.profiles p on p.id = u.id
    left join public.customers c on c.id = v_customer
    where u.id = auth.uid();
end;
$$;

create or replace function public.customer_account_save_profile(
  p_org_slug text, p_name text, p_phone text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_customer uuid;
  v_name     text := trim(coalesce(p_name, ''));
  v_phone    text := nullif(trim(coalesce(p_phone, '')), '');
begin
  if auth.uid() is null then
    raise exception 'sign in required' using errcode = 'check_violation';
  end if;
  select w.org_id into v_org from app.restaurant_website_org(p_org_slug) w;
  if v_org is null then
    raise exception 'restaurant not found' using errcode = 'check_violation';
  end if;
  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'الاسم مطلوب' using errcode = '22023';
  end if;
  if v_phone is not null and (length(v_phone) < 6 or length(v_phone) > 32) then
    raise exception 'رقم الهاتف غير صحيح' using errcode = '22023';
  end if;

  v_customer := app.customer_row_ensure(v_org, v_name, v_phone);

  -- The person's global profile: their name and number follow them.
  update public.profiles
     set full_name = v_name, phone = coalesce(v_phone, phone)
   where id = auth.uid();

  begin
    update public.customers
       set name = v_name, phone = coalesce(v_phone, phone)
     where id = v_customer;
  exception when unique_violation then
    -- Another record at this restaurant already holds that number; keep the
    -- name change and leave the phone where it was. See customer_row_ensure.
    update public.customers set name = v_name where id = v_customer;
  end;
end;
$$;

create or replace function public.customer_account_save_settings(
  p_org_slug text, p_marketing boolean, p_order_updates boolean
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_customer uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in required' using errcode = 'check_violation';
  end if;
  select w.org_id into v_org from app.restaurant_website_org(p_org_slug) w;
  if v_org is null then
    raise exception 'restaurant not found' using errcode = 'check_violation';
  end if;

  v_customer := app.customer_row_ensure(v_org);
  update public.customers
     set marketing_opt_in = coalesce(p_marketing, false),
         order_updates_opt_in = coalesce(p_order_updates, true)
   where id = v_customer;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Order history.
--
-- Scoped by customer_id, which is scoped by organization, so "only my orders"
-- and "only this restaurant's orders" are the same filter. The customer-facing
-- projection stops well short of the operational record: no ids, no staff
-- notes, no kitchen timings, no invoice or accounting fields.
-- ---------------------------------------------------------------------------
create or replace function public.customer_orders(p_org_slug text)
returns table (
  number           text,
  status           text,
  type             text,
  channel          text,
  branch_name      text,
  total_cents      bigint,
  currency         char(3),
  placed_at        timestamptz,
  item_count       numeric
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_customer uuid;
begin
  select w.org_id into v_org from app.restaurant_website_org(p_org_slug) w;
  if v_org is null then
    return;
  end if;
  v_customer := app.customer_row(v_org);
  if v_customer is null then
    return;
  end if;

  return query
    select o.number, o.status, o.type, o.channel, b.name,
           o.total_cents, o.currency, o.placed_at,
           (select coalesce(sum(i.quantity), 0)
              from public.restaurant_order_items i where i.order_id = o.id)
    from public.restaurant_orders o
    join public.branches b on b.id = o.branch_id
    where o.organization_id = v_org
      and o.customer_id = v_customer
    order by o.placed_at desc
    limit 100;
end;
$$;

-- The order itself, addressed by its human number within the customer's own
-- history. A number belonging to someone else — or to another restaurant —
-- matches nothing, so guessing one reveals only that it is not theirs.
create or replace function public.customer_order_detail(p_org_slug text, p_number text)
returns table (
  number            text,
  status            text,
  type              text,
  branch_name       text,
  subtotal_cents    bigint,
  discount_cents    bigint,
  tax_cents         bigint,
  delivery_fee_cents bigint,
  total_cents       bigint,
  currency          char(3),
  placed_at         timestamptz,
  delivery_address  text,
  delivery_city     text,
  delivery_area     text,
  delivery_landmark text
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_customer uuid;
begin
  select w.org_id into v_org from app.restaurant_website_org(p_org_slug) w;
  if v_org is null then
    return;
  end if;
  v_customer := app.customer_row(v_org);
  if v_customer is null then
    return;
  end if;

  return query
    select o.number, o.status, o.type, b.name,
           o.subtotal_cents, o.discount_cents, o.tax_cents,
           o.delivery_fee_cents, o.total_cents, o.currency, o.placed_at,
           d.address, d.city, d.area, d.landmark
    from public.restaurant_orders o
    join public.branches b on b.id = o.branch_id
    left join public.restaurant_order_deliveries d on d.order_id = o.id
    where o.organization_id = v_org
      and o.customer_id = v_customer
      and o.number = trim(p_number)
    limit 1;
end;
$$;

create or replace function public.customer_order_items(p_org_slug text, p_number text)
returns table (
  product_name     text,
  variant_name     text,
  quantity         numeric(10,3),
  line_total_cents bigint
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_customer uuid;
begin
  select w.org_id into v_org from app.restaurant_website_org(p_org_slug) w;
  if v_org is null then
    return;
  end if;
  v_customer := app.customer_row(v_org);
  if v_customer is null then
    return;
  end if;

  -- The item note is the customer's own request ("بدون بصل"), not a staff or
  -- kitchen note, and no operational column travels with it.
  return query
    select i.product_name, i.variant_name, i.quantity, i.line_total_cents
    from public.restaurant_order_items i
    join public.restaurant_orders o on o.id = i.order_id
    where o.organization_id = v_org
      and o.customer_id = v_customer
      and o.number = trim(p_number)
    order by i.position, i.created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Favourites.
-- ---------------------------------------------------------------------------
create or replace function public.customer_favorites(p_org_slug text)
returns table (
  product_id   uuid,
  product_name text,
  description  text,
  image_url    text,
  price_cents  bigint,
  currency     char(3),
  available    boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_customer uuid;
begin
  select w.org_id into v_org from app.restaurant_website_org(p_org_slug) w;
  if v_org is null then
    return;
  end if;
  v_customer := app.customer_row(v_org);
  if v_customer is null then
    return;
  end if;

  -- A product withdrawn from the menu drops out of the list rather than
  -- rendering as a broken card or, worse, exposing a deactivated item.
  return query
    select p.id, p.name, p.description, p.image_url,
           (select min(v.price_cents) from public.restaurant_variants v
             where v.product_id = p.id and v.is_active and v.deleted_at is null),
           o.currency,
           exists (select 1 from public.restaurant_variants v
                    where v.product_id = p.id and v.is_active and v.deleted_at is null)
    from public.restaurant_customer_favorites f
    join public.restaurant_products p on p.id = f.product_id
    join public.organizations o on o.id = f.organization_id
    where f.customer_id = v_customer
      and p.is_active and p.deleted_at is null
    order by f.created_at desc;
end;
$$;

create or replace function public.customer_favorite_add(p_org_slug text, p_product_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_customer uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in required' using errcode = 'check_violation';
  end if;
  select w.org_id into v_org from app.restaurant_website_org(p_org_slug) w;
  if v_org is null then
    raise exception 'restaurant not found' using errcode = 'check_violation';
  end if;

  -- The product is checked against the organization resolved from the slug,
  -- so a product id copied from another restaurant matches nothing. The
  -- composite foreign key would refuse it too; this returns a clean error
  -- instead of a constraint violation.
  if not exists (
    select 1 from public.restaurant_products p
    where p.id = p_product_id and p.organization_id = v_org
      and p.is_active and p.deleted_at is null
  ) then
    raise exception 'المنتج غير متاح' using errcode = 'check_violation';
  end if;

  v_customer := app.customer_row_ensure(v_org);

  insert into public.restaurant_customer_favorites (organization_id, customer_id, product_id)
  values (v_org, v_customer, p_product_id)
  on conflict (customer_id, product_id) do nothing;
end;
$$;

create or replace function public.customer_favorite_remove(p_org_slug text, p_product_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_customer uuid;
begin
  select w.org_id into v_org from app.restaurant_website_org(p_org_slug) w;
  if v_org is null then
    return;
  end if;
  v_customer := app.customer_row(v_org);
  if v_customer is null then
    return;
  end if;

  delete from public.restaurant_customer_favorites
   where customer_id = v_customer and product_id = p_product_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Saved addresses.
--
-- The id of an address is only ever accepted as a filter against the caller's
-- own customer row. An id belonging to another customer matches zero rows and
-- the statement is a no-op — it is never an error the caller can distinguish,
-- and never a row they can read.
-- ---------------------------------------------------------------------------
create or replace function public.customer_addresses_list(p_org_slug text)
returns table (
  id             uuid,
  label          text,
  recipient_name text,
  phone          text,
  city           text,
  area           text,
  address        text,
  landmark       text,
  is_default     boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_customer uuid;
begin
  select w.org_id into v_org from app.restaurant_website_org(p_org_slug) w;
  if v_org is null then
    return;
  end if;
  v_customer := app.customer_row(v_org);
  if v_customer is null then
    return;
  end if;

  return query
    select a.id, a.label, a.recipient_name, a.phone, a.city, a.area,
           a.address, a.landmark, a.is_default
    from public.customer_addresses a
    where a.customer_id = v_customer
    order by a.is_default desc, a.created_at desc;
end;
$$;

create or replace function public.customer_address_save(
  p_org_slug      text,
  p_label         text,
  p_address       text,
  p_id            uuid    default null,
  p_recipient_name text   default null,
  p_phone         text    default null,
  p_city          text    default null,
  p_area          text    default null,
  p_landmark      text    default null,
  p_is_default    boolean default false
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_customer uuid;
  v_id       uuid;
  v_count    int;
begin
  if auth.uid() is null then
    raise exception 'sign in required' using errcode = 'check_violation';
  end if;
  select w.org_id into v_org from app.restaurant_website_org(p_org_slug) w;
  if v_org is null then
    raise exception 'restaurant not found' using errcode = 'check_violation';
  end if;
  if length(trim(coalesce(p_label, ''))) < 1 then
    raise exception 'اسم العنوان مطلوب' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_address, ''))) < 5 then
    raise exception 'العنوان غير مكتمل' using errcode = '22023';
  end if;

  v_customer := app.customer_row_ensure(v_org);

  -- A modest ceiling. An address book is a convenience, not storage.
  select count(*) into v_count from public.customer_addresses where customer_id = v_customer;
  if p_id is null and v_count >= 10 then
    raise exception 'وصلت للحد الأقصى من العناوين المحفوظة' using errcode = 'check_violation';
  end if;

  if p_is_default then
    update public.customer_addresses set is_default = false
     where customer_id = v_customer and is_default;
  end if;

  if p_id is not null then
    update public.customer_addresses a
       set label = left(trim(p_label), 60),
           address = left(trim(p_address), 500),
           recipient_name = nullif(left(trim(coalesce(p_recipient_name, '')), 120), ''),
           phone = nullif(left(trim(coalesce(p_phone, '')), 32), ''),
           city = nullif(left(trim(coalesce(p_city, '')), 120), ''),
           area = nullif(left(trim(coalesce(p_area, '')), 120), ''),
           landmark = nullif(left(trim(coalesce(p_landmark, '')), 240), ''),
           is_default = coalesce(p_is_default, false)
     -- Ownership is the WHERE clause. An id from another customer updates
     -- nothing, whatever the caller believes they are editing.
     where a.id = p_id and a.customer_id = v_customer
    returning a.id into v_id;

    if v_id is null then
      raise exception 'العنوان غير موجود' using errcode = 'check_violation';
    end if;
    return v_id;
  end if;

  insert into public.customer_addresses
    (organization_id, customer_id, label, recipient_name, phone,
     city, area, address, landmark, is_default)
  values (
    v_org, v_customer, left(trim(p_label), 60),
    nullif(left(trim(coalesce(p_recipient_name, '')), 120), ''),
    nullif(left(trim(coalesce(p_phone, '')), 32), ''),
    nullif(left(trim(coalesce(p_city, '')), 120), ''),
    nullif(left(trim(coalesce(p_area, '')), 120), ''),
    left(trim(p_address), 500),
    nullif(left(trim(coalesce(p_landmark, '')), 240), ''),
    -- The first address a customer saves is their default.
    coalesce(p_is_default, false) or v_count = 0
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.customer_address_delete(p_org_slug text, p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_customer uuid;
begin
  select w.org_id into v_org from app.restaurant_website_org(p_org_slug) w;
  if v_org is null then
    return;
  end if;
  v_customer := app.customer_row(v_org);
  if v_customer is null then
    return;
  end if;

  delete from public.customer_addresses
   where id = p_id and customer_id = v_customer;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Checkout, with the account attached.
--
-- THIS IS THE SAME CHECKOUT. There is no second ordering path: the function
-- is dropped and recreated with one extra argument so that PostgREST sees one
-- signature rather than two overloads, and every line of pricing, validation,
-- idempotency and delivery handling below is D1's, unchanged.
--
-- What D3 adds is exactly two things:
--   * customer_id is filled in when the caller is signed in
--   * a saved address may be named, and is then read from the database
--
-- p_saved_address_id is an id from the browser, so it is treated as one: it
-- is a filter against the caller's own customer row, and the address fields
-- that reach the delivery record are the ones the database held, never the
-- ones the form posted alongside it.
-- ---------------------------------------------------------------------------
drop function if exists public.restaurant_place_online_order(
  text, text, jsonb, text, text, text, text, jsonb, text
);

create or replace function public.restaurant_place_online_order(
  p_org_slug        text,
  p_branch_slug     text,
  p_items           jsonb,
  p_fulfillment     text,
  p_customer_name   text,
  p_customer_phone  text,
  p_idempotency_key text,
  p_address         jsonb default null,
  p_note            text default null,
  p_saved_address_id uuid default null
)
returns table (out_token text, out_number text, out_total_cents bigint, out_edit_until timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v        record;
  v_order  uuid;
  v_number text;
  v_token  text;
  v_fee    bigint;
  v_open   int;
  v_existing uuid;
  v_customer uuid;
  -- Scalars rather than a record: an unassigned plpgsql record has no field
  -- structure, so `v_saved.id is null` would raise instead of being false on
  -- the overwhelmingly common path where no saved address was named.
  v_saved_id        uuid;
  v_saved_recipient text;
  v_saved_phone     text;
  v_saved_city      text;
  v_saved_area      text;
  v_saved_address   text;
  v_saved_landmark  text;
begin
  select * into v from app.restaurant_online_branch(p_org_slug, p_branch_slug);
  if v.org_id is null then
    raise exception 'storefront not found' using errcode = 'check_violation';
  end if;
  -- Branch-scoped, from D1.1. A caller reaching this function directly with
  -- ordering switched off for the branch is refused here.
  if not app.restaurant_online_enabled(v.org_id, v.branch_id) then
    raise exception 'online ordering is not enabled' using errcode = 'check_violation';
  end if;
  if p_fulfillment not in ('pickup', 'delivery') then
    raise exception 'invalid fulfilment type' using errcode = 'check_violation';
  end if;
  if not app.restaurant_fulfillment_enabled(v.org_id, v.branch_id, p_fulfillment) then
    raise exception 'this fulfilment option is not available' using errcode = 'check_violation';
  end if;
  if length(trim(coalesce(p_customer_name, ''))) < 2 then
    raise exception 'customer name is required' using errcode = 'check_violation';
  end if;
  if length(trim(coalesce(p_customer_phone, ''))) < 6 then
    raise exception 'customer phone is required' using errcode = 'check_violation';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 then
    raise exception 'an idempotency key is required' using errcode = 'check_violation';
  end if;

  -- Retry of a checkout we already accepted: hand back the original order
  -- rather than creating a second one. Checked before any write.
  select o.id into v_existing
    from public.restaurant_orders o
   where o.organization_id = v.org_id
     and o.idempotency_key = trim(p_idempotency_key);

  if v_existing is not null then
    return query
      select pl.token, o.number, o.total_cents, o.customer_edit_until
        from public.restaurant_orders o
        join public.public_links pl
          on pl.kind = 'order_status'
         and (pl.target ->> 'entity_id')::uuid = o.id
       where o.id = v_existing;
    return;
  end if;

  -- D3: the account, when there is one. A guest reaches here with auth.uid()
  -- null and nothing below changes for them.
  if auth.uid() is not null then
    v_customer := app.customer_row_ensure(v.org_id, p_customer_name, p_customer_phone);
  end if;

  -- D3: a saved address, read from the database under the caller's own id.
  if p_saved_address_id is not null then
    if v_customer is null then
      raise exception 'sign in required to use a saved address' using errcode = 'check_violation';
    end if;
    select a.id, a.recipient_name, a.phone, a.city, a.area, a.address, a.landmark
      into v_saved_id, v_saved_recipient, v_saved_phone, v_saved_city,
           v_saved_area, v_saved_address, v_saved_landmark
      from public.customer_addresses a
     where a.id = p_saved_address_id and a.customer_id = v_customer;
    if v_saved_id is null then
      raise exception 'العنوان غير موجود' using errcode = 'check_violation';
    end if;
  end if;

  if p_fulfillment = 'delivery' and p_address is null and v_saved_id is null then
    raise exception 'a delivery order needs an address' using errcode = 'check_violation';
  end if;

  -- Caps what one storefront can accumulate between rate-limit windows.
  select count(*) into v_open
    from public.restaurant_orders
   where organization_id = v.org_id and channel = 'online'
     and status = 'new' and placed_at > now() - interval '1 hour';
  if v_open >= 200 then
    raise exception 'too many open online orders' using errcode = 'check_violation';
  end if;

  v_fee := case when p_fulfillment = 'delivery'
                then app.restaurant_delivery_fee(v.org_id, v.branch_id) else 0 end;

  v_number := app.next_document_number(v.org_id, v.branch_id, 'restaurant_order');

  insert into public.restaurant_orders
    (organization_id, branch_id, number, channel, type, status,
     customer_id, guest_name, guest_phone, note, currency, delivery_fee_cents,
     idempotency_key, customer_edit_until, created_by)
  values
    (v.org_id, v.branch_id, v_number, 'online', p_fulfillment, 'new',
     v_customer,
     left(trim(p_customer_name), 120), left(trim(p_customer_phone), 32),
     nullif(left(trim(coalesce(p_note, '')), 500), ''),
     v.currency, v_fee, trim(p_idempotency_key),
     -- The window. now() is the transaction clock on the server; no caller can
     -- influence it, and the trigger from 0036 freezes it from here on.
     now() + interval '60 seconds',
     null)
  returning id into v_order;

  perform app.restaurant_build_order_lines(v.org_id, v.branch_id, v_order, p_items);

  if p_fulfillment = 'delivery' then
    insert into public.restaurant_order_deliveries
      (order_id, organization_id, branch_id, recipient_name, phone,
       city, area, address, landmark, latitude, longitude, notes)
    values (
      v_order, v.org_id, v.branch_id,
      left(trim(coalesce(v_saved_recipient, p_address ->> 'recipient_name', p_customer_name)), 120),
      left(trim(coalesce(v_saved_phone, p_address ->> 'phone', p_customer_phone)), 32),
      nullif(left(trim(coalesce(v_saved_city, p_address ->> 'city', '')), 120), ''),
      nullif(left(trim(coalesce(v_saved_area, p_address ->> 'area', '')), 120), ''),
      left(trim(coalesce(v_saved_address, p_address ->> 'address', '')), 500),
      nullif(left(trim(coalesce(v_saved_landmark, p_address ->> 'landmark', '')), 240), ''),
      (p_address ->> 'latitude')::numeric,
      (p_address ->> 'longitude')::numeric,
      nullif(left(trim(coalesce(p_address ->> 'notes', '')), 500), '')
    );
  end if;

  -- The guest's capability token. Opaque, single-purpose, revocable. An
  -- account holder gets one too: it is what the 60-second edit window runs on,
  -- and D3 does not change that mechanism.
  v_token := app.new_public_token();
  insert into public.public_links
    (organization_id, branch_id, kind, token, target, label, expires_at)
  values (
    v.org_id, v.branch_id, 'order_status', v_token,
    jsonb_build_object('entity_type', 'restaurant_order', 'entity_id', v_order),
    v_number, now() + interval '30 days'
  );

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  select v.org_id, v.branch_id, auth.uid(), 'restaurant.online_order.created',
         'restaurant_order', v_order::text,
         jsonb_build_object('number', v_number, 'channel', 'online',
                            'type', p_fulfillment, 'total_cents', o.total_cents,
                            'account', v_customer is not null)
    from public.restaurant_orders o where o.id = v_order;

  -- Notification seam. A pending row in the existing outbox; a later worker
  -- delivers it. Nothing here knows about WhatsApp, SMS or email.
  insert into public.notifications
    (organization_id, branch_id, recipient, channel, template, payload)
  values (
    v.org_id, v.branch_id, left(trim(p_customer_phone), 32), 'inapp',
    'restaurant.online_order.created',
    jsonb_build_object('order_number', v_number, 'fulfillment', p_fulfillment)
  );

  return query
    select v_token, o.number, o.total_cents, o.customer_edit_until
      from public.restaurant_orders o where o.id = v_order;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Attaching the order a guest just placed.
--
-- WHY THIS IS SAFE, AND WHAT IT DELIBERATELY IS NOT.
--
-- It is not a lookup by order number, phone or email. Those are things other
-- people know, and a claim mechanism built on them lets anyone who can guess
-- a number read a stranger's order history. There is no such function here.
--
-- The claim is authorised by the order-status token and nothing else: 24
-- CSPRNG bytes the server minted at checkout, bound to exactly one order,
-- which reached the customer only by being the URL in their own browser.
-- Whoever holds it can already read, edit and cancel that order under D1, so
-- attaching it to an account grants no authority they did not have.
--
-- On top of that possession proof:
--   * a 24-hour window — far shorter than the token's own 30-day life, so an
--     old tracking link found later cannot be turned into a claim
--   * consumed once — an order that already has a customer is refused, so the
--     same link cannot move an order between accounts
--   * verified — the order must be an online order of that same restaurant
--   * audited — the link is written to audit_logs with the actor
-- ---------------------------------------------------------------------------
create or replace function public.customer_claim_order(p_token text)
returns table (out_number text, out_org_slug text)
language plpgsql security definer set search_path = '' as $$
declare
  v_order    record;
  v_customer uuid;
  v_slug     text;
begin
  if auth.uid() is null then
    raise exception 'sign in required' using errcode = 'check_violation';
  end if;

  select o.id, o.organization_id, o.number, o.customer_id, o.channel,
         o.placed_at, o.branch_id, o.guest_name, o.guest_phone
    into v_order
  from public.public_links pl
  join public.restaurant_orders o
    on o.id = (pl.target ->> 'entity_id')::uuid
  where pl.token = p_token
    and pl.kind = 'order_status'
    and pl.is_active and pl.revoked_at is null
    and (pl.expires_at is null or pl.expires_at > now());

  -- One message for every failure: unknown token, expired window, already
  -- claimed. A caller probing tokens learns nothing from the difference.
  if v_order.id is null
     or v_order.channel <> 'online'
     or v_order.customer_id is not null
     or v_order.placed_at <= now() - interval '24 hours' then
    raise exception 'تعذّر ربط الطلب بالحساب' using errcode = 'check_violation';
  end if;

  v_customer := app.customer_row_ensure(
    v_order.organization_id, v_order.guest_name, v_order.guest_phone);

  update public.restaurant_orders
     set customer_id = v_customer
   where id = v_order.id and customer_id is null;

  if not found then
    raise exception 'تعذّر ربط الطلب بالحساب' using errcode = 'check_violation';
  end if;

  insert into public.audit_logs
    (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (
    v_order.organization_id, v_order.branch_id, auth.uid(),
    'restaurant.online_order.claimed', 'restaurant_order', v_order.id::text,
    jsonb_build_object('number', v_order.number, 'customer_id', v_customer)
  );

  select o.slug::text into v_slug
    from public.organizations o where o.id = v_order.organization_id;

  return query select v_order.number, v_slug;
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Grants.
--
-- Every function above is revoked from PUBLIC first, because Postgres grants
-- EXECUTE to PUBLIC on creation and a later `grant ... to authenticated` would
-- not take that away — the lesson of 0028.
--
-- The account functions are granted to `authenticated` only. anon holds none
-- of them: an anonymous caller has no account to read and must not be able to
-- probe for one. The checkout keeps its anon grant, because guest ordering is
-- the point.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.customer_account_profile(text)',
    'public.customer_account_save_profile(text, text, text)',
    'public.customer_account_save_settings(text, boolean, boolean)',
    'public.customer_orders(text)',
    'public.customer_order_detail(text, text)',
    'public.customer_order_items(text, text)',
    'public.customer_favorites(text)',
    'public.customer_favorite_add(text, uuid)',
    'public.customer_favorite_remove(text, uuid)',
    'public.customer_addresses_list(text)',
    'public.customer_address_save(text, text, text, uuid, text, text, text, text, text, boolean)',
    'public.customer_address_delete(text, uuid)',
    'public.customer_claim_order(text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

revoke all on function public.restaurant_place_online_order(
  text, text, jsonb, text, text, text, text, jsonb, text, uuid
) from public;
grant execute on function public.restaurant_place_online_order(
  text, text, jsonb, text, text, text, text, jsonb, text, uuid
) to anon, authenticated;
