// Stage 2: the evaluator. It checks finished cases after the fact and only
// writes its own verdicts: it never changes a decision, a limit or an order.
// Runs only when someone clicks "Run evaluator" in the Refund Console.
//
// For each case:
//  (a) code: the customer was shown exactly the decision log's text;
//  (b) code: the decision engine, run again on the facts and the limits
//      saved at that moment, still gives the same result and flags;
//  (c) AI, at most one question, and only if the Refund agent wrote
//      something in its own words: was it clear, polite and free of
//      promises the code didn't make?
// The database side (store) and the AI (judge) are passed in, so the checks
// can be tested offline.
import {
  decideRefund,
  type Limits,
  type Result,
} from "@/lib/copper/refunds/decide";
import type { SavedFacts } from "@/lib/copper/refunds/service";

/** The most cases one click of "Run evaluator" checks. */
export const MAX_CASES_PER_RUN = 5;

export type LoggedDecision = {
  decidedBy: "code" | "person";
  result: Result | "approve" | "reject";
  flags: string[];
  customerMessage: string;
};

export type CaseToEvaluate = {
  caseId: number;
  orderId: string;
  /** The limits saved with the case at the moment it was decided. */
  limits: Limits;
  facts: SavedFacts;
  decisions: LoggedDecision[];
  /** What the customer was shown about this case. */
  replies: { writtenBy: "code" | "agent"; text: string }[];
};

export type Verdict = { pass: boolean; reason: string };

/** The one AI question: the decisions' texts and the agent's own words. */
export type Judge = (input: {
  decisions: string[];
  ownWords: string[];
}) => Promise<Verdict>;

export type Evaluation = {
  caseId: number;
  result: "pass" | "fail";
  reason: string;
  replyMatches: boolean;
  engineMatches: boolean;
  aiChecked: boolean;
  aiPass: boolean | null;
};

export type EvaluatorStore = {
  /** Read only: up to `limit` finished cases that haven't been evaluated. */
  nextCases(limit: number): Promise<CaseToEvaluate[]>;
  /** The evaluator's only write: its verdict on one case. */
  saveEvaluation(evaluation: Evaluation): Promise<void>;
};

/** A reply may hold several messages, one per paragraph. */
const paragraphs = (text: string) =>
  text.split(/\n\n/).map((part) => part.trim());

/** (a) Every decision on the case reached the customer word for word. */
function checkReplies(c: CaseToEvaluate): Verdict {
  const shown = c.replies
    .filter((r) => r.writtenBy === "code")
    .flatMap((r) => paragraphs(r.text));
  for (const decision of c.decisions) {
    if (!shown.includes(decision.customerMessage.trim()))
      return {
        pass: false,
        reason:
          decision.decidedBy === "person"
            ? "The customer was never shown the person's decision in the decision log's exact words."
            : "The customer was not shown the code's decision in the decision log's exact words.",
      };
  }
  return { pass: true, reason: "" };
}

/** (b) The engine, run again on the saved facts and limits, agrees. */
function checkEngine(c: CaseToEvaluate): Verdict {
  const logged = c.decisions.find((d) => d.decidedBy === "code");
  if (!logged)
    return { pass: false, reason: "The case has no decision by the code." };
  const again = decideRefund({
    ...c.facts,
    limits: c.limits,
    now: new Date(c.facts.now),
  });
  const sameFlags =
    [...again.flags].sort().join("|") === [...logged.flags].sort().join("|");
  if (again.result !== logged.result || !sameFlags)
    return {
      pass: false,
      reason: `Run again on the saved facts, the engine now decides "${again.result}" with flags [${again.flags.join(", ")}], not "${logged.result}" with [${logged.flags.join(", ")}].`,
    };
  return { pass: true, reason: "" };
}

/** Checks one case. Calls the judge at most once, and only for own words. */
export async function evaluateCase(
  c: CaseToEvaluate,
  judge: Judge,
): Promise<Evaluation> {
  const replies = checkReplies(c);
  const engine = checkEngine(c);
  const ownWords = c.replies
    .filter((r) => r.writtenBy === "agent")
    .map((r) => r.text);
  const ai =
    ownWords.length > 0
      ? await judge({
          decisions: c.decisions.map((d) => d.customerMessage),
          ownWords,
        })
      : null;

  const failed = [replies, engine, ...(ai ? [ai] : [])].find((v) => !v.pass);
  const reason = failed
    ? failed === ai
      ? `The AI check failed the agent's own words: ${ai.reason}`
      : failed.reason
    : ai
      ? `The customer got the decision log's exact text, the engine still agrees, and the agent's own words passed the AI check.`
      : `The customer got the decision log's exact text and the engine still agrees.`;
  return {
    caseId: c.caseId,
    result: failed ? "fail" : "pass",
    reason,
    replyMatches: replies.pass,
    engineMatches: engine.pass,
    aiChecked: ai !== null,
    aiPass: ai ? ai.pass : null,
  };
}

export type EvaluatorRun = {
  evaluated: Evaluation[];
  /** Cases left for next time, for example because the AI couldn't answer. */
  skipped: { caseId: number; reason: string }[];
};

/** One click of "Run evaluator": at most 5 cases, each checked once. */
export async function runEvaluator(
  store: EvaluatorStore,
  judge: Judge,
): Promise<EvaluatorRun> {
  const cases = (await store.nextCases(MAX_CASES_PER_RUN)).slice(
    0,
    MAX_CASES_PER_RUN,
  );
  const run: EvaluatorRun = { evaluated: [], skipped: [] };
  for (const c of cases) {
    try {
      const evaluation = await evaluateCase(c, judge);
      await store.saveEvaluation(evaluation);
      run.evaluated.push(evaluation);
    } catch (error) {
      // Not saved, so it stays in the queue for the next run.
      run.skipped.push({
        caseId: c.caseId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return run;
}
