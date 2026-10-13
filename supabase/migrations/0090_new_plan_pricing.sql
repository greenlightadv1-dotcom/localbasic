-- ---------------------------------------------------------------------------
-- 0090: new monthly prices for the three paid tiers.
--
--   basic   (أساسي)   499.00 → 2,500.00 EGP
--   growth  (نمو)   1,299.00 → 3,500.00 EGP
--   scale   (احترافي) 2,999.00 → 6,000.00 EGP
--
-- plans.price_cents is the MONTHLY price in minor units (piastres); a longer
-- term is that × its months, computed on the server when a term is sold. Past
-- subscription_events keep the gross/net they were sold at, so nothing already
-- charged changes — an existing subscription is re-priced only when it is next
-- renewed. Limits and features are untouched.
-- ---------------------------------------------------------------------------
update public.plans
   set price_cents = case key
         when 'basic'  then 250000
         when 'growth' then 350000
         when 'scale'  then 600000
       end
 where key in ('basic', 'growth', 'scale');
