-- =============================================================================
-- LOCAL BASIC — 0028 Harden function EXECUTE grants
-- =============================================================================
-- PostgreSQL grants EXECUTE on every new function to PUBLIC by default, so
-- `grant execute ... to authenticated` never removed anon's access. Each of
-- these already refuses an anonymous caller (auth.uid() is null, or the
-- permission check fails), so nothing was exploitable — but anon should not be
-- able to invoke a financial RPC at all.
--
-- Only the guest-facing token functions stay callable by anon.
-- =============================================================================

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.provision_workspace(text, text, text, text, text, char, text, text)',
    'public.is_org_slug_available(text)',
    'public.treasury_account_balance(uuid)',
    'public.retail_stock_of(uuid, uuid)',
    'public.retail_create_sale(uuid, uuid, jsonb, text, bigint, uuid, bigint, text)',
    'public.retail_create_return(uuid, uuid, uuid, jsonb, text, text)',
    'public.restaurant_create_order(uuid, uuid, jsonb, uuid, text, text, uuid, text)',
    'public.restaurant_set_order_status(uuid, uuid, text, text)',
    'public.restaurant_pay_order(uuid, uuid, text, bigint, bigint)',
    'public.restaurant_issue_table_link(uuid, uuid, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;

-- Guest-facing functions: reachable with an opaque token and no session. They
-- stay anon-callable by design; each one resolves the token itself and returns
-- nothing without a live link.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.resolve_public_link(text)',
    'public.restaurant_public_context(text)',
    'public.restaurant_public_menu(text)',
    'public.restaurant_public_order_status(text, text)',
    'public.restaurant_place_public_order(text, jsonb, text, text, text)'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to anon, authenticated', fn);
  end loop;
end;
$$;

-- Trigger function reached through table DML; pin its search_path like the rest.
alter function app.touch_updated_at() set search_path = '';
