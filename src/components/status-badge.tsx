import { Badge, type BadgeProps } from "@/components/ui/badge";

const TRANCHE: Record<string, { label: string; variant: BadgeProps["variant"] }> = {
  PENDING: { label: "Waiting", variant: "held" },
  AUDITING: { label: "Auditing", variant: "warning" },
  APPROVED: { label: "Approved", variant: "success" },
  CAPTURED: { label: "Captured", variant: "success" },
  PAID_OUT: { label: "Paid out", variant: "success" },
  REFUSED: { label: "Withheld", variant: "destructive" },
  VOIDED: { label: "Voided", variant: "secondary" },
};

const DEAL: Record<string, { label: string; variant: BadgeProps["variant"] }> = {
  DRAFT: { label: "Draft", variant: "secondary" },
  AUTHORIZED: { label: "Funds held", variant: "held" },
  IN_PROGRESS: { label: "Paying out", variant: "success" },
  COMPLETED: { label: "Completed", variant: "success" },
  VOIDED: { label: "Voided", variant: "secondary" },
};

export function TrancheStatusBadge({ status }: { status: string }) {
  const s = TRANCHE[status] ?? { label: status, variant: "outline" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export function DealStatusBadge({ status }: { status: string }) {
  const s = DEAL[status] ?? { label: status, variant: "outline" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}
