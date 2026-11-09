import type { Metadata } from "next";
import Link from "next/link";
import "@fontsource-variable/hanken-grotesk/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tranche: sponsorships that pay when the video goes live",
  description: "Escrow for creator brand deals. Funds are held on PayPal and released tranche by tranche when an AI audit verifies the video.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b bg-card">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
            <Link href="/" className="flex items-center gap-2.5 text-[17px] font-bold tracking-tight">
              <span aria-hidden className="flex h-5 w-7 gap-[3px]">
                <span className="w-1/2 rounded-[2px] bg-success" />
                <span className="w-1/4 rounded-[2px] bg-held/40" />
                <span className="w-1/4 rounded-[2px] bg-held/20" />
              </span>
              Tranche
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              <Link href="/" className="rounded-md px-3 py-1.5 hover:bg-accent">
                Deals
              </Link>
              <Link href="/deals/new" className="rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground hover:bg-primary/90">
                New deal
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">{children}</main>
      </body>
    </html>
  );
}
