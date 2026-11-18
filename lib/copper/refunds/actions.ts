"use server";

// The Server Actions the /support page calls from the browser: the chat's
// "Signed in as" switcher, the Customer simulator and the Refund Console.
// Each checks its input, then calls lib/copper/refunds/service.ts.
// Only reviewRefund() can approve a refund, and only a click in the console
// calls it: no agent tool reaches it.
import { z } from "zod";
import {
  type EvaluatorRun,
  runEvaluator,
} from "@/lib/copper/refunds/evaluator";
import {
  aiJudge,
  type EvaluationRow,
  evaluatorStore,
  recentEvaluations,
} from "@/lib/copper/refunds/evaluator-store";
import {
  type Account,
  chatUpdates,
  type ChatUpdate,
  consoleData,
  type ConsoleData,
  listAccounts,
  reviewCase,
  saveLimits,
  startSession,
  updateSignals,
} from "@/lib/copper/refunds/service";

const signals = z.strictObject({
  ip: z.string().trim().min(1).max(60),
  device: z.string().trim().min(1).max(60),
  browser: z.string().trim().min(1).max(60),
  country: z.string().trim().toUpperCase().length(2),
});

export async function getAccounts(): Promise<Account[]> {
  return listAccounts();
}

/** A new chat: the signed-in account and the simulator's signals. */
export async function startChatSession(
  accountId: string,
  input: z.input<typeof signals>,
): Promise<string> {
  return startSession(z.string().min(1).parse(accountId), signals.parse(input));
}

export async function updateChatSignals(
  sessionId: string,
  input: z.input<typeof signals>,
): Promise<void> {
  await updateSignals(z.uuid().parse(sessionId), signals.parse(input));
}

export async function getConsole(): Promise<ConsoleData> {
  return consoleData();
}

export async function reviewRefund(
  caseId: number,
  decision: "approve" | "reject",
): Promise<{ changed: boolean }> {
  return reviewCase(
    z.number().int().positive().parse(caseId),
    z.enum(["approve", "reject"]).parse(decision),
  );
}

export async function saveRefundLimits(input: {
  order: string;
  accountDaily: string;
  shopDaily: string;
}) {
  return saveLimits(
    z
      .object({
        order: z.string(),
        accountDaily: z.string(),
        shopDaily: z.string(),
      })
      .parse(input),
  );
}

/** A person's decisions on this chat's refunds, for the chat to show. */
export async function getChatUpdates(
  sessionId: string,
  afterId: number,
): Promise<ChatUpdate[]> {
  return chatUpdates(
    z.uuid().parse(sessionId),
    z.number().int().min(0).parse(afterId),
  );
}

// ---------- Stage 2: the evaluator ----------

/**
 * The "Run evaluator" button: checks up to 5 finished cases that haven't
 * been evaluated. Only a click runs it; it only writes its own verdicts.
 */
export async function runEvaluatorNow(): Promise<EvaluatorRun> {
  return runEvaluator(evaluatorStore, aiJudge);
}

export async function getEvaluations(): Promise<EvaluationRow[]> {
  return recentEvaluations();
}
