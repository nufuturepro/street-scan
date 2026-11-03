'use client';

import { Fragment, useEffect, useState } from 'react';
import Link from 'next/link';
import { computeAuditCost, perKmLabel, usd } from '@/lib/cost';
import type { SpendRow, SpendTotals } from '@/lib/types';
import {
  SAM_USD_PER_1000_FRAMES,
  SPARK_USD_PER_1M_IN,
  SPARK_USD_PER_1M_OUT,
} from '@/lib/config';

type CostEntry = {
  id: number;
  name: string;
  createdAt: string;
  status: string;
  frames: number;
  cost: ReturnType<typeof computeAuditCost>;
  /** this audit's ledger totals and rows, behind the row's detail toggle */
  spend: SpendTotals;
  spendRows: SpendRow[];
};

type Ledger = {
  entries: CostEntry[];
  /** every billed event, from the spend ledger: the number the pill reports */
  lifetime: {
    usd: number;
    frames: number;
    requests: number;
    samUsd: number;
    sparkUsd: number;
    classCalls: number;
    tokensIn: number;
    tokensOut: number;
    /** what you re-recorded from Meta's Billing page (see reconcile below) */
    adjustmentUsd: number;
  };
  session: {
    frames: number;
    requests: number;
    samUsd: number;
    classUsd: number;
    classCalls: number;
    tokensIn: number;
    tokensOut: number;
    fixtureCalls: number;
    usd: number;
    creditUsd: number;
  };
};

/**
 * The expense ledger: every audit's bill, what it was made of, and spend
 * against the $150 credit. Linked from the header pill and each export pill,
 * so any amount on screen leads here - a judge who wants to know what the
 * demo costs should never have to ask.
 */
export default function CostsClient() {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** which audit's billing detail is open */
  const [expanded, setExpanded] = useState<number | null>(null);
  const [credits, setCredits] = useState('');
  const [busy, setBusy] = useState(false);
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/costs', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Ledger;
        if (alive) {
          setLedger(data);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-10">
        <div className="rounded border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      </div>
    );
  }

  if (!ledger) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-10 text-sm text-zinc-500">
        Loading the ledger…
      </div>
    );
  }

  const { entries, session, lifetime } = ledger;
  const rowsSumUsd = entries.reduce((s, e) => s + e.cost.totalUsd, 0);
  const rowsSumKm = entries.reduce((s, e) => s + (e.cost.distanceM ?? 0), 0);
  const creditPct = Math.min(100, (lifetime.usd / session.creditUsd) * 100);
  const projected = entries.some((e) => e.cost.projected);
  const anySimulated = entries.some((e) => e.cost.simulated);

  // Reconcile preview: what Meta's Billing page implies vs what the ledger
  // holds, shown live before anything is written.
  const typedCredits = credits.trim() === '' ? null : Number(credits);
  const previewActual =
    typedCredits !== null &&
    Number.isFinite(typedCredits) &&
    typedCredits >= 0 &&
    typedCredits <= session.creditUsd
      ? Math.round((session.creditUsd - typedCredits) * 100) / 100
      : null;
  const previewDelta =
    previewActual === null
      ? null
      : Math.round((previewActual - lifetime.usd) * 1e4) / 1e4;

  const reconcile = async () => {
    if (previewActual === null || typedCredits === null) return;
    setBusy(true);
    setReconcileMsg(null);
    try {
      const res = await fetch('/api/costs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creditsRemaining: typedCredits }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        changed?: boolean;
        delta?: number;
        lifetime?: Ledger['lifetime'];
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setCredits('');
      setReconcileMsg(
        data.changed
          ? `Recorded ${data.delta !== undefined && data.delta >= 0 ? '+' : ''}${usd(data.delta ?? 0)} — lifetime is now ${usd(data.lifetime?.usd ?? 0)}.`
          : 'Already in step with Meta — nothing to record.'
      );
      const fresh = await fetch('/api/costs', { cache: 'no-store' });
      if (fresh.ok) setLedger((await fresh.json()) as Ledger);
    } catch (err) {
      setReconcileMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Audit costs</h1>
        <span className="text-xs text-zinc-500">
          {entries.length} audit{entries.length === 1 ? '' : 's'}
        </span>
        <Link
          href="/dashboard"
          className="ml-auto text-sm text-amber-400 hover:text-amber-300"
        >
          ← Dispatch
        </Link>
      </div>

      {/* Credit bar: what the $150 hackathon pool has actually consumed. */}
      <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Credit consumed
          </span>
          <span className="font-mono text-sm tabular-nums text-zinc-200">
            {usd(lifetime.usd)} / {usd(session.creditUsd, 0)}
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full bg-amber-400 transition-[width] duration-500"
            style={{ width: `${Math.max(1, creditPct)}%` }}
          />
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">
          {lifetime.usd > 0 ? (
            <>
              {lifetime.frames.toLocaleString()} frames billed across{' '}
              {lifetime.requests} SAM request
              {lifetime.requests === 1 ? '' : 's'} · {lifetime.classCalls}{' '}
              classification call{lifetime.classCalls === 1 ? '' : 's'} ·{' '}
              {lifetime.tokensIn.toLocaleString()} in /{' '}
              {lifetime.tokensOut.toLocaleString()} out tokens
              {Math.abs(lifetime.adjustmentUsd) > 0.0001 && (
                <> · {usd(lifetime.adjustmentUsd)} reconciled against Meta</>
              )}
              {session.fixtureCalls > 0 && (
                <> · {session.fixtureCalls} served from fixtures (free)</>
              )}
            </>
          ) : (
            <>No billed API calls recorded yet.</>
          )}
        </p>

        {/* The redo button: Meta exposes no usage API, so the operator types
            what the Billing page says and the difference is appended as one
            adjustment row - never a rewrite of what the ledger knows. */}
        <div className="mt-3 border-t border-zinc-800 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <label
              htmlFor="reconcile-credits"
              className="text-[11px] uppercase tracking-wider text-zinc-500"
            >
              Free credits remaining (Meta → Billing)
            </label>
            <input
              id="reconcile-credits"
              type="number"
              min={0}
              max={session.creditUsd}
              step="0.01"
              value={credits}
              onChange={(ev) => setCredits(ev.target.value)}
              placeholder="e.g. 115.86"
              className="w-32 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-sm tabular-nums text-zinc-200 placeholder:text-zinc-700"
            />
            <button
              type="button"
              onClick={reconcile}
              disabled={busy || previewDelta === null || previewDelta === 0}
              className="rounded border border-amber-700 bg-amber-950 px-3 py-1 text-xs font-medium text-amber-300 hover:bg-amber-900 disabled:opacity-40"
            >
              {busy ? 'Recording…' : 'Reconcile'}
            </button>
            {previewDelta !== null && previewDelta !== 0 && (
              <span className="font-mono text-[11px] tabular-nums text-zinc-500">
                → {usd(previewActual ?? 0)} spent · {previewDelta > 0 ? '+' : ''}
                {usd(previewDelta)} adjustment
              </span>
            )}
          </div>
          {reconcileMsg && (
            <p className="mt-2 text-[11px] text-zinc-400">{reconcileMsg}</p>
          )}
        </div>
      </div>

      {/* Per-audit rows, each anchored so a pill link lands on it. */}
      <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2.5 font-medium">Audit</th>
              <th className="px-3 py-2.5 font-medium">Run</th>
              <th className="px-3 py-2.5 text-right font-medium">Frames</th>
              <th className="px-3 py-2.5 text-right font-medium">SAM</th>
              <th className="px-3 py-2.5 text-right font-medium">Spark</th>
              <th className="px-3 py-2.5 text-right font-medium">Total</th>
              <th className="px-4 py-2.5 text-right font-medium">Per km</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/70">
            {entries.map((e) => (
              <Fragment key={e.id}>
              <tr
                id={`job-${e.id}`}
                className="scroll-mt-20 transition-colors hover:bg-zinc-800/40"
              >
                <td className="px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                    aria-expanded={expanded === e.id}
                    aria-label={`billing detail for audit ${e.id}`}
                    className="mr-1.5 inline-flex h-4 w-4 items-center justify-center text-[9px] text-zinc-600 hover:text-amber-400"
                  >
                    {expanded === e.id ? '▾' : '▸'}
                  </button>
                  <Link
                    href={`/inspect/${e.id}`}
                    className="text-zinc-200 hover:text-amber-400"
                  >
                    <span className="font-mono text-xs text-zinc-500">
                      #{e.id}
                    </span>{' '}
                    {e.name}
                  </Link>
                  {e.status !== 'ready' && (
                    <span className="ml-2 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase text-zinc-500">
                      {e.status}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-xs tabular-nums text-zinc-500">
                  {e.createdAt}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-zinc-400">
                  {e.frames ? e.frames.toLocaleString() : '—'}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-zinc-300">
                  {usd(e.cost.samUsd)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-zinc-300">
                  {e.cost.sparkUsd > 0 ? usd(e.cost.sparkUsd) : '—'}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-sm tabular-nums text-zinc-100">
                  {usd(e.cost.totalUsd)}
                  {e.cost.simulated && (
                    <span
                      className="ml-1.5 text-[10px] uppercase text-amber-500"
                      title="recorded fixtures — what this would have cost, not a charge"
                    >
                      sim
                    </span>
                  )}
                  {e.cost.projected && (
                    <span
                      className="ml-1.5 text-[10px] uppercase text-zinc-600"
                      title="no bill recorded for this run — frame charge only"
                    >
                      est
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-zinc-400">
                  {e.cost.perKmUsd != null ? perKmLabel(e.cost.perKmUsd) : '—'}
                </td>
              </tr>
              {expanded === e.id && (
                <tr className="bg-zinc-950/60">
                  <td colSpan={7} className="px-4 py-3">
                    <div className="grid gap-4 text-[11px] sm:grid-cols-2">
                      <div>
                        <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                          Billed for this audit
                        </div>
                        <div className="font-mono tabular-nums text-zinc-300">
                          {e.spend.frames.toLocaleString()} frames ·{' '}
                          {e.spend.requests} SAM request
                          {e.spend.requests === 1 ? '' : 's'} ·{' '}
                          {e.spend.classCalls} classification call
                          {e.spend.classCalls === 1 ? '' : 's'}
                        </div>
                        <div className="font-mono tabular-nums text-zinc-400">
                          {e.spend.tokensIn.toLocaleString()} in /{' '}
                          {e.spend.tokensOut.toLocaleString()} out tokens
                        </div>
                      </div>
                      <div>
                        <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                          Ledger rows
                        </div>
                        <ul className="space-y-1">
                          {e.spendRows.map((r, i) => (
                            <li key={i} className="flex gap-2 font-mono text-[10px]">
                              <span className="w-20 shrink-0 uppercase text-zinc-600">
                                {r.kind}
                              </span>
                              <span className="w-16 shrink-0 text-zinc-300">
                                {usd(r.usd)}
                              </span>
                              <span className="truncate text-zinc-500" title={r.detail}>
                                {r.detail}
                              </span>
                            </li>
                          ))}
                          {e.spendRows.length === 0 && (
                            <li className="font-mono text-[10px] text-zinc-600">
                              no charges recorded
                            </li>
                          )}
                        </ul>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
            {entries.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-zinc-500"
                >
                  No audits yet — run one and its bill lands here.
                </td>
              </tr>
            )}
          </tbody>
          {entries.length > 0 && (
            <tfoot>
              <tr className="border-t border-zinc-700 bg-zinc-900">
                <td className="px-4 py-3 text-[11px] uppercase tracking-wider text-zinc-500">
                  All audits
                </td>
                <td />
                <td className="px-3 py-3 text-right tabular-nums text-zinc-400">
                  {entries
                    .reduce((s, e) => s + e.frames, 0)
                    .toLocaleString()}
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-zinc-300">
                  {usd(entries.reduce((s, e) => s + e.cost.samUsd, 0))}
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-zinc-300">
                  {usd(entries.reduce((s, e) => s + e.cost.sparkUsd, 0))}
                </td>
                <td className="px-3 py-3 text-right font-mono text-sm font-medium tabular-nums text-zinc-100">
                  {usd(rowsSumUsd)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-zinc-400">
                  {rowsSumKm > 0
                    ? perKmLabel(rowsSumUsd / (rowsSumKm / 1000))
                    : '—'}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Rate card + the two honesty notes a judge should read before quoting a number. */}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Rate card
          </h2>
          <dl className="mt-2 space-y-1.5 text-xs text-zinc-400">
            <div className="flex justify-between gap-3">
              <dt>SAM 3.1 segmentation</dt>
              <dd className="font-mono tabular-nums text-zinc-200">
                {usd(SAM_USD_PER_1000_FRAMES, 2)} / 1,000 frames
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>Muse Spark input</dt>
              <dd className="font-mono tabular-nums text-zinc-200">
                {usd(SPARK_USD_PER_1M_IN, 2)} / 1M tokens
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>Muse Spark output</dt>
              <dd className="font-mono tabular-nums text-zinc-200">
                {usd(SPARK_USD_PER_1M_OUT, 2)} / 1M tokens
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>Transcode, stills, crops (ffmpeg)</dt>
              <dd className="font-mono tabular-nums text-emerald-500">
                $0.00 — local
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">
            Analysis runs on a separate 10fps copy, so a 10-minute drive bills
            6,000 frames instead of 18,000.
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-amber-600/90">
            Estimate, not an invoice: every figure here is computed from
            today&apos;s published rates — which Meta can change — and from
            the ledger&apos;s own records. Treat the numbers as projections of
            what gets charged, not receipts.
          </p>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            How to read this
          </h2>
          <ul className="mt-2 space-y-2 text-[11px] leading-relaxed text-zinc-500">
            <li>
              <span className="text-zinc-400">One row per charge.</span> Since
              the ledger began, SAM rows carry the frames Meta actually billed
              and Spark rows the real token counts; rows are written when the
              money moves, so a crash, a restart or a re-run cannot erase them.
            </li>
            {anySimulated && (
              <li>
                <span className="text-amber-500">Sim</span> rows never reached
                the API: they show what the run would have cost at published
                rates, not a charge.
              </li>
            )}
            {projected && (
              <li>
                <span className="text-zinc-400">Est</span> rows finished without
                a recorded bill, so only the frame charge is claimed.
              </li>
            )}
            <li>
              Audits run before this ledger kept a single per-run estimate that
              a re-run overwrote — the app underreported against Meta&apos;s
              usage page. Those rows are seeded from what it recorded; Meta is
              the authority for that period.
            </li>
            <li>
              The header pill reports the lifetime ledger: the rows below plus
              probes billed without an audit and anything you record with the
              reconcile box — so it can exceed the sum of rows here. Meta has
              no usage API, so that box is how the two are kept in step.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
