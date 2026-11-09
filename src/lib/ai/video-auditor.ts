/**
 * Multimodal Video Audit Engine (Gemini via @google/genai).
 *
 * Primary path: pass the PUBLIC YouTube URL as a `fileData` part. Gemini's
 * YouTube input is a preview feature and rejects unlisted/private videos.
 *
 * Fallback path: inspect a timestamped transcript the creator supplies
 * (SRT, WebVTT or "MM:SS text" lines). Used when the URL path fails or when
 * the caller forces it. On-screen disclosures cannot be seen in a transcript,
 * so the model is told to report them as absent with low confidence.
 *
 * The model OBSERVES (timestamps, presence, confidence). Pass/fail is decided
 * later by deterministic code and the Spend Firewall.
 */
import { GoogleGenAI, ThinkingLevel, type Part } from "@google/genai";
import { z } from "zod";
import { env } from "@/lib/env";
import { GeminiVerdictSchema, type AuditSource, type GeminiVerdict } from "@/lib/contracts/audit-verdict";
import type { TrancheConditions } from "@/lib/contracts/deal-contract";
import { hashJson } from "@/lib/util/hash";
import { GeminiBusyError, withModelFailover } from "./models";

export const AUDIT_PROMPT_VERSION = "video-auditor/v2";

let client: GoogleGenAI | undefined;
function ai(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: env().GEMINI_API_KEY });
  return client;
}

/** JSON Schema for responseJsonSchema, derived from the Zod schema. */
const verdictJsonSchema = (() => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(GeminiVerdictSchema) as Record<string, unknown>;
  return rest;
})();

export interface AuditContext {
  brandName: string;
  productName: string;
  conditions: TrancheConditions;
  videoDurationSec: number;
}

export interface AuditResult {
  verdict: GeminiVerdict;
  source: Exclude<AuditSource, "metadata">;
  model: string;
  latencyMs: number;
  /** Set when the YouTube URL path failed and the transcript was used instead. */
  fallbackReason?: string;
}

export class AuditUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditUnavailableError";
  }
}

/** Same video + prompt + conditions + model + thinking level => reusable verdict. */
export function verdictCacheKey(videoId: string, ctx: AuditContext, source: string, transcriptHash = ""): string {
  return hashJson({ videoId, source, transcriptHash, model: env().GEMINI_MODEL, tl: env().GEMINI_THINKING_LEVEL, v: AUDIT_PROMPT_VERSION, b: ctx.brandName, p: ctx.productName, c: ctx.conditions });
}

function thinkingLevel(): ThinkingLevel {
  return { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH }[env().GEMINI_THINKING_LEVEL];
}

function instructions(ctx: AuditContext, medium: "video" | "transcript"): string {
  const c = ctx.conditions;
  const keyword = c.targetKeyword ? `"${c.targetKeyword}"` : "(none required — set found=false, confidence 1)";
  const visualNote =
    medium === "transcript"
      ? "You only have a transcript, so you cannot see the screen: set visualDisclosure.present=false with confidence 0.3."
      : "Check on-screen text, overlays and YouTube's 'Paid partnership' label.";
  return `You are a meticulous compliance auditor for sponsored YouTube content. ${medium === "video" ? "Watch and listen to the entire video." : "Read the entire timestamped transcript."}

Sponsor: ${ctx.brandName}. Product: ${ctx.productName}. Video length: ${ctx.videoDurationSec} seconds.
Report only what you directly observe. Timestamps use MM:SS (or H:MM:SS). Use "" for anything that does not apply.

1. brandSegments: every contiguous stretch where ${ctx.productName} is the focus (shown, demonstrated or discussed), with start and end.
2. spokenDisclosure: is the sponsorship disclosed out loud ("sponsored by", "paid partnership", "#ad", "this video is brought to you by")? First timestamp and a verbatim quote of at most 12 words.
3. visualDisclosure: ${visualNote}
4. keyword: is ${keyword} said or clearly shown? First timestamp.
5. summary: two sentences on what the video is.

Give every item a confidence from 0 to 1. When something is absent, set present/found=false and give your confidence that it is truly absent.`;
}

/**
 * One audit call. GEMINI_MODEL first; if Google reports it busy, or it has not
 * answered within `timeoutMs`, the next model in GEMINI_FALLBACK_MODELS.
 */
async function generate(parts: Part[], timeoutMs: number): Promise<{ verdict: GeminiVerdict; model: string; latencyMs: number }> {
  const started = Date.now();
  const { result: verdict, model } = await withModelFailover(async (model, abortSignal) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await ai().models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        // Default temperature (Gemini 3 is tuned for 1.0; lower values can cause looping) and a
        // configurable thinking level ("low" = Google's lowest-latency setting). Pass/fail is
        // decided by deterministic code, so sampling variance can't move money on its own.
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: verdictJsonSchema,
          thinkingConfig: { thinkingLevel: thinkingLevel() },
          abortSignal, // cancels this request if the model runs out of time
        },
      });
      const parsed = GeminiVerdictSchema.safeParse(JSON.parse(res.text ?? "null"));
      if (parsed.success) return parsed.data;
      lastError = new Error(`Gemini verdict failed schema validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
    throw lastError;
  }, { timeoutMs });
  return { verdict, model, latencyMs: Date.now() - started };
}

export async function auditYouTubeUrl(videoId: string, ctx: AuditContext): Promise<AuditResult> {
  // Just the YouTube URL, as in Google's YouTube examples. Do not add `mediaProcessing` here: the
  // API rejects it without a mime type ("mime_type must be set when media_processing is
  // specified"), and Google already processes YouTube videos in its default static mode.
  const videoPart: Part = { fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` } };
  // Watching a video takes longer than a text answer, so it gets its own, longer limit.
  const r = await generate([videoPart, { text: instructions(ctx, "video") }], env().GEMINI_VIDEO_TIMEOUT_MS);
  return { ...r, source: "youtube_url" };
}

export async function auditTranscript(transcript: string, ctx: AuditContext): Promise<AuditResult> {
  const normalized = normalizeTranscript(transcript);
  if (normalized.length < 20) throw new AuditUnavailableError("Transcript is empty or has no timestamps");
  const r = await generate([{ text: `TRANSCRIPT\n"""\n${normalized.slice(0, 60_000)}\n"""` }, { text: instructions(ctx, "transcript") }], env().GEMINI_TIMEOUT_MS);
  return { ...r, source: "transcript" };
}

/**
 * URL first; transcript if the URL path fails (or `preferTranscript`).
 * Throws AuditUnavailableError when neither path can run.
 */
export async function auditVideo(videoId: string, ctx: AuditContext, opts: { transcript?: string; preferTranscript?: boolean } = {}): Promise<AuditResult> {
  if (opts.preferTranscript && opts.transcript) return auditTranscript(opts.transcript, ctx);
  try {
    return await auditYouTubeUrl(videoId, ctx);
  } catch (e) {
    // Busy is about Google's capacity, not the video: say so instead of "make it public".
    if (e instanceof GeminiBusyError) throw e;
    const reason = e instanceof Error ? e.message : String(e);
    if (!opts.transcript) {
      throw new AuditUnavailableError(`YouTube URL audit failed (${reason.slice(0, 200)}). Make the video public, or supply its transcript.`);
    }
    const fallback = await auditTranscript(opts.transcript, ctx);
    return { ...fallback, fallbackReason: reason.slice(0, 300) };
  }
}

/**
 * SRT / WebVTT / "MM:SS text" -> "MM:SS text" lines. Cue numbers, WEBVTT
 * headers and end times are dropped; cue start times are kept so the model
 * can cite them.
 */
export function normalizeTranscript(raw: string): string {
  const lines = raw.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let pendingTs: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t === "WEBVTT" || /^\d+$/.test(t) || /^(NOTE|STYLE|Kind:|Language:)/.test(t)) continue;
    const cue = /^(\d{1,2}:)?(\d{1,2}):(\d{2})(?:[.,]\d{1,3})?\s*-->/.exec(t);
    if (cue) {
      const h = cue[1] ? Number(cue[1].slice(0, -1)) : 0;
      const m = Number(cue[2]) + h * 60;
      pendingTs = `${String(m).padStart(2, "0")}:${cue[3]}`;
      continue;
    }
    const inline = /^\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s+(.+)$/.exec(t);
    if (inline) {
      out.push(`${inline[1]} ${inline[2]}`);
      pendingTs = null;
      continue;
    }
    out.push(pendingTs ? `${pendingTs} ${t}` : t);
    pendingTs = null;
  }
  return out.join("\n");
}
