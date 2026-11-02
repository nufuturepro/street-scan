import path from 'node:path';
import { ANALYSIS_FPS } from './config';
import { chunkWindows } from './chunking';
import { getMetaClient, costTally, type MetaClient } from './meta';
import { sliceSegment, tmpDir } from './ffmpeg';
import type { TaggedFrame } from './filter';
import { SAM_PROMPTS } from './taxonomy';

/**
 * The detection stage: split the analysis video into overlapping windows and
 * ask SAM 3.1 for open-vocabulary masks in each.
 *
 * Why overlapping windows at all:
 *   - the API caps a request at 15,000 frames, and a 10-minute drive is 6,000
 *     at 10fps, so long footage must be split anyway
 *   - processing chunk-by-chunk lets the inspection UI populate while later
 *     chunks are still running, which is where the "live" feel comes from
 *   - the overlap is what makes reconciliation across a seam possible at all
 *
 * One concrete noun per request, one request per prompt per chunk: the API has
 * no multi-concept syntax (comma lists return zero matches), so coverage widens
 * by asking again rather than by lengthening the prompt. Every frame carries
 * which prompt asked for it, so the filter can tell a second opinion from a
 * second hazard. SAM detects generically, Muse Spark classifies specifically.
 */

export type SegmentationResult = {
  frames: TaggedFrame[];
  chunks: number;
  notice: string | null;
  clientMode: 'live' | 'fixture';
  cost: ReturnType<typeof costTally>;
};

export async function runSegmentation(opts: {
  analysisPath: string;
  totalFrames: number;
  fps?: number;
  prompt?: string;
  /** audit these frames belong to; its spend rows hang off it */
  jobId?: number;
  onProgress?: (doneChunks: number, totalChunks: number) => void;
}): Promise<SegmentationResult> {
  const fps = opts.fps ?? ANALYSIS_FPS;
  const prompts: readonly string[] = opts.prompt ? [opts.prompt] : SAM_PROMPTS;
  const windows = chunkWindows(opts.totalFrames);
  const client: MetaClient = await getMetaClient();

  const frames: TaggedFrame[] = [];
  const totalRequests = prompts.length * windows.length;
  let doneRequests = 0;

  for (let p = 0; p < prompts.length; p++) {
    const prompt = prompts[p];

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const frameCount = w.end - w.start;
      if (frameCount <= 0) {
        doneRequests++;
        continue;
      }

      // Fixtures never need a physical chunk file; live does, to upload.
      // The prompt index is in the temp name too: both passes slice the same
      // source back to back, so the old name would have collided.
      let filePath = opts.analysisPath;
      if (client.mode === 'live') {
        const chunkFile = path.join(
          tmpDir(),
          `chunk-${Date.now()}-${p}-${w.chunkId}.mp4`
        );
        await sliceSegment(
          opts.analysisPath,
          chunkFile,
          w.start / fps,
          frameCount / fps
        );
        filePath = chunkFile;
      }

      await client.segment({
        filePath,
        frameCount,
        globalStartFrame: w.start,
        chunkId: w.chunkId,
        totalFrames: opts.totalFrames,
        prompt,
        jobId: opts.jobId,
        onFrame: (f) => frames.push({ ...f, chunkId: w.chunkId, promptIdx: p }),
        onBilled: () => {
          /* cost is accumulated centrally in meta.ts */
        },
      });

      doneRequests++;
      opts.onProgress?.(doneRequests, totalRequests);
    }
  }

  frames.sort((a, b) => a.frameIndex - b.frameIndex);

  return {
    frames,
    chunks: windows.length,
    notice: client.notice,
    clientMode: client.mode,
    cost: costTally(),
  };
}
