/**
 * POST /api/paypal/on-approve
 * Body: { dealId, orderId }
 *
 * Called by the PayPal button's onApprove (or the redirect return page).
 * Authorizes the approved order — funds are HELD, not captured — records the
 * authorization id and the brand's payer id, sets tranche deadlines, and
 * moves the deal DRAFT -> AUTHORIZED.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { env } from "@/lib/env";
import { authorizeOrder, PayPalError } from "@/lib/paypal/client";
import { ledger } from "@/lib/engine/orchestrator";
import { toCents } from "@/lib/util/money";
import { addDays } from "@/lib/util/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ dealId: z.uuid(), orderId: z.string().min(5).max(64) });
const AUTH_VALIDITY_MS = 29 * 86_400_000;

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const { dealId, orderId } = parsed.data;

  const [deal] = await db().select().from(schema.deals).where(eq(schema.deals.id, dealId));
  if (!deal) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (deal.authorizedOrderId !== orderId) return NextResponse.json({ error: "order_mismatch" }, { status: 409 });
  if (deal.status !== "DRAFT") return NextResponse.json({ ok: true, dealId, status: deal.status, authorizationId: deal.authorizationId });

  try {
    const { data, authorization, requestId, debugId } = await authorizeOrder(orderId);
    if (data.purchase_units?.[0]?.custom_id !== dealId) throw new Error("Order does not belong to this deal");
    const authorizedCents = toCents(authorization.amount.value);
    if (authorizedCents !== toCents(deal.totalBudget)) throw new Error(`Authorized ${authorization.amount.value} does not match budget ${deal.totalBudget}`);

    await ledger({
      dealId,
      trancheId: null,
      kind: "ORDER_AUTHORIZE",
      requestId,
      paypalId: authorization.id,
      debugId,
      status: authorization.status,
      amount: authorizedCents,
      request: { orderId },
      response: data,
    });

    const now = new Date();
    const dayMs = env().DEMO_DAY_MS;
    await db().transaction(async (tx) => {
      const updated = await tx
        .update(schema.deals)
        .set({
          status: "AUTHORIZED",
          authorizationId: authorization.id,
          authorizedAmount: authorization.amount.value,
          authorizedAt: now,
          authorizationExpiresAt: authorization.expiration_time ? new Date(authorization.expiration_time) : new Date(now.getTime() + AUTH_VALIDITY_MS),
          brandPaypalId: data.payer?.email_address ?? data.payer?.payer_id ?? null,
          updatedAt: now,
        })
        .where(and(eq(schema.deals.id, dealId), eq(schema.deals.status, "DRAFT")))
        .returning({ id: schema.deals.id });
      if (updated.length === 0) return;
      for (const t of deal.contractJson.tranches) {
        await tx
          .update(schema.tranches)
          .set({
            // RETENTION_ACTIVE has no deadline of its own: its clock starts at the publish payout.
            deadlineAt: t.type === "RETENTION_ACTIVE" ? null : addDays(now, t.conditions.deadlineDays, dayMs),
            updatedAt: now,
          })
          .where(and(eq(schema.tranches.dealId, dealId), eq(schema.tranches.trancheIndex, t.index)));
      }
    });
    return NextResponse.json({ ok: true, dealId, status: "AUTHORIZED", authorizationId: authorization.id });
  } catch (e) {
    console.error("[on-approve]", e);
    if (e instanceof PayPalError) return NextResponse.json({ error: e.errorName, issue: e.issue, debugId: e.debugId }, { status: 502 });
    return NextResponse.json({ error: "authorize_failed", message: (e as Error).message }, { status: 500 });
  }
}
