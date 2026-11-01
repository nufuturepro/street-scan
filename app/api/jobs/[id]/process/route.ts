import { getJob } from '@/lib/repo';
import { enqueue } from '@/lib/queue';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Enqueue a scan. JSON, not SSE: the run belongs to lib/queue.ts now, so any
 * page can read its progress and nobody has to hold a stream open for the job
 * to finish. Idempotent - enqueueing a job that is already queued or running
 * returns its place instead of starting a second pipeline over the same rows.
 *
 * Also the Retry button and the re-run path: a completed job enqueued again
 * re-runs (the pipeline replaces its detections rather than appending).
 */
export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const jobId = Number(id);
  const job = getJob(jobId);
  if (!job) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }
  if (!job.footagePath) {
    return Response.json({ error: 'job has no footage' }, { status: 409 });
  }

  return Response.json({ jobId, ...enqueue(jobId) });
}
