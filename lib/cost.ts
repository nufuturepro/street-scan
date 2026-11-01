/**
 * The per-audit cost ledger - the taxi meter.
 *
 * Pure arithmetic over figures the app already records, so the meter cannot
 * disagree with the spend pill in the header:
 *
 *   jobs.frames          analysis frames (10fps) SAM actually saw, set on transcode
 *   jobs.cost_estimate   what this run was billed, written when the run finishes
 *   the job's GPS track  metres driven, for the per-km figure
 *
 * Muse Spark has no per-job counter - tokens are tallied per process - so its
 * line is the residual: the run's bill minus the frame charge is exactly what
 * classification cost, because those two are the only things that are billed.
 * ffmpeg (transcode, stills, crops) costs nothing, which is why it gets a row:
 * showing $0.00 is the point of the row.
 *
 * Fixture runs never reach the API, so nothing is billed. The meter then shows
 * what the run *would* have cost off the frame count, labelled simulated - a
 * judge must never take a recorded response for a real charge.
 */
import { SAM_USD_PER_1000_FRAMES } from './config';

export type AuditUsage = {
  /** analysis frames (10fps) this run segmented */
  frames: number;
  analysisFps?: number;
  /** what the run was billed; 0 means fixture mode or a run that never finished */
  billedUsd?: number;
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
  const simulated = !!usage.simulated;
  const projected = !simulated && billed === 0 && frames > 0;

  // Frame charge is measured, never estimated: frames x the published rate.
  const samUsd = round((frames / 1000) * SAM_USD_PER_1000_FRAMES, 3);

  // Live and billed: trust the receipt, which already contains both legs.
  // Fixture or never-finished: the frame charge is all we can honestly claim.
  const totalUsd = simulated ? samUsd : billed > 0 ? Math.max(billed, samUsd) : samUsd;
  const sparkUsd = round(totalUsd - samUsd, 3);

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
        : `${frames} frames @ ${usd(SAM_USD_PER_1000_FRAMES, 2)} / 1,000`,
      usd: samUsd,
    },
    {
      label: 'Muse Spark',
      detail: simulated
        ? 'recorded fixtures · no API call'
        // Tokens are tallied per process, not per job, so this is the bill
        // minus the frame charge rather than a token count - which is exactly
        // what it is, and does not imply a precision we do not have.
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

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
