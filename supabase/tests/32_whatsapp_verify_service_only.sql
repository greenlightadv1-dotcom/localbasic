-- =============================================================================
-- LOCAL BASIC — the WhatsApp verification function is service-role only (0099)
-- =============================================================================
\set ON_ERROR_STOP on

do $$
declare
  u uuid; refused boolean; r record;
begin
  insert into auth.users (email) values ('w32@test.local') returning id into u;

  -- anon (the public key) must be refused.
  perform auth.logout();
  refused := false;
  begin
    perform * from public.restaurant_whatsapp_verify_webhook('MAIN', '123456', '01012345678');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'anon must not execute restaurant_whatsapp_verify_webhook';

  -- a signed-in user must be refused too.
  perform auth.login_as(u);
  refused := false;
  begin
    perform * from public.restaurant_whatsapp_verify_webhook('MAIN', '123456', '01012345678');
  exception when insufficient_privilege then refused := true; end;
  assert refused, 'authenticated must not execute restaurant_whatsapp_verify_webhook';

  -- the trusted server role still can; an unknown code simply does not match.
  perform auth.as_service_role();
  select * into r from public.restaurant_whatsapp_verify_webhook('MAIN', '123456', '01012345678');
  assert r.out_matched = false, 'service_role call works and returns no match';

  perform auth.as_admin();
  raise notice 'whatsapp verify function is service-role only: OK';
end $$;
