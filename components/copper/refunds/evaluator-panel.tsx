"use client";

// Stage 2: the Evaluator panel in the Refund Console. Only the button runs
// the evaluator; it checks up to 5 finished cases and only writes its own
// verdicts.
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getEvaluations, runEvaluatorNow } from "@/lib/copper/refunds/actions";
import type { EvaluatorRun } from "@/lib/copper/refunds/evaluator";
import type { EvaluationRow } from "@/lib/copper/refunds/evaluator-store";

function summary(run: EvaluatorRun) {
  const passed = run.evaluated.filter((e) => e.result === "pass").length;
  const parts = [
    run.evaluated.length === 0 && run.skipped.length === 0
      ? "There are no new cases to check."
      : `Checked ${run.evaluated.length} case${run.evaluated.length === 1 ? "" : "s"}. ${passed} passed. ${run.evaluated.length - passed} failed.`,
    ...run.skipped.map(
      (s) => `Case ${s.caseId} was skipped. Please try again later.`,
    ),
  ];
  return parts.join(" ");
}

export function EvaluatorPanel() {
  const [rows, setRows] = useState<EvaluationRow[]>([]);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      setRows(await getEvaluations());
    } catch {
      setNote("We can't load the data right now.");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    return () => clearTimeout(first);
  }, [load]);

  async function run() {
    setRunning(true);
    setNote("");
    try {
      setNote(summary(await runEvaluatorNow()));
    } catch (error) {
      console.error(error);
      setNote("The evaluator could not run. Please try again later.");
    }
    await load();
    setRunning(false);
  }

  return (
    <Card data-testid="evaluator">
      <CardHeader>
        <CardTitle>Evaluator</CardTitle>
        <CardDescription>
          Checks up to 5 finished cases that have not been checked before. For
          each case, it checks two things. First, did the customer see exactly
          the words in the decision log? Second, does the decision engine still
          give the same result? If the agent wrote a reply in its own words, the
          AI also reads that reply once. The evaluator never changes a decision.
          It skips cases from before Stage 2 and the sample history.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={run} disabled={running}>
            {running ? "Checking…" : "Run evaluator"}
          </Button>
          {note && <p className="text-sm">{note}</p>}
        </div>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No cases have been checked yet.
          </p>
        ) : (
          <Table className="table-fixed text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="w-14">Case</TableHead>
                <TableHead className="w-28">Order</TableHead>
                <TableHead className="w-16">Result</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="w-28">AI read the reply</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => (
                <TableRow key={e.caseId} className="align-top">
                  <TableCell>{e.caseId}</TableCell>
                  <TableCell className="whitespace-normal">
                    <span className="font-mono">{e.orderId}</span>
                    <br />
                    {e.accountName}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={e.result === "pass" ? "default" : "destructive"}
                    >
                      {e.result === "pass" ? "Passed" : "Failed"}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {e.reason}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {e.aiChecked ? "Yes" : "Not needed"}
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
