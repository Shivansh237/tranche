import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { env } from "@/lib/env";

/**
 * AI SDK Google provider bound to GEMINI_API_KEY. The default `google`
 * export reads GOOGLE_GENERATIVE_AI_API_KEY instead, which would silently
 * diverge from the key the video auditor uses.
 */
let provider: ReturnType<typeof createGoogleGenerativeAI> | undefined;

export function gemini(modelId: string = env().GEMINI_MODEL) {
  provider ??= createGoogleGenerativeAI({ apiKey: env().GEMINI_API_KEY });
  return provider(modelId);
}
