/**
 * Background Verification & Execution Engine.
 *
 *   Upload detected -> Gemini multimodal audit -> evidence hash
 *     -> Spend Firewall -> partial capture -> payout -> state update
 *
 * Entry points:
 *   runVerification({ dealId, videoId?, transcript? })   one deal (manual trigger or webhook)
 *   pollAllDeals()                                       every active deal (cron)
 *
 * Safety properties:
 *  - A lease on the deal row means one run per deal at a time.
 *  - Tranches are claimed with conditional UPDATEs (PENDING/REFUSED -> AUDITING).
 *  - Money moves only after evaluateSpendFirewall() returns APPROVED, and the
 *    approval row is unique per PayPal-Request-Id at the database level.
 *  - APPROVED/CAPTURED tranches left behind by a crash are resumed with the
 *    SAME PayPal-Request-Id / sender_batch_id, so PayPal returns the original
 *    capture/payout instead of creating a second one.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db, schema } from "@/db/client";
import type { Deal, EvidenceAudit, Tranche } from "@/db/schema";
import { env } from "@/lib/env";
import type { AuditFindings, AuditSource, GeminiVerdict, VideoSnapshot } from "@/lib/contracts/audit-verdict";
import { PaymentIntentSchema, type PaymentIntent } from "@/lib/contracts/payment-intent";
import { GeminiBusyError } from "@/lib/ai/models";
import { auditVideo, AuditUnavailableError, AUDIT_PROMPT_VERSION, verdictCacheKey, type AuditContext } from "@/lib/ai/video-auditor";
import { evaluateMetadataFindings, evaluateVideoFindings } from "./conditions";
import { assertTrancheTransition, AUDITABLE_STATES, type TrancheStatus } from "./state-machine";
import {
  deriveIdempotencyKey,
  derivePayoutBatchId,
  evaluateSpendFirewall,
  FIREWALL_POLICY_VERSION,
  type DealPolicy,
  type FirewallResult,
} from "@/lib/firewall/engine";
import {
  captureAuthorizedOrder,
  createPayout,
  getAuthorization,
  getPayoutBatch,
  PayPalError,
  voidAuthorization,
} from "@/lib/paypal/client";
import { isPayoutFinal, isPayoutProblem, payoutStatusLabel, payoutStatusOf } from "@/lib/paypal/payout-status";
import { getVideoSnapshot, getVideoSnapshots, listRecentUploadIds } from "@/lib/youtube/client";
import { formatUsd, fromCents, toCents } from "@/lib/util/money";
import { formatTimestamp } from "@/lib/util/time";
import { hashJson } from "@/lib/util/hash";

const LEASE_MS = 3 * 60_000;
const AUTH_VALIDITY_MS = 29 * 86_400_000;
type Step = (typeof schema.timelineStep.enumValues)[number];

export interface RunInput {
  dealId: string;
  /** Audit this video instead of scanning the channel's uploads. */
  videoId?: string;
  /** Timestamped transcript used if the YouTube URL audit fails. */
  transcript?: string;
  preferTranscript?: boolean;
  trigger: "manual" | "poll";
}

export interface TrancheOutcome {
  trancheIndex: number;
  type: Tranche["type"];
  status: TrancheStatus;
  note: string;
}

export interface RunReport {
  runId: string;
  dealId: string;
  skipped?: string;
  outcomes: TrancheOutcome[];
  closed?: string;
}

export async function pollAllDeals(): Promise<RunReport[]> {
  // Payouts finish at PayPal after the deal may already be COMPLETED, so check those deals too.
  for (const dealId of await dealsWithPendingPayouts()) {
    await refreshPendingPayouts(dealId, { force: true }).catch((e) => console.warn("[payouts]", (e as Error).message));
  }
  const active = await db()
    .select({ id: schema.deals.id })
    .from(schema.deals)
    .where(inArray(schema.deals.status, ["AUTHORIZED", "IN_PROGRESS"]));
  const reports: RunReport[] = [];
  for (const { id } of active) {
    try {
      reports.push(await runVerification({ dealId: id, trigger: "poll" }));
    } catch (e) {
      reports.push({ runId: "", dealId: id, skipped: `error: ${(e as Error).message}`, outcomes: [] });
    }
  }
  return reports;
}

export async function runVerification(input: RunInput): Promise<RunReport> {
  // A manual or scheduled audit also picks up payouts that PayPal has finished since the last check.
  await refreshPendingPayouts(input.dealId, { force: true }).catch((e) => console.warn("[payouts]", (e as Error).message));
  const runId = randomUUID();
  const report: RunReport = { runId, dealId: input.dealId, outcomes: [] };
  const started = new Date();

  const [deal] = await db()
    .update(schema.deals)
    .set({ verifyLockUntil: new Date(started.getTime() + LEASE_MS) })
    .where(
      and(
        eq(schema.deals.id, input.dealId),
        inArray(schema.deals.status, ["AUTHORIZED", "IN_PROGRESS"]),
        or(isNull(schema.deals.verifyLockUntil), lt(schema.deals.verifyLockUntil, started)),
      ),
    )
    .returning();
  if (!deal) return { ...report, skipped: "Deal is not active, or another run holds its lease" };

  try {
    // 1. Finish anything a previous run left mid-release.
    for (const t of await loadTranches(deal.id)) {
      if (t.status === "APPROVED" || t.status === "CAPTURED") report.outcomes.push(await resumeRelease(runId, t.id));
    }

    // 2. Breach: the paid video went private or was deleted while tranches are still open.
    const breach = await detectBreach(await loadDeal(deal.id), await loadTranches(deal.id));
    if (breach) {
      for (const t of await loadTranches(deal.id)) {
        if (t.status === "PENDING" || t.status === "REFUSED") {
          await setStatus(t, "VOIDED", { lastError: `Breach: ${breach}`, progressNote: null });
          await emit(runId, deal.id, t.id, "VOIDED", false, `Tranche ${t.trancheIndex + 1} voided: ${breach}`);
          report.outcomes.push({ trancheIndex: t.trancheIndex, type: t.type, status: "VOIDED", note: breach });
        }
      }
      await closeDeal(runId, deal.id, breach);
      report.closed = breach;
      return report;
    }

    // 3. Evaluate every auditable tranche in order.
    for (const t of await loadTranches(deal.id)) {
      if (!AUDITABLE_STATES.includes(t.status)) continue;
      report.outcomes.push(await processTranche(runId, await loadDeal(deal.id), t, input));
    }

    // 4. Close when nothing can pay any more.
    const final = await loadTranches(deal.id);
    if (final.every((t) => t.status === "PAID_OUT" || t.status === "VOIDED")) {
      await closeDeal(runId, deal.id, "All tranches settled");
      report.closed = "All tranches settled";
    }
    return report;
  } finally {
    await db()
      .update(schema.deals)
      .set({ verifyLockUntil: null, lastCheckedAt: new Date() })
      .where(eq(schema.deals.id, deal.id));
  }
}

// ---------------------------------------------------------------------------
// Per-tranche processing
// ---------------------------------------------------------------------------

async function processTranche(runId: string, deal: Deal, t: Tranche, input: RunInput): Promise<TrancheOutcome> {
  const now = new Date();
  const out = (status: TrancheStatus, note: string): TrancheOutcome => ({ trancheIndex: t.trancheIndex, type: t.type, status, note });

  if (t.deadlineAt && now.getTime() > t.deadlineAt.getTime() + env().CLOCK_DRIFT_TOLERANCE_MS) {
    await setStatus(t, "VOIDED", { lastError: "Deadline passed before the conditions were met", progressNote: null });
    await emit(runId, deal.id, t.id, "VOIDED", false, `Tranche ${t.trancheIndex + 1} voided: deadline ${t.deadlineAt.toISOString()} passed`);
    return out("VOIDED", "Deadline passed");
  }

  const tranches = await loadTranches(deal.id);
  const publish = tranches.find((x) => x.type === "PUBLISH_VERIFIED");
  if (t.type !== "PUBLISH_VERIFIED" && publish?.status !== "PAID_OUT") {
    await db().update(schema.tranches).set({ progressNote: "Waiting for the publish tranche to pay out" }).where(eq(schema.tranches.id, t.id));
    return out(t.status, "Waiting for the publish tranche");
  }

  // Claim: PENDING/REFUSED -> AUDITING. Exactly one run can win this.
  const previous = t.status;
  const [claimed] = await db()
    .update(schema.tranches)
    .set({ status: "AUDITING", updatedAt: new Date() })
    .where(and(eq(schema.tranches.id, t.id), inArray(schema.tranches.status, ["PENDING", "REFUSED"])))
    .returning();
  if (!claimed) return out(t.status, "Claimed by another run");

  const revert = async (note: string, lastError?: string) => {
    await db()
      .update(schema.tranches)
      .set({ status: previous, progressNote: note, ...(lastError !== undefined ? { lastError } : {}), updatedAt: new Date() })
      .where(and(eq(schema.tranches.id, t.id), eq(schema.tranches.status, "AUDITING")));
    return out(previous, note);
  };

  try {
    if (t.type === "PUBLISH_VERIFIED") return await processPublish(runId, deal, claimed, input, revert);
    if (t.type === "VIEW_MILESTONE") return await processViews(runId, deal, claimed, publish!, revert);
    return await processRetention(runId, deal, claimed, publish!, now, revert);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof AuditUnavailableError || e instanceof GeminiBusyError) {
      await emit(runId, deal.id, t.id, "MULTIMODAL_ANALYSIS", false, message);
    }
    return revert(`Evaluation error: ${message.slice(0, 200)}`, message.slice(0, 500));
  }
}

type Revert = (note: string, lastError?: string) => Promise<TrancheOutcome>;

async function processPublish(runId: string, deal: Deal, t: Tranche, input: RunInput, revert: Revert): Promise<TrancheOutcome> {
  const snapshot = input.videoId ? await getVideoSnapshot(input.videoId) : await detectUpload(deal);
  if (!snapshot) return revert(input.videoId ? `Video ${input.videoId} not found` : "No eligible public upload yet");

  const ctx: AuditContext = {
    brandName: deal.brandName,
    productName: deal.productName,
    conditions: t.conditionsJson,
    videoDurationSec: snapshot.durationSec,
  };
  const transcriptHash = input.transcript ? hashJson(input.transcript) : "";
  const urlKey = verdictCacheKey(snapshot.videoId, ctx, "youtube_url");
  const transcriptKey = verdictCacheKey(snapshot.videoId, ctx, "transcript", transcriptHash);
  const cached = await findCachedVerdict(input.preferTranscript && input.transcript ? [transcriptKey] : [urlKey, transcriptKey]);

  let verdict: GeminiVerdict;
  let source: AuditSource;
  let model: string;
  let latencyMs = 0;
  let cacheKey: string;
  let fallbackReason: string | undefined;

  if (cached) {
    ({ verdict, source, model } = cached);
    cacheKey = cached.key;
  } else {
    await emit(runId, deal.id, t.id, "UPLOAD_DETECTED", true, `Upload detected: "${snapshot.title}" (${snapshot.videoId}), published ${snapshot.publishedAt}`, {
      videoId: snapshot.videoId,
      title: snapshot.title,
      publishedAt: snapshot.publishedAt,
      durationSec: snapshot.durationSec,
    });
    const result = await auditVideo(snapshot.videoId, ctx, { transcript: input.transcript, preferTranscript: input.preferTranscript });
    ({ verdict, source, model, latencyMs, fallbackReason } = result);
    cacheKey = source === "transcript" ? transcriptKey : urlKey;
  }

  const findings = evaluateVideoFindings({ verdict, snapshot, conditions: t.conditionsJson, expectedChannelId: deal.youtubeChannelId, source });
  const stateHash = hashJson({ v: snapshot.videoId, d: snapshot.description, p: snapshot.privacyStatus, t: snapshot.title, f: findings });

  // A scheduled poll that sees nothing new does not re-log an unchanged refusal.
  if (cached && input.trigger === "poll") {
    const last = await lastAudit(t.id);
    if (last && last.stateHash === stateHash && last.videoId === snapshot.videoId) return revert("Unchanged since last audit");
  }
  if (cached) {
    await emit(runId, deal.id, t.id, "UPLOAD_DETECTED", true, `Upload detected: "${snapshot.title}" (${snapshot.videoId})`, {
      videoId: snapshot.videoId,
      title: snapshot.title,
      publishedAt: snapshot.publishedAt,
    });
  }

  await emit(runId, deal.id, t.id, "MULTIMODAL_ANALYSIS", true, describeFindings(findings, t, source, !!cached), {
    source,
    model,
    cached: !!cached,
    latencyMs,
    fallbackReason,
    findings,
  });

  const audit = await recordAudit({ deal, t, snapshot, verdict, findings, source, model, cacheKey, stateHash, latencyMs });
  return decide(runId, deal.id, t.id, audit, findings, `Video ${snapshot.videoId} evaluated against tranche ${t.trancheIndex + 1}`);
}

async function processViews(runId: string, deal: Deal, t: Tranche, publish: Tranche, revert: Revert): Promise<TrancheOutcome> {
  const videoId = deal.boundVideoId ?? publish.boundVideoId;
  if (!videoId) return revert("No bound video");
  const snapshot = await getVideoSnapshot(videoId);
  if (!snapshot) return revert("Bound video not found");
  const target = t.conditionsJson.minViews;
  const progress = `${snapshot.viewCount.toLocaleString("en-US")} / ${target.toLocaleString("en-US")} views`;
  if (snapshot.viewCount < target) return revert(progress);

  const findings = evaluateMetadataFindings(snapshot, deal.youtubeChannelId);
  await emit(runId, deal.id, t.id, "MULTIMODAL_ANALYSIS", true, `View milestone reached: ${progress} (YouTube Data API)`, { source: "metadata", findings });
  const audit = await recordAudit({
    deal,
    t,
    snapshot,
    verdict: null,
    findings,
    source: "metadata",
    model: "youtube-data-api",
    cacheKey: null,
    stateHash: hashJson({ v: videoId, views: snapshot.viewCount }),
    latencyMs: 0,
  });
  return decide(runId, deal.id, t.id, audit, findings, `View milestone reached: ${progress}`);
}

async function processRetention(runId: string, deal: Deal, t: Tranche, publish: Tranche, now: Date, revert: Revert): Promise<TrancheOutcome> {
  const videoId = deal.boundVideoId ?? publish.boundVideoId;
  if (!videoId || !publish.paidOutAt) return revert("No bound video");
  const until = new Date(publish.paidOutAt.getTime() + t.conditionsJson.deadlineDays * env().DEMO_DAY_MS);
  if (now < until) {
    const elapsed = (now.getTime() - publish.paidOutAt.getTime()) / env().DEMO_DAY_MS;
    return revert(`Public for ${elapsed.toFixed(1)} of ${t.conditionsJson.deadlineDays} day(s)`);
  }
  const snapshot = await getVideoSnapshot(videoId);
  if (!snapshot) return revert("Bound video not found");
  const findings = evaluateMetadataFindings(snapshot, deal.youtubeChannelId);
  await emit(runId, deal.id, t.id, "MULTIMODAL_ANALYSIS", true, `Retention period met: video still ${snapshot.privacyStatus} after ${t.conditionsJson.deadlineDays} day(s)`, {
    source: "metadata",
    findings,
  });
  const audit = await recordAudit({
    deal,
    t,
    snapshot,
    verdict: null,
    findings,
    source: "metadata",
    model: "youtube-data-api",
    cacheKey: null,
    stateHash: hashJson({ v: videoId, p: snapshot.privacyStatus, until: until.toISOString() }),
    latencyMs: 0,
  });
  return decide(runId, deal.id, t.id, audit, findings, `Video stayed public for ${t.conditionsJson.deadlineDays} day(s)`);
}

// ---------------------------------------------------------------------------
// Firewall decision
// ---------------------------------------------------------------------------

async function decide(runId: string, dealId: string, trancheId: string, audit: EvidenceAudit, findings: AuditFindings, rationale: string): Promise<TrancheOutcome> {
  const deal = await loadDeal(dealId);
  const tranches = await loadTranches(dealId);
  const t = tranches.find((x) => x.id === trancheId)!;
  const now = new Date();
  const e = env();

  const intent: PaymentIntent = {
    dealId: deal.id,
    trancheId: t.id,
    trancheIndex: t.trancheIndex,
    trancheType: t.type,
    creatorPayPalId: deal.creatorPaypalId,
    amount: toCents(t.amount),
    currency: "USD",
    idempotencyKey: deriveIdempotencyKey(deal.id, t.id, t.captureAttempt),
    captureAttempt: t.captureAttempt,
    evidence: {
      auditId: audit.id,
      videoId: audit.videoId,
      channelId: audit.snapshot.channelId,
      isPublic: findings.isPublic,
      publishedAt: new Date(audit.snapshot.publishedAt).toISOString(),
      capturedAt: audit.createdAt.toISOString(),
      hasAdDisclosure: findings.hasAdDisclosure,
      brandSegmentDurationSec: findings.brandSegmentDurationSec,
      keywordFound: findings.keywordFound,
      viewCount: findings.viewCount,
      confidenceScore: Number(findings.confidenceScore.toFixed(3)),
      sha256EvidenceHash: audit.sha256EvidenceHash,
    },
    rationale: rationale.slice(0, 500),
  };

  const usedKeys = await db()
    .select({ k: schema.firewallDecisions.idempotencyKey })
    .from(schema.firewallDecisions)
    .where(and(eq(schema.firewallDecisions.trancheId, t.id), eq(schema.firewallDecisions.decision, "APPROVED")));

  const policy = buildPolicy(deal, t, tranches, audit, now, new Set(usedKeys.map((r) => r.k)), e);
  const fw = evaluateSpendFirewall(intent, policy, toCents(deal.capturedTotal));

  let decisionId: string;
  try {
    const [row] = await db()
      .insert(schema.firewallDecisions)
      .values({
        trancheId: t.id,
        dealId: deal.id,
        auditId: audit.id,
        intentHash: fw.intentHash,
        decision: fw.decision,
        refusalReasons: fw.refusalReasons,
        idempotencyKey: intent.idempotencyKey,
        intentJson: intent,
        ruleResults: fw.rules,
        policyVersion: fw.policyVersion,
      })
      .returning({ id: schema.firewallDecisions.id });
    decisionId = row!.id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // The database already holds an APPROVED decision for this key: replay.
    await setStatus(t, "REFUSED", { lastError: "IDEMPOTENCY_NOT_REPLAYED: key already approved (database guard)", lastAuditId: audit.id });
    await emit(runId, deal.id, t.id, "REFUSED", false, "Replay blocked by the database: this PayPal-Request-Id was already approved");
    return { trancheIndex: t.trancheIndex, type: t.type, status: "REFUSED", note: "Replay blocked" };
  }

  const passed = fw.rules.filter((r) => r.passed).length;
  await emit(
    runId,
    deal.id,
    t.id,
    "FIREWALL_EVALUATION",
    fw.decision === "APPROVED",
    fw.decision === "APPROVED"
      ? `Spend Firewall APPROVED: ${passed}/${fw.rules.length} rules passed`
      : `Spend Firewall REJECTED: ${fw.refusalReasons.map((r) => r.split(":")[0]).join(", ")}`,
    { decisionId, rules: fw.rules, intentHash: fw.intentHash, idempotencyKey: intent.idempotencyKey },
  );

  if (fw.decision === "REJECTED") {
    await setStatus(t, "REFUSED", { lastError: fw.refusalReasons.join(" | "), lastAuditId: audit.id, progressNote: null });
    await emit(runId, deal.id, t.id, "REFUSED", false, `Money withheld: ${refusalSummary(fw, findings)}`, {
      refusalReasons: fw.refusalReasons,
      citations: findings.citations,
    });
    return { trancheIndex: t.trancheIndex, type: t.type, status: "REFUSED", note: fw.refusalReasons.join(" | ") };
  }

  await setStatus(t, "APPROVED", {
    approvedDecisionId: decisionId,
    lastAuditId: audit.id,
    lastError: null,
    progressNote: null,
    boundVideoId: t.type === "PUBLISH_VERIFIED" ? audit.videoId : undefined,
  });
  return release(runId, t.id, intent, fw);
}

export function buildPolicy(
  deal: Deal,
  t: Tranche,
  tranches: Tranche[],
  audit: EvidenceAudit,
  now: Date,
  usedKeys: ReadonlySet<string>,
  e = env(),
): DealPolicy {
  const authorizedAt = deal.authorizedAt ?? now;
  const publish = tranches.find((x) => x.type === "PUBLISH_VERIFIED");
  const authEnd = deal.authorizationExpiresAt ?? new Date(authorizedAt.getTime() + AUTH_VALIDITY_MS);
  const c = t.conditionsJson;
  return {
    dealId: deal.id,
    trancheId: t.id,
    trancheIndex: t.trancheIndex,
    trancheType: t.type,
    approvedCreatorEmail: deal.creatorPaypalId,
    currency: "USD",
    authorizedCap: toCents(deal.authorizedAmount),
    trancheAmount: toCents(t.amount),
    expectedChannelId: deal.youtubeChannelId,
    expectedAuditId: audit.id,
    expectedEvidenceHash: audit.sha256EvidenceHash,
    requireAdDisclosure: t.type === "PUBLISH_VERIFIED" && c.requireAdDisclosure,
    minBrandSegmentSec: t.type === "PUBLISH_VERIFIED" ? c.minDurationSec : 0,
    targetKeyword: t.type === "PUBLISH_VERIFIED" ? c.targetKeyword : null,
    minViews: t.type === "VIEW_MILESTONE" ? c.minViews : 0,
    retentionRequiredUntil:
      t.type === "RETENTION_ACTIVE" && publish?.paidOutAt ? new Date(publish.paidOutAt.getTime() + c.deadlineDays * e.DEMO_DAY_MS) : null,
    minConfidenceThreshold: e.MIN_CONFIDENCE,
    activeWindow: { start: authorizedAt, end: t.deadlineAt ?? authEnd },
    clockDriftToleranceMs: e.CLOCK_DRIFT_TOLERANCE_MS,
    maxEvidenceAgeMs: e.MAX_EVIDENCE_AGE_SECONDS * 1000,
    usedIdempotencyKeys: usedKeys,
    dependencySatisfied: t.type === "PUBLISH_VERIFIED" || publish?.status === "PAID_OUT",
    paymentsEnabled: e.PAYMENTS_ENABLED === "true",
    isLastOpenTranche: tranches.filter((x) => x.id !== t.id && x.status !== "PAID_OUT" && x.status !== "VOIDED").length === 0,
    now,
  };
}

// ---------------------------------------------------------------------------
// Money movement — the only code that calls capture / payout
// ---------------------------------------------------------------------------

async function release(runId: string, trancheId: string, intent: PaymentIntent, fw: Pick<FirewallResult, "finalCapture">): Promise<TrancheOutcome> {
  let t = await loadTranche(trancheId);
  const deal = await loadDeal(t.dealId);
  const outcome = (status: TrancheStatus, note: string): TrancheOutcome => ({ trancheIndex: t.trancheIndex, type: t.type, status, note });

  // Capture (APPROVED and not yet captured)
  if (t.status === "APPROVED" && !t.captureId) {
    // Re-check the balance under a row lock; the firewall checked it moments ago.
    const balanceOk = await db().transaction(async (tx) => {
      const [locked] = await tx.select().from(schema.deals).where(eq(schema.deals.id, deal.id)).for("update");
      return !!locked && toCents(locked.capturedTotal) + intent.amount <= toCents(locked.authorizedAmount);
    });
    if (!balanceOk) {
      await setStatus(t, "REFUSED", { lastError: "BUDGET_CAP re-check under row lock failed" });
      return outcome("REFUSED", "Balance re-check failed");
    }
    if (!deal.authorizationId) throw new Error(`Deal ${deal.id} has no authorization id`);

    try {
      const cap = await captureAuthorizedOrder(deal.authorizationId, intent.amount, fw.finalCapture, intent.idempotencyKey, {
        invoiceId: `tranche-${t.id}`,
        noteToPayer: `Tranche ${t.trancheIndex + 1} of "${deal.title}": ${t.label}`,
      });
      await ledger({
        dealId: deal.id,
        trancheId: t.id,
        kind: "CAPTURE",
        requestId: intent.idempotencyKey,
        paypalId: cap.data.id,
        debugId: cap.debugId,
        status: cap.data.status,
        amount: intent.amount,
        request: cap.body,
        response: cap.data,
      });
      if (cap.data.status !== "COMPLETED" && cap.data.status !== "PENDING") {
        throw new PayPalError(422, "CAPTURE_NOT_COMPLETED", JSON.stringify(cap.data), cap.debugId, cap.data.status);
      }
      const capturedCents = toCents(cap.data.amount.value);
      await db().transaction(async (tx) => {
        const updated = await tx
          .update(schema.tranches)
          .set({ status: "CAPTURED", captureId: cap.data.id, capturedAt: new Date(), lastError: null, updatedAt: new Date() })
          .where(and(eq(schema.tranches.id, t.id), eq(schema.tranches.status, "APPROVED"), isNull(schema.tranches.captureId)))
          .returning({ id: schema.tranches.id });
        // Guarded so a resumed capture never double-counts.
        if (updated.length > 0) {
          await tx
            .update(schema.deals)
            .set({
              capturedTotal: sql`${schema.deals.capturedTotal} + ${fromCents(capturedCents)}::numeric`,
              status: "IN_PROGRESS",
              boundVideoId: t.type === "PUBLISH_VERIFIED" ? intent.evidence.videoId : undefined,
              updatedAt: new Date(),
            })
            .where(eq(schema.deals.id, deal.id));
        }
      });
      await emit(runId, deal.id, t.id, "CAPTURE", true, `Captured ${formatUsd(capturedCents)} from the authorization (final_capture=${fw.finalCapture}), capture ${cap.data.id}`, {
        captureId: cap.data.id,
        amount: fromCents(capturedCents),
        finalCapture: fw.finalCapture,
        paypalRequestId: intent.idempotencyKey,
      });
      t = await loadTranche(t.id);
    } catch (err) {
      return handleCaptureFailure(runId, t, intent, err);
    }
  }

  // Payout (CAPTURED)
  if (t.status === "CAPTURED") {
    const senderBatchId = derivePayoutBatchId(t.id);
    try {
      const payout = await createPayout(
        deal.creatorPaypalId,
        intent.amount,
        `${deal.brandName} released tranche ${t.trancheIndex + 1} ("${t.label}") of "${deal.title}". Verified by Tranche: ${intent.rationale}`,
        {
          senderBatchId,
          senderItemId: t.id,
          emailSubject: `${deal.brandName} released ${formatUsd(intent.amount)} for "${deal.title}"`,
        },
      );
      const batch = payout.data.batch_header;
      await ledger({
        dealId: deal.id,
        trancheId: t.id,
        kind: "PAYOUT",
        requestId: senderBatchId,
        paypalId: batch.payout_batch_id,
        debugId: payout.debugId,
        status: batch.batch_status,
        amount: intent.amount,
        request: payout.body,
        response: payout.data,
      });
      await db()
        .update(schema.tranches)
        .set({ status: "PAID_OUT", payoutBatchId: batch.payout_batch_id, payoutStatus: batch.batch_status, paidOutAt: new Date(), lastError: null, updatedAt: new Date() })
        .where(and(eq(schema.tranches.id, t.id), eq(schema.tranches.status, "CAPTURED")));
      await emit(runId, deal.id, t.id, "PAYOUT", true, `Paid ${formatUsd(intent.amount)} to ${maskEmail(deal.creatorPaypalId)} in payout batch ${batch.payout_batch_id} (${batch.batch_status.toLowerCase()})`, {
        payoutBatchId: batch.payout_batch_id,
        batchStatus: batch.batch_status,
        senderBatchId,
      });
      return outcome("PAID_OUT", `Captured and paid out ${formatUsd(intent.amount)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db().update(schema.tranches).set({ lastError: `Payout pending retry: ${message}`, updatedAt: new Date() }).where(eq(schema.tranches.id, t.id));
      await emit(runId, deal.id, t.id, "PAYOUT", false, `Payout failed; funds are captured and the payout will retry with the same sender_batch_id: ${message.slice(0, 200)}`);
      return outcome("CAPTURED", `Payout pending: ${message}`);
    }
  }
  return outcome(t.status as TrancheStatus, `Nothing to release in status ${t.status}`);
}

async function handleCaptureFailure(runId: string, t: Tranche, intent: PaymentIntent, err: unknown): Promise<TrancheOutcome> {
  const message = err instanceof Error ? err.message : String(err);
  const definitive = err instanceof PayPalError && err.definitive;
  await ledger({
    dealId: t.dealId,
    trancheId: t.id,
    kind: "CAPTURE",
    requestId: `${intent.idempotencyKey}:failed:${Date.now()}`,
    paypalId: null,
    debugId: err instanceof PayPalError ? err.debugId : null,
    status: definitive ? "FAILED" : "UNKNOWN_RETRYING",
    amount: intent.amount,
    request: null,
    response: err instanceof PayPalError ? safeJson(err.body) : message,
  });
  if (definitive) {
    // PayPal refused: nothing moved. A fresh attempt gets a fresh key.
    await setStatus(t, "REFUSED", { lastError: `Capture refused by PayPal: ${message}`, captureAttempt: t.captureAttempt + 1 });
    await emit(runId, t.dealId, t.id, "CAPTURE", false, `PayPal refused the capture; nothing moved: ${message.slice(0, 200)}`);
    return { trancheIndex: t.trancheIndex, type: t.type, status: "REFUSED", note: message };
  }
  // Unknown outcome: stay APPROVED; the next run resumes with the SAME request id.
  await db().update(schema.tranches).set({ lastError: `Capture pending retry: ${message}`, updatedAt: new Date() }).where(eq(schema.tranches.id, t.id));
  await emit(runId, t.dealId, t.id, "CAPTURE", false, `Capture outcome unknown; will retry with the same PayPal-Request-Id: ${message.slice(0, 200)}`);
  return { trancheIndex: t.trancheIndex, type: t.type, status: "APPROVED", note: message };
}

/** Resume an APPROVED or CAPTURED tranche from its stored APPROVED decision. */
async function resumeRelease(runId: string, trancheId: string): Promise<TrancheOutcome> {
  const t = await loadTranche(trancheId);
  const [decision] = t.approvedDecisionId
    ? await db().select().from(schema.firewallDecisions).where(eq(schema.firewallDecisions.id, t.approvedDecisionId))
    : [];
  if (!decision) return { trancheIndex: t.trancheIndex, type: t.type, status: t.status as TrancheStatus, note: "No approved decision to resume" };
  const intent = PaymentIntentSchema.parse(decision.intentJson);
  const others = await loadTranches(t.dealId);
  const finalCapture = others.filter((x) => x.id !== t.id && x.status !== "PAID_OUT" && x.status !== "VOIDED").length === 0;
  return release(runId, t.id, intent, { finalCapture });
}

// ---------------------------------------------------------------------------
// Deal-level helpers
// ---------------------------------------------------------------------------

async function detectUpload(deal: Deal): Promise<VideoSnapshot | null> {
  const ids = await listRecentUploadIds(deal.youtubeChannelId, 10);
  const paidElsewhere = await videosPaidByOtherDeals(deal.id);
  const since = (deal.authorizedAt?.getTime() ?? 0) - env().CLOCK_DRIFT_TOLERANCE_MS;
  const snaps = (await getVideoSnapshots(ids))
    .filter((s) => s.channelId === deal.youtubeChannelId)
    .filter((s) => Date.parse(s.publishedAt) >= since)
    .filter((s) => s.privacyStatus === "public" && s.uploadStatus === "processed")
    .filter((s) => !paidElsewhere.includes(s.videoId))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return snaps[0] ?? null;
}

async function detectBreach(deal: Deal, tranches: Tranche[]): Promise<string | null> {
  if (!deal.boundVideoId) return null;
  const open = tranches.some((t) => t.status === "PENDING" || t.status === "REFUSED");
  if (!open) return null;
  const snapshot = await getVideoSnapshot(deal.boundVideoId);
  if (!snapshot) return `the paid video ${deal.boundVideoId} was deleted`;
  if (snapshot.privacyStatus !== "public") return `the paid video ${deal.boundVideoId} is now ${snapshot.privacyStatus}`;
  return null;
}

/** Voids whatever is still held, then closes the deal. Idempotent. */
export async function closeDeal(runId: string, dealId: string, reason: string): Promise<void> {
  const deal = await loadDeal(dealId);
  if (deal.status !== "AUTHORIZED" && deal.status !== "IN_PROGRESS") return;
  const remaining = toCents(deal.authorizedAmount) - toCents(deal.capturedTotal);
  if (remaining > 0 && deal.authorizationId) {
    const auth = await getAuthorization(deal.authorizationId);
    if (["CREATED", "PARTIALLY_CAPTURED", "PENDING"].includes(auth.data.status)) {
      const requestId = `void-${deal.authorizationId}`;
      const res = await voidAuthorization(deal.authorizationId, requestId);
      await ledger({
        dealId,
        trancheId: null,
        kind: "VOID",
        requestId,
        paypalId: deal.authorizationId,
        debugId: res.debugId,
        status: "VOIDED",
        amount: remaining,
        request: { reason },
        response: res.data,
      });
    }
  }
  const status = toCents(deal.capturedTotal) > 0 ? "COMPLETED" : "VOIDED";
  await db().update(schema.deals).set({ status, updatedAt: new Date() }).where(eq(schema.deals.id, dealId));
  await emit(
    runId,
    dealId,
    null,
    "DEAL_CLOSED",
    status === "COMPLETED",
    `Deal ${status.toLowerCase()}: ${reason}. Paid ${formatUsd(toCents(deal.capturedTotal))}${remaining > 0 ? `, released ${formatUsd(remaining)} back to the brand` : ""}`,
    { remaining: fromCents(Math.max(0, remaining)) },
  );
}

async function videosPaidByOtherDeals(dealId: string): Promise<string[]> {
  const rows = await db()
    .select({ v: schema.tranches.boundVideoId })
    .from(schema.tranches)
    .where(
      and(
        eq(schema.tranches.type, "PUBLISH_VERIFIED"),
        ne(schema.tranches.dealId, dealId),
        inArray(schema.tranches.status, ["APPROVED", "CAPTURED", "PAID_OUT"]),
      ),
    );
  return rows.flatMap((r) => (r.v ? [r.v] : []));
}

async function findCachedVerdict(keys: string[]): Promise<{ verdict: GeminiVerdict; source: AuditSource; model: string; key: string } | null> {
  const [row] = await db()
    .select({ verdict: schema.evidenceAudits.rawVerdictJson, source: schema.evidenceAudits.source, model: schema.evidenceAudits.model, key: schema.evidenceAudits.verdictCacheKey })
    .from(schema.evidenceAudits)
    .where(inArray(schema.evidenceAudits.verdictCacheKey, keys))
    .orderBy(desc(schema.evidenceAudits.createdAt))
    .limit(1);
  return row?.verdict && row.key ? { verdict: row.verdict, source: row.source, model: row.model, key: row.key } : null;
}

async function recordAudit(a: {
  deal: Deal;
  t: Tranche;
  snapshot: VideoSnapshot;
  verdict: GeminiVerdict | null;
  findings: AuditFindings;
  source: AuditSource;
  model: string;
  cacheKey: string | null;
  stateHash: string;
  latencyMs: number;
}): Promise<EvidenceAudit> {
  const evidence = {
    videoId: a.snapshot.videoId,
    snapshot: a.snapshot,
    verdict: a.verdict,
    findings: a.findings,
    model: a.model,
    source: a.source,
    promptVersion: a.verdict ? AUDIT_PROMPT_VERSION : "metadata",
    conditions: a.t.conditionsJson,
  };
  const [row] = await db()
    .insert(schema.evidenceAudits)
    .values({
      trancheId: a.t.id,
      dealId: a.deal.id,
      videoId: a.snapshot.videoId,
      brandSegmentStartSec: a.findings.brandSegmentStartSec,
      brandSegmentEndSec: a.findings.brandSegmentEndSec,
      brandSegmentDurationSec: a.findings.brandSegmentDurationSec,
      hasAdDisclosure: a.findings.hasAdDisclosure,
      channelIdMatches: a.findings.channelIdMatches,
      confidenceScore: a.findings.confidenceScore.toFixed(3),
      rawVerdictJson: a.verdict,
      sha256EvidenceHash: hashJson(evidence),
      source: a.source,
      model: a.model,
      keywordFound: a.findings.keywordFound,
      isPublic: a.findings.isPublic,
      viewCount: a.findings.viewCount,
      videoTitle: a.snapshot.title,
      videoPublishedAt: new Date(a.snapshot.publishedAt),
      disclosureSource: a.findings.disclosureSource,
      citations: a.findings.citations,
      snapshot: a.snapshot,
      verdictCacheKey: a.cacheKey,
      stateHash: a.stateHash,
      latencyMs: a.latencyMs,
    })
    .returning();
  return row!;
}

async function lastAudit(trancheId: string): Promise<EvidenceAudit | undefined> {
  const [row] = await db()
    .select()
    .from(schema.evidenceAudits)
    .where(eq(schema.evidenceAudits.trancheId, trancheId))
    .orderBy(desc(schema.evidenceAudits.createdAt))
    .limit(1);
  return row;
}

export async function ledger(row: {
  dealId: string;
  trancheId: string | null;
  kind: (typeof schema.ledgerKind.enumValues)[number];
  requestId: string;
  paypalId: string | null;
  debugId: string | null;
  status: string;
  amount: number | null;
  request: unknown;
  response: unknown;
}) {
  await db()
    .insert(schema.paypalLedger)
    .values({
      dealId: row.dealId,
      trancheId: row.trancheId,
      kind: row.kind,
      paypalRequestId: row.requestId,
      paypalId: row.paypalId,
      paypalDebugId: row.debugId,
      status: row.status,
      amount: row.amount === null ? null : fromCents(row.amount),
      requestJson: row.request,
      responseJson: row.response,
    })
    .onConflictDoNothing({ target: schema.paypalLedger.paypalRequestId });
}

// ---------------------------------------------------------------------------
// Payout status re-check
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __tranchePayoutCheckedAt?: Map<string, number> };
const payoutCheckedAt = (g.__tranchePayoutCheckedAt ??= new Map());

/** Deals (in any status) with a paid-out tranche whose payout PayPal has not finished yet. */
export async function dealsWithPendingPayouts(): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ dealId: schema.tranches.dealId, payoutStatus: schema.tranches.payoutStatus })
    .from(schema.tranches)
    .where(and(eq(schema.tranches.status, "PAID_OUT"), sql`${schema.tranches.payoutBatchId} is not null`));
  return [...new Set(rows.filter((r) => !isPayoutFinal(r.payoutStatus)).map((r) => r.dealId))];
}

/**
 * Asks PayPal where each of the deal's unfinished payout batches stands
 * (read-only GET) and records any change on the tranche and the timeline.
 * Without `force`, a batch is checked at most once per PAYOUT_RECHECK_MS, so
 * a dashboard polling every few seconds does not hammer PayPal. Returns the
 * number of payouts whose status changed.
 */
export async function refreshPendingPayouts(dealId: string, opts: { force?: boolean } = {}): Promise<number> {
  const tranches = await db()
    .select()
    .from(schema.tranches)
    .where(and(eq(schema.tranches.dealId, dealId), eq(schema.tranches.status, "PAID_OUT"), sql`${schema.tranches.payoutBatchId} is not null`));
  const pending = tranches.filter((t) => !isPayoutFinal(t.payoutStatus));
  if (pending.length === 0) return 0;
  const [deal] = await db().select({ creatorPaypalId: schema.deals.creatorPaypalId }).from(schema.deals).where(eq(schema.deals.id, dealId));

  let changed = 0;
  for (const t of pending) {
    const batchId = t.payoutBatchId!;
    const last = payoutCheckedAt.get(batchId) ?? 0;
    if (!opts.force && Date.now() - last < env().PAYOUT_RECHECK_MS) continue;
    payoutCheckedAt.set(batchId, Date.now());

    const res = await getPayoutBatch(batchId);
    const next = payoutStatusOf(res.data);
    if (!next || next === t.payoutStatus) continue;

    // Conditional update: two checks racing (dashboard + poll) record the change once.
    const updated = await db()
      .update(schema.tranches)
      .set({ payoutStatus: next, updatedAt: new Date() })
      .where(and(eq(schema.tranches.id, t.id), t.payoutStatus === null ? isNull(schema.tranches.payoutStatus) : eq(schema.tranches.payoutStatus, t.payoutStatus)))
      .returning({ id: schema.tranches.id });
    if (updated.length === 0) continue;
    changed++;

    const amount = formatUsd(toCents(t.amount));
    const who = deal ? maskEmail(deal.creatorPaypalId) : "the creator";
    const label = payoutStatusLabel(next);
    const message =
      next.toUpperCase() === "SUCCESS"
        ? `PayPal completed payout batch ${batchId}: ${amount} delivered to ${who}`
        : isPayoutProblem(next)
          ? `PayPal reports payout batch ${batchId} as ${label}: ${amount} did not reach ${who}`
          : `PayPal updated payout batch ${batchId} to ${label}`;
    await emit(randomUUID(), dealId, t.id, "PAYOUT", !isPayoutProblem(next), message, { payoutBatchId: batchId, from: t.payoutStatus, to: next });
  }
  return changed;
}

export async function emit(runId: string, dealId: string, trancheId: string | null, step: Step, ok: boolean, message: string, data?: Record<string, unknown>) {
  await db().insert(schema.timelineEvents).values({ runId, dealId, trancheId, step, ok, message: message.slice(0, 1000), data: data ?? null });
}

async function setStatus(t: Tranche, to: TrancheStatus, extra: Partial<typeof schema.tranches.$inferInsert> = {}) {
  const current = (await loadTranche(t.id)).status as TrancheStatus;
  assertTrancheTransition(current, to);
  await db()
    .update(schema.tranches)
    .set({ ...extra, status: to, updatedAt: new Date() })
    .where(and(eq(schema.tranches.id, t.id), eq(schema.tranches.status, current)));
}

async function loadDeal(id: string): Promise<Deal> {
  const [d] = await db().select().from(schema.deals).where(eq(schema.deals.id, id));
  if (!d) throw new Error(`Deal ${id} not found`);
  return d;
}

async function loadTranche(id: string): Promise<Tranche> {
  const [t] = await db().select().from(schema.tranches).where(eq(schema.tranches.id, id));
  if (!t) throw new Error(`Tranche ${id} not found`);
  return t;
}

async function loadTranches(dealId: string): Promise<Tranche[]> {
  return db().select().from(schema.tranches).where(eq(schema.tranches.dealId, dealId)).orderBy(schema.tranches.trancheIndex);
}

function describeFindings(f: AuditFindings, t: Tranche, source: AuditSource, cached: boolean): string {
  const parts = [
    f.brandSegmentStartSec !== null
      ? `${f.brandSegmentDurationSec}s brand segment ${formatTimestamp(f.brandSegmentStartSec)}–${formatTimestamp(f.brandSegmentEndSec ?? f.brandSegmentStartSec)}`
      : "no brand segment",
    f.hasAdDisclosure ? `#ad verified (${f.disclosureSource})` : "#ad missing",
    t.conditionsJson.targetKeyword ? (f.keywordFound ? `"${t.conditionsJson.targetKeyword}" mentioned` : `"${t.conditionsJson.targetKeyword}" not mentioned`) : null,
    `confidence ${f.confidenceScore.toFixed(2)}`,
  ].filter(Boolean);
  const how = source === "transcript" ? "Transcript analysis" : "Multimodal analysis";
  return `${how}${cached ? " (cached verdict, fresh YouTube facts)" : ""}: ${parts.join(", ")}`;
}

function refusalSummary(fw: FirewallResult, f: AuditFindings): string {
  const reasons = fw.refusalReasons.map((r) => r.slice(r.indexOf(":") + 2)).join("; ");
  const segment = f.brandSegmentStartSec !== null ? ` (brand segment found at ${formatTimestamp(f.brandSegmentStartSec)}–${formatTimestamp(f.brandSegmentEndSec ?? f.brandSegmentStartSec)})` : "";
  return `${reasons}${segment}`;
}

function maskEmail(email: string): string {
  return email.replace(/^([^@]{0,2})[^@]*/, "$1***");
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
