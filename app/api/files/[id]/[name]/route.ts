import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { storageDir } from '@/lib/db';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; name: string }> };

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
};

/**
 * Streams derived media.
 *
 * Range support is mandatory, not a nicety: without 206 responses the browser
 * cannot seek, and the whole point of the inspection view is scrubbing to the
 * exact frame a hazard was flagged on.
 */
export async function GET(req: Request, ctx: Ctx) {
  const { id, name } = await ctx.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return new Response('bad id', { status: 400 });
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return new Response('bad name', { status: 400 });

  const file = path.join(storageDir('jobs', id), name);
  if (!existsSync(file)) return new Response('not found', { status: 404 });

  const stat = statSync(file);
  const total = stat.size;
  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.get('range');

  const baseHeaders: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  if (!range) {
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new Response(body, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(total) },
    });
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) return new Response('malformed range', { status: 416 });

  const start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : total - 1;
  if (Number.isNaN(start) || Number.isNaN(end)) return new Response('bad range', { status: 416 });
  if (start > end || start >= total) {
    return new Response('range not satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${total}` },
    });
  }
  end = Math.min(end, total - 1);

  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
  return new Response(body, {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(end - start + 1),
    },
  });
}
