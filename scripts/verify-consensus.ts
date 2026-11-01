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
 * Also covered: the matching must be MAXIMUM, not first-come (case 10), street
 * names canonicalised across passes, and which detections a second pass earns
 * a verification for - corroborated only, never disputed.
 *
 * Everything runs offline in milliseconds against synthetic geometry at the
 * same city scale as the real audit.
 *
 * Run: npm run verify
 */
import { CONSENSUS_RADIUS_M, SEGMENT_MERGE_M, SEGMENT_LENGTH_M } from '../lib/config';
import { buildRqsi, summarize } from '../lib/rqsi';
import { corroboratedIds, groupHazards, groupIndex, mergeSegments } from '../lib/consensus';
import { canonicalStreets, streetKey } from '../lib/streets';
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
  surface?: 'roadway' | 'sidewalk';
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
    surface: opts.surface ?? 'roadway',
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

// A sidewalk crack and a street crack 5 m apart are two different physical
// defects; corroboration claims the same thing was seen twice.
const surfaces = groupHazards([
  det({ id: 1, jobId: 4, east: 0, type: 'crack', surface: 'roadway' }),
  det({ id: 2, jobId: 6, east: 5, type: 'crack', surface: 'sidewalk' }),
]);
assert(surfaces.length === 2, `roadway and sidewalk never group - got ${surfaces.length}`);
assert(
  surfaces.every((g) => g.state === 'single'),
  'an unmatched sighting stays single'
);

const sameSidewalk = groupHazards([
  det({ id: 1, jobId: 4, east: 0, type: 'crack', surface: 'sidewalk' }),
  det({ id: 2, jobId: 6, east: 8, type: 'crack', surface: 'sidewalk' }),
]);
assert(
  sameSidewalk.length === 1 && sameSidewalk[0].state === 'corroborated',
  `two passes on the same sidewalk defect still corroborate - got ${sameSidewalk.length}/${sameSidewalk[0]?.state}`
);

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

/* --------------------- 3. maximum, not first-come --------------------- */

console.log('\n# maximum matching');

/** A hand-placed stretch: geometry only, so the matching can be reasoned about. */
function seg(
  jobId: number,
  index: number,
  midEast: number,
  grade: RouteSegment['grade'] = 'green'
): RouteSegment {
  const a = at(midEast - SEGMENT_LENGTH_M / 2, 0);
  const b = at(midEast + SEGMENT_LENGTH_M / 2, 0);
  const m = at(midEast, 0);
  return {
    jobId,
    jobIds: [jobId],
    passes: 1,
    disagree: false,
    index,
    lat1: a.lat,
    lon1: a.lon,
    lat2: b.lat,
    lon2: b.lon,
    midLat: m.lat,
    midLon: m.lon,
    lengthM: SEGMENT_LENGTH_M,
    detectionIds: [],
    defectCount: 0,
    offRoute: 0,
    worstSeverity: 0,
    density: 0,
    rqsi: 100,
    grade,
  };
}

// The case input-order greedy fails: A1 sits on B1 (its nearest) and also
// fits B2, while A2's ONLY option is B1. Greedy gives A1 -> B1 and strands A2;
// augmenting paths move A1 to B2 and hand B1 to A2, merging both.
const a1 = seg(4, 0, 0);
const a2 = seg(4, 1, 22);
const b1 = seg(6, 0, 0);
const b2 = seg(6, 1, -20);

const swapped = mergeSegments([a1, a2, b1, b2]);
assert(
  swapped.length === 2,
  `both overlapping pairs merge, not just the nearest - got ${swapped.length} stretches`
);
assert(
  swapped.every((s) => s.passes === 2),
  'every result of the swap carries both audits'
);
assert(
  mergeSegments([a1, a2]).length === 2,
  'two stretches of the SAME audit never merge, however close'
);

// A shared hazard claims its two stretches in phase 1. Phase 2 must then reach
// the maximum over what is LEFT, not offer the claimed partner again - a
// window whose only neighbour was the claimed one would be stranded twice over
// and a third stretch left unmerged.
//
// Geometry is jobs 4 and 6's own: four windows a side, where A0 has exactly one
// neighbour (B0), A1 and A2 share B0/B1, and A3 has only B2. Three merges are
// the maximum once the hazard claims A1-B0.
const tagged = (s: RouteSegment, id: number): RouteSegment => ({
  ...s,
  detectionIds: [id],
});
const claimed = mergeSegments(
  [
    seg(4, 0, 0),
    tagged(seg(4, 1, 22), 1),
    seg(4, 2, 44),
    seg(4, 3, 66),
    tagged(seg(6, 0, 0), 2),
    seg(6, 1, 26),
    seg(6, 2, 52),
  ],
  groupHazards([
    det({ id: 1, jobId: 4, east: 5 }),
    det({ id: 2, jobId: 6, east: 5 }),
  ])
);
const mergedTwice = claimed.filter((s) => s.passes === 2).length;
assert(
  mergedTwice === 3,
  `a phase-1 claim costs no merge elsewhere - got ${mergedTwice} of 3 possible`
);
assert(
  claimed.length === 4 && claimed.some((s) => s.passes === 1),
  `the one window with no free neighbour stays on its own - got ${claimed.length} stretches`
);
assert(
  claimed.some((s) => s.detectionIds.join(',') === '1,2'),
  'the shared hazard survives the merge it was claimed for'
);

/* --------------------------- 4. street names --------------------------- */

console.log('\n# street names');

assert(
  streetKey('Hart St') === streetKey('Hart Street') &&
    streetKey('Malcolm X Blvd') === streetKey('Malcolm X Boulevard') &&
    streetKey('De Kalb Av') === streetKey('De Kalb Avenue'),
  'abbreviations fold into one street identity'
);
assert(
  streetKey('Hart Street') !== streetKey('Broadway'),
  'different streets stay different'
);

const names = (list: Detection[], field: 'street' | 'crossStreet') =>
  [...canonicalStreets(list).values()].map((v) => v[field]);

const signDisagree: Detection[] = [
  { ...det({ id: 1, jobId: 4, east: 0 }), street: 'Hart St', crossStreet: null, osmStreet: 'Hart Street' },
  { ...det({ id: 2, jobId: 6, east: 4 }), street: 'Hart Street', crossStreet: null, osmStreet: 'Hart Street' },
];
assert(
  names(signDisagree, 'street').every((s) => s === 'Hart Street'),
  `two passes and the map agree on one spelling - got ${JSON.stringify(names(signDisagree, 'street'))}`
);

const noMap: Detection[] = [
  { ...det({ id: 1, jobId: 4, east: 0 }), street: 'Lorimer St', osmStreet: null },
  { ...det({ id: 2, jobId: 6, east: 4 }), street: 'Lorimer St', osmStreet: null },
  { ...det({ id: 3, jobId: 7, east: 8 }), street: 'Lorimer St', osmStreet: null },
  { ...det({ id: 4, jobId: 8, east: 12 }), street: 'Lorimer Street', osmStreet: null },
];
assert(
  names(noMap, 'street').every((s) => s === 'Lorimer St'),
  `without the map, the majority spelling wins - got ${JSON.stringify([...new Set(names(noMap, 'street'))])}`
);

// A corner where the map names a DIFFERENT street than the sign: both are
// true (they cross), so the existing osmDisagrees flag must survive untouched.
const corner: Detection[] = [
  {
    ...det({ id: 1, jobId: 4, east: 0 }),
    street: 'Stuyvesant Ave',
    crossStreet: 'Broadway',
    osmStreet: 'Broadway',
  },
];
const cornerNames = [...canonicalStreets(corner).values()][0];
assert(
  cornerNames.street === 'Stuyvesant Ave',
  `a map disagreement is never silently renamed - got ${cornerNames.street}`
);
assert(
  cornerNames.crossStreet === 'Broadway',
  'the cross street is canonicalised too'
);

/* ------------------------ 5. what earns a verify ------------------------ */

console.log('\n# verification by corroboration');

const mixed = groupHazards([
  det({ id: 10, jobId: 4, east: 0, type: 'pothole' }),
  det({ id: 11, jobId: 6, east: 6, type: 'pothole' }), // agrees -> verified
  det({ id: 12, jobId: 4, east: 400, type: 'pothole' }),
  det({ id: 13, jobId: 6, east: 406, type: 'crack' }), // clashes -> a human
]);
const promotable = corroboratedIds(mixed);
assert(
  promotable.slice().sort((a, b) => a - b).join(',') === '10,11',
  `only the agreeing pair is promoted - got ${promotable.join(',')}`
);
assert(
  !promotable.includes(12) && !promotable.includes(13),
  'a disputed pair is never auto-verified'
);
assert(
  corroboratedIds(groupHazards([det({ id: 99, jobId: 4, east: 0 })])).length === 0,
  'a single pass verifies nothing'
);

console.log(process.exitCode ? '\nFAILED' : '\nAll consensus assertions passed.');
