import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import StatusPill from "@/components/StatusPill";

export const metadata: Metadata = {
  title: "StreetScan — Urban Hazard Auditor",
  description:
    "Turns dashcam and handlebar footage into verified, geo-tagged municipal work orders using SAM 3.1 and Muse Spark.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
        <header className="border-b border-zinc-800 bg-zinc-950/95 sticky top-0 z-[500]">
          <div className="mx-auto max-w-7xl px-4 h-14 flex items-center gap-6">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400" />
              StreetScan
            </Link>
            <nav className="flex items-center gap-4 text-sm text-zinc-400">
              <Link href="/" className="hover:text-zinc-100 transition-colors">
                New audit
              </Link>
              <Link href="/dashboard" className="hover:text-zinc-100 transition-colors">
                Dispatch
              </Link>
            </nav>
            <div className="ml-auto">
              <StatusPill />
            </div>
          </div>
        </header>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
