"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { EscrowBar } from "@/components/escrow-bar";
import { PayPalAuthorizeButton } from "@/components/paypal-button";
import { useElapsedSeconds } from "@/components/use-elapsed";
import type { DealContract } from "@/lib/contracts/deal-contract";

const SAMPLE = `Lumen Skincare pays $600 for one YouTube video about the Glow Serum.
$400 when the video goes live with at least 30 seconds focused on the Glow Serum, the words "Glow Serum" said on camera, and a clear #ad disclosure. The video must be published within 7 days.
$200 bonus if the video reaches 10,000 views within 14 days.`;

const TYPE_LABEL: Record<string, string> = {
  PUBLISH_VERIFIED: "When the video goes live",
  VIEW_MILESTONE: "View milestone",
  RETENTION_ACTIVE: "Stays public",
};

/** Headline for each error the compile route can return; anything else is a contract problem. */
const ERROR_TITLE: Record<string, string> = {
  gemini_busy: "Gemini is busy right now",
  compile_failed: "Gemini couldn't compile the contract",
  channel_not_found: "That YouTube channel wasn't found",
};

interface Compiled {
  dealId: string;
  contract: DealContract;
  contractHash: string;
  ambiguities: string[];
}

export default function NewDealPage() {
  const router = useRouter();
  const [terms, setTerms] = useState(SAMPLE);
  const [creator, setCreator] = useState("");
  const [channel, setChannel] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [errorTitle, setErrorTitle] = useState("");
  const [compiled, setCompiled] = useState<Compiled | null>(null);
  const [fundError, setFundError] = useState<string | null>(null);
  const elapsed = useElapsedSeconds(busy);

  async function compile(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors([]);
    const res = await fetch("/api/deals/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ terms, creatorPayPalId: creator, youtubeChannel: channel, dealId: compiled?.dealId }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setErrorTitle(ERROR_TITLE[json.error as string] ?? "The contract needs a fix before it can be funded");
      return setErrors(json.issues ?? [json.error ?? "Compilation failed"]);
    }
    setCompiled(json as Compiled);
  }

  const onApproved = useCallback(() => {
    if (compiled) router.push(`/deals/${compiled.dealId}?funded=1`);
  }, [compiled, router]);
  const onFundError = useCallback((m: string) => setFundError(m), []);

  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
      <form onSubmit={compile} className="min-w-0 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Write the deal</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            Describe it the way you would in an email. Gemini turns it into tranches; you check them before any money is held.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="terms">Deal terms</Label>
          <Textarea id="terms" value={terms} onChange={(e) => setTerms(e.target.value)} className="min-h-[210px] text-[15px]" required />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="creator">Creator&apos;s PayPal email</Label>
            <Input id="creator" type="email" placeholder="sb-creator@personal.example.com" value={creator} onChange={(e) => setCreator(e.target.value)} required />
            <p className="text-xs text-muted-foreground">The only account this deal can ever pay.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="channel">Creator&apos;s YouTube channel</Label>
            <Input id="channel" placeholder="@handle or channel URL" value={channel} onChange={(e) => setChannel(e.target.value)} required />
            <p className="text-xs text-muted-foreground">Only videos from this channel count.</p>
          </div>
        </div>

        {errors.length > 0 && (
          <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <p className="font-semibold">{errorTitle}</p>
            <ul className="mt-1 list-disc pl-5">
              {errors.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        )}

        <Button type="submit" size="lg" disabled={busy}>
          {busy ? <span className="tabular-nums">Compiling with Gemini…{elapsed > 0 && ` ${elapsed}s`}</span> : compiled ? "Recompile contract" : "Compile contract"}
        </Button>
      </form>

      <section aria-live="polite" className="min-w-0 lg:pt-1">
        {!compiled ? (
          <div className="flex h-full min-h-[320px] flex-col justify-center rounded-lg border border-dashed p-8 text-sm text-muted-foreground">
            <p className="font-semibold text-foreground">The contract appears here</p>
            <p className="mt-1 max-w-sm leading-relaxed">Each tranche shows its amount and the rules a video must pass. Nothing is charged until the brand approves on PayPal.</p>
          </div>
        ) : (
          <div className="space-y-6 rounded-lg border bg-card p-6">
            <div>
              <h2 className="text-xl font-bold tracking-tight">{compiled.contract.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {compiled.contract.brandName} sponsors {compiled.contract.productName}
              </p>
            </div>

            <EscrowBar
              segments={compiled.contract.tranches.map((t) => ({ key: String(t.index), label: t.label, amount: (t.amountCents / 100).toFixed(2), status: "PENDING" }))}
            />

            <ol className="space-y-4">
              {compiled.contract.tranches.map((t) => (
                <li key={t.index} className="border-l-2 border-held/40 pl-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-semibold">{t.label}</span>
                    <span className="font-semibold tabular-nums">${(t.amountCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
                  </div>
                  <p className="text-sm text-muted-foreground">{TYPE_LABEL[t.type]}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {t.type === "PUBLISH_VERIFIED" && (
                      <>
                        {t.conditions.minDurationSec > 0 && <Badge variant="outline">{t.conditions.minDurationSec}s on the product</Badge>}
                        {t.conditions.requireAdDisclosure && <Badge variant="outline">#ad disclosure</Badge>}
                        {t.conditions.targetKeyword && <Badge variant="outline">Says &ldquo;{t.conditions.targetKeyword}&rdquo;</Badge>}
                        <Badge variant="outline">Publish within {t.conditions.deadlineDays} days</Badge>
                      </>
                    )}
                    {t.type === "VIEW_MILESTONE" && (
                      <>
                        <Badge variant="outline">{t.conditions.minViews.toLocaleString("en-US")} views</Badge>
                        <Badge variant="outline">Within {t.conditions.deadlineDays} days</Badge>
                      </>
                    )}
                    {t.type === "RETENTION_ACTIVE" && <Badge variant="outline">Public for {t.conditions.deadlineDays} days</Badge>}
                  </div>
                </li>
              ))}
            </ol>

            {compiled.ambiguities.length > 0 && (
              <div className="rounded-md bg-warning/10 p-3 text-sm">
                <p className="font-semibold">Gemini made these assumptions</p>
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  {compiled.ambiguities.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Contract fingerprint <span className="font-code text-foreground">{compiled.contractHash.slice(0, 16)}</span>
            </p>

            <div className="space-y-2 border-t pt-5">
              <h3 className="font-semibold">Hold ${(compiled.contract.totalBudgetCents / 100).toLocaleString("en-US")} in escrow</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                PayPal authorizes the full amount on the brand&apos;s account. Each tranche is captured only when its video passes.
              </p>
              <PayPalAuthorizeButton dealId={compiled.dealId} onApproved={onApproved} onError={onFundError} />
              {fundError && (
                <p role="alert" className="text-sm text-destructive">
                  {fundError}
                </p>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
