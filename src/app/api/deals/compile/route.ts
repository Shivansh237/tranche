/**
 * POST /api/deals/compile
 * Body: { terms, creatorPayPalId, youtubeChannel, dealId? }
 *
 * Gemini compiles the terms into a typed contract; deterministic validation
 * runs; the deal and its tranches are saved as DRAFT (or the given DRAFT is
 * replaced) so the brand can fund it next. Returns the compiled contract.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { compileContract } from "@/lib/ai/contract-compiler";
import { GeminiBusyError } from "@/lib/ai/models";
import { ContractValidationError } from "@/lib/contracts/deal-contract";
import { resolveChannelId } from "@/lib/youtube/client";
import { fromCents } from "@/lib/util/money";
import { hashJson } from "@/lib/util/hash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  terms: z.string().trim().min(20, "Describe the deal in at least a sentence").max(6000),
  creatorPayPalId: z.email("Creator PayPal email is invalid"),
  youtubeChannel: z.string().trim().min(2).max(200),
  dealId: z.uuid().optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  }
  const { terms, creatorPayPalId, youtubeChannel, dealId: existingId } = parsed.data;

  let channelId: string;
  try {
    channelId = await resolveChannelId(youtubeChannel);
  } catch (e) {
    return NextResponse.json({ error: "channel_not_found", issues: [(e as Error).message] }, { status: 422 });
  }

  let compiled: Awaited<ReturnType<typeof compileContract>>;
  try {
    compiled = await compileContract(terms);
  } catch (e) {
    if (e instanceof ContractValidationError) return NextResponse.json({ error: "contract_invalid", issues: e.issues }, { status: 422 });
    if (e instanceof GeminiBusyError) {
      return NextResponse.json({ error: "gemini_busy", issues: [e.message] }, { status: 503, headers: { "Retry-After": "60" } });
    }
    console.error("[compile]", e);
    return NextResponse.json({ error: "compile_failed", issues: [(e as Error).message] }, { status: 502 });
  }

  const { contract } = compiled;
  const contractHash = hashJson(contract);
  const values = {
    title: contract.title,
    brandName: contract.brandName,
    productName: contract.productName,
    creatorPaypalId: creatorPayPalId.trim().toLowerCase(),
    youtubeChannelId: channelId,
    currency: "USD",
    totalBudget: fromCents(contract.totalBudgetCents),
    termsText: terms,
    contractJson: contract,
    contractHash,
    updatedAt: new Date(),
  };

  const dealId = await db().transaction(async (tx) => {
    let id = existingId;
    if (id) {
      const updated = await tx
        .update(schema.deals)
        .set(values)
        .where(and(eq(schema.deals.id, id), eq(schema.deals.status, "DRAFT")))
        .returning({ id: schema.deals.id });
      if (updated.length === 0) id = undefined; // not a DRAFT any more: create a new one
      else await tx.delete(schema.tranches).where(eq(schema.tranches.dealId, id));
    }
    if (!id) {
      const [row] = await tx.insert(schema.deals).values({ ...values, status: "DRAFT" }).returning({ id: schema.deals.id });
      id = row!.id;
    }
    await tx.insert(schema.tranches).values(
      contract.tranches.map((t) => ({
        dealId: id!,
        trancheIndex: t.index,
        type: t.type,
        label: t.label,
        amount: fromCents(t.amountCents),
        conditionsJson: t.conditions,
        status: "PENDING" as const,
      })),
    );
    return id!;
  });

  return NextResponse.json({ dealId, contract, contractHash, channelId, ambiguities: compiled.compiled.ambiguities, model: compiled.model });
}
