"use client";

// The Refund Console on /support, with Ask Copper docked beside it.
// - Waiting reviews: only an Approve click here approves a refund.
// - Customer simulator: the made-up IP, device, browser and location of the
//   chat, so you can play a bad actor (the same device on two accounts).
// - Settings: the three limits.
// - Decision log: every decision, by the code or by a person.
// It refreshes every few seconds, so new cases show up on their own.
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AskCopper } from "@/components/copper/ask-copper";
import { EvaluatorPanel } from "@/components/copper/refunds/evaluator-panel";
import { SuggestionsPanel } from "@/components/copper/refunds/suggestions-panel";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
  getLearning,
  reviewRefund,
  saveRefundLimits,
  startChatSession,
  updateChatSignals,
} from "@/lib/copper/refunds/actions";
import { type Limits, type Signals, usd } from "@/lib/copper/refunds/decide";
import { flagLabel, RESULT_LABEL } from "@/lib/copper/refunds/labels";
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
      setProblem("We can't load the data right now. Trying again…");
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
        setProblem("We can't load the data right now. Please reload the page.");
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
      {data && (
        // Keyed by the limits, so the form shows them again after Accept.
        <Settings
          key={JSON.stringify(data.limits)}
          limits={data.limits}
          onSaved={refresh}
        />
      )}
      <SuggestionsPanel onChanged={refresh} />
      <EvaluatorPanel />
      <DecisionLog data={data} />
      <DemoTools>
        <CustomerSimulator
          signals={signals}
          onApply={async (next) => {
            setSignals(next);
            if (sessionId) await updateChatSignals(sessionId, next);
          }}
        />
        <SampleHistory />
      </DemoTools>
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
    return <span className="text-muted-foreground">None</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((flag) => (
        <Badge
          key={flag}
          variant="destructive"
          className="h-auto text-left whitespace-normal"
        >
          {flagLabel(flag)}
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
        ? `Case ${caseId} is ${decision === "approve" ? "approved" : "rejected"}.`
        : `Case ${caseId} was already decided. Nothing changed.`,
    );
    await onChange();
  }

  return (
    <Card data-testid="waiting-reviews">
      <CardHeader>
        <CardTitle>Refunds to review</CardTitle>
        <CardDescription>
          These refund requests need a person to decide. A refund is approved
          only when you click Approve.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {note && <p className="text-sm">{note}</p>}
        {!data ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : data.waiting.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No refund requests are waiting.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Case</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Reasons</TableHead>
                <TableHead>Warnings</TableHead>
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
                    {c.earlierDecisions.map((earlier) => (
                      <div
                        key={earlier.caseId}
                        data-testid="earlier-decision"
                        className="bg-muted mt-2 rounded-md p-2"
                      >
                        <p className="font-semibold">
                          Earlier decision: a person rejected case{" "}
                          {earlier.caseId} on{" "}
                          {new Date(earlier.decidedAt).toLocaleString()}.
                        </p>
                        <p className="text-muted-foreground">
                          It was sent to a person because:{" "}
                          {earlier.reasons.join(" ")}
                        </p>
                        <p className="text-muted-foreground">
                          The customer was told: {earlier.customerMessage}
                        </p>
                      </div>
                    ))}
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
  { key: "ip", label: "Internet address (IP)" },
  { key: "device", label: "Device" },
  { key: "browser", label: "Browser" },
  { key: "country", label: "Country (two letters, for example US)" },
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
          Pretend to be a customer. These made-up values are saved with the
          current chat. To test the warnings, keep the same device and switch
          &quot;Signed in as&quot; in the chat. Or enter a country other than
          the customer&apos;s home country.
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
    {
      key: "order",
      label: "Order limit. Orders above this amount wait for a person.",
    },
    {
      key: "accountDaily",
      label:
        "Daily limit per customer. The most one customer can get back automatically in one day.",
    },
    {
      key: "shopDaily",
      label:
        "Daily limit for the shop. The most all customers together can get back automatically in one day.",
    },
  ] as const;
  return (
    <Card data-testid="refund-settings">
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>
          Enter each limit in dollars. Use 0 or more. A limit of 0 sends every
          refund of that kind to a person. A change applies only to new
          requests. Refunds that are already waiting keep their old limits.
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

function DecisionLog({ data }: { data: ConsoleData | null }) {
  return (
    <Card data-testid="decision-log">
      <CardHeader>
        <CardTitle>Decision log</CardTitle>
        <CardDescription>
          Every decision, newest first. The limits are the ones that applied at
          that moment. The last column shows the exact words the customer saw.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!data || data.log.length === 0 ? (
          <p className="text-muted-foreground text-sm">No decisions yet.</p>
        ) : (
          // Fixed column widths and wrapping text, so the whole log fits
          // beside the docked chat on a 1440-pixel screen.
          <Table className="table-fixed text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Case and time</TableHead>
                <TableHead className="w-32">Order</TableHead>
                <TableHead className="w-24">Decision</TableHead>
                <TableHead>Reasons</TableHead>
                <TableHead className="w-32">Warnings</TableHead>
                <TableHead className="w-32">Limits at the time</TableHead>
                <TableHead>What the customer saw</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.log.map((d) => (
                <TableRow key={d.id} className="align-top">
                  <TableCell className="whitespace-normal">
                    <span className="font-semibold">Case {d.caseId}</span>
                    <br />
                    {new Date(d.at).toLocaleString()}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <span className="font-mono">{d.orderId}</span> ·{" "}
                    {amountOf(d.amountCents)}
                    <br />
                    {d.accountName}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <span className="font-semibold">
                      {RESULT_LABEL[d.result]}
                    </span>
                    <br />
                    {d.decidedBy === "code" ? "by the system" : "by a person"}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <Reasons reasons={d.reasons} />
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <Flags flags={d.flags} />
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {usd(d.limits.orderCents)} per order
                    <br />
                    {usd(d.limits.accountDailyCents)} per customer per day
                    <br />
                    {usd(d.limits.shopDailyCents)} for the shop per day
                  </TableCell>
                  <TableCell className="whitespace-normal">
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

/**
 * Demo tools: only for testing, so they sit at the bottom of the console,
 * folded away until someone opens them.
 */
function DemoTools({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      data-testid="demo-tools"
      open={open}
      onOpenChange={setOpen}
      className="space-y-4 rounded-xl border border-dashed p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <CollapsibleTrigger asChild>
          <Button variant="outline" size="sm">
            {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
            Demo tools
          </Button>
        </CollapsibleTrigger>
        <p className="text-muted-foreground text-sm">
          For testing only. Real customers and staff do not use these.
        </p>
      </div>
      <CollapsibleContent className="space-y-6">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** Where the sample history shows up, moved here from the Suggestions panel. */
function SampleHistory() {
  const [counts, setCounts] = useState<{ band: string; count: number }[]>([]);
  useEffect(() => {
    void (async () => {
      try {
        const { groups } = await getLearning();
        // Each sample refund has at most one warning, so it is counted once.
        setCounts(
          groups
            .map(({ band, groups: byFlag }) => ({
              band: band.label,
              count: byFlag.reduce((sum, g) => sum + g.sample, 0),
            }))
            .filter((c) => c.count > 0),
        );
      } catch {
        setCounts([]);
      }
    })();
  }, []);
  return (
    <Card data-testid="sample-history">
      <CardHeader>
        <CardTitle>Sample history</CardTitle>
        <CardDescription>
          The Suggestions panel also counts 12 made-up refunds from the account
          &quot;Sample customer (sample)&quot;. They show how suggestions work.
          The evaluator skips them.
        </CardDescription>
      </CardHeader>
      {counts.length > 0 && (
        <CardContent className="text-sm">
          Sample refunds by price range:{" "}
          {counts.map((c) => `${c.band}: ${c.count}.`).join(" ")}
        </CardContent>
      )}
    </Card>
  );
}
