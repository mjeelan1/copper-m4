-- Stage 2: the evaluator agent and the learning loop. Additive only: Stage 1
-- uses the same tables and functions, unchanged.
-- New tables have row level security with no policies, and the new
-- functions run for the server (service role) only.

-- Sample history is labelled, so the evaluator and the console can tell it
-- apart from real customers.
alter table accounts add column if not exists is_sample boolean not null default false;

-- The facts the decision engine saw, saved with each case, so the evaluator
-- can run the engine again on exactly the same input. Cases from before
-- Stage 2 have none.
alter table refund_cases add column if not exists facts jsonb;

-- What the customer was actually shown in the chat, linked to the case it
-- was about. written_by: 'code' (the decision log's text) or 'agent' (the
-- Refund agent's own words).
create table if not exists chat_replies (
  id bigint generated always as identity primary key,
  session_id uuid not null references chat_sessions (id),
  case_id bigint references refund_cases (id),
  written_by text not null check (written_by in ('code', 'agent')),
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_replies_case on chat_replies (case_id);

-- One evaluation per case: pass or fail and a one-sentence reason.
create table if not exists evaluations (
  id bigint generated always as identity primary key,
  case_id bigint not null unique references refund_cases (id),
  result text not null check (result in ('pass', 'fail')),
  reason text not null,
  reply_matches boolean not null,
  engine_matches boolean not null,
  -- Whether the AI looked at the agent's own words, and what it said.
  ai_checked boolean not null default false,
  ai_pass boolean,
  created_at timestamptz not null default now()
);

-- Every Accept or Ignore on a suggestion: who, when, and the evidence.
create table if not exists suggestion_actions (
  id bigint generated always as identity primary key,
  suggestion_key text not null,
  action text not null check (action in ('accepted', 'ignored')),
  by_name text not null,
  from_order_cents integer not null,
  to_order_cents integer not null,
  evidence jsonb not null,
  created_at timestamptz not null default now()
);

alter table chat_replies enable row level security;
alter table evaluations enable row level security;
alter table suggestion_actions enable row level security;

-- Saves the engine's facts on a case that has none yet. Never changes the
-- decision, the status or anything else on the case.
create or replace function save_case_facts(p_case bigint, p_facts jsonb)
returns void
language sql set search_path = public as $$
  update refund_cases set facts = p_facts where id = p_case and facts is null;
$$;

-- The evaluator's queue, read only: finished cases with saved facts, not
-- from the sample account, not evaluated yet, oldest first.
create or replace function evaluator_next_cases(p_limit integer)
returns setof refund_cases
language sql stable set search_path = public as $$
  select c.* from refund_cases c
  join accounts a on a.id = c.account_id
  where c.status in ('refunded', 'refused', 'approved', 'rejected')
    and c.facts is not null
    and not a.is_sample
    and not exists (select 1 from evaluations e where e.case_id = c.id)
  order by c.id
  limit least(greatest(p_limit, 0), 5);
$$;

revoke execute on function save_case_facts(bigint, jsonb) from public, anon, authenticated;
revoke execute on function evaluator_next_cases(integer) from public, anon, authenticated;
grant execute on function save_case_facts(bigint, jsonb) to service_role;
grant execute on function evaluator_next_cases(integer) to service_role;
