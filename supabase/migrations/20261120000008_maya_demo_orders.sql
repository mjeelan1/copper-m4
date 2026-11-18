-- Two more of Maya's orders for the class demo: Maya's seed has only one
-- order over $50 (M-1004, $149), and $149 alone goes over the $100 daily
-- account limit. These two are over $50 but small enough that, even after
-- refunding M-1001 ($23.97) the same day, neither reaches $100:
--   $23.97 + $63.92 = $87.89, and $23.97 + $71.91 = $95.88.
-- Catalog prices: Copper Plus is $7.99 a month. Inserts only.
-- tests/maya-demo-orders.test.ts checks this file.

insert into orders (id, account_id, item, amount_cents, purchased_at, refunded_at) values
  ('M-1007', 'acct-maya', 'Copper Plus, 8 months ($7.99 a month)', 6392, now() - interval '2 days', null),
  ('M-1008', 'acct-maya', 'Copper Plus, 9 months ($7.99 a month)', 7191, now() - interval '4 days', null)
on conflict (id) do nothing;
