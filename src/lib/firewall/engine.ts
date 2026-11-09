/**
 * The deterministic Spend Firewall.
 *
 *   "The LLM proposes, deterministic code disposes."
 *
 * `evaluateSpendFirewall(intent, policy, currentCapturedTotal)` is a pure
 * function: no I/O, no clock reads (the clock arrives as `policy.now`), no
 * randomness. The same inputs always give the same decision, so every
 * decision stored in `firewall_decisions` can be replayed and audited.
 *
 * The PaymentIntent is untrusted: its evidence values come from a model's
 * observations. Every field is validated against the policy, which the
 * orchestrator builds from database rows the model cannot touch.
 *
 * ALL MONEY VALUES ARE INTEGER CENTS.
 */
import { PaymentIntentSchema, type PaymentIntent } from "@/lib/contracts/payment-intent";
import type { TrancheType } from "@/lib/contracts/deal-contract";
import { hashJson, sha256Hex } from "@/lib/util/hash";

export const FIREWALL_POLICY_VERSION = "tranche-firewall/2026-11-02";

export type RuleId =
  | "INTENT_SCHEMA"
  | "KILL_SWITCH"
  | "INTENT_BINDING"
  | "PAYEE_ALLOWLIST"
  | "CURRENCY_MATCH"
  | "AMOUNT_EXACT"
  | "BUDGET_CAP"
  | "IDEMPOTENCY_KEY_VALID"
  | "IDEMPOTENCY_NOT_REPLAYED"
  | "DEPENDENCY_SATISFIED"
  | "EVIDENCE_BINDING"
  | "CHANNEL_MATCH"
  | "VIDEO_PUBLIC"
  | "AD_DISCLOSURE"
  | "BRAND_SEGMENT_DURATION"
  | "KEYWORD_PRESENT"
  | "VIEW_MILESTONE"
  | "RETENTION_PERIOD"
  | "CONFIDENCE_GATE"
  | "PUBLICATION_WINDOW"
  | "DEADLINE"
  | "EVIDENCE_FRESH";

export interface RuleResult {
  rule: RuleId;
  passed: boolean;
  detail: string;
}

export interface DealPolicy {
  dealId: string;
  trancheId: string;
  trancheIndex: number;
  trancheType: TrancheType;
  /** The creator's PayPal email bound at deal creation: the only allowed payee. */
  approvedCreatorEmail: string;
  currency: "USD";
  /** Amount held by the PayPal authorization, in cents. */
  authorizedCap: number;
  /** This tranche's contract amount, in cents. The intent must match it exactly. */
  trancheAmount: number;
  expectedChannelId: string;
  /** The audit row the intent must cite (id + hash), read from the database. */
  expectedAuditId: string;
  expectedEvidenceHash: string;
  requireAdDisclosure: boolean;
  minBrandSegmentSec: number;
  targetKeyword: string | null;
  minViews: number;
  /** RETENTION_ACTIVE: the video must still be public at or after this instant. */
  retentionRequiredUntil: Date | null;
  minConfidenceThreshold: number;
  /** Funding time -> tranche deadline. */
  activeWindow: { start: Date; end: Date };
  /** Allowed disagreement between the app clock and database timestamps. */
  clockDriftToleranceMs: number;
  maxEvidenceAgeMs: number;
  /** Capture keys already approved for any tranche (replay guard). */
  usedIdempotencyKeys: ReadonlySet<string>;
  /** VIEW_MILESTONE / RETENTION_ACTIVE require the publish tranche to be paid out. */
  dependencySatisfied: boolean;
  /** Global kill switch (PAYMENTS_ENABLED). */
  paymentsEnabled: boolean;
  /** True when no other tranche of the deal can still pay: capture with final_capture=true. */
  isLastOpenTranche: boolean;
  now: Date;
}

export interface FirewallResult {
  decision: "APPROVED" | "REJECTED";
  rules: RuleResult[];
  refusalReasons: string[];
  intentHash: string;
  finalCapture: boolean;
  policyVersion: string;
}

/**
 * PayPal-Request-Id for a tranche capture. Deterministic per (deal, tranche,
 * attempt): resending after a crash returns PayPal's original capture. The
 * attempt only increments after PayPal definitively refused (nothing moved).
 */
export function deriveIdempotencyKey(dealId: string, trancheId: string, captureAttempt: number): string {
  return sha256Hex(`tranche/capture/v1:${dealId}:${trancheId}:${captureAttempt}`);
}

/** Payouts sender_batch_id: one per tranche, ever. PayPal rejects duplicates. */
export function derivePayoutBatchId(trancheId: string): string {
  return `tranche-payout-${trancheId}`;
}

export function evaluateSpendFirewall(
  intent: PaymentIntent | unknown,
  policy: DealPolicy,
  currentCapturedTotal: number,
): FirewallResult {
  const intentHash = hashJson(intent ?? null);
  const result = (rules: RuleResult[]): FirewallResult => {
    const failed = rules.filter((r) => !r.passed);
    return {
      decision: failed.length === 0 ? "APPROVED" : "REJECTED",
      rules,
      refusalReasons: failed.map((r) => `${r.rule}: ${r.detail}`),
      intentHash,
      finalCapture: policy.isLastOpenTranche,
      policyVersion: FIREWALL_POLICY_VERSION,
    };
  };

  // 0. Structure. Nothing else can be checked on a malformed intent.
  const parsed = PaymentIntentSchema.safeParse(intent);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ");
    return result([{ rule: "INTENT_SCHEMA", passed: false, detail: `Malformed intent: ${issues}` }]);
  }
  const i = parsed.data;
  const e = i.evidence;
  const now = policy.now.getTime();
  const drift = policy.clockDriftToleranceMs;

  const rules: RuleResult[] = [{ rule: "INTENT_SCHEMA", passed: true, detail: "Intent matches the PaymentIntent schema" }];
  const check = (rule: RuleId, passed: boolean, ok: string, fail: string) => rules.push({ rule, passed, detail: passed ? ok : fail });

  check("KILL_SWITCH", policy.paymentsEnabled, "Payments enabled", "PAYMENTS_ENABLED is false: all releases blocked");

  const bound =
    i.dealId === policy.dealId &&
    i.trancheId === policy.trancheId &&
    i.trancheIndex === policy.trancheIndex &&
    i.trancheType === policy.trancheType;
  check("INTENT_BINDING", bound, "Intent names this deal and tranche", "Intent names a different deal, tranche, index or type");

  const payee = i.creatorPayPalId.trim().toLowerCase();
  const approved = policy.approvedCreatorEmail.trim().toLowerCase();
  check("PAYEE_ALLOWLIST", payee === approved, `Payee ${mask(payee)} is the contract creator`, `Payee ${mask(payee)} is not the contract creator ${mask(approved)}`);

  check("CURRENCY_MATCH", i.currency === policy.currency, `Currency ${i.currency}`, `Currency ${i.currency} != ${policy.currency}`);

  check(
    "AMOUNT_EXACT",
    i.amount === policy.trancheAmount,
    `${cents(i.amount)} equals the contract amount`,
    `${cents(i.amount)} != contract amount ${cents(policy.trancheAmount)}`,
  );

  const capturedValid = Number.isSafeInteger(currentCapturedTotal) && currentCapturedTotal >= 0;
  const withinCap = capturedValid && currentCapturedTotal + i.amount <= policy.authorizedCap;
  check(
    "BUDGET_CAP",
    withinCap,
    `${cents(currentCapturedTotal)} captured + ${cents(i.amount)} <= ${cents(policy.authorizedCap)} authorized`,
    capturedValid
      ? `${cents(currentCapturedTotal)} captured + ${cents(i.amount)} exceeds ${cents(policy.authorizedCap)} authorized`
      : `Invalid captured total ${String(currentCapturedTotal)}`,
  );

  const expectedKey = deriveIdempotencyKey(i.dealId, i.trancheId, i.captureAttempt);
  check(
    "IDEMPOTENCY_KEY_VALID",
    i.idempotencyKey === expectedKey,
    `PayPal-Request-Id ${i.idempotencyKey.slice(0, 12)}… derived for attempt ${i.captureAttempt}`,
    "PayPal-Request-Id does not match the deterministic key for this tranche and attempt",
  );
  check(
    "IDEMPOTENCY_NOT_REPLAYED",
    !policy.usedIdempotencyKeys.has(i.idempotencyKey),
    "PayPal-Request-Id has never been approved before",
    "PayPal-Request-Id was already approved: replay blocked",
  );

  check(
    "DEPENDENCY_SATISFIED",
    policy.dependencySatisfied,
    "No unmet dependency",
    "The PUBLISH_VERIFIED tranche has not been paid out yet",
  );

  check(
    "EVIDENCE_BINDING",
    e.auditId === policy.expectedAuditId && e.sha256EvidenceHash === policy.expectedEvidenceHash,
    `Evidence ${e.sha256EvidenceHash.slice(0, 12)}… matches stored audit`,
    "Evidence does not match the stored audit record",
  );

  check("CHANNEL_MATCH", e.channelId === policy.expectedChannelId, "Video is on the contracted channel", `Channel ${e.channelId} is not ${policy.expectedChannelId}`);

  check("VIDEO_PUBLIC", e.isPublic, "Video is public", "Video is not public");

  check(
    "AD_DISCLOSURE",
    !policy.requireAdDisclosure || e.hasAdDisclosure,
    policy.requireAdDisclosure ? "#ad / sponsorship disclosure present" : "Disclosure not required for this tranche",
    "No #ad or sponsorship disclosure found",
  );

  check(
    "BRAND_SEGMENT_DURATION",
    e.brandSegmentDurationSec >= policy.minBrandSegmentSec,
    `${e.brandSegmentDurationSec}s brand segment >= ${policy.minBrandSegmentSec}s`,
    `${e.brandSegmentDurationSec}s brand segment < required ${policy.minBrandSegmentSec}s`,
  );

  check(
    "KEYWORD_PRESENT",
    policy.targetKeyword === null || e.keywordFound,
    policy.targetKeyword === null ? "No keyword required" : `"${policy.targetKeyword}" mentioned`,
    `"${policy.targetKeyword}" not mentioned`,
  );

  check(
    "VIEW_MILESTONE",
    policy.minViews === 0 || e.viewCount >= policy.minViews,
    policy.minViews === 0 ? "No view milestone" : `${e.viewCount} views >= ${policy.minViews}`,
    `${e.viewCount} views < ${policy.minViews}`,
  );

  const until = policy.retentionRequiredUntil;
  check(
    "RETENTION_PERIOD",
    until === null || (now >= until.getTime() && e.isPublic),
    until === null ? "No retention period" : `Still public after ${until.toISOString()}`,
    `Retention not met: must stay public until ${until?.toISOString()}`,
  );

  check(
    "CONFIDENCE_GATE",
    e.confidenceScore >= policy.minConfidenceThreshold,
    `Confidence ${e.confidenceScore.toFixed(2)} >= ${policy.minConfidenceThreshold}`,
    `Confidence ${e.confidenceScore.toFixed(2)} < ${policy.minConfidenceThreshold}`,
  );

  const published = Date.parse(e.publishedAt);
  const start = policy.activeWindow.start.getTime();
  const end = policy.activeWindow.end.getTime();
  check(
    "PUBLICATION_WINDOW",
    published >= start - drift && published <= end + drift,
    `Published ${e.publishedAt}, inside the deal window`,
    `Published ${e.publishedAt}, outside ${policy.activeWindow.start.toISOString()} – ${policy.activeWindow.end.toISOString()}`,
  );

  check("DEADLINE", now <= end + drift, "Before the tranche deadline", `Deadline ${policy.activeWindow.end.toISOString()} has passed`);

  const age = now - Date.parse(e.capturedAt);
  check(
    "EVIDENCE_FRESH",
    age >= -drift && age <= policy.maxEvidenceAgeMs,
    `Evidence ${Math.round(age / 1000)}s old`,
    age < -drift ? "Evidence is timestamped in the future beyond clock-drift tolerance" : `Evidence is ${Math.round(age / 1000)}s old (stale)`,
  );

  return result(rules);
}

function mask(email: string): string {
  return email.replace(/^([^@]{0,2})[^@]*/, "$1***");
}

function cents(n: number): string {
  return `$${(n / 100).toFixed(2)}`;
}
