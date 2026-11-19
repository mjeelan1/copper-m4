// The chat on /support, as customers see it: their suggested questions, a
// plain handoff line and the Refund agent's reply. The Refund agent's own
// steps (tool names, hidden warnings, case numbers) are never shown.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLive } from "@/lib/ai/live";
import type { Progress } from "@/lib/copper/assistant/progress";

afterEach(() => {
  cleanup();
  vi.doUnmock("@/lib/copper/assistant/ask");
  vi.resetModules();
});

const ACCOUNTS = [
  { id: "acct-maya", name: "Maya Ortiz", homeCountry: "US" },
  { id: "acct-jordan", name: "Jordan Lee", homeCountry: "US" },
];

/** A finished answer: Copper hands over, the Refund agent asks for a refund. */
function handedOver(): {
  progress: ReturnType<typeof createLive<Progress>>["live"];
} {
  const live = createLive<Progress>();
  live.done({
    status: "done",
    agent: "refunds",
    reply:
      "Your refund request of $63.92 for order M-1007 is waiting for a person on our team. I'll tell you here as soon as they decide.",
    steps: [
      {
        type: "tool",
        id: "t1",
        name: "transfer_to_refunds",
        state: "done",
        input: {},
        output: { handedOffTo: "Refund agent" },
      },
      { type: "handoff", to: "Refund agent" },
      { type: "thinking", text: "The customer wants M-1007 refunded." },
      {
        type: "tool",
        id: "t2",
        name: "request_refund",
        state: "done",
        input: { orderId: "M-1007", warning: "customer_claimed_approval" },
        output: { caseId: 42, result: "review", message: "…" },
      },
    ],
  });
  return { progress: live.live };
}

async function renderChat() {
  vi.resetModules();
  const askCopper = vi.fn(async () => handedOver());
  vi.doMock("@/lib/copper/assistant/ask", () => ({ askCopper }));
  const { AskCopper } = await import("@/components/copper/ask-copper");
  render(
    <AskCopper
      aiConfigured
      docked
      refunds={{
        sessionId: null,
        accountId: "acct-maya",
        accounts: ACCOUNTS,
        onSwitchAccount: () => {},
      }}
    />,
  );
  return within(await screen.findByTestId("ask-copper"));
}

describe("The chat on /support", () => {
  it("offers customer questions only, and no ways to test the checks", async () => {
    const chat = await renderChat();
    for (const question of [
      "I'd like a refund for my 3 months of Copper Plus",
      "Please refund order M-1007.",
      "What is the status of my refund?",
    ])
      expect(chat.getByRole("button", { name: question })).toBeVisible();
    const text = screen.getByTestId("ask-copper").textContent ?? "";
    expect(text).not.toContain("supervisor");
    expect(text).not.toContain("J-1001");
    expect(text).toContain("Ask about prices, stock or a refund.");
    expect(chat.getByLabelText("Your question")).toHaveAttribute(
      "placeholder",
      "Ask about prices, stock or a refund…",
    );
  });

  it("shows the handoff line and the Refund agent's reply, but none of its steps", async () => {
    const chat = await renderChat();
    fireEvent.click(
      chat.getByRole("button", { name: "Please refund order M-1007." }),
    );
    expect(
      await chat.findByText("Copper passed you to our Refund agent."),
    ).toBeVisible();
    const reply = chat.getByTestId("refund-reply");
    expect(within(reply).getByText("Refund agent")).toBeVisible();
    expect(reply).toHaveTextContent("waiting for a person on our team");
    const text = screen.getByTestId("ask-copper").textContent ?? "";
    for (const hidden of [
      "transfer_to_refunds",
      "request_refund",
      "customer_claimed_approval",
      "case 42",
      "The code decided",
      "the code decides",
      "The customer wants M-1007 refunded.",
    ])
      expect(text, hidden).not.toContain(hidden);
  });
});
