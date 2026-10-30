/**
 * Which concrete nouns does SAM actually return boxes for?
 *
 * lib/taxonomy.ts refuses to widen the prompt list by guesswork: measured on
 * this project's own footage, 'damaged road surface' and 'crack in the road'
 * both return 0 boxes while 'pothole' returns 260, and comma lists return
 * nothing at all. So a candidate obstruction prompt has to earn its place by
 * finding boxes in real video before it costs anything per clip - one more
 * prompt is one more request per chunk on every future run.
 *
 * This probes N candidates against ONE sliced chunk, reports boxes and
 * frames-hit per prompt, and writes a cropped PNG of the largest box each
 * prompt found to the system temp dir - because "returned 260 boxes" says
 * nothing about whether those boxes are cars or tree trunks. Read the crops.
 *
 * Run (same flags as the verify scripts, which is why plain `node` cannot run
 * this file's extensionless imports):
 *
 *   npx tsc scripts/probe-prompts.ts --outDir .probe --module commonjs \
 *     --target es2021 --moduleResolution node --esModuleInterop \
 *     --skipLibCheck --strict false \
 *     && node .probe/scripts/probe-prompts.js [video] [seconds]
 *
 * Defaults: storage/jobs/4/analysis.mp4, 30 s (300 frames at ANALYSIS_FPS).
 * At SAM_USD_PER_1000_FRAMES that is $0.06 per candidate - except the billing
 * floor is 500 frames per request, so in practice each candidate costs $0.10.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ANALYSIS_FPS, SAM_USD_PER_1000_FRAMES } from '../lib/config';
import { costTally, getMetaClient } from '../lib/meta';
import { countFrames, cropToMask, sliceSegment, tmpDir } from '../lib/ffmpeg';
import type { Polygon, SamFrame } from '../lib/types';

/**
 * One concrete noun each - the rule taxonomy.ts measured, not a phrase.
 *
 * `car` is the control: taxonomy.ts already measured 260 boxes for it on our
 * footage, so a run where it finds nothing means the clip or the API is broken
 * rather than that the word is wrong. The rest are the obstruction battery.
 *
 * A zero is ambiguous on its own - it means either "SAM cannot see this word"
 * or "this clip contains no pallets" - so a zero has to be re-checked on
 * footage that plausibly contains the object before the prompt is dropped.
 * Pass the list as the fourth argument to do that:   ... [video] [seconds] [a,b,c]
 */
const DEFAULT_CANDIDATES = 'car,truck,van,parked car,barrel,pallet';
const CANDIDATES = (process.argv[4] ?? DEFAULT_CANDIDATES)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Next's env loader, standalone: getMetaClient() reads process.env only. */
function loadEnv(): void {
  const file = path.join(process.cwd(), '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function area(p: Polygon): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

async function main(): Promise<void> {
  loadEnv();

  const video = process.argv[2] ?? path.join('storage', 'jobs', '4', 'analysis.mp4');
  const seconds = Number(process.argv[3] ?? 30);
  if (!existsSync(video)) {
    console.error(`no such video: ${video}`);
    process.exitCode = 1;
    return;
  }

  const chunk = path.join(tmpDir(), `probe-${Date.now()}.mp4`);
  await sliceSegment(video, chunk, 0, seconds);
  const frameCount = await countFrames(chunk);
  console.log(`\n# probing ${CANDIDATES.length} candidates on ${path.basename(video)}`);
  console.log(`  ${frameCount} frames (${seconds}s) in ${chunk}\n`);

  const client = await getMetaClient();
  if (client.mode !== 'live') {
    console.error(`refusing to probe in ${client.mode} mode: ${client.notice ?? ''}`);
    process.exitCode = 1;
    return;
  }

  const rows: Array<{
    prompt: string;
    boxes: number;
    hits: number;
    bestArea: number;
    crop: string | null;
    /** every frame this prompt hit, so overlap between prompts is visible */
    frames: number[];
  }> = [];

  for (const prompt of CANDIDATES) {
    let boxes = 0;
    let best: SamFrame | null = null;
    const hitFrames = new Set<number>();

    await client.segment({
      filePath: chunk,
      frameCount,
      globalStartFrame: 0,
      chunkId: 0,
      totalFrames: frameCount,
      prompt,
      onFrame: (f) => {
        boxes += 1;
        hitFrames.add(f.frameIndex);
        if (!best || area(f.polygon) > area(best.polygon)) best = f;
      },
    });

    // One crop of the largest box: the visual check that numbers cannot give.
    // Boxes often run past the frame edge - SAM returns coordinates outside
    // 0..1 - and an unclamped bbox makes ffmpeg refuse the crop, which kills
    // the whole probe after it has already paid for the request. Clamp, and
    // treat a failed crop as "no preview", never as "no boxes".
    let crop: string | null = null;
    if (best) {
      const b = best as SamFrame;
      const clamped: Polygon = b.polygon.map(([x, y]) => [
        Math.min(1, Math.max(0, x)),
        Math.min(1, Math.max(0, y)),
      ]);
      const out = path.join(tmpDir(), `probe-${prompt.replace(/\s+/g, '-')}.png`);
      try {
        await cropToMask(chunk, b.frameIndex / ANALYSIS_FPS, clamped, out);
        crop = out;
      } catch {
        crop = null;
      }
    }

    rows.push({
      prompt,
      boxes,
      hits: hitFrames.size,
      bestArea: best ? area((best as SamFrame).polygon) : 0,
      crop,
      frames: [...hitFrames].sort((a, b) => a - b),
    });
  }

  const width = Math.max(...rows.map((r) => r.prompt.length));
  console.log('prompt'.padEnd(width) + '  boxes  frames-hit  largest-box');
  for (const r of rows) {
    console.log(
      r.prompt.padEnd(width) +
        `  ${String(r.boxes).padStart(5)}  ` +
        `${`${r.hits}/${frameCount}`.padStart(10)}  ` +
        `${(r.bestArea * 100).toFixed(1).padStart(10)}%`
    );
  }

  const t = costTally();
  console.log(
    `\ncost: ${t.requests} requests, ${t.frames} frames, $${t.usd.toFixed(4)} ` +
      `(=$${SAM_USD_PER_1000_FRAMES}/1k frames)`
  );

  // Is a second vehicle prompt worth its own request per chunk? Only if it
  // finds frames the control did not - two prompts hitting the same frames
  // buy nothing but a second upload.
  const control = rows[0];
  if (control && rows.length > 1) {
    const seen = new Set(control.frames);
    console.log(`\noverlap against "${control.prompt}" (the first candidate):`);
    for (const r of rows.slice(1)) {
      const extra = r.frames.filter((f) => !seen.has(f)).length;
      console.log(
        `  ${r.prompt}: hits ${r.hits} frames, ${extra} of them NOT already hit by "${control.prompt}"`
      );
    }
  }

  console.log('crops:');
  for (const r of rows) {
    console.log(`  ${r.prompt}: ${r.crop ?? (r.boxes ? '(crop failed)' : '(no boxes)')}`);
  }

  writeFileSync(
    path.join(tmpDir(), 'probe-result.json'),
    JSON.stringify(rows, null, 2)
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
