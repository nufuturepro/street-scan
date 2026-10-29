import { NextResponse } from 'next/server';
import { getJob, listDetections, detectionCounts, readGps, updateJob, deleteJob } from '@/lib/repo';
import { costTally } from '@/lib/meta';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const jobId = Number(id);
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const gps = readGps(jobId);
  return NextResponse.json({
    job,
    detections: listDetections(jobId),
    counts: detectionCounts(jobId),
    gps: { source: gps.source, samples: gps.samples.length },
    cost: costTally(),
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
