import path from 'node:path';
import { ANALYSIS_SIZE, REVIEW_CONFIDENCE_THRESHOLD } from './config';
import { maskSize } from './scale';
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

/**
 * How big the patch is, in the only units the model can trust.
 *
 * Without this the crop arrived with no scale reference at all: a 52x43 px
 * patch - an object roughly 20-30 m down the road - was upscaled into an image
 * that looked like close-up road surface, and the model answered with the
 * confidence of a close-up. Telling it the pixel count and what fraction of
 * the frame it covers is what makes "I cannot judge this" a possible answer.
 */
export type PromptScale = {
  /** "52 x 43" */
  cropPx: string;
  /** "854 x 480" */
  framePx: string;
  /** percentage of the frame's area, e.g. "0.55" */
  framePct: string;
};

export function buildClassificationPrompt(scale?: PromptScale): string {
  return [
    'You are auditing road hazards from a municipal inspection video.',
    '',
    'Two images are provided: first the FULL frame, second a cropped patch of the detected hazard.',
    ...(scale
      ? [
          '',
          `The cropped patch is ${scale.cropPx} pixels out of an ${scale.framePx} frame - about ${scale.framePct}% of the picture.`,
          'A small patch is usually several metres ahead and softer than it looks here: do not infer depth,',
          'edge condition or extent that the pixels cannot show.',
          'If the patch is too small or too soft to judge (roughly under 40 pixels across, or the evidence',
          'is only a few pixels of texture), return hazardType "not_a_defect" with rejectReason "too_small".',
          'Never guess a defect type from a handful of pixels - a wrong work order is worse than a skipped one.',
        ]
      : []),
    '',
    'Classify the hazard into exactly one of these types:',
    rubricPrompt(),
    '- not_a_defect: an intact manhole cover, utility access cover, valve cover, metal',
    '  plate, painted marking, drain or shadow - not a road defect, even when sunken,',
    '  dark or cracked through. Return it and the pipeline discards the patch; never',
    '  force one of these into the list above.',
    '',
    'Severity must be an integer 1-5 and must follow the rubric above for the type you chose.',
    '',
    'Also read the street context from the full frame: the nearest street sign,',
    'any cross street, an address number if visible, and the direction of travel.',
    'If a sign is not clearly legible, return null for that field - do not guess.',
    '',
    'confidence is your honest probability that the hazard TYPE is correct (0 to 1).',
    '',    '    Set onRoadway to true when the patch is in the travel way: the roadway surface,',
    'a bike lane, a bus lane, a crosswalk, or a vehicle or object occupying those spaces.',
    'A vehicle, barrier or debris blocking a travel lane or bike lane IS on roadway - the',
    'blockage is the hazard.',
    '',
    'Set onRoadway to false when it sits on a sidewalk, building, wall, yard or driveway, or',
    'on a vehicle parked clear of the travel way at the curb or in a parking lane.',
    'For a sidewalk finding, severity still follows the rubric but judge it as a PEDESTRIAN',
    'would: 1 = cosmetic, 2 = noticeable, 3 = a trip hazard most people step over, 4 = forces',
    'a wheelchair, stroller or walker around or into the gutter, 5 = impassable without',
    'entering the street. Cite what makes it a pedestrian problem in the justification.',
    '',
    'Return JSON only, with exactly these keys:',
    JSON.stringify({
      hazardType: [...HAZARD_TYPES, 'not_a_defect'],
      severity: 'integer 1-5',
      confidence: 'number 0-1',
      onRoadway: 'boolean',
      justification: 'one sentence citing visible evidence',
      rejectReason: 'string or null - "too_small" when the patch is too small or soft to judge',
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
  /** null when the classifier refused the patch - see classification.rejectReason */
  detection: Detection | null;
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
}): Promise<ClassifyResult> {
  const { jobId, analysisPath, track, fps, gps, client } = opts;

  const tMs = Math.round((track.best.frameIndex / fps) * 1000);
  const timeSec = track.best.frameIndex / fps;

  const stem = `det-job${jobId}-f${track.best.frameIndex}-o${track.objectId}`;
  const out = tmpDir();
  const framePath = path.join(out, `${stem}-frame.png`);
  const cropPath = path.join(out, `${stem}-crop.png`);

  await extractFrame(analysisPath, timeSec, framePath);
  await cropToMask(analysisPath, timeSec, track.best.polygon, cropPath);

  // Measure the patch before describing it: see PromptScale above.
  const box = maskSize(track.best.polygon);
  const [frameW, frameH] = ANALYSIS_SIZE.split('x').map(Number);
  const scale: PromptScale = {
    cropPx: `${Math.max(1, Math.round(box.widthFrac * frameW))} x ${Math.max(
      1,
      Math.round(box.heightFrac * frameH)
    )}`,
    framePx: `${frameW} x ${frameH}`,
    framePct: (box.areaFrac * 100).toFixed(2),
  };

  const classification = await client.classify({
    cropPath,
    framePath,
    prompt: buildClassificationPrompt(scale),
    seed: hashSeed(jobId, track.best.frameIndex, track.objectId),
    jobId,
  });

  // The classifier's reject: an intact cover, plate or marking it refused to
  // file, or a patch too small to judge. normalizeType has already turned
  // every unknown answer into this, so a manhole answer can no longer fall
  // through to a pothole work order.
  if (classification.hazardType === 'not_a_defect') return { detection: null, classification };

  // Sidewalk patches match SAM's vocabulary too. They are kept rather than
  // discarded - but tagged, so the dashboard can show them as their own class
  // instead of passing a sidewalk defect off as a street hazard.
  const surface: Detection['surface'] = classification.onRoadway ? 'roadway' : 'sidewalk';

  const hazardType = classification.hazardType;
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
    // Nobody has reviewed it yet, so there is no note; a reviewer adds one.
    note: '',
    needsReview,
    reviewStatus: 'detected',
    polygon: track.best.polygon,
    frameIndex: track.best.frameIndex,
    osmStreet,
    osmDisagrees: agrees === false,
    serviceCode: spec.serviceCode,
    priority: spec.priority,
    surface,
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
