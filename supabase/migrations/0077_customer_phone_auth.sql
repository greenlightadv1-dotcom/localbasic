-- =============================================================================
-- LOCAL BASIC — 0077 Customer accounts: phone becomes the identity
--
-- Customer sign-up/sign-in moves from email+password to phone+password, with
-- the phone verified by an SMS OTP at sign-up (auth.users.phone is unique
-- platform-wide the same way auth.users.email already was — Supabase Auth
-- enforces it, nothing here has to). Email stays collectible, but only as an
-- optional contact detail — not an Auth identity, so attaching one never
-- triggers Supabase's own email-confirmation flow for an address nobody
-- will sign in with. It lives on `profiles`, read back here alongside
-- whatever an older, still-email-primary account already has on
-- auth.users.email (customer_account_profile prefers the profiles value,
-- falling back to the auth one, so neither kind of account loses its
-- address).
-- =============================================================================

alter table public.profiles add column if not exists email text;

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
           coalesce(p.email, u.email::text),
           coalesce(c.phone, p.phone, u.phone::text),
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

-- The parameter list grew by one (p_email); the old 3-arg overload is
-- dropped rather than left beside the new one, which would otherwise leave
-- two functions of the same name resolvable from three positional
-- arguments — an ambiguity, not a compatibility shim.
drop function if exists public.customer_account_save_profile(text, text, text);

create or replace function public.customer_account_save_profile(
  p_org_slug text, p_name text, p_phone text default null, p_email text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org      uuid;
  v_customer uuid;
  v_name     text := trim(coalesce(p_name, ''));
  v_phone    text := nullif(trim(coalesce(p_phone, '')), '');
  v_email    text := nullif(trim(coalesce(p_email, '')), '');
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
  if v_email is not null and length(v_email) > 200 then
    raise exception 'البريد الإلكتروني طويل جدًا' using errcode = '22023';
  end if;

  v_customer := app.customer_row_ensure(v_org, v_name, v_phone);

  -- The person's global profile: their name, number and optional email
  -- follow them across every restaurant they order from.
  update public.profiles
     set full_name = v_name,
         phone = coalesce(v_phone, phone),
         email = coalesce(v_email, email)
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

revoke all on function public.customer_account_save_profile(text, text, text, text) from public, anon;
grant execute on function public.customer_account_save_profile(text, text, text, text) to authenticated;
