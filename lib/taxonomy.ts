import type { HazardType } from './types';

/**
 * One file drives the whole taxonomy. Add a hazard class here and it flows
 * through detection, classification, the work order and the dashboard without
 * re-running any video.
 *
 * `prompt` is what we hand SAM. One CONCRETE noun per request: the API has no
 * multi-concept syntax (comma lists return zero matches) and vague phrasing is
 * unreliable. Measured against sam-3.1 on our own night footage:
 *
 *   'damaged road surface' ->     0 boxes  (too abstract)
 *   'crack in the road'    ->     0 boxes
 *   'pothole'              ->   260 boxes, 52 of 100 frames
 *   'crack'                ->   595 boxes, 73 of 100 frames
 *   'car' (control)        ->   260 boxes, so the footage itself is fine
 *
 * A control image of a known pothole returned 5 boxes, so the concept is in
 * SAM's vocabulary - the wording is what has to stay concrete. Spark still
 * makes the fine-grained call (pothole vs cave-in vs crack): it sees depth,
 * scale and surrounding context that a segmentation model never does.
 *
 * Wider coverage therefore costs a second request per chunk (~2x SAM cost),
 * never a longer prompt. SAM_PROMPTS is that list: 'crack' alone returns 2.3x
 * what 'pothole' does here, so asking for 'pothole' alone silently skips most
 * of the damaged road. Both prompts watch the same frames, and the filter
 * welds their overlaps back together so one hazard is still one work order -
 * see the second pass in mergeAcrossChunks.
 *
 * The obstruction battery was probed the same way rather than assumed, with
 * scripts/probe-prompts.ts on 300-frame slices of two of our own clips (night
 * Broadway, day Broadway):
 *
 *   prompt        night boxes/frames      day boxes/frames
 *   car           1078  300/300           337  293/300
 *   parked car     730  261/300             0    0/300
 *   van            245  245/300             0    0/300
 *   truck            0    0/300             8    8/300
 *   barrel           0    0/300             0    0/300
 *   pallet           0    0/300             0    0/300
 *
 * Two things came out of it. 'barrel' and 'pallet' return nothing on either
 * clip, and - the part that decided the list - every frame the narrower words
 * found was ALREADY found by 'car': 0 unique frames out of 261, 245 and 8.
 * 'parked car' and 'van' do box real vehicles (verified by cropping what they
 * matched), but a second request per chunk that adds no new footage is pure
 * cost, so the obstruction prompt is 'car' alone. Widening has to be measured;
 * here measurement narrowed it.
 */
export const SAM_PROMPTS = ['pothole', 'crack', 'car'] as const;

/** Single-prompt form, for callers that want exactly one request. */
export const SAM_PROMPT = SAM_PROMPTS[0];

export type HazardSpec = {
  label: string;
  /** Open311 service code for this class. Swap per municipality. */
  serviceCode: string;
  priority: string;
  /** The severity rubric we hand Spark, so scores mean the same thing twice. */
  rubric: string;
  /** Words the classifier is told to look for in the street context. */
  hint: string;
};

export const TAXONOMY: Record<HazardType, HazardSpec> = {
  pothole: {
    label: 'Pothole',
    serviceCode: 'POTHOLE',
    priority: 'P3',
    rubric:
      '1 = under 10cm, cosmetic. 2 = 10-20cm, not in wheel path. ' +
      '3 = 10-30cm in the wheel path. 4 = 30cm+, multiple connected. ' +
      '5 = over 30cm, clustered failure, or breaking the road edge.',
    hint: 'Roughly circular or oval depression with broken edges, road-worn interior.',
  },
  cave_in: {
    label: 'Cave-in',
    serviceCode: 'SINKHOLE',
    priority: 'P1',
    rubric:
      '1 = hairline depression, no measurable depth. 2 = shallow, under 15cm, edge intact. ' +
      '3 = 15-40cm deep, edge intact. 4 = edge undermined or breaking away. ' +
      '5 = spreading, undermined edge, or adjacent to a utility patch or structure.',
    hint: 'Deep collapse with a sharp drop, often near a trench cut or utility repair.',
  },
  crack: {
    label: 'Cracked asphalt',
    serviceCode: 'STREET_DEFECT',
    priority: 'P4',
    rubric:
      '1 = single hairline. 2 = single visible crack. 3 = connected cracking. ' +
      '4 = alligator cracking over a patch. 5 = cracking with raveling or loose material.',
    hint: 'Linear or alligator patterning, no measurable depth.',
  },
  blocked_lane: {
    label: 'Blocked lane',
    serviceCode: 'OBSTRUCTION',
    priority: 'P2',
    rubric:
      '1 = minor encroachment. 2 = partial blockage. 3 = half the lane. ' +
      '4 = most of the lane. 5 = full blockage or forcing vehicles into oncoming traffic.',
    hint: 'Debris, parked obstruction or material occupying travel space.',
  },
  debris: {
    label: 'Road debris',
    serviceCode: 'DEBRIS',
    priority: 'P2',
    rubric:
      '1 = small and off to the shoulder. 2 = small object in lane. ' +
      '3 = medium object in lane. 4 = large or scattered debris. ' +
      '5 = hazard likely to cause a collision at speed.',
    hint: 'Loose object not part of the road surface.',
  },
};

export const HAZARD_TYPES = Object.keys(TAXONOMY) as HazardType[];

export function isHazardType(v: unknown): v is HazardType {
  return typeof v === 'string' && v in TAXONOMY;
}

/** Natural-language rubric block we embed in the classification prompt. */
export function rubricPrompt(): string {
  return HAZARD_TYPES.map((t) => {
    const s = TAXONOMY[t];
    return `- ${t} ("${s.label}"): ${s.hint} Severity: ${s.rubric}`;
  }).join('\n');
}
