/**
 * PayPal Payouts statuses, shared by the server (when to stop re-checking)
 * and the dashboard (what to call each one).
 *
 *   batch_status:        PENDING | PROCESSING | SUCCESS | DENIED | CANCELED
 *   transaction_status:  PENDING | SUCCESS | FAILED | UNCLAIMED | RETURNED |
 *                        ONHOLD | BLOCKED | REFUNDED | REVERSED
 *
 * Each Tranche payout batch holds exactly one item (one creator), so the
 * item's transaction_status is the most precise answer: a batch can be
 * SUCCESS while its item is UNCLAIMED (no PayPal account for that email yet).
 */

/** Statuses PayPal will not change again, so there is nothing left to re-check. */
const FINAL = new Set(["SUCCESS", "FAILED", "RETURNED", "REFUNDED", "REVERSED", "BLOCKED", "DENIED", "CANCELED"]);
/** Final statuses where the creator did not receive the money. */
const PROBLEM = new Set(["FAILED", "RETURNED", "REFUNDED", "REVERSED", "BLOCKED", "DENIED", "CANCELED"]);

export function isPayoutFinal(status: string | null | undefined): boolean {
  return !!status && FINAL.has(status.toUpperCase());
}

export function isPayoutProblem(status: string | null | undefined): boolean {
  return !!status && PROBLEM.has(status.toUpperCase());
}

/** The payout's status: the item's transaction_status when PayPal reports one, otherwise the batch status. */
export function payoutStatusOf(batch: { batch_header?: { batch_status?: string }; items?: Array<{ transaction_status?: string }> }): string | null {
  return batch.items?.[0]?.transaction_status ?? batch.batch_header?.batch_status ?? null;
}

/** Plain-language label for the dashboard. */
export function payoutStatusLabel(status: string | null | undefined): string {
  const s = (status ?? "").toUpperCase();
  switch (s) {
    case "SUCCESS":
      return "completed";
    case "":
    case "NEW":
    case "PENDING":
    case "PROCESSING":
      return "pending";
    case "UNCLAIMED":
      return "unclaimed: no PayPal account for this email yet";
    case "ONHOLD":
      return "on hold at PayPal";
    case "RETURNED":
      return "returned unclaimed";
    case "BLOCKED":
      return "blocked by PayPal";
    case "DENIED":
      return "denied by PayPal";
    default:
      return s.toLowerCase();
  }
}
