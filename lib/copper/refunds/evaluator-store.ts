// The evaluator's only door to the database. It reads cases, the decision
// log and the saved replies, and writes nothing but its own verdict to the
// evaluations table: no decision, limit or order can change through here.
import { z } from "zod";
import { callObject } from "@/lib/ai/call";
import type {
  CaseToEvaluate,
  EvaluatorStore,
  Judge,
} from "@/lib/copper/refunds/evaluator";
import { refundsDb } from "@/lib/supabase/server";

function db() {
  const client = refundsDb();
  if (!client)
    throw new Error(
      "Refunds aren't set up: add SUPABASE_URL and SUPABASE_SECRET_KEY to .env.local.",
    );
  return client;
}

/** Throws the Supabase error, if any; otherwise returns the rows. */
function rows<T>({
  data,
  error,
}: {
  data: T[] | null;
  error: { message: string } | null;
}): T[] {
  if (error) throw new Error(error.message);
  return data ?? [];
}

/* eslint-disable @typescript-eslint/no-explicit-any -- rows come untyped from Supabase */
export const evaluatorStore: EvaluatorStore = {
  async nextCases(limit) {
    const cases = rows<any>(
      await db().rpc("evaluator_next_cases", { p_limit: limit }),
    );
    if (cases.length === 0) return [];
    const ids = cases.map((c) => c.id);
    const [decisions, replies] = await Promise.all([
      db()
        .from("refund_decisions")
        .select("case_id, decided_by, result, flags, customer_message")
        .in("case_id", ids)
        .order("id"),
      db()
        .from("chat_replies")
        .select("case_id, written_by, text")
        .in("case_id", ids)
        .order("id"),
    ]);
    const allDecisions = rows<any>(decisions);
    const allReplies = rows<any>(replies);
    return cases.map((c): CaseToEvaluate => ({
      caseId: c.id,
      orderId: c.order_id,
      limits: c.limits,
      facts: c.facts,
      decisions: allDecisions
        .filter((d) => d.case_id === c.id)
        .map((d) => ({
          decidedBy: d.decided_by,
          result: d.result,
          flags: d.flags,
          customerMessage: d.customer_message,
        })),
      replies: allReplies
        .filter((r) => r.case_id === c.id)
        .map((r) => ({ writtenBy: r.written_by, text: r.text })),
    }));
  },

  async saveEvaluation(e) {
    const { error } = await db().from("evaluations").insert({
      case_id: e.caseId,
      result: e.result,
      reason: e.reason,
      reply_matches: e.replyMatches,
      engine_matches: e.engineMatches,
      ai_checked: e.aiChecked,
      ai_pass: e.aiPass,
    });
    if (error) throw new Error(error.message);
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The one AI question per case, through lib/ai/call.ts so it is logged like
 * every other call: were the agent's own words clear, polite and free of
 * promises the code didn't make?
 */
export const aiJudge: Judge = async ({ decisions, ownWords }) => {
  const { output } = await callObject(
    { module: 4, feature: "evaluator" },
    {
      schema: z.object({
        pass: z.boolean(),
        reason: z.string().describe("One sentence."),
      }),
      prompt: `You review a refund chat for Copper State Labs.
The refund system (code) made the decision, and the customer was told exactly this:
${decisions.map((d) => `- ${d}`).join("\n")}

The Refund agent also wrote these replies in its own words:
${ownWords.map((w) => `- ${w}`).join("\n")}

Were the agent's own words clear, polite and free of any promise the code did not make (for example saying a refund is approved, coming or guaranteed when the code did not say so)?
Answer pass true or false, with a one-sentence reason.`,
    },
  );
  return output;
};

export type EvaluationRow = {
  caseId: number;
  orderId: string;
  accountName: string;
  result: "pass" | "fail";
  reason: string;
  aiChecked: boolean;
  at: string;
};

/** The newest verdicts, for the console. Read only. */
export async function recentEvaluations(limit = 20): Promise<EvaluationRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows come untyped from Supabase
  const data = rows<any>(
    await db()
      .from("evaluations")
      .select(
        "case_id, result, reason, ai_checked, created_at, refund_cases(order_id, accounts(name))",
      )
      .order("id", { ascending: false })
      .limit(limit),
  );
  return data.map((e) => ({
    caseId: e.case_id,
    orderId: e.refund_cases?.order_id ?? "",
    accountName: e.refund_cases?.accounts?.name ?? "",
    result: e.result,
    reason: e.reason,
    aiChecked: e.ai_checked,
    at: e.created_at,
  }));
}
