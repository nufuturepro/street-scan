import path from 'node:path';
import { REVIEW_CONFIDENCE_THRESHOLD } from './config';
import { HAZARD_TYPES, TAXONOMY, SAM_PROMPT, rubricPrompt } from './taxonomy';
import { cropToMask, extractFrame, tmpDir } from './ffmpeg';
import { interpolate } from './track';
import { reverseGeocode, streetsAgree } from './osm';
import type { MetaClient } from './meta';
import type { Track } from './filter';
import type { Classification, Detection, GpsTrack } from './types';

/**
 * The classification stage.
 *
 * SAM has given us a mask and a track; it has not told us what the thing IS.
 * That is deliberately Spark's job: pothole versus cave-in depends on depth,
 * edge condition and surrounding context (a trench cut, a utility patch, an
 * undermining crack) that a segmentation model is never asked to reason about.
 *
 * We hand Spark two images on purpose:
 *   - the masked crop, so it looks at the hazard
 *   - the full frame, so it can read the street, the cross street and scale
 * The crop answers "what is this"; the frame answers "where and how bad".
 */

export function buildClassificationPrompt(): string {
  return [
    'You are auditing road hazards from a municipal inspection video.',
    '',
    'Two images are provided: first the FULL frame, second a cropped patch of the detected hazard.',
    '',
    'Classify the hazard into exactly one of these types:',
    rubricPrompt(),
    '',
    'Severity must be an integer 1-5 and must follow the rubric above for the type you chose.',
    '',
    'Also read the street context from the full frame: the nearest street sign,',
    'any cross street, an address number if visible, and the direction of travel.',
    'If a sign is not clearly legible, return null for that field - do not guess.',
    '',
    'confidence is your honest probability that the hazard TYPE is correct (0 to 1).',
    '',    'Set onRoadway to true when the patch is in the travel way: the roadway surface,',
    'a bike lane, a bus lane, a crosswalk, or a vehicle or object occupying those spaces.',
    'A vehicle, barrier or debris blocking a travel lane or bike lane IS on roadway - the',
    'blockage is the hazard.',
    '',
    'Return false when it sits on a sidewalk, building, wall, yard or driveway, or on a',
    'vehicle parked clear of the travel way at the curb or in a parking lane. Those are not',
    'roadway hazards and must not be reported.',
    '',
    'Return JSON only, with exactly these keys:',
    JSON.stringify({
      hazardType: HAZARD_TYPES,
      severity: 'integer 1-5',
      confidence: 'number 0-1',
      onRoadway: 'boolean',
      justification: 'one sentence citing visible evidence',
      streetContext: {
        street: 'string or null',
        crossStreet: 'string or null',
        nearestAddress: 'string or null',
        direction: 'string or null',
      },
    }),
  ].join('\n');
}

export type ClassifyResult = {
  detection: Detection;
  classification: Classification;
};

export async function classifyTrack(opts: {
  jobId: number;
  analysisPath: string;
  track: Track;
  fps: number;
  gps: GpsTrack;
  client: MetaClient;
  /** skip network calls (fixtures, offline demo, tests) */
  skipOsm?: boolean;
}): Promise<ClassifyResult | null> {
  const { jobId, analysisPath, track, fps, gps, client } = opts;

  const tMs = Math.round((track.best.frameIndex / fps) * 1000);
  const timeSec = track.best.frameIndex / fps;

  const stem = `det-job${jobId}-f${track.best.frameIndex}-o${track.objectId}`;
  const out = tmpDir();
  const framePath = path.join(out, `${stem}-frame.png`);
  const cropPath = path.join(out, `${stem}-crop.png`);

  await extractFrame(analysisPath, timeSec, framePath);
  await cropToMask(analysisPath, timeSec, track.best.polygon, cropPath);

  const classification = await client.classify({
    cropPath,
    framePath,
    prompt: buildClassificationPrompt(),
    seed: hashSeed(jobId, track.best.frameIndex, track.objectId),
  });

  // Sidewalk and curb patches match SAM's vocabulary but are not road hazards,
  // so reject them here instead of shipping a false positive to the queue.
  if (!classification.onRoadway) return null;

  // Guard the classifier's output: an out-of-taxonomy answer falls back rather
  // than crashing the job or filing an unrecognised service code.
  const hazardType = HAZARD_TYPES.includes(classification.hazardType)
    ? classification.hazardType
    : 'pothole';
  const spec = TAXONOMY[hazardType];

  const geo = interpolate(gps, tMs);

  let osmStreet: string | null = null;
  let agrees: boolean | null = null;
  if (geo && !opts.skipOsm) {
    const osm = await reverseGeocode(geo.lat, geo.lon);
    if (osm.ok) {
      osmStreet = osm.street;
      agrees = streetsAgree(classification.streetContext.street, osm.street);
    }
  }

  const confidence = clamp01(classification.confidence);
  const needsReview =
    confidence < REVIEW_CONFIDENCE_THRESHOLD ||
    agrees === false ||
    geo === null ||
    !classification.streetContext.street;

  const detection: Detection = {
    jobId,
    hazardType,
    severity: (Math.min(5, Math.max(1, Math.round(classification.severity))) ||
      3) as Detection['severity'],
    confidence,
    tMs,
    lat: geo?.lat ?? null,
    lon: geo?.lon ?? null,
    // OCR at speed, at night, frequently reads nothing at all. The work order
    // still needs a street, so fall back to the independently geocoded name.
    // osmStreet keeps the map's own value and needsReview still records that
    // no sign was actually read.
    street: classification.streetContext.street ?? osmStreet,
    crossStreet: classification.streetContext.crossStreet ?? null,
    description: classification.justification || spec.label,
    needsReview,
    reviewStatus: 'detected',
    polygon: track.best.polygon,
    frameIndex: track.best.frameIndex,
    osmStreet,
    osmDisagrees: agrees === false,
    serviceCode: spec.serviceCode,
    priority: spec.priority,
  };

  return { detection, classification };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function hashSeed(...parts: number[]): number {
  let h = 2166136261;
  for (const p of parts) {
    h ^= p & 0xff;
    h = Math.imul(h, 16777619);
    h ^= (p >>> 8) & 0xff;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export { SAM_PROMPT };
