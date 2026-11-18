// @vitest-environment node
// Stage 2 against the real Supabase project: the evaluator and the learning
// loop. Run it with npm run test:live (not part of npm test). Skipped
// without SUPABASE_URL and SUPABASE_SECRET_KEY.
// No Gemini calls: the AI judge is a stand-in that must not be called unless
// a reply is in the agent's own words.
// It makes its own account and orders ("t-<run>"), uses its own per-order
// limit ($60, so its suggestion can't clash with a real one), puts the
// limits back, and deletes every row it made.
import { existsSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Judge } from "@/lib/copper/refunds/evaluator";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const ready = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY,
);

const RUN = Date.now().toString(36).toUpperCase();
const ACCOUNT = `t-${RUN}-e`;
const REVIEWER = `test reviewer ${RUN}`;
const order = (name: string) => `T${RUN}-${name}`;
const ORDERS = ["CLEAN", "TAMPERED", "CHANGED", "OWN"];

type Service = typeof import("@/lib/copper/refunds/service");
type Store = typeof import("@/lib/copper/refunds/evaluator-store");
type Evaluator = typeof import("@/lib/copper/refunds/evaluator");
type Learning = typeof import("@/lib/copper/refunds/learning");
let service: Service;
let store: Store["evaluatorStore"];
let evaluator: Evaluator;
let learning: Learning;
let db: NonNullable<
  ReturnType<typeof import("@/lib/supabase/server").refundsDb>
>;
let savedLimits: { order: string; accountDaily: string; shopDaily: string };

let device = 0;
const signals = () => ({
  ip: `198.19.${++device}.${RUN.length}`,
  device: `test-stage2-${RUN}-${device}`,
  browser: "Test",
  country: "US",
});

/** A refund decided by the code, with the reply the chat would show. */
async function decided(name: string) {
  const session = await service.startSession(ACCOUNT, signals());
  const outcome = await service.requestRefund({
    sessionId: session,
    orderId: order(name),
  });
  return { session, ...outcome };
}

const neverAsked = () =>
  vi.fn<Judge>(async () => {
    throw new Error("The AI must not be asked about this case.");
  });

/** Everything the evaluator must leave alone, for this account. */
async function snapshot() {
  const [cases, decisions, orders, settings] = await Promise.all([
    db.from("refund_cases").select("*").eq("account_id", ACCOUNT).order("id"),
    db
      .from("refund_decisions")
      .select("*, refund_cases!inner(account_id)")
      .eq("refund_cases.account_id", ACCOUNT)
      .order("id"),
    db.from("orders").select("*").eq("account_id", ACCOUNT).order("id"),
    db.from("refund_settings").select("*"),
  ]);
  return JSON.stringify([
    cases.data,
    decisions.data,
    orders.data,
    settings.data,
  ]);
}

async function setLimits(
  order: number,
  accountDaily: number,
  shopDaily: number,
) {
  expect(
    await service.saveLimits({
      order: String(order),
      accountDaily: String(accountDaily),
      shopDaily: String(shopDaily),
    }),
  ).toEqual({ ok: true });
}

describe.skipIf(!ready)("Stage 2 against Supabase", () => {
  beforeAll(async () => {
    service = await import("@/lib/copper/refunds/service");
    store = (await import("@/lib/copper/refunds/evaluator-store"))
      .evaluatorStore;
    evaluator = await import("@/lib/copper/refunds/evaluator");
    learning = await import("@/lib/copper/refunds/learning");
    db = (await import("@/lib/supabase/server")).refundsDb()!;
    const { limits } = await service.consoleData();
    savedLimits = {
      order: String(limits.orderCents / 100),
      accountDaily: String(limits.accountDailyCents / 100),
      shopDaily: String(limits.shopDailyCents / 100),
    };
    await db.from("accounts").insert({
      id: ACCOUNT,
      name: `Test E ${RUN}`,
      email: "e@example.com",
      home_country: "US",
    });
    const { error } = await db.from("orders").insert(
      ORDERS.map((name) => ({
        id: order(name),
        account_id: ACCOUNT,
        item: "Copper Plus (test)",
        amount_cents: 799,
        purchased_at: new Date().toISOString(),
      })),
    );
    expect(error).toBeNull();
  });

  beforeEach(() => setLimits(50, 1_000_000, 1_000_000));

  afterAll(async () => {
    await service.saveLimits(savedLimits);
    await db.from("suggestion_actions").delete().eq("by_name", REVIEWER);
    const { data: cases } = await db
      .from("refund_cases")
      .select("id")
      .eq("account_id", ACCOUNT);
    const ids = (cases ?? []).map((c) => c.id);
    if (ids.length) {
      await db.from("chat_replies").delete().in("case_id", ids);
      await db.from("evaluations").delete().in("case_id", ids);
      await db.from("refund_decisions").delete().in("case_id", ids);
    }
    await db.from("refund_cases").delete().eq("account_id", ACCOUNT);
    await db.from("chat_sessions").delete().eq("account_id", ACCOUNT);
    await db.from("orders").delete().eq("account_id", ACCOUNT);
    await db.from("accounts").delete().eq("id", ACCOUNT);
    const { count } = await db
      .from("suggestion_actions")
      .select("id", { count: "exact", head: true })
      .eq("by_name", REVIEWER);
    expect(count, "every test row was deleted").toBe(0);
  });

  it("saves the engine's facts with each case, and passes a clean case without asking the AI", async () => {
    const { session, caseId, message } = await decided("CLEAN");
    await service.recordChatReplies(session, [
      { caseId, writtenBy: "code", text: message },
    ]);
    const [c] = await store.loadCases([caseId]);
    expect(c.facts).toMatchObject({ orderId: order("CLEAN") });
    const judge = neverAsked();
    const result = await evaluator.evaluateCase(c, judge);
    expect(result).toMatchObject({ result: "pass", aiChecked: false });
    expect(judge).not.toHaveBeenCalled();
  });

  it("catches a reply that differs from the decision log", async () => {
    const { session, caseId } = await decided("TAMPERED");
    await service.recordChatReplies(session, [
      { caseId, writtenBy: "code", text: "Your refund of $500.00 is done." },
    ]);
    const [c] = await store.loadCases([caseId]);
    const result = await evaluator.evaluateCase(c, neverAsked());
    expect(result).toMatchObject({ result: "fail", replyMatches: false });
  });

  it("catches a case the engine would now decide differently", async () => {
    const { session, caseId, message } = await decided("CHANGED");
    await service.recordChatReplies(session, [
      { caseId, writtenBy: "code", text: message },
    ]);
    // Change the saved facts behind the evaluator's back: a $149 order.
    const [c] = await store.loadCases([caseId]);
    c.facts.order!.amountCents = 14900;
    const result = await evaluator.evaluateCase(c, neverAsked());
    expect(result).toMatchObject({ result: "fail", engineMatches: false });
  });

  it("asks the AI once, only about the agent's own words", async () => {
    const { session, caseId, message } = await decided("OWN");
    await service.recordChatReplies(session, [
      { caseId, writtenBy: "code", text: message },
    ]);
    await service.recordChatReplies(session, [
      {
        caseId: await service.latestCaseId(session),
        writtenBy: "agent",
        text: "Glad I could help!",
      },
    ]);
    const [c] = await store.loadCases([caseId]);
    const judge = vi.fn<Judge>(async () => ({
      pass: true,
      reason: "Clear and polite.",
    }));
    const result = await evaluator.evaluateCase(c, judge);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0][0].ownWords).toEqual(["Glad I could help!"]);
    expect(result).toMatchObject({ result: "pass", aiChecked: true });
  });

  it("the evaluator writes only its verdicts: nothing else changes", async () => {
    const before = await snapshot();
    const { data: cases } = await db
      .from("refund_cases")
      .select("id")
      .eq("account_id", ACCOUNT);
    const loaded = await store.loadCases(cases!.map((c) => c.id));
    for (const c of loaded)
      await store.saveEvaluation(
        await evaluator.evaluateCase(c, async () => ({
          pass: true,
          reason: "Clear and polite.",
        })),
      );
    expect(await snapshot()).toBe(before);
    const { count } = await db
      .from("evaluations")
      .select("id", { count: "exact", head: true })
      .in(
        "case_id",
        cases!.map((c) => c.id),
      );
    expect(count).toBe(loaded.length);
  });

  it("the button's queue never holds more than 5 cases, and never sample or pre-Stage 2 cases", async () => {
    const { data: queue, error } = await db.rpc("evaluator_next_cases", {
      p_limit: 50,
    });
    expect(error).toBeNull();
    expect(queue!.length).toBeLessThanOrEqual(5);
    for (const c of queue!) {
      expect(c.facts).not.toBeNull();
      expect(c.account_id).not.toBe("acct-sample");
    }
  });

  it("Ignore hides the suggestion and changes nothing else", async () => {
    await setLimits(60, 1_000_000, 1_000_000);
    const before = await learning.learningData();
    expect(before.suggestion?.key).toBe("order-limit:6000->10000");
    const state = await snapshot();
    expect(
      await learning.ignoreSuggestion(before.suggestion!.key, REVIEWER),
    ).toEqual({ ok: true });
    const after = await learning.learningData();
    expect(after.suggestion).toBeNull();
    expect(after.limits).toEqual(before.limits);
    expect(await snapshot()).toBe(state);
    await db.from("suggestion_actions").delete().eq("by_name", REVIEWER);
  });

  it("Accept saves the new per-order limit through the Settings path and logs who and when", async () => {
    await setLimits(60, 1_000_000, 1_000_000);
    const { suggestion } = await learning.learningData();
    expect(suggestion?.toOrderCents).toBe(10000);
    expect(await learning.acceptSuggestion(suggestion!.key, REVIEWER)).toEqual({
      ok: true,
    });
    const { limits } = await service.consoleData();
    expect(limits).toEqual({
      orderCents: 10000,
      accountDailyCents: 100_000_000,
      shopDailyCents: 100_000_000,
    });
    const { data: logged } = await db
      .from("suggestion_actions")
      .select("action, by_name, from_order_cents, to_order_cents, created_at")
      .eq("by_name", REVIEWER);
    expect(logged).toEqual([
      expect.objectContaining({
        action: "accepted",
        by_name: REVIEWER,
        from_order_cents: 6000,
        to_order_cents: 10000,
      }),
    ]);
    // Accepting a suggestion that is no longer current changes nothing.
    expect(
      await learning.acceptSuggestion("order-limit:6000->10000", REVIEWER),
    ).toEqual({ ok: false, error: "This suggestion is no longer current." });
    expect((await service.consoleData()).limits.orderCents).toBe(10000);
  });

  it("the sample history only touches its own labelled account", async () => {
    const { data: sample } = await db
      .from("refund_cases")
      .select("order_id, account_id, accounts(is_sample, name)")
      .eq("account_id", "acct-sample");
    expect(sample!.length).toBe(12);
    for (const c of sample!) {
      expect(c.order_id).toMatch(/^S-\d{4}$/);
      expect(c.accounts).toMatchObject({
        is_sample: true,
        name: "Sample customer (sample)",
      });
    }
    // Maya, Jordan and Priya still have exactly their own six orders each.
    for (const [account, prefix] of [
      ["acct-maya", "M"],
      ["acct-jordan", "J"],
      ["acct-priya", "P"],
    ]) {
      const { data: orders } = await db
        .from("orders")
        .select("id")
        .eq("account_id", account)
        .order("id");
      expect(orders!.map((o) => o.id)).toEqual(
        [1001, 1002, 1003, 1004, 1005, 1006].map((n) => `${prefix}-${n}`),
      );
      const { data: wrong } = await db
        .from("refund_cases")
        .select("id")
        .eq("account_id", account)
        .like("order_id", "S-%");
      expect(wrong).toEqual([]);
    }
  });
});
