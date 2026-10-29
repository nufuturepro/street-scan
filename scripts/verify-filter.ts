/**
 * Verification for the temporal filter and chunk-boundary merge.
 *
 * A 20-second clip fits in a single chunk, so the merge path never runs in a
 * normal demo. This constructs the case that actually matters: one hazard
 * straddling a seam, arriving as two different object IDs from two separate
 * API responses, plus transients that must be discarded.
 *
 * Run: npm run verify   (compiles this and verify-rqsi to .verify/ and runs them
 * in sequence; plain `node` fails because Node's type stripping does not resolve
 * this project's extensionless imports)
 */
import { chunkWindows } from '../lib/chunking';
import { resolveTracks, buildTracks, persists } from '../lib/filter';
import { ANALYSIS_FPS, CHUNK_FRAMES } from '../lib/config';
import type { TaggedFrame } from '../lib/filter';

const TOTAL = 7000; // frames at 10fps = 700s of footage
const windows = chunkWindows(TOTAL);

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok   - ${msg}`);
  }
}

/** A hazard that lives entirely inside one window. */
function persistentFrames(
  chunkId: number,
  globalStart: number,
  from: number,
  to: number,
  objectId: number
): TaggedFrame[] {
  const out: TaggedFrame[] = [];
  for (let f = from; f <= to; f++) {
    if (f < globalStart) continue;
    out.push({
      frameIndex: f,
      chunkId,
      objectId,
      score: 0.9,
      polygon: rect(0.4, 0.4, 0.1, 0.1),
    });
  }
  return out;
}

function rect(x: number, y: number, w: number, h: number): Array<[number, number]> {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

/* ---------------- fixture ---------------- */

const frames: TaggedFrame[] = [];

// 1. A hazard straddling the seam between chunk 0 and chunk 1.
//    Chunk 0 covers [0,3000), chunk 1 covers [2850,5850). Overlap = [2850,3000).
//    Object IDs deliberately differ per chunk, exactly as the real API behaves.
frames.push(...persistentFrames(0, 0, 2900, 2960, 0));
frames.push(...persistentFrames(1, 2850, 2900, 2960, 7));

// 2. A hazard entirely inside chunk 1 - must survive untouched.
frames.push(...persistentFrames(1, 2850, 3500, 3560, 3));

// 3. A hazard straddling the chunk 1 / chunk 2 seam.
frames.push(...persistentFrames(1, 2850, 5760, 5830, 11));
frames.push(...persistentFrames(2, 5700, 5760, 5830, 2));

// 4. Transients: a 4-frame flicker. Must be discarded by the frame-count test.
for (const f of [400, 401, 402, 403]) {
  frames.push({ frameIndex: f, chunkId: 0, objectId: 99, score: 0.95, polygon: rect(0.1, 0.1, 0.05, 0.05) });
}

// 5. A codec-noise burst: 6 contiguous frames = 500ms at 10fps.
//    Passes the frame-count test (>= 6) but must be discarded by duration (< 600ms).
for (let i = 0; i < 6; i++) {
  frames.push({
    frameIndex: 5000 + i,
    chunkId: 1,
    objectId: 97,
    score: 0.95,
    polygon: rect(0.7, 0.2, 0.05, 0.05),
  });
}

// 6. A long, sparse artifact: 8 frames spread across 560 seconds.
//    Both thresholds are satisfied, so the filter intentionally keeps it -
//    dense-and-long is the definition of persistent. Asserted to document it.
for (let i = 0; i < 8; i++) {
  frames.push({
    frameIndex: 1000 + i * 800,
    chunkId: 0,
    objectId: 98,
    score: 0.9,
    polygon: rect(0.8, 0.8, 0.05, 0.05),
  });
}

/* ---------------- assertions ---------------- */

console.log(`windows: ${JSON.stringify(windows)}`);
assert(windows.length === 3, '7000 frames split into 3 windows with overlap');

const built = buildTracks(frames, ANALYSIS_FPS);
assert(built.length === 8, `raw tracks grouped by (chunk, objectId) - got ${built.length}`);

const unresolved = built.filter(persists);
assert(
  unresolved.length === 6,
  `flicker killed by frame count, burst killed by duration - got ${unresolved.length} of 8`
);

const resolved = resolveTracks(frames, ANALYSIS_FPS);
assert(
  resolved.length === 4,
  `seam-crossing pairs merged into 4 hazards - got ${resolved.length}`
);

const seam = resolved.find((t) => t.firstFrame === 2900);
assert(!!seam, 'the hazard straddling the chunk 0/1 seam is present');
assert(
  seam!.frameCount === 61,
  `overlap duplicates collapsed so 61 frames count once - got ${seam?.frameCount}`
);
assert(seam!.spanMs === 6000, `span is 6.0s at 10fps - got ${seam?.spanMs}ms`);

const plain = resolved.find((t) => t.firstFrame === 3500);
assert(!!plain && plain.frameCount === 61, 'the in-chunk hazard survived unchanged');

const firsts = resolved.map((t) => t.firstFrame).sort((a, b) => a - b);
assert(
  JSON.stringify(firsts) === JSON.stringify([1000, 2900, 3500, 5760]),
  `exactly the expected hazards, no false merges - got ${JSON.stringify(firsts)}`
);

const sparse = resolved.find((t) => t.firstFrame === 1000);
assert(
  !!sparse && sparse.frameCount === 8 && sparse.spanMs === 560_000,
  `dense-and-long artifact is retained by design - got ${sparse?.frameCount} frames over ${sparse?.spanMs}ms`
);

console.log(
  process.exitCode ? '\nFAILED' : '\nAll filter assertions passed.'
);
