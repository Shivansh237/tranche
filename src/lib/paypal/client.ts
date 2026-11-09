/**
 * Authenticated, idempotent PayPal REST client (sandbox by default).
 *
 *   getAccessToken()           OAuth2 client_credentials, cached until near expiry
 *   createAuthorizedOrder()    POST /v2/checkout/orders            intent AUTHORIZE
 *   authorizeOrder()           POST /v2/checkout/orders/{id}/authorize
 *   captureAuthorizedOrder()   POST /v2/payments/authorizations/{id}/capture
 *   createPayout()             POST /v1/payments/payouts
 *   getPayoutBatch()           GET  /v1/payments/payouts/{payout_batch_id}
 *   voidAuthorization()        POST /v2/payments/authorizations/{id}/void
 *
 * Every mutating call REQUIRES a PayPal-Request-Id. PayPal stores these keys
 * (45 days for captures) and returns the original result for a repeated key,
 * so a retry after a timeout can never move money twice.
 */
import { env } from "@/lib/env";
import { fromCents, type Cents } from "@/lib/util/money";

const BASE_URL = { sandbox: "https://api-m.sandbox.paypal.com", live: "https://api-m.paypal.com" } as const;

export function paypalBaseUrl(): string {
  return BASE_URL[env().PAYPAL_ENV];
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

let tokenCache: { token: string; expiresAt: number } | undefined;

export async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = env();
  const res = await fetch(`${paypalBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  if (!res.ok) throw new PayPalError(res.status, "AUTHENTICATION_FAILURE", await res.text(), res.headers.get("paypal-debug-id"));
  const json = (await res.json()) as { access_token: string; expires_in: number };
  // Refresh two minutes early so a long request never carries an expired token.
  tokenCache = { token: json.access_token, expiresAt: Date.now() + Math.max(0, json.expires_in - 120) * 1000 };
  return json.access_token;
}

export function clearTokenCache(): void {
  tokenCache = undefined;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class PayPalError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorName: string,
    public readonly body: string,
    public readonly debugId: string | null,
    public readonly issue?: string,
  ) {
    super(`PayPal ${status} ${errorName}${issue ? ` (${issue})` : ""} debug_id=${debugId ?? "n/a"}`);
    this.name = "PayPalError";
  }

  /** PayPal refused on the merits (4xx other than 401/408/409/429): nothing moved. */
  get definitive(): boolean {
    return this.status >= 400 && this.status < 500 && ![401, 408, 409, 429].includes(this.status);
  }
}

export interface PayPalResponse<T> {
  data: T;
  status: number;
  debugId: string | null;
}

/**
 * Fetch with PayPal-Request-Id on every mutation, `Prefer: return=representation`,
 * and up to two retries on network errors / 5xx / 429 / 401 with the SAME
 * request id — safe because PayPal de-duplicates on it.
 */
export async function paypalRequest<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; requestId?: string },
): Promise<PayPalResponse<T>> {
  if (init.method !== "GET" && !init.requestId) {
    throw new Error(`Refusing ${init.method} ${path} without a PayPal-Request-Id`);
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${paypalBaseUrl()}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${await getAccessToken()}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          ...(init.requestId ? { "PayPal-Request-Id": init.requestId } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        cache: "no-store",
      });
      const debugId = res.headers.get("paypal-debug-id");
      const text = await res.text();
      if (res.ok) return { data: (text ? JSON.parse(text) : {}) as T, status: res.status, debugId };

      const parsed = safeJson(text) as { name?: string; details?: Array<{ issue?: string }> } | undefined;
      const err = new PayPalError(res.status, parsed?.name ?? "HTTP_ERROR", text, debugId, parsed?.details?.[0]?.issue);
      if (res.status === 401) clearTokenCache();
      if (!err.definitive) {
        lastError = err;
        await sleep(300 * (attempt + 1));
        continue;
      }
      throw err;
    } catch (e) {
      if (e instanceof PayPalError && e.definitive) throw e;
      lastError = e;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Orders v2
// ---------------------------------------------------------------------------

interface Link {
  href: string;
  rel: string;
}

export interface AuthorizationResource {
  id: string;
  status: string; // CREATED | CAPTURED | PARTIALLY_CAPTURED | VOIDED | EXPIRED | DENIED | PENDING
  amount: { currency_code: string; value: string };
  expiration_time?: string;
}

export interface OrderResource {
  id: string;
  status: string;
  links?: Link[];
  payer?: { email_address?: string; payer_id?: string };
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    amount?: { currency_code: string; value: string };
    payments?: { authorizations?: AuthorizationResource[] };
  }>;
}

export interface CaptureResource {
  id: string;
  status: string; // COMPLETED | PENDING | DECLINED | FAILED
  amount: { currency_code: string; value: string };
  final_capture?: boolean;
}

/**
 * Creates an order with intent AUTHORIZE for the whole deal budget.
 * - For the JS SDK buttons, omit `returnUrl`: the button handles approval.
 * - For the redirect fallback, pass `returnUrl`/`cancelUrl`; the response's
 *   payer-action link is where the brand approves.
 */
export async function createAuthorizedOrder(
  amount: Cents,
  currency: "USD",
  opts: { dealId: string; description: string; requestId: string; returnUrl?: string; cancelUrl?: string },
) {
  const body: Record<string, unknown> = {
    intent: "AUTHORIZE",
    purchase_units: [
      {
        reference_id: opts.dealId,
        custom_id: opts.dealId,
        description: opts.description.slice(0, 127),
        amount: { currency_code: currency, value: fromCents(amount) },
      },
    ],
  };
  if (opts.returnUrl) {
    body.payment_source = {
      paypal: {
        experience_context: {
          brand_name: "Tranche Escrow",
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
          return_url: opts.returnUrl,
          cancel_url: opts.cancelUrl ?? opts.returnUrl,
        },
      },
    };
  }
  const res = await paypalRequest<OrderResource>("/v2/checkout/orders", { method: "POST", body, requestId: opts.requestId });
  const approveUrl = res.data.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null;
  return { ...res, approveUrl, body };
}

/** Authorizes an order the brand approved. Funds are held, not moved. */
export async function authorizeOrder(orderId: string) {
  const requestId = `order-${orderId}-authorize`;
  const res = await paypalRequest<OrderResource>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {
    method: "POST",
    body: {},
    requestId,
  });
  const authorization = res.data.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!authorization) throw new Error(`Order ${orderId} returned no authorization`);
  return { ...res, authorization, requestId };
}

export async function getOrder(orderId: string) {
  return paypalRequest<OrderResource>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { method: "GET" });
}

export async function getAuthorization(authorizationId: string) {
  return paypalRequest<AuthorizationResource>(`/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`, { method: "GET" });
}

// ---------------------------------------------------------------------------
// Payments v2
// ---------------------------------------------------------------------------

/**
 * Partial capture against the authorization. `isFinal` (final_capture) is true
 * only for the last tranche that can still pay; PayPal then closes the
 * authorization. `requestId` is mandatory: it is the firewall-approved key.
 */
export async function captureAuthorizedOrder(
  authorizationId: string,
  amount: Cents,
  isFinal: boolean,
  requestId: string,
  opts: { invoiceId: string; noteToPayer: string; currency?: "USD" },
) {
  if (!/^[\w-]{8,108}$/.test(requestId)) throw new Error("captureAuthorizedOrder requires a valid PayPal-Request-Id");
  const body = {
    amount: { currency_code: opts.currency ?? "USD", value: fromCents(amount) },
    final_capture: isFinal,
    invoice_id: opts.invoiceId.slice(0, 127),
    note_to_payer: opts.noteToPayer.slice(0, 255),
  };
  const res = await paypalRequest<CaptureResource>(`/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, {
    method: "POST",
    body,
    requestId,
  });
  return { ...res, body };
}

/** Releases everything still held on the authorization back to the brand. */
export async function voidAuthorization(authorizationId: string, requestId = `void-${authorizationId}`) {
  return paypalRequest<AuthorizationResource | Record<string, never>>(
    `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`,
    { method: "POST", requestId },
  );
}

// ---------------------------------------------------------------------------
// Payouts v1
// ---------------------------------------------------------------------------

export interface PayoutBatchResource {
  batch_header: {
    payout_batch_id: string;
    batch_status: string; // PENDING | PROCESSING | SUCCESS | DENIED
    sender_batch_header: { sender_batch_id: string };
  };
}

/** GET /v1/payments/payouts/{id}: the batch header plus each item's transaction_status. */
export interface PayoutBatchDetails extends PayoutBatchResource {
  items?: Array<{ payout_item_id?: string; transaction_status?: string; errors?: { name?: string; message?: string } }>;
}

/** Read-only: where a payout batch stands now (PayPal processes batches after they are created). */
export async function getPayoutBatch(payoutBatchId: string) {
  return paypalRequest<PayoutBatchDetails>(`/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`, { method: "GET" });
}

/**
 * Pushes captured funds to the creator. `senderBatchId` is unique per tranche;
 * PayPal rejects a repeated sender_batch_id, and the same value is sent as
 * the PayPal-Request-Id so a retry returns the original batch.
 */
export async function createPayout(
  receiverEmail: string,
  amount: Cents,
  note: string,
  opts: { senderBatchId: string; senderItemId: string; emailSubject: string; currency?: "USD" },
) {
  const body = {
    sender_batch_header: {
      sender_batch_id: opts.senderBatchId,
      email_subject: opts.emailSubject.slice(0, 255),
      email_message: note.slice(0, 1000),
    },
    items: [
      {
        recipient_type: "EMAIL",
        receiver: receiverEmail,
        amount: { value: fromCents(amount), currency: opts.currency ?? "USD" },
        note: note.slice(0, 4000),
        sender_item_id: opts.senderItemId,
      },
    ],
  };
  const res = await paypalRequest<PayoutBatchResource>("/v1/payments/payouts", {
    method: "POST",
    body,
    requestId: opts.senderBatchId,
  });
  return { ...res, body };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
