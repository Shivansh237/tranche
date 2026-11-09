/**
 * Spend Firewall invariants. `npm run test:coverage` enforces 100% branch,
 * line, function and statement coverage on src/lib/firewall/engine.ts.
 */
import { describe, expect, it } from "vitest";
import {
  deriveIdempotencyKey,
  derivePayoutBatchId,
  evaluateSpendFirewall,
  FIREWALL_POLICY_VERSION,
  type DealPolicy,
  type RuleId,
} from "@/lib/firewall/engine";
import type { PaymentIntent } from "@/lib/contracts/payment-intent";

const DEAL = "11111111-1111-4111-8111-111111111111";
const TRANCHE = "22222222-2222-4222-8222-222222222222";
const AUDIT = "33333333-3333-4333-8333-333333333333";
const HASH = "a".repeat(64);
const NOW = new Date("2026-11-10T12:00:00.000Z");
const FUNDED = new Date("2026-11-10T10:00:00.000Z");
const DEADLINE = new Date("2026-11-17T10:00:00.000Z");
const CREATOR = "creator@personal.example.com";

function makeIntent(over: (i: PaymentIntent) => void = () => {}): PaymentIntent {
  const i: PaymentIntent = {
    dealId: DEAL,
    trancheId: TRANCHE,
    trancheIndex: 0,
    trancheType: "PUBLISH_VERIFIED",
    creatorPayPalId: CREATOR,
    amount: 40_000,
    currency: "USD",
    idempotencyKey: deriveIdempotencyKey(DEAL, TRANCHE, 0),
    captureAttempt: 0,
    evidence: {
      auditId: AUDIT,
      videoId: "vid123",
      channelId: "UCchannel",
      isPublic: true,
      publishedAt: "2026-11-10T11:00:00.000Z",
      capturedAt: "2026-11-10T11:59:00.000Z",
      hasAdDisclosure: true,
      brandSegmentDurationSec: 39,
      keywordFound: true,
      viewCount: 1234,
      confidenceScore: 0.94,
      sha256EvidenceHash: HASH,
    },
    rationale: "Video meets every condition",
  };
  over(i);
  return i;
}

function makePolicy(over: (p: DealPolicy) => void = () => {}): DealPolicy {
  const p: DealPolicy = {
    dealId: DEAL,
    trancheId: TRANCHE,
    trancheIndex: 0,
    trancheType: "PUBLISH_VERIFIED",
    approvedCreatorEmail: "Creator@Personal.Example.com",
    currency: "USD",
    authorizedCap: 60_000,
    trancheAmount: 40_000,
    expectedChannelId: "UCchannel",
    expectedAuditId: AUDIT,
    expectedEvidenceHash: HASH,
    requireAdDisclosure: true,
    minBrandSegmentSec: 30,
    targetKeyword: "Glow Serum",
    minViews: 0,
    retentionRequiredUntil: null,
    minConfidenceThreshold: 0.85,
    activeWindow: { start: FUNDED, end: DEADLINE },
    clockDriftToleranceMs: 60_000,
    maxEvidenceAgeMs: 15 * 60_000,
    usedIdempotencyKeys: new Set(),
    dependencySatisfied: true,
    paymentsEnabled: true,
    isLastOpenTranche: false,
    now: NOW,
  };
  over(p);
  return p;
}

function failedRules(intent: unknown, policy = makePolicy(), captured = 0): RuleId[] {
  return evaluateSpendFirewall(intent, policy, captured)
    .rules.filter((r) => !r.passed)
    .map((r) => r.rule);
}

describe("evaluateSpendFirewall — approval", () => {
  it("approves a compliant, correctly bound claim and reports every rule", () => {
    const r = evaluateSpendFirewall(makeIntent(), makePolicy(), 0);
    expect(r.decision).toBe("APPROVED");
    expect(r.refusalReasons).toEqual([]);
    expect(r.rules).toHaveLength(22);
    expect(r.rules.every((x) => x.passed)).toBe(true);
    expect(r.policyVersion).toBe(FIREWALL_POLICY_VERSION);
    expect(r.intentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.finalCapture).toBe(false);
  });

  it("sets finalCapture on the last open tranche", () => {
    expect(evaluateSpendFirewall(makeIntent(), makePolicy((p) => (p.isLastOpenTranche = true)), 0).finalCapture).toBe(true);
  });

  it("is deterministic: same inputs, same decision and hash", () => {
    const a = evaluateSpendFirewall(makeIntent(), makePolicy(), 0);
    const b = evaluateSpendFirewall(makeIntent(), makePolicy(), 0);
    expect(a).toEqual(b);
  });

  it("approves a view milestone (no disclosure, segment or keyword required)", () => {
    const policy = makePolicy((p) => {
      p.trancheType = "VIEW_MILESTONE";
      p.trancheIndex = 1;
      p.requireAdDisclosure = false;
      p.minBrandSegmentSec = 0;
      p.targetKeyword = null;
      p.minViews = 10_000;
      p.trancheAmount = 20_000;
    });
    const intent = makeIntent((i) => {
      i.amount = 20_000;
      i.trancheType = "VIEW_MILESTONE";
      i.trancheIndex = 1;
      i.evidence.hasAdDisclosure = false;
      i.evidence.brandSegmentDurationSec = 0;
      i.evidence.keywordFound = false;
      i.evidence.viewCount = 12_000;
    });
    const r = evaluateSpendFirewall(intent, policy, 40_000);
    expect(r.decision).toBe("APPROVED");
    expect(r.rules.find((x) => x.rule === "AD_DISCLOSURE")?.detail).toContain("not required");
    expect(r.rules.find((x) => x.rule === "KEYWORD_PRESENT")?.detail).toBe("No keyword required");
    expect(r.rules.find((x) => x.rule === "VIEW_MILESTONE")?.detail).toContain("12000 views");
  });

  it("approves retention once the period has passed and the video is public", () => {
    const policy = makePolicy((p) => (p.retentionRequiredUntil = new Date(NOW.getTime() - 1)));
    const r = evaluateSpendFirewall(makeIntent(), policy, 0);
    expect(r.decision).toBe("APPROVED");
    expect(r.rules.find((x) => x.rule === "RETENTION_PERIOD")?.detail).toContain("Still public after");
  });
});

describe("evaluateSpendFirewall — structural refusals", () => {
  it("rejects a malformed intent and stops before any other rule", () => {
    const r = evaluateSpendFirewall({ ...makeIntent(), amount: -5 }, makePolicy(), 0);
    expect(r.decision).toBe("REJECTED");
    expect(r.rules.map((x) => x.rule)).toEqual(["INTENT_SCHEMA"]);
    expect(r.refusalReasons[0]).toContain("amount");
  });

  it("rejects a null intent with a root-level reason", () => {
    const r = evaluateSpendFirewall(null, makePolicy(), 0);
    expect(r.decision).toBe("REJECTED");
    expect(r.refusalReasons[0]).toContain("(root)");
  });

  it("rejects an undefined intent and still produces a stable hash", () => {
    const r = evaluateSpendFirewall(undefined, makePolicy(), 0);
    expect(r.decision).toBe("REJECTED");
    expect(r.intentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects everything when the kill switch is off", () => {
    expect(failedRules(makeIntent(), makePolicy((p) => (p.paymentsEnabled = false)))).toEqual(["KILL_SWITCH"]);
  });

  it.each([
    ["dealId", (i: PaymentIntent) => (i.dealId = "99999999-9999-4999-8999-999999999999")],
    ["trancheId", (i: PaymentIntent) => (i.trancheId = "99999999-9999-4999-8999-999999999999")],
    ["trancheIndex", (i: PaymentIntent) => (i.trancheIndex = 3)],
    ["trancheType", (i: PaymentIntent) => (i.trancheType = "RETENTION_ACTIVE")],
  ])("rejects an intent bound to a different %s", (_field, mutate) => {
    expect(failedRules(makeIntent(mutate))).toContain("INTENT_BINDING");
  });
});

describe("evaluateSpendFirewall — money rules", () => {
  it("rejects a payee that is not the contract creator", () => {
    const r = evaluateSpendFirewall(makeIntent((i) => (i.creatorPayPalId = "attacker@example.com")), makePolicy(), 0);
    expect(r.decision).toBe("REJECTED");
    expect(r.refusalReasons).toEqual([expect.stringMatching(/^PAYEE_ALLOWLIST: Payee at\*\*\*@example.com is not the contract creator/)]);
  });

  it("rejects a currency mismatch", () => {
    const policy = makePolicy((p) => (p.currency = "EUR" as "USD"));
    expect(failedRules(makeIntent(), policy)).toEqual(["CURRENCY_MATCH"]);
  });

  it("rejects an amount that differs from the contract by one cent", () => {
    // 40,001 also blows no cap (60,000), so only AMOUNT_EXACT fails.
    expect(failedRules(makeIntent((i) => (i.amount = 40_001)))).toEqual(["AMOUNT_EXACT"]);
  });

  it("rejects an over-budget attempt", () => {
    expect(failedRules(makeIntent(), makePolicy(), 30_000)).toEqual(["BUDGET_CAP"]);
    const r = evaluateSpendFirewall(makeIntent(), makePolicy(), 30_000);
    expect(r.refusalReasons[0]).toContain("exceeds $600.00 authorized");
  });

  it("allows a capture that lands exactly on the cap", () => {
    expect(failedRules(makeIntent(), makePolicy(), 20_000)).toEqual([]);
  });

  it.each([[-1], [Number.NaN], [1.5]])("rejects an invalid captured total %s", (captured) => {
    const r = evaluateSpendFirewall(makeIntent(), makePolicy(), captured);
    expect(r.decision).toBe("REJECTED");
    expect(r.refusalReasons).toEqual([expect.stringContaining("Invalid captured total")]);
  });
});

describe("evaluateSpendFirewall — idempotency", () => {
  it("rejects a forged PayPal-Request-Id", () => {
    expect(failedRules(makeIntent((i) => (i.idempotencyKey = "b".repeat(64))))).toEqual(["IDEMPOTENCY_KEY_VALID"]);
  });

  it("rejects a key derived for a different attempt", () => {
    expect(failedRules(makeIntent((i) => (i.captureAttempt = 1)))).toEqual(["IDEMPOTENCY_KEY_VALID"]);
  });

  it("accepts a fresh key after a definitive refusal bumped the attempt", () => {
    const intent = makeIntent((i) => {
      i.captureAttempt = 1;
      i.idempotencyKey = deriveIdempotencyKey(DEAL, TRANCHE, 1);
    });
    const used = new Set([deriveIdempotencyKey(DEAL, TRANCHE, 0)]);
    expect(failedRules(intent, makePolicy((p) => (p.usedIdempotencyKeys = used)))).toEqual([]);
  });

  it("rejects a replay of an already-approved key", () => {
    const used = new Set([deriveIdempotencyKey(DEAL, TRANCHE, 0)]);
    const r = evaluateSpendFirewall(makeIntent(), makePolicy((p) => (p.usedIdempotencyKeys = used)), 0);
    expect(r.decision).toBe("REJECTED");
    expect(r.refusalReasons).toEqual(["IDEMPOTENCY_NOT_REPLAYED: PayPal-Request-Id was already approved: replay blocked"]);
  });

  it("derives keys deterministically and within PayPal's 108-char limit", () => {
    const k = deriveIdempotencyKey(DEAL, TRANCHE, 0);
    expect(k).toBe(deriveIdempotencyKey(DEAL, TRANCHE, 0));
    expect(k).not.toBe(deriveIdempotencyKey(DEAL, TRANCHE, 1));
    expect(k.length).toBeLessThanOrEqual(108);
    expect(derivePayoutBatchId(TRANCHE)).toBe(`tranche-payout-${TRANCHE}`);
  });
});

describe("evaluateSpendFirewall — evidence rules", () => {
  it("rejects when the publish tranche has not been paid out", () => {
    expect(failedRules(makeIntent(), makePolicy((p) => (p.dependencySatisfied = false)))).toEqual(["DEPENDENCY_SATISFIED"]);
  });

  it("rejects evidence that cites a different audit", () => {
    expect(failedRules(makeIntent((i) => (i.evidence.auditId = "44444444-4444-4444-8444-444444444444")))).toEqual(["EVIDENCE_BINDING"]);
  });

  it("rejects evidence whose hash does not match the stored audit", () => {
    expect(failedRules(makeIntent((i) => (i.evidence.sha256EvidenceHash = "c".repeat(64))))).toEqual(["EVIDENCE_BINDING"]);
  });

  it("rejects a video from another channel", () => {
    expect(failedRules(makeIntent((i) => (i.evidence.channelId = "UCother")))).toEqual(["CHANNEL_MATCH"]);
  });

  it("rejects a private video", () => {
    expect(failedRules(makeIntent((i) => (i.evidence.isPublic = false)))).toEqual(["VIDEO_PUBLIC"]);
  });

  it("rejects a missing #ad disclosure", () => {
    const r = evaluateSpendFirewall(makeIntent((i) => (i.evidence.hasAdDisclosure = false)), makePolicy(), 0);
    expect(r.decision).toBe("REJECTED");
    expect(r.refusalReasons).toEqual(["AD_DISCLOSURE: No #ad or sponsorship disclosure found"]);
  });

  it("rejects a brand segment that is too short", () => {
    const r = evaluateSpendFirewall(makeIntent((i) => (i.evidence.brandSegmentDurationSec = 8)), makePolicy(), 0);
    expect(r.refusalReasons).toEqual(["BRAND_SEGMENT_DURATION: 8s brand segment < required 30s"]);
  });

  it("accepts a segment exactly at the minimum", () => {
    expect(failedRules(makeIntent((i) => (i.evidence.brandSegmentDurationSec = 30)))).toEqual([]);
  });

  it("rejects a missing required keyword", () => {
    expect(failedRules(makeIntent((i) => (i.evidence.keywordFound = false)))).toEqual(["KEYWORD_PRESENT"]);
  });

  it("rejects a view milestone that is not reached", () => {
    const policy = makePolicy((p) => (p.minViews = 10_000));
    const r = evaluateSpendFirewall(makeIntent(), policy, 0);
    expect(r.refusalReasons).toEqual(["VIEW_MILESTONE: 1234 views < 10000"]);
  });

  it("rejects retention before the period ends", () => {
    const policy = makePolicy((p) => (p.retentionRequiredUntil = new Date(NOW.getTime() + 60_000)));
    expect(failedRules(makeIntent(), policy)).toEqual(["RETENTION_PERIOD"]);
  });

  it("rejects retention when the video went private", () => {
    const policy = makePolicy((p) => (p.retentionRequiredUntil = new Date(NOW.getTime() - 60_000)));
    const ids = failedRules(makeIntent((i) => (i.evidence.isPublic = false)), policy);
    expect(ids).toEqual(["VIDEO_PUBLIC", "RETENTION_PERIOD"]);
  });

  it("rejects confidence below the gate", () => {
    const r = evaluateSpendFirewall(makeIntent((i) => (i.evidence.confidenceScore = 0.84)), makePolicy(), 0);
    expect(r.refusalReasons).toEqual(["CONFIDENCE_GATE: Confidence 0.84 < 0.85"]);
  });

  it("accepts confidence exactly at the gate", () => {
    expect(failedRules(makeIntent((i) => (i.evidence.confidenceScore = 0.85)))).toEqual([]);
  });
});

describe("evaluateSpendFirewall — timing bounds and clock drift", () => {
  it("rejects a video published before funding", () => {
    expect(failedRules(makeIntent((i) => (i.evidence.publishedAt = "2026-11-01T00:00:00.000Z")))).toEqual(["PUBLICATION_WINDOW"]);
  });

  it("tolerates a publish time slightly before funding (clock drift)", () => {
    expect(failedRules(makeIntent((i) => (i.evidence.publishedAt = "2026-11-10T09:59:30.000Z")))).toEqual([]);
  });

  it("rejects a video published after the window closed", () => {
    const policy = makePolicy((p) => (p.now = new Date("2026-11-17T10:00:30.000Z")));
    const intent = makeIntent((i) => {
      i.evidence.publishedAt = "2026-11-17T10:05:00.000Z";
      i.evidence.capturedAt = "2026-11-17T10:00:00.000Z";
    });
    expect(failedRules(intent, policy)).toEqual(["PUBLICATION_WINDOW"]);
  });

  it("rejects a claim after the deadline", () => {
    const policy = makePolicy((p) => (p.now = new Date("2026-11-17T10:02:00.000Z")));
    const intent = makeIntent((i) => (i.evidence.capturedAt = "2026-11-17T10:01:00.000Z"));
    expect(failedRules(intent, policy)).toEqual(["DEADLINE"]);
  });

  it("tolerates database timestamps slightly ahead of the app clock", () => {
    expect(failedRules(makeIntent((i) => (i.evidence.capturedAt = "2026-11-10T12:00:30.000Z")))).toEqual([]);
  });

  it("rejects evidence timestamped beyond the drift tolerance in the future", () => {
    const r = evaluateSpendFirewall(makeIntent((i) => (i.evidence.capturedAt = "2026-11-10T12:05:00.000Z")), makePolicy(), 0);
    expect(r.refusalReasons).toEqual(["EVIDENCE_FRESH: Evidence is timestamped in the future beyond clock-drift tolerance"]);
  });

  it("rejects stale evidence", () => {
    const r = evaluateSpendFirewall(makeIntent((i) => (i.evidence.capturedAt = "2026-11-10T11:00:00.000Z")), makePolicy(), 0);
    expect(r.refusalReasons).toEqual(["EVIDENCE_FRESH: Evidence is 3600s old (stale)"]);
  });
});

describe("evaluateSpendFirewall — multiple failures", () => {
  it("reports every failed rule, not just the first", () => {
    const intent = makeIntent((i) => {
      i.creatorPayPalId = "attacker@example.com";
      i.evidence.hasAdDisclosure = false;
      i.evidence.brandSegmentDurationSec = 5;
      i.evidence.confidenceScore = 0.2;
    });
    expect(failedRules(intent, makePolicy(), 0)).toEqual(["PAYEE_ALLOWLIST", "AD_DISCLOSURE", "BRAND_SEGMENT_DURATION", "CONFIDENCE_GATE"]);
  });
});
