-- Module 4: refunds, part 3 of 3: made-up demo data and the default limits.
-- Order dates count back from the day this runs, so the "older than 30 days"
-- order stays old and the others stay recent for a few weeks.

insert into accounts (id, name, email, home_country) values
  ('acct-maya', 'Maya Ortiz', 'maya@example.com', 'US'),
  ('acct-jordan', 'Jordan Lee', 'jordan@example.com', 'US'),
  ('acct-priya', 'Priya Natarajan', 'priya@example.com', 'CA')
on conflict (id) do nothing;

-- Each account: two under $50 (to reach the daily totals), exactly $50, over
-- $50, one older than 30 days and one already refunded.
insert into orders (id, account_id, item, amount_cents, purchased_at, refunded_at)
select prefix || n, account_id, item, cents,
  now() - make_interval(days => age_days),
  case when refunded then now() - interval '10 days' end
from (values ('M-', 'acct-maya'), ('J-', 'acct-jordan'), ('P-', 'acct-priya'))
  as a (prefix, account_id)
cross join (values
  (1001, 'Copper Notes clip', 2900, 3, false),
  (1002, 'Copper Home stand', 4500, 5, false),
  (1003, 'Copper Home travel case', 5000, 6, false),
  (1004, 'Copper Home', 14900, 8, false),
  (1005, 'Copper Notes charging dock', 3500, 45, false),
  (1006, 'Copper Home wall mount', 2500, 12, true)
) as o (n, item, cents, age_days, refunded)
on conflict (id) do nothing;

insert into refund_settings (id, order_cents, account_daily_cents, shop_daily_cents)
values (1, 5000, 10000, 20000)
on conflict (id) do nothing;
