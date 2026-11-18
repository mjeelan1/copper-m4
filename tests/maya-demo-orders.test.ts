// @vitest-environment node
// Maya's two extra demo orders (supabase/migrations/…_maya_demo_orders.sql):
// over $50, at catalog prices, and each one together with the $23.97 refund
// of M-1001 stays within the $100 daily account limit, so the demo shows
// the order limit and nothing else.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPlans } from "@/lib/copper/catalog";
import {
  decideRefund,
  DEFAULT_LIMITS,
  type RefundFacts,
} from "@/lib/copper/refunds/decide";

const sql = readFileSync(
  "supabase/migrations/20261120000008_maya_demo_orders.sql",
  "utf8",
);
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const orders = [
  ...code.matchAll(
    /\('(M-\d{4})', '(acct-\w+)', 'Copper Plus, (\d+) months \(\$7\.99 a month\)', (\d+),/g,
  ),
].map(([, id, account, months, cents]) => ({
  id,
  account,
  months: Number(months),
  cents: Number(cents),
}));

const NOW = new Date("2026-11-20T18:00:00Z");
const facts = (cents: number, autoToday: number): RefundFacts => ({
  accountId: "acct-maya",
  homeCountry: "US",
  orderId: "M-1007",
  order: {
    id: "M-1007",
    accountId: "acct-maya",
    item: "Copper Plus",
    amountCents: cents,
    purchasedAt: "2026-11-18T18:00:00Z",
    refundedAt: null,
  },
  hasWaitingRefund: false,
  signals: {
    ip: "198.51.100.23",
    device: "laptop-4821",
    browser: "Chrome 142",
    country: "US",
  },
  accountsOnDeviceOrIpToday: [],
  accountAutoTodayCents: autoToday,
  shopAutoTodayCents: autoToday,
  customerClaimedApproval: false,
  agentWarning: false,
  previousRejection: null,
  limits: DEFAULT_LIMITS,
  now: NOW,
});

describe("Maya's demo orders", () => {
  it("adds M-1007 and M-1008 to Maya only, and only inserts", () => {
    expect(orders.map((o) => [o.id, o.account])).toEqual([
      ["M-1007", "acct-maya"],
      ["M-1008", "acct-maya"],
    ]);
    expect(code).not.toMatch(/\b(update|delete|truncate|drop|alter)\b/i);
  });

  it("uses catalog prices", () => {
    const monthly = Math.round(
      getPlans().find((p) => p.id === "copper-plus")!.monthlyUsd * 100,
    );
    for (const o of orders) expect(o.cents).toBe(o.months * monthly);
  });

  it("goes to review for the order limit alone, even after the $23.97 refund", () => {
    for (const o of orders) {
      expect(o.cents).toBeGreaterThan(5000);
      const decision = decideRefund(facts(o.cents, 2397));
      expect(decision.result).toBe("review");
      expect(decision.flags).toEqual([]);
      expect(decision.reasons).toEqual([
        `$${(o.cents / 100).toFixed(2)} is over the $50.00 order limit.`,
      ]);
    }
  });
});
