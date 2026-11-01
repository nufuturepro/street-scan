import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { NextResponse } from 'next/server';
import { storageDir } from '@/lib/db';
import { createJob, getJob, listJobs, updateJob } from '@/lib/repo';
import { enqueue, progressOf } from '@/lib/queue';

export const dynamic = 'force-dynamic';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.insv']);

function safeExt(raw: string | null): string {
  const ext = (raw ?? '').toLowerCase();
  if (!VIDEO_EXT.has(ext)) return '.mp4';
  return ext;
}

/**
 * Raw streamed upload.
 *
 * Deliberately not multipart: Next's request.formData() buffers the whole body
 * in memory, and a 10-minute 4K clip will take the dev server down with it.
 * The client sends the File straight through, we pipe bytes to disk.
 *
 * Two calls share this route:
 *   POST                -> the footage; creates the job
 *   POST?id=N&role=gps  -> the original recording, kept only for its GPS track.
 *                          The flattened export measures 0 GPS tags vs
 *                          701 in the source, so the two must travel apart.
 *
 * Both enqueue the scan when they finish. The footage call honours
 * `autostart=0`, which the uploader sends when a GPS source is still to come:
 * starting the pipeline before that second upload lands would make it read
 * GPS from the flattened file and find none. The GPS call enqueues on either
 * outcome - a failed GPS attach degrades to a manual pin, not a stuck job.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const ext = safeExt(url.searchParams.get('ext'));

  if (!request.body) {
    return NextResponse.json({ error: 'empty body' }, { status: 400 });
  }

  const stream = async (dest: string): Promise<number> => {
    const write = createWriteStream(dest);
    await pipeline(Readable.fromWeb(request.body as import('node:stream/web').ReadableStream), write);
    const { size } = await stat(dest);
    if (size === 0) throw new Error('uploaded file is empty');
    return size;
  };

  /* ---- second call: GPS source attached to an existing job ---- */
  if (url.searchParams.get('role') === 'gps') {
    const id = Number(url.searchParams.get('id'));
    const job = Number.isFinite(id) ? getJob(id) : null;
    if (!job) return NextResponse.json({ error: 'unknown job' }, { status: 404 });

    const dest = path.join(storageDir('jobs', String(id)), `source${ext}`);
    try {
      const size = await stream(dest);
      updateJob(id, { gps_path: dest });
      const queue = enqueue(id);
      return NextResponse.json({ id, gpsPath: dest, bytes: size, ...queue });
    } catch (err) {
      // A failed GPS attach never blocks the job: it degrades to a manual map
      // pin, which the pipeline already handles. It still scans.
      const message = err instanceof Error ? err.message : String(err);
      enqueue(id);
      return NextResponse.json({ id, error: message }, { status: 500 });
    }
  }

  /* ---- first call: the footage ---- */
  const name = url.searchParams.get('name')?.slice(0, 120) || 'Untitled clip';
  const autostart = url.searchParams.get('autostart') !== '0';
  const id = createJob(name);
  const dest = path.join(storageDir('jobs', String(id)), `footage${ext}`);

  try {
    const bytes = await stream(dest);
    updateJob(id, { footage_path: dest, status: 'ingested' });
    const queue = autostart
      ? enqueue(id)
      : { queued: false, position: 0, deferred: true } as const;
    return NextResponse.json({ id, name, bytes, path: dest, ...queue });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateJob(id, { status: 'failed', error: message });
    return NextResponse.json({ id, error: message }, { status: 500 });
  }
}

/** Job list with a live queue snapshot on each row. */
export async function GET() {
  return NextResponse.json({
    jobs: listJobs().map((j) => ({ ...j, progress: progressOf(j.id) })),
  });
}
