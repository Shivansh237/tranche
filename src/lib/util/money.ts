/**
 * Money helpers. Postgres stores amounts as numeric(12,2) (strings in JS);
 * all arithmetic in Tranche happens on integer cents, never floats.
 */
export type Cents = number;

export function toCents(value: string | number): Cents {
  const s = typeof value === "number" ? value.toFixed(2) : value.trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Invalid money amount: ${value}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export function fromCents(cents: Cents): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`Invalid cents: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function formatUsd(cents: Cents): string {
  const [whole = "0", frac = "00"] = fromCents(cents).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}
