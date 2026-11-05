'use client';

import Link from 'next/link';
import {
  SAM_USD_PER_1000_FRAMES,
  SPARK_USD_PER_1M_IN,
  SPARK_USD_PER_1M_OUT,
} from '@/lib/config';
import { computeAuditCost, km, perKmLabel, usd } from '@/lib/cost';
import type { SpendTotals } from '@/lib/types';

type Props = {
  frames: number;
  analysisFps?: number;
  /** what this run was billed, from the spend ledger */
  billedUsd?: number;
  distanceM?: number | null;
  /** this audit's ledger rows - the exact split behind the line items */
  spend?: SpendTotals;
  /** true when the run served recorded fixtures rather than calling the API */
  simulated?: boolean;
  /** links the total through to this audit's row on /costs */
  jobId?: number;
};

/**
 * The audit's taxi meter: every line that can cost money, what it cost, and
 * what a kilometre of street costs to audit.
 *
 * It reads figures the pipeline already records - frames from the transcode,
 * the bill from the run, distance from the GPS track - and does no I/O of its
 * own, so the meter can never drift from the spend pill in the header. The
 * ffmpeg row is kept at $0.00 on purpose: "this stage is free" is half the
 * pitch of a 10fps analysis pipeline, and a number beats an adjective.
 */
export default function CostMeter({
  frames,
  analysisFps,
  billedUsd,
  distanceM,
  spend,
  simulated,
  jobId,
}: Props) {
  const cost = computeAuditCost({
    frames,
    analysisFps,
    billedUsd,
    distanceM,
    spend,
    simulated,
  });

  return (
    <div className="rounded-lg border border-line bg-surface/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted">
          Audit cost
        </h2>
        {cost.simulated && (
          <span className="rounded border border-gold/40 bg-gold/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gold">
            simulated
          </span>
        )}
      </div>

      <dl className="mt-2.5 space-y-1.5">
        {cost.lines.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0">
              <span className="text-xs text-muted">{row.label}</span>
              <span className="block truncate text-[10px] text-muted2">{row.detail}</span>
            </dt>
            <dd
              className={`shrink-0 font-mono text-xs tabular-nums ${
                row.usd > 0 ? 'text-ink' : 'text-muted2'
              }`}
            >
              {usd(row.usd)}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-2.5 flex items-end justify-between gap-3 border-t border-line pt-2.5">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted2">Total</div>
          <Link
            href={jobId != null ? `/costs#job-${jobId}` : '/costs'}
            className="text-2xl font-semibold tabular-nums text-ink hover:text-gold"
            title="full expense breakdown for every audit"
          >
            {usd(cost.totalUsd)} →
          </Link>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-muted2">Per km</div>
          <div className="text-sm tabular-nums text-ink">
            {cost.perKmUsd != null ? perKmLabel(cost.perKmUsd) : '—'}
          </div>
          <div className="text-[10px] text-muted2">
            {cost.distanceM != null ? `${km(cost.distanceM)} graded` : 'no GPS track'}
          </div>
        </div>
      </div>

      <p className="mt-2 border-t border-line pt-1.5 text-[10px] leading-relaxed text-muted2">
        {cost.simulated
          ? 'Recorded fixtures - what this run would have cost at published rates, not a charge.'
          : cost.projected
            ? 'No bill recorded for this run, so the total is the frame charge only.'
            : 'Billed: frame charge plus classification. Transcoding is local and free.'}{' '}
        Rates: SAM {usd(SAM_USD_PER_1000_FRAMES, 2)}/1k frames · Spark{' '}
        {usd(SPARK_USD_PER_1M_IN, 2)}/1M in, {usd(SPARK_USD_PER_1M_OUT, 2)}/1M out{' '}
        — estimates at those rates, not an invoice.
      </p>
    </div>
  );
}
