"use client";

/**
 * PayPal JS SDK (v5) button with intent=authorize. createOrder asks our
 * server for an AUTHORIZE order; onApprove sends the order id back so the
 * server authorizes it (funds held, not captured). The brand can also
 * approve on PayPal's own site (redirect flow): offered as a link under the
 * buttons, and as the only option when the SDK can't load.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

declare global {
  interface Window {
    paypal?: {
      Buttons: (opts: {
        style?: Record<string, string | number>;
        createOrder: () => Promise<string>;
        onApprove: (data: { orderID: string }) => Promise<void>;
        onError?: (err: unknown) => void;
        onCancel?: () => void;
      }) => { render: (el: HTMLElement) => Promise<void>; isEligible?: () => boolean };
    };
  }
}

const CLIENT_ID = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? "";

export function PayPalAuthorizeButton({
  dealId,
  onApproved,
  onError,
}: {
  dealId: string;
  onApproved: () => void;
  onError: (message: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [sdkState, setSdkState] = useState<"loading" | "ready" | "failed">(CLIENT_ID ? "loading" : "failed");
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    if (!CLIENT_ID || !ref.current) return;
    let cancelled = false;
    const render = () => {
      if (cancelled || !window.paypal || !ref.current) return;
      ref.current.innerHTML = "";
      window.paypal
        .Buttons({
          style: { layout: "vertical", color: "blue", shape: "rect", label: "paypal", height: 44 },
          createOrder: async () => {
            const res = await fetch("/api/paypal/create-order", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ dealId, flow: "buttons" }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json.issue ?? json.error ?? "Could not create the PayPal order");
            return json.orderId as string;
          },
          onApprove: async ({ orderID }) => {
            const res = await fetch("/api/paypal/on-approve", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ dealId, orderId: orderID }),
            });
            const json = await res.json();
            if (!res.ok) return onError(json.issue ?? json.message ?? json.error ?? "PayPal could not authorize the order");
            onApproved();
          },
          onError: (err) => onError(err instanceof Error ? err.message : "PayPal reported an error"),
        })
        .render(ref.current)
        .then(() => !cancelled && setSdkState("ready"))
        .catch(() => !cancelled && setSdkState("failed"));
    };

    const src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(CLIENT_ID)}&currency=USD&intent=authorize&components=buttons`;
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing && window.paypal) render();
    else {
      const script = existing ?? document.createElement("script");
      script.src = src;
      script.async = true;
      script.addEventListener("load", render);
      script.addEventListener("error", () => !cancelled && setSdkState("failed"));
      if (!existing) document.body.appendChild(script);
    }
    return () => {
      cancelled = true;
    };
  }, [dealId, onApproved, onError]);

  async function approveOnPayPal() {
    setRedirecting(true);
    const res = await fetch("/api/paypal/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealId, flow: "redirect" }),
    });
    const json = await res.json();
    if (!res.ok || !json.approveUrl) {
      setRedirecting(false);
      return onError(json.issue ?? json.error ?? "Could not create the PayPal order");
    }
    window.location.href = json.approveUrl;
  }

  return (
    <div className="space-y-3">
      <div ref={ref} className={sdkState === "failed" ? "hidden" : "min-h-[44px]"} />
      {sdkState === "loading" && <p className="text-sm text-muted-foreground">Loading PayPal…</p>}
      {sdkState === "ready" && (
        // Embedded browsers and strict cookie settings can break PayPal's in-page window;
        // a full-page approval on PayPal's own site always works and returns here afterwards.
        <button
          type="button"
          onClick={approveOnPayPal}
          disabled={redirecting}
          className="w-full text-center text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-60"
        >
          {redirecting ? "Opening PayPal…" : "PayPal window not working? Approve on PayPal's website instead"}
        </button>
      )}
      {sdkState === "failed" && (
        <Button className="w-full" size="lg" onClick={approveOnPayPal} disabled={redirecting}>
          {redirecting ? "Opening PayPal…" : "Approve on PayPal"}
        </Button>
      )}
    </div>
  );
}
