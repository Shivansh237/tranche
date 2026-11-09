/**
 * Allowed status transitions. Every status write in the orchestrator goes
 * through `assertTrancheTransition`, so no code path can reach PAID_OUT
 * without APPROVED and CAPTURED first.
 */
export type TrancheStatus = "PENDING" | "AUDITING" | "APPROVED" | "CAPTURED" | "PAID_OUT" | "REFUSED" | "VOIDED";
export type DealStatus = "DRAFT" | "AUTHORIZED" | "IN_PROGRESS" | "COMPLETED" | "VOIDED";

const TRANCHE: Record<TrancheStatus, readonly TrancheStatus[]> = {
  PENDING: ["AUDITING", "VOIDED"],
  AUDITING: ["PENDING", "APPROVED", "REFUSED", "VOIDED"],
  APPROVED: ["CAPTURED", "REFUSED"],
  CAPTURED: ["PAID_OUT"],
  REFUSED: ["AUDITING", "VOIDED"],
  PAID_OUT: [],
  VOIDED: [],
};

const DEAL: Record<DealStatus, readonly DealStatus[]> = {
  DRAFT: ["AUTHORIZED", "VOIDED"],
  AUTHORIZED: ["IN_PROGRESS", "COMPLETED", "VOIDED"],
  IN_PROGRESS: ["COMPLETED", "VOIDED"],
  COMPLETED: [],
  VOIDED: [],
};

export const OPEN_TRANCHE_STATES: readonly TrancheStatus[] = ["PENDING", "AUDITING", "APPROVED", "CAPTURED", "REFUSED"];
export const AUDITABLE_STATES: readonly TrancheStatus[] = ["PENDING", "REFUSED"];

export function canTrancheTransition(from: TrancheStatus, to: TrancheStatus): boolean {
  return TRANCHE[from].includes(to);
}

export function assertTrancheTransition(from: TrancheStatus, to: TrancheStatus): void {
  if (!canTrancheTransition(from, to)) throw new Error(`Illegal tranche transition ${from} -> ${to}`);
}

export function canDealTransition(from: DealStatus, to: DealStatus): boolean {
  return DEAL[from].includes(to);
}

export function isTerminalTranche(s: TrancheStatus): boolean {
  return TRANCHE[s].length === 0;
}
