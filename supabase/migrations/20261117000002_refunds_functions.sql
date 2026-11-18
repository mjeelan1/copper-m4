-- Module 4: refunds, part 2 of 3: the server-only functions. Every refund
-- write goes through these, so each one happens in one step.

-- "Today" is the shop's day in Arizona (no daylight saving time).
create or replace function refund_day_start() returns timestamptz
language sql stable set search_path = public as $$
  select date_trunc('day', now() at time zone 'America/Phoenix')
    at time zone 'America/Phoenix';
$$;

-- Everything the decision engine needs, read in one go. `version` is the
-- newest case ID: record_refund_case won't save if a case was added since.
create or replace function refund_facts(p_session uuid, p_order text)
returns jsonb
language plpgsql stable set search_path = public as $$
declare
  s chat_sessions;
  day_start timestamptz := refund_day_start();
begin
  select * into s from chat_sessions where id = p_session;
  if not found then
    raise exception 'No chat session %', p_session;
  end if;
  return jsonb_build_object(
    'version', (select coalesce(max(id), 0) from refund_cases),
    'now', now(),
    'account_id', s.account_id,
    'home_country', (select home_country from accounts where id = s.account_id),
    'signals', jsonb_build_object(
      'ip', s.ip, 'device', s.device, 'browser', s.browser, 'country', s.country),
    'claimed_approval', s.claimed_approval,
    'order', (select to_jsonb(o) from orders o where o.id = p_order),
    'has_waiting_refund', exists (
      select 1 from refund_cases where order_id = p_order and status = 'waiting'),
    'accounts_on_device_or_ip_today', coalesce((
      select jsonb_agg(distinct account_id) from refund_cases
      where created_at >= day_start and (device = s.device or ip = s.ip)), '[]'),
    'account_auto_today_cents', (
      select coalesce(sum(amount_cents), 0) from refund_cases
      where status = 'refunded' and account_id = s.account_id
        and created_at >= day_start),
    'shop_auto_today_cents', (
      select coalesce(sum(amount_cents), 0) from refund_cases
      where status = 'refunded' and created_at >= day_start),
    'limits', (select jsonb_build_object(
      'orderCents', order_cents,
      'accountDailyCents', account_daily_cents,
      'shopDailyCents', shop_daily_cents) from refund_settings where id = 1)
  );
end;
$$;

-- Saves the code's decision in one step. Every refund request takes the same
-- lock, so they run one at a time; if any case was saved after the facts were
-- read, nothing is saved and the server decides again with fresh facts.
-- Amount, account and signals come from the order and the session here.
create or replace function record_refund_case(
  p_session uuid,
  p_order text,
  p_seen_version bigint,
  p_result text,
  p_reasons text[],
  p_flags text[],
  p_limits jsonb,
  p_message text
) returns jsonb
language plpgsql set search_path = public as $$
declare
  s chat_sessions;
  amount integer;
  new_id bigint;
  status text := case p_result
    when 'refund' then 'refunded'
    when 'refuse' then 'refused'
    when 'review' then 'waiting'
  end;
begin
  if status is null then
    raise exception 'Unknown result %', p_result;
  end if;
  perform pg_advisory_xact_lock(hashtext('refund_requests'));
  if (select coalesce(max(id), 0) from refund_cases) <> p_seen_version then
    return jsonb_build_object('conflict', true);
  end if;

  select * into s from chat_sessions where id = p_session;
  select amount_cents into amount from orders where id = p_order;

  insert into refund_cases (
    session_id, account_id, order_id, amount_cents, status,
    ip, device, browser, country, reasons, flags, limits,
    decided_at, decided_by)
  values (
    p_session, s.account_id, p_order, amount, status,
    s.ip, s.device, s.browser, s.country, p_reasons, p_flags, p_limits,
    case when status = 'waiting' then null else now() end,
    case when status = 'waiting' then null else 'code' end)
  returning id into new_id;

  if status = 'refunded' then
    update orders set refunded_at = now()
    where id = p_order and refunded_at is null;
    if not found then
      raise exception 'Order % was already refunded', p_order;
    end if;
  end if;

  insert into refund_decisions (
    case_id, decided_by, result, reasons, flags, limits, customer_message)
  values (new_id, 'code', p_result, p_reasons, p_flags, p_limits, p_message);

  return jsonb_build_object('conflict', false, 'case_id', new_id, 'status', status);
exception
  -- The one-refund-per-order index: another request got there first.
  when unique_violation then
    return jsonb_build_object('conflict', true);
end;
$$;

-- A person's Approve or Reject. Only a waiting case can be decided, so a
-- second click, or Approve after Reject, changes nothing.
create or replace function review_refund_case(
  p_case bigint,
  p_decision text,
  p_message text
) returns jsonb
language plpgsql set search_path = public as $$
declare
  c refund_cases;
begin
  if p_decision not in ('approve', 'reject') then
    raise exception 'Unknown decision %', p_decision;
  end if;
  update refund_cases
  set status = case p_decision when 'approve' then 'approved' else 'rejected' end,
      decided_at = now(),
      decided_by = 'person'
  where id = p_case and status = 'waiting'
  returning * into c;
  if not found then
    return jsonb_build_object('changed', false);
  end if;

  if p_decision = 'approve' then
    update orders set refunded_at = now()
    where id = c.order_id and refunded_at is null;
  end if;

  insert into refund_decisions (
    case_id, decided_by, result, reasons, flags, limits, customer_message)
  values (
    c.id, 'person', p_decision,
    array[case p_decision when 'approve' then 'Approved by a person.'
      else 'Rejected by a person.' end],
    c.flags, c.limits, p_message);

  return jsonb_build_object('changed', true, 'status', c.status);
end;
$$;

-- The Settings form. The table's checks refuse a negative limit.
create or replace function set_refund_limits(
  p_order_cents integer,
  p_account_daily_cents integer,
  p_shop_daily_cents integer
) returns void
language sql set search_path = public as $$
  update refund_settings
  set order_cents = p_order_cents,
      account_daily_cents = p_account_daily_cents,
      shop_daily_cents = p_shop_daily_cents,
      updated_at = now()
  where id = 1;
$$;

-- Only the server (service role, the secret key) may run these.
revoke execute on function refund_day_start() from public, anon, authenticated;
revoke execute on function refund_facts(uuid, text) from public, anon, authenticated;
revoke execute on function record_refund_case(uuid, text, bigint, text, text[], text[], jsonb, text) from public, anon, authenticated;
revoke execute on function review_refund_case(bigint, text, text) from public, anon, authenticated;
revoke execute on function set_refund_limits(integer, integer, integer) from public, anon, authenticated;
grant execute on function refund_day_start() to service_role;
grant execute on function refund_facts(uuid, text) to service_role;
grant execute on function record_refund_case(uuid, text, bigint, text, text[], text[], jsonb, text) to service_role;
grant execute on function review_refund_case(bigint, text, text) to service_role;
grant execute on function set_refund_limits(integer, integer, integer) to service_role;
