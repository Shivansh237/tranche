/** "MM:SS" or "H:MM:SS" -> seconds, or null when unparseable. */
export function parseTimestamp(ts: string): number | null {
  const m = /^\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[.,]\d+)?\s*$/.exec(ts);
  if (!m) return null;
  const sec = Number(m[3]);
  if (sec >= 60) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + sec;
}

export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** YouTube ISO-8601 duration ("PT1M42S") -> seconds. */
export function parseIsoDuration(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

export function addDays(from: Date, days: number, dayMs: number): Date {
  return new Date(from.getTime() + days * dayMs);
}
