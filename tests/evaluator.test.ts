// @vitest-environment node
// Stage 2: the evaluator (lib/copper/refunds/evaluator.ts), offline. Cases
// are built with the real decision engine; the store and the AI are fakes,
// so no database and no Gemini calls.
import { describe, expect, it, vi } from "vitest";
import {
  customerMessage,
  decideRefund,
  DEFAULT_LIMITS,
  type RefundFacts,
} from "@/lib/copper/refunds/decide";
import {
  type CaseToEvaluate,
  evaluateCase,
  type EvaluatorStore,
  type Judge,
  MAX_CASES_PER_RUN,
  runEvaluator,
} from "@/lib/copper/refunds/evaluator";

const NOW = new Date("2026-11-19T18:00:00Z");

function facts(change: Partial<RefundFacts> = {}): RefundFacts {
  return {
    accountId: "acct-maya",
    homeCountry: "US",
    orderId: "M-1001",
    order: {
      id: "M-1001",
      accountId: "acct-maya",
      item: "Copper Plus, 3 months ($7.99 a month)",
      amountCents: 2397,
      purchasedAt: "2026-11-15T18:00:00Z",
      refundedAt: null,
    },
    hasWaitingRefund: false,
    signals: { ip: "1.2.3.4", device: "d", browser: "b", country: "US" },
    accountsOnDeviceOrIpToday: [],
    accountAutoTodayCents: 0,
    shopAutoTodayCents: 0,
    customerClaimedApproval: false,
    agentWarning: false,
    previousRejection: null,
    limits: DEFAULT_LIMITS,
    now: NOW,
    ...change,
  };
}

/** A case as the app saves it: decided by the real engine, shown word for word. */
function decidedCase(change: Partial<RefundFacts> = {}): CaseToEvaluate {
  const f = facts(change);
  const decision = decideRefund(f);
  const text = customerMessage(
    decision.result,
    { id: f.orderId, amountCents: decision.amountCents },
    decision.reasons,
  );
  return {
    caseId: 1,
    orderId: f.orderId,
    limits: decision.limits,
    facts: { ...f, now: f.now.toISOString() },
    decisions: [
      {
        decidedBy: "code",
        result: decision.result,
        flags: decision.flags,
        customerMessage: text,
      },
    ],
    replies: [{ writtenBy: "code", text }],
  };
}

const judgeSays = (pass: boolean, reason = "Clear and polite.") =>
  vi.fn<Judge>(async () => ({ pass, reason }));

describe("evaluateCase", () => {
  it("passes a case whose reply is the log's text and the engine still agrees, without asking the AI", async () => {
    const judge = judgeSays(true);
    const result = await evaluateCase(decidedCase(), judge);
    expect(result).toMatchObject({
      result: "pass",
      replyMatches: true,
      engineMatches: true,
      aiChecked: false,
      aiPass: null,
    });
    expect(judge).not.toHaveBeenCalled();
  });

  it("catches a reply that differs from the decision log", async () => {
    const c = decidedCase();
    c.replies = [{ writtenBy: "code", text: "Your refund is approved!" }];
    const result = await evaluateCase(c, judgeSays(true));
    expect(result.result).toBe("fail");
    expect(result.replyMatches).toBe(false);
    expect(result.reason).toContain("exact words");
  });

  it("finds the log's text inside a reply that holds several messages", async () => {
    const c = decidedCase();
    c.replies = [
      {
        writtenBy: "code",
        text: `I can't refund order J-1001. It is not on this account.\n\n${c.decisions[0].customerMessage}`,
      },
    ];
    expect((await evaluateCase(c, judgeSays(true))).replyMatches).toBe(true);
  });

  it("catches a person's decision that never reached the customer", async () => {
    const c = decidedCase({ order: { ...facts().order!, amountCents: 14900 } });
    c.decisions.push({
      decidedBy: "person",
      result: "approve",
      flags: [],
      customerMessage: "A person on our team approved your refund…",
    });
    const result = await evaluateCase(c, judgeSays(true));
    expect(result.result).toBe("fail");
    expect(result.reason).toContain("person's decision");
  });

  it("catches a case the engine would now decide differently", async () => {
    // Logged as "refund now", but the limits saved at that moment say an
    // order of $23.97 must wait for a person.
    const c = decidedCase();
    c.limits = { ...DEFAULT_LIMITS, orderCents: 0 };
    const result = await evaluateCase(c, judgeSays(true));
    expect(result.result).toBe("fail");
    expect(result.engineMatches).toBe(false);
    expect(result.reason).toContain('now decides "review"');
  });

  it("uses the limits saved with the case, not today's", async () => {
    // Saved facts carry the old limits; the case's own snapshot wins.
    const c = decidedCase({ limits: { ...DEFAULT_LIMITS, orderCents: 0 } });
    c.limits = DEFAULT_LIMITS;
    c.decisions[0].result = "refund";
    c.decisions[0].flags = [];
    expect((await evaluateCase(c, judgeSays(true))).engineMatches).toBe(true);
  });

  it("asks the AI only about the agent's own words, once per case", async () => {
    const judge = judgeSays(true);
    const c = decidedCase();
    c.replies.push(
      { writtenBy: "agent", text: "Anything else I can help with?" },
      { writtenBy: "agent", text: "Have a great day!" },
    );
    const result = await evaluateCase(c, judge);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge).toHaveBeenCalledWith({
      decisions: [c.decisions[0].customerMessage],
      ownWords: ["Anything else I can help with?", "Have a great day!"],
    });
    expect(result).toMatchObject({
      result: "pass",
      aiChecked: true,
      aiPass: true,
    });
  });

  it("fails a case when the AI finds a promise the code didn't make", async () => {
    const c = decidedCase();
    c.replies.push({ writtenBy: "agent", text: "Don't worry, it's approved." });
    const result = await evaluateCase(
      c,
      judgeSays(false, "It promises an approval."),
    );
    expect(result).toMatchObject({ result: "fail", aiPass: false });
    expect(result.reason).toContain("It promises an approval.");
  });
});

describe("runEvaluator (the Run evaluator button)", () => {
  function fakeStore(count: number) {
    const saved: unknown[] = [];
    const store: EvaluatorStore = {
      nextCases: vi.fn(async () =>
        // A store that ignores the limit: the evaluator must still stop at 5.
        Array.from({ length: count }, (_, i) => ({
          ...decidedCase(),
          caseId: i + 1,
        })),
      ),
      saveEvaluation: vi.fn(async (e) => {
        saved.push(e);
      }),
    };
    return { store, saved };
  }

  it("never processes more than 5 cases", async () => {
    const { store, saved } = fakeStore(8);
    const run = await runEvaluator(store, judgeSays(true));
    expect(MAX_CASES_PER_RUN).toBe(5);
    expect(store.nextCases).toHaveBeenCalledWith(5);
    expect(run.evaluated).toHaveLength(5);
    expect(saved).toHaveLength(5);
  });

  it("with nothing to check, does nothing", async () => {
    const { store, saved } = fakeStore(0);
    const run = await runEvaluator(store, judgeSays(true));
    expect(run).toEqual({ evaluated: [], skipped: [] });
    expect(saved).toHaveLength(0);
  });

  it("when the AI can't answer, skips the case and saves nothing for it", async () => {
    const { store, saved } = fakeStore(1);
    vi.mocked(store.nextCases).mockResolvedValueOnce([
      {
        ...decidedCase(),
        replies: [
          ...decidedCase().replies,
          { writtenBy: "agent", text: "Hi!" },
        ],
      },
    ]);
    const run = await runEvaluator(
      store,
      vi.fn<Judge>(async () => {
        throw new Error("quota exceeded");
      }),
    );
    expect(run.skipped).toEqual([{ caseId: 1, reason: "quota exceeded" }]);
    expect(saved).toHaveLength(0);
  });
});
