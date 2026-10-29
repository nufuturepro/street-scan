import { CHUNK_FRAMES, CHUNK_OVERLAP_FRAMES } from './config';

/**
 * Window math shared by the chunker and the fixture generator, so both agree
 * on exactly which global frames a chunk covers. They have to agree: the
 * fixture uses it to reproduce identical masks in the overlap region, which is
 * what lets the chunk-boundary merge be exercised without a live API.
 */
export type ChunkWindow = {
  chunkId: number;
  /** global frame index of the first frame in this chunk */
  start: number;
  /** global frame index one past the last frame */
  end: number;
};

export function chunkWindows(totalFrames: number): ChunkWindow[] {
  const stride = CHUNK_FRAMES - CHUNK_OVERLAP_FRAMES;
  if (totalFrames <= 0) return [];
  if (totalFrames <= CHUNK_FRAMES) return [{ chunkId: 0, start: 0, end: totalFrames }];

  const windows: ChunkWindow[] = [];
  let start = 0;
  let id = 0;
  while (start < totalFrames) {
    const end = Math.min(totalFrames, start + CHUNK_FRAMES);
    windows.push({ chunkId: id, start, end });
    if (end >= totalFrames) break;
    start += stride;
    id += 1;
  }
  return windows;
}

export function totalChunkBilledFrames(totalFrames: number): number {
  return chunkWindows(totalFrames).reduce((sum, w) => sum + (w.end - w.start), 0);
}
