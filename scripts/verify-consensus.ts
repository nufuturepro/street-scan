/**
 * Verification for cross-audit consensus - the module's executable contract.
 *
 * Why this exists: "different passes learn from each other" is a claim about
 * agreement, and agreement is exactly the thing that silently goes wrong. Two
 * failure modes drive everything below:
 *
 *   1. CHAINING. A naive radius union welds a whole route into one blob - job
 *      4's detections sit ~10 m apart, so at a 20 m radius every hazard on the
 *      street becomes "the same hazard". One sighting per audit, per group is
 *      the rule that prevents it, and case 4 is that rule's proof.
 *   2. AVERAGING. Two passes disagreeing about a road must not be averaged
 *      into something nobody drove: merged segments take the WORST grade, and
 *      shared metres are counted once (case 7-9) - the double count is the
 *      whole reason merging exists.
 *
 * Everything runs offline in milliseconds against synthetic geometry at the
 * same city scale as the real audit.
 *
 * Run: npm run verify
 */
import { CONSENSUS_RADIUS_M, SEGMENT_MERGE_M, SEGMENT_LENGTH_M } from '../lib/config';
import { buildRqsi, summarize } from '../lib/rqsi';
import { groupHazards, groupIndex, mergeSegments } from '../lib/consensus';
import type { Detection, GpsSample, HazardType, RouteSegment } from '../lib/types';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok   - ${msg}`);
  }
}

/* ------------------------------ fixtures ------------------------------ */

const LAT0 = 40.704;
const LON0 = -73.9475;
const M_PER_DEG = 111_320;

/** `east` metres east and `north` metres north of the origin. */
function at(east: number, north = 0): { lat: number; lon: number } {
  return {
    lat: LAT0 + north / M_PER_DEG,
    lon: LON0 + east / (M_PER_DEG * Math.cos((LAT0 * Math.PI) / 180)),
  };
}

/** One sample per metre, heading east for exactly `lengthM` metres. */
function eastTrack(lengthM: number): GpsSample[] {
  const out: GpsSample[] = [];
  for (let i = 0; i <= lengthM; i++) {
    const p = at(i, 0);
    out.push({ t: i * 1000, lat: p.lat, lon: p.lon });
  }
  return out;
}

type DetOpts = {
  id: number;
  jobId: number;
  east: number;
  north?: number;
  type?: HazardType;
  severity?: 1 | 2 | 3 | 4 | 5;
  confidence?: number;
};

function det(opts: DetOpts): Detection {
  const p = at(opts.east, opts.north ?? 0);
  return {
    id: opts.id,
    jobId: opts.jobId,
    hazardType: opts.type ?? 'pothole',
    severity: opts.severity ?? 3,
    confidence: opts.confidence ?? 0.9,
    tMs: 0,
    lat: p.lat,
    lon: p.lon,
    street: null,
    crossStreet: null,
    description: '',
    needsReview: false,
    reviewStatus: 'detected',
    polygon: [],
    frameIndex: 0,
    osmStreet: null,
    osmDisagrees: false,
    serviceCode: 'TEST',
    priority: 'P3',
  };
}

/* ------------------------------ 1. grouping ------------------------------ */

console.log('\n# hazard grouping');

const agree = groupHazards([
  det({ id: 1, jobId: 4, east: 0, type: 'pothole', severity: 2 }),
  det({ id: 2, jobId: 6, east: 10, type: 'pothole', severity: 4 }),
]);
assert(agree.length === 1, `two passes, same defect -> one group - got ${agree.length}`);
assert(agree[0].state === 'corroborated', `state is corroborated - got ${agree[0].state}`);
assert(agree[0].passes === 2 && agree[0].jobs.length === 2, 'both audits are recorded');
assert(agree[0].severity === 4, `worst severity wins - got ${agree[0].severity}`);
assert(
  agree[0].detectionIds.join(',') === '1,2',
  `both sightings are kept - got ${agree[0].detectionIds.join(',')}`
);
// The group is placed at the winning sighting, not the average of the two:
// averaging two defects 10 m apart would pin the hazard between them.
assert(
  Math.abs(agree[0].lon - at(10, 0).lon) < 1e-9,
  'the group sits on the higher-severity sighting, not an average of the two'
);

const dispute = groupHazards([
  det({ id: 1, jobId: 4, east: 0, type: 'pothole' }),
  det({ id: 2, jobId: 6, east: 8, type: 'crack' }),
]);
assert(dispute[0].state === 'disputed', `type clash is disputed - got ${dispute[0].state}`);

const alone = groupHazards([det({ id: 1, jobId: 4, east: 0 })]);
assert(alone[0].state === 'single', `one pass is single - got ${alone[0].state}`);
assert(alone[0].passes === 1, 'a single pass reports one pass');

const apart = groupHazards([
  det({ id: 1, jobId: 4, east: 0 }),
  det({ id: 2, jobId: 6, east: CONSENSUS_RADIUS_M + 20 }),
]);
assert(apart.length === 2, `past the radius stays separate - got ${apart.length}`);

const noCoord = groupHazards([
  det({ id: 1, jobId: 4, east: 0 }),
  { ...det({ id: 2, jobId: 6, east: 5 }), lat: null, lon: null },
]);
assert(
  noCoord.length === 1 && noCoord[0].passes === 1,
  'an unplacable detection joins no group'
);

// The rule the whole design rests on: one sighting per audit, per group.
const chained = groupHazards([
  det({ id: 1, jobId: 4, east: 0 }),
  det({ id: 2, jobId: 4, east: 10 }),
  det({ id: 3, jobId: 4, east: 20 }),
  det({ id: 4, jobId: 4, east: 30 }),
  det({ id: 5, jobId: 6, east: 5 }),
]);
assert(
  chained.length === 4,
  `a 10 m chain does not weld one job's street together - got ${chained.length} groups`
);
assert(
  chained.filter((g) => g.passes === 2).length === 1,
  'exactly one group is corroborated, the rest stay single'
);
assert(
  chained.filter((g) => g.jobs.includes(4) && g.jobs.includes(6)).length === 1,
  'the corroboration is the pair, not the chain'
);

const radiusEdge = groupHazards([
  det({ id: 1, jobId: 4, east: 0 }),
  det({ id: 2, jobId: 6, east: CONSENSUS_RADIUS_M - 1 }),
  det({ id: 3, jobId: 6, east: CONSENSUS_RADIUS_M + 1 }),
]);
assert(
  radiusEdge.length === 2,
  `inside the radius matches, just outside does not - got ${radiusEdge.length}`
);

/* ---------------------------- 2. segment merge ---------------------------- */

console.log('\n# segment merge');

function route(jobId: number, detections: Detection[] = []): RouteSegment[] {
  return buildRqsi({
    jobId,
    track: { source: 'manual', samples: eastTrack(50) },
    detections,
  });
}

const shared = mergeSegments(
  [
    ...route(4, [det({ id: 1, jobId: 4, east: 5, severity: 4 })]),
    ...route(6, []),
  ],
  groupHazards([
    det({ id: 1, jobId: 4, east: 5, severity: 4 }),
  ])
);

assert(shared.length === 2, `the same 50 m street merges to 2 stretches - got ${shared.length}`);
assert(
  shared.every((s) => s.passes === 2 && s.jobIds.length === 2),
  'every merged stretch knows both audits cover it'
);
assert(
  shared[0].disagree && shared[0].grade === 'red',
  'a red pass over a green pass is recorded as a disagreement'
);
assert(
  !shared[1].disagree && shared[1].grade === 'green',
  'a stretch both passes call clean is not a disagreement'
);
assert(
  shared.some((s) => s.grade === 'red' && s.rqsi === 0),
  'the worse grade wins the merge - no averaging into amber'
);
assert(
  summarize(shared).totalLengthM === 50,
  `shared metres count once, not twice - got ${summarize(shared).totalLengthM} m`
);
assert(
  summarize([...route(4), ...route(6)]).totalLengthM === 100,
  'unmerged, the same street would read 100 m (the bug being fixed)'
);

const aloneRoute = mergeSegments(route(4, [det({ id: 1, jobId: 4, east: 5 })]));
assert(
  aloneRoute.length === 2 &&
    aloneRoute.every((s) => s.passes === 1 && !s.disagree),
  'one audit on its own is untouched by the merge'
);
assert(
  aloneRoute[0].defectCount === 1 && aloneRoute[1].defectCount === 0,
  'single-pass defect counts are unchanged'
);

// One pothole seen by two passes is one pothole, not two.
const bothSaw = [
  det({ id: 1, jobId: 4, east: 5, type: 'pothole' }),
  det({ id: 2, jobId: 6, east: 5, type: 'pothole' }),
];
const deduped = mergeSegments(
  [
    ...route(4, [bothSaw[0]]),
    ...route(6, [bothSaw[1]]),
  ],
  groupHazards(bothSaw)
);
assert(
  deduped[0].defectCount === 1 && deduped[0].detectionIds.length === 2,
  `two sightings of one hazard count as one defect - got ${deduped[0].defectCount} from ${deduped[0].detectionIds.length} ids`
);

// Same rule as hazards: a job's own segments never merge into each other.
const longStreet = mergeSegments([...route(4), ...route(6), ...route(7)]);
assert(
  longStreet.length === 2,
  `three audits on one street collapse to 2 stretches - got ${longStreet.length}`
);
assert(
  longStreet.every((s) => new Set(s.jobIds).size === 3),
  'all three audits are credited on the merged stretch'
);

const index = groupIndex(groupHazards(bothSaw));
assert(
  index.get(1) != null && index.get(1) === index.get(2),
  'both sightings map to one hazard id'
);
assert(SEGMENT_MERGE_M === SEGMENT_LENGTH_M, 'segment merging uses one grading window');

console.log(process.exitCode ? '\nFAILED' : '\nAll consensus assertions passed.');
