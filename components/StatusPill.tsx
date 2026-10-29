'use client';

import { useEffect, useState } from 'react';

type Status = {
  mode: string;
  live: { ok: boolean; detail: string };
  billing: { blocked: boolean; url?: string; message?: string };
  cost: {
    frames: number;
    requests: number;
    /** SAM + Muse Spark combined */
    usd: number;
    fixtureCalls: number;
    creditUsd: number;
    classUsd?: number;
    classCalls?: number;
    tokensIn?: number;
    tokensOut?: number;
  };
};

/**
 * Live honesty badge.
 *
 * Shows whether calls are hitting the real Meta Model API or the recorded
 * fixtures, plus spend against the $150 hackathon credit. Hiding this would be
 * the easy thing to do and the wrong thing to do: a judge who assumes the
 * masks are live when they are not has been misled.
 */
export default function StatusPill() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/status', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as Status;
        if (alive) setStatus(data);
      } catch {
        /* server not up yet */
      }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!status) {
    return <span className="text-xs text-zinc-600">checking…</span>;
  }

  const live = status.live.ok;

  return (
    <div className="flex items-center gap-3 text-xs">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 border ${
          live
            ? 'border-emerald-700 bg-emerald-950 text-emerald-300'
            : 'border-amber-700 bg-amber-950 text-amber-300'
        }`}
        title={status.billing.message ?? status.live.detail}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-400' : 'bg-amber-400 pulse-soft'}`} />
        {live ? 'live API' : 'fixtures'}
      </span>
      <span className="hidden sm:inline text-zinc-500 tabular-nums">
        ${(status.cost.usd).toFixed(3)} / ${status.cost.creditUsd}
      </span>
      {!live && status.billing.blocked && status.billing.url && (
        <a
          href={status.billing.url}
          target="_blank"
          rel="noreferrer"
          className="hidden md:inline text-amber-400 hover:text-amber-300 underline underline-offset-2"
        >
          fix billing
        </a>
      )}
    </div>
  );
}
