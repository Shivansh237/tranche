import { NextResponse } from "next/server";
import { z } from "zod";
import { askDealDesk, DealDeskError } from "@/lib/copilot/deal-desk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Above the Deal Desk's own total limit, so it can answer with a timed trace instead of being cut off.
export const maxDuration = 170;

const Body = z.object({ dealId: z.uuid(), question: z.string().trim().min(3).max(1000) });

const STATUS: Record<DealDeskError["code"], number> = { timeout: 504, gemini_busy: 503, failed: 502 };

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  try {
    return NextResponse.json(await askDealDesk(parsed.data.dealId, parsed.data.question));
  } catch (e) {
    if (e instanceof DealDeskError) {
      console.error(`[copilot] ${e.code}: ${e.message}`);
      return NextResponse.json({ error: e.code === "failed" ? "copilot_failed" : e.code, message: e.message, trace: e.trace }, { status: STATUS[e.code] });
    }
    console.error("[copilot]", e);
    return NextResponse.json({ error: "copilot_failed", message: (e as Error).message }, { status: 502 });
  }
}
