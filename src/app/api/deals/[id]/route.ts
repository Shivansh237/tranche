/**
 * GET /api/deals/[id] — deal, escrow balances, tranches, audits, firewall decisions, ledger, timeline.
 * Also refreshes any payout PayPal is still processing (throttled), so the dashboard stays current.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { loadDealView } from "@/lib/engine/deal-view";
import { refreshPendingPayouts } from "@/lib/engine/orchestrator";
import { isPayoutFinal } from "@/lib/paypal/payout-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  let view = await loadDealView(id);
  if (!view) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // While a payout is still processing at PayPal, ask PayPal again (throttled to once per
  // PAYOUT_RECHECK_MS per batch) so the open dashboard flips from "pending" to "completed".
  if (view.tranches.some((t) => t.status === "PAID_OUT" && t.payoutBatchId && !isPayoutFinal(t.payoutStatus))) {
    const changed = await refreshPendingPayouts(id).catch((e) => {
      console.warn("[payouts]", (e as Error).message);
      return 0;
    });
    if (changed > 0) view = (await loadDealView(id)) ?? view;
  }
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}
