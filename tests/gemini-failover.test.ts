import { describe, expect, it } from "vitest";
import { describeGeminiError, GeminiBusyError, isGeminiBusy, withModelFailover } from "@/lib/ai/models";

const MODELS = ["gemini-3.8-flash", "gemini-3.6-flash"];
const LIMIT = 60; // ms: stands in for the real 40 s limit

/** Answers `value` after `ms`, or rejects as soon as the signal is aborted (like a real fetch). */
function answerAfter<T>(ms: number, value: T, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(value), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });
}

const busy503 = Object.assign(new Error("This model is currently experiencing high demand. Spikes in demand are usually temporary."), { statusCode: 503 });

describe("Gemini failover: slow models", () => {
  it("keeps the main model's answer when it answers within the limit", async () => {
    const out = await withModelFailover((model, signal) => answerAfter(5, `answer from ${model}`, signal), { timeoutMs: LIMIT, models: MODELS });
    expect(out).toEqual({ result: "answer from gemini-3.8-flash", model: "gemini-3.8-flash" });
  });

  it("switches to the backup when the main model is slower than the limit, and cancels the slow request", async () => {
    const signals: Record<string, AbortSignal> = {};
    const started = Date.now();
    const out = await withModelFailover(
      (model, signal) => {
        signals[model] = signal;
        return answerAfter(model === "gemini-3.8-flash" ? 5_000 : 5, `answer from ${model}`, signal);
      },
      { timeoutMs: LIMIT, models: MODELS },
    );
    expect(out.model).toBe("gemini-3.6-flash");
    expect(out.result).toBe("answer from gemini-3.6-flash");
    expect(signals["gemini-3.8-flash"]!.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000); // did not wait for the slow model
  });

  it("never cuts off the last model: a slow backup still answers", async () => {
    const out = await withModelFailover(
      (model, signal) => answerAfter(model === "gemini-3.8-flash" ? 5_000 : LIMIT * 3, `answer from ${model}`, signal),
      { timeoutMs: LIMIT, models: MODELS },
    );
    expect(out.model).toBe("gemini-3.6-flash");
  });

  it("applies no limit when only one model is configured", async () => {
    const out = await withModelFailover((model, signal) => answerAfter(LIMIT * 3, model, signal), { timeoutMs: LIMIT, models: ["gemini-3.8-flash"] });
    expect(out.model).toBe("gemini-3.8-flash");
  });

  it("still waits correctly even if an SDK ignores the cancel signal", async () => {
    const out = await withModelFailover(
      (model) => new Promise<string>((resolve) => setTimeout(() => resolve(model), model === "gemini-3.8-flash" ? 5_000 : 5)),
      { timeoutMs: LIMIT, models: MODELS },
    );
    expect(out.model).toBe("gemini-3.6-flash");
  });
});

describe("Gemini failover: busy and other errors", () => {
  it("switches to the backup when the main model reports high demand", async () => {
    const out = await withModelFailover(
      async (model) => {
        if (model === "gemini-3.8-flash") throw busy503;
        return "ok";
      },
      { timeoutMs: LIMIT, models: MODELS },
    );
    expect(out.model).toBe("gemini-3.6-flash");
  });

  it("throws GeminiBusyError naming both models when the main model is slow and the backup is busy", async () => {
    await expect(
      withModelFailover(
        (model, signal) => (model === "gemini-3.8-flash" ? answerAfter(5_000, "late", signal) : Promise.reject(busy503)),
        { timeoutMs: LIMIT, models: MODELS },
      ),
    ).rejects.toThrow(GeminiBusyError);
  });

  it("does not try the backup for errors a different model cannot fix", async () => {
    const tried: string[] = [];
    await expect(
      withModelFailover(
        async (model) => {
          tried.push(model);
          throw Object.assign(new Error("API key not valid. Please pass a valid API key."), { status: 400 });
        },
        { timeoutMs: LIMIT, models: MODELS },
      ),
    ).rejects.toThrow("API key not valid");
    expect(tried).toEqual(["gemini-3.8-flash"]);
  });

  it("tells capacity errors apart from video errors", () => {
    expect(isGeminiBusy(busy503)).toBe(true);
    expect(isGeminiBusy({ status: 429, message: "Resource has been exhausted" })).toBe(true);
    expect(isGeminiBusy({ lastError: busy503, errors: [busy503] })).toBe(true);
    expect(isGeminiBusy({ status: 400, message: '{"error":{"code":400,"message":"Video is not accessible (unlisted, private or unavailable)","status":"INVALID_ARGUMENT"}}' })).toBe(false);
    expect(isGeminiBusy(new TypeError("fetch failed"))).toBe(false);
  });
});

describe("describeGeminiError: Google's reason in one log line", () => {
  it("shows the quota and the wait for a 429 rate limit, from the AI SDK's last retry", () => {
    const quota = Object.assign(
      new Error(
        "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.6-flash\nPlease retry in 31.2s.",
      ),
      { statusCode: 429 },
    );
    const retryError = Object.assign(new Error("Failed after 4 attempts. Last error: You exceeded your current quota"), { lastError: quota, errors: [quota] });
    expect(describeGeminiError(retryError)).toBe("429: Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10; retry in 31.2s");
  });

  it("shows Google's message for a 503", () => {
    expect(describeGeminiError(busy503)).toBe("503: This model is currently experiencing high demand. Spikes in demand are usually temporary.");
  });

  it("reads @google/genai's status field and shortens long messages", () => {
    const long = Object.assign(new Error(`{"error":{"code":503,"status":"UNAVAILABLE","message":"${"overloaded ".repeat(40)}"}}`), { status: 503 });
    const text = describeGeminiError(long);
    expect(text.startsWith('503: {"error":{"code":503')).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(206);
  });

  it("copes with errors that aren't Error objects", () => {
    expect(describeGeminiError("socket hang up")).toBe("socket hang up");
  });
});
