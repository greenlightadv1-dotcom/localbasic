-- =============================================================================
-- LOCAL BASIC — Live order status, pushed over Supabase Realtime
--
-- The public tracking page (/order/track/[token]) already has its whole
-- security model: "the token is the whole authorization" — a 192-bit random
-- secret (app.new_public_token(), 0024) that resolves, via public_links, to
-- exactly one order and nothing else. This adds a push channel with the
-- SAME model rather than a new one: the topic name IS the token, so only
-- someone holding it can derive the channel to subscribe to.
--
-- WHY realtime.send(), NOT realtime.broadcast_changes().
--
-- broadcast_changes() would put the FULL restaurant_orders row on the wire —
-- branch_id, created_by, internal notes, everything — to anyone who can
-- derive the topic. The existing status RPC (restaurant_online_order_status)
-- is deliberately selective about what a customer may see; a broadcast that
-- is less selective than the pull path it is supposed to complement would be
-- a new, wider leak next to a narrow one. realtime.send() is used instead,
-- with a payload built by hand to carry exactly one field: the new status.
-- The client updates its own stage indicator from that value; it does not
-- trust the broadcast for money amounts or order contents, which it already
-- has from the page's own initial, server-rendered load.
--
-- private = false: this channel needs no Realtime Authorization/RLS policy
-- on realtime.messages, because the topic name is already the credential —
-- exactly as the token in the URL already is for the pull path. Nothing
-- about table-level RLS on restaurant_orders changes; anon still cannot
-- query that table directly, only receive this one narrow broadcast.
-- =============================================================================

create or replace function app.broadcast_order_status()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_token text;
begin
  if new.status is distinct from old.status then
    select pl.token into v_token
      from public.public_links pl
     where pl.kind = 'order_status'
       and pl.target ->> 'entity_type' = 'restaurant_order'
       and (pl.target ->> 'entity_id')::uuid = new.id
       and pl.is_active and pl.revoked_at is null
     order by pl.created_at desc
     limit 1;

    if v_token is not null then
      perform realtime.send(
        jsonb_build_object('status', new.status),
        'status',
        'order-status:' || v_token,
        false
      );
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app.broadcast_order_status() from public, anon, authenticated;

create trigger restaurant_orders_broadcast_status
  after update of status on public.restaurant_orders
  for each row execute function app.broadcast_order_status();
