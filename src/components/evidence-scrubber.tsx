/**
 * The audited video as a scrubber: the brand segment is highlighted where it
 * actually happens, with pins for the disclosure and keyword timestamps.
 */
import type { Citation } from "@/lib/contracts/audit-verdict";
import { formatTimestamp, parseTimestamp } from "@/lib/util/time";

export function EvidenceScrubber({
  durationSec,
  segmentStart,
  segmentEnd,
  citations,
}: {
  durationSec: number;
  segmentStart: number | null;
  segmentEnd: number | null;
  citations: Citation[];
}) {
  const total = Math.max(durationSec, segmentEnd ?? 0, 1);
  const pct = (s: number) => `${Math.min(100, Math.max(0, (s / total) * 100))}%`;
  const pins = citations
    .filter((c) => c.at && !c.at.includes("–"))
    .map((c) => ({ c, sec: parseTimestamp(c.at) }))
    .filter((p): p is { c: Citation; sec: number } => p.sec !== null);

  return (
    <figure className="w-full">
      <div className="relative h-9 rounded-md bg-primary/90" aria-hidden>
        {segmentStart !== null && segmentEnd !== null && (
          <div className="absolute inset-y-1 rounded-[3px] bg-warning" style={{ left: pct(segmentStart), width: `calc(${pct(segmentEnd)} - ${pct(segmentStart)})` }} />
        )}
        {pins.map(({ c, sec }, i) => (
          <div key={i} className="absolute -top-1.5 bottom-[-6px] w-0.5 bg-card" style={{ left: pct(sec) }} title={`${c.at} ${c.note}`}>
            <div className="absolute -top-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full border-2 border-primary bg-card" />
          </div>
        ))}
      </div>
      <figcaption className="mt-1.5 flex justify-between text-xs tabular-nums text-muted-foreground">
        <span>0:00</span>
        {segmentStart !== null && segmentEnd !== null ? (
          <span className="font-semibold text-foreground">
            Brand segment {formatTimestamp(segmentStart)}–{formatTimestamp(segmentEnd)}
          </span>
        ) : (
          <span>No brand segment found</span>
        )}
        <span>{formatTimestamp(total)}</span>
      </figcaption>
    </figure>
  );
}
