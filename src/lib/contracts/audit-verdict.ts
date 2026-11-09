import { z } from "zod";

/**
 * What Gemini returns after watching a video (or reading its transcript).
 * Observations only: timestamps, presence, short quotes, confidence. Never an
 * amount, a payee or a verdict on the contract.
 * Absent values are empty strings, not nulls, to stay inside every
 * structured-output dialect.
 */
const Ts = z.string().describe('"MM:SS" or "H:MM:SS"; empty string when not applicable');
const Confidence = z.number().min(0).max(1);

export const GeminiVerdictSchema = z.object({
  summary: z.string().max(600),
  brandSegments: z
    .array(z.object({ start: Ts, end: Ts, description: z.string().max(200), confidence: Confidence }))
    .max(12)
    .describe("Every contiguous stretch where the sponsor's product is the focus"),
  spokenDisclosure: z.object({
    present: z.boolean(),
    timestamp: Ts,
    quote: z.string().max(120).describe("At most 12 words, verbatim"),
    confidence: Confidence,
  }),
  visualDisclosure: z.object({
    present: z.boolean(),
    timestamp: Ts,
    text: z.string().max(120),
    confidence: Confidence,
  }),
  keyword: z.object({
    found: z.boolean(),
    timestamp: Ts,
    confidence: Confidence,
  }),
});
export type GeminiVerdict = z.infer<typeof GeminiVerdictSchema>;

/** YouTube Data API facts at the moment of evaluation. */
export interface VideoSnapshot {
  videoId: string;
  channelId: string;
  title: string;
  description: string;
  publishedAt: string;
  privacyStatus: string;
  uploadStatus: string;
  durationSec: number;
  viewCount: number;
  fetchedAt: string;
}

export type AuditSource = "youtube_url" | "transcript" | "metadata";

export interface Citation {
  /** "0:42" or "0:42–1:21"; empty for metadata facts. */
  at: string;
  note: string;
  source: "video" | "transcript" | "description" | "youtube-api";
}

/** Deterministic interpretation of a verdict + snapshot, stored on evidence_audits. */
export interface AuditFindings {
  brandSegmentStartSec: number | null;
  brandSegmentEndSec: number | null;
  brandSegmentDurationSec: number;
  hasAdDisclosure: boolean;
  disclosureSource: "description" | "spoken" | "visual" | "none";
  keywordFound: boolean;
  channelIdMatches: boolean;
  isPublic: boolean;
  viewCount: number;
  /** Lowest confidence among the observations this tranche relies on. */
  confidenceScore: number;
  citations: Citation[];
}
