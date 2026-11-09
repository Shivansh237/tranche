# Tranche

**Sponsorships that pay the moment the video checks out.** A brand funds a creator deal once with PayPal. Tranche watches the creator's YouTube channel, has Gemini audit each video against the contract, and releases money tranche by tranche — only after a deterministic Spend Firewall approves. When something is missing, the money stays held and both sides see the exact second why.

Built for the PayPal AI Hackathon (2026). MIT licensed.

## Try it in 30 seconds (no accounts needed)

```bash
npm install
npm run simulate
```

`simulate` runs the real route handlers, orchestrator, firewall and database (in-memory Postgres via PGlite with the real migrations). Only PayPal, YouTube and Gemini are simulated, at the HTTP layer. It walks through three deals and prints the verified ledger:

- **Deal A** — a video without `#ad` is **withheld**; the creator adds `#ad`; $400 is **partially captured** (`final_capture: false`) and **paid out**; at 10,000 views the last $200 is captured with `final_capture: true` and the deal completes.
- **Deal B** — the same video cannot pay a second deal.
- **Deal C** — Gemini can't open the video, so the **transcript** is audited instead; PayPal captures but the response is lost, and the retry with the **same PayPal-Request-Id** produces exactly one capture; the creator makes the video private, so the retention tranche is **voided** and the rest of the authorization goes back to the brand.

## How it works

1. **Compile.** The brand writes the deal in plain English. Gemini (Vercel AI SDK 7, `generateText` + `Output.object`) compiles it into typed tranches; deterministic code checks that the amounts add up. The creator's PayPal email and channel come from form fields, never from the model.
2. **Fund.** The brand approves a PayPal order with `intent: "AUTHORIZE"` (JS SDK button, or a redirect fallback). Funds are held on the brand's account, not captured.
3. **Detect.** A cron poll (or a manual trigger) finds the creator's newest public upload with the YouTube Data API.
4. **Audit.** Gemini watches the public YouTube video (`@google/genai`, YouTube URL as `fileData`) and reports *observations only*: brand-segment timestamps, spoken and on-screen disclosures, keyword mentions, confidence. If the URL can't be opened, a creator-supplied transcript is audited instead.
5. **Evaluate and hash.** Code turns observations plus YouTube facts into findings (segment seconds from merged timestamps, `#ad` in the description read directly) and seals them with a SHA-256 evidence hash.
6. **Spend Firewall.** `evaluateSpendFirewall(intent, policy, currentCapturedTotal)` — a pure function — checks 22 rules: payee allowlist, exact amount, budget cap, deterministic and non-replayed PayPal-Request-Id, evidence binding, channel, public video, `#ad`, segment length, keyword, view milestone, retention, confidence gate, publication window and deadline with clock-drift tolerance, evidence freshness, kill switch.
7. **Release.** Only on APPROVED: partial capture on the authorization, then a Payout to the creator.
8. **Close.** When nothing more can pay (all paid, deadline missed, or the video taken down), the remaining authorization is voided back to the brand.

## PayPal integration

| Capability | API | Code |
| --- | --- | --- |
| Hold the budget | Orders v2 `intent: AUTHORIZE` + authorize | `src/lib/paypal/client.ts` `createAuthorizedOrder`, `authorizeOrder` |
| Release a tranche | Payments v2 capture, `final_capture` false then true | `captureAuthorizedOrder` |
| Pay the creator | Payouts v1, one `sender_batch_id` per tranche | `createPayout` |
| Return unearned funds | Void authorization | `voidAuthorization` |
| Brand checkout | PayPal JS SDK v5 buttons, `intent=authorize` | `src/components/paypal-button.tsx` |
| AI read access | PayPal MCP server (`@paypal/mcp`), read-only tools | `src/lib/copilot/deal-desk.ts` |

Every mutating PayPal call carries a `PayPal-Request-Id` and is recorded in `paypal_ledger`.

## AI tools used

- **Gemini via `@google/genai`** — multimodal audit of public YouTube videos with JSON-schema output, plus transcript fallback (`src/lib/ai/video-auditor.ts`).
- **Gemini via Vercel AI SDK 7** — contract compiler (`src/lib/ai/contract-compiler.ts`).
- **Gemini + PayPal MCP server via `@ai-sdk/mcp`** — the read-only Deal Desk copilot that explains a deal (`src/lib/copilot/deal-desk.ts`).

Default model: `gemini-3.8-flash`. `gemini-1.5` is retired and `gemini-2.5` is only available to Google projects that used it before; set `GEMINI_MODEL` if yours does.

## Safety design

- **The model observes; code decides.** Gemini never outputs an amount, payee or verdict.
- **No double payment:** a per-deal lease, conditional status claims, a balance re-check under `SELECT … FOR UPDATE`, deterministic PayPal-Request-Ids (resent unchanged after a timeout), a unique `invoice_id` per capture, one `sender_batch_id` per payout, and a partial unique index that lets each idempotency key be **APPROVED only once** at the database level.
- **State machine:** a tranche reaches `PAID_OUT` only through `AUDITING → APPROVED → CAPTURED` (`src/lib/engine/state-machine.ts`).
- **Least privilege for AI tools:** the copilot's MCP server only has `orders.get`, `transactions.list` and `invoices.list`.

## Run it for real (PayPal sandbox)

Requirements: Node 22.12+ (24 recommended), Postgres, a PayPal developer account, a Gemini key and a YouTube Data API key. **[SETUP.md](SETUP.md) walks through getting every key, step by step.**

```bash
cp .env.example .env.local    # fill it in (see SETUP.md)
npm run smoke -- --channel=@yourhandle --video=<a public video id>   # migrates the DB, then checks Postgres, PayPal, YouTube, Gemini
npm run dev                   # http://localhost:3000
npm run poll -- --every=15    # second terminal: checks every active deal every 15 s
```

**Sandbox setup:** create an app under *Apps & Credentials → Sandbox* (its business account is the platform that receives captures and sends payouts) and make sure **Payouts** is enabled. Create two personal sandbox accounts: the **brand** logs in to approve funding; the **creator** receives payouts. Put the same client id in `PAYPAL_CLIENT_ID` and `NEXT_PUBLIC_PAYPAL_CLIENT_ID`.

**Flow:** *New deal* → write terms, enter the creator's sandbox email and channel → *Compile contract* → approve with the PayPal button as the brand → publish a **public** video → *Run audit* on the deal page.

### Test accounts for judges

<!-- Fill these in before submitting -->
- Hosted app: `https://…`
- Brand sandbox login: `…` / `…`
- Creator sandbox login: `…` / `…`

## API

| Route | Purpose |
| --- | --- |
| `POST /api/deals/compile` | Plain-English terms → compiled contract; saves a DRAFT deal |
| `POST /api/paypal/create-order` | Creates the `intent: AUTHORIZE` order |
| `POST /api/paypal/on-approve` | Authorizes the approved order; deal → AUTHORIZED |
| `POST /api/verify/trigger` | Audit one deal now (`{ dealId, videoId?, transcript? }`) or poll all (`{ all: true }`, Bearer `CRON_SECRET`) |
| `GET /api/deals/[id]` | Deal, balances, tranches, audits, firewall decisions, ledger, timeline |
| `POST /api/copilot` | Read-only Deal Desk question |

## Tests

```bash
npm test                 # 71 unit tests
npm run test:coverage    # fails if src/lib/firewall/engine.ts drops below 100% coverage
npm run simulate         # end-to-end money path, self-contained
npm run simulate -- --pg # same against DATABASE_URL (truncates Tranche tables), plus a concurrency check
```

## Deploy

`render.yaml` defines the web service and a one-minute cron job that calls `POST /api/verify/trigger` with `{ "all": true }`. Set `APP_URL`, `DATABASE_URL` and the keys, then deploy.

## Limitations

- Sandbox only. The platform's business account briefly holds captured funds before paying out; production would use PayPal's multiparty delayed disbursement.
- Gemini's YouTube URL input is a preview feature and only accepts public videos.
- PayPal authorizations last 29 days with a 3-day honor period, so deal windows are capped at 28 days.
