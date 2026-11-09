/**
 * Scheduled poll: asks the running app to verify every active deal.
 *   npm run poll                 one pass
 *   npm run poll -- --every=15   a pass every 15 seconds (local demos)
 * The Render cron job runs the one-pass form every minute.
 */
import { loadEnvConfig } from "@next/env";

// Same files and precedence as Next.js: .env.local overrides .env.
loadEnvConfig(process.cwd());

const every = Number(process.argv.find((a) => a.startsWith("--every="))?.split("=")[1] ?? 0);
const url = `${process.env.APP_URL ?? "http://localhost:3000"}/api/verify/trigger`;

async function pass() {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.CRON_SECRET}` },
    body: JSON.stringify({ all: true }),
  });
  const body = (await res.json()) as { reports?: Array<{ dealId: string; skipped?: string; outcomes: Array<{ trancheIndex: number; status: string; note: string }> }> };
  const at = new Date().toLocaleTimeString();
  if (!res.ok) return console.log(`[${at}] ${res.status}`, body);
  for (const r of body.reports ?? []) {
    if (r.skipped) console.log(`[${at}] ${r.dealId.slice(0, 8)} skipped: ${r.skipped}`);
    for (const o of r.outcomes) console.log(`[${at}] ${r.dealId.slice(0, 8)} tranche ${o.trancheIndex + 1} ${o.status}: ${o.note}`);
  }
  if (!body.reports?.length) console.log(`[${at}] no active deals`);
}

async function main() {
  await pass();
  while (every > 0) {
    await new Promise((r) => setTimeout(r, every * 1000));
    await pass().catch((e) => console.error(e));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
