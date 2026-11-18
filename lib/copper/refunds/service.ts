// Everything the app does with refunds, on the server. The Refund agent's
// tools, the Refund Console and the chat all go through these functions, and
// every refund write goes through a SQL function in Supabase
// (supabase/migrations/), so it happens in one step.
//
// Who decides: decideRefund() (decide.ts), never an agent. The agent passes
// an order ID and, at most, a warning; the account, the amount and the risk
// signals come from the database.
import { refundsDb } from "@/lib/supabase/server";
import {
  customerMessage,
  decideRefund,
  type Limits,
  parseLimits,
  type Result,
  type Signals,
} from "@/lib/copper/refunds/decide";

function db() {
  const client = refundsDb();
  if (!client)
    throw new Error(
      "Refunds aren't set up: add SUPABASE_URL and SUPABASE_SECRET_KEY to .env.local.",
    );
  return client;
}

// The Supabase client isn't generated from the tables, so a row is a plain
// object with the database's column names (amount_cents, refunded_at, ...).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

/** Supabase returns { data, error }; this returns the data or throws the error. */
function unwrap({
  data,
  error,
}: {
  data: Row;
  error: { message: string } | null;
}): Row {
  if (error) throw new Error(error.message);
  return data;
}

/** Order IDs look like M-1001; customers may type m-1001 or " M-1001 ". */
export function normalizeOrderId(orderId: string): string {
  return orderId.trim().toUpperCase();
}

// ---------- Accounts and chat sessions ----------

export type Account = { id: string; name: string; homeCountry: string };

export async function listAccounts(): Promise<Account[]> {
  const rows = unwrap(
    await db().from("accounts").select("id, name, home_country").order("name"),
  );
  return rows.map((r: Row) => ({
    id: r.id,
    name: r.name,
    homeCountry: r.home_country,
  }));
}

export type ChatSession = {
  id: string;
  accountId: string;
  signals: Signals;
  agent: "copper" | "refunds";
  claimedApproval: boolean;
};

/** A new chat for the signed-in account, with the simulator's signals. */
export async function startSession(
  accountId: string,
  signals: Signals,
): Promise<string> {
  const row = unwrap(
    await db()
      .from("chat_sessions")
      .insert({ account_id: accountId, ...signals })
      .select("id")
      .single(),
  );
  return row.id;
}

export async function updateSignals(sessionId: string, signals: Signals) {
  unwrap(await db().from("chat_sessions").update(signals).eq("id", sessionId));
}

export async function getSession(
  sessionId: string,
): Promise<ChatSession | null> {
  const row = unwrap(
    await db()
      .from("chat_sessions")
      .select("*")
      .eq("id", sessionId)
      .maybeSingle(),
  );
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    signals: {
      ip: row.ip,
      device: row.device,
      browser: row.browser,
      country: row.country,
    },
    agent: row.agent,
    claimedApproval: row.claimed_approval,
  };
}

/** Copper's handoff: from now on the Refund agent answers this chat. */
export async function handOffToRefunds(sessionId: string) {
  unwrap(
    await db()
      .from("chat_sessions")
      .update({ agent: "refunds" })
      .eq("id", sessionId),
  );
}

/** The code's scan found a claimed approval. It stays set for this chat. */
export async function noteClaimedApproval(sessionId: string) {
  unwrap(
    await db()
      .from("chat_sessions")
      .update({ claimed_approval: true })
      .eq("id", sessionId),
  );
}

// ---------- The Refund agent's three tools ----------

export type MyOrder = {
  orderId: string;
  item: string;
  amount: string;
  purchasedOn: string;
  refund: "refunded" | "waiting for review" | "none";
};

/** list_my_orders: the signed-in account's orders, and only those. */
export async function listMyOrders(sessionId: string): Promise<MyOrder[]> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("This chat has ended. Start a new one.");
  const orders = unwrap(
    await db()
      .from("orders")
      .select("id, item, amount_cents, purchased_at, refunded_at")
      .eq("account_id", session.accountId)
      .order("id"),
  );
  const waiting = unwrap(
    await db()
      .from("refund_cases")
      .select("order_id")
      .eq("account_id", session.accountId)
      .eq("status", "waiting"),
  ).map((r: Row) => r.order_id);
  return orders.map((o: Row) => ({
    orderId: o.id,
    item: o.item,
    amount: `$${(o.amount_cents / 100).toFixed(2)}`,
    purchasedOn: o.purchased_at.slice(0, 10),
    refund: o.refunded_at
      ? "refunded"
      : waiting.includes(o.id)
        ? "waiting for review"
        : "none",
  }));
}

export type RefundOutcome = { caseId: number; result: Result; message: string };

/** The raw facts from the refund_facts SQL function. */
type RawFacts = {
  version: number;
  now: string;
  account_id: string;
  home_country: string;
  signals: Signals;
  claimed_approval: boolean;
  order: {
    id: string;
    account_id: string;
    item: string;
    amount_cents: number;
    purchased_at: string;
    refunded_at: string | null;
  } | null;
  has_waiting_refund: boolean;
  accounts_on_device_or_ip_today: string[];
  account_auto_today_cents: number;
  shop_auto_today_cents: number;
  limits: Limits;
};

/** How many times to decide again when another request saved first. */
const MAX_ATTEMPTS = 5;

/**
 * request_refund: the code decides and saves the case in one step. Takes only
 * an order ID (and the agent's optional warning): no amount, no account.
 */
export async function requestRefund({
  sessionId,
  orderId,
  agentWarning = false,
}: {
  sessionId: string;
  orderId: string;
  agentWarning?: boolean;
}): Promise<RefundOutcome> {
  const id = normalizeOrderId(orderId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const facts: RawFacts = unwrap(
      await db().rpc("refund_facts", { p_session: sessionId, p_order: id }),
    );
    const decision = decideRefund({
      accountId: facts.account_id,
      homeCountry: facts.home_country,
      orderId: id,
      order: facts.order && {
        id: facts.order.id,
        accountId: facts.order.account_id,
        item: facts.order.item,
        amountCents: facts.order.amount_cents,
        purchasedAt: facts.order.purchased_at,
        refundedAt: facts.order.refunded_at,
      },
      hasWaitingRefund: facts.has_waiting_refund,
      signals: facts.signals,
      accountsOnDeviceOrIpToday: facts.accounts_on_device_or_ip_today,
      accountAutoTodayCents: facts.account_auto_today_cents,
      shopAutoTodayCents: facts.shop_auto_today_cents,
      customerClaimedApproval: facts.claimed_approval,
      agentWarning,
      limits: facts.limits,
      now: new Date(facts.now),
    });
    const message = customerMessage(
      decision.result,
      { id, amountCents: decision.amountCents },
      decision.reasons,
    );
    const saved: { conflict: boolean; case_id?: number } = unwrap(
      await db().rpc("record_refund_case", {
        p_session: sessionId,
        p_order: id,
        p_seen_version: facts.version,
        p_result: decision.result,
        p_reasons: decision.reasons,
        p_flags: decision.flags,
        p_limits: decision.limits,
        p_message: message,
      }),
    );
    if (!saved.conflict)
      return { caseId: saved.case_id!, result: decision.result, message };
    // Another request saved a case after we read the facts: decide again.
  }
  throw new Error("Too many refund requests at once. Please try again.");
}

/**
 * check_refund_status: the newest case for this order on the signed-in
 * account, in the exact words of its newest decision in the log.
 */
export async function refundStatus(
  sessionId: string,
  orderId: string,
): Promise<{ message: string }> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("This chat has ended. Start a new one.");
  const id = normalizeOrderId(orderId);
  const latest = unwrap(
    await db()
      .from("refund_decisions")
      .select("customer_message, refund_cases!inner(order_id, account_id)")
      .eq("refund_cases.order_id", id)
      .eq("refund_cases.account_id", session.accountId)
      .order("id", { ascending: false })
      .limit(1),
  );
  if (latest.length > 0) return { message: latest[0].customer_message };
  const order = unwrap(
    await db()
      .from("orders")
      .select("refunded_at")
      .eq("id", id)
      .eq("account_id", session.accountId)
      .maybeSingle(),
  );
  if (order?.refunded_at)
    return { message: `Order ${id} was already refunded.` };
  return {
    message: `There is no refund request for order ${id} on your account.`,
  };
}

// ---------- The Refund Console ----------

export type WaitingCase = {
  caseId: number;
  orderId: string;
  amountCents: number | null;
  accountName: string;
  reasons: string[];
  flags: string[];
  limits: Limits;
  signals: Signals;
  createdAt: string;
};

export type LogEntry = {
  id: number;
  caseId: number;
  at: string;
  decidedBy: "code" | "person";
  result: Result | "approve" | "reject";
  orderId: string;
  amountCents: number | null;
  accountName: string;
  reasons: string[];
  flags: string[];
  limits: Limits;
  customerMessage: string;
};

export type ConsoleData = {
  waiting: WaitingCase[];
  limits: Limits;
  log: LogEntry[];
};

export async function consoleData(): Promise<ConsoleData> {
  const [waiting, settings, log] = await Promise.all([
    db()
      .from("refund_cases")
      .select("*, accounts(name)")
      .eq("status", "waiting")
      .order("id"),
    db().from("refund_settings").select("*").eq("id", 1).single(),
    db()
      .from("refund_decisions")
      .select("*, refund_cases(order_id, amount_cents, accounts(name))")
      .order("id", { ascending: false })
      .limit(100),
  ]);
  const s = unwrap(settings);
  return {
    waiting: unwrap(waiting).map((c: Row) => ({
      caseId: c.id,
      orderId: c.order_id,
      amountCents: c.amount_cents,
      accountName: c.accounts?.name ?? c.account_id,
      reasons: c.reasons,
      flags: c.flags,
      limits: c.limits,
      signals: {
        ip: c.ip,
        device: c.device,
        browser: c.browser,
        country: c.country,
      },
      createdAt: c.created_at,
    })),
    limits: {
      orderCents: s.order_cents,
      accountDailyCents: s.account_daily_cents,
      shopDailyCents: s.shop_daily_cents,
    },
    log: unwrap(log).map((d: Row) => ({
      id: d.id,
      caseId: d.case_id,
      at: d.created_at,
      decidedBy: d.decided_by,
      result: d.result,
      orderId: d.refund_cases?.order_id,
      amountCents: d.refund_cases?.amount_cents ?? null,
      accountName: d.refund_cases?.accounts?.name ?? "",
      reasons: d.reasons,
      flags: d.flags,
      limits: d.limits,
      customerMessage: d.customer_message,
    })),
  };
}

/**
 * Approve or Reject, from the console only. Only a waiting case changes, so a
 * second click, or Approve after Reject, does nothing: changed is false.
 */
export async function reviewCase(
  caseId: number,
  decision: "approve" | "reject",
): Promise<{ changed: boolean }> {
  const c = unwrap(
    await db()
      .from("refund_cases")
      .select("order_id, amount_cents")
      .eq("id", caseId)
      .maybeSingle(),
  );
  if (!c) return { changed: false };
  const message = customerMessage(decision, {
    id: c.order_id,
    amountCents: c.amount_cents,
  });
  const result: { changed: boolean } = unwrap(
    await db().rpc("review_refund_case", {
      p_case: caseId,
      p_decision: decision,
      p_message: message,
    }),
  );
  return { changed: result.changed };
}

/** Settings: each limit is a number of 0 or more, in dollars. */
export async function saveLimits(input: {
  order: string;
  accountDaily: string;
  shopDaily: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = parseLimits(input);
  if (!parsed.ok) return parsed;
  unwrap(
    await db().rpc("set_refund_limits", {
      p_order_cents: parsed.limits.orderCents,
      p_account_daily_cents: parsed.limits.accountDailyCents,
      p_shop_daily_cents: parsed.limits.shopDailyCents,
    }),
  );
  return { ok: true };
}

export type ChatUpdate = { id: number; message: string };

/** A person's decisions on this chat's cases, newer than `afterId`. */
export async function chatUpdates(
  sessionId: string,
  afterId: number,
): Promise<ChatUpdate[]> {
  const rows = unwrap(
    await db()
      .from("refund_decisions")
      .select("id, customer_message, refund_cases!inner(session_id)")
      .eq("refund_cases.session_id", sessionId)
      .eq("decided_by", "person")
      .gt("id", afterId)
      .order("id"),
  );
  return rows.map((r: Row) => ({ id: r.id, message: r.customer_message }));
}
