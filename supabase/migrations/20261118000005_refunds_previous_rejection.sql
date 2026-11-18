-- Module 4: an order a person rejected before goes to review if anyone asks
-- again, in any chat. refund_facts now also returns the newest rejected case
-- for the order, and decideRefund() flags it "previously rejected by a person".

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
    -- The newest case for this order a person rejected: asking again goes to
    -- a person, never straight to a refund.
    'previous_rejection', (
      select jsonb_build_object('case_id', id, 'decided_at', decided_at)
      from refund_cases
      where order_id = p_order and status = 'rejected'
      order by id desc limit 1),
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
