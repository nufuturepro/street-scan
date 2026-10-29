import { readFileSync, existsSync } from 'node:fs';
import { TAXONOMY } from './taxonomy';
import type { Classification, HazardType, Polygon, SamFrame } from './types';
import type { ClassifyRequest, SegmentRequest } from './meta';

/**
 * Deterministic recorded responses.
 *
 * Why this exists: the Meta Model API currently returns 402
 * `billing_not_configured`, so nothing can be built against a live call. These
 * fixtures are not random noise - they are constructed to be *adversarial* for
 * the parts of the pipeline we most need to trust:
 *
 *   - a few persistent hazards that must survive the filter
 *   - a few 2-4 frame transients that must be killed by it
 *   - object IDs that are deliberately different in each overlapping chunk
 *     (matching Meta's documented "IDs are not stable across responses"), so
 *     the chunk-boundary merge has to actually do its job
 *
 * Everything is a pure function of (totalFrames, chunkId, globalFrame), so
 * re-running a job reproduces byte-identical detections.
 */

/* ---------------- deterministic PRNG ---------------- */

function hash(...parts: (string | number)[]): number {
  let h = 2166136261;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- virtual hazards ---------------- */

type VirtualHazard = {
  index: number;
  start: number;
  end: number;
  cx: number;
  cy: number;
  r: number;
  driftX: number;
  driftY: number;
  transient: boolean;
  kind: HazardType;
};

const KINDS: HazardType[] = ['pothole', 'pothole', 'cave_in', 'crack', 'blocked_lane', 'debris'];

const hazardCache = new Map<number, VirtualHazard[]>();

function virtualHazards(totalFrames: number): VirtualHazard[] {
  const cached = hazardCache.get(totalFrames);
  if (cached) return cached;

  const rng = mulberry32(hash('hazards', totalFrames));
  const out: VirtualHazard[] = [];

  const persistent = Math.max(3, Math.min(6, Math.floor(totalFrames / 200) + 3));
  for (let i = 0; i < persistent; i++) {
    const start = Math.floor(rng() * totalFrames * 0.75);
    const len = 60 + Math.floor(rng() * 120); // 6-18s at 10fps
    const end = Math.min(totalFrames - 1, start + len);
    out.push({
      index: i,
      start,
      end,
      cx: 0.15 + rng() * 0.7,
      cy: 0.3 + rng() * 0.4,
      r: 0.05 + rng() * 0.06,
      driftX: (rng() - 0.5) * 0.0006,
      driftY: (rng() - 0.5) * 0.0003,
      transient: false,
      kind: KINDS[i % KINDS.length],
    });
  }

  // Transients: glare flicker, a bird, a codec block. The filter must kill all
  // of these - they are the whole reason MIN_PERSISTENT_FRAMES exists.
  for (let i = 0; i < 3; i++) {
    const start = Math.floor(rng() * totalFrames * 0.9);
    const end = Math.min(totalFrames - 1, start + 2 + Math.floor(rng() * 2)); // 3-4 frames
    out.push({
      index: persistent + i,
      start,
      end,
      cx: 0.1 + rng() * 0.8,
      cy: 0.1 + rng() * 0.8,
      r: 0.03 + rng() * 0.05,
      driftX: (rng() - 0.5) * 0.01,
      driftY: (rng() - 0.5) * 0.01,
      transient: true,
      kind: 'debris',
    });
  }

  hazardCache.set(totalFrames, out);
  return out;
}

/** Shape is a pure function of (hazardIndex, globalFrame) - never of chunk. */
function polygonFor(h: VirtualHazard, frame: number): Polygon {
  const cx = h.cx + h.driftX * (frame - h.start);
  const cy = h.cy + h.driftY * (frame - h.start);
  const pts: Polygon = [];
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const jitter = mulberry32(hash('pt', h.index, i))() * 0.35 - 0.175;
    const rr = h.r * (1 + jitter);
    pts.push([
      Math.min(1, Math.max(0, cx + Math.cos(angle) * rr)),
      Math.min(1, Math.max(0, cy + Math.sin(angle) * rr * 1.15)),
    ]);
  }
  return pts;
}

/**
 * Produce every frame this chunk reports on.
 *
 * Note the deliberate per-chunk object ID offset: a hazard straddling a seam
 * arrives as two different IDs in two responses, exactly as it would from the
 * real API. If filter.ts's merge is broken, this fixture will show it.
 */
export function streamFixtureFrames(req: SegmentRequest): SamFrame[] {
  const { globalStartFrame: start, frameCount, chunkId, totalFrames } = req;
  const probeEnd = Math.min(totalFrames, start + frameCount);
  const hazards = virtualHazards(totalFrames);
  const frames: SamFrame[] = [];

  for (const h of hazards) {
    const from = Math.max(start, h.start);
    const to = Math.min(probeEnd, h.end);
    for (let f = from; f <= to; f++) {
      // Fixtures mirror real SAM: each response numbers its own objects.
      const objectId = chunkId * 100 + h.index;
      frames.push({
        frameIndex: f,
        objectId,
        score: h.transient ? 0.42 : 0.8 + mulberry32(hash('sc', h.index, f))() * 0.19,
        polygon: polygonFor(h, f),
      });
    }
  }

  frames.sort((a, b) => a.frameIndex - b.frameIndex);
  return frames;
}

/* ---------------- classification ---------------- */

const STREETS: Array<[string, string]> = [
  ['W 5th St', 'S Congress Ave'],
  ['E Cesar Chavez St', 'Chicon St'],
  ['N Lamar Blvd', 'W 38th St'],
  ['S 1st St', 'Live Oak St'],
  ['E 6th St', 'Navasota St'],
  ['Burnet Rd', 'W Koenig Ln'],
];

const DIRECTIONS = ['northbound', 'southbound', 'eastbound', 'westbound'];

/**
 * Deterministic classification derived from the actual crop bytes, so the same
 * image always yields the same answer and the UI is reproducible during review.
 */
export function buildFixtureClassification(req: ClassifyRequest): Classification {
  const bytes = existsSync(req.cropPath) ? readFileSync(req.cropPath) : Buffer.from('missing');
  const seed = hash(req.seed, bytes.length, bytes[0] ?? 0, bytes[bytes.length - 1] ?? 0);

  const types: HazardType[] = ['pothole', 'pothole', 'cave_in', 'cave_in', 'crack', 'blocked_lane'];
  const hazardType = types[seed % types.length];
  const severity = ((seed >>> 5) % 5) + 1;
  const confidence = 0.58 + ((seed >>> 9) % 100) / 380; // 0.58 - 0.84
  const [street, crossStreet] = STREETS[(seed >>> 3) % STREETS.length];

  const spec = TAXONOMY[hazardType];
  return {
    hazardType,
    severity: severity as Classification['severity'],
    confidence: Math.min(0.97, confidence),
    justification: `Fixture response (billing disabled). ${spec.hint} Applied rubric: ${spec.rubric}`,
    // Fixtures stand in for roadway hits - they must not trip the reject.
    onRoadway: true,
    streetContext: {
      street,
      crossStreet,
      nearestAddress: `${100 + ((seed >>> 7) % 800)} ${street}`,
      direction: DIRECTIONS[(seed >>> 11) % DIRECTIONS.length],
    },
  };
}
