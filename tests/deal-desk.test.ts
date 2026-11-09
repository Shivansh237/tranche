/**
 * Deal Desk time limits, with a fake Gemini (MockLanguageModelV4) and a fake
 * PayPal MCP server. Limits are scaled down to milliseconds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Reply = { ms: number; toolCalls?: { name: string; input?: object }[]; text?: string } | { ms: number; error: Error };

const h = vi.hoisted(() => {
  /** Resolves with `value` after `ms` (never, for Infinity); rejects with the abort reason as soon as `signal` aborts, like fetch. */
  function wait<T>(ms: number, value: T, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = Number.isFinite(ms) ? setTimeout(() => resolve(value), ms) : undefined;
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  }
  return {
    wait,
    replies: {} as Record<string, Reply[]>,
    requests: {} as Record<string, number>,
    toolsOffered: [] as string[][],
    mcp: { fails: false, getOrderMs: 5, closed: 0 },
  };
});

vi.mock("@/lib/env", () => ({
  env: () => ({ GEMINI_MODEL: "gemini-3.8-flash", GEMINI_FALLBACK_MODELS: "gemini-3.6-flash", GEMINI_THINKING_LEVEL: "low", PAYPAL_ENV: "sandbox" }),
}));
vi.mock("@/lib/engine/deal-view", () => ({
  loadDealView: async () => ({ deal: { id: "deal-1", authorizedOrderId: "ORDER-1", authorizationId: "AUTH-1" }, tranches: [], ledger: [] }),
}));
vi.mock("@/lib/paypal/client", () => ({ getAccessToken: async () => "test-token" }));
vi.mock("@ai-sdk/mcp/mcp-stdio", () => ({
  Experimental_StdioMCPTransport: class {
    constructor(readonly params: unknown) {}
  },
}));
vi.mock("@ai-sdk/mcp", async () => {
  const { tool } = await import("ai");
  const { z } = await import("zod");
  return {
    createMCPClient: async () => {
      if (h.mcp.fails) throw new Error("MCP client initialization timed out after 1000ms");
      return {
        tools: async () => ({
          get_order: tool({
            description: "Retrieves a PayPal order",
            inputSchema: z.object({ id: z.string() }),
            execute: (_input: { id: string }, { abortSignal }: { abortSignal?: AbortSignal }) => h.wait(h.mcp.getOrderMs, { status: "COMPLETED" }, abortSignal),
          }),
        }),
        close: async () => {
          h.mcp.closed += 1;
        },
      };
    },
  };
});
vi.mock("@/lib/ai/provider", async () => {
  const { MockLanguageModelV4 } = await import("ai/test");
  return {
    gemini: (modelId: string) =>
      new MockLanguageModelV4({
        provider: "google",
        modelId,
        doGenerate: async ({ abortSignal, tools }: { abortSignal?: AbortSignal; tools?: Array<{ name: string }> }) => {
          h.toolsOffered.push((tools ?? []).map((t) => t.name));
          const n = (h.requests[modelId] = (h.requests[modelId] ?? 0) + 1);
          const script = h.replies[modelId] ?? [];
          const reply = script[n - 1] ?? script.at(-1)!;
          await h.wait(reply.ms, null, abortSignal);
          if ("error" in reply) throw reply.error;
          const content = reply.toolCalls
            ? reply.toolCalls.map((c, i) => ({ type: "tool-call" as const, toolCallId: `${modelId}-${n}-${i}`, toolName: c.name, input: JSON.stringify(c.input ?? {}) }))
            : [{ type: "text" as const, text: reply.text ?? "" }];
          return {
            content,
            finishReason: { unified: reply.toolCalls ? ("tool-calls" as const) : ("stop" as const), raw: undefined },
            usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
            warnings: [],
          };
        },
      }),
  };
});

import { APICallError } from "@ai-sdk/provider";
import { askDealDesk, DealDeskError, resetDealDeskState, type DealDeskLimits } from "@/lib/copilot/deal-desk";

const LIMITS: DealDeskLimits = { mcpStartMs: 1_000, paypalToolMs: 80, modelBudgetMs: 150, lastModelBudgetMs: 1_000, totalMs: 1_500, demoteMs: 60_000 };
const MAIN = "gemini-3.8-flash";
const BACKUP = "gemini-3.6-flash";
const LEDGER = { name: "get_tranche_ledger" };
const ORDER = { name: "get_order", input: { id: "ORDER-1" } };
const busy503 = () => Object.assign(new Error("This model is currently experiencing high demand."), { statusCode: 503 });

/** A two-request answer: ask for tools, then write `text`. */
const answers = (ms: number, text: string, tools = [LEDGER, ORDER]): Reply[] => [{ ms, toolCalls: tools }, { ms, text }];

async function failure(p: Promise<unknown>): Promise<DealDeskError> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DealDeskError);
  return error as DealDeskError;
}

beforeEach(() => {
  resetDealDeskState();
  for (const k of Object.keys(h.replies)) delete h.replies[k];
  for (const k of Object.keys(h.requests)) delete h.requests[k];
  h.toolsOffered.length = 0;
  Object.assign(h.mcp, { fails: false, getOrderMs: 5, closed: 0 });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("Deal Desk", () => {
  it("answers with the main model and times every step", async () => {
    h.replies[MAIN] = answers(5, "Nothing is still held: both tranches were captured.");
    const out = await askDealDesk("deal-1", "How much is still held?", LIMITS);

    expect(out.model).toBe(MAIN);
    expect(out.answer).toBe("Nothing is still held: both tranches were captured.");
    expect(out.toolCalls).toEqual(["get_tranche_ledger", "get_order"]);
    expect(h.toolsOffered[0]).toEqual(expect.arrayContaining(["get_order", "get_tranche_ledger"]));
    const trace = out.trace.join("\n");
    expect(trace).toMatch(/^\+\d+\.\ds deal loaded/);
    expect(trace).toContain("PayPal MCP ready: get_order");
    expect(trace).toMatch(/gemini-3\.8-flash: request 1 answered in [\d.]+s \(asked for get_tranche_ledger, get_order; 100 tokens in, 10 out\)/);
    expect(trace).toMatch(/get_order\(\{"id":"ORDER-1"\}\) started/);
    expect(trace).toMatch(/get_order finished in [\d.]+s/);
    expect(trace).toMatch(/gemini-3\.8-flash: request 2 answered in [\d.]+s \(final answer/);
    expect(trace).toMatch(/answered by gemini-3\.8-flash$/);
    expect(h.mcp.closed).toBe(1);
  });

  it("switches to the backup once the main model has used up its Gemini time, then tries the backup first", async () => {
    h.replies[MAIN] = answers(100, "too late"); // 200 ms of Gemini time against a 150 ms budget
    h.replies[BACKUP] = answers(5, "answer from the backup");
    const first = await askDealDesk("deal-1", "How much is still held?", LIMITS);

    expect(first.model).toBe(BACKUP);
    expect(first.answer).toBe("answer from the backup");
    expect(first.trace.join("\n")).toMatch(/gemini-3\.8-flash: used up its [\d.]+s of Gemini time; cancelled/);
    expect(first.trace.at(-1)).toMatch(/answered by gemini-3\.6-flash; gemini-3\.8-flash will be tried last for the next 1 min$/);
    expect(h.requests[MAIN]).toBe(2);

    // The next question skips the slow model while the backup keeps answering.
    delete h.requests[MAIN];
    const second = await askDealDesk("deal-1", "And why?", LIMITS);
    expect(second.model).toBe(BACKUP);
    expect(second.trace.join("\n")).toContain("gemini-3.8-flash was busy or too slow on a recent question; trying gemini-3.6-flash first");
    expect(h.requests[MAIN]).toBeUndefined();
  });

  it("doesn't count PayPal's time against the model", async () => {
    h.mcp.getOrderMs = 70; // under the 80 ms PayPal limit
    h.replies[MAIN] = answers(60, "on time", [ORDER]); // 120 ms of Gemini time, ~190 ms in all
    const out = await askDealDesk("deal-1", "How much is still held?", LIMITS);

    expect(out.model).toBe(MAIN);
    expect(h.requests[BACKUP]).toBeUndefined();
  });

  it("turns a PayPal call that never answers into a tool error, and still answers", async () => {
    h.mcp.getOrderMs = Infinity;
    h.replies[MAIN] = answers(5, "PayPal's live data was unavailable; from Tranche's records, nothing is held.", [ORDER]);
    const started = Date.now();
    const out = await askDealDesk("deal-1", "How much is still held?", LIMITS);

    expect(out.model).toBe(MAIN);
    expect(out.answer).toContain("PayPal's live data was unavailable");
    expect(out.trace.join("\n")).toMatch(/get_order timed out after [\d.]+s \(limit 0\.1s\)/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("answers from Tranche's records when PayPal's MCP server doesn't start", async () => {
    h.mcp.fails = true;
    h.replies[MAIN] = answers(5, "From Tranche's records: nothing is held.", [LEDGER]);
    const out = await askDealDesk("deal-1", "How much is still held?", LIMITS);

    expect(out.answer).toBe("From Tranche's records: nothing is held.");
    expect(h.toolsOffered[0]).toEqual(["get_tranche_ledger"]);
    expect(out.trace.join("\n")).toContain("PayPal MCP unavailable (MCP client initialization timed out after 1000ms); answering from Tranche's records only");
  });

  it("retries a busy model (after 2 s) before switching to the next one", async () => {
    const overloaded = new APICallError({ message: "This model is currently experiencing high demand.", url: "https://generativelanguage.googleapis.com", requestBodyValues: {}, statusCode: 503 });
    h.replies[MAIN] = [{ ms: 5, error: overloaded }, ...answers(5, "answer after one retry", [LEDGER])];
    const out = await askDealDesk("deal-1", "How much is still held?", { ...LIMITS, modelBudgetMs: 5_000, totalMs: 6_000 });

    expect(out.model).toBe(MAIN);
    expect(out.answer).toBe("answer after one retry");
    expect(h.requests[MAIN]).toBe(3); // one failed attempt, then both requests
    expect(h.requests[BACKUP]).toBeUndefined();
    expect(out.trace.join("\n")).toMatch(/gemini-3\.8-flash: request 1 answered in [23](\.\d)?s/); // includes the 2 s wait
  }, 10_000);

  it("cuts off a stalled last model too, and ends with a clear busy error", async () => {
    h.replies[MAIN] = [{ ms: 5, error: busy503() }];
    h.replies[BACKUP] = [{ ms: Infinity, text: "never" }];
    const started = Date.now();
    const error = await failure(askDealDesk("deal-1", "How much is still held?", { ...LIMITS, lastModelBudgetMs: 200 }));

    expect(error.code).toBe("gemini_busy");
    expect(error.message).toContain("tried gemini-3.8-flash, then gemini-3.6-flash");
    const trace = error.trace.join("\n");
    expect(trace).toContain("gemini-3.8-flash: busy after retries (503: This model is currently experiencing high demand.)");
    expect(trace).toMatch(/gemini-3\.6-flash: used up its 0\.2s of Gemini time; cancelled/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("gives up after the total limit with a timed trace, and closes PayPal's MCP server", async () => {
    h.replies[MAIN] = [{ ms: 5, error: busy503() }];
    h.replies[BACKUP] = [{ ms: Infinity, text: "never" }]; // its 1 s budget is longer than the 0.3 s total
    const started = Date.now();
    const error = await failure(askDealDesk("deal-1", "How much is still held?", { ...LIMITS, totalMs: 300 }));

    expect(error.code).toBe("timeout");
    expect(error.message).toBe("The Deal Desk did not answer within 0.3s. Try again in a minute.");
    expect(error.trace.at(-1)).toMatch(/gave up: no answer within 0\.3s$/);
    expect(Date.now() - started).toBeLessThan(1_000);
    await vi.waitFor(() => expect(h.mcp.closed).toBe(1));
  });

  it("reports Gemini as busy when every model is busy", async () => {
    h.replies[MAIN] = [{ ms: 5, error: busy503() }];
    h.replies[BACKUP] = [{ ms: 5, error: busy503() }];
    const error = await failure(askDealDesk("deal-1", "How much is still held?", LIMITS));

    expect(error.code).toBe("gemini_busy");
    expect(error.message).toContain("Gemini service is busy");
    expect(h.mcp.closed).toBe(1);
  });

  it("reports any other error at once, with the trace", async () => {
    h.replies[MAIN] = [{ ms: 5, error: new Error("API key not valid. Please pass a valid API key.") }];
    const error = await failure(askDealDesk("deal-1", "How much is still held?", LIMITS));

    expect(error.code).toBe("failed");
    expect(error.message).toBe("API key not valid. Please pass a valid API key.");
    expect(error.trace.at(-1)).toMatch(/failed: API key not valid/);
    expect(h.requests[BACKUP]).toBeUndefined();
  });
});
