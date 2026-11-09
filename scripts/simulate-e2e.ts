/**
 * Tranche end-to-end simulation — self-contained, no accounts or keys needed.
 *
 *   npm run simulate              in-memory Postgres (PGlite) + the real migrations
 *   npm run simulate -- --pg      a real Postgres at DATABASE_URL (TRUNCATES Tranche tables)
 *
 * Runs the REAL route handlers, orchestrator, Spend Firewall and database.
 * Only the outside world is simulated, at the HTTP (fetch) layer:
 * PayPal sandbox, YouTube Data API and Gemini.
 *
 * Scenario
 *   Deal A  compile -> authorize -> video without #ad (WITHHELD) -> creator adds #ad
 *           -> partial capture $400 + payout -> view milestone -> final capture $200 -> COMPLETED
 *   Deal B  replay guard: the same video cannot pay a second deal
 *   Deal C  YouTube URL fails -> transcript fallback -> PayPal captures but the response
 *           is lost -> retry with the same PayPal-Request-Id -> one capture -> creator makes
 *           the video private -> retention tranche voided, authorization remainder voided
 * Prints the verified ledger and exits non-zero if any invariant fails.
 */
import assert from "node:assert/strict";
import path from "node:path";

const usePg = process.argv.includes("--pg");

Object.assign(process.env, {
  APP_URL: "http://localhost:3000",
  PAYPAL_ENV: "sandbox",
  PAYPAL_CLIENT_ID: "sim-client",
  PAYPAL_CLIENT_SECRET: "sim-secret",
  GEMINI_API_KEY: "sim-gemini",
  GEMINI_MODEL: "gemini-3.8-flash",
  GEMINI_FALLBACK_MODELS: "gemini-3.6-flash",
  // Short limits so the simulated "slow model" scenario runs in seconds, not 40 s.
  GEMINI_TIMEOUT_MS: "1500",
  GEMINI_VIDEO_TIMEOUT_MS: "1500",
  YOUTUBE_API_KEY: "sim-youtube",
  CRON_SECRET: "sim-cron-secret-0123456789",
  PAYMENTS_ENABLED: "true",
  DEMO_DAY_MS: "60000",
  PAYOUT_RECHECK_MS: "0", // re-check payout status on every request in the simulation
});

// ---------------------------------------------------------------------------
// The simulated outside world
// ---------------------------------------------------------------------------

const CHANNEL = `UC${"s".repeat(22)}`;
const CREATOR = "asha.creator@personal.example.com";
const BRAND = "brand-buyer@personal.example.com";

interface SimVideo {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  privacyStatus: "public" | "private" | "unlisted";
  viewCount: number;
  durationSec: number;
  spokenDisclosure: boolean;
  urlAuditFails?: boolean;
}

const world = {
  videos: [] as SimVideo[],
  compileCalls: 0,
  /** generationConfig of every Gemini request, to check the latency settings actually reach Google. */
  geminiConfigs: [] as Array<{ temperature?: number; thinkingConfig?: { thinkingLevel?: string } }>,
  /** Google "high demand" outage on the main model: the first compile and the first video audit
   *  get 503s from gemini-3.8-flash until the app fails over to gemini-3.6-flash. */
  busy: { compile: true, audit: true, served: 0, compileModel: "", auditModel: "" },
  /** Slow main model: the second compile and the first transcript audit get no answer from
   *  gemini-3.8-flash (until cancelled), so the time limit must hand them to gemini-3.6-flash. */
  slow: { compile: false, transcript: true, cancelled: 0, compileModel: "", transcriptModel: "" },
  urlAuditCalls: 0,
  transcriptAuditCalls: 0,
  orders: new Map<string, { dealId: string; value: string }>(),
  auths: new Map<string, { value: number; captured: number; status: string }>(),
  captures: new Map<string, { id: string; authId: string; value: string; final: boolean }>(),
  captureHttpCalls: 0,
  loseNextCaptureResponse: false,
  payouts: new Map<string, { batchId: string; receiver: string; value: string }>(),
  /** GET /v1/payments/payouts/{id} calls per batch: PayPal says PENDING on the first, SUCCESS afterwards. */
  payoutChecks: new Map<string, number>(),
  voids: [] as string[],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "paypal-debug-id": `sim-${Math.random().toString(16).slice(2, 10)}` } });

const gemini = (text: string) =>
  json({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });

function compiledFor(terms: string) {
  const retention = /stays? public/i.test(terms);
  return {
    title: retention ? "Glow Serum review (retention)" : "Glow Serum launch video",
    brandName: "Lumen Skincare",
    productName: "Glow Serum",
    currency: "USD",
    totalBudget: 600,
    tranches: [
      { type: "PUBLISH_VERIFIED", label: "Video goes live", amount: 400, conditions: { minDurationSec: 30, requireAdDisclosure: true, targetKeyword: "Glow Serum", minViews: 0, deadlineDays: 7 } },
      retention
        ? { type: "RETENTION_ACTIVE", label: "Stays public 3 days", amount: 200, conditions: { minDurationSec: 0, requireAdDisclosure: false, targetKeyword: "", minViews: 0, deadlineDays: 3 } }
        : { type: "VIEW_MILESTONE", label: "10k views bonus", amount: 200, conditions: { minDurationSec: 0, requireAdDisclosure: false, targetKeyword: "", minViews: 10000, deadlineDays: 14 } },
    ],
    ambiguities: [],
  };
}

function verdictFor(v: SimVideo | undefined, viaTranscript: boolean) {
  return {
    summary: "A morning skincare routine featuring the Glow Serum.",
    brandSegments: [{ start: "00:42", end: "01:21", description: "Applies and talks about Glow Serum", confidence: 0.94 }],
    spokenDisclosure: v?.spokenDisclosure
      ? { present: true, timestamp: "00:40", quote: "this video is sponsored by Lumen", confidence: 0.95 }
      : { present: false, timestamp: "", quote: "", confidence: 0.92 },
    visualDisclosure: viaTranscript ? { present: false, timestamp: "", text: "", confidence: 0.3 } : { present: false, timestamp: "", text: "", confidence: 0.9 },
    keyword: { found: true, timestamp: "00:44", confidence: 0.96 },
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? init.body : "";
  const headers = new Headers(init?.headers);

  // ---- Gemini (AI SDK contract compiler + @google/genai video auditor) ----
  if (url.hostname === "generativelanguage.googleapis.com") {
    // Same rule as the real API: a part that sets media processing must also set a mime type.
    if (/"mediaProcessing"|"media_processing"/.test(body) && !/"mimeType"|"mime_type"/.test(body)) {
      return json({ error: { code: 400, message: "mime_type must be set when media_processing is specified.", status: "INVALID_ARGUMENT" } }, 400);
    }
    world.geminiConfigs.push((JSON.parse(body || "{}") as { generationConfig?: (typeof world.geminiConfigs)[number] }).generationConfig ?? {});
    const model = /\/models\/([^:/]+):/.exec(url.pathname)?.[1] ?? "";
    const kind = body.includes("Deal terms") ? "compile" : /"fileUri":"https:\/\/www\.youtube\.com/.test(body) ? "audit" : null;
    if (kind && world.busy[kind]) {
      if (model === "gemini-3.8-flash") {
        world.busy.served++;
        return json({ error: { code: 503, message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.", status: "UNAVAILABLE" } }, 503);
      }
      world.busy[kind] = false; // the fallback model answered: the outage is over for this kind of call
      world.busy[kind === "compile" ? "compileModel" : "auditModel"] = model;
    }
    const slowKind = kind === "compile" ? "compile" : body.includes("TRANSCRIPT") ? "transcript" : null;
    if (slowKind && world.slow[slowKind] && !(kind && world.busy[kind])) {
      if (model === "gemini-3.8-flash") {
        // Never answers in time; like a real fetch, rejects as soon as the request is cancelled.
        return new Promise<Response>((_, reject) => {
          const t = setTimeout(() => reject(new Error("simulated slow model was never cancelled")), 30_000);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              world.slow.cancelled++;
              reject(init.signal!.reason ?? new DOMException("The operation was aborted.", "AbortError"));
            },
            { once: true },
          );
        });
      }
      world.slow[slowKind] = false;
      world.slow[slowKind === "compile" ? "compileModel" : "transcriptModel"] = model;
    }
    if (body.includes("Deal terms")) {
      world.compileCalls++;
      if (world.compileCalls === 1) world.slow.compile = true; // arm the slow-model trap for the next compile
      const terms = /Deal terms:\\n\\"\\"\\"\\n([\s\S]*?)\\n\\"\\"\\"/.exec(body)?.[1] ?? body;
      return gemini(JSON.stringify(compiledFor(terms)));
    }
    const fileUri = /"fileUri":"https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/.exec(body)?.[1];
    if (fileUri) {
      world.urlAuditCalls++;
      const v = world.videos.find((x) => x.id === fileUri);
      if (!v || v.urlAuditFails || v.privacyStatus !== "public") {
        return json({ error: { code: 400, message: "Video is not accessible (unlisted, private or unavailable)", status: "INVALID_ARGUMENT" } }, 400);
      }
      return gemini(JSON.stringify(verdictFor(v, false)));
    }
    if (body.includes("TRANSCRIPT")) {
      world.transcriptAuditCalls++;
      return gemini(JSON.stringify(verdictFor({ spokenDisclosure: /sponsored by/i.test(body) } as SimVideo, true)));
    }
    return gemini("ready");
  }

  // ---- YouTube Data API ----
  if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/youtube/v3/")) {
    const p = url.pathname.replace("/youtube/v3/", "");
    if (p === "channels") {
      if (url.searchParams.get("forHandle")) return json({ items: [{ id: CHANNEL }] });
      return json({ items: [{ id: CHANNEL, contentDetails: { relatedPlaylists: { uploads: `UU${"s".repeat(22)}` } } }] });
    }
    if (p === "playlistItems") return json({ items: [...world.videos].reverse().map((v) => ({ contentDetails: { videoId: v.id } })) });
    if (p === "videos") {
      const ids = (url.searchParams.get("id") ?? "").split(",");
      return json({
        items: world.videos
          .filter((v) => ids.includes(v.id))
          .map((v) => ({
            id: v.id,
            snippet: { channelId: CHANNEL, title: v.title, description: v.description, publishedAt: v.publishedAt },
            status: { privacyStatus: v.privacyStatus, uploadStatus: "processed" },
            statistics: { viewCount: String(v.viewCount) },
            contentDetails: { duration: `PT${Math.floor(v.durationSec / 60)}M${v.durationSec % 60}S` },
          })),
      });
    }
  }

  // ---- PayPal sandbox ----
  if (url.hostname === "api-m.sandbox.paypal.com") {
    const p = url.pathname;
    const rid = headers.get("PayPal-Request-Id") ?? "";
    if (p === "/v1/oauth2/token") return json({ access_token: "A21AA-sim", expires_in: 32400 });

    if (p === "/v2/checkout/orders" && method === "POST") {
      const b = JSON.parse(body);
      const existing = [...world.orders.entries()].find(([, o]) => o.dealId === b.purchase_units[0].custom_id);
      const id = existing?.[0] ?? `ORDER${world.orders.size + 1}SIM`;
      world.orders.set(id, { dealId: b.purchase_units[0].custom_id, value: b.purchase_units[0].amount.value });
      return json({ id, status: "CREATED", links: [{ rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] }, 201);
    }
    const authorize = /^\/v2\/checkout\/orders\/([^/]+)\/authorize$/.exec(p);
    if (authorize) {
      const order = world.orders.get(authorize[1]!)!;
      const authId = `AUTH${authorize[1]}`;
      world.auths.set(authId, { value: Number(order.value), captured: 0, status: "CREATED" });
      return json(
        {
          id: authorize[1],
          status: "COMPLETED",
          payer: { email_address: BRAND, payer_id: "BRANDPAYER1" },
          purchase_units: [
            {
              custom_id: order.dealId,
              payments: {
                authorizations: [
                  { id: authId, status: "CREATED", amount: { currency_code: "USD", value: order.value }, expiration_time: new Date(Date.now() + 29 * 86_400_000).toISOString() },
                ],
              },
            },
          ],
        },
        201,
      );
    }
    const capture = /^\/v2\/payments\/authorizations\/([^/]+)\/capture$/.exec(p);
    if (capture) {
      world.captureHttpCalls++;
      const prior = world.captures.get(rid);
      if (prior) return json({ id: prior.id, status: "COMPLETED", amount: { currency_code: "USD", value: prior.value }, final_capture: prior.final }, 201);
      const b = JSON.parse(body);
      const auth = world.auths.get(capture[1]!)!;
      const value = Number(b.amount.value);
      if (auth.captured + value > auth.value + 1e-9) return json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "MAX_CAPTURE_AMOUNT_EXCEEDED" }] }, 422);
      auth.captured += value;
      auth.status = b.final_capture || Math.abs(auth.captured - auth.value) < 1e-9 ? "CAPTURED" : "PARTIALLY_CAPTURED";
      const cap = { id: `CAP${world.captures.size + 1}SIM`, authId: capture[1]!, value: b.amount.value, final: b.final_capture };
      world.captures.set(rid, cap);
      if (world.loseNextCaptureResponse) {
        world.loseNextCaptureResponse = false;
        return json({ name: "SERVICE_UNAVAILABLE" }, 503); // PayPal captured, but the response never arrived
      }
      return json({ id: cap.id, status: "COMPLETED", amount: b.amount, final_capture: b.final_capture }, 201);
    }
    const authGet = /^\/v2\/payments\/authorizations\/([^/]+)$/.exec(p);
    if (authGet && method === "GET") {
      const a = world.auths.get(authGet[1]!)!;
      return json({ id: authGet[1], status: a.status, amount: { currency_code: "USD", value: a.value.toFixed(2) } });
    }
    const voidM = /^\/v2\/payments\/authorizations\/([^/]+)\/void$/.exec(p);
    if (voidM) {
      world.voids.push(voidM[1]!);
      world.auths.get(voidM[1]!)!.status = "VOIDED";
      return new Response(null, { status: 204 });
    }
    const payoutGet = /^\/v1\/payments\/payouts\/([^/]+)$/.exec(p);
    if (payoutGet && method === "GET") {
      const batchId = decodeURIComponent(payoutGet[1]!);
      const entry = [...world.payouts.entries()].find(([, v]) => v.batchId === batchId);
      if (!entry) return json({ name: "RESOURCE_NOT_FOUND", message: "Batch not found" }, 404);
      const n = (world.payoutChecks.get(batchId) ?? 0) + 1;
      world.payoutChecks.set(batchId, n);
      const status = n === 1 ? "PENDING" : "SUCCESS";
      return json({
        batch_header: { payout_batch_id: batchId, batch_status: status, sender_batch_header: { sender_batch_id: entry[0] } },
        items: [{ payout_item_id: `ITEM-${batchId}`, transaction_status: status }],
      });
    }
    if (p === "/v1/payments/payouts" && method === "POST") {
      const b = JSON.parse(body);
      const sid = b.sender_batch_header.sender_batch_id as string;
      const prior = world.payouts.get(sid);
      const batchId = prior?.batchId ?? `BATCH${world.payouts.size + 1}SIM`;
      if (!prior) world.payouts.set(sid, { batchId, receiver: b.items[0].receiver, value: b.items[0].amount.value });
      return json({ batch_header: { payout_batch_id: batchId, batch_status: "PENDING", sender_batch_header: { sender_batch_id: sid } } }, 201);
    }
  }

  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return realFetch(input, init);
  throw new Error(`Simulation has no mock for ${method} ${url.href}`);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  const { db, setDb, closeDb, schema } = await import("@/db/client");
  const { sql, eq, asc } = await import("drizzle-orm");

  let pglite: { close(): Promise<void> } | undefined;
  if (usePg) {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db(), { migrationsFolder: path.resolve(__dirname, "../drizzle") });
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const client = new PGlite();
    pglite = client;
    const memDb = drizzle(client, { schema });
    await migrate(memDb, { migrationsFolder: path.resolve(__dirname, "../drizzle") });
    setDb(memDb as unknown as Parameters<typeof setDb>[0]);
  }
  await db().execute(sql`truncate deals, tranches, evidence_audits, firewall_decisions, paypal_ledger, timeline_events cascade`);

  const { POST: compile } = await import("@/app/api/deals/compile/route");
  const { POST: createOrder } = await import("@/app/api/paypal/create-order/route");
  const { POST: onApprove } = await import("@/app/api/paypal/on-approve/route");
  const { POST: trigger } = await import("@/app/api/verify/trigger/route");
  const { GET: getDeal } = await import("@/app/api/deals/[id]/route");

  const post = (handler: (r: Request) => Promise<Response>, body: unknown, auth = false) =>
    handler(
      new Request("http://localhost/api", {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {}) },
        body: JSON.stringify(body),
      }),
    ).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

  const say = (s: string) => console.log(`\n\u25B8 ${s}`);
  const ok = (s: string) => console.log(`  \u2713 ${s}`);
  const tranchesOf = async (dealId: string) =>
    db().select().from(schema.tranches).where(eq(schema.tranches.dealId, dealId)).orderBy(asc(schema.tranches.trancheIndex));
  const dealRow = async (dealId: string) => (await db().select().from(schema.deals).where(eq(schema.deals.id, dealId)))[0]!;
  const lastDecision = async (trancheId: string) =>
    (await db().select().from(schema.firewallDecisions).where(eq(schema.firewallDecisions.trancheId, trancheId))).at(-1)!;
  const publish = (v: Omit<SimVideo, "publishedAt" | "title" | "durationSec" | "viewCount"> & Partial<SimVideo>) => {
    world.videos.push({ title: `Morning routine (${v.id})`, durationSec: 95, viewCount: 120, publishedAt: new Date().toISOString(), ...v });
  };
  const tick = () => new Promise((r) => setTimeout(r, 25));

  async function fundedDeal(terms: string): Promise<string> {
    const c = await post(compile, { terms, creatorPayPalId: CREATOR, youtubeChannel: "@asha" });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const dealId = c.body.dealId as string;
    const o = await post(createOrder, { dealId, flow: "buttons" });
    assert.equal(o.status, 200, JSON.stringify(o.body));
    const a = await post(onApprove, { dealId, orderId: o.body.orderId });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    return dealId;
  }

  console.log(`Tranche simulation (${usePg ? "Postgres at DATABASE_URL" : "in-memory PGlite"}; PayPal, YouTube and Gemini simulated)`);

  // ---------------- Deal A ----------------
  say("Deal A: compile plain-English terms, then authorize $600 on PayPal");
  const A = await fundedDeal("Lumen pays $600: $400 when the video is live with 30s on Glow Serum and #ad; $200 bonus at 10,000 views.");
  let d = await dealRow(A);
  assert.equal(d.status, "AUTHORIZED");
  assert.equal(d.authorizedAmount, "600.00");
  assert.equal(d.capturedTotal, "0.00");
  assert.equal(d.brandPaypalId, BRAND);
  ok(`deal ${A.slice(0, 8)} AUTHORIZED: $600.00 held, $0.00 captured (brand ${BRAND})`);

  say("Deal A: video goes live WITHOUT a disclosure");
  await tick();
  publish({ id: "vidAAAAAAA1", description: "My morning routine with Glow Serum", privacyStatus: "public", spokenDisclosure: false });
  let r = await post(trigger, { dealId: A, videoId: "https://www.youtube.com/watch?v=vidAAAAAAA1" });
  let ts = await tranchesOf(A);
  assert.equal(ts[0]!.status, "REFUSED", JSON.stringify(r.body));
  let dec = await lastDecision(ts[0]!.id);
  assert.equal(dec.decision, "REJECTED");
  assert.deepEqual(dec.refusalReasons.map((x) => x.split(":")[0]), ["AD_DISCLOSURE"]);
  assert.equal(world.captures.size, 0);
  ok(`firewall REJECTED: ${dec.refusalReasons[0]}`);
  ok(`no PayPal capture attempted (captures so far: ${world.captures.size})`);

  say("Deal A: the creator adds #ad to the description and the audit re-runs");
  world.videos[0]!.description += "\n\nThanks Lumen Skincare for sponsoring this video #ad";
  await new Promise((res) => setTimeout(res, 5_100)); // the public trigger is throttled to one run per 5 s
  r = await post(trigger, { dealId: A, videoId: "vidAAAAAAA1" });
  ts = await tranchesOf(A);
  assert.equal(ts[0]!.status, "PAID_OUT", JSON.stringify(r.body));
  assert.equal(world.urlAuditCalls, 1, "the second audit must reuse the cached Gemini verdict");
  dec = await lastDecision(ts[0]!.id);
  assert.equal(dec.decision, "APPROVED");
  const capA1 = [...world.captures.values()][0]!;
  assert.equal(capA1.value, "400.00");
  assert.equal(capA1.final, false);
  assert.equal([...world.payouts.values()][0]!.receiver, CREATOR);
  d = await dealRow(A);
  assert.equal(d.capturedTotal, "400.00");
  assert.equal(d.status, "IN_PROGRESS");
  ok(`firewall APPROVED ${dec.ruleResults.filter((x) => x.passed).length}/${dec.ruleResults.length} rules; Gemini called once (verdict cached)`);
  ok(`captured $${capA1.value} (final_capture=${capA1.final}) and paid out to ${CREATOR}`);

  say("Deal A: view milestone not reached yet");
  r = await post(trigger, { all: true }, true);
  ts = await tranchesOf(A);
  assert.equal(ts[1]!.status, "PENDING");
  ok(`tranche 2 waiting: ${ts[1]!.progressNote}`);

  say("Deal A: 12,000 views; the scheduled poll releases the final $200");
  world.videos[0]!.viewCount = 12_000;
  r = await post(trigger, { all: true }, true);
  ts = await tranchesOf(A);
  assert.equal(ts[1]!.status, "PAID_OUT", JSON.stringify(r.body));
  const capA2 = [...world.captures.values()][1]!;
  assert.equal(capA2.value, "200.00");
  assert.equal(capA2.final, true);
  d = await dealRow(A);
  assert.equal(d.capturedTotal, "600.00");
  assert.equal(d.status, "COMPLETED");
  assert.equal(world.voids.length, 0);
  ok(`captured $${capA2.value} with final_capture=true; deal COMPLETED, nothing left to void`);

  // ---------------- Deal B ----------------
  say("Deal B: a second deal cannot be paid with the same video");
  const B = await fundedDeal("Lumen pays $600: $400 when live with #ad and 30s on Glow Serum; $200 at 10,000 views.");
  r = await post(trigger, { dealId: B }, true);
  ts = await tranchesOf(B);
  assert.equal(ts[0]!.status, "PENDING");
  assert.match(String((r.body.outcomes as Array<{ note: string }>)[0]?.note), /No eligible public upload/);
  ok("channel scan skips videos already paid by another deal");

  // ---------------- Deal C ----------------
  say("Deal C: YouTube URL audit fails, so the transcript is audited instead");
  const C = await fundedDeal("Lumen pays $600: $400 when live with #ad and 30s on Glow Serum; $200 if the video stays public 3 days.");
  await tick();
  publish({ id: "vidCCCCCCC3", description: "Glow Serum, two weeks in", privacyStatus: "public", spokenDisclosure: true, urlAuditFails: true });
  const transcript = ["WEBVTT", "", "00:00:40.000 --> 00:00:43.000", "This video is sponsored by Lumen Skincare.", "", "00:00:44.000 --> 00:00:50.000", "Glow Serum goes on first."].join("\n");
  world.loseNextCaptureResponse = true;
  const capturesBefore = world.captures.size;
  const callsBefore = world.captureHttpCalls;
  r = await post(trigger, { dealId: C, videoId: "vidCCCCCCC3", transcript }, true);
  ts = await tranchesOf(C);
  assert.equal(ts[0]!.status, "PAID_OUT", JSON.stringify(r.body));
  assert.equal(world.transcriptAuditCalls, 1);
  const [auditC] = await db().select().from(schema.evidenceAudits).where(eq(schema.evidenceAudits.trancheId, ts[0]!.id));
  assert.equal(auditC!.source, "transcript");
  ok("transcript audit: spoken disclosure at 00:40, brand segment 0:42–1:21");
  assert.equal(world.captures.size, capturesBefore + 1, "exactly one capture despite the lost response");
  assert.ok(world.captureHttpCalls >= callsBefore + 2, "the client retried");
  ok(`PayPal captured but the response was lost; the retry reused the PayPal-Request-Id: ${world.captureHttpCalls - callsBefore} HTTP calls, 1 capture`);

  say("Deal C: the creator makes the paid video private during the retention period");
  world.videos.find((v) => v.id === "vidCCCCCCC3")!.privacyStatus = "private";
  r = await post(trigger, { dealId: C }, true);
  ts = await tranchesOf(C);
  d = await dealRow(C);
  assert.equal(ts[1]!.status, "VOIDED");
  assert.equal(d.status, "COMPLETED");
  assert.equal(world.voids.length, 1);
  ok(`retention tranche VOIDED; authorization voided, $200.00 released back to the brand (${r.body.closed})`);

  // ---------------- Concurrency (real Postgres only) ----------------
  if (usePg) {
    say("Concurrency: two runs on one deal at the same moment");
    const reports = await Promise.all([post(trigger, { dealId: B }, true), post(trigger, { dealId: B }, true)]);
    assert.ok(reports.some((x) => String(x.body.skipped ?? "").includes("lease")), JSON.stringify(reports.map((x) => x.body)));
    ok("the deal lease let exactly one run proceed");
  }

  // ---------------- Invariants + ledger ----------------
  say("Invariants");
  const deals = await db().select().from(schema.deals);
  for (const deal of deals) {
    assert.ok(Number(deal.capturedTotal) <= Number(deal.authorizedAmount), `deal ${deal.id} over-captured`);
  }
  ok("no deal captured more than it authorized");
  const captureRows = (await db().select().from(schema.paypalLedger).where(eq(schema.paypalLedger.kind, "CAPTURE"))).filter((x) => x.status === "COMPLETED");
  assert.equal(new Set(captureRows.map((x) => x.paypalRequestId)).size, captureRows.length);
  assert.equal(captureRows.length, world.captures.size);
  ok(`every capture has its own PayPal-Request-Id (${captureRows.length} captures, ${world.captures.size} at PayPal)`);
  assert.ok([...world.payouts.values()].every((p) => p.receiver === CREATOR));
  ok("every payout went to the contract creator");
  const approvedKeys = (await db().select().from(schema.firewallDecisions).where(eq(schema.firewallDecisions.decision, "APPROVED"))).map((x) => x.idempotencyKey);
  assert.equal(new Set(approvedKeys).size, approvedKeys.length);
  ok("no PayPal-Request-Id was approved twice");

  // Payout status: PayPal answered PENDING when each payout was created; re-checks pick up SUCCESS.
  for (const id of [A, C, A, C]) await getDeal(new Request(`http://localhost/api/deals/${id}`), { params: Promise.resolve({ id }) });
  const paidOut = await db().select().from(schema.tranches).where(eq(schema.tranches.status, "PAID_OUT"));
  assert.ok(paidOut.length >= 3, `expected at least 3 paid-out tranches, got ${paidOut.length}`);
  assert.ok(paidOut.every((t) => t.payoutStatus === "SUCCESS"), `payouts not refreshed: ${paidOut.map((t) => t.payoutStatus).join(", ")}`);
  const completions = (await db().select().from(schema.timelineEvents)).filter((e) => /PayPal completed payout batch/.test(e.message));
  assert.equal(completions.length, paidOut.length, "each payout's completion should be recorded exactly once");
  ok(`payout status re-checked at PayPal: ${paidOut.length}/${paidOut.length} payouts went from PENDING to SUCCESS, each recorded once on the timeline`);

  const view = await (await getDeal(new Request(`http://localhost/api/deals/${A}`), { params: Promise.resolve({ id: A }) })).json();
  assert.equal(view.escrow.capturedCents, 60_000);
  ok(`GET /api/deals/${A.slice(0, 8)} returns ${view.timeline.length} timeline events, ${view.decisions.length} firewall decisions`);

  console.log("\nVerified PayPal ledger");
  const rows = await db().select().from(schema.paypalLedger).orderBy(asc(schema.paypalLedger.createdAt));
  const dealIndex = new Map([
    [A, "A"],
    [B, "B"],
    [C, "C"],
  ]);
  const line = (cols: string[]) => console.log([cols[0]!.padEnd(4), cols[1]!.padEnd(16), cols[2]!.padStart(9), cols[3]!.padEnd(19), cols[4]].join("  "));
  line(["Deal", "Call", "Amount", "Status", "PayPal id"]);
  for (const row of rows) {
    line([dealIndex.get(row.dealId) ?? "?", row.kind, row.amount ? `$${row.amount}` : "", row.status, row.paypalId ?? "—"]);
  }
  const decisions = await db().select().from(schema.firewallDecisions).orderBy(asc(schema.firewallDecisions.evaluatedAt));
  console.log(`\nFirewall decisions: ${decisions.filter((x) => x.decision === "APPROVED").length} approved, ${decisions.filter((x) => x.decision === "REJECTED").length} rejected`);
  console.log(`Gemini calls: ${world.compileCalls} contract compiles, ${world.urlAuditCalls} video audits, ${world.transcriptAuditCalls} transcript audit(s)`);
  // Latency settings: default temperature (Gemini 3 can loop below 1.0) and thinking level "low" on every call.
  assert.ok(world.geminiConfigs.length > 0, "no Gemini requests were made");
  for (const gc of world.geminiConfigs) {
    assert.equal(gc.temperature, undefined, `Gemini request overrides temperature: ${JSON.stringify(gc)}`);
    assert.equal(String(gc.thinkingConfig?.thinkingLevel ?? "").toLowerCase(), "low", `Gemini request without thinking level low: ${JSON.stringify(gc)}`);
  }
  console.log(`Gemini settings: ${world.geminiConfigs.length}/${world.geminiConfigs.length} requests use default temperature and thinking level low`);
  // Model failover: "high demand" 503s on the main model were answered by the fallback model.
  assert.ok(world.busy.served >= 2, `expected the simulated outage to serve 503s, got ${world.busy.served}`);
  assert.equal(world.busy.compileModel, "gemini-3.6-flash", "contract compile did not fail over to the fallback model");
  assert.equal(world.busy.auditModel, "gemini-3.6-flash", "video audit did not fail over to the fallback model");
  const fallbackAudits = await db().select().from(schema.evidenceAudits).where(eq(schema.evidenceAudits.model, "gemini-3.6-flash"));
  assert.ok(fallbackAudits.length >= 1, "the audit made on the fallback model is not recorded with that model");
  console.log(`Gemini failover: ${world.busy.served} "high demand" 503s from gemini-3.8-flash; compile and audit completed on gemini-3.6-flash`);
  // Time limit: slow main-model requests were cancelled and answered by the fallback.
  assert.equal(world.slow.compileModel, "gemini-3.6-flash", "slow contract compile did not switch to the fallback model");
  assert.equal(world.slow.transcriptModel, "gemini-3.6-flash", "slow transcript audit did not switch to the fallback model");
  assert.ok(world.slow.cancelled >= 2, `expected both slow requests to be cancelled at the network level, got ${world.slow.cancelled}`);
  console.log(`Gemini time limit: ${world.slow.cancelled} slow gemini-3.8-flash requests cancelled after 1.5 s; compile and transcript audit completed on gemini-3.6-flash`);
  console.log("\n\u2714 Simulation passed: every invariant held.");

  await pglite?.close();
  if (usePg) await closeDb();
}

main().catch((e) => {
  console.error("\n\u2718 Simulation failed:", e);
  process.exit(1);
});
