/**
 * Deterministic interpretation of evidence.
 *
 * Gemini reports observations (timestamps, presence, confidence). This module
 * turns them, plus YouTube API facts, into `AuditFindings`:
 *  - segment seconds are computed from merged timestamps, clamped to the real
 *    video length — never taken from a model-reported duration;
 *  - a disclosure token in the description is read by code (confidence 1.0);
 *  - the confidence score is the LOWEST confidence among the observations the
 *    tranche actually relies on.
 */
import type { AuditFindings, AuditSource, Citation, GeminiVerdict, VideoSnapshot } from "@/lib/contracts/audit-verdict";
import type { TrancheConditions } from "@/lib/contracts/deal-contract";
import { formatTimestamp, parseTimestamp } from "@/lib/util/time";

export const DISCLOSURE_TOKENS = ["#ad", "#sponsored", "paid partnership", "sponsored by", "#paidpartnership"] as const;

/** First disclosure token in the title or description, matched as a whole token. */
export function findDescriptionDisclosure(title: string, description: string): string | null {
  const hay = `${title}\n${description}`.toLowerCase();
  for (const token of DISCLOSURE_TOKENS) {
    const pattern = token.startsWith("#")
      ? new RegExp(`${escapeRegex(token)}(?![\\p{L}\\p{N}_])`, "u") // "#ad" must not match "#adventure"
      : new RegExp(`\\b${escapeRegex(token)}\\b`, "u");
    if (pattern.test(hay)) return token;
  }
  return null;
}

/** Merge overlapping [start, end, confidence] spans; merged confidence is the minimum. */
export function mergeSpans(spans: Array<[number, number, number]>): Array<[number, number, number]> {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number, number]> = [];
  for (const [a, b, c] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1]) {
      last[1] = Math.max(last[1], b);
      last[2] = Math.min(last[2], c);
    } else {
      out.push([a, b, c]);
    }
  }
  return out;
}

export function evaluateVideoFindings(args: {
  verdict: GeminiVerdict;
  snapshot: VideoSnapshot;
  conditions: TrancheConditions;
  expectedChannelId: string;
  source: AuditSource;
}): AuditFindings {
  const { verdict, snapshot, conditions, expectedChannelId, source } = args;
  const citeSource = source === "transcript" ? "transcript" : "video";
  const citations: Citation[] = [];
  const confidences: number[] = [];

  // Brand segment
  const spans: Array<[number, number, number]> = [];
  for (const seg of verdict.brandSegments) {
    const a = parseTimestamp(seg.start);
    const b = parseTimestamp(seg.end);
    if (a === null || b === null || b <= a) continue;
    const end = snapshot.durationSec > 0 ? Math.min(b, snapshot.durationSec) : b;
    if (end > a) spans.push([a, end, seg.confidence]);
  }
  const merged = mergeSpans(spans);
  const duration = merged.reduce((s, [a, b]) => s + (b - a), 0);
  for (const [a, b] of merged) {
    citations.push({ at: `${formatTimestamp(a)}–${formatTimestamp(b)}`, note: "Brand segment", source: citeSource });
  }
  if (conditions.minDurationSec > 0 && merged.length > 0) confidences.push(Math.min(...merged.map((m) => m[2])));

  // Disclosure: description (deterministic) first, then spoken, then visual
  const token = findDescriptionDisclosure(snapshot.title, snapshot.description);
  let hasAdDisclosure = false;
  let disclosureSource: AuditFindings["disclosureSource"] = "none";
  let disclosureConfidence: number;
  if (token) {
    hasAdDisclosure = true;
    disclosureSource = "description";
    disclosureConfidence = 1;
    citations.push({ at: "", note: `Description contains "${token}"`, source: "description" });
  } else if (verdict.spokenDisclosure.present) {
    hasAdDisclosure = true;
    disclosureSource = "spoken";
    disclosureConfidence = verdict.spokenDisclosure.confidence;
    citations.push({ at: verdict.spokenDisclosure.timestamp, note: `Spoken disclosure: "${verdict.spokenDisclosure.quote}"`, source: citeSource });
  } else if (verdict.visualDisclosure.present) {
    hasAdDisclosure = true;
    disclosureSource = "visual";
    disclosureConfidence = verdict.visualDisclosure.confidence;
    citations.push({ at: verdict.visualDisclosure.timestamp, note: `On-screen disclosure: "${verdict.visualDisclosure.text}"`, source: citeSource });
  } else {
    // Confidence that the disclosure is truly absent.
    disclosureConfidence = Math.min(verdict.spokenDisclosure.confidence, verdict.visualDisclosure.confidence);
    citations.push({ at: "", note: "No #ad or sponsorship disclosure in description, speech or on screen", source: "description" });
  }
  if (conditions.requireAdDisclosure) confidences.push(disclosureConfidence);

  // Keyword
  const keywordFound = conditions.targetKeyword === null ? false : verdict.keyword.found;
  if (conditions.targetKeyword !== null) {
    confidences.push(verdict.keyword.confidence);
    citations.push(
      keywordFound
        ? { at: verdict.keyword.timestamp, note: `Mentions "${conditions.targetKeyword}"`, source: citeSource }
        : { at: "", note: `"${conditions.targetKeyword}" not mentioned`, source: citeSource },
    );
  }

  return {
    brandSegmentStartSec: merged.length ? merged[0]![0] : null,
    brandSegmentEndSec: merged.length ? merged.at(-1)![1] : null,
    brandSegmentDurationSec: duration,
    hasAdDisclosure,
    disclosureSource,
    keywordFound,
    channelIdMatches: snapshot.channelId === expectedChannelId,
    isPublic: snapshot.privacyStatus === "public",
    viewCount: snapshot.viewCount,
    confidenceScore: confidences.length ? Math.min(...confidences) : 1,
    citations,
  };
}

/** VIEW_MILESTONE and RETENTION_ACTIVE rely only on YouTube API facts. */
export function evaluateMetadataFindings(snapshot: VideoSnapshot, expectedChannelId: string): AuditFindings {
  return {
    brandSegmentStartSec: null,
    brandSegmentEndSec: null,
    brandSegmentDurationSec: 0,
    hasAdDisclosure: findDescriptionDisclosure(snapshot.title, snapshot.description) !== null,
    disclosureSource: "none",
    keywordFound: false,
    channelIdMatches: snapshot.channelId === expectedChannelId,
    isPublic: snapshot.privacyStatus === "public",
    viewCount: snapshot.viewCount,
    confidenceScore: 1,
    citations: [
      { at: "", note: `${snapshot.viewCount.toLocaleString("en-US")} views, ${snapshot.privacyStatus} (YouTube Data API at ${snapshot.fetchedAt})`, source: "youtube-api" },
    ],
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
