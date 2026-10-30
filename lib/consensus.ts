import { CONSENSUS_RADIUS_M, SEGMENT_MERGE_M } from './config';
import { haversineM } from './rqsi';
import type { Detection, HazardGroup, RouteSegment, RqsiGrade } from './types';

/**
 * What one audit learns from another.
 *
 * Two clips of the same street are two independent witnesses. Agreeing makes a
 * hazard more believable than any single pass; disagreeing is information too -
 * a stretch one run graded red and another graded green is exactly where a
 * detector is unreliable, and hiding that behind an average is how a demo
 * looks better than the product is.
 *
 * Two rules carry the whole design, both learned from measuring this project's
 * own three jobs rather than from theory:
 *
 *   1. ONE SIGHTING PER AUDIT, PER GROUP. A naive radius union welds a whole
 *      route into a single blob: job 4's detections sit ~10 m apart and job 6's
 *      segments 23 m apart, so at a 20 m radius a chain of links merges an
 *      entire street. A detection therefore only ever joins a group that does
 *      not already contain its own job.
 *
 *   2. AGREEMENT IS RARE AT POINT LEVEL. The two passes' nearest detections are
 *      15-24 m apart (median 23 m), so CONSENSUS_RADIUS_M is deliberately tight
 *      at 20 m: corroboration claims "same physical defect", and a false match
 *      is worse than a missed one. Most agreement shows up between route
 *      segments instead, which is why both layers exist.
 *
 * Everything here is pure arithmetic over rows already in the database -
 * nothing is written, so a re-run cannot corrupt it and existing jobs get
 * consensus the moment they are read. Same contract as lib/rqsi.ts.
 */

const CELL = 111_320; // metres per degree of latitude, close enough at city scale

const GRADE_RANK: Record<RqsiGrade, number> = { green: 0, yellow: 1, red: 2 };

function cellKey(lat: number, lon: number, sizeM: number): string {
  const row = Math.floor((lat * CELL) / sizeM);
  const col = Math.floor((lon * CELL * Math.cos((lat * Math.PI) / 180)) / sizeM);
  return `${row}:${col}`;
}

/* ------------------------------ hazards ------------------------------ */

type Draft = {
  /** the first sighting's coordinates; fixed, so matching never drifts */
  anchor: { lat: number; lon: number };
  detections: Detection[];
};

/**
 * Cluster detections across audits into physical hazards.
 *
 * State falls out of membership:
 *   single        - one audit saw it
 *   corroborated  - 2+ audits saw it and agreed on what it is
 *   disputed      - 2+ audits saw it and called it different things
 */
export function groupHazards(
  detections: Detection[],
  radiusM: number = CONSENSUS_RADIUS_M
): HazardGroup[] {
  const drafts: Draft[] = [];
  const cells = new Map<string, Draft[]>();

  for (const d of detections) {
    if (d.lat == null || d.lon == null) continue;
    const point = { lat: d.lat, lon: d.lon };

    const [row, col] = cellKey(point.lat, point.lon, radiusM)
      .split(':')
      .map(Number);

    let best: Draft | null = null;
    let bestDist = Infinity;
    // The 3x3 neighbourhood covers any point within `radiusM` of the anchor on
    // either side of a cell boundary, so edge cases are matched, not missed.
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        for (const draft of cells.get(`${row + dr}:${col + dc}`) ?? []) {
          if (draft.detections.some((x) => x.jobId === d.jobId)) continue;
          const dist = haversineM(draft.anchor, point);
          if (dist <= radiusM && dist < bestDist) {
            best = draft;
            bestDist = dist;
          }
        }
      }
    }

    if (best) {
      best.detections.push(d);
    } else {
      const draft: Draft = { anchor: point, detections: [d] };
      drafts.push(draft);
      const key = cellKey(point.lat, point.lon, radiusM);
      const bucket = cells.get(key);
      if (bucket) bucket.push(draft);
      else cells.set(key, [draft]);
    }
  }

  return drafts.map((draft, id) => {
    const jobs = [...new Set(draft.detections.map((d) => d.jobId))];
    const winner = draft.detections.reduce((best, d) =>
      d.severity > best.severity ||
      (d.severity === best.severity && d.confidence > best.confidence)
        ? d
        : best
    );
    const types = new Set(draft.detections.map((d) => d.hazardType));

    return {
      id,
      lat: winner.lat!,
      lon: winner.lon!,
      hazardType: winner.hazardType,
      severity: winner.severity,
      confidence: winner.confidence,
      detectionIds: draft.detections
        .map((d) => d.id!)
        .filter((n) => n != null)
        .sort((a, b) => a - b),
      jobs,
      passes: jobs.length,
      state:
        jobs.length === 1 ? 'single' : types.size === 1 ? 'corroborated' : 'disputed',
    };
  });
}

/** detection id -> which hazard it belongs to, for counting defects once. */
export function groupIndex(groups: HazardGroup[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const g of groups) for (const id of g.detectionIds) map.set(id, g.id);
  return map;
}

/* ------------------------------ segments ------------------------------ */

type Bucket = { anchor: RouteSegment; members: RouteSegment[] };

/**
 * Collapse segments from different audits that grade the same stretch of
 * street, so "All audits" reports the street once instead of once per clip.
 *
 * A merged stretch takes the WORST grade and the LOWEST index of its
 * contributors: two passes disagreeing about a road is not a reason to average
 * them into something nobody drove. Its length is the longest contributor
 * rather than the sum - the point of merging is that shared metres are counted
 * once - and its defect count is the number of distinct hazards inside it, so
 * one pothole seen twice still reads as one pothole.
 */
export function mergeSegments(
  segments: RouteSegment[],
  hazards: HazardGroup[] = []
): RouteSegment[] {
  const buckets: Bucket[] = [];
  const cells = new Map<string, Bucket[]>();

  for (const s of segments) {
    const point = { lat: s.midLat, lon: s.midLon };
    const [row, col] = cellKey(point.lat, point.lon, SEGMENT_MERGE_M)
      .split(':')
      .map(Number);

    let best: Bucket | null = null;
    let bestDist = Infinity;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        for (const bucket of cells.get(`${row + dr}:${col + dc}`) ?? []) {
          if (bucket.members.some((m) => m.jobId === s.jobId)) continue;
          const dist = haversineM(
            { lat: bucket.anchor.midLat, lon: bucket.anchor.midLon },
            point
          );
          if (dist <= SEGMENT_MERGE_M && dist < bestDist) {
            best = bucket;
            bestDist = dist;
          }
        }
      }
    }

    if (best) {
      best.members.push(s);
    } else {
      const bucket: Bucket = { anchor: s, members: [s] };
      buckets.push(bucket);
      const key = cellKey(point.lat, point.lon, SEGMENT_MERGE_M);
      const bucketList = cells.get(key);
      if (bucketList) bucketList.push(bucket);
      else cells.set(key, [bucket]);
    }
  }

  const groupOf = groupIndex(hazards);

  return buckets.map(({ members }) => {
    // Longest contributor supplies the drawn geometry: it is the better
    // measured description of the road, and merging must not invent one.
    const lead = members.reduce((a, b) => (b.lengthM > a.lengthM ? b : a));
    const jobIds = [...new Set(members.map((m) => m.jobId))];
    const grade = members.reduce<RqsiGrade>(
      (worst, m) => (GRADE_RANK[m.grade] > GRADE_RANK[worst] ? m.grade : worst),
      'green'
    );
    const detectionIds = [...new Set(members.flatMap((m) => m.detectionIds))].sort(
      (a, b) => a - b
    );
    const distinctHazards = new Set(
      detectionIds.map((id) => groupOf.get(id) ?? `d${id}`)
    ).size;

    return {
      ...lead,
      jobId: lead.jobId,
      jobIds,
      passes: jobIds.length,
      // Only a disagreement between passes is a disagreement; one pass cannot
      // disagree with itself.
      disagree: jobIds.length > 1 && new Set(members.map((m) => m.grade)).size > 1,
      detectionIds,
      defectCount: distinctHazards,
      offRoute: members.reduce((sum, m) => sum + m.offRoute, 0),
      worstSeverity: members.reduce((m, x) => Math.max(m, x.worstSeverity), 0),
      density: members.reduce((m, x) => Math.max(m, x.density), 0),
      rqsi: Math.min(...members.map((m) => m.rqsi)),
      grade,
    } satisfies RouteSegment;
  });
}
