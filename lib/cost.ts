/**
 * The per-audit cost ledger - the taxi meter.
 *
 * Pure arithmetic over figures the app already records, so the meter cannot
 * disagree with the spend pill in the header:
 *
 *   jobs.frames          analysis frames (10fps) SAM actually saw, set on transcode
 *   the spend ledger     every billed event: SAM frames, Spark tokens, exact $
 *   the job's GPS track  metres driven, for the per-km figure
 *
 * The split is exact when the caller has read `spend` - every request that was
 * charged has a row, so the parts add up with no residual to reconcile. Without
 * it (a fixture run, a projection), the old derivation stands: frame charge at
 * the published rate, Spark as whatever the bill minus that charge comes to,
 * because those two are the only things that are billed. ffmpeg (transcode,
 * stills, crops) costs nothing, which is why it gets a row: showing $0.00 is
 * the point of the row.
 *
 * Fixture runs never reach the API, so nothing is billed. The meter then shows
 * what the run *would* have cost off the frame count, labelled simulated - a
 * judge must never take a recorded response for a real charge.
 */
import { SAM_USD_PER_1000_FRAMES } from './config';
import type { SpendTotals } from './types';

export type AuditUsage = {
  /** analysis frames (10fps) this run segmented */
  frames: number;
  analysisFps?: number;
  /** what the run was billed; 0 means fixture mode or a run that never finished */
  billedUsd?: number;
  /** the job's ledger rows - the exact split, used whenever a bill exists */
  spend?: SpendTotals;
  distanceM?: number | null;
  /** true when the run served recorded fixtures */
  simulated?: boolean;
};

export type CostRow = {
  label: string;
  /** the rate card line under the label - what the number is made of */
  detail: string;
  usd: number;
};

export type AuditCost = {
  /** line items, in meter order; the total is separate */
  lines: CostRow[];
  totalUsd: number;
  samUsd: number;
  sparkUsd: number;
  distanceM: number | null;
  perKmUsd: number | null;
  simulated: boolean;
  /** billed 0 on a live run: the total is a projection, not a receipt */
  projected: boolean;
};

/** $1.437 - three places, because a whole audit is a dollar-scale number. */
export const usd = (n: number, dp = 3) => `$${n.toFixed(dp)}`;
export const km = (m: number) => `${(m / 1000).toFixed(2)} km`;
export const perKmLabel = (n: number) => `$${n.toFixed(2)}/km`;

export function computeAuditCost(usage: AuditUsage): AuditCost {
  const frames = Math.max(0, Math.round(usage.frames || 0));
  const billed = Math.max(0, usage.billedUsd ?? 0);
  // A job with a real bill is real whatever the current mode says: fixtures
  // never write spend rows, so billed > 0 means live money moved.
  const simulated = !!usage.simulated && billed === 0;
  const projected = !simulated && billed === 0 && frames > 0;
  // Exact only when there is a bill to be exact about: a job with no spend
  // rows still needs the projection path, not a row of $0.000 zeros.
  const exact = usage.spend !== undefined && billed > 0;
  const spend = usage.spend;

  // Frame charge: the ledger's own figure when the caller read `spend`, else
  // the old derivation - frames x the published rate, never estimated twice.
  const samUsd = exact
    ? round(spend?.samUsd ?? 0, 3)
    : round((frames / 1000) * SAM_USD_PER_1000_FRAMES, 3);
  const samFrames = exact ? Math.max(0, spend?.frames ?? frames) : frames;

  let totalUsd: number;
  let sparkUsd: number;
  if (exact) {
    // Every row was written when its request was charged, so the parts add up
    // with no residual and no max() reconciliation.
    sparkUsd = round(spend?.sparkUsd ?? Math.max(0, billed - samUsd), 3);
    totalUsd = round(samUsd + sparkUsd, 3);
  } else if (simulated) {
    totalUsd = samUsd; // projections never mix with real spend
    sparkUsd = 0;
  } else if (billed > 0) {
    // Live and billed without a split: trust the receipt over the estimate.
    totalUsd = Math.max(billed, samUsd);
    sparkUsd = round(totalUsd - samUsd, 3);
  } else {
    totalUsd = samUsd; // known frames, no bill recorded: the frame charge is all we can claim
    sparkUsd = 0;
  }

  const distanceM = usage.distanceM && usage.distanceM > 0 ? usage.distanceM : null;
  const perKmUsd = distanceM ? round(totalUsd / (distanceM / 1000), 3) : null;

  const fps = usage.analysisFps ?? 10;
  const lines: CostRow[] = [
    {
      label: 'Ingest & transcode',
      detail: `${frames} frames @ ${fps}fps · local ffmpeg`,
      usd: 0,
    },
    {
      label: 'SAM 3.1',
      detail: simulated
        ? `${frames} frames · ${usd(SAM_USD_PER_1000_FRAMES, 2)}/1k applied`
        : `${samFrames} frames @ ${usd(SAM_USD_PER_1000_FRAMES, 2)} / 1,000`,
      usd: samUsd,
    },
    {
      label: 'Muse Spark',
      detail: simulated
        ? 'recorded fixtures · no API call'
        : exact && (spend?.tokensIn || spend?.tokensOut)
          ? `${count(spend?.tokensIn)} in / ${count(spend?.tokensOut)} out tokens`
          : 'billed, less the frame charge',
      usd: sparkUsd,
    },
  ];

  return {
    lines,
    totalUsd,
    samUsd,
    sparkUsd,
    distanceM,
    perKmUsd,
    simulated,
    projected,
  };
}

/** 12480 -> "12,480"; the token line should read like a receipt, not a float. */
function count(n: number | undefined): string {
  return (n ?? 0).toLocaleString('en-US');
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
