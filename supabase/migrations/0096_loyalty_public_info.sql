-- ---------------------------------------------------------------------------
-- 0096: what a guest may know about a store's loyalty program BEFORE they are
-- recognised — whether it exists and its rules (points rate, reward size).
-- Used by the sticky cart bar to show "+N points" while the cart fills.
-- Rules only: no customer data, and nothing is returned unless the owner has
-- switched the program on.
-- ---------------------------------------------------------------------------
create or replace function app.loyalty_public(p_org uuid)
returns table (out_cents_per_point int, out_reward_points int, out_reward_value_cents bigint)
language sql stable security definer set search_path = '' as $$
  select s.cents_per_point, s.reward_points, s.reward_value_cents
    from public.restaurant_loyalty_settings s
   where s.organization_id = p_org and s.enabled;
$$;
revoke all on function app.loyalty_public(uuid) from public, anon, authenticated;

create or replace function public.loyalty_public_info(p_org_slug text)
returns table (out_cents_per_point int, out_reward_points int, out_reward_value_cents bigint)
language sql stable security definer set search_path = '' as $$
  select l.out_cents_per_point, l.out_reward_points, l.out_reward_value_cents
    from public.organizations o
    cross join lateral app.loyalty_public(o.id) l
   where o.slug = p_org_slug and o.status = 'active' and o.deleted_at is null;
$$;

create or replace function public.loyalty_public_info_by_token(p_token text)
returns table (out_cents_per_point int, out_reward_points int, out_reward_value_cents bigint)
language sql stable security definer set search_path = '' as $$
  select l.out_cents_per_point, l.out_reward_points, l.out_reward_value_cents
    from public.public_links pl
    join public.organizations o on o.id = pl.organization_id
    cross join lateral app.loyalty_public(o.id) l
   where pl.token = p_token and pl.kind = 'menu' and pl.is_active and pl.revoked_at is null
     and (pl.expires_at is null or pl.expires_at > now())
     and o.status = 'active' and o.deleted_at is null;
$$;

revoke all on function public.loyalty_public_info(text) from public;
revoke all on function public.loyalty_public_info_by_token(text) from public;
grant execute on function public.loyalty_public_info(text) to anon, authenticated;
grant execute on function public.loyalty_public_info_by_token(text) to anon, authenticated;
