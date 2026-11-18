// Stage 2: the learning loop, in code only (no AI). It reads the cases a
// person decided and, when people keep approving the same kind of case,
// suggests a new per-order limit. A suggestion is only ever applied when a
// person clicks Accept, through the same checked path as the Settings form.
import { type Limits, usd } from "@/lib/copper/refunds/decide";

/** Amount bands, in cents. The top band has no upper edge. */
export const BANDS = [
  { label: "$0.01 to $25", fromCents: 1, toCents: 2500 },
  { label: "$25.01 to $50", fromCents: 2501, toCents: 5000 },
  { label: "$50.01 to $100", fromCents: 5001, toCents: 10000 },
  { label: "$100.01 to $200", fromCents: 10001, toCents: 20000 },
  { label: "Over $200", fromCents: 20001, toCents: null },
] as const;

export type Band = (typeof BANDS)[number];

/** A suggestion needs at least this many cases in a band... */
export const MIN_CASES = 5;
/** ...and at least this share of them approved by a person. */
export const MIN_APPROVAL = 0.8;

export const NO_FLAGS = "no flags";

/** One case a person decided, as read from the decision log. */
export type PersonDecision = {
  caseId: number;
  amountCents: number;
  flags: string[];
  approved: boolean;
  /** From the labelled Sample customer account. */
  sample: boolean;
};

export type Group = {
  flag: string;
  decided: number;
  approved: number;
  sample: number;
};

export type BandGroups = { band: Band; groups: Group[] };

export function bandOf(cents: number): Band {
  return BANDS.find(
    (b) => cents >= b.fromCents && (b.toCents === null || cents <= b.toCents),
  )!;
}

function tally(decisions: PersonDecision[], flag: string): Group {
  return {
    flag,
    decided: decisions.length,
    approved: decisions.filter((d) => d.approved).length,
    sample: decisions.filter((d) => d.sample).length,
  };
}

/** The cases a person decided, by amount band and then by flag. */
export function groupDecisions(decisions: PersonDecision[]): BandGroups[] {
  return BANDS.map((band) => {
    const inBand = decisions.filter((d) => bandOf(d.amountCents) === band);
    const flags = [...new Set(inBand.flatMap((d) => d.flags))].sort();
    return {
      band,
      groups: [
        tally(
          inBand.filter((d) => d.flags.length === 0),
          NO_FLAGS,
        ),
        ...flags.map((flag) =>
          tally(
            inBand.filter((d) => d.flags.includes(flag)),
            flag,
          ),
        ),
      ],
    };
  }).filter((b) => b.groups.some((g) => g.decided > 0));
}

export type Evidence = {
  band: string;
  decided: number;
  approved: number;
  /** Rounded, for display: 83 means 83%. */
  approvedPercent: number;
  sample: number;
  /** Flagged cases in the band, left out because a flag needs a person anyway. */
  flaggedLeftOut: number;
};

export type Suggestion = {
  key: string;
  fromOrderCents: number;
  toOrderCents: number;
  text: string;
  evidence: Evidence[];
};

export const suggestionKey = (from: number, to: number) =>
  `order-limit:${from}->${to}`;

/**
 * A new per-order limit, or null. Only cases above the current limit with no
 * flags count: those waited for a person only because of the order limit.
 * Bands are taken in order upward from the current limit, and each one must
 * have at least 5 such cases with at least 80% approved; the suggestion is
 * the top of the last band that does. Accepted or ignored suggestions
 * (`handled` keys) are not shown again.
 */
export function suggestOrderLimit(
  decisions: PersonDecision[],
  limits: Limits,
  handled: Set<string> = new Set(),
): Suggestion | null {
  const from = limits.orderCents;
  const above = decisions.filter((d) => d.amountCents > from);
  const evidence: Evidence[] = [];
  let to: number | null = null;
  for (const band of BANDS) {
    if (band.toCents === null || band.toCents <= from) continue;
    const inBand = above.filter((d) => bandOf(d.amountCents) === band);
    const clean = inBand.filter((d) => d.flags.length === 0);
    const approved = clean.filter((d) => d.approved).length;
    if (clean.length < MIN_CASES || approved / clean.length < MIN_APPROVAL)
      break;
    evidence.push({
      band: band.label,
      decided: clean.length,
      approved,
      approvedPercent: Math.round((approved / clean.length) * 100),
      sample: clean.filter((d) => d.sample).length,
      flaggedLeftOut: inBand.length - clean.length,
    });
    to = band.toCents;
  }
  if (to === null) return null;
  const key = suggestionKey(from, to);
  if (handled.has(key)) return null;
  return {
    key,
    fromOrderCents: from,
    toOrderCents: to,
    text: `Raise the per-order limit from ${usd(from)} to ${usd(to)}: people approved ${evidence
      .map((e) => `${e.approved} of ${e.decided} cases from ${e.band}`)
      .join(" and ")}.`,
    evidence,
  };
}

/**
 * Accepting fills in the Settings form for you: the new per-order limit and
 * the two daily limits as they are, in dollars. It is then saved by the same
 * saveLimits() the form uses, so the same rules apply (each a number of 0 or
 * more).
 */
export function acceptedLimitsInput(current: Limits, toOrderCents: number) {
  return {
    order: String(toOrderCents / 100),
    accountDaily: String(current.accountDailyCents / 100),
    shopDaily: String(current.shopDailyCents / 100),
  };
}
