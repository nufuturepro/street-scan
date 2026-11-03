import { NextResponse } from 'next/server';
import { listJobs, readGps } from '@/lib/repo';
import { computeAuditCost, type AuditCost } from '@/lib/cost';
import { costTally } from '@/lib/meta';
import { clientMode, HACKATHON_CREDIT_USD } from '@/lib/config';
import { haversineM } from '@/lib/rqsi';
import { jobSpend, jobSpendRows, allSpend, recordSpend } from '@/lib/spend';
import type { SpendRow, SpendTotals } from '@/lib/types';

export const dynamic = 'force-dynamic';

type CostEntry = {
  id: number;
  name: string;
  createdAt: string;
  status: string;
  frames: number;
  cost: AuditCost;
  /** this audit's ledger totals and rows, for the expandable detail view */
  spend: SpendTotals;
  spendRows: SpendRow[];
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
      spend,
      spendRows: jobSpendRows(j.id),
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
      creditUsd: HACKATHON_CREDIT_USD,
    },
  });
}

/**
 * The reconcile action - the redo the ledger cannot do itself. Meta exposes
 * no usage API, so the operator reads "free credits remaining" off the
 * Billing page and this appends the difference as one adjustment row.
 *
 * Append-only by design: the seed rows stay what the app claimed, this row
 * stays what Meta said, both remain visible, and a later reconciliation can
 * correct in either direction.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { creditsRemaining?: number };
  // typeof first: Number(null) is 0, which would read as "all credits gone".
  const remaining = typeof body.creditsRemaining === 'number' ? body.creditsRemaining : NaN;
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > HACKATHON_CREDIT_USD) {
    return NextResponse.json(
      { error: `creditsRemaining must be between 0 and ${HACKATHON_CREDIT_USD}` },
      { status: 400 }
    );
  }

  const before = allSpend().usd;
  const actual = Math.round((HACKATHON_CREDIT_USD - remaining) * 100) / 100;
  const delta = Math.round((actual - before) * 1e4) / 1e4;

  if (Math.abs(delta) < 0.0001) {
    return NextResponse.json({ ok: true, changed: false, delta: 0, lifetime: allSpend() });
  }

  recordSpend({
    kind: 'adjustment',
    usd: delta,
    detail:
      `reconciled ${new Date().toISOString().slice(0, 10)} against Meta billing: ` +
      `${HACKATHON_CREDIT_USD} - ${remaining.toFixed(2)} = ${actual.toFixed(2)} spent; ` +
      `ledger was ${before.toFixed(4)}`,
  });

  return NextResponse.json({ ok: true, changed: true, delta, lifetime: allSpend() });
}
