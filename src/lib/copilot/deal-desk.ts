/**
 * Deal Desk copilot: answers questions about one deal.
 *
 * Gemini gets PayPal tools through PayPal's official MCP server (@paypal/mcp)
 * started with READ-ONLY tools only (orders.get, transactions.list,
 * invoices.list), plus a tool over Tranche's own records. It cannot capture,
 * pay out, refund or create anything: money moves only through the Spend
 * Firewall. The MCP server runs as a separate npx process because it pins
 * older `ai`/`zod` majors than this app.
 *
 * Time limits (DEAL_DESK_LIMITS) keep a question from spinning for minutes:
 *  - PayPal's MCP server has mcpStartMs to start (its first run downloads it
 *    with npx). If it doesn't start, Gemini answers from Tranche's records.
 *  - Each PayPal call has paypalToolMs. A slower call reaches Gemini as a tool
 *    error, and Gemini answers without it.
 *  - A busy model (Google's 503 "high demand" or a 429 rate limit) is retried
 *    up to 3 times with backoff (2, 4, 8 s) before the next model is tried.
 *  - Each model has modelBudgetMs of Gemini time per question (the last model
 *    in the chain gets lastModelBudgetMs). Only Gemini's own requests count,
 *    not the PayPal calls between them. A model that uses it up is cancelled
 *    and the question restarts on the next model; a model that was busy or
 *    cut off is tried last for the next demoteMs. When the last model is cut
 *    off too, the question ends with "Gemini is busy" instead of spinning.
 *  - The whole question has totalMs.
 * Every step is timed in a trace that is logged as [deal-desk] and returned
 * with the answer or the error.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { z } from "zod";
import { gemini } from "@/lib/ai/provider";
import { describeGeminiError, GeminiBusyError, GeminiSlowError, geminiModelChain, isGeminiBusy, withModelFailover } from "@/lib/ai/models";
import { env } from "@/lib/env";
import { getAccessToken } from "@/lib/paypal/client";
import { loadDealView } from "@/lib/engine/deal-view";

const READ_ONLY_TOOLS = ["orders.get", "transactions.list", "invoices.list"].join(",");
const PAYPAL_MCP = "@paypal/mcp@1.8.1";

export interface DealDeskLimits {
  /** Starting PayPal's MCP server, including npx's one-time download of about 250 packages. */
  mcpStartMs: number;
  /** One PayPal call through MCP. */
  paypalToolMs: number;
  /** Gemini time per model per question (PayPal calls excluded) before switching to the next model. */
  modelBudgetMs: number;
  /** The same for the last model in the chain, which has nothing to fall back to. */
  lastModelBudgetMs: number;
  /** The whole question. */
  totalMs: number;
  /** How long a model that was cut off is tried last. */
  demoteMs: number;
}

export const DEAL_DESK_LIMITS: DealDeskLimits = {
  mcpStartMs: 90_000,
  paypalToolMs: 15_000,
  modelBudgetMs: 25_000,
  lastModelBudgetMs: 45_000,
  totalMs: 150_000,
  demoteMs: 10 * 60_000,
};

export interface DealDeskAnswer {
  answer: string;
  /** The Gemini model that wrote the answer. */
  model: string;
  /** Tools Gemini called, in order. */
  toolCalls: string[];
  /** Timed steps, e.g. "+4.1s gemini-3.6-flash: request 1 answered in 3.2s (asked for get_order; …)". */
  trace: string[];
}

export class DealDeskError extends Error {
  constructor(
    message: string,
    readonly code: "timeout" | "gemini_busy" | "failed",
    readonly trace: string[],
  ) {
    super(message);
    this.name = "DealDeskError";
  }
}

/** Models that were cut off for a recent question, and until when they are tried last. */
const demotedUntil = new Map<string, number>();

/** The models to try for the next question: the configured chain, with recently cut-off models moved to the end. */
export function deskModelChain(now = Date.now()): string[] {
  const chain = geminiModelChain();
  const demoted = (m: string) => (demotedUntil.get(m) ?? 0) > now;
  return [...chain.filter((m) => !demoted(m)), ...chain.filter(demoted)];
}

/** Forgets which models were cut off (for tests). */
export function resetDealDeskState(): void {
  demotedUntil.clear();
}

export async function askDealDesk(dealId: string, question: string, limits: DealDeskLimits = DEAL_DESK_LIMITS): Promise<DealDeskAnswer> {
  const trace = new Trace();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), limits.totalMs);
  const work = answer(dealId, question, limits, trace, deadline.signal);
  try {
    return await Promise.race([work, whenAborted(deadline.signal)]);
  } catch (e) {
    if (deadline.signal.aborted) {
      trace.log(`gave up: no answer within ${seconds(limits.totalMs)}`);
      throw new DealDeskError(`The Deal Desk did not answer within ${seconds(limits.totalMs)}. Try again in a minute.`, "timeout", trace.lines);
    }
    if (e instanceof GeminiBusyError) {
      trace.log(e.message);
      throw new DealDeskError(e.message, "gemini_busy", trace.lines);
    }
    trace.log(`failed: ${errorMessage(e)}`);
    throw new DealDeskError(errorMessage(e), "failed", trace.lines);
  } finally {
    clearTimeout(timer);
    deadline.abort(); // cancels whatever is still running after an error
    work.catch(() => {}); // its outcome no longer matters
  }
}

async function answer(dealId: string, question: string, limits: DealDeskLimits, trace: Trace, deadline: AbortSignal): Promise<DealDeskAnswer> {
  const view = await loadDealView(dealId);
  if (!view) throw new Error("Deal not found");
  trace.log("deal loaded");

  let mcp: MCPClient | undefined;
  let paypalTools: ToolSet = {};
  try {
    trace.log(`starting PayPal's MCP server (npx ${PAYPAL_MCP})`);
    mcp = await startPayPalMcp(limits, deadline);
    paypalTools = await mcp.tools();
    trace.log(`PayPal MCP ready: ${Object.keys(paypalTools).join(", ") || "no tools"}`);
  } catch (e) {
    if (deadline.aborted) throw e;
    trace.log(`PayPal MCP unavailable (${errorMessage(e)}); answering from Tranche's records only`);
    await mcp?.close().catch(() => {});
    mcp = undefined;
    paypalTools = {};
  }

  try {
    const tools: ToolSet = {
      ...paypalTools,
      get_tranche_ledger: tool({
        description: "Tranche's records for this deal: contract, tranche statuses, evidence audits with timestamp citations, Spend Firewall decisions with every rule, the PayPal ledger and the timeline.",
        inputSchema: z.object({}),
        execute: async () => view,
      }),
    };
    const system = systemPrompt(view.deal, Object.keys(paypalTools).length > 0);

    const chain = deskModelChain();
    const demoted = chain.filter((m) => (demotedUntil.get(m) ?? 0) > Date.now());
    if (demoted.length > 0) trace.log(`${demoted.join(", ")} was busy or too slow on a recent question; trying ${chain[0]} first`);

    const { result, model } = await withModelFailover(
      (modelId, signal) =>
        runModel({
          modelId,
          // The last model gets longer, since nothing comes after it, but not forever: a stalled
          // model would otherwise hold the question until totalMs.
          budgetMs: modelId === chain.at(-1) ? limits.lastModelBudgetMs : limits.modelBudgetMs,
          signal: AbortSignal.any([signal, deadline]),
          tools,
          system,
          question,
          limits,
          trace,
        }),
      // Slowness is judged by Gemini time inside runModel; this outer limit only backs up the deadline.
      { timeoutMs: limits.totalMs, models: chain },
    );

    const cutOff = chain.slice(0, chain.indexOf(model));
    for (const m of cutOff) demotedUntil.set(m, Date.now() + limits.demoteMs);
    demotedUntil.delete(model);
    trace.log(`answered by ${model}${cutOff.length > 0 ? `; ${cutOff.join(", ")} will be tried last for the next ${minutes(limits.demoteMs)}` : ""}`);
    return {
      answer: result.text,
      model,
      toolCalls: result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)),
      trace: trace.lines,
    };
  } finally {
    await mcp?.close().catch(() => {});
  }
}

interface RunModelArgs {
  modelId: string;
  budgetMs: number;
  signal: AbortSignal;
  tools: ToolSet;
  system: string;
  question: string;
  limits: DealDeskLimits;
  trace: Trace;
}

/** One full tool-using answer from one model, cancelled if the model uses up its Gemini time. */
async function runModel({ modelId, budgetMs, signal, tools, system, question, limits, trace }: RunModelArgs) {
  const budget = new GeminiTimeBudget(modelId, budgetMs);
  let request = 0;
  try {
    return await generateText({
      model: gemini(modelId),
      abortSignal: AbortSignal.any([signal, budget.signal]),
      system,
      prompt: question.slice(0, 1000),
      tools,
      stopWhen: stepCountIs(6),
      // Each tool call (in practice: each PayPal call) is cancelled after paypalToolMs and reaches Gemini as a tool error.
      timeout: { toolMs: limits.paypalToolMs },
      // Default temperature: Gemini 3 is tuned for 1.0 and can loop at lower values.
      providerOptions: { google: { thinkingConfig: { thinkingLevel: env().GEMINI_THINKING_LEVEL } } },
      // Google's 503 "high demand" usually clears within seconds: retry the same model (after 2, 4
      // and 8 s) before restarting the whole question on another model.
      maxRetries: 3,
      onLanguageModelCallStart: () => {
        request += 1;
        budget.start();
        trace.log(`${modelId}: request ${request} sent`);
      },
      onLanguageModelCallEnd: (e) => {
        trace.log(`${modelId}: request ${request} answered in ${seconds(budget.stop())} (${describeCall(e)})`);
      },
      onToolExecutionStart: (e) => trace.log(`${e.toolCall.toolName}(${preview(e.toolCall.input)}) started`),
      onToolExecutionEnd: (e) => trace.log(describeToolEnd(e, limits.paypalToolMs)),
    });
  } catch (e) {
    if (budget.signal.aborted) {
      trace.log(`${modelId}: used up its ${seconds(budgetMs)} of Gemini time; cancelled`);
      throw budget.signal.reason; // a GeminiSlowError: withModelFailover moves on to the next model
    }
    if (isGeminiBusy(e)) trace.log(`${modelId}: busy after retries (${describeGeminiError(e)})`);
    throw e;
  } finally {
    budget.dispose();
  }
}

/**
 * Gemini time used by one model for one question, summed over its requests.
 * Tool calls between requests don't count. Past the budget, `signal` aborts
 * with a GeminiSlowError.
 */
class GeminiTimeBudget {
  private readonly controller = new AbortController();
  private usedMs = 0;
  private since: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly model: string,
    private readonly budgetMs: number,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** A request went to Gemini. */
  start(): void {
    if (this.since !== undefined) return;
    this.since = Date.now();
    if (Number.isFinite(this.budgetMs)) {
      this.timer = setTimeout(() => this.controller.abort(new GeminiSlowError(this.model, this.budgetMs)), Math.max(0, this.budgetMs - this.usedMs));
    }
  }

  /** Gemini answered. Returns how long that request took. */
  stop(): number {
    if (this.since === undefined) return 0;
    const ms = Date.now() - this.since;
    this.usedMs += ms;
    this.since = undefined;
    clearTimeout(this.timer);
    return ms;
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

function systemPrompt(deal: { authorizedOrderId: string | null; authorizationId: string | null }, paypalAvailable: boolean): string {
  return [
    "You are the Deal Desk for Tranche, an escrow service for creator sponsorships.",
    "Answer questions about ONE deal using the tools. Cite amounts, tranche numbers, video timestamps and firewall rule ids.",
    "You are read-only: you cannot move money, and you say so if asked.",
    "Start with get_tranche_ledger: it holds the contract, tranche states, audits, Spend Firewall decisions and every PayPal call with its id.",
    ...(paypalAvailable
      ? [
          "Use get_order to confirm PayPal's live view of the authorization and its captures.",
          "list_transactions searches PayPal's history one month at a time and is slow: use it only when asked about PayPal's transaction history.",
          "If a PayPal tool fails or times out, answer from get_tranche_ledger and say PayPal's live data was unavailable.",
        ]
      : ["PayPal's live tools are unavailable right now: answer from get_tranche_ledger and say so."]),
    `PayPal order id: ${deal.authorizedOrderId ?? "none"}. Authorization id: ${deal.authorizationId ?? "none"}.`,
  ].join("\n");
}

async function startPayPalMcp(limits: DealDeskLimits, deadline: AbortSignal): Promise<MCPClient> {
  const { command, args } = npxCommand(["-y", PAYPAL_MCP, `--tools=${READ_ONLY_TOOLS}`]);
  return createMCPClient({
    transport: new Experimental_StdioMCPTransport({
      command,
      args,
      env: {
        ...systemEnv(),
        PAYPAL_ACCESS_TOKEN: await getAccessToken(),
        PAYPAL_ENVIRONMENT: env().PAYPAL_ENV === "live" ? "PRODUCTION" : "SANDBOX",
      },
    }),
    // @paypal/mcp speaks the classic initialize handshake; skip the newer server/discover probe.
    protocolVersionDiscovery: false,
    // On timeout the client closes the transport, which stops the npx process.
    initializationOptions: { timeout: limits.mcpStartMs, signal: deadline },
    onUncaughtError: (e) => console.warn("[deal-desk] PayPal MCP:", errorMessage(e)),
  });
}

/**
 * Windows cannot spawn `npx` (a .cmd shim) without a shell, so run npm's
 * npx-cli.js with the current Node binary instead. Elsewhere, plain npx.
 */
function npxCommand(args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command: "npx", args };
  const npxCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  return { command: process.execPath, args: [npxCli, ...args] };
}

/** Only what npm needs to run — never this app's own secrets. */
function systemEnv(): Record<string, string> {
  const keep = ["PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "TEMP", "TMP", "ComSpec", "PATHEXT"];
  return Object.fromEntries(keep.flatMap((k) => (process.env[k] ? [[k, process.env[k] as string]] : [])));
}

/** Timestamped steps for one question, logged as they happen. */
class Trace {
  readonly lines: string[] = [];
  private readonly started = Date.now();
  private readonly id = randomUUID().slice(0, 4);

  log(message: string): void {
    const line = `+${((Date.now() - this.started) / 1000).toFixed(1)}s ${message}`;
    this.lines.push(line);
    console.info(`[deal-desk ${this.id}] ${line}`);
  }
}

function describeCall(e: { finishReason: string; content: ReadonlyArray<{ type: string }>; usage: { inputTokens: number | undefined; outputTokens: number | undefined } }): string {
  const asked = e.content.flatMap((p) => (p.type === "tool-call" && "toolName" in p ? [String(p.toolName)] : []));
  const what = asked.length > 0 ? `asked for ${asked.join(", ")}` : e.finishReason === "stop" ? "final answer" : `finished: ${e.finishReason}`;
  return `${what}; ${e.usage.inputTokens ?? "?"} tokens in, ${e.usage.outputTokens ?? "?"} out`;
}

function describeToolEnd(e: { toolCall: { toolName: string }; toolExecutionMs: number; toolOutput: { type: string } }, limitMs: number): string {
  const name = e.toolCall.toolName;
  const took = seconds(e.toolExecutionMs);
  if (e.toolOutput.type !== "tool-error") return `${name} finished in ${took}`;
  const error = "error" in e.toolOutput ? e.toolOutput.error : undefined;
  return isTimeout(error) ? `${name} timed out after ${took} (limit ${seconds(limitMs)})` : `${name} failed after ${took}: ${errorMessage(error)}`;
}

/** True for the AI SDK's tool time limit (an AbortSignal.timeout), possibly wrapped by the MCP client. */
function isTimeout(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 3) return false;
  if ((error as { name?: unknown }).name === "TimeoutError") return true;
  return isTimeout((error as { cause?: unknown }).cause, depth + 1);
}

function whenAborted(signal: AbortSignal): Promise<never> {
  const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  aborted.catch(() => {}); // the race above handles it; later aborts are expected
  return aborted;
}

function preview(input: unknown): string {
  const text = JSON.stringify(input ?? {});
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const seconds = (ms: number) => `${Number((ms / 1000).toFixed(1))}s`;
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;
