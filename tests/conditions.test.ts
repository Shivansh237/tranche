import { describe, expect, it } from "vitest";
import { evaluateMetadataFindings, evaluateVideoFindings, findDescriptionDisclosure, mergeSpans } from "@/lib/engine/conditions";
import { assertTrancheTransition, canDealTransition, canTrancheTransition, isTerminalTranche } from "@/lib/engine/state-machine";
import { normalizeTranscript } from "@/lib/ai/video-auditor";
import { finalizeContract, ContractValidationError, type CompiledDeal } from "@/lib/contracts/deal-contract";
import type { GeminiVerdict, VideoSnapshot } from "@/lib/contracts/audit-verdict";
import type { TrancheConditions } from "@/lib/contracts/deal-contract";
import { formatUsd, fromCents, toCents } from "@/lib/util/money";
import { formatTimestamp, parseIsoDuration, parseTimestamp } from "@/lib/util/time";
import { canonicalJson, hashJson } from "@/lib/util/hash";

const conditions: TrancheConditions = { minDurationSec: 30, requireAdDisclosure: true, targetKeyword: "Glow Serum", minViews: 0, deadlineDays: 7 };
const snapshot: VideoSnapshot = {
  videoId: "vid12345678",
  channelId: "UCchannel",
  title: "My morning routine",
  description: "Thanks Lumen for sponsoring this video #ad",
  publishedAt: "2026-11-10T11:00:00Z",
  privacyStatus: "public",
  uploadStatus: "processed",
  durationSec: 95,
  viewCount: 1234,
  fetchedAt: "2026-11-10T12:00:00Z",
};
const verdict: GeminiVerdict = {
  summary: "Routine featuring Glow Serum",
  brandSegments: [
    { start: "00:42", end: "01:05", description: "Applies serum", confidence: 0.95 },
    { start: "01:00", end: "01:21", description: "Talks results", confidence: 0.92 },
  ],
  spokenDisclosure: { present: true, timestamp: "00:40", quote: "sponsored by Lumen", confidence: 0.96 },
  visualDisclosure: { present: false, timestamp: "", text: "", confidence: 0.8 },
  keyword: { found: true, timestamp: "00:44", confidence: 0.97 },
};
const run = (over: Partial<{ v: GeminiVerdict; s: VideoSnapshot; c: TrancheConditions }> = {}) =>
  evaluateVideoFindings({ verdict: over.v ?? verdict, snapshot: over.s ?? snapshot, conditions: over.c ?? conditions, expectedChannelId: "UCchannel", source: "youtube_url" });

describe("evaluateVideoFindings", () => {
  it("merges overlapping segments and computes seconds from timestamps", () => {
    const f = run();
    expect(f.brandSegmentStartSec).toBe(42);
    expect(f.brandSegmentEndSec).toBe(81);
    expect(f.brandSegmentDurationSec).toBe(39);
    expect(f.citations[0]).toMatchObject({ at: "0:42–1:21", note: "Brand segment" });
  });

  it("clamps segments to the real video length and drops invalid ones", () => {
    const f = run({ v: { ...verdict, brandSegments: [{ start: "01:00", end: "09:00", description: "", confidence: 0.9 }, { start: "bad", end: "00:10", description: "", confidence: 0.9 }] } });
    expect(f.brandSegmentDurationSec).toBe(35);
  });

  it("reads #ad from the description deterministically (confidence 1)", () => {
    const f = run({ v: { ...verdict, spokenDisclosure: { present: false, timestamp: "", quote: "", confidence: 0.9 } } });
    expect(f.hasAdDisclosure).toBe(true);
    expect(f.disclosureSource).toBe("description");
  });

  it("falls back to a spoken, then visual disclosure", () => {
    const noDesc = { ...snapshot, description: "Morning routine" };
    expect(run({ s: noDesc }).disclosureSource).toBe("spoken");
    const visualOnly: GeminiVerdict = {
      ...verdict,
      spokenDisclosure: { present: false, timestamp: "", quote: "", confidence: 0.9 },
      visualDisclosure: { present: true, timestamp: "00:05", text: "Paid partnership", confidence: 0.88 },
    };
    const f = run({ v: visualOnly, s: noDesc });
    expect(f.disclosureSource).toBe("visual");
    expect(f.confidenceScore).toBe(0.88);
  });

  it("reports a missing disclosure with the model's confidence that it is absent", () => {
    const f = run({
      s: { ...snapshot, description: "Join my #adventure" },
      v: { ...verdict, spokenDisclosure: { present: false, timestamp: "", quote: "", confidence: 0.93 }, visualDisclosure: { present: false, timestamp: "", text: "", confidence: 0.9 } },
    });
    expect(f.hasAdDisclosure).toBe(false);
    expect(f.disclosureSource).toBe("none");
    expect(f.confidenceScore).toBe(0.9);
  });

  it("uses the lowest relevant confidence and ignores unused observations", () => {
    expect(run().confidenceScore).toBe(0.92);
    const f = run({ c: { ...conditions, targetKeyword: null, requireAdDisclosure: false, minDurationSec: 0 } });
    expect(f.confidenceScore).toBe(1);
    expect(f.keywordFound).toBe(false);
  });

  it("cites a missing keyword", () => {
    const f = run({ v: { ...verdict, keyword: { found: false, timestamp: "", confidence: 0.9 } } });
    expect(f.keywordFound).toBe(false);
    expect(f.citations.some((c) => c.note.includes("not mentioned"))).toBe(true);
  });

  it("flags a channel mismatch and a private video", () => {
    const f = run({ s: { ...snapshot, channelId: "UCother", privacyStatus: "private" } });
    expect(f.channelIdMatches).toBe(false);
    expect(f.isPublic).toBe(false);
  });

  it("returns null segment bounds when nothing was found", () => {
    const f = run({ v: { ...verdict, brandSegments: [] } });
    expect(f.brandSegmentStartSec).toBeNull();
    expect(f.brandSegmentDurationSec).toBe(0);
  });

  it("uses video length 0 as unknown (no clamping)", () => {
    expect(run({ s: { ...snapshot, durationSec: 0 } }).brandSegmentDurationSec).toBe(39);
  });

  it("evaluates metadata-only findings for view and retention tranches", () => {
    const f = evaluateMetadataFindings(snapshot, "UCchannel");
    expect(f).toMatchObject({ viewCount: 1234, isPublic: true, channelIdMatches: true, confidenceScore: 1, hasAdDisclosure: true });
  });
});

describe("disclosure tokens and spans", () => {
  it("matches whole tokens only", () => {
    expect(findDescriptionDisclosure("", "Great #ad!")).toBe("#ad");
    expect(findDescriptionDisclosure("", "#adventure time")).toBeNull();
    expect(findDescriptionDisclosure("Sponsored by Lumen", "")).toBe("sponsored by");
    expect(findDescriptionDisclosure("", "PAID PARTNERSHIP with Lumen")).toBe("paid partnership");
  });

  it("merges spans and keeps the lowest confidence", () => {
    expect(mergeSpans([[10, 20, 0.9], [0, 5, 0.8], [18, 30, 0.7]])).toEqual([[0, 5, 0.8], [10, 30, 0.7]]);
  });
});

describe("state machine", () => {
  it("only reaches PAID_OUT through APPROVED and CAPTURED", () => {
    expect(canTrancheTransition("PENDING", "PAID_OUT")).toBe(false);
    expect(canTrancheTransition("REFUSED", "APPROVED")).toBe(false);
    expect(canTrancheTransition("AUDITING", "APPROVED")).toBe(true);
    expect(canTrancheTransition("APPROVED", "CAPTURED")).toBe(true);
    expect(canTrancheTransition("CAPTURED", "PAID_OUT")).toBe(true);
    expect(() => assertTrancheTransition("PENDING", "CAPTURED")).toThrow("Illegal tranche transition");
    expect(() => assertTrancheTransition("REFUSED", "AUDITING")).not.toThrow();
  });

  it("treats PAID_OUT and VOIDED as terminal", () => {
    expect(isTerminalTranche("PAID_OUT")).toBe(true);
    expect(isTerminalTranche("VOIDED")).toBe(true);
    expect(isTerminalTranche("REFUSED")).toBe(false);
  });

  it("guards deal transitions", () => {
    expect(canDealTransition("DRAFT", "AUTHORIZED")).toBe(true);
    expect(canDealTransition("COMPLETED", "IN_PROGRESS")).toBe(false);
  });
});

describe("transcript normalization", () => {
  it("turns WebVTT cues into timestamped lines", () => {
    const vtt = "WEBVTT\n\n1\n00:00:40.000 --> 00:00:43.000\nThis video is sponsored by Lumen.\n\n2\n00:01:04.500 --> 00:01:08.000\nGlow Serum goes on first.";
    expect(normalizeTranscript(vtt)).toBe("00:40 This video is sponsored by Lumen.\n01:04 Glow Serum goes on first.");
  });

  it("converts hour timestamps and keeps inline MM:SS lines", () => {
    expect(normalizeTranscript("01:02:03,000 --> 01:02:05,000\nHello")).toBe("62:03 Hello");
    expect(normalizeTranscript("[0:44] Glow Serum\nno timestamp")).toBe("0:44 Glow Serum\nno timestamp");
  });
});

describe("contract finalization", () => {
  const draft: CompiledDeal = {
    title: "Glow Serum video",
    brandName: "Lumen",
    productName: "Glow Serum",
    currency: "USD",
    totalBudget: 600,
    tranches: [
      { type: "VIEW_MILESTONE", label: "10k views", amount: 200, conditions: { minDurationSec: 99, requireAdDisclosure: true, targetKeyword: "x", minViews: 10000, deadlineDays: 14 } },
      { type: "PUBLISH_VERIFIED", label: "Goes live", amount: 400, conditions: { minDurationSec: 30, requireAdDisclosure: true, targetKeyword: " Glow Serum ", minViews: 5, deadlineDays: 7 } },
    ],
    ambiguities: [],
  };

  it("orders PUBLISH first, converts to cents and strips conditions that don't apply", () => {
    const c = finalizeContract(draft);
    expect(c.totalBudgetCents).toBe(60_000);
    expect(c.tranches.map((t) => [t.index, t.type, t.amountCents])).toEqual([
      [0, "PUBLISH_VERIFIED", 40_000],
      [1, "VIEW_MILESTONE", 20_000],
    ]);
    expect(c.tranches[0]!.conditions).toMatchObject({ targetKeyword: "Glow Serum", minViews: 0 });
    expect(c.tranches[1]!.conditions).toMatchObject({ minDurationSec: 0, requireAdDisclosure: false, targetKeyword: null, minViews: 10000 });
  });

  it("rejects totals that don't add up, a missing publish tranche and a zero view milestone", () => {
    const bad: CompiledDeal = {
      ...draft,
      totalBudget: 700,
      tranches: [{ type: "VIEW_MILESTONE", label: "views", amount: 200, conditions: { minDurationSec: 0, requireAdDisclosure: false, targetKeyword: "", minViews: 0, deadlineDays: 14 } }],
    };
    try {
      finalizeContract(bad);
      throw new Error("expected a validation error");
    } catch (e) {
      expect(e).toBeInstanceOf(ContractValidationError);
      expect((e as ContractValidationError).issues).toHaveLength(3);
    }
  });
});

describe("money, time and hashing helpers", () => {
  it("handles money without floats", () => {
    expect(toCents("400.00")).toBe(40_000);
    expect(toCents("19.9")).toBe(1_990);
    expect(toCents(12.5)).toBe(1_250);
    expect(fromCents(5)).toBe("0.05");
    expect(formatUsd(123_456_78)).toBe("$123,456.78");
    expect(() => toCents("-1")).toThrow();
    expect(() => fromCents(1.5)).toThrow();
  });

  it("parses and formats timestamps", () => {
    expect(parseTimestamp("01:21")).toBe(81);
    expect(parseTimestamp("1:02:03")).toBe(3723);
    expect(parseTimestamp("1:75")).toBeNull();
    expect(parseTimestamp("")).toBeNull();
    expect(formatTimestamp(81)).toBe("1:21");
    expect(formatTimestamp(3723)).toBe("1:02:03");
    expect(parseIsoDuration("PT1M35S")).toBe(95);
    expect(parseIsoDuration("nope")).toBe(0);
  });

  it("hashes canonical JSON regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined, e: new Date("2026-01-01T00:00:00Z") } })).toBe('{"a":{"d":2,"e":"2026-01-01T00:00:00.000Z"},"b":1}');
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
  });
});
