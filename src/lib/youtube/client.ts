/**
 * YouTube Data API v3: the source of facts that must not come from a model —
 * channel, privacy, publish time, length, description and view count.
 * channels.list, playlistItems.list and videos.list cost 1 quota unit each.
 */
import { env } from "@/lib/env";
import type { VideoSnapshot } from "@/lib/contracts/audit-verdict";
import { parseIsoDuration } from "@/lib/util/time";

const API = "https://www.googleapis.com/youtube/v3";

async function yt<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ ...params, key: env().YOUTUBE_API_KEY });
  const res = await fetch(`${API}/${path}?${qs}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`YouTube ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Accepts a "UC…" channel id, an "@handle", or a channel URL. */
export async function resolveChannelId(input: string): Promise<string> {
  const raw = input.trim();
  const fromUrl = /youtube\.com\/(?:channel\/(UC[\w-]{22})|(@[\w.-]+))/i.exec(raw);
  const candidate = fromUrl?.[1] ?? fromUrl?.[2] ?? raw;
  if (/^UC[\w-]{22}$/.test(candidate)) return candidate;
  const handle = candidate.startsWith("@") ? candidate : `@${candidate}`;
  const res = await yt<{ items?: Array<{ id: string }> }>("channels", { part: "id", forHandle: handle });
  const id = res.items?.[0]?.id;
  if (!id) throw new Error(`No YouTube channel found for "${input}"`);
  return id;
}

export async function listRecentUploadIds(channelId: string, max = 10): Promise<string[]> {
  const ch = await yt<{ items?: Array<{ contentDetails: { relatedPlaylists: { uploads: string } } }> }>("channels", {
    part: "contentDetails",
    id: channelId,
  });
  const uploads = ch.items?.[0]?.contentDetails.relatedPlaylists.uploads;
  if (!uploads) return [];
  const res = await yt<{ items?: Array<{ contentDetails: { videoId: string } }> }>("playlistItems", {
    part: "contentDetails",
    playlistId: uploads,
    maxResults: String(max),
  });
  return (res.items ?? []).map((i) => i.contentDetails.videoId);
}

interface VideoItem {
  id: string;
  snippet: { channelId: string; title: string; description: string; publishedAt: string };
  status: { privacyStatus: string; uploadStatus: string };
  statistics?: { viewCount?: string };
  contentDetails: { duration: string };
}

export async function getVideoSnapshots(videoIds: string[]): Promise<VideoSnapshot[]> {
  if (videoIds.length === 0) return [];
  const res = await yt<{ items?: VideoItem[] }>("videos", {
    part: "snippet,status,statistics,contentDetails",
    id: videoIds.slice(0, 50).join(","),
  });
  const fetchedAt = new Date().toISOString();
  return (res.items ?? []).map((v) => ({
    videoId: v.id,
    channelId: v.snippet.channelId,
    title: v.snippet.title,
    description: v.snippet.description,
    publishedAt: v.snippet.publishedAt,
    privacyStatus: v.status.privacyStatus,
    uploadStatus: v.status.uploadStatus,
    durationSec: parseIsoDuration(v.contentDetails.duration),
    viewCount: Number(v.statistics?.viewCount ?? 0),
    fetchedAt,
  }));
}

/** null when the video was deleted (YouTube simply omits it). */
export async function getVideoSnapshot(videoId: string): Promise<VideoSnapshot | null> {
  const [s] = await getVideoSnapshots([videoId]);
  return s ?? null;
}

/** Accepts a bare id or any youtube.com / youtu.be URL. */
export function parseVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = /(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/.exec(s);
  return m?.[1] ?? null;
}
