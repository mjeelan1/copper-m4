-- Stage 2: made-up SAMPLE history, so the Suggestions panel has something to
-- show. A separate "Sample customer" account (is_sample = true) with its own
-- orders and 12 past cases that a person decided. Inserts only: no row of
-- Maya's, Jordan's or Priya's is read, changed or deleted.
-- Prices come from the catalog (Copper Plus $7.99 a month or $79 a year,
-- Copper Notes $129, Copper Home $149). tests/stage2-sample.test.ts checks
-- this file.

insert into accounts (id, name, email, home_country, is_sample) values
  ('acct-sample', 'Sample customer (sample)', 'sample@example.com', 'US', true)
on conflict (id) do nothing;

-- n, item, cents, days ago, outcome, flagged ("customer claimed approval")
create temporary table sample_cases (
  n integer, item text, cents integer, days integer, outcome text, flagged boolean
) on commit drop;
insert into sample_cases values
  -- $50.01 to $100, no flags: 5 of 6 approved (83%)
  (2001, 'Copper Plus, 1 year', 7900, 20, 'approve', false),
  (2002, 'Copper Plus, 1 year', 7900, 18, 'approve', false),
  (2003, 'Copper Plus, 8 months ($7.99 a month)', 6392, 16, 'approve', false),
  (2004, 'Copper Plus, 10 months ($7.99 a month)', 7990, 14, 'approve', false),
  (2005, 'Copper Plus, 1 year', 7900, 12, 'approve', false),
  (2006, 'Copper Plus, 9 months ($7.99 a month)', 7191, 10, 'reject', false),
  -- $50.01 to $100, the customer claimed approval: both rejected
  (2007, 'Copper Plus, 1 year', 7900, 9, 'reject', true),
  (2008, 'Copper Plus, 8 months ($7.99 a month)', 6392, 8, 'reject', true),
  -- $100.01 to $200, no flags: 3 of 4 approved (too few cases to suggest)
  (2009, 'Copper Notes', 12900, 7, 'approve', false),
  (2010, 'Copper Home', 14900, 6, 'approve', false),
  (2011, 'Copper Notes', 12900, 5, 'approve', false),
  (2012, 'Copper Home', 14900, 4, 'reject', false);

insert into orders (id, account_id, item, amount_cents, purchased_at, refunded_at)
select 'S-' || n, 'acct-sample', item, cents,
  now() - make_interval(days => days + 3),
  case when outcome = 'approve' then now() - make_interval(days => days) + interval '1 hour' end
from sample_cases
on conflict (id) do nothing;

-- The cases, as the code sent them to review and a person decided them.
insert into refund_cases (
  account_id, order_id, amount_cents, status, ip, device, browser, country,
  reasons, flags, limits, created_at, decided_at, decided_by)
select 'acct-sample', 'S-' || n, cents,
  case when outcome = 'approve' then 'approved' else 'rejected' end,
  '192.0.2.' || (n - 2000), 'sample-device-' || (n - 2000), 'Sample', 'US',
  case when flagged then array[
      'The customer said someone already approved this refund.',
      '$' || to_char(cents / 100.0, 'FM999990.00') || ' is over the $50.00 order limit.']
    else array[
      '$' || to_char(cents / 100.0, 'FM999990.00') || ' is over the $50.00 order limit.'] end,
  case when flagged then array['customer claimed approval'] else array[]::text[] end,
  '{"orderCents": 5000, "accountDailyCents": 10000, "shopDailyCents": 20000}'::jsonb,
  now() - make_interval(days => days),
  now() - make_interval(days => days) + interval '1 hour',
  'person'
from sample_cases
where not exists (select 1 from refund_cases where account_id = 'acct-sample');

-- The decision log: the code's "review", then the person's decision.
insert into refund_decisions (
  case_id, decided_by, result, reasons, flags, limits, customer_message, created_at)
select c.id, 'code', 'review', c.reasons, c.flags, c.limits,
  'Your refund request of $' || to_char(c.amount_cents / 100.0, 'FM999990.00') ||
    ' for order ' || c.order_id ||
    ' is waiting for a person on our team. I''ll tell you here as soon as they decide.',
  c.created_at
from refund_cases c
where c.account_id = 'acct-sample'
  and not exists (select 1 from refund_decisions d where d.case_id = c.id);

insert into refund_decisions (
  case_id, decided_by, result, reasons, flags, limits, customer_message, created_at)
select c.id, 'person',
  case c.status when 'approved' then 'approve' else 'reject' end,
  array[case c.status when 'approved' then 'Approved by a person.' else 'Rejected by a person.' end],
  c.flags, c.limits,
  case c.status
    when 'approved' then 'A person on our team approved your refund of $' ||
      to_char(c.amount_cents / 100.0, 'FM999990.00') || ' for order ' || c.order_id || '. It''s done.'
    else 'A person on our team reviewed your refund request for order ' ||
      c.order_id || ' and turned it down.' end,
  c.decided_at
from refund_cases c
where c.account_id = 'acct-sample'
  and not exists (select 1 from refund_decisions d where d.case_id = c.id and d.decided_by = 'person');
