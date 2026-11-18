"use client";

// Stage 2: the Suggestions panel in the Refund Console. The suggestion is
// worked out in code from the cases a person decided; it changes a limit
// only when a person clicks Accept, and Ignore only hides it.
import { useCallback, useEffect, useState } from "react";
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
  acceptLimitSuggestion,
  getLearning,
  ignoreLimitSuggestion,
} from "@/lib/copper/refunds/actions";
import { usd } from "@/lib/copper/refunds/decide";
import type { LearningData } from "@/lib/copper/refunds/learning";

const percent = (approved: number, decided: number) =>
  decided === 0 ? "—" : `${Math.round((approved / decided) * 100)}%`;

export function SuggestionsPanel({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<LearningData | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await getLearning());
    } catch {
      setNote("Can't reach Supabase right now.");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    return () => clearTimeout(first);
  }, [load]);

  async function act(action: "accept" | "ignore", key: string) {
    if (!name.trim()) {
      setNote("Type your name first, so the log shows who decided.");
      return;
    }
    setBusy(true);
    const result =
      action === "accept"
        ? await acceptLimitSuggestion(key, name)
        : await ignoreLimitSuggestion(key, name);
    setNote(
      result.ok
        ? action === "accept"
          ? "Accepted: the new per-order limit is saved."
          : "Ignored: the suggestion is hidden and nothing changed."
        : result.error,
    );
    await load();
    onChanged();
    setBusy(false);
  }

  const suggestion = data?.suggestion;
  return (
    <Card data-testid="suggestions">
      <CardHeader>
        <CardTitle>Suggestions</CardTitle>
        <CardDescription>
          Worked out in code (no AI) from the cases a person decided. When
          people approved at least 80% of at least 5 unflagged cases in the
          amount bands just above the per-order limit, it suggests raising the
          limit. Nothing changes until someone clicks Accept.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!data ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : (
          <>
            {suggestion ? (
              <div
                data-testid="suggestion"
                className="bg-muted space-y-2 rounded-lg p-3 text-sm"
              >
                <p className="font-semibold">{suggestion.text}</p>
                <ul className="list-disc pl-5 text-xs">
                  {suggestion.evidence.map((e) => (
                    <li key={e.band}>
                      {e.band}: {e.approved} of {e.decided} unflagged cases
                      approved ({e.approvedPercent}%)
                      {e.sample > 0 && `, ${e.sample} of them sample history`}
                      {e.flaggedLeftOut > 0 &&
                        `; ${e.flaggedLeftOut} flagged case${e.flaggedLeftOut === 1 ? "" : "s"} left out`}
                      .
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="reviewer-name">
                      Your name (for the log)
                    </Label>
                    <Input
                      id="reviewer-name"
                      className="h-8 w-48"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </div>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => act("accept", suggestion.key)}
                  >
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => act("ignore", suggestion.key)}
                  >
                    Ignore
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                No suggestion right now (per-order limit{" "}
                {usd(data.limits.orderCents)}).
              </p>
            )}
            {note && <p className="text-sm">{note}</p>}

            <div>
              <p className="mb-1 text-sm font-semibold">
                Cases a person decided, by amount band and flag
              </p>
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead>Amount band</TableHead>
                    <TableHead>Flag</TableHead>
                    <TableHead>Decided</TableHead>
                    <TableHead>Approved</TableHead>
                    <TableHead>Sample</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.groups.flatMap(({ band, groups }) =>
                    groups
                      .filter((g) => g.decided > 0)
                      .map((g) => (
                        <TableRow key={`${band.label}-${g.flag}`}>
                          <TableCell>{band.label}</TableCell>
                          <TableCell>{g.flag}</TableCell>
                          <TableCell>{g.decided}</TableCell>
                          <TableCell>
                            {g.approved} ({percent(g.approved, g.decided)})
                          </TableCell>
                          <TableCell>{g.sample}</TableCell>
                        </TableRow>
                      )),
                  )}
                </TableBody>
              </Table>
            </div>

            {data.history.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-semibold">
                  Accepted or ignored
                </p>
                <ul className="space-y-0.5 text-xs">
                  {data.history.map((h) => (
                    <li key={`${h.key}-${h.at}`}>
                      {new Date(h.at).toLocaleString()}: {h.byName} {h.action}{" "}
                      {usd(h.fromOrderCents)} → {usd(h.toOrderCents)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
