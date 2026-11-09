/** Read model for GET /api/deals/[id], the dashboard and the Deal Desk copilot. */
import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { toCents } from "@/lib/util/money";

export async function loadDealView(dealId: string) {
  const [deal] = await db().select().from(schema.deals).where(eq(schema.deals.id, dealId));
  if (!deal) return null;
  const [tranches, audits, decisions, ledger, timeline] = await Promise.all([
    db().select().from(schema.tranches).where(eq(schema.tranches.dealId, dealId)).orderBy(asc(schema.tranches.trancheIndex)),
    db().select().from(schema.evidenceAudits).where(eq(schema.evidenceAudits.dealId, dealId)).orderBy(desc(schema.evidenceAudits.createdAt)).limit(25),
    db().select().from(schema.firewallDecisions).where(eq(schema.firewallDecisions.dealId, dealId)).orderBy(desc(schema.firewallDecisions.evaluatedAt)).limit(25),
    db().select().from(schema.paypalLedger).where(eq(schema.paypalLedger.dealId, dealId)).orderBy(desc(schema.paypalLedger.createdAt)).limit(50),
    db().select().from(schema.timelineEvents).where(eq(schema.timelineEvents.dealId, dealId)).orderBy(desc(schema.timelineEvents.createdAt)).limit(80),
  ]);

  const authorizedCents = toCents(deal.authorizedAmount);
  const capturedCents = toCents(deal.capturedTotal);
  // Once a deal closes, the remainder is voided back to the brand: nothing is held any more.
  const closed = deal.status === "COMPLETED" || deal.status === "VOIDED";
  const unreleased = Math.max(0, authorizedCents - capturedCents);
  return {
    deal: {
      id: deal.id,
      title: deal.title,
      brandName: deal.brandName,
      productName: deal.productName,
      brandPaypalId: deal.brandPaypalId,
      creatorPaypalId: deal.creatorPaypalId,
      youtubeChannelId: deal.youtubeChannelId,
      currency: deal.currency,
      totalBudget: deal.totalBudget,
      authorizedOrderId: deal.authorizedOrderId,
      authorizationId: deal.authorizationId,
      status: deal.status,
      contractHash: deal.contractHash,
      contract: deal.contractJson,
      termsText: deal.termsText,
      boundVideoId: deal.boundVideoId,
      authorizedAt: deal.authorizedAt,
      lastCheckedAt: deal.lastCheckedAt,
      createdAt: deal.createdAt,
    },
    escrow: {
      authorizedCents,
      capturedCents,
      heldCents: closed ? 0 : unreleased,
      returnedCents: closed ? unreleased : 0,
      totalBudgetCents: toCents(deal.totalBudget),
    },
    tranches: tranches.map((t) => ({
      id: t.id,
      trancheIndex: t.trancheIndex,
      type: t.type,
      label: t.label,
      amount: t.amount,
      status: t.status,
      conditions: t.conditionsJson,
      deadlineAt: t.deadlineAt,
      captureId: t.captureId,
      capturedAt: t.capturedAt,
      payoutBatchId: t.payoutBatchId,
      payoutStatus: t.payoutStatus,
      paidOutAt: t.paidOutAt,
      boundVideoId: t.boundVideoId,
      lastError: t.lastError,
      progressNote: t.progressNote,
    })),
    audits: audits.map((a) => ({
      id: a.id,
      trancheId: a.trancheId,
      videoId: a.videoId,
      videoTitle: a.videoTitle,
      source: a.source,
      model: a.model,
      brandSegmentStartSec: a.brandSegmentStartSec,
      brandSegmentEndSec: a.brandSegmentEndSec,
      brandSegmentDurationSec: a.brandSegmentDurationSec,
      hasAdDisclosure: a.hasAdDisclosure,
      disclosureSource: a.disclosureSource,
      channelIdMatches: a.channelIdMatches,
      keywordFound: a.keywordFound,
      isPublic: a.isPublic,
      viewCount: a.viewCount,
      confidenceScore: Number(a.confidenceScore),
      citations: a.citations,
      durationSec: a.snapshot.durationSec,
      videoPublishedAt: a.videoPublishedAt,
      sha256EvidenceHash: a.sha256EvidenceHash,
      latencyMs: a.latencyMs,
      createdAt: a.createdAt,
    })),
    decisions: decisions.map((d) => ({
      id: d.id,
      trancheId: d.trancheId,
      decision: d.decision,
      refusalReasons: d.refusalReasons,
      rules: d.ruleResults,
      intentHash: d.intentHash,
      idempotencyKey: d.idempotencyKey,
      policyVersion: d.policyVersion,
      evaluatedAt: d.evaluatedAt,
    })),
    ledger: ledger.map((l) => ({
      id: l.id,
      trancheId: l.trancheId,
      kind: l.kind,
      paypalRequestId: l.paypalRequestId,
      paypalId: l.paypalId,
      paypalDebugId: l.paypalDebugId,
      status: l.status,
      amount: l.amount,
      createdAt: l.createdAt,
    })),
    timeline: timeline.map((e) => ({
      id: e.id,
      runId: e.runId,
      trancheId: e.trancheId,
      step: e.step,
      ok: e.ok,
      message: e.message,
      data: e.data,
      createdAt: e.createdAt,
    })),
  };
}

export type DealView = NonNullable<Awaited<ReturnType<typeof loadDealView>>>;

/** The same shape after JSON serialization: dates become strings. */
type Jsonify<T> = T extends Date
  ? string
  : T extends Array<infer U>
    ? Jsonify<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;
export type DealViewJson = Jsonify<DealView>;
