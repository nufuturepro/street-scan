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
        <div className="rounded border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {error}
        </div>
      </div>
    );
  }

  if (!ledger) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-10 text-sm text-muted">
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
    <div className="mx-auto max-w-6xl px-4 py-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Audit costs</h1>
        <span className="text-xs text-muted">
          {entries.length} audit{entries.length === 1 ? '' : 's'}
        </span>
        <Link
          href="/"
          className="ml-auto text-sm text-accent hover:text-accent"
        >
          ← Dispatch
        </Link>
      </div>

      {/* Credit bar: what the $150 hackathon pool has actually consumed. */}
      <div className="mt-6 panel p-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="label">
            Credit consumed
          </span>
          <span className="font-mono text-sm tabular-nums text-ink">
            {usd(lifetime.usd)} / {usd(session.creditUsd, 0)}
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface2">
          <div
            className="h-full bg-gold transition-[width] duration-500"
            style={{ width: `${Math.max(1, creditPct)}%` }}
          />
        </div>
        <p className="mt-2 text-[11px] text-muted">
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
        <div className="mt-3 border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <label
              htmlFor="reconcile-credits"
              className="text-[11px] uppercase tracking-wider text-muted"
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
              className="w-32 rounded border border-line bg-bg px-2 py-1 font-mono text-sm tabular-nums text-ink placeholder:text-muted2"
            />
            <button
              type="button"
              onClick={reconcile}
              disabled={busy || previewDelta === null || previewDelta === 0}
              className="rounded border border-gold/40 bg-gold/10 px-3 py-1 text-xs font-medium text-gold hover:bg-gold/15 disabled:opacity-40"
            >
              {busy ? 'Recording…' : 'Reconcile'}
            </button>
            {previewDelta !== null && previewDelta !== 0 && (
              <span className="font-mono text-[11px] tabular-nums text-muted">
                → {usd(previewActual ?? 0)} spent · {previewDelta > 0 ? '+' : ''}
                {usd(previewDelta)} adjustment
              </span>
            )}
          </div>
          {reconcileMsg && (
            <p className="mt-2 text-[11px] text-muted">{reconcileMsg}</p>
          )}
        </div>
      </div>

      {/* Per-audit rows, each anchored so a pill link lands on it. */}
      <div className="mt-6 overflow-x-auto panel">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-muted">
              <th className="px-4 py-2.5 font-medium">Audit</th>
              <th className="px-3 py-2.5 font-medium">Run</th>
              <th className="px-3 py-2.5 text-right font-medium">Frames</th>
              <th className="px-3 py-2.5 text-right font-medium">SAM</th>
              <th className="px-3 py-2.5 text-right font-medium">Spark</th>
              <th className="px-3 py-2.5 text-right font-medium">Total</th>
              <th className="px-4 py-2.5 text-right font-medium">Per km</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/70">
            {entries.map((e) => (
              <Fragment key={e.id}>
              <tr
                id={`job-${e.id}`}
                className="scroll-mt-20 transition-colors hover:bg-surface2/40"
              >
                <td className="px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                    aria-expanded={expanded === e.id}
                    aria-label={`billing detail for audit ${e.id}`}
                    className="mr-1.5 inline-flex h-4 w-4 items-center justify-center text-[9px] text-muted2 hover:text-gold"
                  >
                    {expanded === e.id ? '▾' : '▸'}
                  </button>
                  <Link
                    href={`/inspect/${e.id}`}
                    className="text-ink hover:text-gold"
                  >
                    <span className="font-mono text-xs text-muted">
                      #{e.id}
                    </span>{' '}
                    {e.name}
                  </Link>
                  {e.status !== 'ready' && (
                    <span className="ml-2 rounded border border-line px-1.5 py-0.5 text-[10px] uppercase text-muted">
                      {e.status}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-xs tabular-nums text-muted">
                  {e.createdAt}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted">
                  {e.frames ? e.frames.toLocaleString() : '—'}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-ink/90">
                  {usd(e.cost.samUsd)}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-ink/90">
                  {e.cost.sparkUsd > 0 ? usd(e.cost.sparkUsd) : '—'}
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-sm tabular-nums text-ink">
                  {usd(e.cost.totalUsd)}
                  {e.cost.simulated && (
                    <span
                      className="ml-1.5 text-[10px] uppercase text-gold"
                      title="recorded fixtures — what this would have cost, not a charge"
                    >
                      sim
                    </span>
                  )}
                  {e.cost.projected && (
                    <span
                      className="ml-1.5 text-[10px] uppercase text-muted2"
                      title="no bill recorded for this run — frame charge only"
                    >
                      est
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-muted">
                  {e.cost.perKmUsd != null ? perKmLabel(e.cost.perKmUsd) : '—'}
                </td>
              </tr>
              {expanded === e.id && (
                <tr className="bg-bg/60">
                  <td colSpan={7} className="px-4 py-3">
                    <div className="grid gap-4 text-[11px] sm:grid-cols-2">
                      <div>
                        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">
                          Billed for this audit
                        </div>
                        <div className="font-mono tabular-nums text-ink/90">
                          {e.spend.frames.toLocaleString()} frames ·{' '}
                          {e.spend.requests} SAM request
                          {e.spend.requests === 1 ? '' : 's'} ·{' '}
                          {e.spend.classCalls} classification call
                          {e.spend.classCalls === 1 ? '' : 's'}
                        </div>
                        <div className="font-mono tabular-nums text-muted">
                          {e.spend.tokensIn.toLocaleString()} in /{' '}
                          {e.spend.tokensOut.toLocaleString()} out tokens
                        </div>
                      </div>
                      <div>
                        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">
                          Ledger rows
                        </div>
                        <ul className="space-y-1">
                          {e.spendRows.map((r, i) => (
                            <li key={i} className="flex gap-2 font-mono text-[10px]">
                              <span className="w-20 shrink-0 uppercase text-muted2">
                                {r.kind}
                              </span>
                              <span className="w-16 shrink-0 text-ink/90">
                                {usd(r.usd)}
                              </span>
                              <span className="truncate text-muted" title={r.detail}>
                                {r.detail}
                              </span>
                            </li>
                          ))}
                          {e.spendRows.length === 0 && (
                            <li className="font-mono text-[10px] text-muted2">
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
                  className="px-4 py-8 text-center text-sm text-muted"
                >
                  No audits yet — run one and its bill lands here.
                </td>
              </tr>
            )}
          </tbody>
          {entries.length > 0 && (
            <tfoot>
              <tr className="border-t border-line bg-surface2">
                <td className="px-4 py-3 text-[11px] uppercase tracking-wider text-muted">
                  All audits
                </td>
                <td />
                <td className="px-3 py-3 text-right tabular-nums text-muted">
                  {entries
                    .reduce((s, e) => s + e.frames, 0)
                    .toLocaleString()}
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-ink/90">
                  {usd(entries.reduce((s, e) => s + e.cost.samUsd, 0))}
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-ink/90">
                  {usd(entries.reduce((s, e) => s + e.cost.sparkUsd, 0))}
                </td>
                <td className="px-3 py-3 text-right font-mono text-sm font-medium tabular-nums text-ink">
                  {usd(rowsSumUsd)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs tabular-nums text-muted">
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
        <div className="panel p-4">
          <h2 className="label">
            Rate card
          </h2>
          <dl className="mt-2 space-y-1.5 text-xs text-muted">
            <div className="flex justify-between gap-3">
              <dt>SAM 3.1 segmentation</dt>
              <dd className="font-mono tabular-nums text-ink">
                {usd(SAM_USD_PER_1000_FRAMES, 2)} / 1,000 frames
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>Muse Spark input</dt>
              <dd className="font-mono tabular-nums text-ink">
                {usd(SPARK_USD_PER_1M_IN, 2)} / 1M tokens
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>Muse Spark output</dt>
              <dd className="font-mono tabular-nums text-ink">
                {usd(SPARK_USD_PER_1M_OUT, 2)} / 1M tokens
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>Transcode, stills, crops (ffmpeg)</dt>
              <dd className="font-mono tabular-nums text-good">
                $0.00 — local
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-[11px] leading-relaxed text-muted2">
            Analysis runs on a separate 10fps copy, so a 10-minute drive bills
            6,000 frames instead of 18,000.
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-gold/70">
            Estimate, not an invoice: every figure here is computed from
            today&apos;s published rates — which Meta can change — and from
            the ledger&apos;s own records. Treat the numbers as projections of
            what gets charged, not receipts.
          </p>
        </div>

        <div className="panel p-4">
          <h2 className="label">
            How to read this
          </h2>
          <ul className="mt-2 space-y-2 text-[11px] leading-relaxed text-muted">
            <li>
              <span className="text-muted">One row per charge.</span> Since
              the ledger began, SAM rows carry the frames Meta actually billed
              and Spark rows the real token counts; rows are written when the
              money moves, so a crash, a restart or a re-run cannot erase them.
            </li>
            {anySimulated && (
              <li>
                <span className="text-gold">Sim</span> rows never reached
                the API: they show what the run would have cost at published
                rates, not a charge.
              </li>
            )}
            {projected && (
              <li>
                <span className="text-muted">Est</span> rows finished without
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
