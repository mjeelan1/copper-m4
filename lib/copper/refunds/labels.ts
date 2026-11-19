// Plain words for staff. The saved values (a decision's result, a flag)
// never change; only how the console shows them.
import { FLAGS } from "@/lib/copper/refunds/decide";
import { NO_FLAGS } from "@/lib/copper/refunds/suggestions";

export const RESULT_LABEL = {
  refund: "Refunded",
  refuse: "Refused",
  review: "Sent to a person",
  approve: "Approved",
  reject: "Rejected",
} as const;

const FLAG_LABELS: Record<string, string> = {
  [FLAGS.claimedApproval]: "Customer said it was already approved",
  [FLAGS.sharedDevice]:
    "Same device or internet address on 2 or more accounts today",
  [FLAGS.location]: "Customer is outside their home country",
  [FLAGS.notYourOrder]: "Order belongs to another customer",
  [FLAGS.noSuchOrder]: "Order does not exist",
  [FLAGS.previouslyRejected]: "A person rejected this order before",
  [NO_FLAGS]: "No warning",
};

/** A flag in plain words, for the console. */
export function flagLabel(flag: string): string {
  return FLAG_LABELS[flag] ?? flag;
}
