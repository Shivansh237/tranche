/**
 * Day-1 check: proves every external dependency works before you build on it.
 *   npm run smoke -- --channel=@yourhandle --video=<a PUBLIC video id>
 *   (smoke = this script with --migrate, which applies the database migrations first)
 *
 *  1. Postgres reachable and migrated
 *  2. PayPal OAuth works, the app has Payouts, and an AUTHORIZE order can be created
 *  3. YouTube Data API resolves your channel
 *  4. Gemini answers with GEMINI_MODEL, and (with --video) can watch a public video
 */
import { loadEnvConfig } from "@next/env";

// Same files and precedence as Next.js: .env.local overrides .env.
loadEnvConfig(process.cwd());
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { normalizeDatabaseUrl } from "../src/db/url";
import { isGeminiBusy } from "../src/lib/ai/models";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=") as [string, string]));
let failures = 0;
const pass = (m: string) => console.log(`  ✓ ${m}`);
const warn = (m: string) => console.log(`  ! ${m}`);
const isSet = (k: string) => !!process.env[k]?.trim() && !/<<<|>>>|PASTE_/.test(process.env[k] ?? "");
/** Runs a check only when its variables are filled in, so placeholders don't produce confusing network errors. */
const ready = (name: string, ...keys: string[]) => {
  const todo = keys.filter((k) => !isSet(k));
  if (todo.length) {
    failures++;
    console.log(`  ✗ ${name}: skipped until you fill in ${todo.join(", ")} in .env.local`);
  }
  return todo.length === 0;
};
const fail = (m: string, e: unknown) => {
  failures++;
  const cause = e instanceof Error && e.cause instanceof Error ? ` (${(e.cause as NodeJS.ErrnoException).code ?? e.cause.message})` : "";
  console.log(`  ✗ ${m}: ${e instanceof Error ? e.message : String(e)}${cause}`);
};

async function main() {
  console.log("Tranche environment check\n");
  const required = ["DATABASE_URL", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "NEXT_PUBLIC_PAYPAL_CLIENT_ID", "GEMINI_API_KEY", "YOUTUBE_API_KEY", "CRON_SECRET"];
  const missing = required.filter((k) => !process.env[k]?.trim());
  const placeholders = required.filter((k) => /<<<|>>>|PASTE_/.test(process.env[k] ?? ""));
  if (missing.length) fail("Environment", new Error(`missing ${missing.join(", ")}. Did you create .env.local? (copy .env.example .env.local)`));
  if (placeholders.length) fail("Environment", new Error(`still a placeholder in .env.local: ${placeholders.join(", ")}`));
  if (!missing.length && !placeholders.length) pass("All required variables are set");
  if (isSet("PAYPAL_CLIENT_ID") && isSet("NEXT_PUBLIC_PAYPAL_CLIENT_ID") && process.env.PAYPAL_CLIENT_ID !== process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID) {
    fail("Environment", new Error("NEXT_PUBLIC_PAYPAL_CLIENT_ID must be the same value as PAYPAL_CLIENT_ID"));
  }
  if (isSet("CRON_SECRET") && process.env.CRON_SECRET!.trim().length < 16) fail("Environment", new Error("CRON_SECRET must be at least 16 characters"));

  if (ready("Postgres", "DATABASE_URL")) {
    const pool = new Pool({ connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL!), max: 1 });
    try {
      if ("migrate" in args) {
        await migrate(drizzle(pool), { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
        pass("Database migrations applied");
      }
      const { rows } = await pool.query("select count(*)::int as n from information_schema.tables where table_name in ('deals','tranches','evidence_audits','firewall_decisions')");
      if (rows[0].n === 4) pass("Postgres reachable and migrated");
      else fail("Postgres", new Error("tables missing: run npm run smoke (it migrates first)"));
    } catch (e) {
      fail("Postgres", e);
    } finally {
      await pool.end();
    }
  }

  const base = process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  if (ready("PayPal", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET")) try {
    const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
    const t = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!t.ok) throw new Error(`${t.status} ${await t.text()}`);
    const { access_token, scope } = (await t.json()) as { access_token: string; scope: string };
    pass("PayPal OAuth token");
    if (scope.includes("payouts")) pass("App has the Payouts scope");
    else warn("App may be missing Payouts: enable it under the app's features in the developer dashboard");
    const o = await fetch(`${base}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", "PayPal-Request-Id": `validate-${Date.now()}` },
      body: JSON.stringify({ intent: "AUTHORIZE", purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }] }),
    });
    const order = (await o.json()) as { id?: string; status?: string };
    if (!o.ok) throw new Error(`${o.status} ${JSON.stringify(order)}`);
    pass(`AUTHORIZE order created: ${order.id} (${order.status})`);
  } catch (e) {
    fail("PayPal", e);
  }

  if (ready("YouTube Data API", "YOUTUBE_API_KEY")) try {
    const handle = args.channel ?? "@YouTube";
    const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${process.env.YOUTUBE_API_KEY}`);
    const body = (await res.json()) as { items?: Array<{ id: string }>; error?: { message: string } };
    if (!res.ok || !body.items?.[0]) throw new Error(body.error?.message ?? "channel not found");
    pass(`YouTube resolved ${handle} to ${body.items[0].id}`);
  } catch (e) {
    fail("YouTube Data API", e);
  }

  // Same settings and failover order the app uses.
  const models = [...new Set([process.env.GEMINI_MODEL ?? "gemini-3.8-flash", ...(process.env.GEMINI_FALLBACK_MODELS ?? "gemini-3.6-flash").split(",")].map((m) => m.trim()).filter(Boolean))];
  const geminiReady = ready("Gemini", "GEMINI_API_KEY");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const level = (process.env.GEMINI_THINKING_LEVEL ?? "low").toUpperCase() as "LOW" | "MEDIUM" | "HIGH";
  const config = { thinkingConfig: { thinkingLevel: ThinkingLevel[level] ?? ThinkingLevel.LOW } };
  const secs = (started: number) => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const available: string[] = [];
  if (geminiReady) {
    for (const [i, model] of models.entries()) {
      const role = i === 0 ? "main model" : "fallback";
      try {
        const started = Date.now();
        const res = await ai.models.generateContent({ model, contents: "Reply with the single word: ready", config });
        pass(`Gemini ${model} (${role}, thinking ${level.toLowerCase()}) replied "${res.text?.trim()}" in ${secs(started)}`);
        available.push(model);
      } catch (e) {
        // Busy is Google's capacity, not your setup: a warning, unless no model answers at all.
        if (isGeminiBusy(e)) warn(`Gemini ${model} (${role}) is busy right now (Google reports high demand). Temporary; the app fails over to the next model.`);
        else fail(`Gemini ${model} (${role})`, e);
      }
    }
    if (available.length === 0 && models.length > 0) fail("Gemini", new Error(`every model was busy or failed (${models.join(", ")}); wait a minute and run the smoke test again`));
  }
  if (geminiReady && args.video && available[0]) {
    const model = available[0];
    try {
      const started = Date.now();
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ fileData: { fileUri: `https://www.youtube.com/watch?v=${args.video}` } }, { text: "In one sentence, what happens in this video? Include one MM:SS timestamp." }] }],
        config,
      });
      pass(`Gemini ${model} watched ${args.video} in ${secs(started)}: ${res.text?.trim().slice(0, 140)}`);
    } catch (e) {
      if (isGeminiBusy(e)) warn(`Gemini ${model} became busy while watching the video. Temporary; try again in a minute.`);
      else fail("Gemini YouTube input (the video must be PUBLIC)", e);
    }
  }

  if (!args.video) warn("Add --video=<id of a PUBLIC video> to also check that Gemini can watch YouTube videos");
  console.log(failures ? `\n${failures} check(s) failed. Fix the ✗ lines above and run it again.` : "\nAll checks passed. Start the app with: npm run dev");
  process.exit(failures ? 1 : 0);
}

main();
