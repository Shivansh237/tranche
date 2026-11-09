"use client";

/** Return URL for the redirect approval flow: authorizes the order, then opens the deal. */
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function ReturnFromPayPal(props: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string }> }) {
  const { id } = use(props.params);
  const { token: orderId } = use(props.searchParams);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orderId) {
      setError("PayPal did not return an order id.");
      return;
    }
    fetch("/api/paypal/on-approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealId: id, orderId }),
    })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.issue ?? json.message ?? json.error);
        router.replace(`/deals/${id}`);
      })
      .catch((e: Error) => setError(e.message));
  }, [id, orderId, router]);

  return (
    <div className="max-w-md">
      {error ? (
        <>
          <h1 className="text-xl font-semibold">PayPal didn&apos;t authorize the funds</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <Link className="mt-4 inline-block text-sm font-semibold underline" href={`/deals/${id}`}>
            Open the deal
          </Link>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Authorizing your funds with PayPal…</p>
      )}
    </div>
  );
}
