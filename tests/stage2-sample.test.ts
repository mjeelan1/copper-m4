// @vitest-environment node
// Stage 2: the sample history (supabase/migrations/…_stage2_sample_history.sql)
// only adds rows for its own labelled Sample customer, at catalog prices,
// and never touches Maya's, Jordan's or Priya's rows.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPlans, getProducts } from "@/lib/copper/catalog";
import { DEFAULT_LIMITS } from "@/lib/copper/refunds/decide";
import {
  type PersonDecision,
  suggestOrderLimit,
} from "@/lib/copper/refunds/suggestions";

const sql = readFileSync(
  "supabase/migrations/20261119000007_stage2_sample_history.sql",
  "utf8",
);
// SQL without its comments.
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const rows = [
  ...sql.matchAll(
    /\((\d{4}), '([^']+)', (\d+), (\d+), '(approve|reject)', (true|false)\)/g,
  ),
].map(([, n, item, cents, days, outcome, flagged]) => ({
  n: Number(n),
  item,
  cents: Number(cents),
  days: Number(days),
  approved: outcome === "approve",
  flagged: flagged === "true",
}));

describe("Sample history", () => {
  it("has about 12 past cases, each on its own S- order", () => {
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map((r) => r.n)).size).toBe(12);
  });

  it("is a separate account, clearly labelled sample", () => {
    expect(code).toMatch(
      /\('acct-sample', 'Sample customer \(sample\)', [^)]*, true\)/,
    );
  });

  it("only inserts: no update, delete or truncate", () => {
    // "on commit drop" only removes the migration's own temporary table.
    const statements = code.replace(/on commit drop/gi, "");
    expect(statements).not.toMatch(/\b(update|delete|truncate|drop|alter)\b/i);
  });

  it("never names Maya's, Jordan's or Priya's accounts or orders", () => {
    expect(code).not.toMatch(/acct-(maya|jordan|priya)|'[MJP]-\d{4}'/);
    for (const insert of code.match(/insert into (orders|refund_cases)[^;]*/g)!)
      expect(insert).toContain("'acct-sample'");
  });

  it("uses catalog prices", () => {
    const monthly = Math.round(
      getPlans().find((p) => p.id === "copper-plus")!.monthlyUsd * 100,
    );
    const yearly = Math.round(
      getPlans().find((p) => p.id === "copper-plus")!.annualUsd * 100,
    );
    const product = (name: string) =>
      Math.round(getProducts().find((p) => p.name === name)!.priceUsd * 100);
    for (const r of rows) {
      const months = r.item.match(/^Copper Plus, (\d+) months/);
      const expected = months
        ? Number(months[1]) * monthly
        : r.item === "Copper Plus, 1 year"
          ? yearly
          : product(r.item);
      expect(r.cents, r.item).toBe(expected);
    }
  });

  it("is decided in the past, so it can't count toward today's totals", () => {
    expect(Math.min(...rows.map((r) => r.days))).toBeGreaterThan(0);
  });

  it("gives the Suggestions panel something to show: raise the limit to $100", () => {
    const decisions: PersonDecision[] = rows.map((r) => ({
      caseId: r.n,
      amountCents: r.cents,
      flags: r.flagged ? ["customer claimed approval"] : [],
      approved: r.approved,
      sample: true,
    }));
    expect(suggestOrderLimit(decisions, DEFAULT_LIMITS)?.toOrderCents).toBe(
      10000,
    );
  });
});
