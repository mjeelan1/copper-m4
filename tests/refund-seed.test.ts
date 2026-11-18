// @vitest-environment node
// The made-up orders (supabase/migrations/…_refunds_catalog_prices.sql) must
// use what Copper sells, at the catalog's prices, so refunds match the shop.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPlans, getProducts } from "@/lib/copper/catalog";

const sql = readFileSync(
  "supabase/migrations/20261117000004_refunds_catalog_prices.sql",
  "utf8",
);
const rows = [...sql.matchAll(/\('(\d{4})', '([^']+)', (\d+)\)/g)].map(
  ([, n, item, cents]) => ({ n, item, cents: Number(cents) }),
);

const cents = (usd: number) => Math.round(usd * 100);
const product = (name: string) => getProducts().find((p) => p.name === name)!;
const plusMonthly = getPlans().find((p) => p.id === "copper-plus")!.monthlyUsd;

/** What the customer paid for an item, worked out from the catalog. */
function catalogCents(item: string): number {
  const months = item.match(/^Copper Plus, (\d+) months?/);
  if (months) return Number(months[1]) * cents(plusMonthly);
  const discounted = item.match(
    /^(.+) \(\$(\d+)\) with a \$(\d+) discount code$/,
  );
  if (discounted) {
    expect(cents(product(discounted[1]).priceUsd)).toBe(
      cents(Number(discounted[2])),
    );
    return cents(Number(discounted[2]) - Number(discounted[3]));
  }
  return cents(product(item).priceUsd);
}

describe("Refund demo orders", () => {
  it("has the six kinds of order", () => {
    expect(rows.map((r) => r.n)).toEqual([
      "1001",
      "1002",
      "1003",
      "1004",
      "1005",
      "1006",
    ]);
  });

  it.each(rows)("$item costs what the catalog says", ({ item, cents }) => {
    expect(cents).toBe(catalogCents(item));
  });

  it("covers under $50, exactly $50 and over $50", () => {
    const amounts = rows.map((r) => r.cents);
    expect(amounts.some((a) => a < 5000)).toBe(true);
    expect(amounts).toContain(5000);
    expect(amounts.some((a) => a > 5000)).toBe(true);
  });
});
