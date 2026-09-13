-- =============================================================================
-- LOCAL BASIC — 0016 Restaurant layout
-- sections (areas) and tables, with a guarded table state machine
--
-- Core is reused throughout: the organization, branch, members, roles,
-- customers, invoices, payments, treasury, audit log, public links and QR
-- codes all come from Core. This migration adds only what a restaurant has
-- that Core does not: a floor plan.
-- =============================================================================

create table public.restaurant_sections (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 80),
  sort_order       int not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id)
);
create index restaurant_sections_branch_idx
  on public.restaurant_sections(organization_id, branch_id);
create trigger restaurant_sections_touch before update on public.restaurant_sections
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- tables
--
-- A table's public QR points at a Core public_link; the link's token is the
-- only identifier that ever reaches a customer. Reassigning a printed sticker
-- to another table is a change of which table the link targets, so nothing has
-- to be reprinted.
-- ---------------------------------------------------------------------------
create table public.restaurant_tables (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  branch_id        uuid not null references public.branches(id) on delete cascade,
  section_id       uuid references public.restaurant_sections(id) on delete set null,
  -- Shown to staff and printed on the QR card: "5", "A3", "شرفة 2".
  name             text not null check (length(trim(name)) between 1 and 40),
  seats            int not null default 4 check (seats between 1 and 100),
  status           text not null default 'available' check (status in (
    'available', 'occupied', 'waiting_payment', 'cleaning', 'reserved'
  )),
  -- The Core public link this table's QR resolves to.
  public_link_id   uuid references public.public_links(id) on delete set null,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references public.profiles(id),
  deleted_at       timestamptz,
  unique (branch_id, name)
);
create index restaurant_tables_branch_idx
  on public.restaurant_tables(organization_id, branch_id) where deleted_at is null;
create index restaurant_tables_section_idx on public.restaurant_tables(section_id);
create index restaurant_tables_status_idx
  on public.restaurant_tables(branch_id, status) where deleted_at is null;
create trigger restaurant_tables_touch before update on public.restaurant_tables
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Table state machine.
--
--   available       → occupied | reserved | cleaning
--   reserved        → occupied | available | cleaning
--   occupied        → waiting_payment | cleaning | available
--   waiting_payment → occupied | cleaning | available
--   cleaning        → available
--
-- Enforced in the database so no screen, action or future integration can put
-- a table into a state the floor cannot actually reach.
-- ---------------------------------------------------------------------------
create or replace function app.check_table_transition()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  allowed text[];
begin
  if new.status = old.status then
    return new;
  end if;

  allowed := case old.status
    when 'available'       then array['occupied','reserved','cleaning']
    when 'reserved'        then array['occupied','available','cleaning']
    when 'occupied'        then array['waiting_payment','cleaning','available']
    when 'waiting_payment' then array['occupied','cleaning','available']
    when 'cleaning'        then array['available']
    else array[]::text[]
  end;

  if not (new.status = any(allowed)) then
    raise exception 'invalid table transition % → %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger restaurant_tables_transition
  before update of status on public.restaurant_tables
  for each row execute function app.check_table_transition();

-- ---------------------------------------------------------------------------
-- Tenancy guards: a table's section and branch must belong to its own
-- organization, and the section must be in the same branch as the table.
-- ---------------------------------------------------------------------------
create or replace function app.check_table_tenancy()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_branch_org uuid;
  v_section_branch uuid;
begin
  select organization_id into v_branch_org
    from public.branches where id = new.branch_id;
  if v_branch_org is distinct from new.organization_id then
    raise exception 'table branch does not belong to the organization'
      using errcode = 'check_violation';
  end if;

  if new.section_id is not null then
    select branch_id into v_section_branch
      from public.restaurant_sections where id = new.section_id;
    if v_section_branch is distinct from new.branch_id then
      raise exception 'section belongs to a different branch'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger restaurant_tables_tenancy
  before insert or update on public.restaurant_tables
  for each row execute function app.check_table_tenancy();
