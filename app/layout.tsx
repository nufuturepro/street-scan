import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import "./globals.css";
import StatusPill from "@/components/StatusPill";

export const metadata: Metadata = {
  title: "StreetScan — Urban Hazard Auditor",
  description:
    "Turns dashcam and handlebar footage into verified, geo-tagged municipal work orders using SAM 3.1 and Muse Spark.",
};

/**
 * The shell: an icon rail down the left (where you are, in one glance) and a
 * thin top bar (whether the API is live, what has been spent).
 *
 * The rail is md-and-up; on a phone it becomes a scrolling tab row inside the
 * top bar, because a 56px column of unlabelled glyphs on a 390px screen costs
 * more than it gives.
 */
const NAV = [
  { href: "/", label: "Dispatch", icon: "dispatch" },
  { href: "/costs", label: "Costs", icon: "costs" },
  { href: "/settings", label: "Settings", icon: "settings" },
] as const;

function Glyph({ name }: { name: string }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (name === "dispatch")
    return (
      <svg {...common}>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </svg>
    );
  if (name === "costs")
    return (
      <svg {...common}>
        <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H19a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5.5A2.5 2.5 0 0 1 3 16.5z" />
        <path d="M3 9h17" />
        <circle cx="16.5" cy="14" r="1.2" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.7 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.7a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.3 9v.03a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.1A1.7 1.7 0 0 0 19.4 15z" />
    </svg>
  );
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full text-ink">
        <div className="flex min-h-screen">
          {/* Rail: brand, destinations, then the one action that starts work. */}
          <aside className="sticky top-0 z-[500] hidden h-screen w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-[rgb(21_11_29/0.85)] py-3 backdrop-blur md:flex">
            <Link
              href="/"
              className="mb-2 grid h-9 w-9 place-items-center rounded-lg bg-accent shadow-[0_6px_18px_rgb(255_46_99/0.35)]"
              title="StreetScan — Dispatch"
            >
              <Image src="/streetscan-logo.png" alt="StreetScan" width={22} height={22} />
            </Link>
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                title={item.label}
                className="group grid h-10 w-10 place-items-center rounded-lg text-muted transition-colors hover:bg-surface2 hover:text-ink"
              >
                <Glyph name={item.icon} />
                <span className="sr-only">{item.label}</span>
              </Link>
            ))}
            {/* The one action that always starts work, from anywhere. */}
            <Link
              href="/?new=1"
              title="New audit — upload footage"
              className="mt-1 grid h-10 w-10 place-items-center rounded-lg border border-accent/40 bg-accent/15 text-accent transition-colors hover:bg-accent hover:text-white"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span className="sr-only">New audit</span>
            </Link>
            <div className="mt-auto flex flex-col items-center gap-2">
              <span className="grid h-10 w-10 place-items-center rounded-lg text-muted-2" title="LAN only — no login">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
                  <path d="M12 3a9 9 0 0 0-9 9v3a2 2 0 0 0 2 2h1v-6H5a7 7 0 0 1 14 0h-1v6h1a2 2 0 0 0 2-2v-3a9 9 0 0 0-9-9z" strokeLinejoin="round" />
                </svg>
              </span>
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-[500] border-b border-line bg-[rgb(21_11_29/0.88)] backdrop-blur">
              <div className="flex h-12 items-center gap-4 px-4">
                <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight md:hidden">
                  <Image src="/streetscan-logo.png" alt="" width={20} height={20} className="shrink-0" />
                  StreetScan
                </Link>
                <nav className="hidden items-center gap-1 text-sm text-muted md:flex">
                  {NAV.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="rounded-md px-2.5 py-1 transition-colors hover:bg-surface2 hover:text-ink"
                    >
                      {item.label}
                    </Link>
                  ))}
                </nav>
                <div className="ml-auto flex items-center gap-3">
                  <StatusPill />
                </div>
              </div>
              {/* Phone: the rail's destinations become a scrolling tab row. */}
              <nav className="flex gap-1 overflow-x-auto border-t border-line px-3 py-1.5 text-xs text-muted md:hidden">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="shrink-0 rounded-md px-2 py-1 hover:bg-surface2 hover:text-ink"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </header>
            <main className="flex-1">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
