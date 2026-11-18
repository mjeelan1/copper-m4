"use server";

// The server action the Ask Copper chat calls. It streams the conversation to
// the model through callStream (lib/ai/call.ts), with or without the tools,
// and sends back each step as it happens, so the panel can show Copper
// thinking and using its tools.
// On /support (Module 4) the chat has a session: Copper can hand it to the
// Refund agent, which then answers every later question in that chat.
import { hasToolCall, stepCountIs } from "ai";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { createLive, type Live } from "@/lib/ai/live";
import {
  COPPER_INSTRUCTIONS,
  HANDOFF_INSTRUCTIONS,
} from "@/lib/copper/assistant/instructions";
import type { Progress, ToolStep } from "@/lib/copper/assistant/progress";
import { copperTools } from "@/lib/copper/assistant/tools";
import {
  handoffTools,
  REFUND_INSTRUCTIONS,
  refundTools,
} from "@/lib/copper/refunds/agent";
import { claimsApproval } from "@/lib/copper/refunds/decide";
import { getSession, noteClaimedApproval } from "@/lib/copper/refunds/service";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskCopperRequest = {
  messages: ChatMessage[];
  useTools: boolean;
  /** The chat session on /support. Without one there are no refunds. */
  sessionId?: string;
};

export type AskCopperResult = { progress: Live<Progress> };

/** At most this many model steps (tool calls plus the reply) per question. */
const MAX_STEPS = 5;

const SORRY = "Sorry, something went wrong on my end. Please try again.";

/** The Refund agent's tools whose result is the reply, word for word. */
const DECISION_TOOLS = ["request_refund", "check_refund_status"];

export async function askCopper({
  messages,
  useTools,
  sessionId,
}: AskCopperRequest): Promise<AskCopperResult> {
  const { live, update, done } = createLive<Progress>();
  const progress: Progress = {
    steps: [],
    reply: "",
    status: "working",
    agent: "copper",
  };
  // A fresh copy each time, so earlier updates never change underneath the
  // panel.
  const snapshot = (): Progress => ({
    ...progress,
    steps: progress.steps.map((step) => ({ ...step })),
  });
  const send = () => update(snapshot());
  const toolSteps = () =>
    progress.steps.filter((step): step is ToolStep => step.type === "tool");

  // Read the stream in the background, so the panel gets the first update now.
  void (async () => {
    try {
      // Refunds only happen on /support, where the chat has a session that
      // knows who is signed in.
      const session =
        useTools && sessionId ? await getSession(sessionId) : null;
      if (session) {
        // The code's own scan for "a supervisor already approved this". It
        // doesn't depend on the agent noticing, and once set it stays set.
        const claimed = messages.some(
          (m) => m.role === "user" && claimsApproval(m.content),
        );
        if (claimed && !session.claimedApproval)
          await noteClaimedApproval(session.id);
      }

      if (session?.agent !== "refunds") {
        // Without tools, send no instructions either: "always use your tools"
        // with no tools makes the model answer with nothing.
        await readInto(
          callStream(
            { module: 2, feature: "ask-copper" },
            {
              messages,
              providerOptions: THOUGHT_SUMMARIES,
              ...(useTools && {
                instructions: session
                  ? `${COPPER_INSTRUCTIONS}\n\n${HANDOFF_INSTRUCTIONS}`
                  : COPPER_INSTRUCTIONS,
                tools: session
                  ? { ...copperTools, ...handoffTools(session.id) }
                  : copperTools,
                stopWhen: [
                  stepCountIs(MAX_STEPS),
                  hasToolCall("transfer_to_refunds"),
                ],
              }),
            },
          ),
          progress,
          send,
        );
        const handedOff = toolSteps().some(
          (step) =>
            step.name === "transfer_to_refunds" && step.state === "done",
        );
        if (!handedOff) return finish();
        // The handoff: the Refund agent takes the same conversation.
        progress.steps.push({ type: "handoff", to: "Refund agent" });
        progress.reply = "";
        send();
      }

      progress.agent = "refunds";
      await readInto(
        callStream(
          { module: 4, feature: "refund-agent" },
          {
            messages,
            providerOptions: THOUGHT_SUMMARIES,
            instructions: REFUND_INSTRUCTIONS,
            tools: refundTools(session!.id),
            stopWhen: [stepCountIs(MAX_STEPS), hasToolCall(...DECISION_TOOLS)],
          },
        ),
        progress,
        send,
      );
      // After a refund request or a status check, the reply is the code's
      // message, exactly as saved in the decision log, never the model's
      // retelling of it.
      const official = toolSteps()
        .filter((s) => DECISION_TOOLS.includes(s.name) && s.state === "done")
        .map((s) => (s.output as { message: string }).message);
      if (official.length > 0) progress.reply = official.join("\n\n");
      finish();
    } catch (error) {
      // The customer sees "Sorry"; the reason goes to the terminal.
      console.error(
        "[ask-copper]",
        error instanceof Error ? error.message : String(error),
      );
      progress.status = "error";
      if (!progress.reply.trim()) progress.reply = SORRY;
      done(snapshot());
    }

    function finish() {
      progress.status = "done";
      if (!progress.reply.trim()) progress.reply = SORRY;
      done(snapshot());
    }
  })();

  return { progress: live };
}

/** Reads one agent's stream into `progress`, calling `send` after each part. */
async function readInto(
  result: ReturnType<typeof callStream>,
  progress: Progress,
  send: () => void,
) {
  const toolStep = (id: string) =>
    progress.steps.find(
      (step): step is ToolStep => step.type === "tool" && step.id === id,
    );
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "reasoning-delta": {
        const last = progress.steps.at(-1);
        if (last?.type === "thinking") last.text += part.text;
        else progress.steps.push({ type: "thinking", text: part.text });
        break;
      }
      case "tool-input-start":
        progress.steps.push({
          type: "tool",
          id: part.id,
          name: part.toolName,
          state: "calling",
        });
        break;
      case "tool-call": {
        const step = toolStep(part.toolCallId);
        if (step) step.input = part.input;
        else
          progress.steps.push({
            type: "tool",
            id: part.toolCallId,
            name: part.toolName,
            state: "calling",
            input: part.input,
          });
        break;
      }
      case "tool-result": {
        const step = toolStep(part.toolCallId);
        if (step) Object.assign(step, { output: part.output, state: "done" });
        break;
      }
      case "tool-error": {
        const step = toolStep(part.toolCallId);
        const message =
          part.error instanceof Error ? part.error.message : String(part.error);
        if (step) Object.assign(step, { output: message, state: "error" });
        break;
      }
      case "text-delta":
        progress.reply += part.text;
        break;
      case "error":
        throw part.error;
      default:
        continue;
    }
    send();
  }
}
