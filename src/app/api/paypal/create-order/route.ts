/**
 * POST /api/paypal/create-order
 * Body: { dealId, flow?: "buttons" | "redirect" }
 *
 * Creates a sandbox order with intent AUTHORIZE for the full deal budget.
 * "buttons": returns the order id for the PayPal JS SDK button.
 * "redirect": also returns the approval URL (fallback when the SDK can't load).
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { env } from "@/lib/env";
import { createAuthorizedOrder, PayPalError } from "@/lib/paypal/client";
import { ledger } from "@/lib/engine/orchestrator";
import { toCents } from "@/lib/util/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ dealId: z.uuid(), flow: z.enum(["buttons", "redirect"]).default("buttons") });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const { dealId, flow } = parsed.data;

  const [deal] = await db().select().from(schema.deals).where(eq(schema.deals.id, dealId));
  if (!deal) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (deal.status !== "DRAFT") return NextResponse.json({ error: "already_funded", status: deal.status }, { status: 409 });

  const amount = toCents(deal.totalBudget);
  const requestId = `deal-${dealId}-order-${flow}`;
  try {
    const order = await createAuthorizedOrder(amount, "USD", {
      dealId,
      description: `Tranche escrow: ${deal.title}`,
      requestId,
      ...(flow === "redirect"
        ? { returnUrl: `${env().APP_URL}/deals/${dealId}/return`, cancelUrl: `${env().APP_URL}/deals/new?cancelled=${dealId}` }
        : {}),
    });
    await ledger({
      dealId,
      trancheId: null,
      kind: "ORDER_CREATE",
      requestId: `${requestId}:${order.data.id}`,
      paypalId: order.data.id,
      debugId: order.debugId,
      status: order.data.status,
      amount,
      request: order.body,
      response: order.data,
    });
    await db().update(schema.deals).set({ authorizedOrderId: order.data.id, updatedAt: new Date() }).where(eq(schema.deals.id, dealId));
    return NextResponse.json({ orderId: order.data.id, approveUrl: order.approveUrl });
  } catch (e) {
    console.error("[create-order]", e);
    if (e instanceof PayPalError) return NextResponse.json({ error: e.errorName, issue: e.issue, debugId: e.debugId }, { status: 502 });
    return NextResponse.json({ error: "internal", message: (e as Error).message }, { status: 500 });
  }
}
