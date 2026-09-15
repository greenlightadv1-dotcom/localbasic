-- =============================================================================
-- LOCAL BASIC — 0033 Platform leads + service catalog
--
-- Two platform-operator concerns that had no home yet:
--   * leads: who asked about the product, and where that conversation got to.
--     Operational, not a CRM — enough to run a sales follow-up, no more.
--   * services: the vertical catalog. organization_modules already records
--     which verticals an organization has enabled; what was missing is the
--     platform's own list of which verticals may be SOLD, independent of the
--     ones already provisioned.
--
-- Neither is tenant data. Both are invisible to every tenant user.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- platform_services — the sellable catalog.
--
-- Deliberately keyed by the same module_key vocabulary organization_modules
-- uses, so provisioning checks one list and the bootstrap hook keeps working
-- by convention. A row here does NOT create a vertical; it records whether an
-- already-built one may be sold.
-- ---------------------------------------------------------------------------
create table public.platform_services (
  module_key       text primary key
                   check (module_key in ('retail','restaurant','medical','workshop')),
  name_ar          text not null,
  name_en          text not null,
  description_ar   text,
  -- Built and working, as opposed to merely named in the enum above.
  is_built         boolean not null default false,
  -- May be chosen when provisioning a NEW workspace. Turning this off never
  -- touches organizations already running the service.
  is_available     boolean not null default false,
  sort_order       int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger platform_services_touch before update on public.platform_services
  for each row execute function app.touch_updated_at();

-- Restaurant is the only built, sellable service. The other three are listed
-- because the module_key vocabulary already names them — is_built = false says
-- plainly that they do not exist yet, rather than implying a roadmap.
insert into public.platform_services
  (module_key, name_ar, name_en, description_ar, is_built, is_available, sort_order)
values
  ('restaurant', 'مطاعم وكافيهات', 'Restaurants & Cafes',
   'نقطة بيع، مطبخ، صالة، منيو QR، خزينة وتقارير.', true, true, 0),
  ('retail',    'تجزئة',  'Retail',   null, false, false, 1),
  ('medical',   'عيادات', 'Medical',  null, false, false, 2),
  ('workshop',  'ورش',    'Workshop', null, false, false, 3)
on conflict (module_key) do nothing;

-- ---------------------------------------------------------------------------
-- platform_leads — sales pipeline.
-- ---------------------------------------------------------------------------
create table public.platform_leads (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(trim(name)) between 2 and 120),
  phone          text not null check (length(trim(phone)) between 6 and 32),
  business_name  text check (length(trim(business_name)) <= 160),
  -- Which vertical they asked about. References the catalog above so a lead
  -- cannot name a service the platform does not have.
  requested_service text references public.platform_services(module_key),
  source         text not null default 'website'
                 check (source in ('website','whatsapp','referral','call','walk_in','other')),
  status         text not null default 'new'
                 check (status in ('new','contacted','qualified','won','lost')),
  notes          text check (length(notes) <= 4000),
  -- Set when a lead becomes a customer, so the pipeline links to the workspace.
  organization_id uuid references public.organizations(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index platform_leads_status_idx on public.platform_leads(status, created_at desc);
create index platform_leads_phone_idx  on public.platform_leads(phone);
create trigger platform_leads_touch before update on public.platform_leads
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS. Platform-operator tables: an admin sees them, nobody else does.
-- ---------------------------------------------------------------------------
alter table public.platform_services enable row level security;
alter table public.platform_services force  row level security;
alter table public.platform_leads    enable row level security;
alter table public.platform_leads    force  row level security;

create policy platform_services_read on public.platform_services
  for select to authenticated using (app.is_platform_admin());
create policy platform_services_update on public.platform_services
  for update to authenticated
  using (app.is_platform_admin()) with check (app.is_platform_admin());

create policy platform_leads_read on public.platform_leads
  for select to authenticated using (app.is_platform_admin());
create policy platform_leads_insert on public.platform_leads
  for insert to authenticated with check (app.is_platform_admin());
create policy platform_leads_update on public.platform_leads
  for update to authenticated
  using (app.is_platform_admin()) with check (app.is_platform_admin());

-- ---------------------------------------------------------------------------
-- Grants.
--
-- No INSERT on platform_services: the catalog mirrors what is actually built,
-- so adding a row is a migration, not an admin action. No DELETE anywhere —
-- a finished lead is 'won' or 'lost', never erased.
-- ---------------------------------------------------------------------------
revoke all on public.platform_services from anon, authenticated;
revoke all on public.platform_leads    from anon, authenticated;
grant select, update         on public.platform_services to authenticated;
grant select, insert, update on public.platform_leads    to authenticated;

-- ---------------------------------------------------------------------------
-- Public lead capture.
--
-- The marketing site has no session, so anon needs a way in — but anon holds
-- no privilege on the table. This SECURITY DEFINER function is the only door:
-- it writes exactly the columns a stranger may set, forces status and source,
-- and returns nothing. There is no anonymous read path.
-- ---------------------------------------------------------------------------
create or replace function public.submit_public_lead(
  p_name          text,
  p_phone         text,
  p_business_name text default null,
  p_service       text default 'restaurant'
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'name is required' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_phone, ''))) < 6 then
    raise exception 'phone is required' using errcode = '22023';
  end if;

  -- A stranger may only ask about a service that is actually on sale.
  if not exists (
    select 1 from public.platform_services s
     where s.module_key = p_service and s.is_available
  ) then
    raise exception 'unknown service' using errcode = '22023';
  end if;

  insert into public.platform_leads (name, phone, business_name, requested_service, source, status)
  values (
    left(trim(p_name), 120),
    left(trim(p_phone), 32),
    nullif(left(trim(coalesce(p_business_name, '')), 160), ''),
    p_service,
    'website',
    'new'
  );
end;
$$;

revoke all on function public.submit_public_lead(text, text, text, text) from public;
grant execute on function public.submit_public_lead(text, text, text, text) to anon, authenticated;
