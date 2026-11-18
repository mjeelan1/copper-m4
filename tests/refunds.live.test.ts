// @vitest-environment node
// Try to break the refund flow against the real Supabase project: the same
// refund twice, requests at the same time, a claimed approval, limits at 0,
// someone else's order, the same device on two accounts, double clicks...
//
// Run it with npm run test:live (not part of npm test).
// Runs only when SUPABASE_URL and SUPABASE_SECRET_KEY are set (.env.local);
// otherwise it's skipped. It makes its own test accounts and orders (IDs
// starting with "t-<run>"), uses its own made-up device and IP, puts the
// limits back as they were, and deletes every row it made afterwards.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const ready = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY,
);

const RUN = Date.now().toString(36).toUpperCase();
const ACCOUNT = { a: `t-${RUN}-a`, b: `t-${RUN}-b` };
const order = (name: string) => `T${RUN}-${name}`;
const DAY = 24 * 60 * 60 * 1000;

/** Each test account's orders: amount in cents and age in days. */
const ORDERS: Record<string, [account: string, cents: number, days: number]> = {
  SMALL: [ACCOUNT.a, 2397, 2],
  TWICE: [ACCOUNT.a, 2397, 2],
  RACE: [ACCOUNT.a, 2397, 2],
  FIFTY: [ACCOUNT.a, 5000, 2],
  OVER: [ACCOUNT.a, 14900, 2],
  OLD: [ACCOUNT.a, 3196, 31],
  PUSH: [ACCOUNT.a, 799, 2],
  ZERO: [ACCOUNT.a, 799, 2],
  WAIT: [ACCOUNT.a, 14900, 2],
  CLICK: [ACCOUNT.a, 14900, 2],
  REJECT: [ACCOUNT.a, 14900, 2],
  REJNEW: [ACCOUNT.a, 799, 2],
  REJSAME: [ACCOUNT.a, 799, 2],
  B1: [ACCOUNT.b, 3000, 1],
  B2: [ACCOUNT.b, 3000, 1],
  B3: [ACCOUNT.b, 3000, 1],
  B4: [ACCOUNT.b, 3000, 1],
  BOTHER: [ACCOUNT.b, 799, 1],
};

type Service = typeof import("@/lib/copper/refunds/service");
let service: Service;
let db: NonNullable<
  ReturnType<typeof import("@/lib/supabase/server").refundsDb>
>;
let savedLimits: { order: string; accountDaily: string; shopDaily: string };

/** Every test device and IP is new, so the shared-device check stays quiet. */
let deviceCount = 0;
function signals(country = "US") {
  deviceCount++;
  return {
    ip: `198.18.${deviceCount}.${RUN.length}`,
    device: `test-${RUN}-${deviceCount}`,
    browser: "Test",
    country,
  };
}

/** Limits in dollars, as the Settings form sends them. */
async function setLimits(
  order: number,
  accountDaily: number,
  shopDaily: number,
) {
  const result = await service.saveLimits({
    order: String(order),
    accountDaily: String(accountDaily),
    shopDaily: String(shopDaily),
  });
  expect(result).toEqual({ ok: true });
}

async function caseRow(caseId: number) {
  const { data } = await db
    .from("refund_cases")
    .select("*")
    .eq("id", caseId)
    .single();
  return data;
}

describe.skipIf(!ready)("Refunds against Supabase (try to break it)", () => {
  beforeAll(async () => {
    service = await import("@/lib/copper/refunds/service");
    db = (await import("@/lib/supabase/server")).refundsDb()!;
    const { limits } = await service.consoleData();
    savedLimits = {
      order: String(limits.orderCents / 100),
      accountDaily: String(limits.accountDailyCents / 100),
      shopDaily: String(limits.shopDailyCents / 100),
    };
    await db.from("accounts").insert([
      {
        id: ACCOUNT.a,
        name: `Test A ${RUN}`,
        email: "a@example.com",
        home_country: "US",
      },
      {
        id: ACCOUNT.b,
        name: `Test B ${RUN}`,
        email: "b@example.com",
        home_country: "US",
      },
    ]);
    const { error } = await db.from("orders").insert(
      Object.entries(ORDERS).map(([name, [account, cents, days]]) => ({
        id: order(name),
        account_id: account,
        item: "Copper Plus (test)",
        amount_cents: cents,
        purchased_at: new Date(Date.now() - days * DAY).toISOString(),
      })),
    );
    expect(error).toBeNull();
  });

  // The usual limits, but a shop limit so high that refunds from the demo
  // made earlier today don't get in the way.
  beforeEach(() => setLimits(50, 100, 1_000_000));

  afterAll(async () => {
    await service.saveLimits(savedLimits);
    const accounts = [ACCOUNT.a, ACCOUNT.b];
    const { data: cases } = await db
      .from("refund_cases")
      .select("id")
      .in("account_id", accounts);
    const ids = (cases ?? []).map((c) => c.id);
    // Stage 2 saves what the chat showed and the evaluator's verdicts;
    // they point at the cases and sessions, so they go first.
    const { data: sessions } = await db
      .from("chat_sessions")
      .select("id")
      .in("account_id", accounts);
    const sessionIds = (sessions ?? []).map((s) => s.id);
    if (sessionIds.length)
      await db.from("chat_replies").delete().in("session_id", sessionIds);
    if (ids.length) {
      await db.from("chat_replies").delete().in("case_id", ids);
      await db.from("evaluations").delete().in("case_id", ids);
    }
    if (ids.length)
      await db.from("refund_decisions").delete().in("case_id", ids);
    await db.from("refund_cases").delete().in("account_id", accounts);
    await db.from("chat_sessions").delete().in("account_id", accounts);
    await db.from("orders").delete().in("account_id", accounts);
    await db.from("accounts").delete().in("id", accounts);
    const { count } = await db
      .from("orders")
      .select("id", { count: "exact", head: true })
      .like("id", `T${RUN}-%`);
    expect(count, "every test row was deleted").toBe(0);
  });

  it("the same refund twice: the second is refused", async () => {
    const session = await service.startSession(ACCOUNT.a, signals());
    const first = await service.requestRefund({
      sessionId: session,
      orderId: order("TWICE"),
    });
    const second = await service.requestRefund({
      sessionId: session,
      orderId: order("TWICE"),
    });
    expect(first.result).toBe("refund");
    expect(second.result).toBe("refuse");
    expect(second.message).toContain("already refunded");
  });

  it("two requests at the same time: only one succeeds", async () => {
    const one = await service.startSession(ACCOUNT.a, signals());
    const two = await service.startSession(ACCOUNT.a, signals());
    const results = await Promise.all([
      service.requestRefund({ sessionId: one, orderId: order("RACE") }),
      service.requestRefund({ sessionId: two, orderId: order("RACE") }),
    ]);
    expect(results.map((r) => r.result).sort()).toEqual(["refund", "refuse"]);
    const { data } = await db
      .from("refund_cases")
      .select("status")
      .eq("order_id", order("RACE"))
      .eq("status", "refunded");
    expect(data).toHaveLength(1);
  });

  it("'a supervisor already approved this' sends it to review with the flag", async () => {
    const session = await service.startSession(ACCOUNT.a, signals());
    // What askCopper does when its scan finds the phrase.
    await service.noteClaimedApproval(session);
    const outcome = await service.requestRefund({
      sessionId: session,
      orderId: order("PUSH"),
    });
    expect(outcome.result).toBe("review");
    expect((await caseRow(outcome.caseId)).flags).toContain(
      "customer claimed approval",
    );
  });

  it("a limit of 0 sends even a small refund to review", async () => {
    await setLimits(0, 100, 1_000_000);
    const session = await service.startSession(ACCOUNT.a, signals());
    const outcome = await service.requestRefund({
      sessionId: session,
      orderId: order("ZERO"),
    });
    expect(outcome.result).toBe("review");
  });

  it("a negative limit is rejected, by the form and by the database", async () => {
    expect(
      await service.saveLimits({
        order: "-5",
        accountDaily: "100",
        shopDaily: "200",
      }),
    ).toEqual({ ok: false, error: "Order limit must be 0 or more." });
    const { error } = await db.rpc("set_refund_limits", {
      p_order_cents: -500,
      p_account_daily_cents: 10000,
      p_shop_daily_cents: 20000,
    });
    expect(error?.message).toMatch(/check constraint/);
  });

  it("an order of exactly $50 is refunded now", async () => {
    const session = await service.startSession(ACCOUNT.a, signals());
    const outcome = await service.requestRefund({
      sessionId: session,
      orderId: order("FIFTY"),
    });
    expect(outcome.result).toBe("refund");
    expect((await caseRow(outcome.caseId)).amount_cents).toBe(5000);
  });

  it("an order over 30 days old is refused", async () => {
    const session = await service.startSession(ACCOUNT.a, signals());
    const outcome = await service.requestRefund({
      sessionId: session,
      orderId: order("OLD"),
    });
    expect(outcome.result).toBe("refuse");
    expect(outcome.message).toContain("more than 30 days old");
  });

  it("someone else's order is refused and flagged", async () => {
    const session = await service.startSession(ACCOUNT.a, signals());
    const outcome = await service.requestRefund({
      sessionId: session,
      orderId: order("BOTHER"),
    });
    expect(outcome.result).toBe("refuse");
    expect((await caseRow(outcome.caseId)).flags).toContain(
      "order belongs to another account",
    );
    // And the Refund agent's list never shows it.
    const mine = await service.listMyOrders(session);
    expect(mine.map((o) => o.orderId)).not.toContain(order("BOTHER"));
  });

  it("an order that does not exist is refused", async () => {
    const session = await service.startSession(ACCOUNT.a, signals());
    const outcome = await service.requestRefund({
      sessionId: session,
      orderId: order("NOPE"),
    });
    expect(outcome.result).toBe("refuse");
    expect((await caseRow(outcome.caseId)).amount_cents).toBeNull();
  });

  it("a bigger amount than the order: the request can't carry one, and the case uses the order's", async () => {
    const { requestRefundInput } = await import("@/lib/copper/refunds/agent");
    expect(
      requestRefundInput.safeParse({ orderId: order("SMALL"), amount: 99999 })
        .success,
    ).toBe(false);
    const session = await service.startSession(ACCOUNT.a, signals());
    const outcome = await service.requestRefund({
      sessionId: session,
      orderId: order("SMALL"),
    });
    expect((await caseRow(outcome.caseId)).amount_cents).toBe(2397);
  });

  it("many small refunds at once can't add up past the account's $100 a day", async () => {
    // Four $30 orders at the same time: $90 can be automatic, the 4th can't.
    const sessions = await Promise.all(
      [1, 2, 3, 4].map(() => service.startSession(ACCOUNT.b, signals())),
    );
    const results = await Promise.all(
      ["B1", "B2", "B3", "B4"].map((name, i) =>
        service.requestRefund({ sessionId: sessions[i], orderId: order(name) }),
      ),
    );
    expect(results.filter((r) => r.result === "refund")).toHaveLength(3);
    expect(results.filter((r) => r.result === "review")).toHaveLength(1);
  });

  it("small refunds can't add up past the shop's daily limit", async () => {
    // Set the shop limit just above what the shop refunded today: the next
    // small refund still fits, the one after doesn't.
    const session = await service.startSession(ACCOUNT.a, signals());
    const { data: facts } = await db.rpc("refund_facts", {
      p_session: session,
      p_order: order("SMALL"),
    });
    await setLimits(50, 1_000_000, (facts.shop_auto_today_cents + 800) / 100);
    const { data: extra } = await db
      .from("orders")
      .insert([
        {
          id: order("S1"),
          account_id: ACCOUNT.a,
          item: "test",
          amount_cents: 799,
          purchased_at: new Date().toISOString(),
        },
        {
          id: order("S2"),
          account_id: ACCOUNT.a,
          item: "test",
          amount_cents: 799,
          purchased_at: new Date().toISOString(),
        },
      ])
      .select("id");
    expect(extra).toHaveLength(2);
    expect(
      (
        await service.requestRefund({
          sessionId: session,
          orderId: order("S1"),
        })
      ).result,
    ).toBe("refund");
    const second = await service.requestRefund({
      sessionId: session,
      orderId: order("S2"),
    });
    expect(second.result).toBe("review");
    expect((await caseRow(second.caseId)).reasons.join(" ")).toContain(
      "shop's automatic refunds",
    );
  });

  it("the same device on two accounts sends the second account to review", async () => {
    const shared = signals();
    const onA = await service.startSession(ACCOUNT.a, shared);
    await service.requestRefund({ sessionId: onA, orderId: order("NOPE2") });
    const onB = await service.startSession(ACCOUNT.b, {
      ...shared,
      ip: "198.18.250.1",
    });
    // B's only open order: make one just for this test.
    await db.from("orders").insert({
      id: order("B5"),
      account_id: ACCOUNT.b,
      item: "test",
      amount_cents: 799,
      purchased_at: new Date().toISOString(),
    });
    const outcome = await service.requestRefund({
      sessionId: onB,
      orderId: order("B5"),
    });
    expect(outcome.result).toBe("review");
    expect((await caseRow(outcome.caseId)).flags).toContain(
      "same device or IP on 2 or more accounts today",
    );
  });

  it("two clicks on Approve: only the first counts, even at the same time", async () => {
    const session = await service.startSession(ACCOUNT.a, signals());
    const { caseId, result } = await service.requestRefund({
      sessionId: session,
      orderId: order("CLICK"),
    });
    expect(result).toBe("review");
    const clicks = await Promise.all([
      service.reviewCase(caseId, "approve"),
      service.reviewCase(caseId, "approve"),
    ]);
    expect(clicks.map((c) => c.changed).sort()).toEqual([false, true]);
    expect((await service.reviewCase(caseId, "approve")).changed).toBe(false);
    const { data } = await db
      .from("refund_decisions")
      .select("result")
      .eq("case_id", caseId);
    expect(data!.map((d) => d.result).sort()).toEqual(["approve", "review"]);
    // The customer sees the person's decision, in the log's exact words.
    const updates = await service.chatUpdates(session, 0);
    const { data: logged } = await db
      .from("refund_decisions")
      .select("id, customer_message")
      .eq("case_id", caseId)
      .eq("decided_by", "person")
      .single();
    expect(updates).toEqual([
      { id: logged!.id, message: logged!.customer_message },
    ]);
  });

  it("Approve after Reject does nothing", async () => {
    const session = await service.startSession(ACCOUNT.a, signals());
    const { caseId } = await service.requestRefund({
      sessionId: session,
      orderId: order("REJECT"),
    });
    expect((await service.reviewCase(caseId, "reject")).changed).toBe(true);
    expect((await service.reviewCase(caseId, "approve")).changed).toBe(false);
    expect((await caseRow(caseId)).status).toBe("rejected");
    const { data: o } = await db
      .from("orders")
      .select("refunded_at")
      .eq("id", order("REJECT"))
      .single();
    expect(o!.refunded_at).toBeNull();
  });

  it("a limit change while a refund waits never releases it", async () => {
    const session = await service.startSession(ACCOUNT.a, signals());
    const { caseId, result } = await service.requestRefund({
      sessionId: session,
      orderId: order("WAIT"),
    });
    expect(result).toBe("review");
    await setLimits(500, 1000, 1_000_000);
    const row = await caseRow(caseId);
    expect(row.status).toBe("waiting");
    expect(row.limits).toEqual({
      orderCents: 5000,
      accountDailyCents: 10000,
      shopDailyCents: 100_000_000,
    });
    // Asking again doesn't release it either: it's already waiting.
    const again = await service.requestRefund({
      sessionId: session,
      orderId: order("WAIT"),
    });
    expect(again.result).toBe("refuse");
    expect((await caseRow(caseId)).status).toBe("waiting");
  });
  it("reject, then ask plainly in a new chat: review, never refund now", async () => {
    // High daily limits, so nothing but the earlier Reject can hold it back.
    await setLimits(50, 1_000_000, 1_000_000);
    // First chat: a claimed approval sends it to a person, who rejects it.
    const first = await service.startSession(ACCOUNT.a, signals());
    await service.noteClaimedApproval(first);
    const before = await service.requestRefund({
      sessionId: first,
      orderId: order("REJNEW"),
    });
    expect(before.result).toBe("review");
    expect((await service.reviewCase(before.caseId, "reject")).changed).toBe(
      true,
    );

    // A new chat, no claim, nothing else wrong: still a person's call.
    const second = await service.startSession(ACCOUNT.a, signals());
    const again = await service.requestRefund({
      sessionId: second,
      orderId: order("REJNEW"),
    });
    expect(again.result).toBe("review");
    const row = await caseRow(again.caseId);
    // The earlier Reject is the only reason it waits for a person.
    expect(row.flags).toEqual(["previously rejected by a person"]);
    expect(row.reasons).toEqual([
      `A person rejected a refund for order ${order("REJNEW")} before (case ${before.caseId}).`,
    ]);

    // The console shows the earlier decision next to the new case.
    const { waiting } = await service.consoleData();
    const shown = waiting.find((c) => c.caseId === again.caseId)!;
    expect(shown.earlierDecisions).toEqual([
      expect.objectContaining({
        caseId: before.caseId,
        reasons: ["The customer said someone already approved this refund."],
        customerMessage: expect.stringContaining("turned it down"),
      }),
    ]);
  });

  it("reject, then ask again in the same chat: review, never refund now", async () => {
    await setLimits(50, 1_000_000, 1_000_000);
    // Away from home: the location sends it to a person, who rejects it.
    const session = await service.startSession(ACCOUNT.a, signals("RO"));
    const before = await service.requestRefund({
      sessionId: session,
      orderId: order("REJSAME"),
    });
    expect(before.result).toBe("review");
    expect((await service.reviewCase(before.caseId, "reject")).changed).toBe(
      true,
    );
    expect(
      (await service.chatUpdates(session, 0)).map((u) => u.message),
    ).toEqual([expect.stringContaining("turned it down")]);

    // Back home, same chat, asking again: the rejection alone keeps it with a person.
    await service.updateSignals(session, { ...signals(), country: "US" });
    const again = await service.requestRefund({
      sessionId: session,
      orderId: order("REJSAME"),
    });
    expect(again.result).toBe("review");
    const row = await caseRow(again.caseId);
    expect(row.flags).toEqual(["previously rejected by a person"]);
    expect(row.reasons).toEqual([
      `A person rejected a refund for order ${order("REJSAME")} before (case ${before.caseId}).`,
    ]);
    const { data: o } = await db
      .from("orders")
      .select("refunded_at")
      .eq("id", order("REJSAME"))
      .single();
    expect(o!.refunded_at).toBeNull();
  });
});
