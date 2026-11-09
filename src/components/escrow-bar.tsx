/**
 * The escrow as one bar: each tranche is a segment sized by its amount.
 * Paid out fills teal, approved/captured fills lighter teal, withheld gets a
 * crimson edge, voided is hatched, waiting is held slate.
 */
import { cn } from "@/lib/utils";

export interface EscrowSegment {
  key: string;
  label: string;
  amount: string;
  status: string;
}

const FILL: Record<string, string> = {
  PAID_OUT: "bg-success",
  CAPTURED: "bg-success/70",
  APPROVED: "bg-success/50",
  AUDITING: "bg-warning/60",
  REFUSED: "bg-destructive/15 ring-2 ring-inset ring-destructive",
  VOIDED: "hatched bg-secondary",
  PENDING: "bg-held/20",
};

export function EscrowBar({ segments, size = "lg" }: { segments: EscrowSegment[]; size?: "sm" | "lg" }) {
  const total = segments.reduce((s, x) => s + Number(x.amount), 0) || 1;
  return (
    <div>
      <div className={cn("flex w-full gap-1", size === "lg" ? "h-5" : "h-2")} role="img" aria-label={segments.map((s) => `${s.label} $${s.amount} ${s.status}`).join(", ")}>
        {segments.map((s) => (
          <div
            key={s.key}
            className={cn("rounded-[3px] transition-colors duration-700", FILL[s.status] ?? "bg-held/20")}
            style={{ width: `${(Number(s.amount) / total) * 100}%` }}
          />
        ))}
      </div>
      {size === "lg" && (
        <div className="mt-2 flex w-full gap-1 text-xs">
          {segments.map((s) => (
            <div key={s.key} style={{ width: `${(Number(s.amount) / total) * 100}%` }} className="min-w-0">
              <div className="font-semibold tabular-nums">${Number(s.amount).toLocaleString("en-US")}</div>
              <div className="truncate text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
