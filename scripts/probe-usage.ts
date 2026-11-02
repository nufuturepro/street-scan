/**
 * One cheap live request to settle what the rate card only implies:
 *
 *   1. does usage.video_frames_processed actually arrive on SAM's stream?
 *   2. does SAM bill our 10fps analysis copy at 10fps (Assumption A in the
 *      README), or resample and charge 3x?
 *
 * 50 frames is SAM's billing floor - 5 seconds at 10fps, about one cent at
 * $0.20/1,000. The spend row this leaves behind (job_id NULL) doubles as a
 * live check of the ledger write path, and lands in the lifetime total on
 * /costs where the sum of per-audit rows cannot see it.
 *
 *   npx tsx scripts/probe-usage.ts [path-to-analysis.mp4]
 *
 * No argument: the newest ready job's analysis video. Run it where the key
 * and the database live (the server), not on a machine with fixture mode.
 */
import path from 'node:path';
import { rmSync } from 'node:fs';
import { getMetaClient } from '../lib/meta';
import { sliceSegment, tmpDir } from '../lib/ffmpeg';
import { allSpend } from '../lib/spend';
import { db } from '../lib/db';
import { SAM_USD_PER_1000_FRAMES } from '../lib/config';

/** SAM's billing floor: 5 s at 10 fps, ~$0.01. */
const FRAMES = 50;
const PROMPT = 'pothole';

async function main(): Promise<void> {
  const arg = process.argv[2];
  const picked = (arg
    ? { analysis_path: arg }
    : (db()
        .prepare(
          `SELECT analysis_path FROM jobs
           WHERE analysis_path IS NOT NULL AND status = 'ready'
           ORDER BY id DESC LIMIT 1`
        )
        .get() as { analysis_path: string } | undefined)) as
    | { analysis_path: string }
    | undefined;
  if (!picked?.analysis_path) {
    throw new Error(
      'no analysis video found - pass one: npx tsx scripts/probe-usage.ts <path>'
    );
  }

  const client = await getMetaClient();
  if (client.mode !== 'live') {
    console.log(`client mode is '${client.mode}' - nothing live to probe`);
    process.exitCode = 1;
    return;
  }

  const chunk = path.join(tmpDir(), `probe-usage-${Date.now()}.mp4`);
  await sliceSegment(picked.analysis_path, chunk, 0, FRAMES / 10);

  const before = allSpend();
  let billed = 0;
  try {
    await client.segment({
      filePath: chunk,
      frameCount: FRAMES,
      globalStartFrame: 0,
      chunkId: 0,
      totalFrames: FRAMES,
      prompt: PROMPT,
      onFrame: () => {},
      onBilled: (n) => {
        billed = n;
      },
    });
  } finally {
    rmSync(chunk, { force: true });
  }

  const after = allSpend();
  const last = db()
    .prepare(`SELECT frames, usd, detail FROM spend ORDER BY id DESC LIMIT 1`)
    .get() as { frames: number; usd: number; detail: string | null } | undefined;
  const viaUsage = (last?.detail ?? '').includes('provider usage');
  const ratio = billed / FRAMES;

  console.log(`sent   : ${FRAMES} frames (5 s at 10 fps)`);
  console.log(
    `billed : ${billed} frames = $${((billed / 1000) * SAM_USD_PER_1000_FRAMES).toFixed(4)}`
  );
  console.log(
    `ledger : +${after.frames - before.frames} frames, +$${(after.usd - before.usd).toFixed(4)} ` +
      `(${last?.detail ?? 'NO ROW WRITTEN'})`
  );

  if (after.usd <= before.usd) {
    console.log('FAIL: the ledger recorded nothing - recordSpend did not write');
    process.exitCode = 1;
    return;
  }
  if (!viaUsage) {
    console.log(
      'usage NOT parsed: the billed number above is our own frame count, ' +
        'so Assumption A stays open'
    );
    process.exitCode = 1;
    return;
  }
  if (Math.abs(ratio - 1) < 0.05) {
    console.log('ASSUMPTION A HOLDS: SAM billed our 10 fps frames 1:1');
  } else {
    console.log(
      `ASSUMPTION A BROKEN: billed ${ratio.toFixed(2)}x our frames - SAM resampled`
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});