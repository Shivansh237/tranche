import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/** Constant-time check of `Authorization: Bearer <CRON_SECRET>`. */
export function hasCronSecret(header: string | null): boolean {
  const expected = `Bearer ${env().CRON_SECRET}`;
  if (!header || header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
