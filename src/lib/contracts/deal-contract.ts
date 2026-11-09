/**
 * Deal contract schemas.
 *
 * `CompiledDealSchema` is the ONLY shape the LLM contract compiler may emit:
 * dollars instead of cents, no payee, no channel. `finalizeContract()` turns
 * it into the canonical `DealContract` with deterministic checks the model
 * cannot talk its way past (totals must add up, exactly one
 * PUBLISH_VERIFIED tranche first, thresholds must be meaningful).
 */
import { z } from "zod";
import { toCents, type Cents } from "@/lib/util/money";

export const TRANCHE_TYPES = ["PUBLISH_VERIFIED", "VIEW_MILESTONE", "RETENTION_ACTIVE"] as const;
export type TrancheType = (typeof TRANCHE_TYPES)[number];

/** Stored in tranches.conditions_json. */
export const TrancheConditionsSchema = z.object({
  /** PUBLISH_VERIFIED: minimum total seconds of on-camera brand segment. */
  minDurationSec: z.number().int().min(0).max(1800),
  /** PUBLISH_VERIFIED: a sponsorship disclosure (#ad etc.) is required. */
  requireAdDisclosure: z.boolean(),
  /** PUBLISH_VERIFIED: a word or phrase that must be said or shown; null if none. */
  targetKeyword: z.string().min(1).max(80).nullable(),
  /** VIEW_MILESTONE: view count that releases the tranche. 0 for other types. */
  minViews: z.number().int().min(0),
  /**
   * The tranche's window in contract days:
   *  PUBLISH_VERIFIED - must be published within N days of funding
   *  VIEW_MILESTONE   - views must be reached within N days of funding
   *  RETENTION_ACTIVE - video must stay public for N days after the publish payout
   */
  deadlineDays: z.number().int().min(1).max(28),
});
export type TrancheConditions = z.infer<typeof TrancheConditionsSchema>;

// ---------------------------------------------------------------------------
// What the LLM may emit
// ---------------------------------------------------------------------------

export const CompiledTrancheSchema = z.object({
  type: z
    .enum(TRANCHE_TYPES)
    .describe(
      "PUBLISH_VERIFIED: paid when a compliant video goes live. VIEW_MILESTONE: paid when the video reaches a view count. RETENTION_ACTIVE: paid if the video stays public for a number of days.",
    ),
  label: z.string().min(3).max(80).describe("Short label, e.g. 'Video goes live'"),
  amount: z.number().positive().describe("Amount in US dollars released by this tranche"),
  conditions: z.object({
    minDurationSec: z.number().int().min(0).max(1800).describe("PUBLISH_VERIFIED only: minimum seconds focused on the product. 0 otherwise."),
    requireAdDisclosure: z.boolean().describe("PUBLISH_VERIFIED only: true if a sponsorship disclosure is required"),
    targetKeyword: z.string().max(80).describe("PUBLISH_VERIFIED only: product name or phrase that must be said or shown. Empty string if none."),
    minViews: z.number().int().min(0).describe("VIEW_MILESTONE only: view-count threshold. 0 otherwise."),
    deadlineDays: z
      .number()
      .int()
      .min(1)
      .max(28)
      .describe("PUBLISH: days to publish. VIEW_MILESTONE: days to reach the views. RETENTION: days the video must stay public."),
  }),
});
export type CompiledTranche = z.infer<typeof CompiledTrancheSchema>;

export const CompiledDealSchema = z.object({
  title: z.string().min(3).max(100),
  brandName: z.string().min(1).max(80),
  productName: z.string().min(1).max(80),
  currency: z.literal("USD"),
  totalBudget: z.number().positive().describe("Total deal value in US dollars; must equal the sum of tranche amounts"),
  tranches: z.array(CompiledTrancheSchema).min(1).max(6),
  ambiguities: z.array(z.string().max(240)).max(8).describe("Anything in the terms you could not map exactly. Empty if none."),
});
export type CompiledDeal = z.infer<typeof CompiledDealSchema>;

// ---------------------------------------------------------------------------
// Canonical contract
// ---------------------------------------------------------------------------

export interface ContractTranche {
  index: number;
  type: TrancheType;
  label: string;
  amountCents: Cents;
  conditions: TrancheConditions;
}

export interface DealContract {
  version: 1;
  title: string;
  brandName: string;
  productName: string;
  currency: "USD";
  totalBudgetCents: Cents;
  tranches: ContractTranche[];
}

export class ContractValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Contract failed validation: ${issues.join("; ")}`);
    this.name = "ContractValidationError";
  }
}

const ORDER: Record<TrancheType, number> = { PUBLISH_VERIFIED: 0, VIEW_MILESTONE: 1, RETENTION_ACTIVE: 2 };

/**
 * Deterministic compiled-draft -> contract. Rejects instead of "fixing"
 * anything both parties should look at.
 */
export function finalizeContract(draft: CompiledDeal): DealContract {
  const issues: string[] = [];
  const sorted = [...draft.tranches].sort((a, b) => ORDER[a.type] - ORDER[b.type]);

  const tranches: ContractTranche[] = sorted.map((t, index) => {
    const keyword = t.conditions.targetKeyword.trim();
    const conditions: TrancheConditions = {
      minDurationSec: t.type === "PUBLISH_VERIFIED" ? t.conditions.minDurationSec : 0,
      requireAdDisclosure: t.type === "PUBLISH_VERIFIED" ? t.conditions.requireAdDisclosure : false,
      targetKeyword: t.type === "PUBLISH_VERIFIED" && keyword.length > 0 ? keyword : null,
      minViews: t.type === "VIEW_MILESTONE" ? t.conditions.minViews : 0,
      deadlineDays: t.conditions.deadlineDays,
    };
    if (t.type === "VIEW_MILESTONE" && conditions.minViews <= 0) {
      issues.push(`"${t.label}": a view milestone needs a view count above 0`);
    }
    return { index, type: t.type, label: t.label.trim(), amountCents: toCents(t.amount), conditions };
  });

  const publishCount = tranches.filter((t) => t.type === "PUBLISH_VERIFIED").length;
  if (publishCount !== 1) issues.push(`Exactly one PUBLISH_VERIFIED tranche is required (found ${publishCount})`);

  const totalBudgetCents = toCents(draft.totalBudget);
  const sum = tranches.reduce((s, t) => s + t.amountCents, 0);
  if (sum !== totalBudgetCents) {
    issues.push(`Tranches add up to $${(sum / 100).toFixed(2)} but the total budget is $${(totalBudgetCents / 100).toFixed(2)}`);
  }
  for (const t of tranches) {
    const parsed = TrancheConditionsSchema.safeParse(t.conditions);
    if (!parsed.success) issues.push(`"${t.label}": ${parsed.error.issues.map((i) => i.message).join(", ")}`);
  }

  if (issues.length > 0) throw new ContractValidationError(issues);
  return {
    version: 1,
    title: draft.title.trim(),
    brandName: draft.brandName.trim(),
    productName: draft.productName.trim(),
    currency: "USD",
    totalBudgetCents,
    tranches,
  };
}
