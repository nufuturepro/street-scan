import { NextResponse } from 'next/server';
import { listJobs, readGps } from '@/lib/repo';
import { computeAuditCost, type AuditCost } from '@/lib/cost';
import { costTally } from '@/lib/meta';
import { clientMode } from '@/lib/config';
import { haversineM } from '@/lib/rqsi';

export const dynamic = 'force-dynamic';

type CostEntry = {
  id: number;
  name: string;
  createdAt: string;
  status: string;
  frames: number;
  cost: AuditCost;
};

/**
 * The expense ledger behind the spend pill: one row per audit (the same
 * arithmetic the inspect-page meter runs, so the two can never disagree),
 * plus the session tally the header reports.
 *
 * The session total and the sum of rows legitimately differ: the tally counts
 * work in flight whose job row has not been written yet, and rows recorded
 * before the per-run fix carry an inflated bill. Both numbers are returned so
 * the page can show the difference instead of picking one.
 */
export async function GET() {
  const jobs = listJobs();

  const entries: CostEntry[] = jobs.map((j) => {
    const gps = readGps(j.id);
    let distanceM = 0;
    for (let i = 1; i < gps.samples.length; i++) {
      distanceM += haversineM(gps.samples[i - 1], gps.samples[i]);
    }
    return {
      id: j.id,
      name: j.name,
      createdAt: j.createdAt,
      status: j.status,
      frames: j.frames,
      cost: computeAuditCost({
        frames: j.frames,
        analysisFps: j.analysisFps,
        billedUsd: j.costEstimateUsd,
        distanceM: distanceM > 0 ? distanceM : null,
        // A fixture run never reaches the API, so its row shows the projection.
        simulated: clientMode() === 'fixture',
      }),
    };
  });

  const tally = costTally();

  // Same number the header pill reports: the session tally covers work in
  // flight, the persisted rows cover everything billed before a restart, and
  // a fresh process must not show $0.000 under a pill reading $5.138.
  const persisted = entries.reduce((sum, e) => sum + (e.cost.totalUsd || 0), 0);

  return NextResponse.json({
    entries,
    session: {
      frames: tally.frames,
      requests: tally.requests,
      samUsd: Number(tally.usd.toFixed(4)),
      classUsd: Number(tally.classUsd.toFixed(4)),
      classCalls: tally.classCalls,
      tokensIn: tally.tokensIn,
      tokensOut: tally.tokensOut,
      fixtureCalls: tally.fixtureCalls,
      usd: Number(Math.max(tally.totalUsd, persisted).toFixed(4)),
      creditUsd: 150,
    },
  });
}
