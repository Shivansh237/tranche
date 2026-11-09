/**
 * Gemini model failover.
 *
 * Every Gemini call tries GEMINI_MODEL first and then each model in
 * GEMINI_FALLBACK_MODELS, moving on when the current model
 *  - says it is out of capacity ("This model is currently experiencing high
 *    demand", HTTP 503, or a per-model rate limit, HTTP 429), or
 *  - has not answered within the time limit (GEMINI_TIMEOUT_MS for text,
 *    GEMINI_VIDEO_TIMEOUT_MS for watching a video). The slow request is
 *    cancelled on our side.
 * The last model in the chain is never cut off: with nothing left to fall back
 * to, a slow answer beats no answer. Any other error (bad key, invalid
 * request, schema failure) is thrown straight away: switching models would
 * not fix it.
 */
import { env } from "@/lib/env";

/** GEMINI_MODEL followed by the fallbacks, without duplicates or blanks. */
export function geminiModelChain(): string[] {
  const e = env();
  const chain = [e.GEMINI_MODEL, ...e.GEMINI_FALLBACK_MODELS.split(",")].map((m) => m.trim()).filter(Boolean);
  return [...new Set(chain)];
}

const BUSY_STATUS = new Set([429, 503]);
/** Google's capacity wording. Deliberately narrow: "private or unavailable" (a video error) must not match. */
const BUSY_TEXT = /high demand|model is overloaded|spikes in demand/i;
/** gRPC status names in Google's error bodies; case-sensitive on purpose. */
const BUSY_STATUS_NAME = /"status":\s*"(UNAVAILABLE|RESOURCE_EXHAUSTED)"/;

/**
 * True when Google says the model is out of capacity. Looks through the AI SDK's
 * RetryError (lastError / errors), APICallError (statusCode), @google/genai's
 * ApiError (status) and `cause` chains.
 */
export function isGeminiBusy(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  const e = error as { statusCode?: unknown; status?: unknown; message?: unknown; lastError?: unknown; errors?: unknown; cause?: unknown };
  if (typeof e.statusCode === "number" && BUSY_STATUS.has(e.statusCode)) return true;
  if (typeof e.status === "number" && BUSY_STATUS.has(e.status)) return true;
  if (typeof e.message === "string" && (BUSY_TEXT.test(e.message) || BUSY_STATUS_NAME.test(e.message))) return true;
  if (isGeminiBusy(e.lastError, depth + 1) || isGeminiBusy(e.cause, depth + 1)) return true;
  return Array.isArray(e.errors) && e.errors.some((x) => isGeminiBusy(x, depth + 1));
}

/**
 * Google's own words for a failed Gemini request, short enough for one log line:
 * the HTTP status and message of the last attempt, e.g.
 * "429: Quota exceeded for metric: …free_tier_requests, limit: 10; retry in 31.2s" or
 * "503: This model is currently experiencing high demand. …".
 * Tells a quota limit (429) apart from Google being overloaded (503).
 */
export function describeGeminiError(error: unknown): string {
  let e: unknown = error;
  for (let i = 0; i < 4 && e && typeof e === "object" && (e as { lastError?: unknown }).lastError; i++) e = (e as { lastError: unknown }).lastError;
  const { statusCode, status } = (e ?? {}) as { statusCode?: unknown; status?: unknown };
  const code = typeof statusCode === "number" ? statusCode : typeof status === "number" ? status : undefined;
  const message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
  const quota = message.match(/Quota exceeded for metric: [^,]+(?:, limit: \d+)?/)?.[0];
  const retry = message.match(/retry in [\d.]+m?s/i)?.[0];
  const text = quota ? [quota, retry].filter(Boolean).join("; ") : message.length > 200 ? `${message.slice(0, 200)}…` : message;
  return code !== undefined ? `${code}: ${text}` : text;
}

/** Every model in the chain was busy, or too slow and then busy. */
export class GeminiBusyError extends Error {
  constructor(readonly models: string[]) {
    super(
      `Google's Gemini service is busy right now (tried ${models.join(", then ")}). ` +
        "This is temporary: wait a minute and try again.",
    );
    this.name = "GeminiBusyError";
  }
}

/** A model did not answer within the time limit (its request was cancelled). */
export class GeminiSlowError extends Error {
  constructor(
    readonly model: string,
    readonly timeoutMs: number,
  ) {
    super(`${model} did not answer within ${seconds(timeoutMs)}`);
    this.name = "GeminiSlowError";
  }
}

const seconds = (ms: number) => `${Number((ms / 1000).toFixed(1))}s`;

export interface FailoverOptions {
  /** Give up on a model after this long and try the next one (never applied to the last model). */
  timeoutMs: number;
  /** Models to try in order. Defaults to GEMINI_MODEL followed by GEMINI_FALLBACK_MODELS. */
  models?: string[];
}

/**
 * Runs `call` with each model in turn until one answers. `call` must pass the
 * signal to its SDK request so a model that runs out of time is cancelled.
 * Returns the result and the model that produced it.
 */
export async function withModelFailover<T>(
  call: (model: string, signal: AbortSignal) => Promise<T>,
  opts: FailoverOptions,
): Promise<{ result: T; model: string }> {
  const chain = opts.models ?? geminiModelChain();
  for (const [i, model] of chain.entries()) {
    const isLast = i === chain.length - 1;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Rejects when the time limit passes; never settles for the last model.
    const outOfTime = new Promise<never>((_, reject) => {
      if (isLast) return;
      timer = setTimeout(() => {
        const slow = new GeminiSlowError(model, opts.timeoutMs);
        controller.abort(slow);
        reject(slow);
      }, opts.timeoutMs);
    });
    try {
      return { result: await Promise.race([call(model, controller.signal), outOfTime]), model };
    } catch (e) {
      const next = isLast ? "no more fallbacks" : `trying ${chain[i + 1]}`;
      if (e instanceof GeminiSlowError || controller.signal.aborted) {
        // A caller may enforce its own, tighter limit by throwing GeminiSlowError (the Deal Desk does).
        const limitMs = e instanceof GeminiSlowError ? e.timeoutMs : opts.timeoutMs;
        console.warn(`[gemini] ${model} did not answer within ${seconds(limitMs)}; ${next}`);
        continue;
      }
      if (!isGeminiBusy(e)) throw e;
      console.warn(`[gemini] ${model} is busy (${describeGeminiError(e)}); ${next}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new GeminiBusyError(chain);
}
