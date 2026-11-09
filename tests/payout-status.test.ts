import { describe, expect, it } from "vitest";
import { isPayoutFinal, isPayoutProblem, payoutStatusLabel, payoutStatusOf } from "@/lib/paypal/payout-status";

describe("PayPal payout status", () => {
  it("keeps re-checking until PayPal reports a final status", () => {
    for (const s of ["PENDING", "PROCESSING", "UNCLAIMED", "ONHOLD", null, undefined]) expect(isPayoutFinal(s)).toBe(false);
    for (const s of ["SUCCESS", "FAILED", "RETURNED", "REFUNDED", "REVERSED", "BLOCKED", "DENIED", "CANCELED", "success"]) expect(isPayoutFinal(s)).toBe(true);
  });

  it("prefers the item's transaction_status over the batch status", () => {
    // A batch can finish while its single item is still unclaimed by the receiver.
    expect(payoutStatusOf({ batch_header: { batch_status: "SUCCESS" }, items: [{ transaction_status: "UNCLAIMED" }] })).toBe("UNCLAIMED");
    expect(payoutStatusOf({ batch_header: { batch_status: "PENDING" } })).toBe("PENDING");
    expect(payoutStatusOf({})).toBeNull();
  });

  it("labels statuses in plain language for the dashboard", () => {
    expect(payoutStatusLabel("SUCCESS")).toBe("completed");
    expect(payoutStatusLabel("PENDING")).toBe("pending");
    expect(payoutStatusLabel("PROCESSING")).toBe("pending");
    expect(payoutStatusLabel(null)).toBe("pending");
    expect(payoutStatusLabel("UNCLAIMED")).toMatch(/^unclaimed/);
    expect(payoutStatusLabel("RETURNED")).toBe("returned unclaimed");
  });

  it("flags final statuses where the creator did not get the money", () => {
    expect(isPayoutProblem("SUCCESS")).toBe(false);
    expect(isPayoutProblem("PENDING")).toBe(false);
    for (const s of ["FAILED", "RETURNED", "BLOCKED", "DENIED"]) expect(isPayoutProblem(s)).toBe(true);
  });
});
