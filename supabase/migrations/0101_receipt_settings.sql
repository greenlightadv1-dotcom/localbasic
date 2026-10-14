-- ---------------------------------------------------------------------------
-- 0101: the store's official details printed on every receipt.
--
-- Two scopes, because a restaurant group has one legal identity but many
-- addresses:
--   restaurant_receipt_settings         one row per ORGANIZATION:
--       legal name, commercial registration no., tax registration no.,
--       a header note and a footer note
--   restaurant_branch_receipt_settings  one row per BRANCH:
--       the branch name as printed, its address and phone
--       (empty fields fall back to the branch's own name/address/phone)
--
-- ACCESS. Both tables have RLS forced and no policies, and no table privilege
-- for any client role: every read and write goes through the functions below.
--   * get / save   need settings.manage on the organization, and the branch
--                  must belong to that organization (a branch id from another
--                  store is "not found", never written to);
--   * header       the cashier's print path: needs invoice.read ON THAT BRANCH,
--                  so a cashier can print without being able to edit.
--
-- VALIDATION happens twice: friendly Arabic errors in the save function, and
-- CHECK constraints on the columns so no other path can store bad text. Text
-- is refused if it carries control characters (newlines only in the notes) or
-- Unicode bidi-override characters, which can make a printed receipt read
-- differently from what was typed. Escaping for HTML happens at render time
-- (src/lib/print/receipt-html.ts); nothing here is trusted as markup.
--
-- This is still a RECEIPT (إيصال), not a tax invoice: showing a tax ID does not
-- change that, and the receipt keeps its legal disclaimer.
-- ---------------------------------------------------------------------------

create or replace function app.receipt_text_ok(p_value text, p_max int, p_multiline boolean)
returns boolean language sql immutable set search_path = '' as $$
  select p_value is null or (
        length(p_value) <= p_max
    and (case when p_multiline then replace(p_value, E'\n', '') else p_value end) !~ '[[:cntrl:]]'
    and p_value !~ E'[‪-‮⁦-⁩]'
    and (not p_multiline or array_length(string_to_array(p_value, E'\n'), 1) <= 4)
  );
$$;

-- Registration and tax numbers: digits (Latin or Arabic-Indic), Latin letters,
-- spaces, dashes and slashes. Phone: digits, spaces, + - ( ).
create or replace function app.receipt_code_ok(p_value text)
returns boolean language sql immutable set search_path = '' as $$
  select p_value is null or p_value ~ '^[0-9٠-٩A-Za-z /-]{1,32}$';
$$;

create or replace function app.receipt_phone_ok(p_value text)
returns boolean language sql immutable set search_path = '' as $$
  select p_value is null or p_value ~ '^[0-9٠-٩+() -]{6,32}$';
$$;

create table public.restaurant_receipt_settings (
  organization_id          uuid primary key references public.organizations(id) on delete cascade,
  legal_name               text check (app.receipt_text_ok(legal_name, 120, false)),
  commercial_registration  text check (app.receipt_code_ok(commercial_registration)),
  tax_id                   text check (app.receipt_code_ok(tax_id)),
  header_note              text check (app.receipt_text_ok(header_note, 300, true)),
  footer_note              text check (app.receipt_text_ok(footer_note, 300, true)),
  updated_by               uuid references auth.users(id),
  updated_at               timestamptz not null default now()
);

create table public.restaurant_branch_receipt_settings (
  branch_id        uuid primary key references public.branches(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  display_name     text check (app.receipt_text_ok(display_name, 120, false)),
  address          text check (app.receipt_text_ok(address, 200, false)),
  phone            text check (app.receipt_phone_ok(phone)),
  updated_by       uuid references auth.users(id),
  updated_at       timestamptz not null default now()
);
create index restaurant_branch_receipt_settings_org_idx on public.restaurant_branch_receipt_settings(organization_id);

alter table public.restaurant_receipt_settings enable row level security;
alter table public.restaurant_receipt_settings force row level security;
alter table public.restaurant_branch_receipt_settings enable row level security;
alter table public.restaurant_branch_receipt_settings force row level security;
revoke all on public.restaurant_receipt_settings from public, anon, authenticated;
revoke all on public.restaurant_branch_receipt_settings from public, anon, authenticated;

-- The branch must belong to the organization; anything else is "not found".
create or replace function app.receipt_branch_check(p_org uuid, p_branch uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.branches b where b.id = p_branch and b.organization_id = p_org) then
    raise exception 'الفرع غير موجود' using errcode = 'check_violation';
  end if;
end;
$$;

create or replace function app.receipt_details(p_org uuid, p_branch uuid)
returns table (
  out_legal_name text, out_commercial_registration text, out_tax_id text,
  out_header_note text, out_footer_note text,
  out_branch_display_name text, out_branch_address text, out_branch_phone text,
  out_branch_name text, out_branch_default_address text, out_branch_default_phone text)
language sql stable security definer set search_path = '' as $$
  select s.legal_name, s.commercial_registration, s.tax_id, s.header_note, s.footer_note,
         bs.display_name, bs.address, bs.phone,
         b.name, b.address, b.phone
    from public.branches b
    left join public.restaurant_receipt_settings s on s.organization_id = b.organization_id
    left join public.restaurant_branch_receipt_settings bs on bs.branch_id = b.id
   where b.id = p_branch and b.organization_id = p_org;
$$;

-- Owner's form: read.
create or replace function public.restaurant_receipt_settings_get(p_org uuid, p_branch uuid)
returns table (
  out_legal_name text, out_commercial_registration text, out_tax_id text,
  out_header_note text, out_footer_note text,
  out_branch_display_name text, out_branch_address text, out_branch_phone text,
  out_branch_name text, out_branch_default_address text, out_branch_default_phone text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'settings.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  perform app.receipt_branch_check(p_org, p_branch);
  return query select * from app.receipt_details(p_org, p_branch);
end;
$$;

-- Owner's form: write. Empty strings mean "not set".
create or replace function public.restaurant_receipt_settings_save(
  p_org uuid, p_branch uuid,
  p_legal_name text, p_commercial_registration text, p_tax_id text,
  p_header_note text, p_footer_note text,
  p_branch_display_name text, p_branch_address text, p_branch_phone text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user   uuid := auth.uid();
  v_legal  text := nullif(trim(coalesce(p_legal_name, '')), '');
  v_cr     text := nullif(trim(coalesce(p_commercial_registration, '')), '');
  v_tax    text := nullif(trim(coalesce(p_tax_id, '')), '');
  v_header text := nullif(trim(replace(coalesce(p_header_note, ''), E'\r', '')), '');
  v_footer text := nullif(trim(replace(coalesce(p_footer_note, ''), E'\r', '')), '');
  v_bname  text := nullif(trim(coalesce(p_branch_display_name, '')), '');
  v_addr   text := nullif(trim(coalesce(p_branch_address, '')), '');
  v_phone  text := nullif(trim(coalesce(p_branch_phone, '')), '');
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_permission(p_org, 'settings.manage') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  perform app.receipt_branch_check(p_org, p_branch);

  if not app.receipt_text_ok(v_legal, 120, false) or not app.receipt_text_ok(v_bname, 120, false) then
    raise exception 'الاسم طويل جدًا أو يحتوي على رموز غير مسموحة' using errcode = '22023';
  end if;
  if not app.receipt_code_ok(v_cr) then
    raise exception 'رقم السجل التجاري غير صالح' using errcode = '22023';
  end if;
  if not app.receipt_code_ok(v_tax) then
    raise exception 'رقم التسجيل الضريبي غير صالح' using errcode = '22023';
  end if;
  if not app.receipt_text_ok(v_addr, 200, false) then
    raise exception 'العنوان طويل جدًا أو يحتوي على رموز غير مسموحة' using errcode = '22023';
  end if;
  if not app.receipt_phone_ok(v_phone) then
    raise exception 'رقم الهاتف غير صالح' using errcode = '22023';
  end if;
  if not app.receipt_text_ok(v_header, 300, true) or not app.receipt_text_ok(v_footer, 300, true) then
    raise exception 'الملاحظة تتجاوز 300 حرف أو 4 أسطر أو تحتوي على رموز غير مسموحة' using errcode = '22023';
  end if;

  insert into public.restaurant_receipt_settings
    (organization_id, legal_name, commercial_registration, tax_id, header_note, footer_note, updated_by, updated_at)
  values (p_org, v_legal, v_cr, v_tax, v_header, v_footer, v_user, now())
  on conflict (organization_id) do update
    set legal_name = excluded.legal_name, commercial_registration = excluded.commercial_registration,
        tax_id = excluded.tax_id, header_note = excluded.header_note, footer_note = excluded.footer_note,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at;

  insert into public.restaurant_branch_receipt_settings
    (branch_id, organization_id, display_name, address, phone, updated_by, updated_at)
  values (p_branch, p_org, v_bname, v_addr, v_phone, v_user, now())
  on conflict (branch_id) do update
    set display_name = excluded.display_name, address = excluded.address, phone = excluded.phone,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at;

  insert into public.audit_logs (organization_id, branch_id, actor_id, action, entity_type, entity_id, after)
  values (p_org, p_branch, v_user, 'restaurant.receipt_settings.updated', 'organization', p_org::text,
          jsonb_build_object('legal_name', v_legal, 'commercial_registration', v_cr, 'tax_id', v_tax,
                             'branch_display_name', v_bname, 'branch_address', v_addr, 'branch_phone', v_phone,
                             'has_header_note', v_header is not null, 'has_footer_note', v_footer is not null));
end;
$$;

-- The print path: anyone who may read invoices AT THIS BRANCH (cashiers).
create or replace function public.restaurant_receipt_header(p_org uuid, p_branch uuid)
returns table (
  out_legal_name text, out_commercial_registration text, out_tax_id text,
  out_header_note text, out_footer_note text,
  out_branch_display_name text, out_branch_address text, out_branch_phone text,
  out_branch_name text, out_branch_default_address text, out_branch_default_phone text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.has_branch_permission(p_org, p_branch, 'invoice.read') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return query select * from app.receipt_details(p_org, p_branch);
end;
$$;

-- Explicit, because Postgres grants EXECUTE on every new function to PUBLIC and
-- a per-schema ALTER DEFAULT PRIVILEGES (as tried in 0100) cannot take that
-- global default away. tests/33 fails if any app.* function is left callable
-- by anon. The validators stay callable by signed-in roles (harmless, pure).
revoke all on function app.receipt_text_ok(text, int, boolean) from public, anon;
revoke all on function app.receipt_code_ok(text) from public, anon;
revoke all on function app.receipt_phone_ok(text) from public, anon;
grant execute on function app.receipt_text_ok(text, int, boolean) to authenticated, service_role;
grant execute on function app.receipt_code_ok(text) to authenticated, service_role;
grant execute on function app.receipt_phone_ok(text) to authenticated, service_role;
revoke all on function app.receipt_branch_check(uuid, uuid) from public, anon, authenticated;
revoke all on function app.receipt_details(uuid, uuid) from public, anon, authenticated;
revoke all on function public.restaurant_receipt_settings_get(uuid, uuid) from public, anon;
revoke all on function public.restaurant_receipt_settings_save(uuid, uuid, text, text, text, text, text, text, text, text) from public, anon;
revoke all on function public.restaurant_receipt_header(uuid, uuid) from public, anon;
grant execute on function public.restaurant_receipt_settings_get(uuid, uuid) to authenticated;
grant execute on function public.restaurant_receipt_settings_save(uuid, uuid, text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.restaurant_receipt_header(uuid, uuid) to authenticated;
