/**
 * Tranche — PostgreSQL schema (Drizzle ORM).
 *
 * The four tables in the spec (deals, tranches, evidence_audits,
 * firewall_decisions) carry every column the spec names. Extra columns and
 * two extra tables exist because the engine needs them:
 *   - paypal_ledger    every PayPal money call with its exact request id
 *   - timeline_events  the step-by-step log the dashboard renders live
 *
 * Amounts are numeric(12,2) in Postgres (strings in JS). Domain code converts
 * to integer cents with `toCents()` before any arithmetic.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { DealContract, TrancheConditions } from "@/lib/contracts/deal-contract";
import type { AuditSource, Citation, GeminiVerdict, VideoSnapshot } from "@/lib/contracts/audit-verdict";
import type { PaymentIntent } from "@/lib/contracts/payment-intent";
import type { RuleResult } from "@/lib/firewall/engine";

export const dealStatus = pgEnum("deal_status", ["DRAFT", "AUTHORIZED", "IN_PROGRESS", "COMPLETED", "VOIDED"]);
export const trancheType = pgEnum("tranche_type", ["PUBLISH_VERIFIED", "VIEW_MILESTONE", "RETENTION_ACTIVE"]);
export const trancheStatus = pgEnum("tranche_status", [
  "PENDING", // waiting for evidence (or for the tranche it depends on)
  "AUDITING", // claimed by one orchestrator run
  "APPROVED", // firewall approved; capture in flight
  "CAPTURED", // captured to the platform; payout pending
  "PAID_OUT", // payout accepted by PayPal
  "REFUSED", // last evaluation refused; re-auditable when evidence changes
  "VOIDED", // deadline missed or breach; never pays
]);
export const firewallDecision = pgEnum("firewall_decision", ["APPROVED", "REJECTED"]);
export const ledgerKind = pgEnum("ledger_kind", ["ORDER_CREATE", "ORDER_AUTHORIZE", "CAPTURE", "PAYOUT", "VOID"]);
export const timelineStep = pgEnum("timeline_step", [
  "UPLOAD_DETECTED",
  "MULTIMODAL_ANALYSIS",
  "FIREWALL_EVALUATION",
  "CAPTURE",
  "PAYOUT",
  "REFUSED",
  "VOIDED",
  "DEAL_CLOSED",
]);

export const deals = pgTable(
  "deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    /** Brand's PayPal payer email (or payer id), recorded when the brand approves. */
    brandPaypalId: text("brand_paypal_id"),
    /** Creator's PayPal email: the ONLY payee. Bound from a form field, never from model output. */
    creatorPaypalId: text("creator_paypal_id").notNull(),
    youtubeChannelId: text("youtube_channel_id").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    totalBudget: numeric("total_budget", { precision: 12, scale: 2 }).notNull(),
    authorizedOrderId: varchar("authorized_order_id", { length: 64 }),
    status: dealStatus("status").notNull().default("DRAFT"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

    brandName: text("brand_name").notNull(),
    productName: text("product_name").notNull(),
    termsText: text("terms_text").notNull(),
    contractJson: jsonb("contract_json").$type<DealContract>().notNull(),
    contractHash: varchar("contract_hash", { length: 64 }).notNull(),
    authorizationId: varchar("authorization_id", { length: 64 }),
    authorizedAmount: numeric("authorized_amount", { precision: 12, scale: 2 }).notNull().default("0"),
    capturedTotal: numeric("captured_total", { precision: 12, scale: 2 }).notNull().default("0"),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    authorizationExpiresAt: timestamp("authorization_expires_at", { withTimezone: true }),
    /** The video the PUBLISH_VERIFIED tranche paid for; later tranches read it. */
    boundVideoId: text("bound_video_id"),
    /** Lease so the cron poll and a manual trigger never process one deal concurrently. */
    verifyLockUntil: timestamp("verify_lock_until", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("deals_authorized_order_id_uq").on(t.authorizedOrderId), index("deals_status_idx").on(t.status)],
);

export const tranches = pgTable(
  "tranches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    trancheIndex: integer("tranche_index").notNull(),
    type: trancheType("type").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    status: trancheStatus("status").notNull().default("PENDING"),
    conditionsJson: jsonb("conditions_json").$type<TrancheConditions>().notNull(),
    payoutBatchId: varchar("payout_batch_id", { length: 64 }),
    capturedAt: timestamp("captured_at", { withTimezone: true }),

    label: text("label").notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    captureId: varchar("capture_id", { length: 64 }),
    /** Incremented only after PayPal definitively refuses a capture (nothing moved). */
    captureAttempt: integer("capture_attempt").notNull().default(0),
    boundVideoId: text("bound_video_id"),
    paidOutAt: timestamp("paid_out_at", { withTimezone: true }),
    payoutStatus: text("payout_status"),
    lastError: text("last_error"),
    /** Human-readable progress for tranches that are waiting ("1,234 / 10,000 views"). */
    progressNote: text("progress_note"),
    lastAuditId: uuid("last_audit_id"),
    approvedDecisionId: uuid("approved_decision_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tranches_deal_index_uq").on(t.dealId, t.trancheIndex),
    index("tranches_status_idx").on(t.status),
    index("tranches_bound_video_idx").on(t.boundVideoId),
  ],
);

export const evidenceAudits = pgTable(
  "evidence_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trancheId: uuid("tranche_id")
      .notNull()
      .references(() => tranches.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    brandSegmentStartSec: integer("brand_segment_start_sec"),
    brandSegmentEndSec: integer("brand_segment_end_sec"),
    brandSegmentDurationSec: integer("brand_segment_duration_sec").notNull().default(0),
    hasAdDisclosure: boolean("has_ad_disclosure").notNull(),
    channelIdMatches: boolean("channel_id_matches").notNull(),
    confidenceScore: numeric("confidence_score", { precision: 4, scale: 3 }).notNull(),
    rawVerdictJson: jsonb("raw_verdict_json").$type<GeminiVerdict | null>(),
    sha256EvidenceHash: varchar("sha256_evidence_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    source: text("source").$type<AuditSource>().notNull(),
    model: text("model").notNull(),
    keywordFound: boolean("keyword_found").notNull(),
    isPublic: boolean("is_public").notNull(),
    viewCount: integer("view_count").notNull(),
    videoTitle: text("video_title").notNull(),
    videoPublishedAt: timestamp("video_published_at", { withTimezone: true }).notNull(),
    disclosureSource: text("disclosure_source").notNull(),
    citations: jsonb("citations").$type<Citation[]>().notNull(),
    snapshot: jsonb("snapshot").$type<VideoSnapshot>().notNull(),
    /** Same video + model + prompt + conditions reuse one Gemini verdict. */
    verdictCacheKey: varchar("verdict_cache_key", { length: 64 }),
    /** Hash of what was evaluated, minus timestamps: unchanged refusals are not re-logged. */
    stateHash: varchar("state_hash", { length: 64 }).notNull(),
    latencyMs: integer("latency_ms").notNull().default(0),
  },
  (t) => [index("audits_tranche_idx").on(t.trancheId, t.createdAt), index("audits_cache_idx").on(t.verdictCacheKey)],
);

export const firewallDecisions = pgTable(
  "firewall_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trancheId: uuid("tranche_id")
      .notNull()
      .references(() => tranches.id, { onDelete: "cascade" }),
    intentHash: varchar("intent_hash", { length: 64 }).notNull(),
    decision: firewallDecision("decision").notNull(),
    refusalReasons: text("refusal_reasons").array().notNull().default(sql`ARRAY[]::text[]`),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),

    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    auditId: uuid("audit_id").references(() => evidenceAudits.id, { onDelete: "set null" }),
    idempotencyKey: varchar("idempotency_key", { length: 64 }).notNull(),
    intentJson: jsonb("intent_json").$type<PaymentIntent>().notNull(),
    ruleResults: jsonb("rule_results").$type<RuleResult[]>().notNull(),
    policyVersion: text("policy_version").notNull(),
  },
  (t) => [
    index("firewall_tranche_idx").on(t.trancheId, t.evaluatedAt),
    // Database-level replay guard: one idempotency key can be APPROVED once, ever.
    uniqueIndex("firewall_approved_key_uq").on(t.idempotencyKey).where(sql`decision = 'APPROVED'`),
  ],
);

export const paypalLedger = pgTable(
  "paypal_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    trancheId: uuid("tranche_id").references(() => tranches.id, { onDelete: "cascade" }),
    kind: ledgerKind("kind").notNull(),
    paypalRequestId: varchar("paypal_request_id", { length: 128 }).notNull(),
    paypalId: varchar("paypal_id", { length: 64 }),
    paypalDebugId: varchar("paypal_debug_id", { length: 64 }),
    status: text("status").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }),
    requestJson: jsonb("request_json").$type<unknown>(),
    responseJson: jsonb("response_json").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ledger_request_id_uq").on(t.paypalRequestId), index("ledger_deal_idx").on(t.dealId, t.createdAt)],
);

export const timelineEvents = pgTable(
  "timeline_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealId: uuid("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    trancheId: uuid("tranche_id").references(() => tranches.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    step: timelineStep("step").notNull(),
    ok: boolean("ok").notNull(),
    message: text("message").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("timeline_deal_idx").on(t.dealId, t.createdAt)],
);

export type Deal = typeof deals.$inferSelect;
export type Tranche = typeof tranches.$inferSelect;
export type EvidenceAudit = typeof evidenceAudits.$inferSelect;
export type FirewallDecisionRow = typeof firewallDecisions.$inferSelect;
export type LedgerRow = typeof paypalLedger.$inferSelect;
export type TimelineEvent = typeof timelineEvents.$inferSelect;
