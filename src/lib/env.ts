import { z } from "zod";

/**
 * Server configuration, validated once and read lazily so `next build`
 * works without secrets. The first request that needs a value fails loudly.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  APP_URL: z.url().default("http://localhost:3000"),

  PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),

  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default("gemini-3.8-flash"),
  // Gemini 3.x Flash thinks at "medium" by default; "low" is Google's setting for lowest latency.
  // ("minimal" is not supported by gemini-3.7/3.8-flash.)
  GEMINI_THINKING_LEVEL: z.enum(["low", "medium", "high"]).default("low"),
  // Comma-separated models to try, in order, when GEMINI_MODEL is busy ("high demand" 503 or a
  // 429 rate limit) or too slow (see the timeouts below). Empty string disables failover.
  GEMINI_FALLBACK_MODELS: z.string().default("gemini-3.6-flash"),
  // How long to wait for a model before switching to the next one (the last model is never cut off).
  // Text calls (contract compile, transcript audit, copilot) and video audits differ: Google needs
  // time to fetch and watch a YouTube video, so a short limit there would abandon working audits.
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(40_000),
  GEMINI_VIDEO_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  YOUTUBE_API_KEY: z.string().min(1),

  CRON_SECRET: z.string().min(16),

  PAYMENTS_ENABLED: z.enum(["true", "false"]).default("true"),
  MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.85),
  CLOCK_DRIFT_TOLERANCE_MS: z.coerce.number().int().min(0).default(60_000),
  MAX_EVIDENCE_AGE_SECONDS: z.coerce.number().int().positive().default(900),
  /** Length of one contract "day". 86400000 in production; 60000 makes demos watchable. */
  DEMO_DAY_MS: z.coerce.number().int().positive().default(86_400_000),
  // Minimum time between PayPal status checks for one payout batch that is still pending.
  PAYOUT_RECHECK_MS: z.coerce.number().int().min(0).default(15_000),
});

export type Env = z.infer<typeof EnvSchema>;
let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** For the simulation script and tests. */
export function resetEnvCache(): void {
  cached = undefined;
}
