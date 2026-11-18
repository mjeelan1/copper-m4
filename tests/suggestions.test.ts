// @vitest-environment node
// Stage 2: the learning loop (lib/copper/refunds/suggestions.ts), offline.
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, parseLimits } from "@/lib/copper/refunds/decide";
import {
  acceptedLimitsInput,
  groupDecisions,
  NO_FLAGS,
  type PersonDecision,
  suggestionKey,
  suggestOrderLimit,
} from "@/lib/copper/refunds/suggestions";

let nextId = 1;
/** `approved` of `total` cases a person decided at `cents`, with `flags`. */
function cases(
  total: number,
  approved: number,
  cents: number,
  flags: string[] = [],
  sample = false,
): PersonDecision[] {
  return Array.from({ length: total }, (_, i) => ({
    caseId: nextId++,
    amountCents: cents,
    flags,
    approved: i < approved,
    sample,
  }));
}

describe("groupDecisions", () => {
  it("groups the cases a person decided by amount band, then by flag", () => {
    const groups = groupDecisions([
      ...cases(6, 5, 7900),
      ...cases(2, 0, 7900, ["customer claimed approval"]),
      ...cases(4, 3, 14900),
    ]);
    expect(groups.map((g) => g.band.label)).toEqual([
      "$50.01 to $100",
      "$100.01 to $200",
    ]);
    expect(groups[0].groups).toEqual([
      { flag: NO_FLAGS, decided: 6, approved: 5, sample: 0 },
      {
        flag: "customer claimed approval",
        decided: 2,
        approved: 0,
        sample: 0,
      },
    ]);
  });
});

describe("suggestOrderLimit", () => {
  it("suggests $100 when people approved 5 of 6 cases from $50.01 to $100, with the evidence", () => {
    const suggestion = suggestOrderLimit(
      [...cases(6, 5, 7900, [], true), ...cases(4, 3, 14900)],
      DEFAULT_LIMITS,
    );
    expect(suggestion).toMatchObject({
      key: suggestionKey(5000, 10000),
      fromOrderCents: 5000,
      toOrderCents: 10000,
      evidence: [
        {
          band: "$50.01 to $100",
          decided: 6,
          approved: 5,
          approvedPercent: 83,
          sample: 6,
          flaggedLeftOut: 0,
        },
      ],
    });
    expect(suggestion!.text).toContain("from $50.00 to $100.00");
  });

  it("needs at least 5 cases: 4 of 4 approved is not enough", () => {
    expect(suggestOrderLimit(cases(4, 4, 7900), DEFAULT_LIMITS)).toBeNull();
  });

  it("needs at least 80% approved: 4 of 5 is enough, 7 of 9 is not", () => {
    expect(suggestOrderLimit(cases(5, 4, 7900), DEFAULT_LIMITS)).not.toBeNull();
    expect(suggestOrderLimit(cases(9, 7, 7900), DEFAULT_LIMITS)).toBeNull();
  });

  it("leaves out flagged cases: a flag needs a person whatever the limit", () => {
    const suggestion = suggestOrderLimit(
      [
        ...cases(3, 3, 7900),
        ...cases(6, 6, 7900, ["customer claimed approval"]),
      ],
      DEFAULT_LIMITS,
    );
    expect(suggestion).toBeNull();
  });

  it("counts only cases above the current limit", () => {
    // These $29 cases waited for a person for another reason (daily totals).
    expect(suggestOrderLimit(cases(8, 8, 2900), DEFAULT_LIMITS)).toBeNull();
  });

  it("goes up band by band, never skipping one", () => {
    const both = [...cases(5, 5, 7900), ...cases(5, 5, 14900)];
    expect(suggestOrderLimit(both, DEFAULT_LIMITS)?.toOrderCents).toBe(20000);
    const gap = [...cases(2, 2, 7900), ...cases(5, 5, 14900)];
    expect(suggestOrderLimit(gap, DEFAULT_LIMITS)).toBeNull();
  });

  it("Ignore hides it: a handled suggestion isn't shown again", () => {
    const decisions = cases(6, 5, 7900);
    const key = suggestionKey(5000, 10000);
    expect(suggestOrderLimit(decisions, DEFAULT_LIMITS)?.key).toBe(key);
    expect(
      suggestOrderLimit(decisions, DEFAULT_LIMITS, new Set([key])),
    ).toBeNull();
  });

  it("once accepted, the new limit is the starting point", () => {
    const decisions = cases(6, 5, 7900);
    expect(
      suggestOrderLimit(decisions, { ...DEFAULT_LIMITS, orderCents: 10000 }),
    ).toBeNull();
  });
});

describe("Accept uses the Settings form's rules (0 or more)", () => {
  it("fills in only the per-order limit and keeps the daily limits", () => {
    expect(acceptedLimitsInput(DEFAULT_LIMITS, 10000)).toEqual({
      order: "100",
      accountDaily: "100",
      shopDaily: "200",
    });
    expect(parseLimits(acceptedLimitsInput(DEFAULT_LIMITS, 10000))).toEqual({
      ok: true,
      limits: { ...DEFAULT_LIMITS, orderCents: 10000 },
    });
  });

  it("accepts 0 and refuses a negative limit, like the form", () => {
    expect(parseLimits(acceptedLimitsInput(DEFAULT_LIMITS, 0)).ok).toBe(true);
    expect(parseLimits(acceptedLimitsInput(DEFAULT_LIMITS, -500))).toEqual({
      ok: false,
      error: "Order limit must be 0 or more.",
    });
  });
});
