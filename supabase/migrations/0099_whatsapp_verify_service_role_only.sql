-- ---------------------------------------------------------------------------
-- 0099: restaurant_whatsapp_verify_webhook is for the WhatsApp gateway only.
--
-- 0086 granted it to `anon`, so anyone holding the public anon key could call
-- it straight through the REST API, skipping the shared-secret check in
-- /api/webhooks/whatsapp-verify. With a pending order's code (shown on the
-- placing guest's own screen) and a victim's phone number, that released the
-- order and bound the caller's device to the victim's number.
--
-- The function now runs for `service_role` only. The webhook route calls it
-- with the service-role client after checking the secret.
-- ---------------------------------------------------------------------------
revoke all on function public.restaurant_whatsapp_verify_webhook(text, text, text)
  from public, anon, authenticated;
grant execute on function public.restaurant_whatsapp_verify_webhook(text, text, text) to service_role;
