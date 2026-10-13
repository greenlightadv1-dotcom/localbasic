-- ---------------------------------------------------------------------------
-- 0092: drop the pre-order device-verification RPCs left over from 0081.
--
-- 0086 moved verification AFTER order creation: the order is created with its
-- own verification_code at 'pending_verification', and the WhatsApp webhook
-- (or the cashier's manual button) releases it. The functions below issued a
-- code BEFORE an order existed. Nothing in the application calls them any
-- more, and the start/status pair is still executable by anon, so they are
-- removed rather than left as dead public surface.
--
-- Unchanged: restaurant_guest_devices (trust store), app.restaurant_guest_
-- device_trusted, restaurant_guest_verify_order, the webhook function.
-- ---------------------------------------------------------------------------
drop function if exists public.restaurant_guest_verification_start_by_token(text, text, text);
drop function if exists public.restaurant_guest_verification_start(text, text, text, text);
drop function if exists public.restaurant_guest_device_status_by_token(text, text, text);
drop function if exists public.restaurant_guest_device_status(text, text, text, text);
drop function if exists app.restaurant_guest_verification_issue(uuid, uuid, text, text);
