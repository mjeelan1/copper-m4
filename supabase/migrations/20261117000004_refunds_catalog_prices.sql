-- Module 4: the made-up orders use what Copper sells, at catalog prices
-- (lib/copper/data/catalog.json): Copper Home $149, Copper Notes $129,
-- Copper Plus $7.99 a month. amount_cents is what the customer paid, and a
-- refund is always that amount, never the list price.
-- No catalog price makes exactly $50, so that order is Copper Notes with a
-- $79 discount code. tests/refund-seed.test.ts checks these against the catalog.
update orders o
set item = v.item, amount_cents = v.cents
from (values
  ('1001', 'Copper Plus, 3 months ($7.99 a month)', 2397),
  ('1002', 'Copper Plus, 6 months ($7.99 a month)', 4794),
  ('1003', 'Copper Notes ($129) with a $79 discount code', 5000),
  ('1004', 'Copper Home', 14900),
  ('1005', 'Copper Plus, 4 months ($7.99 a month)', 3196),
  ('1006', 'Copper Plus, 1 month', 799)
) as v (n, item, cents)
where o.id in ('M-' || v.n, 'J-' || v.n, 'P-' || v.n);
