/**
 * Verification for the RQSI route scoring - the module's executable contract.
 *
 * Why this exists: until now the only proof that the math was right was a live
 * browser pass, and a window planned at 100 m against a track that actually
 * measures 78 m reached the map before anything caught it. Everything here
 * runs in milliseconds, offline, with no API key and no database.
 *
 * What it pins down:
 *   1. route splitting at the boundaries, including a track shorter than one
 *      window and the real 78 m audit -> 4 equal segments with no tail stub
 *   2. detection snapping: outright snap inside the radius, the off-track
 *      fallback band, and a pin so far away it is dropped rather than blamed
 *      on a segment it is not on
 *   3. the grade rubric as a table (it is judge-facing, so it is asserted)
 *   4. index arithmetic and its clamp, at the calibrated K
 *   5. the real audit's outcome - 3 green + 1 red, RQSI 75 - matching what the
 *      deployed dashboard showed
 *
 * Run: npm run verify   (compiles this and verify-filter to .verify/ and runs
 * them in sequence, stopping at the first failure)
 */
import {
  SEGMENT_LENGTH_M,
  SEGMENT_SNAP_RADIUS_M,
  SEGMENT_OFF_ROUTE_M,
  RQSI_DENSITY_K,
} from '../lib/config';
import { buildRqsi, summarize, haversineM } from '../lib/rqsi';
import type { Detection, GpsSample, HazardType, RqsiGrade } from '../lib/types';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok   - ${msg}`);
  }
}

function approx(actual: number, expected: number, tol: number, msg: string): void {
  assert(
    Math.abs(actual - expected) <= tol,
    `${msg} (got ${actual}, want ${expected} ± ${tol})`
  );
}

/* ------------------------------ fixtures ------------------------------ */

// Coordinates from the real audit's track, so fixture distances behave like
// the deployed data. Steps are derived from the haversine inverse, so a track
// asked for at N metres measures N metres when the module walks it.
const LAT0 = 40.6953;
const LON0 = -73.93161;
const EARTH_R = 6371008.8;

const northM = (m: number) => m / 110574;
/** Metres east -> degrees of longitude. The inverse of the haversine on this
 *  parallel, returned in degrees because that is what a coordinate stores. */
const eastDeg = (m: number, lat = LAT0) =>
  (2 * Math.asin(Math.sin(m / (2 * EARTH_R)) / Math.cos((lat * Math.PI) / 180)) * 180) /
  Math.PI;

/** One sample per metre, heading east for exactly `lengthM` metres. */
function eastTrack(lengthM: number): GpsSample[] {
  const out: GpsSample[] = [];
  for (let i = 0; i <= lengthM; i++) {
    out.push({ t: i * 1000, lat: LAT0, lon: LON0 + eastDeg(i) });
  }
  return out;
}

/** Where a hazard sits relative to the track: `along` east, `north` off it. */
function place(along: number, north: number): { lat: number; lon: number } {
  return { lat: LAT0 + northM(north), lon: LON0 + eastDeg(along) };
}

type DetectionOpts = {
  along: number;
  north?: number;
  type?: HazardType;
  severity?: 1 | 2 | 3 | 4 | 5;
  id?: number;
  surface?: 'roadway' | 'sidewalk';
};

function det(opts: DetectionOpts): Detection {
  const p = place(opts.along, opts.north ?? 0);
  return {
    id: opts.id ?? 0,
    jobId: 4,
    hazardType: opts.type ?? 'pothole',
    severity: opts.severity ?? 3,
    confidence: 0.9,
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

function run(lengthM: number, detections: Detection[] = []) {
  return buildRqsi({
    jobId: 4,
    track: { source: 'manual', samples: eastTrack(lengthM) },
    detections,
  });
}

/* ------------------------ 1. route splitting ------------------------ */

console.log('\n# splitting');

// Equal division, not "every window plus a remainder": the remainder version
// left a 3 m tail stub that swallowed defects into something that is not a
// stretch of road. Every case must divide evenly and stay under the window.
const SPLIT_CASES: Array<{ lengthM: number; segments: number; each: number }> = [
  { lengthM: 10, segments: 1, each: 10 }, // shorter than one window
  { lengthM: 25, segments: 1, each: 25 }, // exactly one window
  { lengthM: 26, segments: 2, each: 13 }, // one metre over
  { lengthM: 50, segments: 2, each: 25 }, // exact multiple
  { lengthM: 51, segments: 3, each: 17 }, // one metre over a multiple
  { lengthM: 78, segments: 4, each: 19.5 }, // the real audit track
];

for (const c of SPLIT_CASES) {
  const segs = run(c.lengthM);
  const lengths = segs.map((s) => s.lengthM);
  const total = lengths.reduce((a, b) => a + b, 0);

  assert(segs.length === c.segments, `${c.lengthM} m splits into ${c.segments} segments - got ${segs.length}`);
  assert(
    lengths.every((l) => Math.abs(l - c.each) < 0.001),
    `${c.lengthM} m segments are all ${c.each} m (no tail stub) - got ${JSON.stringify(lengths)}`
  );
  assert(Math.abs(total - c.lengthM) < 0.01, `${c.lengthM} m is fully accounted for - got ${total}`);
  assert(
    Math.max(...lengths) <= SEGMENT_LENGTH_M + 0.001,
    `no segment exceeds the ${SEGMENT_LENGTH_M} m window - got ${Math.max(...lengths)}`
  );
  assert(segs.every((s) => s.grade === 'green'), `${c.lengthM} m with no detections grades clean`);
}

assert(run(10).every((s, i) => s.index === i), 'segments are numbered in route order');
assert(run(10)[0].lon1 < run(10)[0].lon2, 'segments follow the direction of travel');

assert(
  run(0).length === 0,
  'a motionless track (zero length) yields no segments rather than a degenerate one'
);
assert(
  buildRqsi({
    jobId: 4,
    track: { source: 'manual', samples: [eastTrack(10)[0]] },
    detections: [],
  }).length === 0,
  'a single sample yields no segments'
);

// Fixture sanity: if this is wrong, every distance assertion below is wrong.
approx(haversineM(place(0, 0), place(1, 0)), 1, 0.001, 'fixture steps measure what they claim');

/* ------------------------ 2. detection snapping ------------------------ */

console.log('\n# snapping');

// 75 m = three 25 m windows: [0-25], [25-50], [50-75].
type SnapCase = { name: string; along: number; north: number; segment: number; offRoute: number };

const SNAP_CASES: SnapCase[] = [
  { name: 'on the track', along: 10, north: 0, segment: 0, offRoute: 0 },
  { name: '10 m beside it, inside the snap radius', along: 30, north: 10, segment: 1, offRoute: 0 },
  // Boundaries are stated 0.1 m inside/outside rather than exactly on: a pin
  // placed at precisely 30 m lands at 30.000000000000004 after the round trip
  // through degrees, and asserting an exact float tells us nothing.
  { name: 'just inside the snap radius', along: 10, north: SEGMENT_SNAP_RADIUS_M - 0.1, segment: 0, offRoute: 0 },
  { name: 'just outside the snap radius, in the off-track band', along: 10, north: SEGMENT_SNAP_RADIUS_M + 0.1, segment: 0, offRoute: 1 },
  { name: 'just inside the off-track limit', along: 10, north: SEGMENT_OFF_ROUTE_M - 0.1, segment: 0, offRoute: 1 },
];

for (const c of SNAP_CASES) {
  const segs = run(75, [det({ ...c, id: 1 })]);
  assert(
    segs[c.segment].detectionIds.includes(1),
    `${c.name} lands on segment ${c.segment}`
  );
  assert(
    segs[c.segment].offRoute === c.offRoute,
    `${c.name} reports offRoute ${c.offRoute} - got ${segs[c.segment].offRoute}`
  );
  assert(
    segs.every((s, i) => i === c.segment || (s.defectCount === 0 && s.offRoute === 0)),
    `${c.name} is not also charged to another segment`
  );
}

const dropped = run(75, [det({ along: 10, north: SEGMENT_OFF_ROUTE_M + 0.1, id: 9 })]);
assert(
  dropped.every((s) => s.defectCount === 0 && s.detectionIds.length === 0),
  `a pin just past the ${SEGMENT_OFF_ROUTE_M} m limit is dropped, not blamed on a segment`
);

const multiple = run(75, [
  det({ along: 5, id: 1 }),
  det({ along: 40, id: 2 }),
  det({ along: 60, id: 3 }),
]);
assert(
  JSON.stringify(multiple.map((s) => s.detectionIds)) === JSON.stringify([[1], [2], [3]]),
  `each detection is charged to its own segment - got ${JSON.stringify(multiple.map((s) => s.detectionIds))}`
);

/* ------------------------- 3. the grade rubric ------------------------- */

console.log('\n# grades');

// Copied from the rubric the pitch deck quotes, so a logic change cannot
// quietly rewrite what "hazardous" means. One detection in a 25 m window.
const GRADE_CASES: Array<{ type: HazardType; severity: 1 | 2 | 3 | 4 | 5; expect: RqsiGrade }> = [
  { type: 'pothole', severity: 1, expect: 'green' },
  { type: 'debris', severity: 1, expect: 'green' },
  { type: 'crack', severity: 1, expect: 'yellow' }, // any cracking is caution
  { type: 'pothole', severity: 2, expect: 'yellow' },
  { type: 'blocked_lane', severity: 2, expect: 'yellow' }, // needs 3 to be red
  { type: 'debris', severity: 3, expect: 'yellow' },
  { type: 'pothole', severity: 3, expect: 'yellow' },
  { type: 'blocked_lane', severity: 3, expect: 'red' },
  { type: 'cave_in', severity: 3, expect: 'red' },
  { type: 'debris', severity: 4, expect: 'red' },
  { type: 'pothole', severity: 4, expect: 'red' },
  { type: 'crack', severity: 5, expect: 'red' },
];

for (const c of GRADE_CASES) {
  const segs = run(25, [det({ along: 12, type: c.type, severity: c.severity })]);
  assert(
    segs.length === 1 && segs[0].grade === c.expect,
    `${c.type} at severity ${c.severity} grades ${c.expect} - got ${segs[0]?.grade}`
  );
}

assert(run(25)[0].grade === 'green', 'an untouched segment grades green');
assert(
  run(25, [det({ along: 5, severity: 1 }), det({ along: 20, severity: 3 })])[0].grade === 'yellow',
  'mixes grade by their worst member'
);
assert(
  run(25, [det({ along: 5, severity: 1 }), det({ along: 20, severity: 4 })])[0].grade === 'red',
  'one severe defect reddens the whole segment'
);

// Sidewalk findings are real but graded apart: a severity-5 sidewalk defect
// must not redden a driving segment no tyre ever touched.
const walkOnly = run(25, [det({ along: 12, severity: 5, surface: 'sidewalk' })]);
assert(
  walkOnly.length === 1 && walkOnly[0].grade === 'green' && walkOnly[0].defectCount === 0,
  `sidewalk findings are excluded from the street grade - got ${walkOnly[0]?.grade}/${walkOnly[0]?.defectCount}`
);
const mixed = run(25, [
  det({ along: 5, severity: 4 }),
  det({ along: 20, severity: 5, surface: 'sidewalk' }),
]);
assert(
  mixed[0].grade === 'red' && mixed[0].defectCount === 1,
  `only the street defect counts - got ${mixed[0].grade}/${mixed[0].defectCount}`
);

/* --------------------- 4. index arithmetic + clamp --------------------- */

console.log('\n# index');

// Calibrations the config comments promise. Changing K or the window size
// breaks these deliberately - that is the point of pinning them.
assert(SEGMENT_LENGTH_M === 25, `window calibrated to 25 m (the audit track is 78 m) - got ${SEGMENT_LENGTH_M}`);
assert(RQSI_DENSITY_K === 4, `K calibrated to 4 - got ${RQSI_DENSITY_K}`);
assert(SEGMENT_OFF_ROUTE_M > SEGMENT_SNAP_RADIUS_M, 'the off-track band sits outside the snap radius, or it is unreachable');

type IndexCase = {
  name: string;
  contents: Array<[HazardType, 1 | 2 | 3 | 4 | 5]>;
  density: number;
  rqsi: number;
};

// A 25 m window holds a quarter of the "per 100 m" the rubric speaks in, so
// densities run 4x the per-defect weight: weight / 0.25.
const INDEX_CASES: IndexCase[] = [
  { name: 'clean segment', contents: [], density: 0, rqsi: 100 },
  { name: 'one severity-2 crack', contents: [['crack', 2]], density: 4.8, rqsi: 81 },
  { name: 'two severity-2 cracks', contents: [['crack', 2], ['crack', 2]], density: 9.6, rqsi: 62 },
  { name: 'one severity-3 pothole', contents: [['pothole', 3]], density: 16, rqsi: 36 },
  { name: 'one severity-4 pothole', contents: [['pothole', 4]], density: 28, rqsi: 0 },
  { name: 'two severity-5 cave-ins', contents: [['cave_in', 5], ['cave_in', 5]], density: 120, rqsi: 0 },
];

for (const c of INDEX_CASES) {
  const segs = run(
    25,
    c.contents.map(([type, severity], i) => det({ along: 4 + i * 4, type, severity }))
  );
  const seg = segs[0];
  approx(seg.density, c.density, 0.01, `${c.name} has density ${c.density}/100m`);
  assert(seg.rqsi === c.rqsi, `${c.name} scores ${c.rqsi} at K=${RQSI_DENSITY_K} - got ${seg.rqsi}`);
  assert(seg.rqsi >= 0 && seg.rqsi <= 100, `${c.name} stays inside 0-100`);
}

/* ------------------- 5. the real audit, end to end ------------------- */

console.log('\n# the real 78 m audit');

// Same shape as job 4 on the deployed box: six cracks and two severity-4
// potholes, all inside the last stretch of a 78 m track. The dashboard showed
// 3 smooth / 0 caution / 1 hazardous and an overall RQSI of 75.
const auditDetections: Detection[] = [
  det({ along: 62, north: 4, type: 'crack', severity: 2, id: 50 }),
  det({ along: 63, north: 2, type: 'crack', severity: 3, id: 51 }),
  det({ along: 65, north: 6, type: 'pothole', severity: 4, id: 52 }),
  det({ along: 66, north: 1, type: 'crack', severity: 2, id: 53 }),
  det({ along: 70, north: 8, type: 'pothole', severity: 4, id: 54 }),
  det({ along: 71, north: 3, type: 'crack', severity: 3, id: 55 }),
  det({ along: 74, north: 5, type: 'crack', severity: 2, id: 56 }),
  det({ along: 76, north: 0, type: 'crack', severity: 2, id: 57 }),
];

const audit = run(78, auditDetections);
const summary = summarize(audit);
const counts = summary.counts;

assert(audit.length === 4, `78 m still yields 4 segments with hazards present - got ${audit.length}`);
assert(
  Math.abs(audit.reduce((s, x) => s + x.lengthM, 0) - 78) < 0.01,
  'the audited route still measures 78 m end to end'
);
assert(counts.green === 3 && counts.yellow === 0 && counts.red === 1,
  `grades are 3 smooth / 0 caution / 1 hazardous - got ${counts.green}/${counts.yellow}/${counts.red}`);
assert(audit[3].defectCount === 8, `all 8 hazards fall in the final segment - got ${audit[3].defectCount}`);
assert(audit[3].worstSeverity === 4, `worst severity in that segment is 4 - got ${audit[3].worstSeverity}`);
assert(audit[3].rqsi === 0, `the damaged segment scores 0 - got ${audit[3].rqsi}`);
assert(summary.rqsi === 75, `overall RQSI is 75, as the dashboard showed - got ${summary.rqsi}`);
assert(summary.worst?.index === 3, `the worst segment is the damaged one - got ${summary.worst?.index}`);
assert(summary.totalLengthM === 78, `summary totals 78 m - got ${summary.totalLengthM}`);
assert(
  audit.every((s) => s.offRoute === 0),
  'every hazard sat within the snap radius, so none were flagged off-track'
);

const empty = summarize([]);
assert(
  empty.rqsi === 0 && empty.worst === null && empty.counts.green === 0,
  'an audit with no route summarises as empty rather than crashing'
);

console.log(process.exitCode ? '\nFAILED' : '\nAll RQSI assertions passed.');
