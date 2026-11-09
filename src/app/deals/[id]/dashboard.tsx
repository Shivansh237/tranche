"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, ExternalLink, LoaderCircle, X } from "lucide-react";
import type { DealViewJson } from "@/lib/engine/deal-view";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useElapsedSeconds } from "@/components/use-elapsed";
import { LocalTime } from "@/components/local-time";
import { payoutStatusLabel } from "@/lib/paypal/payout-status";
import { DealStatusBadge, TrancheStatusBadge } from "@/components/status-badge";
import { EscrowBar } from "@/components/escrow-bar";
import { EvidenceScrubber } from "@/components/evidence-scrubber";
import { cn } from "@/lib/utils";

const STEP_LABEL: Record<string, string> = {
  UPLOAD_DETECTED: "Upload detected",
  MULTIMODAL_ANALYSIS: "Multimodal analysis",
  FIREWALL_EVALUATION: "Firewall evaluation",
  CAPTURE: "Capture",
  PAYOUT: "Payout",
  REFUSED: "Money withheld",
  VOIDED: "Tranche voided",
  DEAL_CLOSED: "Deal closed",
};

const RULE_LABEL: Record<string, string> = {
  INTENT_SCHEMA: "Intent is well formed",
  KILL_SWITCH: "Payments enabled",
  INTENT_BINDING: "Names this deal and tranche",
  PAYEE_ALLOWLIST: "Payee is the contract creator",
  CURRENCY_MATCH: "Currency matches",
  AMOUNT_EXACT: "Exact contract amount",
  BUDGET_CAP: "Within the authorized budget",
  IDEMPOTENCY_KEY_VALID: "PayPal-Request-Id is the derived key",
  IDEMPOTENCY_NOT_REPLAYED: "PayPal-Request-Id never used before",
  DEPENDENCY_SATISFIED: "Earlier tranche paid out",
  EVIDENCE_BINDING: "Evidence matches the stored audit",
  CHANNEL_MATCH: "Contracted channel",
  VIDEO_PUBLIC: "Video is public",
  AD_DISCLOSURE: "#ad disclosure",
  BRAND_SEGMENT_DURATION: "Brand segment length",
  KEYWORD_PRESENT: "Keyword said",
  VIEW_MILESTONE: "View milestone",
  RETENTION_PERIOD: "Retention period",
  CONFIDENCE_GATE: "Audit confidence",
  PUBLICATION_WINDOW: "Published inside the deal window",
  DEADLINE: "Before the deadline",
  EVIDENCE_FRESH: "Evidence is fresh",
};

const SOURCE_LABEL: Record<string, string> = {
  youtube_url: "Gemini watched the YouTube video",
  transcript: "Gemini read the transcript",
  metadata: "YouTube Data API",
};

const usd = (v: string | number | null) =>
  v === null ? "—" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usdCents = (c: number) => usd(c / 100);

/** A little longer than the Deal Desk's own 150 s limit (DEAL_DESK_LIMITS.totalMs), so the server's timed error arrives first. */
const ASK_TIMEOUT_MS = 170_000;

export function Dashboard({ initial, justFunded }: { initial: DealViewJson; justFunded: boolean }) {
  const [view, setView] = useState(initial);
  const [videoInput, setVideoInput] = useState("");
  const [transcript, setTranscript] = useState("");
  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);
  const auditSeconds = useElapsedSeconds(running);
  const [question, setQuestion] = useState("Why is each tranche in its current state, and how much is still held?");
  const [answer, setAnswer] = useState<string | null>(null);
  const [deskTrace, setDeskTrace] = useState<{ lines: string[]; model: string | null } | null>(null);
  const [asking, setAsking] = useState(false);
  const askSeconds = useElapsedSeconds(asking);
  const [auditIndex, setAuditIndex] = useState(0);

  const { deal, escrow, tranches, audits, decisions, ledger, timeline } = view;
  const active = deal.status === "AUTHORIZED" || deal.status === "IN_PROGRESS";

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/deals/${deal.id}`, { cache: "no-store" });
    if (res.ok) setView(await res.json());
  }, [deal.id]);

  useEffect(() => {
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  async function runAudit(e: React.FormEvent) {
    e.preventDefault();
    setRunning(true);
    setRunNote(null);
    const res = await fetch("/api/verify/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealId: deal.id, videoId: videoInput || undefined, transcript: transcript || undefined }),
    });
    const json = await res.json();
    setRunning(false);
    if (!res.ok) {
      setRunNote(json.error === "too_soon" ? "Give it a few seconds between audits." : (json.issues?.join(" ") ?? json.error ?? "The audit could not start."));
    } else {
      const notes = (json.outcomes as Array<{ trancheIndex: number; note: string }> | undefined)?.map((o) => `Tranche ${o.trancheIndex + 1}: ${o.note}`);
      setRunNote(json.skipped ?? (notes?.length ? notes.join("\n") : "Audit finished."));
      setAuditPinned(false);
    }
    refresh();
  }

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    setAsking(true);
    setAnswer(null);
    setDeskTrace(null);
    try {
      const res = await fetch("/api/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: deal.id, question }),
        signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
      });
      const json = await res.json().catch(() => ({}));
      // Timed steps (Gemini requests, PayPal calls) for anyone debugging a slow answer.
      if (Array.isArray(json.trace)) {
        const lines = (json.trace as unknown[]).filter((x): x is string => typeof x === "string");
        console.info(`[deal-desk] ${res.ok ? `answered by ${json.model}` : "failed"}\n${lines.join("\n")}`);
        setDeskTrace({ lines, model: res.ok && typeof json.model === "string" ? json.model : null });
      }
      setAnswer(res.ok ? json.answer : `The Deal Desk couldn't answer: ${json.message ?? json.error ?? `HTTP ${res.status}`}`);
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      setAnswer(timedOut ? "The Deal Desk didn't answer in time. Try again in a minute." : `The Deal Desk couldn't be reached: ${(err as Error).message}`);
    } finally {
      setAsking(false);
    }
  }

  const runs = useMemo(() => {
    const byRun = new Map<string, typeof timeline>();
    for (const ev of [...timeline].reverse()) byRun.set(ev.runId, [...(byRun.get(ev.runId) ?? []), ev]);
    return [...byRun.entries()].reverse();
  }, [timeline]);

  // Open on the newest video audit (the evidence people want to see), not a view-count check.
  const firstVideoAudit = Math.max(0, audits.findIndex((a) => a.source !== "metadata"));
  const [auditPinned, setAuditPinned] = useState(false);
  const shownIndex = auditPinned ? auditIndex : firstVideoAudit;
  const audit = audits[Math.min(shownIndex, Math.max(0, audits.length - 1))];
  const trancheName = (id: string | null) => {
    const t = tranches.find((x) => x.id === id);
    return t ? `Tranche ${t.trancheIndex + 1}` : "Deal";
  };

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight sm:text-[1.75rem]">{deal.title}</h1>
            <DealStatusBadge status={deal.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {deal.brandName} sponsors {deal.productName}. Pays only {deal.creatorPaypalId}.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          Contract <span className="font-code text-foreground">{deal.contractHash.slice(0, 16)}</span>
        </p>
      </header>

      {justFunded && deal.status === "AUTHORIZED" && (
        <p className="rounded-md border border-held/30 bg-held/10 px-4 py-3 text-sm">
          {usdCents(escrow.authorizedCents)} is held on the brand&apos;s PayPal account. Nothing is captured until a tranche passes the firewall.
        </p>
      )}

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
        {/* ---------------- Money ---------------- */}
        <div className="min-w-0 space-y-10">
          <section aria-labelledby="escrow-h" className="space-y-4">
            <h2 id="escrow-h" className="text-lg font-semibold">
              Authorized balance
            </h2>
            <dl className="grid grid-cols-3 gap-3 sm:gap-4">
              <div>
                <dt className="text-sm text-muted-foreground">Released to creator</dt>
                <dd className="text-xl font-bold tabular-nums text-success sm:text-2xl">{usdCents(escrow.capturedCents)}</dd>
              </div>
              {escrow.returnedCents > 0 ? (
                <div>
                  <dt className="text-sm text-muted-foreground">Returned to brand</dt>
                  <dd className="text-xl font-bold tabular-nums sm:text-2xl">{usdCents(escrow.returnedCents)}</dd>
                </div>
              ) : (
                <div>
                  <dt className="text-sm text-muted-foreground">Still held</dt>
                  <dd className="text-xl font-bold tabular-nums text-held sm:text-2xl">{usdCents(escrow.heldCents)}</dd>
                </div>
              )}
              <div>
                <dt className="text-sm text-muted-foreground">Authorized</dt>
                <dd className="text-xl font-bold tabular-nums sm:text-2xl">{usdCents(escrow.authorizedCents || escrow.totalBudgetCents)}</dd>
              </div>
            </dl>
            <EscrowBar segments={tranches.map((t) => ({ key: t.id, label: t.label, amount: t.amount, status: t.status }))} />
          </section>

          <section aria-labelledby="tranches-h">
            <h2 id="tranches-h" className="text-lg font-semibold">
              Tranches
            </h2>
            <ol className="mt-3 divide-y rounded-lg border bg-card">
              {tranches.map((t) => {
                const viewTarget = t.type === "VIEW_MILESTONE" ? t.conditions.minViews : 0;
                const viewNow = t.progressNote ? Number(t.progressNote.split(" / ")[0]?.replace(/,/g, "")) : NaN;
                return (
                  <li key={t.id} className="space-y-2 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <span className="font-semibold">
                          {t.trancheIndex + 1}. {t.label}
                        </span>
                        <TrancheStatusBadge status={t.status} />
                      </div>
                      <span className="font-semibold tabular-nums">{usd(t.amount)}</span>
                    </div>
                    {viewTarget > 0 && Number.isFinite(viewNow) && t.status !== "PAID_OUT" && (
                      <Progress value={Math.min(100, (viewNow / viewTarget) * 100)} indicatorClassName="bg-held" aria-label="Views toward milestone" />
                    )}
                    {t.progressNote && t.status !== "PAID_OUT" && <p className="text-sm text-muted-foreground">{t.progressNote}</p>}
                    {t.status === "REFUSED" && t.lastError && (
                      <ul className="space-y-1 text-sm text-destructive">
                        {t.lastError.split(" | ").map((r) => (
                          <li key={r}>{r.replace(/^[A-Z_]+: /, "")}</li>
                        ))}
                      </ul>
                    )}
                    {t.status === "PAID_OUT" && (
                      <p className="text-sm text-muted-foreground">
                        Captured <span className="font-code text-foreground">{t.captureId}</span>, paid out in batch{" "}
                        <span className="font-code text-foreground">{t.payoutBatchId}</span> ({payoutStatusLabel(t.payoutStatus)})
                      </p>
                    )}
                    {t.status === "VOIDED" && t.lastError && <p className="text-sm text-muted-foreground">{t.lastError}</p>}
                  </li>
                );
              })}
            </ol>
          </section>

          <section aria-labelledby="timeline-h">
            <h2 id="timeline-h" className="text-lg font-semibold">
              Live audit timeline
            </h2>
            {runs.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {active ? "Nothing audited yet. Publish the video, then run an audit, or wait for the scheduled check." : "Fund the deal to start watching the channel."}
              </p>
            ) : (
              <div className="mt-3 space-y-6">
                {runs.slice(0, 6).map(([runId, events]) => (
                  <ol key={runId} className="relative space-y-3 border-l-2 border-border pl-5">
                    {events.map((ev) => (
                      <li key={ev.id} className="relative">
                        <span
                          className={cn(
                            "absolute -left-[29px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full",
                            ev.ok ? "bg-success text-success-foreground" : "bg-destructive text-destructive-foreground",
                          )}
                          aria-hidden
                        >
                          {ev.ok ? <Check className="h-3 w-3" strokeWidth={3} /> : <X className="h-3 w-3" strokeWidth={3} />}
                        </span>
                        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                          <span className="font-semibold">{STEP_LABEL[ev.step] ?? ev.step}</span>
                          <span className="text-xs text-muted-foreground">
                            {trancheName(ev.trancheId)} at <LocalTime iso={ev.createdAt} />
                          </span>
                        </div>
                        <p className="text-sm leading-relaxed text-muted-foreground">{ev.message}</p>
                      </li>
                    ))}
                  </ol>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* ---------------- Evidence ---------------- */}
        <div className="min-w-0 space-y-10">
          {active && (
            <section aria-labelledby="run-h" className="rounded-lg border bg-card p-5">
              <h2 id="run-h" className="text-lg font-semibold">
                Run an audit now
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">Leave the video blank to check the channel&apos;s newest public upload.</p>
              <form onSubmit={runAudit} className="mt-4 space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="video">YouTube video link or id</Label>
                  <Input id="video" placeholder="https://www.youtube.com/watch?v=…" value={videoInput} onChange={(e) => setVideoInput(e.target.value)} />
                </div>
                <details className="text-sm">
                  <summary className="cursor-pointer select-none text-muted-foreground">Add a transcript (used if Gemini can&apos;t open the video)</summary>
                  <Textarea className="mt-2 min-h-[110px] font-code" placeholder={"00:40 This video is sponsored by Lumen\n00:44 Glow Serum goes on first…"} value={transcript} onChange={(e) => setTranscript(e.target.value)} />
                </details>
                <Button type="submit" disabled={running} className="w-full sm:w-auto">
                  {running && <LoaderCircle className="animate-spin" />}
                  {running ? <span className="tabular-nums">Auditing with Gemini…{auditSeconds > 0 && ` ${auditSeconds}s`}</span> : "Run audit"}
                </Button>
                {runNote && <p className="whitespace-pre-line text-sm text-muted-foreground">{runNote}</p>}
              </form>
            </section>
          )}

          <section aria-labelledby="evidence-h">
            <div className="flex items-center justify-between gap-2">
              <h2 id="evidence-h" className="text-lg font-semibold">
                Evidence inspector
              </h2>
              {audits.length > 1 && (
                <div className="flex items-center gap-1 text-sm">
                  <Button variant="ghost" size="sm" disabled={shownIndex >= audits.length - 1} onClick={() => { setAuditPinned(true); setAuditIndex(shownIndex + 1); }}>
                    Older
                  </Button>
                  <Button variant="ghost" size="sm" disabled={shownIndex === 0} onClick={() => { setAuditPinned(true); setAuditIndex(shownIndex - 1); }}>
                    Newer
                  </Button>
                </div>
              )}
            </div>
            {!audit ? (
              <p className="mt-2 text-sm text-muted-foreground">Evidence from each audit appears here: where the brand segment is, whether #ad was found, and the hash that seals it.</p>
            ) : (
              <div className="mt-3 space-y-4 rounded-lg border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <a
                      href={`https://www.youtube.com/watch?v=${audit.videoId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 font-semibold hover:underline"
                    >
                      {audit.videoTitle}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                    <p className="text-sm text-muted-foreground">
                      {trancheName(audit.trancheId)}. {SOURCE_LABEL[audit.source]} at <LocalTime iso={audit.createdAt} />
                    </p>
                  </div>
                  <Badge variant={audit.confidenceScore >= 0.85 ? "success" : "destructive"}>Confidence {audit.confidenceScore.toFixed(2)}</Badge>
                </div>

                {audit.source !== "metadata" && (
                  <EvidenceScrubber durationSec={audit.durationSec} segmentStart={audit.brandSegmentStartSec} segmentEnd={audit.brandSegmentEndSec} citations={audit.citations} />
                )}

                <div className="flex flex-wrap gap-1.5">
                  {audit.source !== "metadata" && (
                    <Badge variant={audit.hasAdDisclosure ? "success" : "destructive"}>
                      {audit.hasAdDisclosure ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                      {audit.hasAdDisclosure ? `#ad verified (${audit.disclosureSource})` : "#ad missing"}
                    </Badge>
                  )}
                  <Badge variant={audit.channelIdMatches ? "success" : "destructive"}>{audit.channelIdMatches ? "Contracted channel" : "Wrong channel"}</Badge>
                  <Badge variant={audit.isPublic ? "success" : "destructive"}>{audit.isPublic ? "Public" : "Not public"}</Badge>
                  {audit.source !== "metadata" && audit.brandSegmentDurationSec > 0 && <Badge variant="warning">{audit.brandSegmentDurationSec}s on the product</Badge>}
                  {audit.source === "metadata" && <Badge variant="held">{audit.viewCount.toLocaleString("en-US")} views</Badge>}
                </div>

                <ul className="space-y-1.5 text-sm">
                  {audit.citations.map((c, i) => (
                    <li key={i} className="grid grid-cols-[88px_1fr] gap-2">
                      <span className="tabular-nums text-muted-foreground">{c.at || (c.source === "description" ? "description" : "YouTube API")}</span>
                      <span>{c.note}</span>
                    </li>
                  ))}
                </ul>

                <Separator />
                <div>
                  <p className="text-xs text-muted-foreground">SHA-256 evidence hash</p>
                  <p className="font-code break-all">{audit.sha256EvidenceHash}</p>
                </div>
              </div>
            )}
          </section>

          <section aria-labelledby="firewall-h">
            <h2 id="firewall-h" className="text-lg font-semibold">
              Spend Firewall log
            </h2>
            {decisions.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">Every payment request is checked here before PayPal is called.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {decisions.slice(0, 8).map((d, i) => {
                  const passed = d.rules.filter((r) => r.passed).length;
                  return (
                    <details key={d.id} open={i === 0} className="group rounded-lg border bg-card">
                      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 p-4">
                        <span className="flex items-center gap-2.5">
                          <Badge variant={d.decision === "APPROVED" ? "success" : "destructive"}>{d.decision === "APPROVED" ? "Allowed" : "Blocked"}</Badge>
                          <span className="text-sm font-semibold">{trancheName(d.trancheId)}</span>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {passed} of {d.rules.length} rules passed at <LocalTime iso={d.evaluatedAt} />
                        </span>
                      </summary>
                      <ul className="space-y-1 border-t px-4 py-3">
                        {d.rules.map((r) => (
                          <li key={r.rule} className="grid grid-cols-[18px_minmax(0,190px)_1fr] items-start gap-2 text-sm">
                            {r.passed ? <Check className="mt-0.5 h-4 w-4 text-success" /> : <X className="mt-0.5 h-4 w-4 text-destructive" />}
                            <span className={cn("font-medium", !r.passed && "text-destructive")}>{RULE_LABEL[r.rule] ?? r.rule}</span>
                            <span className="text-muted-foreground">{r.detail}</span>
                          </li>
                        ))}
                      </ul>
                      <p className="border-t px-4 py-2 text-xs text-muted-foreground">
                        PayPal-Request-Id <span className="font-code text-foreground">{d.idempotencyKey.slice(0, 24)}…</span>
                      </p>
                    </details>
                  );
                })}
              </div>
            )}
          </section>

          <section aria-labelledby="ledger-h">
            <h2 id="ledger-h" className="text-lg font-semibold">
              PayPal ledger
            </h2>
            {ledger.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">PayPal calls that create, hold or move money are recorded here.</p>
            ) : (
              <div className="mt-3 overflow-x-auto rounded-lg border bg-card">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">Call</th>
                      <th className="px-4 py-2 font-medium">Amount</th>
                      <th className="px-4 py-2 font-medium" title="What PayPal answered to each call. Payouts show their latest status.">
                        Status
                      </th>
                      <th className="px-4 py-2 font-medium">PayPal id</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {ledger.map((l) => {
                      const recorded = l.status.toLowerCase().replace(/_/g, " ");
                      // PayPal answers PENDING when it accepts a payout. The tranche keeps the payout's
                      // latest status (re-checked with PayPal), so show that instead.
                      const payout = l.kind === "PAYOUT" && l.paypalId ? tranches.find((t) => t.payoutBatchId === l.paypalId) : undefined;
                      const latest = payout?.payoutStatus ? payoutStatusLabel(payout.payoutStatus) : null;
                      return (
                        <tr key={l.id}>
                          <td className="px-4 py-2 font-medium">{l.kind.replace("_", " ").toLowerCase()}</td>
                          <td className="px-4 py-2 tabular-nums">{usd(l.amount)}</td>
                          <td className="px-4 py-2" title={latest && latest !== recorded ? `PayPal answered "${recorded}" when the payout was sent` : undefined}>
                            {latest ?? recorded}
                          </td>
                          <td className="font-code px-4 py-2 text-muted-foreground" title={l.paypalRequestId}>
                            {l.paypalId ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-labelledby="desk-h" className="rounded-lg border bg-card p-5">
            <h2 id="desk-h" className="text-lg font-semibold">
              Ask the Deal Desk
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Gemini with PayPal&apos;s MCP server in read-only mode. It can explain this deal; it can&apos;t move money.</p>
            <form onSubmit={ask} className="mt-3 space-y-3">
              <Textarea value={question} onChange={(e) => setQuestion(e.target.value)} aria-label="Question for the Deal Desk" />
              <Button type="submit" variant="outline" disabled={asking}>
                {asking && <LoaderCircle className="animate-spin" />}
                {asking ? <span className="tabular-nums">Asking the Deal Desk…{askSeconds > 0 && ` ${askSeconds}s`}</span> : "Ask"}
              </Button>
            </form>
            {answer && <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{answer}</p>}
            {deskTrace && deskTrace.lines.length > 0 && <McpTrace lines={deskTrace.lines} model={deskTrace.model} />}
          </section>
        </div>
      </div>
    </div>
  );
}

/* ---------------- MCP trace drawer ---------------- */

/** The tools PayPal's MCP server exposes in the Deal Desk's read-only mode (orders.get, transactions.list, invoices.list). */
const PAYPAL_MCP_TOOLS = new Set(["get_order", "list_transactions", "list_invoices"]);

type TraceLane = "mcp" | "gemini" | "tranche" | "note";

interface TraceRow {
  at: string;
  lane: TraceLane;
  /** MCP protocol step: spawn, initialize and tools/list, tools/call. */
  method?: string;
  text: string;
  /** Second line: what a Gemini request asked for, or why a call failed. */
  detail?: string;
  duration?: string;
  failed?: boolean;
  /** Set on calls to PayPal's MCP server, for the summary line. */
  tool?: string;
}

const LANE: Record<TraceLane, { label: string; dot: string } | null> = {
  mcp: { label: "MCP", dot: "bg-held" },
  gemini: { label: "Gemini", dot: "bg-warning" },
  tranche: { label: "Tranche", dot: "bg-muted-foreground" },
  note: null,
};

/**
 * Shapes the Deal Desk's trace (lines like "+10.1s get_order({…}) started", written by
 * src/lib/copilot/deal-desk.ts) into one row per Gemini request and per tool call, each with
 * its duration. Lines it doesn't recognise stay as plain notes, so nothing is ever hidden.
 */
function traceRows(lines: string[]) {
  const rows: TraceRow[] = [];
  const openRequests = new Map<string, TraceRow>();
  const openTools = new Map<string, TraceRow[]>();
  let offered: string[] = [];

  for (const line of lines) {
    const stamp = /^\+(\d+(?:\.\d+)?)s (.*)$/.exec(line);
    const at = stamp ? `+${stamp[1]}s` : "";
    const msg = stamp ? (stamp[2] ?? "") : line;
    let m: RegExpExecArray | null;

    if ((m = /^starting PayPal's MCP server \(npx (.+)\)$/.exec(msg))) {
      rows.push({ at, lane: "mcp", method: "spawn", text: `${m[1]} over stdio` });
    } else if ((m = /^PayPal MCP ready: (.*)$/.exec(msg))) {
      offered = (m[1] ?? "").split(", ").filter(Boolean);
      rows.push({ at, lane: "mcp", method: "initialize, tools/list", text: offered.join(", ") || "no tools" });
    } else if ((m = /^PayPal MCP unavailable \((.*)\); /.exec(msg))) {
      rows.push({ at, lane: "mcp", method: "initialize", text: "PayPal's MCP server didn't start", detail: m[1], failed: true });
    } else if ((m = /^(\S+): request (\d+) sent$/.exec(msg))) {
      const row: TraceRow = { at, lane: "gemini", text: `${m[1]} request ${m[2]}` };
      openRequests.set(`${m[1]}#${m[2]}`, row);
      rows.push(row);
    } else if ((m = /^(\S+): request (\d+) answered in (\S+) \((.*)\)$/.exec(msg))) {
      const row = openRequests.get(`${m[1]}#${m[2]}`);
      if (row) Object.assign(row, { detail: m[4], duration: m[3] });
      else rows.push({ at, lane: "gemini", text: `${m[1]} request ${m[2]}`, detail: m[4], duration: m[3] });
    } else if ((m = /^(\S+): (used up its .+|busy after retries .+)$/.exec(msg))) {
      rows.push({ at, lane: "gemini", text: m[1] ?? "", detail: m[2], failed: true });
    } else if ((m = /^([a-z_]+)\((.*)\) started$/.exec(msg))) {
      const name = m[1] ?? "";
      const paypal = PAYPAL_MCP_TOOLS.has(name) || offered.includes(name);
      const row: TraceRow = paypal
        ? { at, lane: "mcp", method: "tools/call", text: `${name}(${m[2]})`, tool: name }
        : { at, lane: "tranche", text: `${name}(${m[2]})` };
      openTools.set(name, [...(openTools.get(name) ?? []), row]);
      rows.push(row);
    } else if ((m = /^([a-z_]+) (?:finished in (\S+)|timed out after (\S+) \(limit (\S+)\)|failed after (\S+): (.*))$/.exec(msg))) {
      const row = openTools.get(m[1] ?? "")?.shift();
      const outcome: Partial<TraceRow> = m[2]
        ? { duration: m[2] }
        : m[3]
          ? { duration: m[3], detail: `timed out (limit ${m[4]})`, failed: true }
          : { duration: m[5], detail: m[6], failed: true };
      if (row) Object.assign(row, outcome);
      else rows.push({ at, lane: "note", text: msg, ...outcome });
    } else {
      rows.push({ at, lane: "note", text: msg, failed: /^(gave up|failed:)|service is busy/i.test(msg) });
    }
  }

  const total = /^\+(\d+(?:\.\d+)?)s/.exec(lines.at(-1) ?? "")?.[1] ?? null;
  return { rows, paypalCalls: rows.filter((r) => r.tool), total };
}

/** Collapsible record of how a Deal Desk answer was made: the MCP handshake, each PayPal tool call and each Gemini request. */
function McpTrace({ lines, model }: { lines: string[]; model: string | null }) {
  const { rows, paypalCalls, total } = useMemo(() => traceRows(lines), [lines]);
  return (
    <details className="group mt-4 rounded-md border bg-muted/40">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-xs [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground motion-safe:transition-transform group-open:rotate-90" aria-hidden />
        <span className="font-semibold">MCP trace</span>
        {paypalCalls.length > 0 ? (
          paypalCalls.map((c, i) => (
            <span key={i} className={cn("font-code rounded border bg-card px-1.5 py-0.5", c.failed && "border-destructive/40 text-destructive")}>
              {c.tool} {c.duration}
            </span>
          ))
        ) : (
          <span className="text-muted-foreground">No PayPal calls</span>
        )}
        <span className="ml-auto flex gap-3 tabular-nums text-muted-foreground">
          {model && <span>{model}</span>}
          {total && <span>{total}s</span>}
        </span>
      </summary>
      <div className="border-t px-3 pb-3 pt-2">
        <p className="text-xs text-muted-foreground">Each step of this answer as it ran. PayPal calls go through PayPal&apos;s own MCP server, started with read-only tools only.</p>
        <ol className="font-code mt-2.5 space-y-1.5 text-xs">
          {rows.map((r, i) => {
            const lane = LANE[r.lane];
            return (
              <li key={i} className="grid grid-cols-[3.25rem_4.25rem_minmax(0,1fr)_auto] items-baseline gap-x-2">
                <span className="tabular-nums text-muted-foreground">{r.at}</span>
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  {lane && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", lane.dot)} aria-hidden />}
                  {lane?.label}
                </span>
                <span className={cn("min-w-0 [overflow-wrap:anywhere]", r.failed ? "text-destructive" : r.tool && "font-semibold")}>
                  {r.method && <span className="font-normal text-muted-foreground">{r.method} </span>}
                  {r.text}
                  {r.detail && <span className={cn("block font-normal", r.failed ? "text-destructive" : "text-muted-foreground")}>{r.detail}</span>}
                </span>
                <span className="tabular-nums text-muted-foreground">{r.duration}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </details>
  );
}
