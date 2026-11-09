/**
 * Hosted Postgres providers (Neon, Supabase, Render) hand out URLs ending in
 * `sslmode=require`. node-postgres 8 already treats require/prefer/verify-ca as
 * `verify-full` (full certificate check) but prints a SECURITY WARNING every time
 * it parses one. Writing the mode the driver actually uses keeps the same strict
 * check and silences the warning. A URL that opts into libpq semantics
 * (`uselibpqcompat=true`) is left alone.
 */
export function normalizeDatabaseUrl(url: string): string {
  const trimmed = url.trim();
  if (/[?&]uselibpqcompat=true\b/.test(trimmed)) return trimmed;
  return trimmed.replace(/([?&]sslmode=)(require|prefer|verify-ca)(?=&|$)/, "$1verify-full");
}
