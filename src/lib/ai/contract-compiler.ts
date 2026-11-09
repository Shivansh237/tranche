/**
 * Contract Compiler: plain-English sponsorship terms -> typed deal contract.
 *
 * Vercel AI SDK 7: `generateText({ output: Output.object({ schema }) })`
 * (`generateObject` is deprecated). The model output then passes through
 * `finalizeContract()`, which applies deterministic rules the model cannot
 * bypass. The payee and channel are never part of model output.
 */
import { generateText, Output } from "ai";
import { gemini } from "./provider";
import { withModelFailover } from "./models";
import { env } from "@/lib/env";
import { CompiledDealSchema, finalizeContract, type CompiledDeal, type DealContract } from "@/lib/contracts/deal-contract";

export const COMPILER_PROMPT_VERSION = "contract-compiler/v2";

const SYSTEM = `You convert a brand–creator sponsorship agreement written in plain English into a structured escrow contract.

Rules:
- Exactly one PUBLISH_VERIFIED tranche: money released when a compliant video goes live.
- VIEW_MILESTONE for view-count bonuses; RETENTION_ACTIVE for "must stay up N days" payments.
- Amounts are US dollars and MUST add up to totalBudget.
- deadlineDays: PUBLISH = days to publish (default 7); VIEW_MILESTONE = days to reach the views (default 14); RETENTION = days the video must stay public. Never above 28 (a PayPal authorization lasts 29 days).
- If the terms do not mention a disclosure, set requireAdDisclosure to true anyway (FTC and ASCI rules require it) and note it in ambiguities.
- targetKeyword: the product name or phrase the creator must say or show, or "" if none.
- Do not invent requirements the terms do not imply. List anything unclear in ambiguities.
- Never output email addresses, PayPal accounts or channel names.`;

export async function compileContract(termsText: string): Promise<{ compiled: CompiledDeal; contract: DealContract; model: string }> {
  // GEMINI_MODEL first; if Google reports it busy, the next model in GEMINI_FALLBACK_MODELS.
  // A model that takes longer than GEMINI_TIMEOUT_MS (default 40 s) is cancelled and the next one asked.
  const { result: output, model } = await withModelFailover(async (modelId, abortSignal) => {
    const res = await generateText({
      model: gemini(modelId),
      abortSignal,
      output: Output.object({ schema: CompiledDealSchema, name: "deal_contract" }),
      system: SYSTEM,
      prompt: `Deal terms:\n"""\n${termsText.slice(0, 6000)}\n"""`,
      // Gemini 3 is tuned for the default temperature (1.0); lower values can cause looping.
      // Determinism comes from finalizeContract(), not from sampling settings.
      providerOptions: { google: { thinkingConfig: { thinkingLevel: env().GEMINI_THINKING_LEVEL } } },
      // One quick retry per model; a model that is still busy hands over to the next one.
      maxRetries: 1,
    });
    return res.output;
  }, { timeoutMs: env().GEMINI_TIMEOUT_MS });
  return { compiled: output, contract: finalizeContract(output), model };
}
