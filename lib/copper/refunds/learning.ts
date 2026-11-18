// Stage 2: the learning loop's server side. Reads the decision log, works
// out the suggestion in code (suggestions.ts), and records Accept or Ignore.
// Accept saves the new limit through saveLimits(), the same checked path
// the Settings form uses. Nothing here runs by itself.
import type { Limits } from "@/lib/copper/refunds/decide";
import { consoleData, saveLimits } from "@/lib/copper/refunds/service";
import {
  acceptedLimitsInput,
  type BandGroups,
  groupDecisions,
  type PersonDecision,
  type Suggestion,
  suggestOrderLimit,
} from "@/lib/copper/refunds/suggestions";
import { refundsDb } from "@/lib/supabase/server";

function db() {
  const client = refundsDb();
  if (!client)
    throw new Error(
      "Refunds aren't set up: add SUPABASE_URL and SUPABASE_SECRET_KEY to .env.local.",
    );
  return client;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- rows come untyped from Supabase */
function rows({
  data,
  error,
}: {
  data: any[] | null;
  error: { message: string } | null;
}): any[] {
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Every case a person decided, read from the decision log. */
export async function personDecisions(): Promise<PersonDecision[]> {
  const logged = rows(
    await db()
      .from("refund_decisions")
      .select(
        "case_id, result, refund_cases(amount_cents, flags, accounts(is_sample))",
      )
      .eq("decided_by", "person"),
  );
  return logged
    .filter((d) => d.refund_cases?.amount_cents != null)
    .map((d) => ({
      caseId: d.case_id,
      amountCents: d.refund_cases.amount_cents,
      flags: d.refund_cases.flags,
      approved: d.result === "approve",
      sample: Boolean(d.refund_cases.accounts?.is_sample),
    }));
}

export type SuggestionAction = {
  key: string;
  action: "accepted" | "ignored";
  byName: string;
  fromOrderCents: number;
  toOrderCents: number;
  at: string;
};

async function suggestionActions(): Promise<SuggestionAction[]> {
  return rows(
    await db()
      .from("suggestion_actions")
      .select(
        "suggestion_key, action, by_name, from_order_cents, to_order_cents, created_at",
      )
      .order("id", { ascending: false }),
  ).map((a) => ({
    key: a.suggestion_key,
    action: a.action,
    byName: a.by_name,
    fromOrderCents: a.from_order_cents,
    toOrderCents: a.to_order_cents,
    at: a.created_at,
  }));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export type LearningData = {
  limits: Limits;
  groups: BandGroups[];
  suggestion: Suggestion | null;
  history: SuggestionAction[];
};

export async function learningData(): Promise<LearningData> {
  const [{ limits }, decisions, history] = await Promise.all([
    consoleData(),
    personDecisions(),
    suggestionActions(),
  ]);
  return {
    limits,
    groups: groupDecisions(decisions),
    suggestion: suggestOrderLimit(
      decisions,
      limits,
      new Set(history.map((h) => h.key)),
    ),
    history,
  };
}

type Outcome = { ok: true } | { ok: false; error: string };

/** The suggestion as it stands now, worked out again on the server. */
async function current(key: string) {
  const data = await learningData();
  if (!data.suggestion || data.suggestion.key !== key) return null;
  return { suggestion: data.suggestion, limits: data.limits };
}

async function record(
  action: "accepted" | "ignored",
  suggestion: Suggestion,
  byName: string,
) {
  const { error } = await db().from("suggestion_actions").insert({
    suggestion_key: suggestion.key,
    action,
    by_name: byName,
    from_order_cents: suggestion.fromOrderCents,
    to_order_cents: suggestion.toOrderCents,
    evidence: suggestion.evidence,
  });
  if (error) throw new Error(error.message);
}

/** Accept: saves the new limit like the Settings form, then logs who and when. */
export async function acceptSuggestion(
  key: string,
  byName: string,
): Promise<Outcome> {
  const now = await current(key);
  if (!now)
    return { ok: false, error: "This suggestion is no longer current." };
  const saved = await saveLimits(
    acceptedLimitsInput(now.limits, now.suggestion.toOrderCents),
  );
  if (!saved.ok) return saved;
  await record("accepted", now.suggestion, byName);
  return { ok: true };
}

/** Ignore: hides the suggestion. Changes no limit, case or order. */
export async function ignoreSuggestion(
  key: string,
  byName: string,
): Promise<Outcome> {
  const now = await current(key);
  if (!now)
    return { ok: false, error: "This suggestion is no longer current." };
  await record("ignored", now.suggestion, byName);
  return { ok: true };
}
