import type { Metadata } from "next";
import { AskCopper } from "@/components/copper/ask-copper";
import { RefundConsole } from "@/components/copper/refunds/refund-console";
import { SiteHeader } from "@/components/copper/site-header";
import { SetupRequired } from "@/components/setup-required";
import { isAiConfigured } from "@/lib/ai/call";
import { isRefundsConfigured } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Support | Copper State Labs" };

export default function Support() {
  return (
    // Leaves room on the right for the docked chat.
    <div className="flex flex-1 flex-col lg:pr-[28rem]">
      <SiteHeader />
      <main
        data-testid="refund-console"
        className="mx-auto w-full max-w-5xl flex-1 space-y-6 px-4 py-8"
      >
        <h1 className="font-display text-3xl font-bold">Refund Console</h1>
        {isRefundsConfigured() ? (
          // The console and the chat share one chat session, so it holds both.
          <RefundConsole aiConfigured={isAiConfigured()} />
        ) : (
          <SetupRequired service="refunds" />
        )}
      </main>
      {!isRefundsConfigured() && (
        <AskCopper aiConfigured={isAiConfigured()} docked />
      )}
    </div>
  );
}
