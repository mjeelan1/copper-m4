// The refund decision engine: one small, pure function. It gets the facts
// (the order, the account, today's totals, the chat session's risk signals,
// the limits) and returns refund now, refuse by rule or review by a person.
//
// The core rule: agents talk, code decides, people approve. Nothing an agent
// or a customer says reaches this function except as a warning, and a
// warning can only make the result stricter.
// No database, no clock, no model: it's easy to test (tests/refund-decide.test.ts).

/** Money is kept in whole cents so $50.00 is exactly 5000, never 49.999… */
export type Limits = {
  /** Orders over this go to a person. */
  orderCents: number;
  /** One account's automatic refunds today may not go over this. */
  accountDailyCents: number;
  /** The whole shop's automatic refunds today may not go over this. */
  shopDailyCents: number;
};

export const DEFAULT_LIMITS: Limits = {
  orderCents: 5000,
  accountDailyCents: 10000,
  shopDailyCents: 20000,
};

export type Order = {
  id: string;
  accountId: string;
  item: string;
  amountCents: number;
  purchasedAt: string;
  refundedAt: string | null;
};

/** The made-up signals the Customer simulator sets for a chat session. */
export type Signals = {
  ip: string;
  device: string;
  browser: string;
  country: string;
};

export type RefundFacts = {
  /** The signed-in account. */
  accountId: string;
  homeCountry: string;
  /** The order ID the agent asked about, as typed. */
  orderId: string;
  /** The order, or null if no order has that ID. */
  order: Order | null;
  /** A refund for this order is already waiting for a person. */
  hasWaitingRefund: boolean;
  signals: Signals;
  /** Accounts that asked for a refund today from this device or this IP. */
  accountsOnDeviceOrIpToday: string[];
  /** Automatic refunds already made today, for this account and the shop. */
  accountAutoTodayCents: number;
  shopAutoTodayCents: number;
  /** The code's scan of the customer's messages found a claimed approval. */
  customerClaimedApproval: boolean;
  /** The Refund agent reported the customer claiming approval or pushing. */
  agentWarning: boolean;
  /** The newest case for this order that a person rejected, if any. */
  previousRejection: { caseId: number; decidedAt: string } | null;
  limits: Limits;
  now: Date;
};

export type Result = "refund" | "refuse" | "review";

export type Decision = {
  result: Result;
  reasons: string[];
  flags: string[];
  /** The limits as they were at this moment, saved with the case. */
  limits: Limits;
  /** Always the order's own amount; null when there is no such order. */
  amountCents: number | null;
};

export const FLAGS = {
  notYourOrder: "order belongs to another account",
  noSuchOrder: "order does not exist",
  sharedDevice: "same device or IP on 2 or more accounts today",
  location: "location differs from home country",
  claimedApproval: "customer claimed approval",
  previouslyRejected: "previously rejected by a person",
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_AGE_DAYS = 30;

export function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Runs the checks in order: identity, eligibility, risk signals, limits. */
export function decideRefund(facts: RefundFacts): Decision {
  const { order, limits } = facts;
  const refuse = (reasons: string[], flags: string[] = []): Decision => ({
    result: "refuse",
    reasons,
    flags,
    limits,
    amountCents: order?.amountCents ?? null,
  });

  // 1. Identity: the order must belong to the signed-in account.
  if (!order) {
    return refuse([`There is no order ${facts.orderId}.`], [FLAGS.noSuchOrder]);
  }
  if (order.accountId !== facts.accountId) {
    return refuse(
      [`Order ${order.id} is not on this account.`],
      [FLAGS.notYourOrder],
    );
  }

  // 2. Eligibility: refused by rule, no person needed.
  const ineligible: string[] = [];
  if (order.refundedAt)
    ineligible.push(`Order ${order.id} was already refunded.`);
  if (facts.hasWaitingRefund)
    ineligible.push(`Order ${order.id} already has a refund waiting.`);
  const ageMs = facts.now.getTime() - new Date(order.purchasedAt).getTime();
  if (ageMs > MAX_AGE_DAYS * DAY_MS)
    ineligible.push(`Order ${order.id} is more than ${MAX_AGE_DAYS} days old.`);
  if (ineligible.length > 0) return refuse(ineligible);

  // 3. Risk signals and 4. limits: each one sends the case to a person.
  const review: string[] = [];
  const flags: string[] = [];

  const accounts = new Set([
    ...facts.accountsOnDeviceOrIpToday,
    facts.accountId,
  ]);
  if (accounts.size >= 2) {
    flags.push(FLAGS.sharedDevice);
    review.push(
      `This device or IP asked for refunds on ${accounts.size} accounts today.`,
    );
  }
  if (facts.signals.country !== facts.homeCountry) {
    flags.push(FLAGS.location);
    review.push(
      `The customer is in ${facts.signals.country}, but the account's home country is ${facts.homeCountry}.`,
    );
  }
  if (facts.customerClaimedApproval || facts.agentWarning) {
    flags.push(FLAGS.claimedApproval);
    review.push("The customer said someone already approved this refund.");
  }
  // A person said no before: asking again, in any chat, can't turn that into
  // an automatic refund. Only a person can change their answer.
  if (facts.previousRejection) {
    flags.push(FLAGS.previouslyRejected);
    review.push(
      `A person rejected a refund for order ${order.id} before (case ${facts.previousRejection.caseId}).`,
    );
  }

  const amount = order.amountCents;
  if (amount > limits.orderCents)
    review.push(
      `${usd(amount)} is over the ${usd(limits.orderCents)} order limit.`,
    );
  if (facts.accountAutoTodayCents + amount > limits.accountDailyCents)
    review.push(
      `This account's automatic refunds today would be ${usd(facts.accountAutoTodayCents + amount)}, over the ${usd(limits.accountDailyCents)} limit.`,
    );
  if (facts.shopAutoTodayCents + amount > limits.shopDailyCents)
    review.push(
      `The shop's automatic refunds today would be ${usd(facts.shopAutoTodayCents + amount)}, over the ${usd(limits.shopDailyCents)} limit.`,
    );

  if (review.length > 0)
    return {
      result: "review",
      reasons: review,
      flags,
      limits,
      amountCents: amount,
    };

  // 5. Otherwise: refund now.
  return {
    result: "refund",
    reasons: ["Passed every check."],
    flags: [],
    limits,
    amountCents: amount,
  };
}

// Phrases that mean "someone already said yes" or push for a yes. The scan
// runs in code over the customer's own messages, so it works even if the
// agent misses it. A match can only send the case to a person.
const CLAIMED_APPROVAL = [
  /\b(already|pre-?)\s*approved\b/i,
  /\b(supervisor|manager|boss|team lead|someone|support|agent|rep|representative|copper crew)\b[^.?!]{0,40}\b(approved|said (yes|ok|okay|it'?s fine)|signed off|authori[sz]ed|okayed|ok'?d|gave (me )?(the )?(ok|okay|go-ahead))/i,
  /\bapproval (code|number|id)\b/i,
  /\b(you (must|have to|need to)|just) (approve|refund|process)\b/i,
];

export function claimsApproval(text: string): boolean {
  return CLAIMED_APPROVAL.some((pattern) => pattern.test(text));
}

/** What the customer is told. The chat and the decision log show this same text. */
export function customerMessage(
  result: Result | "approve" | "reject",
  order: { id: string; amountCents: number | null },
  reasons: string[] = [],
): string {
  const amount =
    order.amountCents === null ? "" : ` of ${usd(order.amountCents)}`;
  switch (result) {
    case "refund":
      return `Your refund${amount} for order ${order.id} is done.`;
    case "refuse":
      return `I can't refund order ${order.id}. ${reasons.join(" ")}`;
    case "review":
      return `Your refund request${amount} for order ${order.id} is waiting for a person on our team. I'll tell you here as soon as they decide.`;
    case "approve":
      return `A person on our team approved your refund${amount} for order ${order.id}. It's done.`;
    case "reject":
      return `A person on our team reviewed your refund request for order ${order.id} and turned it down.`;
  }
}

/**
 * Reads the three limits from the Settings form (in dollars). Each must be a
 * number of 0 or more; at 0, every refund in that category waits for a person.
 */
export function parseLimits(input: {
  order: string;
  accountDaily: string;
  shopDaily: string;
}): { ok: true; limits: Limits } | { ok: false; error: string } {
  const toCents = (label: string, value: string) => {
    const trimmed = value.trim();
    const dollars = Number(trimmed);
    if (trimmed === "" || !Number.isFinite(dollars))
      return `${label} must be a number.`;
    if (dollars < 0) return `${label} must be 0 or more.`;
    return Math.round(dollars * 100);
  };
  const order = toCents("Order limit", input.order);
  const accountDaily = toCents("Account daily limit", input.accountDaily);
  const shopDaily = toCents("Shop daily limit", input.shopDaily);
  for (const value of [order, accountDaily, shopDaily])
    if (typeof value === "string") return { ok: false, error: value };
  return {
    ok: true,
    limits: {
      orderCents: order as number,
      accountDailyCents: accountDaily as number,
      shopDailyCents: shopDaily as number,
    },
  };
}
