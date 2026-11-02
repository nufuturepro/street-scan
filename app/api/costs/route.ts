import { NextResponse } from 'next/server';
import { listJobs, readGps } from '@/lib/repo';
import { computeAuditCost, type AuditCost } from '@/lib/cost';
import { costTally } from '@/lib/meta';
import { clientMode } from '@/lib/config';
import { haversineM } from '@/lib/rqsi';
import { jobSpend, allSpend } from '@/lib/spend';

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
 * plus the lifetime spend from the `spend` table.
 *
 * Every entry's split comes from that table's rows - written at billing time,
 * so crashes, restarts and re-runs cannot erase them. `lifetime` is the truth
 * for the header: it also counts probes and other standalone calls, which bill
 * with no job attached, so it need not equal the sum of the rows below.
 */
export async function GET() {
  const jobs = listJobs();

  const entries: CostEntry[] = jobs.map((j) => {
    const gps = readGps(j.id);
    let distanceM = 0;
    for (let i = 1; i < gps.samples.length; i++) {
      distanceM += haversineM(gps.samples[i - 1], gps.samples[i]);
    }
    const spend = jobSpend(j.id);
    return {
      id: j.id,
      name: j.name,
      createdAt: j.createdAt,
      status: j.status,
      frames: j.frames,
      cost: computeAuditCost({
        frames: j.frames,
        analysisFps: j.analysisFps,
        billedUsd: spend.usd,
        spend,
        distanceM: distanceM > 0 ? distanceM : null,
        // A fixture run never reaches the API, so its row shows the projection.
        simulated: clientMode() === 'fixture',
      }),
    };
  });

  const tally = costTally();
  const lifetime = allSpend();

  return NextResponse.json({
    entries,
    lifetime,
    session: {
      frames: tally.frames,
      requests: tally.requests,
      samUsd: Number(tally.usd.toFixed(4)),
      classUsd: Number(tally.classUsd.toFixed(4)),
      classCalls: tally.classCalls,
      tokensIn: tally.tokensIn,
      tokensOut: tally.tokensOut,
      fixtureCalls: tally.fixtureCalls,
      usd: lifetime.usd,
      creditUsd: 150,
    },
  });
}
