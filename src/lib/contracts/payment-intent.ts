import { z } from "zod";
import { TRANCHE_TYPES } from "./deal-contract";

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase sha256 hex digest");

/**
 * The request to release one tranche. The orchestrator assembles it from
 * database rows and audit findings; the Spend Firewall still treats it as
 * untrusted and validates every field against the policy.
 *
 * MONEY IS INTEGER CENTS: `amount` 40000 means $400.00.
 */
export const PaymentIntentSchema = z.object({
  dealId: z.uuid(),
  trancheId: z.uuid(),
  trancheIndex: z.number().int().min(0),
  trancheType: z.enum(TRANCHE_TYPES),
  creatorPayPalId: z.email(),
  amount: z.number().int().positive(),
  currency: z.literal("USD"),
  /** PayPal-Request-Id for the capture: sha256 of deal, tranche and attempt. */
  idempotencyKey: Hex64,
  captureAttempt: z.number().int().min(0),
  evidence: z.object({
    auditId: z.uuid(),
    videoId: z.string().min(1),
    channelId: z.string().min(1),
    isPublic: z.boolean(),
    publishedAt: z.iso.datetime({ offset: true }),
    capturedAt: z.iso.datetime({ offset: true }),
    hasAdDisclosure: z.boolean(),
    brandSegmentDurationSec: z.number().int().min(0),
    keywordFound: z.boolean(),
    viewCount: z.number().int().min(0),
    confidenceScore: z.number().min(0).max(1),
    sha256EvidenceHash: Hex64,
  }),
  rationale: z.string().max(500),
});
export type PaymentIntent = z.infer<typeof PaymentIntentSchema>;
