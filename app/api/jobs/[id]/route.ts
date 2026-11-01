import { NextResponse } from 'next/server';
import { getJob, listDetections, detectionCounts, readGps, updateJob, deleteJob } from '@/lib/repo';
import { costTally } from '@/lib/meta';
import { clientMode } from '@/lib/config';
import { haversineM } from '@/lib/rqsi';
import { progressOf } from '@/lib/queue';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const jobId = Number(id);
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const gps = readGps(jobId);

  // Distance is arithmetic over samples already read for the count above - no
  // extra query and no stored column - and it is what turns the meter's total
  // into a per-kilometre figure. Below two fixes there is no track to measure.
  let distanceM = 0;
  for (let i = 1; i < gps.samples.length; i++) {
    distanceM += haversineM(gps.samples[i - 1], gps.samples[i]);
  }

  return NextResponse.json({
    job,
    detections: listDetections(jobId),
    counts: detectionCounts(jobId),
    gps: { source: gps.source, samples: gps.samples.length },
    distanceM: distanceM > 0 ? Number(distanceM.toFixed(1)) : null,
    mode: clientMode(),
    cost: costTally(),
    // Live queue snapshot: null once the job is idle. This is what the audit
    // page polls instead of holding an SSE stream of its own.
    progress: progressOf(jobId),
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const jobId = Number(id);
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  if (body.name) updateJob(jobId, { name: String(body.name).slice(0, 120) });
  return NextResponse.json({ job: getJob(jobId) });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  deleteJob(Number(id));
  return NextResponse.json({ ok: true });
}
