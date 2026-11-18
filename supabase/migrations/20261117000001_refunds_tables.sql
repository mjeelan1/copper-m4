-- Module 4: refunds, part 1 of 3: the tables. They sit beside the Module 2
-- `inventory` table without changing it.
-- Row level security is on with no policies: the publishable key can't read
-- or write them. Only the app's server, with the secret key, can.

-- Made-up customer accounts. The chat's "Signed in as" switcher picks one.
create table if not exists accounts (
  id text primary key,
  name text not null,
  email text not null,
  home_country text not null
);

create table if not exists orders (
  id text primary key,
  account_id text not null references accounts (id),
  item text not null,
  amount_cents integer not null check (amount_cents > 0),
  purchased_at timestamptz not null,
  refunded_at timestamptz
);

-- One row per chat. ip, device, browser and country are made up: the
-- Customer simulator on /support sets them.
create table if not exists chat_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id text not null references accounts (id),
  ip text not null,
  device text not null,
  browser text not null,
  country text not null,
  -- Which agent is talking: Copper hands refunds to the Refund agent.
  agent text not null default 'copper' check (agent in ('copper', 'refunds')),
  -- Set once the code's scan finds "a supervisor already approved" and the
  -- like. It never goes back to false, even if the chat history is dropped.
  claimed_approval boolean not null default false,
  created_at timestamptz not null default now()
);

-- The three limits, in cents. At 0, every refund in that category waits.
create table if not exists refund_settings (
  id integer primary key default 1 check (id = 1),
  order_cents integer not null check (order_cents >= 0),
  account_daily_cents integer not null check (account_daily_cents >= 0),
  shop_daily_cents integer not null check (shop_daily_cents >= 0),
  updated_at timestamptz not null default now()
);

-- One row per refund request. status: refunded (by the code), refused (by
-- rule), waiting (for a person), approved or rejected (by a person).
create table if not exists refund_cases (
  id bigint generated always as identity primary key,
  session_id uuid references chat_sessions (id),
  account_id text not null references accounts (id),
  -- Not a foreign key: asking about an order that doesn't exist is logged too.
  order_id text not null,
  -- Always copied from the order, never from the request. Null if no order.
  amount_cents integer,
  status text not null
    check (status in ('refunded', 'refused', 'waiting', 'approved', 'rejected')),
  ip text not null,
  device text not null,
  browser text not null,
  country text not null,
  reasons text[] not null,
  flags text[] not null,
  -- The limits as they were at the moment of the request. Never re-read.
  limits jsonb not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text check (decided_by in ('code', 'person'))
);

-- One refund per order: at most one case per order that is refunded, waiting
-- or approved, so two requests at the same time can't both get in.
create unique index if not exists one_refund_per_order
  on refund_cases (order_id)
  where status in ('refunded', 'waiting', 'approved');

-- The decision log: one row per decision, by the code or by a person.
create table if not exists refund_decisions (
  id bigint generated always as identity primary key,
  case_id bigint not null references refund_cases (id),
  decided_by text not null check (decided_by in ('code', 'person')),
  result text not null
    check (result in ('refund', 'refuse', 'review', 'approve', 'reject')),
  reasons text[] not null,
  flags text[] not null,
  limits jsonb not null,
  -- Exactly what the customer is told in the chat.
  customer_message text not null,
  created_at timestamptz not null default now()
);

alter table accounts enable row level security;
alter table orders enable row level security;
alter table chat_sessions enable row level security;
alter table refund_settings enable row level security;
alter table refund_cases enable row level security;
alter table refund_decisions enable row level security;
