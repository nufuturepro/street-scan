import { createReadStream, existsSync, renameSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { getDetection, getJob } from '@/lib/repo';
import { storageDir } from '@/lib/db';
import { extractFrame } from '@/lib/ffmpeg';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * One cached still per detection: the frame the hazard was found on, cut from
 * the job's playback video the first time anyone asks for it.
 *
 * Why on demand instead of during the pipeline - 57 detections would mean 57
 * ffmpeg passes on every run for images almost nobody opens, and the queue
 * only ever asks for the rows actually on screen (`loading="lazy"` does the
 * asking). Cost is one seek-and-decode per detection, once, forever; no model
 * API is involved, so it never touches the spend readout.
 *
 * The temporary name is derived from the output, so a retry after a failed
 * cut reuses it rather than littering the job folder, and the rename lands a
 * complete file where a second request can only ever see it whole.
 *
 * JPEG, not PNG: a photographic frame is ~880KB as PNG and ~150KB as JPEG at
 * ffmpeg's -q:v 2, and the queue asks for these one row at a time.
 */
const inflight = new Map<string, Promise<void>>();

/**
 * Returns once `out` exists. The path is passed in rather than built here so
 * the reads below stay statically scoped to the storage folder - a path that
 * arrives through a helper makes Turbopack treat the access as untraceable and
 * pull the whole project into the server bundle.
 */
async function ensureStill(source: string, out: string, tMs: number): Promise<void> {
  if (existsSync(out)) return;

  let pending = inflight.get(out);
  if (!pending) {
    pending = (async () => {
      const tmp = `${out}.${process.pid}.tmp.jpg`;
      await extractFrame(source, tMs / 1000, tmp);
      renameSync(tmp, out);
    })().finally(() => inflight.delete(out));
    inflight.set(out, pending);
  }
  await pending;
}

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const detectionId = Number(id);
  const detection = Number.isFinite(detectionId) ? getDetection(detectionId) : null;
  if (!detection) return new Response('not found', { status: 404 });

  const job = getJob(detection.jobId);
  if (!job?.playbackPath || !existsSync(job.playbackPath)) {
    return new Response('no playback for this audit yet', { status: 404 });
  }

  const out = path.join(storageDir('jobs', String(detection.jobId)), `still-${detection.id}.jpg`);

  try {
    await ensureStill(job.playbackPath, out, detection.tMs);
  } catch {
    return new Response('frame could not be cut', { status: 422 });
  }

  const stat = statSync(out);
  const body = Readable.toWeb(createReadStream(out)) as ReadableStream;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(stat.size),
      // Immutable per detection: the frame at a given tMs never changes.
      'Cache-Control': 'private, max-age=604800',
    },
  });
}
