import Link from "next/link";
import { desc } from "drizzle-orm";
import { db, schema } from "@/db/client";
import { Button } from "@/components/ui/button";
import { DealStatusBadge } from "@/components/status-badge";
import { EscrowBar } from "@/components/escrow-bar";
import { formatUsd, toCents } from "@/lib/util/money";

export const dynamic = "force-dynamic";

export default async function Home() {
  const deals = await db().select().from(schema.deals).orderBy(desc(schema.deals.createdAt)).limit(25);
  const tranches = deals.length ? await db().select().from(schema.tranches) : [];

  return (
    <div className="space-y-10">
      <section className="max-w-2xl">
        <h1 className="text-[2.15rem] font-bold leading-[1.1] tracking-tight sm:text-[2.6rem]">Sponsorships that pay the moment the video checks out.</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-muted-foreground">
          The brand funds the deal once on PayPal. Tranche watches the creator&apos;s channel, has Gemini audit the video against the contract, and
          releases each tranche only when every rule passes. If something&apos;s missing, the money stays held and both sides see the exact second why.
        </p>
        <Button asChild size="lg" className="mt-6">
          <Link href="/deals/new">Write a deal</Link>
        </Button>
      </section>

      <section aria-labelledby="deals-heading">
        <h2 id="deals-heading" className="text-lg font-semibold">
          Deals
        </h2>
        {deals.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No deals yet. Write one in plain English and fund it with PayPal sandbox.</p>
        ) : (
          <ul className="mt-3 divide-y rounded-lg border bg-card">
            {deals.map((d) => {
              const segs = tranches
                .filter((t) => t.dealId === d.id)
                .sort((a, b) => a.trancheIndex - b.trancheIndex)
                .map((t) => ({ key: t.id, label: t.label, amount: t.amount, status: t.status }));
              return (
                <li key={d.id}>
                  <Link href={`/deals/${d.id}`} className="grid gap-3 px-4 py-4 hover:bg-accent/50 sm:grid-cols-[1fr_220px_auto] sm:items-center">
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{d.title}</div>
                      <div className="truncate text-sm text-muted-foreground">
                        {d.brandName} to {d.creatorPaypalId}
                      </div>
                    </div>
                    <div>
                      <EscrowBar segments={segs} size="sm" />
                      <div className="mt-1 text-xs tabular-nums text-muted-foreground">
                        {formatUsd(toCents(d.capturedTotal))} of {formatUsd(toCents(d.totalBudget))} released
                      </div>
                    </div>
                    <DealStatusBadge status={d.status} />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
