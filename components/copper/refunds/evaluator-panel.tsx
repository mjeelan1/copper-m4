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
      ? "Nothing new to check."
      : `Checked ${run.evaluated.length} case${run.evaluated.length === 1 ? "" : "s"}: ${passed} passed, ${run.evaluated.length - passed} failed.`,
    ...run.skipped.map(
      (s) => `Case ${s.caseId} skipped, try again later: ${s.reason}`,
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
      setNote("Can't reach Supabase right now.");
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
      setNote(
        `The evaluator couldn't run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await load();
    setRunning(false);
  }

  return (
    <Card data-testid="evaluator">
      <CardHeader>
        <CardTitle>Evaluator</CardTitle>
        <CardDescription>
          Checks up to 5 finished cases that haven&apos;t been checked yet: the
          customer saw the decision log&apos;s exact text, and the engine run
          again on the saved facts still agrees. Only replies the agent wrote in
          its own words get one AI question. It never changes a decision. Cases
          from before Stage 2 (no saved facts) and sample history are not
          checked.
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
          <p className="text-muted-foreground text-sm">No evaluations yet.</p>
        ) : (
          <Table className="table-fixed text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="w-14">Case</TableHead>
                <TableHead className="w-28">Order</TableHead>
                <TableHead className="w-16">Result</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="w-14">AI</TableHead>
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
                      {e.result}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {e.reason}
                  </TableCell>
                  <TableCell>{e.aiChecked ? "asked" : "not needed"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
