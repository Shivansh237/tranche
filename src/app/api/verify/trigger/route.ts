/**
 * POST /api/verify/trigger
 *
 *   { dealId, videoId?, transcript?, preferTranscript? }   audit one deal now
 *   { all: true }                                          poll every active deal (cron)
 *
 * With `Authorization: Bearer $CRON_SECRET` any call is allowed (cron jobs,
 * webhooks from your own systems). Without it, only single-deal triggers are
 * accepted and they are throttled per deal, so a public demo URL cannot be
 * used to hammer Gemini or PayPal.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db/client";
import { pollAllDeals, runVerification } from "@/lib/engine/orchestrator";
import { hasCronSecret } from "@/lib/http/auth";
import { parseVideoId } from "@/lib/youtube/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MIN_INTERVAL_MS = 5_000;

const Body = z.union([
  z.object({ all: z.literal(true) }),
  z.object({
    dealId: z.uuid(),
    videoId: z.string().trim().max(200).optional(),
    transcript: z.string().max(200_000).optional(),
    preferTranscript: z.boolean().optional(),
  }),
]);

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  const trusted = hasCronSecret(req.headers.get("authorization"));
  const body = parsed.data;

  if ("all" in body) {
    if (!trusted) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const started = Date.now();
    const reports = await pollAllDeals();
    return NextResponse.json({ ok: true, ms: Date.now() - started, reports });
  }

  let videoId: string | undefined;
  if (body.videoId) {
    const id = parseVideoId(body.videoId);
    if (!id) return NextResponse.json({ error: "invalid_video_id" }, { status: 400 });
    videoId = id;
  }

  const [deal] = await db()
    .select({ status: schema.deals.status, lastCheckedAt: schema.deals.lastCheckedAt })
    .from(schema.deals)
    .where(eq(schema.deals.id, body.dealId));
  if (!deal) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (deal.status !== "AUTHORIZED" && deal.status !== "IN_PROGRESS") {
    return NextResponse.json({ error: "deal_not_active", status: deal.status }, { status: 409 });
  }
  if (!trusted && deal.lastCheckedAt && Date.now() - deal.lastCheckedAt.getTime() < MIN_INTERVAL_MS) {
    return NextResponse.json({ error: "too_soon", retryAfterMs: MIN_INTERVAL_MS }, { status: 429 });
  }

  const report = await runVerification({
    dealId: body.dealId,
    videoId,
    transcript: body.transcript || undefined,
    preferTranscript: body.preferTranscript,
    trigger: "manual",
  });
  return NextResponse.json(report);
}
