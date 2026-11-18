"use client";

// The Refund Console on /support, with Ask Copper docked beside it.
// - Waiting reviews: only an Approve click here approves a refund.
// - Customer simulator: the made-up IP, device, browser and location of the
//   chat, so you can play a bad actor (the same device on two accounts).
// - Settings: the three limits.
// - Decision log: every decision, by the code or by a person.
// It refreshes every few seconds, so new cases show up on their own.
import { useCallback, useEffect, useRef, useState } from "react";
import { AskCopper } from "@/components/copper/ask-copper";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getAccounts,
  getConsole,
  reviewRefund,
  saveRefundLimits,
  startChatSession,
  updateChatSignals,
} from "@/lib/copper/refunds/actions";
import { type Limits, type Signals, usd } from "@/lib/copper/refunds/decide";
import type { Account, ConsoleData } from "@/lib/copper/refunds/service";

/** An ordinary shopper at home in the US, until the simulator says otherwise. */
const START_SIGNALS: Signals = {
  ip: "198.51.100.23",
  device: "laptop-4821",
  browser: "Chrome 142",
  country: "US",
};

export function RefundConsole({ aiConfigured }: { aiConfigured: boolean }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [signals, setSignals] = useState(START_SIGNALS);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [data, setData] = useState<ConsoleData | null>(null);
  const [problem, setProblem] = useState("");

  const refresh = useCallback(async () => {
    try {
      setData(await getConsole());
      setProblem("");
    } catch {
      setProblem("Can't reach Supabase right now. Retrying…");
    }
  }, []);

  // Sign in and start the chat, once. (In development React runs effects
  // twice, which would start two chat sessions.)
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const list = await getAccounts();
        setAccounts(list);
        // Maya first: the chat's example questions are about her orders.
        const first = list.find((a) => a.id === "acct-maya") ?? list[0];
        setAccountId(first.id);
        setSessionId(await startChatSession(first.id, START_SIGNALS));
      } catch {
        setProblem("Can't reach Supabase right now. Reload to try again.");
      }
    })();
  }, []);

  useEffect(() => {
    // The first refresh runs from the timer too, so no state is set while
    // this effect runs.
    const first = setTimeout(refresh, 0);
    const timer = setInterval(refresh, 3000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  /** Signing in as someone else starts a new chat with the same signals. */
  async function switchAccount(id: string) {
    setAccountId(id);
    setSessionId(null);
    setSessionId(await startChatSession(id, signals));
  }

  return (
    <div className="space-y-6">
      {problem && <p className="text-chart-3 text-sm">{problem}</p>}
      <WaitingReviews data={data} onChange={refresh} />
      <CustomerSimulator
        signals={signals}
        onApply={async (next) => {
          setSignals(next);
          if (sessionId) await updateChatSignals(sessionId, next);
        }}
      />
      {data && <Settings limits={data.limits} onSaved={refresh} />}
      <DecisionLog data={data} />
      <AskCopper
        key={sessionId ?? "starting"}
        aiConfigured={aiConfigured}
        docked
        refunds={{
          sessionId,
          accountId,
          accounts,
          onSwitchAccount: switchAccount,
        }}
      />
    </div>
  );
}

function amountOf(cents: number | null) {
  return cents === null ? "—" : usd(cents);
}

function Flags({ flags }: { flags: string[] }) {
  if (flags.length === 0)
    return <span className="text-muted-foreground">none</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((flag) => (
        <Badge key={flag} variant="destructive">
          {flag}
        </Badge>
      ))}
    </div>
  );
}

function Reasons({ reasons }: { reasons: string[] }) {
  return (
    <ul className="list-disc space-y-0.5 pl-4">
      {reasons.map((reason) => (
        <li key={reason}>{reason}</li>
      ))}
    </ul>
  );
}

function LimitsText({ limits }: { limits: Limits }) {
  return (
    <span className="font-mono text-xs whitespace-nowrap">
      {usd(limits.orderCents)} / {usd(limits.accountDailyCents)} /{" "}
      {usd(limits.shopDailyCents)}
    </span>
  );
}

function WaitingReviews({
  data,
  onChange,
}: {
  data: ConsoleData | null;
  onChange: () => Promise<void>;
}) {
  // Cases with a click on the way, so a second click can't be sent.
  const [clicked, setClicked] = useState<number[]>([]);
  const [note, setNote] = useState("");

  async function decide(caseId: number, decision: "approve" | "reject") {
    setClicked((ids) => [...ids, caseId]);
    const { changed } = await reviewRefund(caseId, decision);
    setNote(
      changed
        ? `Case ${caseId}: ${decision === "approve" ? "approved" : "rejected"}.`
        : `Case ${caseId} was already decided, so nothing changed.`,
    );
    await onChange();
  }

  return (
    <Card data-testid="waiting-reviews">
      <CardHeader>
        <CardTitle>Waiting reviews</CardTitle>
        <CardDescription>
          The code sent these to a person. Only a click here approves a refund.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {note && <p className="text-sm">{note}</p>}
        {!data ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : data.waiting.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing is waiting.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Case</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Reasons</TableHead>
                <TableHead>Flags</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.waiting.map((c) => (
                <TableRow key={c.caseId} className="align-top">
                  <TableCell>{c.caseId}</TableCell>
                  <TableCell className="font-mono">{c.orderId}</TableCell>
                  <TableCell>{amountOf(c.amountCents)}</TableCell>
                  <TableCell>{c.accountName}</TableCell>
                  <TableCell className="max-w-64 text-xs whitespace-normal">
                    <Reasons reasons={c.reasons} />
                  </TableCell>
                  <TableCell className="max-w-48 whitespace-normal">
                    <Flags flags={c.flags} />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={clicked.includes(c.caseId)}
                        onClick={() => decide(c.caseId, "approve")}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={clicked.includes(c.caseId)}
                        onClick={() => decide(c.caseId, "reject")}
                      >
                        Reject
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

const SIGNAL_FIELDS: { key: keyof Signals; label: string }[] = [
  { key: "ip", label: "IP address" },
  { key: "device", label: "Device" },
  { key: "browser", label: "Browser" },
  { key: "country", label: "Location (country code)" },
];

function CustomerSimulator({
  signals,
  onApply,
}: {
  signals: Signals;
  onApply: (signals: Signals) => Promise<void>;
}) {
  const [draft, setDraft] = useState(signals);
  const [saved, setSaved] = useState("");
  return (
    <Card data-testid="customer-simulator">
      <CardHeader>
        <CardTitle>Customer simulator</CardTitle>
        <CardDescription>
          Made-up values the app records for the chat. To play a bad actor, keep
          the same device and switch &quot;Signed in as&quot; in the chat, or
          set a country other than the account&apos;s home.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={async (event) => {
            event.preventDefault();
            await onApply(draft);
            setSaved("Applied to this chat.");
          }}
        >
          {SIGNAL_FIELDS.map(({ key, label }) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`signal-${key}`}>{label}</Label>
              <Input
                id={`signal-${key}`}
                value={draft[key]}
                onChange={(event) => {
                  setSaved("");
                  setDraft({ ...draft, [key]: event.target.value });
                }}
              />
            </div>
          ))}
          <div className="flex items-center gap-3 sm:col-span-2">
            <Button type="submit" size="sm">
              Apply to this chat
            </Button>
            {saved && (
              <span className="text-muted-foreground text-sm">{saved}</span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Settings({
  limits,
  onSaved,
}: {
  limits: Limits;
  onSaved: () => Promise<void>;
}) {
  const dollars = (cents: number) => String(cents / 100);
  const [draft, setDraft] = useState({
    order: dollars(limits.orderCents),
    accountDaily: dollars(limits.accountDailyCents),
    shopDaily: dollars(limits.shopDailyCents),
  });
  const [message, setMessage] = useState("");
  const fields = [
    { key: "order", label: "Order limit: orders over this wait for a person" },
    {
      key: "accountDaily",
      label: "Account daily limit: automatic refunds per account per day",
    },
    {
      key: "shopDaily",
      label: "Shop daily limit: automatic refunds for the whole shop per day",
    },
  ] as const;
  return (
    <Card data-testid="refund-settings">
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>
          In dollars, 0 or more. At 0, every refund in that category waits for a
          person. A change applies to new requests only: waiting cases keep the
          limits they were saved with.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const result = await saveRefundLimits(draft);
            setMessage(result.ok ? "Saved." : result.error);
            if (result.ok) await onSaved();
          }}
        >
          {fields.map(({ key, label }) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`limit-${key}`}>{label}</Label>
              <Input
                id={`limit-${key}`}
                inputMode="decimal"
                className="max-w-40"
                value={draft[key]}
                onChange={(event) => {
                  setMessage("");
                  setDraft({ ...draft, [key]: event.target.value });
                }}
              />
            </div>
          ))}
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm">
              Save limits
            </Button>
            {message && <span className="text-sm">{message}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

const RESULT_LABEL = {
  refund: "Refunded",
  refuse: "Refused",
  review: "Sent to review",
  approve: "Approved",
  reject: "Rejected",
} as const;

function DecisionLog({ data }: { data: ConsoleData | null }) {
  return (
    <Card data-testid="decision-log">
      <CardHeader>
        <CardTitle>Decision log</CardTitle>
        <CardDescription>
          Every decision, newest first. Limits are order / account per day /
          shop per day, as they were at that moment. The message is exactly what
          the customer saw.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!data || data.log.length === 0 ? (
          <p className="text-muted-foreground text-sm">No decisions yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Case</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Decided by</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Reasons</TableHead>
                <TableHead>Flags</TableHead>
                <TableHead>Limits</TableHead>
                <TableHead>Customer saw</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.log.map((d) => (
                <TableRow key={d.id} className="align-top text-xs">
                  <TableCell className="whitespace-nowrap">
                    {new Date(d.at).toLocaleString()}
                  </TableCell>
                  <TableCell>{d.caseId}</TableCell>
                  <TableCell className="font-mono whitespace-nowrap">
                    {d.orderId} · {amountOf(d.amountCents)}
                  </TableCell>
                  <TableCell>{d.accountName}</TableCell>
                  <TableCell>
                    {d.decidedBy === "code" ? "The code" : "A person"}
                  </TableCell>
                  <TableCell className="font-semibold">
                    {RESULT_LABEL[d.result]}
                  </TableCell>
                  <TableCell className="max-w-64 whitespace-normal">
                    <Reasons reasons={d.reasons} />
                  </TableCell>
                  <TableCell className="max-w-48 whitespace-normal">
                    <Flags flags={d.flags} />
                  </TableCell>
                  <TableCell>
                    <LimitsText limits={d.limits} />
                  </TableCell>
                  <TableCell className="max-w-64 whitespace-normal">
                    {d.customerMessage}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
