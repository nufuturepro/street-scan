import { runJob, type Progress } from '@/lib/pipeline';
import { getJob } from '@/lib/repo';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

type Ctx = { params: Promise<{ id: string }> };

/**
 * Runs the pipeline and streams progress as Server-Sent Events.
 *
 * SSE rather than a polling endpoint: a 10-minute clip takes real time, and
 * chunk-by-chunk progress is what makes the inspection page feel alive before
 * the job has finished. The client just appends detections as they land.
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

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: Progress | { stage: 'connected' }) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          /* client disconnected; the job still finishes server-side */
        }
      };

      send({ stage: 'connected' } as unknown as Progress);

      try {
        await runJob(jobId, (p) => send(p));
      } catch (err) {
        send({
          stage: 'failed',
          done: 0,
          total: 0,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
